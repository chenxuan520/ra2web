import {
    ActionsApi,
    BotContext,
    Box2,
    GameApi,
    GameMath,
    GameObjectData,
    LandType,
    ObjectType,
    OrderType,
    PlayerData,
    QueueType,
    Rectangle,
    TechnoRules,
    Tile,
    UnitData,
    Vector2,
} from "../../../../game-api";
import {
    Mission,
    MissionAction,
    disbandMission,
    noop,
    requestSpecificUnits,
    requestUnits,
    requestUnitsWithSamePriority,
} from "../mission";
import { MatchAwareness } from "../../awareness";
import { MissionController } from "../missionController";
import { DebugLogger, isTechnoRulesObject, maxBy, minBy, toPathNode, toVector2 } from "../../common/utils";
import { ActionBatcher } from "../actionBatcher";
import { getCachedTechnoRules } from "../../common/rulesCache";
import { canBuildOnTile, computeAdjacentRect } from "../../common/tileUtils";
import { MissionContext, SupabotContext } from "../../common/context";
import { findVisiblePatches, OrePatch, patchDistance, PatchPoint, ScoredPatch, scorePatch } from "../../common/orePatches";
import { isPressured, readPressure } from "../../common/pressure";
import { isCrawlBlocked } from "../../building/baseCrawl";
import { countCoreTanks, readStrategicSituation } from "../../../strategy/nationalComposition";

const ORDER_COOLDOWN_TICKS = 60;

const mcvTypes = ["AMCV", "SMCV"];

const CONYARD_SCAN_DISTANCE = 15; // distance to check a conyard is already in place
const CONYARD_DEPLOY_SCAN_DISTANCE = 10; // distance to check for a deployable location
const CONYARD_DEPLOY_DISTANCE = 5;

/**
 * A mission that tries to create an MCV (if it doesn't exist) and deploy it somewhere it can be deployed.
 */
export class ExpansionMission extends Mission {
    private destination: Vector2 | null = null;
    private lastOrderAt: number | null = null;

    private lastOrderDeploy = false;
    private deployAttempts = 0;
    private static readonly MAX_DEPLOY_ATTEMPTS = 8;

    constructor(
        uniqueName: string,
        private priority: number,
        private selectedMcvId: number | null,
        private candidates: Vector2[],
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
        if (candidates.length === 1) {
            this.destination = candidates[0];
        } else if (candidates.length === 0) {
            throw new Error("ExpansionMission requires at least one candidate location");
        }
    }

    public _onAiUpdate(context: MissionContext): MissionAction {
        const { game, matchAwareness, actionBatcher } = context;
        const actionsApi = context.player.actions;
        if (context.difficulty === "brutal" && isMcvRelocating(game, context.player.name) && isPressured(context)) return noop();
        const playerData = context.game.getPlayerData(context.player.name);
        const mcvs = this.getUnitsOfTypes(game, ...mcvTypes);
        if (mcvs.length === 0) {
            // Perhaps we deployed already (or the unit was destroyed), end the mission.
            if (this.lastOrderAt !== null) {
                return disbandMission();
            }
            // We need an mcv!
            if (this.selectedMcvId && !!game.getUnitData(this.selectedMcvId)) {
                return requestSpecificUnits([this.selectedMcvId], this.priority);
            }
            if (context.difficulty === "brutal") return disbandMission();
            return requestUnitsWithSamePriority(mcvTypes, this.priority);
        }

        // use the highest-hp MCV
        const selectedMcvUnit = maxBy(mcvs, (mcv) => mcv.hitPoints)!;
        this.selectedMcvId = selectedMcvUnit?.id ?? null;
        if (context.difficulty === "brutal" && context.parasiteRepair?.isRepairing(selectedMcvUnit.id)) return noop();

        if (this.destination) {
            return this.moveMcvToDestination(
                game,
                actionsApi,
                playerData,
                matchAwareness,
                actionBatcher,
                selectedMcvUnit,
                context.difficulty,
            );
        } else {
            const reachableCandidates = this.candidates
                .map((candidate) => game.mapApi.getTile(candidate.x, candidate.y))
                .filter((t): t is Tile => !!t)
                .filter((t) => {
                    try {
                        const path = game.mapApi.findPath(
                            selectedMcvUnit.rules.speedType!,
                            toPathNode(selectedMcvUnit.tile, !!selectedMcvUnit.onBridge),
                            toPathNode(t, false),
                            { bestEffort: true, maxExpandedNodes: 1500 },
                        );
                        return path.length > 0;
                    } catch (_err) {
                        return false;
                    }
                });
            const closestReachableCandidate = minBy(reachableCandidates, (candidate) => {
                return toVector2(selectedMcvUnit.tile).distanceTo(toVector2(candidate));
            });
            if (!closestReachableCandidate) {
                // can't reach any candidates yet, return to start location
                this.destination = playerData.startLocation;
            } else {
                this.destination = toVector2(closestReachableCandidate);
            }
            return noop();
        }
    }

    public moveMcvToDestination(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
        mcv: UnitData,
        difficulty?: "normal" | "brutal",
    ) {
        if (!this.destination) {
            return noop();
        }
        if (difficulty === "brutal" && isMcvRelocating(gameApi, playerData.name) && !this.destination.equals(playerData.startLocation) &&
            gameApi.getVisibleUnits(playerData.name, "enemy", rules => rules.type === ObjectType.Vehicle &&
                rules.isSelectableCombatant && !rules.harvester).some(id => {
                const enemy = gameApi.getUnitData(id);
                return enemy && Math.hypot(enemy.tile.rx - this.destination!.x, enemy.tile.ry - this.destination!.y) <= 14;
            })) {
            this.destination = playerData.startLocation.clone();
            mcvRelocations.get(gameApi)!.set(playerData.name, this.destination);
            this.lastOrderDeploy = false;
            this.deployAttempts = 0;
        }
        // if there's a conyard near the destination, we're done.
        const ownConyards = new Set(gameApi.getVisibleUnits(playerData.name, "self", (rules) => rules.constructionYard));
        const conYards = gameApi
            .getUnitsInArea(
                new Box2(
                    this.destination.clone().subScalar(CONYARD_SCAN_DISTANCE),
                    this.destination.clone().addScalar(CONYARD_SCAN_DISTANCE),
                ),
            )
            .filter((id) => ownConyards.has(id))
            .map((id) => getCachedTechnoRules(gameApi, id))
            .filter((r) => r?.constructionYard);
        if (conYards.length > 0) {
            return disbandMission();
        }
        const isClose = toVector2(mcv.tile).distanceTo(this.destination) <= CONYARD_DEPLOY_DISTANCE;
        const canOrder = !this.lastOrderAt || gameApi.getCurrentTick() > this.lastOrderAt + ORDER_COOLDOWN_TICKS;
        if (!canOrder) {
            return noop();
        }
        if (isClose) {
            this.deployAttempts++;
            // If too many failed attempts at this location, find a new deployable spot
            if (this.deployAttempts > ExpansionMission.MAX_DEPLOY_ATTEMPTS) {
                const deployableLocations = findDeployableLocations(
                    playerData.name,
                    gameApi,
                    {
                        x: mcv.tile.rx - CONYARD_DEPLOY_SCAN_DISTANCE,
                        y: mcv.tile.ry - CONYARD_DEPLOY_SCAN_DISTANCE,
                        width: CONYARD_DEPLOY_SCAN_DISTANCE * 2,
                        height: CONYARD_DEPLOY_SCAN_DISTANCE * 2,
                    },
                    mcv.rules.deploysInto,
                    isMcvRelocating(gameApi, playerData.name),
                );
                const bestLocation = minBy(deployableLocations, (d) => toVector2(mcv.tile).distanceToSquared(d));
                if (bestLocation) {
                    // Update destination to the new deployable location
                    this.destination = bestLocation.clone();
                    this.deployAttempts = 0;
                    this.lastOrderDeploy = false;
                    actionsApi.orderUnits([mcv.id], OrderType.Move, bestLocation.x, bestLocation.y);
                } else {
                    // No deployable location found at all, scatter and retry
                    actionsApi.orderUnits([mcv.id], OrderType.Scatter);
                    this.deployAttempts = 0;
                }
                this.lastOrderAt = gameApi.getCurrentTick();
                return noop();
            }

            if (!this.lastOrderDeploy) {
                actionsApi.orderUnits([mcv.id], OrderType.DeploySelected);
                this.lastOrderDeploy = true;
            } else {
                // Deploy failed, find a nearby clear spot and move there
                const deployableLocations = findDeployableLocations(
                    playerData.name,
                    gameApi,
                    {
                        x: mcv.tile.rx - CONYARD_DEPLOY_SCAN_DISTANCE,
                        y: mcv.tile.ry - CONYARD_DEPLOY_SCAN_DISTANCE,
                        width: CONYARD_DEPLOY_SCAN_DISTANCE * 2,
                        height: CONYARD_DEPLOY_SCAN_DISTANCE * 2,
                    },
                    mcv.rules.deploysInto,
                    isMcvRelocating(gameApi, playerData.name),
                );
                const bestLocation = minBy(deployableLocations, (d) => toVector2(mcv.tile).distanceToSquared(d));

                if (bestLocation) {
                    // Update destination so next cycle we move toward this new spot
                    this.destination = bestLocation.clone();
                    actionsApi.orderUnits([mcv.id], OrderType.Move, bestLocation.x, bestLocation.y);
                } else {
                    actionsApi.orderUnits([mcv.id], OrderType.Scatter);
                }
                this.lastOrderDeploy = false;
            }
            this.lastOrderAt = gameApi.getCurrentTick();
        } else if (!isClose) {
            // find a 4x4 area near the destination that is clear.
            const rx = this.destination.x;
            const ry = this.destination.y;
            actionsApi.orderUnits([mcv.id], OrderType.Move, rx, ry);
            this.lastOrderAt = gameApi.getCurrentTick();
        }
        return noop();
    }

    public getGlobalDebugText(): string | undefined {
        return `Expand with MCV ${this.selectedMcvId}`;
    }

    public getPriority() {
        return this.priority;
    }
}

function findDeployableLocations(playerName: string, gameApi: GameApi, rectangle: Rectangle, rules: string, visibleOnly = false) {
    const tiles = gameApi.map.getTilesInRect(rectangle).filter(tile => !visibleOnly || gameApi.mapApi.isVisibleTile(tile, playerName));
    const { foundation, foundationCenter } = gameApi.getBuildingPlacementData(rules);

    if (foundation.width !== foundation.height) {
        throw new Error("only implemented for square foundations");
    }

    const grid: number[][] = new Array(rectangle.width).fill(() => 0).map(() => new Array(rectangle.height).fill(0));

    // fill tiles that are not buildable
    for (const tile of tiles) {
        const gridX = tile.rx - rectangle.x;
        const gridY = tile.ry - rectangle.y;
        if (canBuildOnTile(tile, gameApi)) {
            grid[gridX][gridY] = 1;
        }
    }

    // we have to start from the bottom-right and calculate backwards
    for (let x = rectangle.width - 2; x >= 0; --x) {
        for (let y = rectangle.height - 2; y >= 0; --y) {
            if (grid[x][y] === 0) {
                continue;
            }
            const right = x < rectangle.width - 1 ? grid[x + 1][y] : 0;
            // Preserve legacy deployment; visible economic scans must stay in the current column.
            const bottom = y < rectangle.height - 1 ? grid[visibleOnly ? x : y][y + 1] : 0;
            grid[x][y] = Math.min(right + 1, bottom + 1);
        }
    }

    const locations: Vector2[] = [];

    for (const tile of tiles) {
        const gridX = tile.rx - rectangle.x;
        const gridY = tile.ry - rectangle.y;
        if (grid[gridX][gridY] >= foundation.width && grid[gridX][gridY] >= foundation.height) {
            if (visibleOnly) {
                const footprint = gameApi.mapApi.getTilesInRect({ x: tile.rx, y: tile.ry, width: foundation.width, height: foundation.height });
                if (footprint.length !== foundation.width * foundation.height || footprint.some(point =>
                    !gameApi.mapApi.isVisibleTile(point, playerName) || point.z !== tile.z || !canBuildOnTile(point, gameApi))) continue;
            }
            locations.push(toVector2(tile).add(foundationCenter));
        }
    }

    return locations;
}

export class PackConyardMission extends Mission {
    constructor(
        uniqueName: string,
        private conyardId: number,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
    }

    public _onAiUpdate(context: MissionContext): MissionAction {
        const { game } = context;
        const actionsApi = context.player.actions;
        if (context.difficulty === "brutal" && isMcvRelocating(game, context.player.name) && isPressured(context)) return noop();
        const conyardOrMcv = game.getGameObjectData(this.conyardId);
        if (!conyardOrMcv) {
            // maybe it died, or unpacked already
            return disbandMission();
        }
        if (context.difficulty === "brutal" && context.parasiteRepair?.isRepairing(this.conyardId)) return noop();
        actionsApi.orderUnits([this.conyardId], OrderType.Move, conyardOrMcv.tile.rx, conyardOrMcv.tile.ry);
        return noop();
    }

    public getGlobalDebugText(): string | undefined {
        return `Pack conyard ${this.conyardId}`;
    }

    public getPriority() {
        return 10000;
    }
}

const CONYARD_PACK_COOLDOWN = 15 * 60 * 6; // 6 mins
const DO_NOT_EXPAND_BEFORE_TICKS = 15 * 60 * 6; // 6 minutes

const mcvRelocations = new WeakMap<GameApi, Map<string, Vector2>>();

/** Pending economic relocation, not evidence that a base has actually been packed or deployed. */
export function isMcvRelocating(game: GameApi, playerName: string): boolean {
    return mcvRelocations.get(game)?.has(playerName) ?? false;
}

/** A newly scanned yard plot must leave an observed empty plot for the refinery it is meant to serve. */
function hasLocalRefinerySpace(game: GameApi, playerName: string, yard: GameObjectData, refinery: TechnoRules, patch: OrePatch, destination: Vector2): boolean {
    const yardPlacement = game.getBuildingPlacementData(yard.rules.name), refineryPlacement = game.getBuildingPlacementData(refinery.name);
    const origin = { rx: destination.x - yardPlacement.foundationCenter.x, ry: destination.y - yardPlacement.foundationCenter.y };
    if (!game.canPlaceBuilding(playerName, yard.rules.name, origin)) return false;
    const yardSize = yardPlacement.foundation, refinerySize = refineryPlacement.foundation;
    const range = computeAdjacentRect(new Vector2(origin.rx, origin.ry), yardSize, refinery.adjacent, refinerySize);
    for (const tile of game.mapApi.getTilesInRect(range)) {
        if (!game.mapApi.isVisibleTile(tile, playerName)) continue;
        if (patchDistance(tile, patch) > 9 || tile.rx + refinerySize.width <= origin.rx - refinery.adjacent ||
            tile.ry + refinerySize.height <= origin.ry - refinery.adjacent || tile.rx >= origin.rx + yardSize.width + refinery.adjacent ||
            tile.ry >= origin.ry + yardSize.height + refinery.adjacent) continue;
        if (tile.rx < origin.rx + yardSize.width && tile.rx + refinerySize.width > origin.rx &&
            tile.ry < origin.ry + yardSize.height && tile.ry + refinerySize.height > origin.ry) continue;
        const footprint = game.mapApi.getTilesInRect({ x: tile.rx, y: tile.ry, width: refinerySize.width, height: refinerySize.height });
        if (footprint.length === refinerySize.width * refinerySize.height && footprint.every(point =>
            game.mapApi.isVisibleTile(point, playerName) && point.z === tile.z &&
            [LandType.Clear, LandType.Road, LandType.Beach, LandType.Rough, LandType.Railroad].includes(point.landType) && canBuildOnTile(point, game))) return true;
    }
    return false;
}

export function planMcvExpansion(context: SupabotContext, home: PatchPoint): { patch: OrePatch; candidate: Vector2 } | undefined {
    const { game, player } = context;
    const quietRelocation = context.difficulty === "brutal" && game.getCurrentTick() >= DO_NOT_EXPAND_BEFORE_TICKS &&
        game.getCurrentTick() < 9000 && readPressure(context).homeQuiet;
    if (context.difficulty !== "brutal" || game.getCurrentTick() < 9000 && !quietRelocation || isPressured(context) ||
        player.production.getQueueData(QueueType.Structures).items.length > 0) return undefined;
    const data = game.getPlayerData(player.name), patches = findVisiblePatches(game, player.name);
    if (!quietRelocation && (patches.filter(patch => patchDistance(home, patch) <= 30).reduce((sum, patch) => sum + patch.value, 0) >= 6000 ||
        countCoreTanks(readStrategicSituation(game, data)) < 6)) return undefined;
    if (quietRelocation && readStrategicSituation(game, data).harvesters < 2) return undefined;
    const refinery = quietRelocation ? player.production.getAvailableObjects(QueueType.Structures).find(rules => rules.refinery) : undefined;
    const refineryCost = refinery?.cost ?? Infinity;
    const targets = patches.filter(patch => patch.value >= (quietRelocation ? 6000 : 12000) || quietRelocation && patch.isGem && patch.value >= refineryCost)
        .map(patch => scorePatch(game, data, patch))
        .filter((entry): entry is ScoredPatch => !!entry && (quietRelocation ? entry.g <= 40 && (entry.g > 20 ||
            patchDistance(home, entry.patch) > 20 || isCrawlBlocked(game, player.name, entry.patch))
            : entry.g > 40 || isCrawlBlocked(game, player.name, entry.patch)))
        .sort((a, b) => b.score - a.score || a.g - b.g || (a.patch.id < b.patch.id ? -1 : a.patch.id > b.patch.id ? 1 : 0));
    for (const entry of targets) {
        const candidates = [...context.matchAwareness.getNextExpansionCandidates()];
        if (quietRelocation && !candidates.some(candidate => patchDistance({ rx: candidate.x, ry: candidate.y }, entry.patch) <= 12)) {
            const yard = game.getVisibleUnits(player.name, "self", rules => rules.constructionYard)
                .map(id => game.getGameObjectData(id)).find((yard): yard is GameObjectData => !!yard);
            if (yard && refinery) candidates.push(...findDeployableLocations(player.name, game, { x: entry.patch.center.rx - 12,
                y: entry.patch.center.ry - 12, width: 24, height: 24 }, yard.rules.name, true)
                .filter(candidate => hasLocalRefinerySpace(game, player.name, yard, refinery, entry.patch, candidate)));
        }
        const candidate = candidates
            .filter(candidate => patchDistance({ rx: candidate.x, ry: candidate.y }, entry.patch) <= 12)
            .sort((a, b) => patchDistance({ rx: a.x, ry: a.y }, entry.patch) - patchDistance({ rx: b.x, ry: b.y }, entry.patch) || a.x - b.x || a.y - b.y)[0];
        if (candidate) return { patch: entry.patch, candidate };
    }
    return undefined;
}

export class ExpansionMissionFactory {
    constructor(private lastConyardPackAt = Number.MIN_VALUE) {}
    getName(): string {
        return "ExpansionMissionFactory";
    }

    maybeCreateMissions(context: SupabotContext, missionController: MissionController, logger: DebugLogger): void {
        const { game, player, matchAwareness } = context;
        const playerData = game.getPlayerData(player.name);
        const mcvs = game.getVisibleUnits(player.name, "self", (r) => game.getGeneralRules().baseUnit.includes(r.name));
        const expandToCandidates = matchAwareness.getNextExpansionCandidates();
        const relocation = mcvRelocations.get(game)?.get(player.name);
        if (context.difficulty === "brutal" && relocation && mcvs.length === 0 &&
            game.getVisibleUnits(player.name, "self", rules => rules.constructionYard).some(id => {
                const yard = game.getGameObjectData(id);
                return yard && Math.hypot(yard.tile.rx - relocation.x, yard.tile.ry - relocation.y) <= CONYARD_SCAN_DISTANCE;
            })) mcvRelocations.get(game)!.delete(player.name);
        const mcvCandidates = context.difficulty === "brutal" ? (relocation && !isPressured(context) ? [relocation] : []) : expandToCandidates;

        // This is used for deploying the initial MCV.
        if (game.getCurrentTick() < DO_NOT_EXPAND_BEFORE_TICKS) {
            mcvs.forEach((mcv) => {
                missionController.addMission(
                    new ExpansionMission("initial-deploy-mcv-" + mcv, 100, mcv, [playerData.startLocation], logger),
                );
            });
        } else if (mcvCandidates.length > 0) {
            mcvs.forEach((mcv) => {
                missionController.addMission(
                    new ExpansionMission("expansion-mcv-" + mcv, 100, mcv, mcvCandidates, logger),
                );
            });
        }

        const threatCache = matchAwareness.getThreatCache();
        const earlyYard = context.difficulty === "brutal" && !expandToCandidates[0] && threatCache &&
            threatCache.totalAvailableAntiGroundFirepower > threatCache.totalOffensiveLandThreat &&
            game.getCurrentTick() >= DO_NOT_EXPAND_BEFORE_TICKS && game.getCurrentTick() < 9000 &&
            game.getCurrentTick() >= this.lastConyardPackAt + CONYARD_PACK_COOLDOWN
            ? game.getVisibleUnits(player.name, "self", rules => rules.constructionYard)
                .map(id => game.getGameObjectData(id)).find((yard): yard is GameObjectData => !!yard) : undefined;
        const earlyPlan = earlyYard && planMcvExpansion(context, earlyYard.tile);
        if ((!expandToCandidates[0] && !earlyPlan) || !threatCache) {
            return;
        }

        if (
            game.getCurrentTick() < DO_NOT_EXPAND_BEFORE_TICKS ||
            game.getCurrentTick() < this.lastConyardPackAt + CONYARD_PACK_COOLDOWN
        ) {
            return;
        }
        // TODO: do not pack up if currently producing something from the conyard

        // if we have a war factory and at least 1 refinery, try expand
        const conYards = game.getVisibleUnits(player.name, "self", (r) => r.constructionYard);
        const warFactories = game.getVisibleUnits(player.name, "self", (r) => r.weaponsFactory);
        const isSafeToExpand = threatCache.totalAvailableAntiGroundFirepower > threatCache.totalOffensiveLandThreat;
        const refineries = game.getVisibleUnits(player.name, "self", (r) => r.refinery);
        if (conYards.length === 0 || warFactories.length === 0 || refineries.length === 0 || !isSafeToExpand) {
            return;
        }
        let economyCandidate: Vector2 | undefined;
        if (context.difficulty === "brutal") {
            const yard = game.getGameObjectData(conYards[0]);
            const plan = earlyPlan ?? (yard && planMcvExpansion(context, yard.tile));
            if (!plan) return;
            economyCandidate = plan.candidate;
        }
        const selectedConyard = game.getGameObjectData(conYards[0])!;
        const ownRefineries = new Set(refineries);
        const refineryNearconyard = game
            .getUnitsInArea(
                new Box2(toVector2(selectedConyard.tile).subScalar(10), toVector2(selectedConyard.tile).addScalar(14)),
            )
            .filter((id) => ownRefineries.has(id))
            .map((id) => game.getGameObjectData(id))
            .filter(isTechnoRulesObject)
            .filter((obj) => obj.rules.refinery);
        if (refineryNearconyard.length > 0) {
            if (economyCandidate) {
                const mcvRules = game.rulesApi.vehicleRules.get(selectedConyard.rules.undeploysInto);
                const tile = game.mapApi.getTile(economyCandidate.x, economyCandidate.y);
                if (mcvRules?.speedType === undefined || !tile) return;
                try {
                    const path = game.mapApi.findPath(mcvRules.speedType, toPathNode(selectedConyard.tile, false), toPathNode(tile, false),
                        { bestEffort: false, maxExpandedNodes: 1500 });
                    if (path.length < 2 || !path.some(node => node.tile.rx === tile.rx && node.tile.ry === tile.ry)) return;
                } catch (_err) {
                    return;
                }
            }
            missionController.addMission(
                new PackConyardMission("pack-up-" + selectedConyard.id, selectedConyard.id, logger),
            );
            if (economyCandidate) {
                let players = mcvRelocations.get(game);
                if (!players) { players = new Map(); mcvRelocations.set(game, players); }
                players.set(player.name, economyCandidate);
            }
            logger("Time to pack the conyard and expand", false);
            this.lastConyardPackAt = game.getCurrentTick();
        } else {
            logger("Not time to pack up, no refinery yet");
        }
    }
}

import { ActionsApi, BotContext, GameApi, OrderType, PlayerData, Vector2 } from "../../../../game-api";
import { MatchAwareness } from "../../awareness";
import {
    Mission,
    MissionAction,
    disbandMission,
    noop,
    releaseUnits,
    requestUnits,
    requestUnitsWithSamePriority,
} from "../mission";
import { AttackMission } from "./attackMission";
import { MissionController } from "../missionController";
import { DebugLogger } from "../../common/utils";
import { ActionBatcher } from "../actionBatcher";
import { getDistanceBetweenTileAndPoint } from "../../map/map";
import { PrioritisedScoutTarget } from "../../common/scout";
import { MissionContext, SupabotContext } from "../../common/context";
import { getKnownEnemyDirections } from "../../common/knownEnemyDirections";
import { DogOrders, WatchPostMissions, getPublicEnemyStart, livingMissionDogs, preferredDog, selectWatchPost } from "./watchPostMission";

const SCOUT_MOVE_COOLDOWN_TICKS = 30;

// Max units to spend on a particular scout target.
const MAX_ATTEMPTS_PER_TARGET = 5;

// Maximum ticks to spend trying to scout a target *without making progress towards it*.
// Every time a unit gets closer to the target, the timer refreshes.
const MAX_TICKS_PER_TARGET = 600;

/**
 * A mission that tries to scout around the map with a cheap, fast unit (usually attack dogs)
 */
export class ScoutingMission extends Mission {
    private scoutTarget: Vector2 | null = null;
    private attemptsOnCurrentTarget: number = 0;
    private scoutTargetRefreshedAt: number = 0;
    private lastMoveCommandTick: number = 0;
    private scoutTargetIsPermanent: boolean = false;

    // Minimum distance from a scout to the target.
    private scoutMinDistance?: number;

    private hadUnit: boolean = false;
    private totalUnitsReceived: number = 0;

    constructor(
        uniqueName: string,
        private priority: number,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
    }

    public _onAiUpdate(context: MissionContext): MissionAction {
        const { game, matchAwareness } = context;
        const actionsApi = context.player.actions;
        const playerData = game.getPlayerData(context.player.name);
        const scoutNames = ["ADOG", "DOG", "E1", "E2", "FV", "HTK"];
        const scouts = this.getUnitsOfTypes(game, ...scoutNames);

        if (scouts.length > 0 && !this.hadUnit) {
            this.hadUnit = true;
            this.totalUnitsReceived++;
        }

        const factories = game.getVisibleUnits(playerData.name, "self", rules => rules.weaponsFactory).length;
        this.priority = factories === 0 ? 85 : 50;

        if ((matchAwareness.getSectorCache().getOverallVisibility() || 0) > 0.9) {
            return disbandMission();
        }

        // Once initial scout dog has been deployed and completed its run (or died/late game), disband to prevent infinite dog feeding
        if (this.totalUnitsReceived >= 1 && (scouts.length === 0 || game.getCurrentTick() > 3600)) {
            const knownEnemy = getKnownEnemyDirections(game, playerData);
            if (knownEnemy.length > 0 || scouts.length === 0) {
                this.logger(`Enemy location known or scout completed, disbanding scouting mission ${this.getUniqueName()}`);
                return disbandMission();
            }
        }

        if (scouts.length > 1) {
            const excess = scouts.slice(1).map((unit) => unit.id);
            return releaseUnits(excess);
        }

        if (scouts.length === 0) {
            if (this.totalUnitsReceived >= 1) {
                return disbandMission();
            }
            // Count the number of times the scout dies trying to uncover the current scoutTarget.
            if (this.scoutTarget && this.hadUnit) {
                this.attemptsOnCurrentTarget++;
                this.hadUnit = false;
            }
            const available = new Set(context.player.production.getAvailableObjects().map((o) => o.name));
            const preferredDog = available.has("DOG") ? "DOG" : available.has("ADOG") ? "ADOG" : null;
            if (preferredDog) {
                return requestUnits({ [preferredDog]: this.priority });
            }
            return requestUnitsWithSamePriority(scoutNames, this.priority);
        } else if (this.scoutTarget) {
            this.hadUnit = true;
            if (!this.scoutTargetIsPermanent) {
                if (this.attemptsOnCurrentTarget > MAX_ATTEMPTS_PER_TARGET) {
                    this.logger(
                        `Scout target ${this.scoutTarget.x},${this.scoutTarget.y} took too many attempts, moving to next`,
                    );
                    this.setScoutTarget(null, 0);
                    return noop();
                }
                if (game.getCurrentTick() > this.scoutTargetRefreshedAt + MAX_TICKS_PER_TARGET) {
                    this.logger(
                        `Scout target ${this.scoutTarget.x},${this.scoutTarget.y} took too long, moving to next`,
                    );
                    this.setScoutTarget(null, 0);
                    return noop();
                }
            }
            const targetTile = game.mapApi.getTile(this.scoutTarget.x, this.scoutTarget.y);
            if (!targetTile) {
                throw new Error(`target tile ${this.scoutTarget.x},${this.scoutTarget.y} does not exist`);
            }
            if (game.getCurrentTick() > this.lastMoveCommandTick + SCOUT_MOVE_COOLDOWN_TICKS) {
                this.lastMoveCommandTick = game.getCurrentTick();
                scouts.forEach((unit) => {
                    if (this.scoutTarget) {
                        actionsApi.orderUnits([unit.id], OrderType.AttackMove, this.scoutTarget.x, this.scoutTarget.y);
                    }
                });
                // Check that a scout is actually moving closer to the target.
                const distances = scouts.map((unit) => getDistanceBetweenTileAndPoint(unit.tile, this.scoutTarget!));
                const newMinDistance = Math.min(...distances);
                if (!this.scoutMinDistance || newMinDistance < this.scoutMinDistance) {
                    this.logger(
                        `Scout timeout refreshed because unit moved closer to point (${newMinDistance} < ${this.scoutMinDistance})`,
                    );
                    this.scoutTargetRefreshedAt = game.getCurrentTick();
                    this.scoutMinDistance = newMinDistance;
                }
            }
            if (game.mapApi.isVisibleTile(targetTile, playerData.name)) {
                this.logger(
                    `Scout target ${this.scoutTarget.x},${this.scoutTarget.y} successfully scouted, moving to next`,
                );
                this.setScoutTarget(null, game.getCurrentTick());
            }
        } else {
            const nextScoutTarget = matchAwareness.getScoutingManager().getNewScoutTarget();
            if (!nextScoutTarget) {
                this.logger(`No more scouting targets available, disbanding.`);
                return disbandMission();
            }
            this.setScoutTarget(nextScoutTarget, game.getCurrentTick());
        }
        return noop();
    }

    setScoutTarget(target: PrioritisedScoutTarget | null, currentTick: number) {
        this.attemptsOnCurrentTarget = 0;
        this.scoutTargetRefreshedAt = currentTick;
        this.scoutTarget = target?.target ?? null;
        this.scoutMinDistance = undefined;
        this.scoutTargetIsPermanent = target?.permanent ?? false;
    }

    public getGlobalDebugText(): string | undefined {
        return "scouting";
    }

    public getPriority() {
        return this.priority;
    }
}

/** Brutal's two paid scouts share a lifetime budget; normal's mission above is unchanged. */
export class OpeningScoutingMission extends Mission {
    private initialScoutIds: number[] = [];
    private priority = 85;
    private firstTargetComplete = false;
    private queueComplete = false;
    private queueTarget: PrioritisedScoutTarget | null = null;
    private homeTargets?: PrioritisedScoutTarget[];
    private queueTargetRefreshedAt = 0;
    private queueMinDistance = Infinity;
    private orders = new DogOrders(SCOUT_MOVE_COOLDOWN_TICKS);

    constructor(logger: DebugLogger, private handoff: (context: MissionContext, mission: Mission) => void) {
        super("globalScout", logger);
    }

    override addUnit(id: number) {
        if (this.getUnitIds().includes(id)) return;
        super.addUnit(id);
        if (!this.initialScoutIds.includes(id) && this.initialScoutIds.length < 2) this.initialScoutIds.push(id);
    }

    getTotalUnitsReceived() { return this.initialScoutIds.length; }
    getPriority() { return this.priority; }
    getGlobalDebugText() { return "two opening scouts"; }
    isUnitsLocked() { return true; }

    private finish(context: MissionContext) {
        this.handoff(context, this);
        return disbandMission();
    }

    _onAiUpdate(context: MissionContext): MissionAction {
        if (context.difficulty !== "brutal") return noop();
        const { game, player, matchAwareness } = context, tick = game.getCurrentTick();
        this.priority = game.getVisibleUnits(player.name, "self", rules => rules.weaponsFactory).length ? 50 : 85;
        const scouts = livingMissionDogs(context, this);
        const excess = scouts.filter(scout => !this.initialScoutIds.includes(scout.id)).map(scout => scout.id);
        if (excess.length) return releaseUnits(excess);
        if (tick >= 3600 || (matchAwareness.getSectorCache().getOverallVisibility() || 0) > 0.9) return this.finish(context);

        const enemyStart = getPublicEnemyStart(game, game.getPlayerData(player.name));
        const first = scouts.find(scout => scout.id === this.initialScoutIds[0]);
        const second = scouts.find(scout => scout.id === this.initialScoutIds[1]);
        if (!enemyStart || this.initialScoutIds.length > 0 && !first) this.firstTargetComplete = true;
        if (first && enemyStart && !this.firstTargetComplete) {
            const tile = game.mapApi.getTile(enemyStart.x, enemyStart.y);
            if (tile && game.mapApi.isVisibleTile(tile, player.name)) this.firstTargetComplete = true;
            else this.orders.move(context, first, { rx: enemyStart.x, ry: enemyStart.y }, OrderType.AttackMove);
        }
        if (first && this.firstTargetComplete) {
            // The completed first scout waits safely at the public midpoint,
            // still locked here until the actual two-slot ownership handoff.
            const post = selectWatchPost(context, 1);
            if (post) this.orders.move(context, first, post); else this.orders.stop(context, first);
        }

        if (second && !this.queueComplete) {
            if (this.queueTarget) {
                const tile = game.mapApi.getTile(this.queueTarget.target.x, this.queueTarget.target.y);
                const currentDistance = getDistanceBetweenTileAndPoint(second.tile, this.queueTarget.target);
                if (currentDistance < this.queueMinDistance) {
                    this.queueMinDistance = currentDistance;
                    this.queueTargetRefreshedAt = tick;
                }
                if (!tile || game.mapApi.isVisibleTile(tile, player.name) ||
                    !this.queueTarget.permanent && tick > this.queueTargetRefreshedAt + MAX_TICKS_PER_TARGET) this.queueTarget = null;
            }
            if (!this.queueTarget) {
                // Discover the home economy before spending the second scout on distant sectors.
                // These are public-start projections, never hidden resource coordinates.
                const home = game.getPlayerData(player.name).startLocation;
                this.homeTargets ??= [[17, -17], [24, 0], [17, 17], [0, 24], [-17, 17], [-24, 0], [-17, -17], [0, -24]]
                    .map(([dx, dy]) => new PrioritisedScoutTarget(1000, new Vector2(home.x + dx, home.y + dy)));
                let next = this.homeTargets.shift() ?? matchAwareness.getScoutingManager().getNewScoutTarget();
                // The first dog reserves its public start; do not send both dogs
                // to that same existing queue entry before other sectors.
                while (next) {
                    const tile = game.mapApi.getTile(next.target.x, next.target.y);
                    if (tile && !game.mapApi.isVisibleTile(tile, player.name) &&
                        !(enemyStart && next.target.x === enemyStart.x && next.target.y === enemyStart.y)) break;
                    next = this.homeTargets.shift() ?? matchAwareness.getScoutingManager().getNewScoutTarget();
                }
                this.queueTarget = next ?? null;
                this.queueTargetRefreshedAt = tick;
                this.queueMinDistance = Infinity;
                if (!next) this.queueComplete = true;
            }
            if (this.queueTarget) this.orders.move(context, second,
                { rx: this.queueTarget.target.x, ry: this.queueTarget.target.y }, OrderType.AttackMove);
        }
        if (this.initialScoutIds.length >= 2 && !second) this.queueComplete = true;
        if (this.initialScoutIds.length >= 2 && this.firstTargetComplete && this.queueComplete) return this.finish(context);
        if (this.initialScoutIds.length < 2) {
            const name = preferredDog(context);
            return name ? requestUnits({ [name]: this.priority }) : noop();
        }
        return noop();
    }
}

const SCOUT_COOLDOWN_TICKS = 300;

export class ScoutingMissionFactory {
    private initialMissionsCreated = false;
    private dogMissions?: WatchPostMissions;
    constructor(private lastScoutAt: number = -SCOUT_COOLDOWN_TICKS) {}

    getName(): string {
        return "ScoutingMissionFactory";
    }

    maybeCreateMissions(context: SupabotContext, missionController: MissionController, logger: DebugLogger): void {
        const { game, matchAwareness } = context;
        if (context.difficulty === "brutal") {
            this.dogMissions ??= new WatchPostMissions(missionController, logger);
            this.dogMissions.ensure(context);
            if (!this.initialMissionsCreated) {
                const scout = new OpeningScoutingMission(logger, (missionContext, mission) => this.dogMissions!.handoff(missionContext, mission));
                if (missionController.addMission(scout)) {
                    this.initialMissionsCreated = true;
                    this.dogMissions.setOpeningReady(() => scout.getTotalUnitsReceived() >= 2);
                }
            }
            return;
        }
        if (this.initialMissionsCreated) {
            return;
        }
        if (game.getCurrentTick() < this.lastScoutAt + SCOUT_COOLDOWN_TICKS) {
            return;
        }
        if (!matchAwareness.getScoutingManager().hasScoutTargets()) {
            return;
        }
        const created0 = !!missionController.addMission(new ScoutingMission("globalScout", 50, logger));
        if (created0) {
            this.initialMissionsCreated = true;
        }
        if (!created0) {
            this.lastScoutAt = game.getCurrentTick();
        }
    }
}

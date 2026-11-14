import {
    ActionsApi,
    GameApi,
    ObjectType,
    PlayerData,
    ProductionApi,
    QueueStatus,
    QueueType,
    TechnoRules,
    Vector2,
} from "../../../game-api";
import { GlobalThreat } from "../threat/threat";
import { BUILDING_NAME_TO_RULES, TechnoRulesWithPriority, getDefaultPlacementLocation } from "./buildingRules";
import { SupabotContext } from "../common/context";
import { UnitRequest } from "../mission/missionController";
import { countCoreTanks, NATIONAL_SUPPORT_LIMITS, readStrategicSituation } from "../../strategy/nationalComposition";
import { getBasicInfantryBudget, isSovietCountry } from "../../strategy/basicInfantryBudget";
import { desiredMiners } from "./harvester";
import { BRUTAL_PARAMS } from "../../strategy/brutalParams";
import { getEconomyPressureLimits, isEcoOnly, readPressure } from "../common/pressure";
import { isCivilianEconomy } from "./economyPlan";
import { isMinerRefineryProduction, observeRefineryEconomy, recordRefineryOrder, sellDuplicateRefinery } from "./refineryEconomy";
import { isCrawlProduction, observeBaseCrawl, planBaseCrawl, recordBaseCrawlOrder } from "./baseCrawl";
import { isDefenseProduction, planDefense, recordDefenseOrder } from "./defensePlan";
import { getDronePriority } from "./droneProduction";
import { findVisiblePatches, isServed, PatchPoint } from "../common/orePatches";

export const QUEUES = [
    QueueType.Structures,
    QueueType.Armory,
    QueueType.Infantry,
    QueueType.Vehicles,
    QueueType.Aircrafts,
    QueueType.Ships,
];

function isBuildingQueue(queueType: QueueType): boolean {
    return queueType === QueueType.Structures || queueType === QueueType.Armory;
}

export const queueTypeToName = (queue: QueueType) => {
    switch (queue) {
        case QueueType.Structures:
            return "Structures";
        case QueueType.Armory:
            return "Armory";
        case QueueType.Infantry:
            return "Infantry";
        case QueueType.Vehicles:
            return "Vehicles";
        case QueueType.Aircrafts:
            return "Aircrafts";
        case QueueType.Ships:
            return "Ships";
        default:
            return "Unknown";
    }
};

type QueueState = {
    queue: QueueType;
    /** sorted in ascending order (last item is the topItem) */
    items: TechnoRulesWithPriority[];
    topItem: TechnoRulesWithPriority | undefined;
};

const REPAIR_CHECK_INTERVAL = 30;
const PLACEMENT_FAILURE_RETRY_THRESHOLD = 3;
const PLACEMENT_FAILURE_CANCEL_THRESHOLD = 10;

export class QueueController {
    private queueStates: QueueState[] = [];
    private lastRepairCheckAt = 0;
    private lastEmergencySaleAt = -9999;
    private airResponseUntil = -Infinity;
    private airResponseTarget = 0;
    private placementFailures: Map<string, number> = new Map();
    private economicPlacementFailures: Map<string, number> = new Map();
    private refineryLocation?: { name: string; location: Vector2 };
    private incomeHeldRefinery?: string;

    constructor() {}

    public onAiUpdate(
        context: SupabotContext,
        threatCache: GlobalThreat | null,
        unitTypeRequests: Map<string, UnitRequest>,
        logger: (message: string) => void,
    ) {
        const { game, player } = context;
        const { production: productionApi, actions: actionsApi } = player;
        const playerData = game.getPlayerData(player.name);
        // Protect the army's actual base area without redefining historical birth-point pressure.
        const ownedAnchors = context.difficulty === "brutal" ? game.getVisibleUnits(player.name, "self", rules =>
            rules.constructionYard || rules.refinery || rules.weaponsFactory)
            .map(id => game.getGameObjectData(id)?.tile).filter((tile): tile is PatchPoint => !!tile) : [];
        const ownedBaseUnderAttack = context.difficulty === "brutal" && game.getVisibleUnits(player.name, "enemy", rules =>
            rules.isSelectableCombatant && !rules.harvester && rules.type !== ObjectType.Building).some(id => {
            const enemy = game.getUnitData(id);
            return enemy && ownedAnchors.some(base => Math.hypot(enemy.tile.rx - base.rx, enemy.tile.ry - base.ry) <= 22);
        });
        observeRefineryEconomy(context);
        observeBaseCrawl(context);
        // Economic units do not belong to combat missions. Keep a separate request
        // so losing miners cannot permanently starve an otherwise healthy base.
        const requests = new Map(unitTypeRequests);
        const ecoOnly = isEcoOnly(context);
        if (ecoOnly) {
            const allowed = new Set(QUEUES.flatMap(queue => productionApi.getAvailableObjects(queue).filter(isCivilianEconomy).map(rules => rules.name)));
            for (const name of requests.keys()) if (!allowed.has(name)) requests.delete(name);
        }
        const cappedSupport = new Set<string>();
        if (context.difficulty === "brutal") {
            for (const name of ["E1", "E2"]) {
                const count = game.getVisibleUnits(player.name, "self", rules => rules.name === name).length;
                const openingRequest = game.getCurrentTick() < 7000 && (requests.get(name)?.priority ?? 0) >= 95;
                const limit = openingRequest ? (name === "E2" ? 16 : 12) : getBasicInfantryBudget(name, context.difficulty).total;
                if (count >= limit) requests.delete(name);
            }
            // Before War Factory is established, never let basic foot infantry starve the refinery and factory
            const factories = game.getVisibleUnits(player.name, "self", rules => rules.weaponsFactory).length;
            const openingRequest = game.getCurrentTick() < 7000 && ["E1", "E2"].some(name => (requests.get(name)?.priority ?? 0) >= 95);
            if (factories === 0 && !openingRequest) {
                const start = playerData.startLocation;
                const hasHomeThreat = !start || game.getVisibleUnits(player.name, "enemy", rules => rules.isSelectableCombatant && !rules.harvester)
                    .some(id => {
                        const unit = game.getUnitData(id);
                        if (!unit?.tile) return true;
                        return (unit.tile.rx - start.x) ** 2 + (unit.tile.ry - start.y) ** 2 <= 25 ** 2;
                    });
                if (!hasHomeThreat) {
                    requests.delete("E1");
                    requests.delete("E2");
                }
            }
            for (const [name, cap] of Object.entries(NATIONAL_SUPPORT_LIMITS)) {
                if (game.getVisibleUnits(player.name, "self", rules => rules.name === name).length >= cap) {
                    requests.delete(name);
                    cappedSupport.add(name);
                }
            }
        }
        const basicDefense = isSovietCountry(playerData.country?.name) ? "NALASR" : "GAPILL";
        const defense = planDefense(context, requests.get(basicDefense));
        const activeDefense = defense && isDefenseProduction(game, player.name) &&
            productionApi.getQueueData(QueueType.Armory).items[0]?.rules.name === defense.rules.name;
        if (defense && (activeDefense || defense.priority >= (requests.get(defense.rules.name)?.priority ?? 0))) {
            requests.set(defense.rules.name, { priority: defense.priority, specificLocation: new Vector2(defense.location.rx, defense.location.ry) });
        }
        const crawl = ownedBaseUnderAttack && !playerData.power?.isLowPower ? undefined : planBaseCrawl(context);
        if (crawl && crawl.priority > (requests.get(crawl.rules.name)?.priority ?? 0)) {
            requests.set(crawl.rules.name, { priority: crawl.priority, specificLocation: new Vector2(crawl.location.rx, crawl.location.ry) });
        }
        const currentMinerTarget = context.difficulty === "brutal" ? desiredMiners(game, playerData) : 0;
        const queuedRefinery = productionApi.getQueueData(QueueType.Structures).items[0]?.rules;
        const futureRefinery = context.difficulty === "brutal" && queuedRefinery?.refinery &&
            ["HARV", "CMIN"].includes(queuedRefinery.freeUnit) && this.refineryLocation?.name === queuedRefinery.name
            ? { rx: this.refineryLocation.location.x, ry: this.refineryLocation.location.y } : undefined;
        const futureMinerTarget = futureRefinery ? desiredMiners(game, playerData, futureRefinery) : 0;
        // A real paid expansion reserves its one supplied miner, not the rest of its visible field's capacity.
        const minerTarget = Math.max(currentMinerTarget, futureMinerTarget - 1);
        for (const option of productionApi.getAvailableObjects(QueueType.Vehicles)) {
            if (!option.harvester) continue;
            const logic = BUILDING_NAME_TO_RULES.get(option.name);
            if (!logic) continue;
            if (context.difficulty === "brutal" && futureMinerTarget <= currentMinerTarget &&
                game.getVisibleUnits(player.name, "self", rules => rules.harvester).length >= 3 &&
                game.getVisibleUnits(player.name, "self", rules => rules.harvester).length >= minerTarget - 1 &&
                !productionApi.getQueueData(QueueType.Vehicles).items.some(item => item.rules.name === option.name) &&
                productionApi.getQueueData(QueueType.Structures).items.some(item =>
                    item.rules.refinery && item.rules.freeUnit === option.name)) continue;
            let priority = logic.getPriority(game, playerData, option, threatCache, context.difficulty);
            if (context.difficulty === "brutal") {
                const miners = game.getVisibleUnits(player.name, "self", rules => rules.harvester).length;
                const desired = minerTarget;
                const situation = readStrategicSituation(game, playerData);
                const core = countCoreTanks(situation);
                const pressure = readPressure(context);
                const minCoreBeforeMiner2 = isSovietCountry(playerData.country?.name) ? 2 : 1;
                const coreFactor = getEconomyPressureLimits(context, miners).minerCoreFactor;

                priority = 0;
                if (miners === 0) {
                    priority = 120;
                } else if (miners === 1 && !pressure.pressured) {
                    priority = 110;
                } else if (miners === 1 && pressure.pressured && (ecoOnly || core >= minCoreBeforeMiner2)) {
                    priority = 90;
                } else if (miners === 2 && !pressure.pressured && miners < desired) {
                    priority = 110;
                } else if (miners === 2 && pressure.pressured && (ecoOnly || core >= 4) && miners < desired) {
                    priority = 78;
                } else if (miners >= 3 && miners < desired && !pressure.baseUnderSiege && !ownedBaseUnderAttack && (ecoOnly || core >= coreFactor * (miners - 2))) {
                    priority = pressure.homeQuiet && miners < 5 && situation.enemy.infantry < 8 &&
                        (ecoOnly || core > 0 || situation.enemy.defences > 0 && situation.enemy.vehicles === 0) ? 110 : 78;
                }
            }
            if (priority > (requests.get(option.name)?.priority ?? 0)) {
                requests.set(option.name, { priority, specificLocation: null });
            }
        }
        if (context.difficulty === "brutal" && !ecoOnly) {
            const situation = readStrategicSituation(game, playerData);
            if (isSovietCountry(playerData.country?.name)) {
                const tick = game.getCurrentTick();
                if (situation.enemy.aircraft > 0) {
                    this.airResponseTarget = Math.max(this.airResponseTarget,
                        Math.min(6, Math.max(2, Math.ceil(situation.enemy.aircraft / 2))));
                    this.airResponseUntil = tick + 600;
                } else if (tick >= this.airResponseUntil) this.airResponseTarget = 0;
                const aa = productionApi.getAvailableObjects(QueueType.Vehicles).find(option => option.name === "HTK");
                if (aa && (situation.own.HTK ?? 0) < this.airResponseTarget && (requests.get(aa.name)?.priority ?? 0) < 115) {
                    // Visible air pressure needs actual counters before another
                    // miner is sent out. Retain the observation briefly across fog.
                    requests.set(aa.name, { priority: 115, specificLocation: null });
                }
                const drone = productionApi.getAvailableObjects(QueueType.Vehicles).find(option => option.name === "DRON");
                if (drone) {
                    const priority = getDronePriority(context, ownedBaseUnderAttack);
                    if (priority > 0) requests.set(drone.name, { priority, specificLocation: null });
                    else requests.delete(drone.name);
                }
            }
            const visibleCoreArmor = game.getVisibleUnits(player.name, "enemy", rules => rules.type === ObjectType.Vehicle &&
                rules.isSelectableCombatant && !rules.harvester && ["MTNK", "HTNK", "MGTK", "APOC", "SREF"].includes(rules.name)).filter(id => {
                const enemy = game.getUnitData(id);
                return enemy && ownedAnchors.some(base => Math.hypot(enemy.tile.rx - base.rx, enemy.tile.ry - base.ry) <= 48);
            }).length;
            if (situation.harvesters >= 2 && (situation.enemy.infantry >= 8 &&
                (situation.own.MTNK ?? 0) + (situation.own.HTNK ?? 0) < Math.min(6, Math.max(2, Math.ceil(situation.enemy.infantry / 6))) ||
                situation.tick < 9000 && visibleCoreArmor > 0 && countCoreTanks(situation) < Math.min(6, Math.max(BRUTAL_PARAMS.assault.formedArmor, visibleCoreArmor))) ||
                situation.harvesters === 1 && situation.tick < 9000 && visibleCoreArmor > 0 && countCoreTanks(situation) < Math.min(6, visibleCoreArmor) &&
                game.getVisibleUnits(player.name, "self", rules => rules.refinery).length > 0) {
                const tank = productionApi.getAvailableObjects(QueueType.Vehicles).find(option => option.name === "MTNK" || option.name === "HTNK");
                if (tank) {
                    requests.set(tank.name, { priority: 100, specificLocation: null });
                    if (requests.get("DRON")?.priority === 112) requests.delete("DRON");
                    for (const option of productionApi.getAvailableObjects(QueueType.Vehicles)) {
                        if (option.harvester && (requests.get(option.name)?.priority === 110 ||
                            situation.harvesters === 1 && requests.get(option.name)?.priority === 90)) requests.delete(option.name);
                    }
                    if (productionApi.getQueueData(QueueType.Infantry).status === QueueStatus.Idle) {
                        requests.delete("ENGINEER"); requests.delete("SENGINEER");
                    }
                }
            }
            if (situation.harvesters >= 1) {
                const core = countCoreTanks(situation);
                const tankName = isSovietCountry(playerData.country?.name) ? "HTNK" : "MTNK";
                const tank = productionApi.getAvailableObjects(QueueType.Vehicles).find(option => option.name === tankName);
                if (tank) {
                    const hasDualRefinery = (situation.own.NAREFN ?? 0) + (situation.own.GAREFN ?? 0) >= 2;
                    if ((core < 1 && situation.harvesters >= 1) || (core < 4 && (situation.harvesters >= 2 || hasDualRefinery))) {
                        if ((requests.get(tank.name)?.priority ?? 0) < 85) requests.set(tank.name, { priority: 85, specificLocation: null });
                    } else if (core < 8 && (requests.get(tank.name)?.priority ?? 0) < 75) {
                        requests.set(tank.name, { priority: 75, specificLocation: null });
                    } else if (core < 16 && (requests.get(tank.name)?.priority ?? 0) < 60) {
                        requests.set(tank.name, { priority: 60, specificLocation: null });
                    } else if ((requests.get(tank.name)?.priority ?? 0) < 50) {
                        requests.set(tank.name, { priority: 50, specificLocation: null });
                    }
                }
                if (!isSovietCountry(playerData.country?.name)) {
                    const heavyName = productionApi.getAvailableObjects(QueueType.Vehicles).some(o => o.name === "SREF") ? "SREF" : "MGTK";
                    const heavy = productionApi.getAvailableObjects(QueueType.Vehicles).find(option => option.name === heavyName);
                    if (heavy && situation.credits >= heavy.cost && (requests.get(heavy.name)?.priority ?? 0) < 60) {
                        requests.set(heavy.name, { priority: 60, specificLocation: null });
                    }
                }
            }
            const openingTank = isSovietCountry(playerData.country?.name) ? "HTNK" : "MTNK";
            if (situation.harvesters >= 3 && countCoreTanks(situation) > 0 && situation.enemy.infantry < 8 && !readPressure(context).pressured && !ownedBaseUnderAttack &&
                requests.get(openingTank)?.priority === 85 && productionApi.getAvailableObjects(QueueType.Vehicles)
                    .some(option => option.harvester && requests.get(option.name)?.priority === 78)) {
                requests.set(openingTank, { ...requests.get(openingTank)!, priority: 75 });
            }
        }
        const refineryQueue = productionApi.getQueueData(QueueType.Structures), pendingRefinery = refineryQueue.items[0]?.rules;
        if (this.refineryLocation && this.refineryLocation.name !== pendingRefinery?.name) this.refineryLocation = undefined;
        let restoringIncome = false;
        if (context.difficulty === "brutal" && pendingRefinery?.refinery &&
            (refineryQueue.status === QueueStatus.Active || refineryQueue.status === QueueStatus.OnHold) &&
            playerData.credits < pendingRefinery.cost && !readPressure(context).pressured && !ownedBaseUnderAttack) {
            const sites = game.getVisibleUnits(player.name, "self", rules => rules.refinery)
                .map(id => game.getGameObjectData(id)?.tile).filter((tile): tile is PatchPoint => !!tile);
            const patches = findVisiblePatches(game, player.name), situation = readStrategicSituation(game, playerData);
            restoringIncome = sites.length === 1 && patches.length > 0 && !patches.some(patch => isServed(patch, sites)) &&
                situation.enemy.aircraft === 0 && situation.enemy.infantry < 8;
        }
        if (restoringIncome && productionApi.getQueueData(QueueType.Infantry).status === QueueStatus.Idle &&
            game.getVisibleUnits(player.name, "self", rules => rules.capturable && rules.produceCashAmount > 0).length > 0) {
            requests.delete("ENGINEER"); requests.delete("SENGINEER");
        }
        this.queueStates = QUEUES.map((queueType) => {
            const options = productionApi.getAvailableObjects(queueType).filter(option => !ecoOnly || isCivilianEconomy(option));
            const items = QueueController.getPrioritiesForBuildingOptions(options, requests);
            const topItem = items.length > 0 ? items[items.length - 1] : undefined;
            return {
                queue: queueType,
                items,
                // only if the top item has a  priority above zero
                topItem: topItem && topItem.priority > 0 ? topItem : undefined,
            };
        });
        const paidMinerQueue = productionApi.getQueueData(QueueType.Vehicles), paidMiner = paidMinerQueue.items[0]?.rules;
        let fundPaidEarlyMiner = false;
        if (context.difficulty === "brutal" && pendingRefinery?.refinery && paidMiner?.harvester &&
            ["HARV", "CMIN"].includes(pendingRefinery.freeUnit) &&
            [QueueStatus.Active, QueueStatus.OnHold].includes(refineryQueue.status) &&
            [QueueStatus.Active, QueueStatus.OnHold].includes(paidMinerQueue.status) &&
            playerData.credits < paidMiner.cost && !playerData.power?.isLowPower && readPressure(context).homeQuiet && !ownedBaseUnderAttack &&
            game.getVisibleUnits(player.name, "self", rules => rules.harvester).length < Math.min(3, minerTarget) &&
            this.queueStates.find(state => state.queue === QueueType.Vehicles)?.topItem?.unit.harvester) {
            const sites = game.getVisibleUnits(player.name, "self", rules => rules.refinery)
                .map(id => game.getGameObjectData(id)?.tile).filter((tile): tile is PatchPoint => !!tile);
            fundPaidEarlyMiner = sites.length === 1 && findVisiblePatches(game, player.name).some(patch => patch.value >= 6000 && isServed(patch, sites));
        }
        const priorityVehicle = this.queueStates.find(state => state.queue === QueueType.Vehicles)?.topItem;
        let fundPriorityVehicle = false;
        if (context.difficulty === "brutal" && priorityVehicle && !priorityVehicle.unit.harvester &&
            (priorityVehicle.priority >= 100 || priorityVehicle.priority >= 85 && (readPressure(context).baseUnderSiege || ownedBaseUnderAttack)) &&
            playerData.credits < priorityVehicle.unit.cost && !playerData.power?.isLowPower &&
            game.getVisibleUnits(player.name, "self", rules => rules.harvester).length > 0) {
            const sites = game.getVisibleUnits(player.name, "self", rules => rules.refinery)
                .map(id => game.getGameObjectData(id)?.tile).filter((tile): tile is PatchPoint => !!tile);
            fundPriorityVehicle = sites.length > 0 && (findVisiblePatches(game, player.name).some(patch => isServed(patch, sites)) ||
                game.getVisibleUnits(player.name, "self", rules => rules.harvester).some(id => {
                    const miner = game.getUnitData(id);
                    return miner?.owner === player.name && !miner.isWarpedOut &&
                        (miner.harvestedOre ?? 0) + (miner.harvestedGems ?? 0) > 0 &&
                        sites.some(site => Math.hypot(miner.tile.rx - site.rx, miner.tile.ry - site.ry) <= 4);
                }));
        }
        const totalWeightAcrossQueues = this.queueStates
            .map((decision) => decision.topItem?.priority ?? 0)
            .reduce((pV, cV) => pV + cV, 0);
        const totalCostAcrossQueues = this.queueStates
            .map((decision) => decision.topItem?.unit.cost ?? 0)
            .reduce((pV, cV) => pV + cV, 0);

        this.queueStates.forEach((decision) => {
            if (decision.queue === QueueType.Structures && (fundPaidEarlyMiner || fundPriorityVehicle && pendingRefinery?.refinery &&
                [QueueStatus.Active, QueueStatus.OnHold].includes(refineryQueue.status))) {
                // Native funding visits structures first; priorities alone cannot fund this paid miner first.
                if (refineryQueue.status === QueueStatus.Active) {
                    actionsApi.pauseProduction(QueueType.Structures);
                    this.incomeHeldRefinery = pendingRefinery?.name;
                }
                return;
            }
            if (decision.queue === QueueType.Structures && this.incomeHeldRefinery) {
                const resumeIncomeHold = this.incomeHeldRefinery === pendingRefinery?.name && refineryQueue.status === QueueStatus.OnHold;
                this.incomeHeldRefinery = undefined;
                if (resumeIncomeHold) { actionsApi.resumeProduction(QueueType.Structures); return; }
            }
            if (fundPriorityVehicle && decision.queue === QueueType.Structures && refineryQueue.status === QueueStatus.Idle && decision.topItem?.unit.refinery) return;
            if (context.difficulty === "brutal" && isCrawlProduction(game, player.name, decision.queue) &&
                (readPressure(context).pressured || ownedBaseUnderAttack && !playerData.power?.isLowPower)) {
                if (productionApi.getQueueData(decision.queue).status === QueueStatus.Active) actionsApi.pauseProduction(decision.queue);
                return;
            }
            if (restoringIncome && decision.queue === QueueType.Vehicles && decision.topItem &&
                ["HTNK", "MTNK"].includes(decision.topItem.unit.name) && decision.topItem.priority <= 85) {
                const queue = productionApi.getQueueData(QueueType.Vehicles), current = queue.items[0]?.rules.name;
                if (!current || current === decision.topItem.unit.name) {
                    if (queue.status === QueueStatus.Active) actionsApi.pauseProduction(QueueType.Vehicles);
                    return;
                }
            }
            if (fundPriorityVehicle && decision.queue === QueueType.Structures && pendingRefinery?.weaponsFactory &&
                [QueueStatus.Active, QueueStatus.OnHold].includes(refineryQueue.status) &&
                game.getVisibleUnits(player.name, "self", rules => rules.weaponsFactory).length > 0) {
                if (refineryQueue.status === QueueStatus.Active) actionsApi.pauseProduction(QueueType.Structures);
                return;
            }
            // Native infantry debits precede vehicles; defer only new, lower-priority basic infantry.
            if (context.difficulty === "brutal" && priorityVehicle && priorityVehicle.priority >= 100 &&
                playerData.credits < priorityVehicle.unit.cost && decision.queue === QueueType.Infantry && decision.topItem &&
                ["E1", "E2"].includes(decision.topItem.unit.name) && decision.topItem.priority < priorityVehicle.priority &&
                productionApi.getQueueData(QueueType.Infantry).status === QueueStatus.Idle) return;
            // Fund the marked refinery before buying miners only its unfinished field can support.
            if (context.difficulty === "brutal" && futureRefinery && pendingRefinery?.refinery &&
                [QueueStatus.Active, QueueStatus.OnHold].includes(refineryQueue.status) &&
                decision.queue === QueueType.Vehicles && decision.topItem?.unit.harvester &&
                currentMinerTarget > 0 && minerTarget > currentMinerTarget &&
                game.getVisibleUnits(player.name, "self", rules => rules.harvester).length >= currentMinerTarget &&
                playerData.credits < pendingRefinery.cost && !readPressure(context).pressured && !ownedBaseUnderAttack &&
                productionApi.getQueueData(QueueType.Vehicles).status === QueueStatus.Idle) return;
            const buildingLocation = decision.topItem && requests.get(decision.topItem.unit.name)?.specificLocation;
            this.updateBuildQueue(
                game,
                productionApi,
                actionsApi,
                playerData,
                threatCache,
                requests,
                decision.queue,
                decision.topItem,
                totalWeightAcrossQueues,
                totalCostAcrossQueues,
                logger,
                cappedSupport,
                context.difficulty,
                !!crawl && decision.queue === crawl.queue && decision.topItem?.unit.name === crawl.rules.name &&
                    requests.get(crawl.rules.name)?.specificLocation?.x === crawl.location.rx &&
                    requests.get(crawl.rules.name)?.specificLocation?.y === crawl.location.ry,
                context.difficulty === "brutal" && decision.queue === QueueType.Structures && !!decision.topItem?.unit.refinery &&
                    !!buildingLocation && !readPressure(context).pressured &&
                    (!ownedBaseUnderAttack || game.getVisibleUnits(player.name, "self", rules => rules.refinery).length === 0) &&
                    game.canPlaceBuilding(player.name, decision.topItem.unit.name, { rx: buildingLocation.x, ry: buildingLocation.y }),
                minerTarget,
                ownedBaseUnderAttack,
            );
        });

        // Repair is simple - just repair everything that's damaged.
        if (playerData.credits > 0 && game.getCurrentTick() > this.lastRepairCheckAt + REPAIR_CHECK_INTERVAL) {
            game.getVisibleUnits(playerData.name, "self", (r) => r.repairable).forEach((unitId) => {
                const unit = game.getUnitData(unitId);
                if (!unit || !unit.hitPoints || !unit.maxHitPoints || unit.hasWrenchRepair) {
                    return;
                }
                if (unit.hitPoints < unit.maxHitPoints) {
                    actionsApi.toggleRepairWrench(unitId);
                }
            });
            this.lastRepairCheckAt = game.getCurrentTick();
        }

        sellDuplicateRefinery(context);

        // Emergency salvage: if we have 0 harvesters or 0 refineries and cannot afford replacement (< 800 credits),
        // sell non-essential auxiliary structures (tech lab, radar, or static defense) to recover cash.
        const tick = game.getCurrentTick();
        if (context.difficulty === "brutal" && playerData.credits < 800 && tick > this.lastEmergencySaleAt + 450) {
            const situation = readStrategicSituation(game, playerData);
            const needsEmergencyCash = situation.harvesters === 0 || ((situation.own.NAREFN ?? 0) + (situation.own.GAREFN ?? 0) === 0);
            if (needsEmergencyCash) {
                const auxiliaryRules = (r: TechnoRules) =>
                    ["NATECH", "GATECH", "NARADR", "AMRADR", "GAAIRC"].includes(r.name) ||
                    ((r.name === "NALASR" || r.name === "GAPILL") && situation.harvesters === 0);
                const candidates = game.getVisibleUnits(playerData.name, "self", auxiliaryRules);
                if (candidates.length > 0) {
                    const sellId = candidates[0];
                    logger(`Emergency cash liquidation: selling building ${sellId} to break deadlock`);
                    actionsApi.sellBuilding?.(sellId);
                    this.lastEmergencySaleAt = tick;
                }
            }
        }
    }

    private updateBuildQueue(
        game: GameApi,
        productionApi: ProductionApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        threatCache: GlobalThreat | null,
        unitTypeRequests: Map<string, UnitRequest>,
        queueType: QueueType,
        decision: TechnoRulesWithPriority | undefined,
        totalWeightAcrossQueues: number,
        totalCostAcrossQueues: number,
        logger: (message: string) => void,
        cappedSupport: ReadonlySet<string>,
        difficulty?: "normal" | "brutal",
        requestedCrawl = false,
        requestedRefinery = false,
        minerTarget = 0,
        ownedBaseUnderAttack = false,
    ): void {
        const myCredits = playerData.credits;
        // With five or six queues, every queue can fall below 25%. Always
        // let the highest-priority queue progress rather than holding all of them.
        const highestPriority = Math.max(0, ...this.queueStates.map(state => state.topItem?.priority ?? 0));
        const minimumPriority = highestPriority >= 85 ? 60 : Math.min(totalWeightAcrossQueues * 0.25, highestPriority);

        const queueData = productionApi.getQueueData(queueType);
        const currentItem = queueData.items[0];
        if (currentItem && cappedSupport.has(currentItem.rules.name)) {
            // Concurrent waves and decaying mission requests must not exceed
            // the global specialist cap once another factory delivers a unit.
            actionsApi.unqueueFromProduction(queueType, currentItem.rules.name, currentItem.rules.type, currentItem.quantity);
            return;
        }
        if (difficulty === "brutal" && queueType === QueueType.Vehicles && currentItem &&
            (queueData.status === QueueStatus.Active || queueData.status === QueueStatus.OnHold) &&
            decision?.unit.harvester && decision.priority === 110 && ["HTNK", "MTNK", "DRON"].includes(currentItem.rules.name) &&
            (unitTypeRequests.get(currentItem.rules.name)?.priority ?? 0) < 100 &&
            readPressure({ game, player: { name: playerData.name }, difficulty }).homeQuiet && !ownedBaseUnderAttack &&
            game.getVisibleUnits(playerData.name, "self", rules => rules.harvester).length < Math.min(5, minerTarget)) {
            logger(`Replacing ordinary ${currentItem.rules.name} with needed early income in queue ${queueTypeToName(queueType)}`);
            actionsApi.unqueueFromProduction(queueType, currentItem.rules.name, currentItem.rules.type, currentItem.quantity);
            return;
        }
        if (queueData.status == QueueStatus.Idle) {
            this.placementFailures.clear();
            // Start building the decided item.
            const canAffordBuilding = isBuildingQueue(queueType) && decision !== undefined && decision.priority >= 18 && myCredits >= decision.unit.cost + 400;
            if (decision !== undefined && (requestedCrawl && myCredits >= decision.unit.cost || requestedRefinery && myCredits > 0 || canAffordBuilding || !(totalCostAcrossQueues > myCredits && decision.priority < minimumPriority))) {
                logger(`Decision (${queueTypeToName(queueType)}): ${decision.unit.name}`);
                actionsApi.queueForProduction(queueType, decision.unit.name, decision.unit.type, 1);
                if (difficulty === "brutal" && queueType === QueueType.Structures && decision.unit.refinery &&
                    game.getVisibleUnits(playerData.name, "self", rules => rules.refinery).length > 0) {
                    const location = unitTypeRequests.get(decision.unit.name)?.specificLocation;
                    if (location) this.refineryLocation = { name: decision.unit.name, location: new Vector2(location.x, location.y) };
                }
                if (difficulty === "brutal") this.economicPlacementFailures.delete(decision.unit.name);
                if (difficulty === "brutal") recordRefineryOrder(game, playerData.name, decision.unit.name, unitTypeRequests.get(decision.unit.name)?.specificLocation);
                if (difficulty === "brutal") recordBaseCrawlOrder(game, playerData.name, decision.unit.name, unitTypeRequests.get(decision.unit.name)?.specificLocation);
                if (difficulty === "brutal") recordDefenseOrder(game, playerData.name, decision.unit.name, unitTypeRequests.get(decision.unit.name)?.specificLocation);
            }
        } else if (queueData.status == QueueStatus.Ready && queueData.items.length > 0) {
            if (isBuildingQueue(queueType)) {
                const readyUnit = queueData.items[0].rules, committedRefinery = this.refineryLocation;
                const heldLocation = difficulty === "brutal" && readyUnit.refinery && committedRefinery?.name === readyUnit.name
                    ? committedRefinery.location : undefined;
                const specificEconomyLocation = difficulty === "brutal" &&
                    (!!heldLocation || isMinerRefineryProduction(game, playerData.name, readyUnit.name) || isCrawlProduction(game, playerData.name, queueType) ||
                        queueType === QueueType.Armory && isDefenseProduction(game, playerData.name));
                // Other idle queues retain their historical clear behavior, but must not erase this marked build's failures.
                const failureCounts = specificEconomyLocation ? this.economicPlacementFailures : this.placementFailures;
                const failures = failureCounts.get(readyUnit.name) ?? 0;
                failureCounts.set(readyUnit.name, failures + 1);

                // If too many failures, cancel the building to unblock the queue
                if (failures >= PLACEMENT_FAILURE_CANCEL_THRESHOLD) {
                    logger(`Cancelling ready ${readyUnit.name} after ${failures} placement failures`);
                    actionsApi.unqueueFromProduction(queueType, readyUnit.name, readyUnit.type, 1);
                    failureCounts.delete(readyUnit.name);
                    return;
                }

                const currentRequest = unitTypeRequests.get(readyUnit.name);
                let placeX = currentRequest?.specificLocation?.x ?? heldLocation?.x;
                let placeY = currentRequest?.specificLocation?.y ?? heldLocation?.y;

                // Check if the suggested location is valid
                let canPlace = placeX !== undefined && placeY !== undefined &&
                    game.canPlaceBuilding(playerData.name, readyUnit.name, { rx: placeX, ry: placeY });

                if ((!canPlace || failures >= PLACEMENT_FAILURE_RETRY_THRESHOLD) && !specificEconomyLocation) {
                    // After threshold, find an alternative placement location
                    const conYards = game.getVisibleUnits(playerData.name, "self", (r: TechnoRules) => r.constructionYard);
                    const conYardData = conYards.length > 0 ? game.getUnitData(conYards[0]) : undefined;
                    const centerPoint = conYardData?.tile
                        ? new Vector2(conYardData.tile.rx, conYardData.tile.ry)
                        : playerData.startLocation;
                    const altLocation = getDefaultPlacementLocation(game, playerData, centerPoint, readyUnit);
                    if (altLocation) {
                        logger(`Retrying ${readyUnit.name} at alternative location (${altLocation.rx},${altLocation.ry}) after ${failures} failures`);
                        placeX = altLocation.rx;
                        placeY = altLocation.ry;
                        canPlace = true;
                    } else {
                        logger(`Cannot find alternative location for ${readyUnit.name} (failure #${failures + 1})`);
                    }
                }

                if (canPlace && placeX !== undefined && placeY !== undefined) {
                    actionsApi.placeBuilding(readyUnit.name, placeX, placeY);
                }
                return;
            }
        } else if (queueData.status == QueueStatus.Active && queueData.items.length > 0 && decision != null) {
            this.placementFailures.clear();
            // Consider cancelling if something else is significantly higher priority than what is currently being produced.

            const currentProduction = queueData.items[0].rules;
            // Never unqueue buildings once active; only allow cancelling non-buildings for emergency priorities
            if (!isBuildingQueue(queueType) &&
                (decision.unit.name !== currentProduction.name || decision.unit.type !== currentProduction.type)) {
                // Changing our mind.
                const currentRequest = unitTypeRequests.get(currentProduction.name);
                const currentItemPriority = currentRequest ? currentRequest.priority : 0;
                const newItemPriority = decision.priority;
                // Only cancel if current item is explicitly obsolete/capped (0 priority) and new item is an emergency (>= 80),
                // or if new item is genuinely more than 2x higher priority than the active request.
                const miners = difficulty === "brutal" && currentProduction.harvester
                    ? game.getVisibleUnits(playerData.name, "self", rules => rules.harvester).length : 0;
                const keepPaidMiner = difficulty === "brutal" && currentProduction.harvester && miners < 12 &&
                    (decision.unit.name === "DRON" || ["HTNK", "MTNK"].includes(decision.unit.name) && newItemPriority < 100 &&
                        miners < minerTarget &&
                        !readPressure({ game, player: { name: playerData.name }, difficulty }).baseUnderSiege && !ownedBaseUnderAttack &&
                        (miners === 1 || readStrategicSituation(game, playerData).enemy.infantry < 8));
                if (!keepPaidMiner && (currentItemPriority === 0 ? newItemPriority >= 80 : newItemPriority > currentItemPriority * 2)) {
                    logger(
                        `Dequeueing queue ${queueTypeToName(queueData.type)} unit ${currentProduction.name} because ${
                            decision.unit.name
                        } has 2x higher priority.`,
                    );
                    actionsApi.unqueueFromProduction(queueData.type, currentProduction.name, currentProduction.type, 1);
                }
            } else {
                // Not changing our mind, but maybe other queues are more important for now.
                // Do not pause if we can easily afford this unit, or if it is an active military response
                const isVitalBuilding = isBuildingQueue(queueType) && currentProduction && (currentProduction.refinery || currentProduction.weaponsFactory || requestedCrawl);
                if (!isVitalBuilding && totalCostAcrossQueues > myCredits && myCredits < (isBuildingQueue(queueType) ? 200 : decision.unit.cost) && decision.priority < minimumPriority) {
                    logger(
                        `Pausing queue ${queueTypeToName(queueData.type)} because weight is low (${
                            decision.priority
                        }/${totalWeightAcrossQueues})`,
                    );
                    actionsApi.pauseProduction(queueData.type);
                }
            }
        } else if (queueData.status == QueueStatus.OnHold) {
            const currentItem = queueData.items[0];
            const currentPriority = currentItem ? (unitTypeRequests.get(currentItem.rules.name)?.priority ?? 0) : 0;
            // Never cancel an in-progress building queue item; only cancel non-buildings whose priority dropped to 0
            if (currentItem && !isBuildingQueue(queueData.type) && currentPriority === 0 && (!decision || decision.priority === 0)) {
                logger(`Cancelling held ${currentItem.rules.name} in queue ${queueTypeToName(queueData.type)} because priority dropped to 0`);
                actionsApi.unqueueFromProduction(queueData.type, currentItem.rules.name, currentItem.rules.type, currentItem.quantity);
                return;
            }
            // Consider resuming queue if priority is high relative to other queues or if we can afford this item.
            const affordable = isBuildingQueue(queueData.type) ? myCredits >= 200 : (decision && myCredits >= decision.unit.cost);
            if (requestedCrawl || totalWeightAcrossQueues === 0 || myCredits >= totalCostAcrossQueues ||
                (decision && affordable && decision.priority >= 15)) {
                logger(`Resuming queue ${queueTypeToName(queueData.type)} because credits are high or item is affordable`);
                actionsApi.resumeProduction(queueData.type);
            } else if (decision && decision.priority >= minimumPriority) {
                logger(
                    `Resuming queue ${queueTypeToName(queueData.type)} because weight is high (${
                        decision.priority
                    }/${totalWeightAcrossQueues})`,
                );
                actionsApi.resumeProduction(queueData.type);
            }
        }
    }

    private static getPrioritiesForBuildingOptions(
        options: TechnoRules[],
        unitTypeRequests: Map<string, UnitRequest>,
    ): TechnoRulesWithPriority[] {
        let priorityQueue: TechnoRulesWithPriority[] = [];
        options.forEach((option) => {
            const priority = unitTypeRequests.get(option.name)?.priority ?? 0;
            if (priority > 0) {
                priorityQueue.push({ unit: option, priority });
            }
        });

        priorityQueue = priorityQueue.sort((a, b) => a.priority - b.priority);
        return priorityQueue;
    }

    public getGlobalDebugText(gameApi: GameApi, productionApi: ProductionApi) {
        const productionState = QUEUES.reduce((prev, queueType) => {
            if (productionApi.getQueueData(queueType).size === 0) {
                return prev;
            }
            const paused = productionApi.getQueueData(queueType).status === QueueStatus.OnHold;
            return (
                prev +
                " [" +
                queueTypeToName(queueType) +
                (paused ? " PAUSED" : "") +
                ": " +
                productionApi
                    .getQueueData(queueType)
                    .items.map((item) => item.rules.name + (item.quantity > 1 ? "x" + item.quantity : "")) +
                "]"
            );
        }, "");

        const queueStates = this.queueStates
            .filter((queueState) => queueState.items.length > 0)
            .map((queueState) => {
                const queueString = queueState.items
                    .map((item) => item.unit.name + "(" + Math.round(item.priority * 10) / 10 + ")")
                    .join(", ");
                return `${queueTypeToName(queueState.queue)} Prios: ${queueString}\n`;
            })
            .join("");

        return `Production: ${productionState}\n${queueStates}`;
    }
}

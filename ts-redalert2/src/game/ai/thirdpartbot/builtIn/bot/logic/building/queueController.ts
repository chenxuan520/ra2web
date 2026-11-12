import {
    ActionsApi,
    GameApi,
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
import { isEcoOnly, readPressure } from "../common/pressure";
import { isCivilianEconomy } from "./economyPlan";

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
        for (const option of productionApi.getAvailableObjects(QueueType.Vehicles)) {
            if (!option.harvester) continue;
            const logic = BUILDING_NAME_TO_RULES.get(option.name);
            if (!logic) continue;
            if (context.difficulty === "brutal" && game.getVisibleUnits(player.name, "self", rules => rules.harvester).length >= 3 &&
                !productionApi.getQueueData(QueueType.Vehicles).items.some(item => item.rules.name === option.name) &&
                (productionApi.getQueueData(QueueType.Structures).items.some(item =>
                    item.rules.refinery && item.rules.freeUnit === option.name) ||
                 productionApi.getAvailableObjects(QueueType.Structures).some(rules =>
                    rules.refinery && rules.freeUnit === option.name && (requests.get(rules.name)?.priority ?? 0) > 0))) continue;
            let priority = logic.getPriority(game, playerData, option, threatCache, context.difficulty);
            if (context.difficulty === "brutal") {
                const miners = game.getVisibleUnits(player.name, "self", rules => rules.harvester).length;
                const desired = desiredMiners(game, playerData);
                const situation = readStrategicSituation(game, playerData);
                const core = countCoreTanks(situation);
                const pressure = readPressure(context);
                const minCoreBeforeMiner2 = isSovietCountry(playerData.country?.name) ? 2 : 1;

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
                } else if (miners >= 3 && miners < desired && !pressure.baseUnderSiege && (ecoOnly || core >= 2 * (miners - 2))) {
                    priority = 78;
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
            }
            if (situation.harvesters >= 2 && situation.enemy.infantry >= 8 &&
                (situation.own.MTNK ?? 0) + (situation.own.HTNK ?? 0) < Math.min(6, Math.max(2, Math.ceil(situation.enemy.infantry / 6)))) {
                const tank = productionApi.getAvailableObjects(QueueType.Vehicles).find(option => option.name === "MTNK" || option.name === "HTNK");
                if (tank) requests.set(tank.name, { priority: 100, specificLocation: null });
            }
            if (situation.harvesters >= 1) {
                const core = countCoreTanks(situation);
                const tankName = isSovietCountry(playerData.country?.name) ? "HTNK" : "MTNK";
                const tank = productionApi.getAvailableObjects(QueueType.Vehicles).find(option => option.name === tankName);
                if (tank) {
                    const hasDualRefinery = (situation.own.NAREFN ?? 0) + (situation.own.GAREFN ?? 0) >= 2;
                    if ((core < 1 && situation.harvesters >= 1) || (core < 4 && (situation.harvesters >= 2 || hasDualRefinery))) {
                        requests.set(tank.name, { priority: 85, specificLocation: null });
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
        const totalWeightAcrossQueues = this.queueStates
            .map((decision) => decision.topItem?.priority ?? 0)
            .reduce((pV, cV) => pV + cV, 0);
        const totalCostAcrossQueues = this.queueStates
            .map((decision) => decision.topItem?.unit.cost ?? 0)
            .reduce((pV, cV) => pV + cV, 0);

        this.queueStates.forEach((decision) => {
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
        if (queueData.status == QueueStatus.Idle) {
            this.placementFailures.clear();
            // Start building the decided item.
            const canAffordBuilding = isBuildingQueue(queueType) && decision !== undefined && decision.priority >= 18 && myCredits >= decision.unit.cost + 400;
            if (decision !== undefined && (canAffordBuilding || !(totalCostAcrossQueues > myCredits && decision.priority < minimumPriority))) {
                logger(`Decision (${queueTypeToName(queueType)}): ${decision.unit.name}`);
                actionsApi.queueForProduction(queueType, decision.unit.name, decision.unit.type, 1);
            }
        } else if (queueData.status == QueueStatus.Ready && queueData.items.length > 0) {
            if (isBuildingQueue(queueType)) {
                const readyUnit = queueData.items[0].rules;
                const failures = this.placementFailures.get(readyUnit.name) ?? 0;
                this.placementFailures.set(readyUnit.name, failures + 1);

                // If too many failures, cancel the building to unblock the queue
                if (failures >= PLACEMENT_FAILURE_CANCEL_THRESHOLD) {
                    logger(`Cancelling ready ${readyUnit.name} after ${failures} placement failures`);
                    actionsApi.unqueueFromProduction(queueType, readyUnit.name, readyUnit.type, 1);
                    this.placementFailures.delete(readyUnit.name);
                    return;
                }

                const currentRequest = unitTypeRequests.get(readyUnit.name);
                let placeX = currentRequest?.specificLocation?.x;
                let placeY = currentRequest?.specificLocation?.y;

                // Check if the suggested location is valid
                let canPlace = placeX !== undefined && placeY !== undefined &&
                    game.canPlaceBuilding(playerData.name, readyUnit.name, { rx: placeX, ry: placeY });

                if (!canPlace || failures >= PLACEMENT_FAILURE_RETRY_THRESHOLD) {
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
                if (currentItemPriority === 0 ? newItemPriority >= 80 : newItemPriority > currentItemPriority * 2) {
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
                const isVitalBuilding = isBuildingQueue(queueType) && currentProduction && (currentProduction.refinery || currentProduction.weaponsFactory);
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
            if (totalWeightAcrossQueues === 0 || myCredits >= totalCostAcrossQueues ||
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

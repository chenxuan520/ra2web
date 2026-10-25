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
import { NATIONAL_SUPPORT_LIMITS } from "../../strategy/nationalComposition";
import { readStrategicSituation } from "../../strategy/nationalComposition";

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
        const cappedSupport = new Set<string>();
        if (context.difficulty === "brutal") {
            for (const name of ["E1", "E2"]) {
                const count = game.getVisibleUnits(player.name, "self", rules => rules.name === name).length;
                if (count >= (name === "E1" ? 9 : 32)) requests.delete(name);
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
            let priority = logic.getPriority(game, playerData, option, threatCache);
            if (context.difficulty === "brutal") {
                const miners = game.getVisibleUnits(player.name, "self", rules => rules.harvester).length;
                const refineries = game.getVisibleUnits(player.name, "self", rules => rules.refinery).length;
                const desired = Math.min(6, refineries * 2);
                if (miners < desired) priority = Math.max(priority, miners < 4 ? 80 : 60);
            }
            if (priority > (requests.get(option.name)?.priority ?? 0)) {
                requests.set(option.name, { priority, specificLocation: null });
            }
        }
        if (context.difficulty === "brutal") {
            const situation = readStrategicSituation(game, playerData);
            if (situation.harvesters >= 1 && situation.enemy.infantry >= 8 &&
                (situation.own.MTNK ?? 0) + (situation.own.HTNK ?? 0) < 2) {
                const tank = productionApi.getAvailableObjects(QueueType.Vehicles).find(option => option.name === "MTNK" || option.name === "HTNK");
                if (tank) requests.set(tank.name, { priority: 100, specificLocation: null });
            }
        }
        this.queueStates = QUEUES.map((queueType) => {
            const options = productionApi.getAvailableObjects(queueType);
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
        const minimumPriority = Math.min(totalWeightAcrossQueues * 0.25, highestPriority);

        const queueData = productionApi.getQueueData(queueType);
        const currentItem = queueData.items[0];
        if (currentItem && cappedSupport.has(currentItem.rules.name)) {
            // Concurrent waves and decaying mission requests must not exceed
            // the global specialist cap once another factory delivers a unit.
            actionsApi.unqueueFromProduction(queueType, currentItem.rules.name, currentItem.rules.type, currentItem.quantity);
            return;
        }
        if (queueData.status == QueueStatus.Idle) {
            // Start building the decided item.
            if (decision !== undefined && !(totalCostAcrossQueues > myCredits && decision.priority < minimumPriority)) {
                logger(`Decision (${queueTypeToName(queueType)}): ${decision.unit.name}`);
                actionsApi.queueForProduction(queueType, decision.unit.name, decision.unit.type, 1);
            }
        } else if (queueData.status == QueueStatus.Ready && queueData.items.length > 0) {
            if (isBuildingQueue(queueType)) {
                const readyUnit = queueData.items[0].rules;
                const currentRequest = unitTypeRequests.get(readyUnit.name);
                if (!currentRequest) {
                    // No one is requesting this anymore, cancel
                    logger(`Cancelling ready ${readyUnit.name} because no one is requesting anymore`);
                    actionsApi.unqueueFromProduction(queueType, readyUnit.name, readyUnit.type, 1);
                    this.placementFailures.delete(readyUnit.name);
                    return;
                }
                if (!currentRequest.specificLocation) {
                    // No one is requesting this anymore, cancel
                    logger(`Cancelling ready ${readyUnit.name} because location is unspecified`);
                    actionsApi.unqueueFromProduction(queueType, readyUnit.name, readyUnit.type, 1);
                    this.placementFailures.delete(readyUnit.name);
                    return;
                }

                const failures = this.placementFailures.get(readyUnit.name) ?? 0;

                // If too many failures, cancel the building to unblock the queue
                if (failures >= PLACEMENT_FAILURE_CANCEL_THRESHOLD) {
                    logger(`Cancelling ready ${readyUnit.name} after ${failures} placement failures`);
                    actionsApi.unqueueFromProduction(queueType, readyUnit.name, readyUnit.type, 1);
                    this.placementFailures.delete(readyUnit.name);
                    return;
                }

                let placeX = currentRequest.specificLocation.x;
                let placeY = currentRequest.specificLocation.y;

                // Check if the suggested location is valid
                const canPlace = game.canPlaceBuilding(playerData.name, readyUnit.name, { rx: placeX, ry: placeY });

                if (!canPlace) {
                    this.placementFailures.set(readyUnit.name, failures + 1);

                    // After threshold, try to find an alternative placement location
                    if (failures >= PLACEMENT_FAILURE_RETRY_THRESHOLD) {
                        const conYards = game.getVisibleUnits(playerData.name, "self", (r: TechnoRules) => r.constructionYard);
                        if (conYards.length > 0) {
                            const conYardData = game.getUnitData(conYards[0]);
                            if (conYardData?.tile) {
                                const altLocation = getDefaultPlacementLocation(
                                    game,
                                    playerData,
                                    new Vector2(conYardData.tile.rx, conYardData.tile.ry),
                                    readyUnit,
                                );
                                if (altLocation) {
                                    logger(`Retrying ${readyUnit.name} at alternative location (${altLocation.rx},${altLocation.ry}) after ${failures} failures`);
                                    actionsApi.placeBuilding(readyUnit.name, altLocation.rx, altLocation.ry);
                                    this.placementFailures.delete(readyUnit.name);
                                    return;
                                }
                            }
                        }
                        logger(`Cannot find alternative location for ${readyUnit.name} (failure #${failures + 1})`);
                    }
                    return;
                }

                // Location is valid, place the building
                actionsApi.placeBuilding(readyUnit.name, placeX, placeY);
                this.placementFailures.delete(readyUnit.name);
            }
        } else if (queueData.status == QueueStatus.Active && queueData.items.length > 0 && decision != null) {
            // Consider cancelling if something else is significantly higher priority than what is currently being produced.

            const currentProduction = queueData.items[0].rules;
            if (decision.unit.name !== currentProduction.name || decision.unit.type !== currentProduction.type) {
                // Changing our mind.
                const currentRequest = unitTypeRequests.get(currentProduction.name);
                const currentItemPriority = currentRequest ? currentRequest.priority : 0;
                const newItemPriority = decision.priority;
                if (newItemPriority > currentItemPriority * 2) {
                    logger(
                        `Dequeueing queue ${queueTypeToName(queueData.type)} unit ${currentProduction.name} because ${
                            decision.unit.name
                        } has 2x higher priority.`,
                    );
                    actionsApi.unqueueFromProduction(queueData.type, currentProduction.name, currentProduction.type, 1);
                }
            } else {
                // Not changing our mind, but maybe other queues are more important for now.
                if (totalCostAcrossQueues > myCredits && decision.priority < minimumPriority) {
                    logger(
                        `Pausing queue ${queueTypeToName(queueData.type)} because weight is low (${
                            decision.priority
                        }/${totalWeightAcrossQueues})`,
                    );
                    actionsApi.pauseProduction(queueData.type);
                }
            }
        } else if (queueData.status == QueueStatus.OnHold) {
            // Consider resuming queue if priority is high relative to other queues.
            if (totalWeightAcrossQueues === 0 || myCredits >= totalCostAcrossQueues) {
                logger(`Resuming queue ${queueTypeToName(queueData.type)} because credits are high`);
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

import { GameApi, PlayerData, QueueType, TechnoRules } from "../../../../game-api";
import { MissionContext } from "../../common/context";
import { DebugLogger, maxBy } from "../../common/utils";
import { buildStructureAtLocation, Mission, MissionAction, noop } from "../mission";
import { GlobalThreat } from "../../threat/threat";
import {
    BUILDING_NAME_TO_RULES,
    DEFAULT_BUILDING_PRIORITY,
    getDefaultPlacementLocation,
} from "../../building/buildingRules";
import { queueTypeToName } from "../../building/queueController";
import { getGrandCannonPlacement, getStrategicBuildingPriority } from "../../building/strategicBuildings";
import { getCompactFirstFactoryPlacement, getEconomicFirstFactoryPlacement } from "../../building/firstFactoryPlacement";
import { getEconomyBuildingPriority } from "../../building/economyPlan";
import { getCommittedRefineryLocation, noteMinerRefineryRequest, planMinerRefinery } from "../../building/refineryEconomy";
import { planRefinery, RefineryPlan } from "../../building/resourceCollectionBuilding";
import { getDefenseState } from "../../building/defensePlan";
import { isPressured } from "../../common/pressure";

// Legacy mission encompassing the old "build queue" logic.
export class BaseBuildingMission extends Mission {
    private defenseState?: ReturnType<typeof getDefenseState>;

    constructor(
        private queueType: QueueType,
        logger: DebugLogger,
    ) {
        super(`building-mission-${queueTypeToName(queueType)}`, logger);
    }

    _onAiUpdate(context: MissionContext): MissionAction {
        if (context.difficulty === "brutal") this.defenseState = getDefenseState(context.game, context.player.name);
        const options = context.player.production.getAvailableObjects(this.queueType);
        const playerData = context.game.getPlayerData(context.player.name);
        if (options.length === 0) {
            return noop();
        }

        const { game, matchAwareness } = context;
        const threatCache = matchAwareness.getThreatCache();
        const committedNames = context.difficulty === "brutal"
            ? new Set(context.player.production.getQueueData(this.queueType).items.map(item => item.rules.name))
            : new Set<string>();

        const optionWithPriority = options.map((option) => {
            const refineryPlan = context.difficulty === "brutal" && option.refinery ? planRefinery(game, playerData, option) : undefined;
            return {
                option,
                refineryPlan,
                priority: this.getPriorityForBuildingOption(option, game, playerData, threatCache, context.difficulty, committedNames.has(option.name), context, refineryPlan),
            };
        });

        if (context.difficulty === "brutal") {
            // A large building with no legal site must not block smaller useful
            // buildings. Stable sorting preserves the API order for equal priorities.
            const candidates = optionWithPriority
                .filter((candidate) => candidate.priority > 0)
                .sort((a, b) => b.priority - a.priority);
            const committedIndex = candidates.findIndex(candidate => committedNames.has(candidate.option.name));
            if (committedIndex > 0 && candidates[0].priority <= candidates[committedIndex].priority * 2) {
                // Refresh the in-progress request before a similar-priority new
                // investment can make it decay and trigger a cancellation.
                candidates.unshift(candidates.splice(committedIndex, 1)[0]);
            }
            for (const candidate of candidates) {
                const location = this.getBestLocationForStructure(game, playerData, candidate.option, context.difficulty, context, candidate.refineryPlan);
                if (location) {
                    return buildStructureAtLocation(candidate.option.name, candidate.priority, location.rx, location.ry);
                }
            }
            return noop();
        }

        const bestOption = maxBy(optionWithPriority, (option) => option.priority);

        if (!bestOption || bestOption.priority === 0) {
            return noop();
        }

        const bestLocation = this.getBestLocationForStructure(game, playerData, bestOption.option);

        if (!bestLocation) {
            return noop();
        }

        return buildStructureAtLocation(bestOption.option.name, bestOption.priority, bestLocation.rx, bestLocation.ry);
    }

    getGlobalDebugText(): string | undefined {
        return undefined;
    }

    /** Read-only state consumed by the benchmark's existing mission sampler. */
    getState() {
        if (!this.defenseState) return undefined;
        return { defenseTriggers: [...this.defenseState.triggered],
            defenseStarted: this.defenseState.started.map(entry => ({ ...entry })),
            defensePlaced: this.defenseState.placed.map(entry => ({ ...entry })) };
    }

    getPriority(): number {
        return 0;
    }

    private getPriorityForBuildingOption(
        option: TechnoRules,
        game: GameApi,
        playerStatus: PlayerData,
        threatCache: GlobalThreat | null,
        difficulty?: "normal" | "brutal",
        committed = false,
        context?: MissionContext,
        refineryPlan?: RefineryPlan,
    ) {
        if (difficulty === "brutal") {
            const economyPriority = getEconomyBuildingPriority(game, playerStatus, option, committed, context, refineryPlan);
            if (economyPriority !== undefined) return economyPriority;
            const priority = getStrategicBuildingPriority(game, playerStatus, option, threatCache, committed);
            if (priority !== undefined) return priority;
        }
        if (BUILDING_NAME_TO_RULES.has(option.name)) {
            let logic = BUILDING_NAME_TO_RULES.get(option.name)!;
            return logic.getPriority(game, playerStatus, option, threatCache);
        } else {
            // Fallback priority when there are no rules.
            return (
                DEFAULT_BUILDING_PRIORITY - game.getVisibleUnits(playerStatus.name, "self", (r) => r == option).length
            );
        }
    }

    private getBestLocationForStructure(
        game: GameApi,
        playerData: PlayerData,
        objectReady: TechnoRules,
        difficulty?: "normal" | "brutal",
        context?: MissionContext,
        refineryPlan?: RefineryPlan,
    ): { rx: number; ry: number } | undefined {
        if (difficulty === "brutal" && objectReady.refinery && context) {
            const committed = getCommittedRefineryLocation(context, objectReady.name);
            if (committed) return committed;
            const plan = refineryPlan ?? planRefinery(game, playerData, objectReady);
            const minerRefinery = planMinerRefinery(context, playerData, objectReady, plan);
            if (minerRefinery) {
                noteMinerRefineryRequest(game, playerData.name, objectReady.name, minerRefinery);
                return minerRefinery.location;
            }
            if (plan.reachable) return plan.location;
            if (game.getVisibleUnits(playerData.name, "self", rules => rules.refinery).length > 0) return undefined;
            // The first-refinery fallback below is the historical nearest-visible-ore placement.
            difficulty = "normal";
        }
        if (difficulty === "brutal" && context && ["GAWEAP", "NAWEAP"].includes(objectReady.name) && !isPressured(context)) {
            const location = getEconomicFirstFactoryPlacement(game, playerData, objectReady);
            if (location) return location;
        }
        if (difficulty === "brutal" && objectReady.name === "GTGCAN") {
            return getGrandCannonPlacement(game, playerData, objectReady);
        }
        if (BUILDING_NAME_TO_RULES.has(objectReady.name)) {
            let logic = BUILDING_NAME_TO_RULES.get(objectReady.name)!;
            const location = logic.getPlacementLocation(game, playerData, objectReady, difficulty);
            return location ?? (difficulty === "brutal" ? getCompactFirstFactoryPlacement(game, playerData, objectReady) : undefined);
        } else {
            // fallback placement logic
            return getDefaultPlacementLocation(game, playerData, playerData.startLocation, objectReady);
        }
    }

    private handleBuildingReady(context: MissionContext, objectReady: TechnoRules) {
        const { game, player } = context;
        const { actions: actionsApi } = player;
        const playerData = game.getPlayerData(player.name);
        let location: { rx: number; ry: number } | undefined = this.getBestLocationForStructure(
            game,
            playerData,
            objectReady,
        );
        if (location !== undefined) {
            this.logger(
                `Completed (${queueTypeToName(this.queueType)}): ${objectReady.name}, placing at ${location.rx},${
                    location.ry
                }`,
            );
            actionsApi.placeBuilding(objectReady.name, location.rx, location.ry);
        } else {
            this.logger(`Completed (${queueTypeToName(this.queueType)}): ${objectReady.name} but nowhere to place it`);
        }
    }
}

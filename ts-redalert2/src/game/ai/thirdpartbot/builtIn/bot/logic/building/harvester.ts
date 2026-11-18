import { sp } from "../../strategy/params";
import { GameApi, PlayerData, TechnoRules } from "../../../game-api";
import { GlobalThreat } from "../threat/threat";
import { BasicGroundUnit } from "./basicGroundUnit";

const IDEAL_HARVESTERS_PER_REFINERY = 2;

// because refineries also scales based on harvesters, we need a cap
const MAX_HARVESTERS_TOTAL = 10;

export class Harvester extends BasicGroundUnit {
    constructor(
        basePriority: number,
        baseAmount: number,
        private minNeeded: number,
    ) {
        super(basePriority, baseAmount, 0, 0);
    }

    // Priority goes up when we have fewer than this many refineries.
    getPriority(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
        difficulty?: "normal" | "brutal",
    ): number {
        const refineries = game.getVisibleUnits(playerData.name, "self", (r) => r.refinery).length;
        const harvesters = game.getVisibleUnits(playerData.name, "self", (r) => r.harvester).length;

        const desired = Math.min((difficulty === "brutal" ? sp(game, playerData.name, 'economy.maxHarvestersCap') : MAX_HARVESTERS_TOTAL), refineries * (difficulty === "brutal" ? sp(game, playerData.name, 'economy.harvestersPerRefinery') : IDEAL_HARVESTERS_PER_REFINERY));
        if (refineries === 0 || harvesters >= desired) return 0;

        // Rebuild the income source before funding ordinary combat requests.
        if (harvesters === 0) return this.basePriority * (difficulty === "brutal" ? sp(game, playerData.name, 'economy.emptyHarvesterPriorityFactor') : 6);
        if (harvesters < this.minNeeded) return this.basePriority * (difficulty === "brutal" ? sp(game, playerData.name, 'economy.lowHarvesterPriorityFactor') : 4);
        return this.basePriority * (1 + (desired - harvesters) / desired);
    }

    getMaxCount(game: GameApi, playerData: PlayerData, technoRules: TechnoRules, threatCache: GlobalThreat | null): number | null {
        return MAX_HARVESTERS_TOTAL;
    }
}

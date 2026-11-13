import { GameApi, PlayerData, TechnoRules } from "../../../game-api";
import { GlobalThreat } from "../threat/threat";
import { BasicGroundUnit } from "./basicGroundUnit";
import { findVisiblePatches, isServed, OrePatch, PatchPoint } from "../common/orePatches";

const IDEAL_HARVESTERS_PER_REFINERY = 2;

// because refineries also scales based on harvesters, we need a cap
const MAX_HARVESTERS_TOTAL = 12;

export function patchCapacity(patch: Pick<OrePatch, "value">, chrono: boolean): number {
    return patch.value >= 6000 ? (chrono ? 5 : 4) : patch.value >= 3000 ? 2 : 1;
}

export function desiredMiners(game: GameApi, playerData: PlayerData, futureRefinery?: PatchPoint): number {
    const refineries = game.getVisibleUnits(playerData.name, "self", rules => rules.refinery)
        .map(id => game.getGameObjectData(id)?.tile).filter((tile): tile is PatchPoint => !!tile);
    if (!refineries.length) return 0;
    if (futureRefinery) refineries.push(futureRefinery);
    const chrono = game.getVisibleUnits(playerData.name, "self", rules => rules.name === "CMIN").length > 0 ||
        ["Americans", "Alliance", "French", "Germans", "British"].includes(playerData.country?.name);
    const capacity = findVisiblePatches(game, playerData.name).filter(patch => isServed(patch, refineries))
        .reduce((sum, patch) => sum + patchCapacity(patch, chrono), 0);
    return Math.min(MAX_HARVESTERS_TOTAL, Math.max(2, capacity));
}

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

        const desired = difficulty === "brutal" ? desiredMiners(game, playerData) : Math.min(10, refineries * IDEAL_HARVESTERS_PER_REFINERY);
        if (refineries === 0 || harvesters >= desired) return 0;

        // Rebuild the income source before funding ordinary combat requests.
        if (harvesters === 0) return this.basePriority * 6;
        if (harvesters < this.minNeeded) return this.basePriority * 4;
        return this.basePriority * (1 + (desired - harvesters) / desired);
    }

    getMaxCount(game: GameApi, playerData: PlayerData, technoRules: TechnoRules, threatCache: GlobalThreat | null, difficulty?: "normal" | "brutal"): number | null {
        return difficulty === "brutal" ? MAX_HARVESTERS_TOTAL : 10;
    }
}

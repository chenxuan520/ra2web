import { GameApi, PlayerData, TechnoRules, UnitData } from "../../../game-api";
import { GlobalThreat } from "../threat/threat";
import { BasicGroundUnit } from "./basicGroundUnit";
import { findVisiblePatches, isServed, minersOn, OrePatch, patchDistance, PatchPoint, scorePatch } from "../common/orePatches";

const IDEAL_HARVESTERS_PER_REFINERY = 2;

// because refineries also scales based on harvesters, we need a cap
const MAX_HARVESTERS_TOTAL = 12;
const workedFieldTiles = new WeakMap<GameApi, Map<string, Map<string, number>>>();
const WORKED_FIELD_WINDOW = 1800;

export function patchCapacity(patch: Pick<OrePatch, "value">, chrono: boolean): number {
    return patch.value >= 12000 ? (chrono ? 6 : 5) : patch.value >= 6000 ? (chrono ? 5 : 4) : patch.value >= 3000 ? 2 : 1;
}

export function desiredMiners(game: GameApi, playerData: PlayerData, futureRefinery?: PatchPoint): number {
    const refineries = game.getVisibleUnits(playerData.name, "self", rules => rules.refinery)
        .map(id => game.getGameObjectData(id)?.tile).filter((tile): tile is PatchPoint => !!tile);
    if (!refineries.length) return 0;
    if (futureRefinery) refineries.push(futureRefinery);
    const chrono = game.getVisibleUnits(playerData.name, "self", rules => rules.name === "CMIN").length > 0 ||
        ["Americans", "Alliance", "French", "Germans", "British"].includes(playerData.country?.name);
    const patches = findVisiblePatches(game, playerData.name), tick = game.getCurrentTick();
    const loadedMiners = game.getVisibleUnits(playerData.name, "self", rules => rules.harvester)
        .map(id => game.getUnitData(id)).filter((miner): miner is UnitData => !!miner &&
            ((miner.harvestedOre ?? 0) > 0 || (miner.harvestedGems ?? 0) > 0)).map(miner => miner.tile);
    let players = workedFieldTiles.get(game);
    if (!players) { players = new Map(); workedFieldTiles.set(game, players); }
    const worked = players.get(playerData.name) ?? new Map<string, number>();
    players.set(playerData.name, worked);
    const key = (tile: PatchPoint) => `${tile.rx}_${tile.ry}`;
    for (const [tile, lastWork] of worked) if (tick < lastWork || tick - lastWork >= WORKED_FIELD_WINDOW) worked.delete(tile);
    for (const patch of patches) if (minersOn(patch, loadedMiners, patches) > 0) {
        for (const tile of patch.tiles) worked.set(key(tile), tick);
    }
    // A real haul route remains usable during unloading; this does not claim refinery service.
    const capacity = patches.filter(patch => isServed(patch, refineries) ||
        patch.tiles.some(tile => worked.has(key(tile))) && refineries.some(ref => patchDistance(ref, patch) <= 40) &&
        !!scorePatch(game, playerData, patch)).reduce((sum, patch) => sum + patchCapacity(patch, chrono), 0);
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

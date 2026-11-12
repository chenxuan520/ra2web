import { BuildStatus } from "@/game/gameobject/Building";
import { GameApi, ObjectType, PlayerData, QueueStatus, QueueType, TechnoRules, UnitData, Vector2 } from "../../../game-api";
import { SupabotContext } from "../common/context";
import { findVisiblePatches, isServed, minersOn, OrePatch, patchDistance, PatchPoint } from "../common/orePatches";
import { isPressured } from "../common/pressure";
import { minBy } from "../common/utils";
import { getDefaultPlacementLocation } from "./buildingRules";
import { desiredMiners, patchCapacity } from "./harvester";
import type { RefineryPlan } from "./resourceCollectionBuilding";

export interface MinerRefineryPlan { patch: OrePatch; location: PatchPoint }
interface RefineryOrder { name: string; location: PatchPoint; minerRefinery: boolean }
interface RefineryEconomyState {
    tick: number;
    lastMinerRefineryStart: number;
    lastSaleStart: number;
    refineries: Map<number, { placedTick: number; readyTick?: number }>;
    proposal?: MinerRefineryPlan & { name: string; tick: number };
    ordered?: RefineryOrder;
    active?: RefineryOrder;
    pendingSale?: { id: number; tick: number };
}
const states = new WeakMap<GameApi, Map<string, RefineryEconomyState>>();

export function getRefineryEconomyState(game: GameApi, playerName: string): Readonly<RefineryEconomyState> {
    return stateFor(game, playerName);
}

function stateFor(game: GameApi, playerName: string): RefineryEconomyState {
    let players = states.get(game);
    if (!players) { players = new Map(); states.set(game, players); }
    let state = players.get(playerName);
    if (!state || game.getCurrentTick() < state.tick) {
        state = { tick: -Infinity, lastMinerRefineryStart: -Infinity, lastSaleStart: -Infinity, refineries: new Map() };
        players.set(playerName, state);
    }
    return state;
}

/** SellTrait uses Soylent first; otherwise AI refunds purchase value in full, humans use RefundPercent. */
export function getRefineryEconomics(game: GameApi, player: PlayerData, rules: TechnoRules) {
    const miner = game.rulesApi?.vehicleRules?.get(rules.freeUnit);
    const refineryCost = rules.cost, minerCost = miner?.harvester ? miner.cost : undefined;
    const configured = game.getGeneralRules?.().refundPercent;
    const refundPercent = player.isAi ? 1 : Number.isFinite(configured) ? configured : 0.5;
    const refund = rules.soylent > 0 ? rules.soylent : Math.floor(refineryCost * refundPercent);
    return { refineryCost, minerCost, refundPercent, refund,
        worthwhile: minerCost !== undefined && refineryCost - refund < minerCost };
}

export function planMinerRefinery(context: SupabotContext, player: PlayerData, rules: TechnoRules, plan: RefineryPlan): MinerRefineryPlan | undefined {
    const { game } = context;
    const miners = game.getVisibleUnits(player.name, "self", option => option.harvester)
        .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
    const refineries = game.getVisibleUnits(player.name, "self", option => option.refinery)
        .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
    if (context.difficulty !== "brutal" || plan.reachable || miners.length >= desiredMiners(game, player) || isPressured(context) ||
        context.player.production.getQueueData(QueueType.Structures).items.length > 0 ||
        (context.player.production.getQueueData(QueueType.Vehicles).items.length === 0 &&
            game.getVisibleUnits(player.name, "self", option => option.weaponsFactory).length > 0) ||
        !getRefineryEconomics(game, player, rules).worthwhile ||
        game.getCurrentTick() - stateFor(game, player.name).lastMinerRefineryStart < 900) return undefined;
    const patches = findVisiblePatches(game, player.name);
    const chrono = rules.freeUnit === "CMIN";
    const served = patches.filter(patch => isServed(patch, refineries.map(unit => unit.tile)))
        .sort((a, b) => (patchCapacity(b, chrono) - minersOn(b, miners.map(unit => unit.tile), patches)) -
            (patchCapacity(a, chrono) - minersOn(a, miners.map(unit => unit.tile), patches)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const patch = served[0];
    if (!patch) return undefined;
    const buildings = game.getVisibleUnits(player.name, "self", option => option.type === ObjectType.Building && !option.wall)
        .map(id => game.getGameObjectData(id)?.tile).filter((tile): tile is PatchPoint => !!tile);
    const building = minBy(buildings, tile => patchDistance(tile, patch));
    const target = building && minBy(patch.tiles, tile => Math.hypot(tile.rx - building.rx, tile.ry - building.ry));
    const location = target && (getDefaultPlacementLocation(game, player, new Vector2(target.rx, target.ry), rules, false, 2)
        ?? getDefaultPlacementLocation(game, player, new Vector2(target.rx, target.ry), rules, false, 1)
        ?? getDefaultPlacementLocation(game, player, new Vector2(target.rx, target.ry), rules, false, 0));
    return location && patchDistance(location, patch) <= 9 ? { patch, location } : undefined;
}

/** A proposal is not a successful start. QueueController records the selected paid order separately. */
export function noteMinerRefineryRequest(game: GameApi, playerName: string, name: string, plan: MinerRefineryPlan): void {
    stateFor(game, playerName).proposal = { ...plan, name, tick: game.getCurrentTick() };
}

export function recordRefineryOrder(game: GameApi, playerName: string, name: string, location: Vector2 | null | undefined): void {
    if (!["GAREFN", "NAREFN"].includes(name) || !location) return;
    const state = stateFor(game, playerName), proposal = state.proposal;
    state.ordered = { name, location: { rx: location.x, ry: location.y }, minerRefinery: !!proposal &&
        proposal.name === name && proposal.tick === game.getCurrentTick() && proposal.location.rx === location.x && proposal.location.ry === location.y };
}

export function isMinerRefineryProduction(game: GameApi, playerName: string, name: string): boolean {
    const active = stateFor(game, playerName).active;
    return active?.name === name && active.minerRefinery;
}

export function getCommittedRefineryLocation(context: SupabotContext, name: string): PatchPoint | undefined {
    const state = stateFor(context.game, context.player.name);
    return context.player.production.getQueueData(QueueType.Structures).items[0]?.rules.name === name && state.active?.name === name
        ? state.active.location : undefined;
}

/** Counts only real non-idle queue starts, real object placement IDs and the public Ready state. */
export function observeRefineryEconomy(context: SupabotContext): void {
    if (context.difficulty !== "brutal") return;
    const { game, player } = context, tick = game.getCurrentTick(), state = stateFor(game, player.name);
    if (state.tick === tick) return;
    const queue = player.production.getQueueData(QueueType.Structures);
    if (state.ordered && queue.status !== QueueStatus.Idle && queue.items[0]?.rules.name === state.ordered.name) {
        state.active = state.ordered;
        if (state.ordered.minerRefinery) state.lastMinerRefineryStart = tick;
        state.ordered = undefined;
        state.proposal = undefined;
    }
    if (!queue.items.length || queue.items[0].rules.name !== state.active?.name) state.active = undefined;
    const ids = game.getVisibleUnits(player.name, "self", rules => rules.refinery);
    for (const id of ids) {
        const unit = game.getUnitData(id);
        if (!unit) continue;
        let entry = state.refineries.get(id);
        if (!entry) { entry = { placedTick: tick }; state.refineries.set(id, entry); }
        if (Number(unit.buildStatus) === BuildStatus.Ready && entry.readyTick === undefined) entry.readyTick = tick;
    }
    for (const id of state.refineries.keys()) if (!ids.includes(id)) state.refineries.delete(id);
    if (state.pendingSale) {
        const sold = game.getUnitData(state.pendingSale.id);
        if (sold && Number(sold.buildStatus) === BuildStatus.BuildDown) state.lastSaleStart = tick;
        if (!sold || Number(sold.buildStatus) === BuildStatus.BuildDown || tick - state.pendingSale.tick >= 30) state.pendingSale = undefined;
    }
    state.tick = tick;
}

export function sellDuplicateRefinery(context: SupabotContext): void {
    if (context.difficulty !== "brutal") return;
    observeRefineryEconomy(context);
    const { game, player } = context, tick = game.getCurrentTick(), state = stateFor(game, player.name);
    if (tick % 30 || state.pendingSale || tick - state.lastSaleStart < 300) return;
    const refineries = game.getVisibleUnits(player.name, "self", rules => rules.refinery)
        .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
    const patches = findVisiblePatches(game, player.name);
    const servedCount = patches.filter(patch => isServed(patch, refineries.map(unit => unit.tile))).length;
    if (refineries.length - 1 < Math.max(1, servedCount)) return;
    const miners = game.getVisibleUnits(player.name, "self", rules => rules.harvester)
        .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
    for (const patch of patches) {
        // Nearest-field assignment prevents selling refineries that belong to different fields with overlapping radii.
        const sameField = refineries.filter(refinery => {
            const nearest = [...patches].sort((a, b) => patchDistance(refinery.tile, a) - patchDistance(refinery.tile, b) || (a.id < b.id ? -1 : 1))[0];
            return nearest?.id === patch.id && patchDistance(refinery.tile, patch) <= 9;
        }).sort((a, b) => ((state.refineries.get(a.id)?.readyTick ?? Infinity) - (state.refineries.get(b.id)?.readyTick ?? Infinity)) || a.id - b.id);
        if (sameField.length < 2) continue;
        const oldest = sameField[0], newest = sameField[sameField.length - 1];
        const readyAt = state.refineries.get(newest.id)?.readyTick;
        if (readyAt === undefined || tick - readyAt <= 150 || Number(oldest.buildStatus) !== BuildStatus.Ready || oldest.isWarpedOut || oldest.rules.unsellable ||
            miners.some(miner => Math.hypot(miner.tile.rx - oldest.tile.rx, miner.tile.ry - oldest.tile.ry) <= 3)) continue;
        player.actions.sellBuilding(oldest.id);
        state.pendingSale = { id: oldest.id, tick };
        return;
    }
}

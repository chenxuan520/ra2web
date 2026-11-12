import { BuildStatus } from "@/game/gameobject/Building";
import { GameApi, ObjectType, QueueStatus, QueueType, TechnoRules, Vector2 } from "../../../game-api";
import { SupabotContext } from "../common/context";
import { OrePatch, patchDistance, PatchPoint } from "../common/orePatches";
import { getEconomyPressureLimits, isEcoOnly, isPressured } from "../common/pressure";
import { isSovietCountry } from "../../strategy/basicInfantryBudget";
import { getAdjacencyTiles, planRefinery } from "./buildingRules";

export interface CrawlPlan {
    patch: OrePatch;
    rules: TechnoRules;
    queue: QueueType;
    location: PatchPoint;
    priority: number;
}
interface CrawlTarget { builtIds: Set<number>; defenseIds: Set<number>; blockedUntil: number }
interface CrawlBuild extends CrawlPlan { knownIds: Set<number>; placedId?: number }
interface CrawlState {
    tick: number;
    targets: Map<string, CrawlTarget>;
    defenseIds: Set<number>;
    proposal?: CrawlPlan;
    proposalTick?: number;
    ordered?: CrawlBuild;
    active?: CrawlBuild;
}
const states = new WeakMap<GameApi, Map<string, CrawlState>>();

function stateFor(game: GameApi, playerName: string): CrawlState {
    let players = states.get(game);
    if (!players) { players = new Map(); states.set(game, players); }
    let state = players.get(playerName);
    if (!state || game.getCurrentTick() < state.tick) {
        state = { tick: -Infinity, targets: new Map(), defenseIds: new Set() };
        players.set(playerName, state);
    }
    return state;
}

function targetFor(state: CrawlState, id: string): CrawlTarget {
    let target = state.targets.get(id);
    if (!target) { target = { builtIds: new Set(), defenseIds: new Set(), blockedUntil: -Infinity }; state.targets.set(id, target); }
    return target;
}

export function getBaseCrawlState(game: GameApi, playerName: string): Readonly<CrawlState> {
    return stateFor(game, playerName);
}

/** T3 can exclude only these actual placed own tower IDs from its ordinary defense cap. */
export function isCrawlDefense(game: GameApi, playerName: string, id: number): boolean {
    return stateFor(game, playerName).defenseIds.has(id);
}

export function isCrawlBlocked(game: GameApi, playerName: string, patch: OrePatch): boolean {
    return game.getCurrentTick() < (stateFor(game, playerName).targets.get(patch.id)?.blockedUntil ?? -Infinity);
}

export function isCrawlProduction(game: GameApi, playerName: string, queue: QueueType): boolean {
    return stateFor(game, playerName).active?.queue === queue;
}

export function planBaseCrawl(context: SupabotContext): CrawlPlan | undefined {
    if (context.difficulty !== "brutal" || isPressured(context)) return undefined;
    const { game, player } = context, state = stateFor(game, player.name);
    if (state.active) {
        return player.production.getQueueData(state.active.queue).items[0]?.rules.name === state.active.rules.name ? state.active : undefined;
    }
    const data = game.getPlayerData(player.name);
    const miners = game.getVisibleUnits(player.name, "self", rules => rules.harvester).length;
    if (game.getVisibleUnits(player.name, "self", rules => rules.weaponsFactory).length === 0 ||
        miners < getEconomyPressureLimits(context, miners).crawlMiners ||
        player.production.getQueueData(QueueType.Structures).items.length > 0 || data.credits < 800) return undefined;
    const refinery = player.production.getAvailableObjects(QueueType.Structures).find(rules => rules.refinery);
    if (!refinery) return undefined;
    const plan = planRefinery(game, data, refinery);
    if (plan.reachable) return undefined;
    const tick = game.getCurrentTick();
    const entry = plan.unreachable.find(entry => {
        if (entry.g > 40 || isCrawlBlocked(game, player.name, entry.patch)) return false;
        const target = targetFor(state, entry.patch.id);
        if (target.builtIds.size >= 5) { target.blockedUntil = tick + 5400; return false; }
        return true;
    });
    if (!entry) return undefined;
    const target = targetFor(state, entry.patch.id);
    const powerMargin = data.power.total - data.power.drain;
    const soviet = isSovietCountry(data.country?.name);
    const usePower = powerMargin < 150 || target.defenseIds.size >= 2 || isEcoOnly(context);
    const queue = usePower ? QueueType.Structures : QueueType.Armory;
    if (player.production.getQueueData(queue).items.length) return undefined;
    const name = usePower ? (soviet ? "NAPOWR" : "GAPOWR") : (soviet ? "NALASR" : "GAPILL");
    const rules = player.production.getAvailableObjects(queue).find(rules => rules.name === name);
    if (!rules) return undefined;
    const location = getAdjacencyTiles(game, data, rules, false, 0)
        .filter(tile => game.canPlaceBuilding(player.name, name, tile))
        .sort((a, b) => patchDistance(a, entry.patch) - patchDistance(b, entry.patch) || a.rx - b.rx || a.ry - b.ry)[0];
    if (!location || patchDistance(location, entry.patch) > entry.g - 2) {
        target.blockedUntil = tick + 2700;
        return undefined;
    }
    const proposal = { patch: entry.patch, rules, queue, location, priority: 45 };
    state.proposal = proposal;
    state.proposalTick = tick;
    return proposal;
}

/** A selected paid queue order still does not count as a placed/completed crawl building. */
export function recordBaseCrawlOrder(game: GameApi, playerName: string, name: string, location: Vector2 | null | undefined): void {
    const state = stateFor(game, playerName), proposal = state.proposal;
    if (!proposal || state.proposalTick !== game.getCurrentTick() || proposal.rules.name !== name ||
        location?.x !== proposal.location.rx || location?.y !== proposal.location.ry) return;
    state.ordered = { ...proposal, knownIds: new Set(game.getVisibleUnits(playerName, "self", rules => rules.type === ObjectType.Building)) };
}

export function observeBaseCrawl(context: SupabotContext): void {
    if (context.difficulty !== "brutal") return;
    const { game, player } = context, state = stateFor(game, player.name), tick = game.getCurrentTick();
    if (state.tick === tick) return;
    if (state.ordered) {
        const queue = player.production.getQueueData(state.ordered.queue);
        if (queue.status !== QueueStatus.Idle && queue.items[0]?.rules.name === state.ordered.rules.name) {
            state.active = state.ordered;
            state.ordered = undefined;
        }
    }
    const build = state.active;
    if (build) {
        const unit = game.getVisibleUnits(player.name, "self", rules => rules.name === build.rules.name)
            .filter(id => !build.knownIds.has(id)).map(id => game.getUnitData(id))
            .find(unit => unit && unit.tile.rx === build.location.rx && unit.tile.ry === build.location.ry);
        if (unit) {
            build.placedId = unit.id;
            if (["GAPILL", "NALASR"].includes(build.rules.name)) state.defenseIds.add(unit.id);
            if (Number(unit.buildStatus) === BuildStatus.Ready) {
                const target = targetFor(state, build.patch.id);
                target.builtIds.add(unit.id);
                if (state.defenseIds.has(unit.id)) target.defenseIds.add(unit.id);
                state.active = undefined;
            }
        } else if (!player.production.getQueueData(build.queue).items.length) state.active = undefined;
    }
    state.tick = tick;
}

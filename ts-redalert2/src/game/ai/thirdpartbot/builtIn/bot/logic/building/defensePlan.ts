import { BuildStatus } from "@/game/gameobject/Building";
import { ApiEvent, ApiEventType, GameApi, ObjectType, PlayerData, QueueStatus, QueueType, TechnoRules, UnitData, Vector2 } from "../../../game-api";
import { BRUTAL_PARAMS } from "../../strategy/brutalParams";
import { isSovietCountry } from "../../strategy/basicInfantryBudget";
import { SupabotContext } from "../common/context";
import { findVisiblePatches, OrePatch, patchDistance, PatchPoint } from "../common/orePatches";
import { isEcoOnly, readPressure } from "../common/pressure";
import { getAdjacencyTiles } from "./buildingRules";
import { isCrawlDefense } from "./baseCrawl";

const BASIC = new Set(["GAPILL", "NALASR"]);
const AIR_DEFENSE = new Set(["NASAM", "NAFLAK"]);
const distance = (a: PatchPoint, b: PatchPoint) => Math.hypot(a.rx - b.rx, a.ry - b.ry);
const towards = (from: PatchPoint, to: PatchPoint, amount: number): PatchPoint => {
    const length = distance(from, to);
    return length > 0 ? { rx: from.rx + (to.rx - from.rx) * amount / length, ry: from.ry + (to.ry - from.ry) * amount / length }
        : { rx: from.rx + amount, ry: from.ry };
};

export interface DefensePlan {
    rules: TechnoRules;
    location: PatchPoint;
    desired: PatchPoint;
    priority: number;
    signal: "D0" | "D1" | "D2" | "D3" | "D4" | "D5";
    refineryId?: number;
}
interface DefenseBuild extends DefensePlan { knownIds: Set<number>; placedId?: number }
interface DefenseState {
    tick: number;
    nextHpCheck: number;
    seenEnemyDrone: boolean;
    seenAirForce: boolean;
    hp: Map<number, { hitPoints: number; point: PatchPoint; miner: boolean }>;
    harassment: { point: PatchPoint; tick: number; minerLoss: boolean }[];
    lastStartTick: number;
    d3Ids: Set<number>;
    refineryIds: Map<number, number>;
    triggered: Set<DefensePlan["signal"]>;
    started: { tick: number; signal: DefensePlan["signal"] }[];
    placed: { tick: number; signal: DefensePlan["signal"]; id: number }[];
    proposal?: DefensePlan;
    proposalTick?: number;
    ordered?: DefenseBuild;
    active?: DefenseBuild;
}
const states = new WeakMap<GameApi, Map<string, DefenseState>>();

export function getDefenseState(game: GameApi, playerName: string): Readonly<DefenseState> {
    return stateFor(game, playerName);
}
function stateFor(game: GameApi, playerName: string): DefenseState {
    let players = states.get(game);
    if (!players) { players = new Map(); states.set(game, players); }
    let state = players.get(playerName);
    if (!state || game.getCurrentTick() < state.tick) {
        state = { tick: -Infinity, nextHpCheck: 0, seenEnemyDrone: false, seenAirForce: false, hp: new Map(), harassment: [],
            lastStartTick: -Infinity, d3Ids: new Set(), refineryIds: new Map(), triggered: new Set(), started: [], placed: [] };
        players.set(playerName, state);
    }
    return state;
}

export function hasSeenEnemyDrone(game: GameApi, playerName: string): boolean {
    return stateFor(game, playerName).seenEnemyDrone;
}

export function canRequestDefense(game: GameApi, player: PlayerData, name: string, committed = false): boolean {
    if (player.credits < 600) return false;
    const basic = BASIC.has(name);
    const count = game.getVisibleUnits(player.name, "self", rules => basic ? BASIC.has(rules.name) : AIR_DEFENSE.has(rules.name))
        .filter(id => !basic || !isCrawlDefense(game, player.name, id)).length;
    if (count >= (basic ? BRUTAL_PARAMS.economy.defenseMaxCount : 2)) return false;
    return committed || game.getCurrentTick() - stateFor(game, player.name).lastStartTick >= BRUTAL_PARAMS.economy.defenseCooldownTicks;
}

/** Only a known own miner's real loss is a D2 signal; voluntary off-world removal is not. */
export function observeDefenseEvent(game: GameApi, playerName: string, event: ApiEvent): void {
    const state = stateFor(game, playerName), id = Number(event.target), previous = state.hp.get(id);
    if (event.type === ApiEventType.ObjectSpawn) {
        const unit = game.getGameObjectData(id);
        if (unit?.owner === playerName && unit.rules.harvester && Number.isFinite(unit.hitPoints)) {
            state.hp.set(id, { hitPoints: unit.hitPoints!, point: { rx: unit.tile.rx, ry: unit.tile.ry }, miner: true });
        }
        return;
    }
    if ((event.type === ApiEventType.ObjectDestroy || event.type === ApiEventType.ObjectOwnerChange && event.newOwnerName !== playerName) && previous?.miner) {
        state.harassment.push({ point: { ...previous.point }, tick: game.getCurrentTick(), minerLoss: true });
    }
    if (event.type === ApiEventType.ObjectDestroy || event.type === ApiEventType.ObjectUnspawn || event.type === ApiEventType.ObjectOwnerChange && event.newOwnerName !== playerName) state.hp.delete(id);
}

/** Observe existing visible appearances, own HP, and paid construction; never infer a successful build from a request. */
export function observeDefense(context: SupabotContext): void {
    if (context.difficulty !== "brutal" || isEcoOnly(context)) return;
    const { game, player } = context, state = stateFor(game, player.name), tick = game.getCurrentTick();
    if (state.tick === tick) return;
    const enemies = game.getVisibleUnits(player.name, "enemy", rules => ["DRON", "GAAIRC", "AMRADR", "ZEP"].includes(rules.name))
        .map(id => game.getGameObjectData(id)).filter(unit => !!unit);
    state.seenEnemyDrone ||= enemies.some(unit => unit!.rules.name === "DRON");
    state.seenAirForce ||= enemies.some(unit => ["GAAIRC", "AMRADR", "ZEP"].includes(unit!.rules.name));
    state.harassment = state.harassment.filter(event => tick - event.tick < 1800);
    if (tick >= state.nextHpCheck) {
        state.nextHpCheck = tick + 30;
        const units = game.getVisibleUnits(player.name, "self", rules => rules.harvester || rules.refinery)
            .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
        const owned = new Set(units.map(unit => unit.id));
        for (const id of state.hp.keys()) if (!owned.has(id)) state.hp.delete(id);
        for (const unit of units) {
            if (!Number.isFinite(unit.hitPoints)) continue;
            const previous = state.hp.get(unit.id), point = { rx: unit.tile.rx, ry: unit.tile.ry };
            if (previous && unit.hitPoints < previous.hitPoints) state.harassment.push({ point, tick, minerLoss: false });
            state.hp.set(unit.id, { hitPoints: unit.hitPoints, point, miner: !!unit.rules.harvester });
        }
    }
    const queue = player.production.getQueueData(QueueType.Armory);
    if (state.ordered && queue.status !== QueueStatus.Idle && queue.items[0]?.rules.name === state.ordered.rules.name) {
        state.active = state.ordered; state.ordered = undefined; state.lastStartTick = tick;
        state.started.push({ tick, signal: state.active.signal });
    }
    const build = state.active;
    if (build) {
        const unit = game.getVisibleUnits(player.name, "self", rules => rules.name === build.rules.name)
            .filter(id => !build.knownIds.has(id)).map(id => game.getUnitData(id))
            .find(unit => unit && unit.tile.rx === build.location.rx && unit.tile.ry === build.location.ry);
        if (unit && build.placedId === undefined) {
            build.placedId = unit.id;
            if (build.signal === "D3") state.d3Ids.add(unit.id);
            if (build.refineryId !== undefined) state.refineryIds.set(build.refineryId, unit.id);
            state.placed.push({ tick, signal: build.signal, id: unit.id });
        }
        if (unit && Number(unit.buildStatus) === BuildStatus.Ready || !unit && !queue.items.length) state.active = undefined;
    }
    state.tick = tick;
}

export function recordDefenseOrder(game: GameApi, playerName: string, name: string, location: Vector2 | null | undefined): void {
    const state = stateFor(game, playerName), plan = state.proposal;
    if (!plan || state.proposalTick !== game.getCurrentTick() || plan.rules.name !== name || location?.x !== plan.location.rx || location?.y !== plan.location.ry) return;
    state.ordered = { ...plan, knownIds: new Set(game.getVisibleUnits(playerName, "self", rules => BASIC.has(rules.name) || AIR_DEFENSE.has(rules.name))) };
}
export function isDefenseProduction(game: GameApi, playerName: string): boolean {
    return !!stateFor(game, playerName).active;
}

/** The existing base-building mission supplies D0 unchanged; the queue checks it before all new signals. */
export function planDefense(context: SupabotContext, emergency?: { priority: number; specificLocation: Vector2 | null }): DefensePlan | undefined {
    if (context.difficulty !== "brutal" || isEcoOnly(context)) return undefined;
    const { game, player } = context, state = stateFor(game, player.name);
    const options = player.production.getAvailableObjects(QueueType.Armory);
    if (!options.length && !state.active) return undefined;
    observeDefense(context);
    const data = game.getPlayerData(player.name);
    if (state.active && player.production.getQueueData(QueueType.Armory).items[0]?.rules.name === state.active.rules.name) {
        const build = state.active;
        if (player.production.getQueueData(QueueType.Armory).status === QueueStatus.Ready &&
            !game.canPlaceBuilding(player.name, build.rules.name, build.location)) {
            // Recover the paid signal's original area, not an unrelated new emergency or home fallback.
            const location = getAdjacencyTiles(game, data, build.rules, false, 0)
                .filter(tile => game.mapApi.isVisibleTile(tile, player.name) && distance(tile, build.desired) <= 8 &&
                    game.canPlaceBuilding(player.name, build.rules.name, tile))
                .sort((a, b) => distance(a, build.desired) - distance(b, build.desired) || a.rx - b.rx || a.ry - b.ry)[0];
            if (location) build.location = { rx: location.rx, ry: location.ry };
        }
        return build;
    }
    if (player.production.getQueueData(QueueType.Armory).items.length || data.credits < 600 ||
        game.getCurrentTick() - state.lastStartTick < BRUTAL_PARAMS.economy.defenseCooldownTicks) return undefined;
    const soviet = isSovietCountry(data.country?.name), basicName = soviet ? "NALASR" : "GAPILL", airName = soviet ? "NAFLAK" : "NASAM";
    const towers = game.getVisibleUnits(player.name, "self", rules => BASIC.has(rules.name))
        .filter(id => !isCrawlDefense(game, player.name, id)).map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
    const patches = findVisiblePatches(game, player.name);
    const refineries = game.getVisibleUnits(player.name, "self", rules => rules.refinery)
        .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit && Number(unit.buildStatus) === BuildStatus.Ready && !unit.isWarpedOut)
        .sort((a, b) => a.id - b.id);
    const fields = refineries.map(refinery => ({ refinery, patch: patches.filter(patch => patchDistance(refinery.tile, patch) <= 9)
        .sort((a, b) => patchDistance(refinery.tile, a) - patchDistance(refinery.tile, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] }));
    const home = { rx: data.startLocation.x, ry: data.startLocation.y };
    const request = (signal: DefensePlan["signal"], name: string, desired: PatchPoint, priority: number, refineryId?: number, fixed = false): DefensePlan | undefined => {
        const rules = options.find(option => option.name === name);
        if (!rules || !canRequestDefense(game, data, name)) return undefined;
        const location = fixed ? (game.canPlaceBuilding(player.name, name, desired) ? desired : undefined) : getAdjacencyTiles(game, data, rules, false, 0)
            .filter(tile => game.canPlaceBuilding(player.name, name, tile))
            .sort((a, b) => distance(a, desired) - distance(b, desired) || a.rx - b.rx || a.ry - b.ry)[0];
        if (!location || distance(location, desired) > 8) return undefined;
        const plan: DefensePlan = { rules, location: { rx: location.rx, ry: location.ry }, desired: { rx: desired.rx, ry: desired.ry }, priority, signal, refineryId };
        state.proposal = plan; state.proposalTick = game.getCurrentTick(); state.triggered.add(signal);
        return plan;
    };
    const fieldRequest = (signal: "D1" | "D2" | "D5", field: { refinery: UnitData; patch: OrePatch | undefined }, priority: number) => {
        if (!field.patch) return undefined;
        const desired = towards(field.refinery.tile, field.patch.center, 3), assigned = state.refineryIds.get(field.refinery.id);
        if (towers.some(tower => tower.id === assigned || distance(tower.tile, desired) <= 8)) return undefined;
        return request(signal, basicName, desired, priority, field.refinery.id);
    };
    if (emergency?.priority === BRUTAL_PARAMS.economy.defensePriority && emergency.specificLocation) {
        return request("D0", basicName, { rx: emergency.specificLocation.x, ry: emergency.specificLocation.y }, emergency.priority, undefined, true);
    }
    if (state.seenEnemyDrone) for (const field of fields) { const plan = fieldRequest("D1", field, 75); if (plan) return plan; }
    // Mining can change a component's lexical ID. Associate remembered own event positions, not old IDs.
    const harassment = new Map<string, typeof state.harassment>();
    for (const event of state.harassment) {
        if (game.getCurrentTick() - event.tick >= 1800) continue;
        let nearest: OrePatch | undefined, nearestDistance = 12;
        for (const patch of patches) {
            const current = patchDistance(event.point, patch);
            if (current <= nearestDistance && (!nearest || current < nearestDistance || patch.id < nearest.id)) {
                nearest = patch; nearestDistance = current;
            }
        }
        if (nearest) {
            const events = harassment.get(nearest.id) ?? [];
            events.push(event); harassment.set(nearest.id, events);
        }
    }
    for (const field of fields) {
        const events = field.patch && harassment.get(field.patch.id);
        if (events && (events.some(event => event.minerLoss) ||
            events.length >= 2 && Math.max(...events.map(event => event.tick)) - Math.min(...events.map(event => event.tick)) >= 150)) {
            const plan = fieldRequest("D2", field, 72); if (plan) return plan;
        }
    }
    const pressure = readPressure(context);
    if (pressure.earlyPressure && pressure.earlyPressurePosition && towers.filter(tower => state.d3Ids.has(tower.id)).length < 2) {
        const plan = request("D3", basicName, towards(home, pressure.earlyPressurePosition, 6), 68); if (plan) return plan;
    }
    const air = game.getVisibleUnits(player.name, "enemy", rules => rules.type === ObjectType.Aircraft || rules.consideredAircraft).length;
    const aaCount = game.getVisibleUnits(player.name, "self", rules => AIR_DEFENSE.has(rules.name)).length;
    if ((air >= 2 || state.seenAirForce) && aaCount < 2) {
        const miners = game.getVisibleUnits(player.name, "self", rules => rules.harvester).map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
        const busiest = [...refineries].sort((a, b) => miners.filter(miner => distance(miner.tile, b.tile) <= 12).length -
            miners.filter(miner => distance(miner.tile, a.tile) <= 12).length || a.id - b.id)[0];
        const desired = aaCount === 0 || !busiest ? { rx: home.rx + 3, ry: home.ry } : towards(busiest.tile, home, 3);
        const plan = request("D4", airName, desired, 66); if (plan) return plan;
    }
    if (!pressure.pressured && data.credits >= 1500) for (const field of fields) {
        if (distance(field.refinery.tile, home) <= 20) continue;
        const plan = fieldRequest("D5", field, 42); if (plan) return plan;
    }
    return undefined;
}

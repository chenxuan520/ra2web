import { ApiEvent, ApiEventType, GameApi, ObjectType, TechnoRules, UnitData } from "../../../game-api";
import { BRUTAL_PARAMS } from "../../strategy/brutalParams";
import { PatchPoint } from "./orePatches";

export interface PressureContext {
    game: GameApi;
    player: { name: string };
    difficulty?: "normal" | "brutal";
}

export interface PressureState {
    pressured: boolean;
    baseUnderSiege: boolean;
    earlyPressure: boolean;
    earlyPressureUntil: number;
    earlyPressurePosition: PatchPoint | undefined;
    lastEconomicLossTick: number;
    enemyMinersSeen: number;
    lastEnemyMinerSeenTick: number;
    passiveEnemy: boolean;
}

interface StoredPressure {
    tick: number;
    baseUnderSiege: boolean;
    earlyPressureUntil: number;
    earlyPressurePosition?: PatchPoint;
    lastEconomicLossTick: number;
    lastHomeCombatTick: number;
    lastEnemyMinerSeenTick: number;
    minerPeaks: { tick: number; count: number }[];
    economicIds: Set<number>;
    watchPost?: PatchPoint;
}

const states = new WeakMap<GameApi, Map<string, StoredPressure>>();
const economicRules = (rules: TechnoRules) => rules.harvester || rules.type === ObjectType.Building;

function stateFor(game: GameApi, playerName: string): StoredPressure {
    let players = states.get(game);
    if (!players) { players = new Map(); states.set(game, players); }
    let state = players.get(playerName);
    if (!state || game.getCurrentTick() < state.tick) {
        state = { tick: -Infinity, baseUnderSiege: false, earlyPressureUntil: -Infinity,
            lastEconomicLossTick: -Infinity, lastHomeCombatTick: -Infinity, lastEnemyMinerSeenTick: -Infinity, minerPeaks: [], economicIds: new Set() };
        players.set(playerName, state);
    }
    return state;
}

export function isEcoOnly(context: PressureContext): boolean {
    return context.difficulty === "brutal" && BRUTAL_PARAMS.economy.ecoOnly === 1;
}

/** T2 supplies public P1 coordinates. No watch-post trigger exists until it does. */
export function setPressureWatchPost(game: GameApi, playerName: string, position?: PatchPoint): void {
    const state = stateFor(game, playerName);
    state.watchPost = position && { ...position };
    state.tick = -Infinity;
}

/** Only destruction/ownership loss of known own economic objects counts; sale/pack unspawn does not. */
export function observePressureEvent(game: GameApi, playerName: string, event: ApiEvent): void {
    const state = stateFor(game, playerName);
    const id = Number(event.target);
    if (event.type === ApiEventType.ObjectSpawn) {
        const object = game.getGameObjectData(id);
        if (object?.owner === playerName && economicRules(object.rules)) state.economicIds.add(id);
    } else if (event.type === ApiEventType.ObjectDestroy || event.type === ApiEventType.ObjectOwnerChange) {
        if (state.economicIds.has(id) && (event.type === ApiEventType.ObjectDestroy || event.newOwnerName !== playerName)) {
            state.lastEconomicLossTick = game.getCurrentTick();
            state.economicIds.delete(id);
        }
    } else if (event.type === ApiEventType.ObjectUnspawn) {
        state.economicIds.delete(id);
    }
}

/** Current visible combatants and actual own events, cached once per simulation tick/player/game. */
export function readPressure(context: PressureContext): PressureState {
    const { game, player } = context;
    const tick = game.getCurrentTick(), state = stateFor(game, player.name);
    if (state.tick !== tick) {
        const home = game.getPlayerData(player.name).startLocation;
        state.economicIds = new Set(game.getVisibleUnits(player.name, "self", economicRules));
        const combatants = game.getVisibleUnits(player.name, "enemy", rules => rules.isSelectableCombatant && !rules.harvester && rules.type !== ObjectType.Building)
            .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
        const homeDistance = (point: PatchPoint) => Math.hypot(point.rx - home.x, point.ry - home.y);
        state.baseUnderSiege = combatants.some(unit => homeDistance(unit.tile) <= 22);
        if (combatants.some(unit => homeDistance(unit.tile) <= 60)) state.lastHomeCombatTick = tick;
        if (tick < 5400) {
            const approaching = combatants.filter(unit => (unit.rules.type === ObjectType.Vehicle || unit.rules.type === ObjectType.Infantry) && !unit.rules.engineer && !["DOG", "ADOG", "ENGINEER", "SENGINEER"].includes(unit.rules.name) &&
                (homeDistance(unit.tile) <= 45 || state.watchPost && Math.hypot(unit.tile.rx - state.watchPost.rx, unit.tile.ry - state.watchPost.ry) <= 12));
            if (approaching.filter(unit => unit.rules.type === ObjectType.Vehicle).length >= 1 ||
                approaching.filter(unit => unit.rules.type === ObjectType.Infantry).length >= 3) {
                state.earlyPressureUntil = tick + 2700;
                state.earlyPressurePosition = { rx: approaching.reduce((sum, unit) => sum + unit.tile.rx, 0) / approaching.length,
                    ry: approaching.reduce((sum, unit) => sum + unit.tile.ry, 0) / approaching.length };
            }
        }
        const count = game.getVisibleUnits(player.name, "enemy", rules => rules.harvester).length;
        if (count > 0) state.lastEnemyMinerSeenTick = tick;
        // Monotonic peak queue: later equal/higher sightings supersede older ones.
        while (state.minerPeaks.length && tick - state.minerPeaks[0].tick >= 2700) state.minerPeaks.shift();
        while (state.minerPeaks.length && state.minerPeaks[state.minerPeaks.length - 1].count <= count) state.minerPeaks.pop();
        state.minerPeaks.push({ tick, count });
        state.tick = tick;
    }
    const earlyPressure = tick < state.earlyPressureUntil;
    const pressured = !isEcoOnly(context) && (state.baseUnderSiege || earlyPressure || tick - state.lastEconomicLossTick < 900);
    return { pressured, baseUnderSiege: state.baseUnderSiege, earlyPressure, earlyPressureUntil: state.earlyPressureUntil,
        earlyPressurePosition: state.earlyPressurePosition, lastEconomicLossTick: state.lastEconomicLossTick,
        enemyMinersSeen: state.minerPeaks[0]?.count ?? 0, lastEnemyMinerSeenTick: state.lastEnemyMinerSeenTick,
        passiveEnemy: tick >= 5400 && !pressured && tick - state.lastHomeCombatTick >= 2700 };
}

export function isPressured(context: PressureContext): boolean {
    return readPressure(context).pressured;
}

/** E7 relaxations use only the rolling visible-miner peak and the real quiet-home window. */
export function getEconomyPressureLimits(context: PressureContext, miners: number) {
    const state = readPressure(context);
    return {
        minerCoreFactor: 1,
        crawlMiners: 2,
        extraRefineryCredits: state.passiveEnemy ? 600 : 1000,
    };
}

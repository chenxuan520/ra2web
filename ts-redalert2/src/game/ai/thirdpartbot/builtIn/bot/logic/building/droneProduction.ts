import { ApiEvent, ApiEventType, GameApi, ObjectType } from "../../../game-api";
import { isSovietCountry } from "../../strategy/basicInfantryBudget";
import { countCoreTanks, readStrategicSituation } from "../../strategy/nationalComposition";
import { SupabotContext } from "../common/context";
import { isEcoOnly, readPressure } from "../common/pressure";

interface DroneProductionState { tick: number; built: number; seenIds: Set<number>; aliveIds: Set<number> }
const states = new WeakMap<GameApi, Map<string, DroneProductionState>>();

export function getDroneProductionState(game: GameApi, playerName: string): Readonly<DroneProductionState> {
    return stateFor(game, playerName);
}
function stateFor(game: GameApi, playerName: string): DroneProductionState {
    let players = states.get(game);
    if (!players) { players = new Map(); states.set(game, players); }
    let state = players.get(playerName);
    if (!state || game.getCurrentTick() < state.tick) {
        state = { tick: game.getCurrentTick(), built: 0, seenIds: new Set(), aliveIds: new Set() };
        players.set(playerName, state);
    }
    return state;
}

/** First own spawn records a delivery once. Captures, transport and parasite limbo are not new production or deaths. */
export function observeDroneProductionEvent(game: GameApi, playerName: string, event: ApiEvent): void {
    const state = stateFor(game, playerName), id = Number(event.target);
    state.tick = game.getCurrentTick();
    if (event.type === ApiEventType.ObjectSpawn || event.type === ApiEventType.ObjectOwnerChange && event.newOwnerName === playerName) {
        const unit = game.getGameObjectData(id);
        if (unit?.owner !== playerName || unit.rules.type !== ObjectType.Vehicle || unit.rules.name !== "DRON") return;
        if (event.type === ApiEventType.ObjectSpawn && !state.seenIds.has(id)) state.built++;
        state.seenIds.add(id); state.aliveIds.add(id);
    } else if (event.type === ApiEventType.ObjectDestroy || event.type === ApiEventType.ObjectOwnerChange && event.newOwnerName !== playerName) {
        state.aliveIds.delete(id);
    }
}

export function getDronePriority(context: SupabotContext): number {
    if (context.difficulty !== "brutal" || isEcoOnly(context)) return 0;
    const { game, player } = context, data = game.getPlayerData(player.name);
    if (!isSovietCountry(data.country?.name)) return 0;
    const state = stateFor(game, player.name), tick = game.getCurrentTick(), pressure = readPressure(context);
    state.tick = tick;
    // Newly captured/current own drones also consume the live cap. A world-list disappearance never removes an own ID.
    for (const id of game.getVisibleUnits(player.name, "self", rules => rules.name === "DRON")) {
        state.seenIds.add(id); state.aliveIds.add(id);
    }
    if (pressure.pressured || tick >= 9000 || state.built >= 4 || state.aliveIds.size >= 2) return 0;
    const s = readStrategicSituation(game, data), core = countCoreTanks(s);
    if (state.built === 0 && (s.own.NAWEAP ?? 0) + (s.own.GAWEAP ?? 0) > 0 && s.harvesters >= 1) return 112;
    if (state.built === 1 && s.harvesters >= 3) return 105;
    if ((state.built === 2 || state.built === 3) && core >= 4 && tick - pressure.lastEnemyMinerSeenTick < 1800) return 60;
    return 0;
}

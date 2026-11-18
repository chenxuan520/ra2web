import type { GameApi } from '../../game-api';
import { isSovietCountry } from './basicInfantryBudget';
import { BRUTAL_PARAMS, BRUTAL_OVERRIDES, type BrutalParams } from './brutalParams';

export type ParamPath = `${keyof BrutalParams}.${string}`;
export const LARGE_MAP_AREA = 23563;
export interface StrategyContext { faction: 'allied' | 'soviet'; mapSize: 'smallMap' | 'largeMap' }
const contexts = new WeakMap<GameApi, Map<string, StrategyContext>>();

export function strategyContext(game: GameApi, playerName: string): StrategyContext {
    let players = contexts.get(game);
    if (!players) { players = new Map(); contexts.set(game, players); }
    let context = players.get(playerName);
    if (!context) {
        const size = game.mapApi.getRealMapSize();
        context = { faction: isSovietCountry(game.getPlayerData(playerName).country?.name) ? 'soviet' : 'allied',
            mapSize: size.width * size.height >= LARGE_MAP_AREA ? 'largeMap' : 'smallMap' };
        players.set(playerName, context);
    }
    return context;
}

export function sp(game: GameApi, playerName: string, path: ParamPath): number {
    const dot = path.indexOf('.');
    const group = path.slice(0, dot) as keyof BrutalParams;
    const name = path.slice(dot + 1);
    const values = BRUTAL_PARAMS[group] as Record<string, number> | undefined;
    if (!values || !Object.hasOwn(values, name)) throw new Error(`Unknown strategy parameter ${path}`);
    // Empty/default tables do not need player/map observations. Tags are immutable game metadata.
    const overrides = BRUTAL_OVERRIDES as Record<string, Record<string, number>>;
    if (!Object.values(overrides).some(table => Object.hasOwn(table, path))) return values[name];
    const context = strategyContext(game, playerName);
    return overrides[context.faction][path] ?? overrides[context.mapSize][path] ?? values[name];
}

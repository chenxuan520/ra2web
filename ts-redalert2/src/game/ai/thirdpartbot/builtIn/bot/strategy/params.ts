import type { GameApi } from '../../game-api';
import { BRUTAL_PARAMS, type BrutalParams } from './brutalParams';

export type ParamPath = `${keyof BrutalParams}.${string}`;

export function sp(game: GameApi, playerName: string, path: ParamPath): number {
    const dot = path.indexOf('.');
    const group = path.slice(0, dot) as keyof BrutalParams;
    const name = path.slice(dot + 1);
    const values = BRUTAL_PARAMS[group] as Record<string, number> | undefined;
    if (!values || !Object.hasOwn(values, name)) throw new Error(`Unknown strategy parameter ${path}`);
    return values[name];
}

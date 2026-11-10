export type Params = Record<'economy' | 'assault', Record<string, number>>;
export type Factor = 0.8 | 1.25;
const excluded = new Set(['maxRefineries', 'maxFactories', 'defenseMaxCount', 'teslaMaxCount', 'harvestersPerRefinery']);

export function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = Math.imul(state ^ state >>> 15, state | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
}
export function mutateParameter(name: string, value: number, factor: Factor): number {
    if (!Number.isFinite(value)) throw new Error(`Non-finite parameter ${name}`);
    let next = Number.isInteger(value) ? Math.round(value * factor) : Math.round(value * factor * 100) / 100;
    if (Number.isInteger(value) && next === value) next += factor > 1 ? 1 : -1;
    const ratio = name.includes('Ratio') || name.includes('Fraction');
    return Math.max(ratio ? 0.3 : 0, Math.min(ratio ? 3 : Infinity, next));
}
export function generateMutants(parent: Params, seed: number): Params[] {
    const eligible = Object.entries(parent).flatMap(([group, values]) => Object.entries(values)
        .filter(([key]) => !key.endsWith('Priority') && !excluded.has(key))
        .map(([key, value]) => ({ group: group as keyof Params, key, value })))
        .sort((a, b) => `${a.group}.${a.key}` < `${b.group}.${b.key}` ? -1 : 1);
    if (eligible.length < 3) throw new Error('At least three mutable parameters are required');
    const random = mulberry32(seed);
    return Array.from({ length: 6 }, () => {
        const child = structuredClone(parent), remaining = [...eligible];
        let changed = 0;
        while (changed < 3 && remaining.length) {
            const entry = remaining.splice(Math.floor(random() * remaining.length), 1)[0];
            const factor: Factor = random() < 0.5 ? 0.8 : 1.25;
            let next = mutateParameter(entry.key, entry.value, factor);
            // Boundary clipping must not silently reduce the promised three real changes.
            if (next === entry.value) next = mutateParameter(entry.key, entry.value, factor === 0.8 ? 1.25 : 0.8);
            if (next === entry.value) continue;
            child[entry.group][entry.key] = next; changed++;
        }
        if (changed !== 3) throw new Error('Fewer than three parameters admit an effective mutation');
        return child;
    });
}
/** Return the zero-based winning child, or null when it does not beat the parent by three wins. */
export function selectMutation(parentWins: number, childWins: readonly number[]): number | null {
    if (![parentWins, ...childWins].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid fitness');
    let best: number | null = null;
    for (let index = 0; index < childWins.length; index++)
        if (best === null || childWins[index] > childWins[best]) best = index;
    return best !== null && childWins[best] >= parentWins + 3 ? best : null;
}

type Visit = (group: keyof Params, key: string, value: number, prefix: string, suffix: string) => string;
function mapParamLines(source: string, visit: Visit): string {
    let group: keyof Params | undefined;
    return source.split('\n').map(line => {
        const heading = /^\s*(economy|assault):\s*\{\s*$/.exec(line);
        if (heading) group = heading[1] as keyof Params;
        const entry = /^(\s+[A-Za-z]\w*:\s*)(-?\d+(?:\.\d{1,2})?)(,\s*)$/.exec(line);
        if (entry && group) {
            const key = /^\s*([A-Za-z]\w*):/.exec(entry[1])![1];
            return visit(group, key, Number(entry[2]), entry[1], entry[3]);
        }
        if (line.trim() === '},') group = undefined;
        return line;
    }).join('\n');
}
export function parseParams(source: string): Params {
    if (!source.trim().startsWith('export const BRUTAL_PARAMS = {') || !source.trim().endsWith('export type BrutalParams = typeof BRUTAL_PARAMS;'))
        throw new Error('Unexpected brutalParams.ts format');
    const params: Params = { economy: {}, assault: {} };
    mapParamLines(source, (group, key, value, prefix, suffix) => {
        if (Object.hasOwn(params[group], key) || !Number.isFinite(value)) throw new Error(`Invalid parameter ${group}.${key}`);
        params[group][key] = value; return prefix + String(value) + suffix;
    });
    if (Object.values(params).some(group => !Object.keys(group).length)) throw new Error('Missing parameter group');
    return params;
}
export function replaceParams(source: string, params: Params): string {
    const original = parseParams(source);
    for (const group of ['economy', 'assault'] as const) {
        if (Object.keys(original[group]).sort().join() !== Object.keys(params[group]).sort().join()) throw new Error(`Changed parameter keys in ${group}`);
    }
    return mapParamLines(source, (group, key, _old, prefix, suffix) => {
        const value = params[group][key];
        if (!Number.isFinite(value) || Number(value.toFixed(2)) !== value) throw new Error(`Invalid replacement ${group}.${key}`);
        return prefix + String(value) + suffix;
    });
}
export function parameterDiff(before: Params, after: Params): { parameter: string; before: number; after: number }[] {
    return Object.entries(before).flatMap(([group, values]) => Object.entries(values)
        .filter(([key, value]) => value !== after[group as keyof Params][key])
        .map(([key, value]) => ({ parameter: `${group}.${key}`, before: value, after: after[group as keyof Params][key] })));
}

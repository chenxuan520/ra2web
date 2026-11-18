import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const GROUPS = ['pressure', 'economy', 'production', 'expand', 'defense', 'scout', 'harass', 'assault'] as const;
export type BaseParams = Record<string, number>;
export interface ParamBounds { min: number; max: number; int: boolean; mutable: boolean; weight: number }
export type ParamSpace = Record<string, ParamBounds>;
const switches = new Set(['assault.marchCohesion', 'assault.engageSpread', 'assault.dogHunt', 'assault.tankOpening']);
const priorities = new Set(['economy.firstFactoryPrioritySoviet', 'economy.firstFactoryPriorityAllied']);
const entryPattern = /^(\s{8})([A-Za-z]\w*)(:\s*)(-?\d+(?:\.\d{1,2})?)(,\s*)$/;

function visitParams(source: string, visit: (path: string, value: number, original: string) => string): string {
    let active = false, group = '';
    const seenGroups = new Set<string>();
    const lines = source.split(/(?<=\n)/);
    const result = lines.map(line => {
        const content = line.replace(/[\r\n]+$/, ''), ending = line.slice(content.length);
        if (content === 'export const BRUTAL_PARAMS = {') { active = true; return line; }
        if (!active) return line;
        if (content === '};') { active = false; return line; }
        const heading = /^ {4}([A-Za-z]\w*):\s*\{\s*$/.exec(content);
        if (heading) {
            group = heading[1];
            if (!(GROUPS as readonly string[]).includes(group) || seenGroups.has(group)) throw new Error(`Invalid parameter group ${group}`);
            seenGroups.add(group); return line;
        }
        if (content.trim() === '},') { group = ''; return line; }
        const match = entryPattern.exec(content);
        if (!match || !group) throw new Error(`Invalid parameter line: ${content}`);
        return match[1] + match[2] + match[3] + visit(`${group}.${match[2]}`, Number(match[4]), match[4]) + match[5] + ending;
    }).join('');
    if (seenGroups.size !== GROUPS.length) throw new Error('Missing parameter group');
    return result;
}
export function parseParams(source: string): BaseParams {
    const params: BaseParams = {};
    visitParams(source, (path, value, original) => {
        if (Object.hasOwn(params, path) || !Number.isFinite(value)) throw new Error(`Invalid parameter ${path}`);
        params[path] = value; return original;
    });
    return params;
}
export function renderParams(source: string, params: BaseParams): string {
    const original = parseParams(source);
    if (Object.keys(original).sort().join() !== Object.keys(params).sort().join()) throw new Error('Changed parameter keys');
    return visitParams(source, (path, value, text) => {
        const next = params[path];
        if (!Number.isFinite(next) || Number(next.toFixed(2)) !== next) throw new Error(`Invalid replacement ${path}`);
        return next === value ? text : String(next);
    });
}
export function boundsFor(path: string, v: number): ParamBounds {
    const [group, name] = path.split('.');
    let int = Number.isInteger(v), min: number, max: number, mutable = true;
    if (name.startsWith('enable') || switches.has(path) || path === 'economy.ecoOnly') {
        int = true; min = 0; max = 1; mutable = path !== 'economy.ecoOnly';
    } else if (name.endsWith('Priority') || priorities.has(path)) {
        int = true; min = v; max = v; mutable = false;
    } else if (name.endsWith('Ratio') || name.endsWith('Factor')) {
        min = int ? 0 : Math.min(v, 0.3); max = int ? v + 3 : 3;
    } else if (/^max/i.test(name) || name.endsWith('Cap')) {
        int = true; min = 1; max = v + 3;
    } else if (group === 'scout') {
        min = v; max = v; mutable = false;
    } else {
        min = Math.floor(v * 0.4); max = Math.max(v + 2, Math.ceil(v * 2.5));
    }
    const weight = mutable ? ['pressure', 'production', 'assault'].includes(group) ? 3 : 1 : 0;
    return { min, max, int, mutable, weight };
}
export function initSpace(params: BaseParams, existing: ParamSpace = {}): ParamSpace {
    const result: ParamSpace = { ...existing };
    for (const path of Object.keys(params).sort()) if (!Object.hasOwn(result, path)) result[path] = boundsFor(path, params[path]);
    return result;
}
export const OVERRIDE_LABELS = ['smallMap', 'largeMap', 'allied', 'soviet'] as const;
export type OverrideLabel = typeof OVERRIDE_LABELS[number];
export interface Genome { base: BaseParams; overrides: Record<OverrideLabel, BaseParams> }
function emptyOverrides(): Genome['overrides'] { return { smallMap: {}, largeMap: {}, allied: {}, soviet: {} }; }
const overrideBlock = /^export const BRUTAL_OVERRIDES = \{\r?\n[\s\S]*?^\};/m;
export function parseGenome(source: string): Genome {
    const base = parseParams(source), overrides = emptyOverrides(), block = overrideBlock.exec(source)?.[0];
    if (!block) return { base, overrides };
    let label: OverrideLabel | undefined;
    const seen = new Set<string>();
    for (const line of block.split(/\r?\n/).slice(1, -1)) {
        const head = /^ {4}(\w+):\s*\{$/.exec(line);
        if (head) {
            if (!(OVERRIDE_LABELS as readonly string[]).includes(head[1]) || seen.has(head[1])) throw new Error('Invalid override table');
            label = head[1] as OverrideLabel; seen.add(label); continue;
        }
        if (line.trim() === '},') { label = undefined; continue; }
        const entry = /^ {8}'([A-Za-z]\w*\.[A-Za-z]\w*)':\s*(-?\d+(?:\.\d{1,2})?),\s*$/.exec(line);
        if (!entry || !label || Object.hasOwn(overrides[label], entry[1])) throw new Error(`Invalid override line ${line}`);
        overrides[label][entry[1]] = Number(entry[2]);
    }
    if (seen.size !== 4) throw new Error('Missing override table');
    return { base, overrides };
}
export function renderGenome(source: string, genome: Genome): string {
    const base = renderParams(source, genome.base), block = overrideBlock.exec(base);
    if (!block) {
        if (overrideCount(genome)) throw new Error('Source has no override tables');
        return base;
    }
    const ending = source.includes('\r\n') ? '\r\n' : '\n';
    const replacement = 'export const BRUTAL_OVERRIDES = {' + ending + OVERRIDE_LABELS.map(label =>
        `    ${label}: {` + ending + Object.keys(genome.overrides[label]).sort().map(path => {
            const value = genome.overrides[label][path];
            if (!Number.isFinite(value) || Number(value.toFixed(2)) !== value) throw new Error(`Invalid override ${path}`);
            return `        '${path}': ${value},` + ending;
        }).join('') + '    },' + ending).join('') + '};';
    return base.slice(0, block.index) + replacement + base.slice(block.index + block[0].length);
}
export function overrideCount(genome: Genome): number { return OVERRIDE_LABELS.reduce((sum, label) => sum + Object.keys(genome.overrides[label]).length, 0); }
export function validateGenome(genome: Genome, space: ParamSpace): string[] {
    const errors: string[] = [];
    const check = (path: string, value: number, override: boolean) => {
        const bound = space[path];
        if (!bound) { errors.push(`Unknown parameter ${path}`); return; }
        if (!Number.isFinite(value) || value < bound.min || value > bound.max || Number(value.toFixed(2)) !== value || (bound.int && !Number.isInteger(value)))
            errors.push(`Out of range ${path}: ${value}`);
        if (override && !bound.mutable) errors.push(`Immutable override ${path}`);
    };
    for (const path of Object.keys(space)) if (!Object.hasOwn(genome.base, path)) errors.push(`Missing parameter ${path}`);
    for (const [path, value] of Object.entries(genome.base)) check(path, value, false);
    for (const label of OVERRIDE_LABELS) {
        if (!genome.overrides[label]) { errors.push(`Missing override table ${label}`); continue; }
        for (const [path, value] of Object.entries(genome.overrides[label])) check(path, value, true);
    }
    if (Object.keys(genome.overrides).some(label => !(OVERRIDE_LABELS as readonly string[]).includes(label))) errors.push('Unknown override table');
    if (OVERRIDE_LABELS.every(label => genome.overrides[label]) && overrideCount(genome) > 24) errors.push('More than 24 overrides');
    return errors;
}
export function genomeKey(genome: Genome): string {
    return JSON.stringify({ base: Object.fromEntries(Object.entries(genome.base).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
        overrides: Object.fromEntries(OVERRIDE_LABELS.map(label => [label, Object.fromEntries(Object.entries(genome.overrides[label]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))])) });
}
if (import.meta.main) {
    try {
        const { values } = parseArgs({ options: { init: { type: 'boolean' } } });
        if (!values.init) throw new Error('Usage: bun e2e/league/p4/paramSpace.ts --init');
        const source = await readFile(resolve(import.meta.dir, '../../../src/game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams.ts'), 'utf8');
        const file = resolve(import.meta.dir, 'paramSpace.json');
        let previous: ParamSpace = {};
        try { previous = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const params = parseParams(source), space = initSpace(params, previous);
        await writeFile(file, JSON.stringify(space, null, 2) + '\n');
        console.log(JSON.stringify({ parameters: Object.keys(params).length, mutable: Object.values(space).filter(entry => entry.mutable).length }, null, 2));
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

import { mulberry32 } from '../evolveCore';
import { genomeKey, overrideCount, OVERRIDE_LABELS, validateGenome, type Genome, type ParamBounds, type ParamSpace } from './paramSpace';
import { median } from '../records';
import type { ArenaGame } from './play';

export interface Mutation { kind: 'base' | 'override' | 'delete' | 'crossover'; path?: string; table?: string; before?: number; after?: number }
export interface Child { genome: Genome; parentIndices: number[]; mutations: Mutation[]; seed: number }
export function normal(random: () => number): number {
    const u = Math.max(Number.MIN_VALUE, random());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}
export function perturb(v: number, z: number, bound: ParamBounds): number {
    if (bound.int && bound.min === 0 && bound.max === 1) return 1 - v;
    const clip = (value: number) => Math.max(bound.min, Math.min(bound.max, value));
    if (bound.int) {
        let next = v === 0 ? 1 : Math.round(v * Math.exp(0.25 * z));
        if (next === v) next = v + (z >= 0 ? 1 : -1);
        next = clip(next);
        if (next === v) next = clip(v + (z >= 0 ? -1 : 1));
        return next;
    }
    let next = clip(Number((v * Math.exp(0.25 * z)).toFixed(2)));
    if (next === v) next = Number((v + (z >= 0 ? 0.05 : -0.05)).toFixed(2));
    return next;
}
function weighted(space: ParamSpace, random: () => number): string {
    const eligible = Object.entries(space).filter(([, bound]) => bound.mutable && bound.weight > 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    let draw = random() * eligible.reduce((sum, [, bound]) => sum + bound.weight, 0);
    for (const [path, bound] of eligible) { draw -= bound.weight; if (draw < 0) return path; }
    if (!eligible.length) throw new Error('No mutable strategy parameters');
    return eligible.at(-1)![0];
}
function entries(genome: Genome) {
    return OVERRIDE_LABELS.flatMap(table => Object.keys(genome.overrides[table]).map(path => ({ table, path })))
        .sort((a, b) => `${a.table}.${a.path}` < `${b.table}.${b.path}` ? -1 : 1);
}
export function makeChild(parents: readonly Genome[], space: ParamSpace, seed: number, existing: ReadonlySet<string>, crossover = true): Child {
    if (parents.length !== 4) throw new Error('Exactly four parents are required');
    for (let attempt = 0; attempt < 20; attempt++) {
        const actualSeed = seed + attempt * 1000, random = mulberry32(actualSeed);
        const first = Math.floor(random() * 4), genome = structuredClone(parents[first]), parentIndices = [first], mutations: Mutation[] = [];
        if (crossover && random() < 0.15) {
            const alternatives = [0, 1, 2, 3].filter(index => index !== first), second = alternatives[Math.floor(random() * 3)];
            parentIndices.push(second);
            for (const path of Object.keys(genome.base).sort()) if (random() < 0.5) genome.base[path] = parents[second].base[path];
            for (const table of OVERRIDE_LABELS) {
                const union = { ...parents[second].overrides[table], ...parents[first].overrides[table] };
                genome.overrides[table] = Object.fromEntries(Object.keys(union).sort().filter(() => random() < 0.5).map(path => [path, union[path]]));
            }
            for (const entry of entries(genome).slice(24)) delete genome.overrides[entry.table][entry.path];
            mutations.push({ kind: 'crossover' });
        }
        const draw = random(), count = draw < 0.5 ? 1 : draw < 0.8 ? 2 : 3;
        const mutateBase = () => {
            const path = weighted(space, random), before = genome.base[path], after = perturb(before, normal(random), space[path]);
            genome.base[path] = after; mutations.push({ kind: 'base', path, before, after });
        };
        for (let index = 0; index < count; index++) {
            const kind = random();
            if (kind < 0.7) mutateBase();
            else if (kind < 0.9) {
                const table = OVERRIDE_LABELS[Math.floor(random() * 4)], path = weighted(space, random);
                if (!Object.hasOwn(genome.overrides[table], path) && overrideCount(genome) >= 24) { mutateBase(); continue; }
                const before = genome.overrides[table][path] ?? genome.base[path], after = perturb(before, normal(random), space[path]);
                genome.overrides[table][path] = after; mutations.push({ kind: 'override', table, path, before, after });
            } else {
                const choices = entries(genome);
                if (!choices.length) { mutateBase(); continue; }
                const { table, path } = choices[Math.floor(random() * choices.length)], before = genome.overrides[table][path];
                delete genome.overrides[table][path]; mutations.push({ kind: 'delete', table, path, before });
            }
        }
        if (!validateGenome(genome, space).length && !existing.has(genomeKey(genome))) return { genome, parentIndices, mutations, seed: actualSeed };
    }
    throw new Error(`Unable to generate a unique valid child after 20 attempts: ${seed}`);
}
export function population(champion: Genome, parents: readonly Genome[], space: ParamSpace, run: number, generation: number, reuseParents = false, seedOn?: string): Child[] {
    const carried = generation > 0 || reuseParents;
    if (carried && parents.length !== 4) throw new Error('Four selected parents are required');
    if (seedOn && (carried || !space[seedOn]?.mutable || !space[seedOn].int || space[seedOn].min !== 0 || space[seedOn].max !== 1))
        throw new Error('seed-on requires a mutable switch and cannot reuse parents');
    const ordinaryParents = carried ? parents : Array.from({ length: 4 }, () => champion);
    const result: Child[] = [], seen = new Set([genomeKey(champion)]);
    for (let index = 0; index < 15; index++) {
        const seed = run * 100000 + generation * 100 + index;
        if (carried && index < 4) {
            const genome = structuredClone(parents[index]), key = genomeKey(genome);
            if (seen.has(key) || validateGenome(genome, space).length) throw new Error('Selected parents are not unique valid genomes');
            result.push({ genome, seed, parentIndices: [index], mutations: [] }); seen.add(key); continue;
        }
        const sourceParents = seedOn && index < 4 ? ordinaryParents.map(parent => {
            const genome = structuredClone(parent); genome.base[seedOn] = 1; return genome;
        }) : ordinaryParents;
        const child = makeChild(sourceParents, space, seed, seen, generation > 0 || reuseParents);
        result.push(child); seen.add(genomeKey(child.genome));
    }
    result.push({ genome: structuredClone(champion), seed: run * 100000 + generation * 100 + 15, parentIndices: [], mutations: [] });
    return result;
}
export function gameScore(result: ArenaGame['result'], ticks: number): number {
    return result === 'a-win' ? 1 + 0.3 * (1 - ticks / 27000) : 0;
}
export interface Fitness {
    index: number; id: string; origin: string; score: number; wins: number; losses: number; timeouts: number;
    winMedian: number | null; overrides: number; lead: number; selected: boolean;
}
export function measureFitness(index: number, id: string, origin: string, genome: Genome, games: readonly ArenaGame[]): Fitness {
    if (games.length !== 64 || games.some(game => game.a !== id || game.result === 'error')) throw new Error(`Invalid 64-game fitness for ${id}`);
    return { index, id, origin, score: games.reduce((sum, game) => sum + gameScore(game.result, game.ticks), 0),
        wins: games.filter(game => game.result === 'a-win').length, losses: games.filter(game => game.result === 'b-win').length,
        timeouts: games.filter(game => game.result === 'timeout').length, winMedian: median(games.filter(game => game.result === 'a-win').map(game => game.ticks)),
        overrides: overrideCount(genome), lead: 0, selected: false };
}
export function selectParents(fitness: readonly Fitness[]): Fitness[] {
    return fitness.filter(row => row.index !== 15).sort((a, b) => b.score - a.score || a.overrides - b.overrides || a.index - b.index).slice(0, 4);
}
export function chooseCandidate(finalParents: readonly Fitness[], history: readonly Fitness[][]): { candidate: Fitness; meanLead: number; evaluations: number } {
    const candidates = finalParents.map(candidate => {
        const evaluations = history.flat().filter(row => row.origin === candidate.origin);
        return { candidate, meanLead: evaluations.reduce((sum, row) => sum + row.lead, 0) / evaluations.length, evaluations: evaluations.length };
    });
    const eligible = candidates.filter(row => row.evaluations >= 2).sort((a, b) => b.meanLead - a.meanLead);
    return eligible[0] ?? candidates.slice().sort((a, b) => b.candidate.score - a.candidate.score)[0];
}

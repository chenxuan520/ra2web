import { expect, test } from 'bun:test';
import { parseGenome, renderGenome, validateGenome, genomeKey, overrideCount, type ParamBounds, type ParamSpace } from '../../../e2e/league/p4/paramSpace';
import { makeChild, population, perturb, gameScore, selectParents, chooseCandidate, type Fitness } from '../../../e2e/league/p4/evolveCore';
import { buildCommit, git, PARAMETER_PATH } from '../../../e2e/league/p4/commit';
import { validateGeneration } from '../../../e2e/league/p4/evolve';
import { trainJobs } from '../../../e2e/league/p4/arena';
import type { ArenaGame } from '../../../e2e/league/p4/play';

async function inputs() {
    const source = await Bun.file(new URL('../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams.ts', import.meta.url)).text();
    const space: ParamSpace = await Bun.file(new URL('../../../e2e/league/p4/paramSpace.json', import.meta.url)).json();
    return { source, space, genome: parseGenome(source) };
}
function fitness(index: number, score: number, overrides = 0, origin = String(index), lead = score): Fitness {
    return { index, id: `g0-i${index}`, score, overrides, origin, lead, wins: 1, losses: 0, timeouts: 0, winMedian: 10000, selected: false };
}
test('population is deterministic, unique and changes with generation', async () => {
    const { genome, space } = await inputs();
    const first = population(genome, [], space, 1, 0), repeat = population(genome, [], space, 1, 0);
    expect(first).toEqual(repeat); expect(first).toHaveLength(16); expect(new Set(first.map(row => genomeKey(row.genome))).size).toBe(16);
    expect(first[15].genome).toEqual(genome);
    const parents = first.slice(0, 4).map(row => row.genome), second = population(genome, parents, space, 1, 1);
    expect(second).not.toEqual(first); expect(second.slice(0, 4).map(row => row.genome)).toEqual(parents);
});
test('500 valid children preserve immutable values, ranges and the override cap', async () => {
    const { genome, space } = await inputs(), parents = [genome, genome, genome, genome], existing = new Set([genomeKey(genome)]);
    for (let seed = 0; seed < 500; seed++) {
        const child = makeChild(parents, space, 100000 + seed, existing, false).genome;
        expect(validateGenome(child, space)).toEqual([]); expect(overrideCount(child)).toBeLessThanOrEqual(24); expect(genomeKey(child)).not.toBe(genomeKey(genome));
        for (const [path, bound] of Object.entries(space)) if (!bound.mutable) expect(child.base[path]).toBe(genome.base[path]);
    }
});
test('integer and fractional perturbations follow the prescribed edge rules', () => {
    const integer: ParamBounds = { min: 0, max: 10, int: true, mutable: true, weight: 1 };
    expect(perturb(0, -1, integer)).toBe(1); expect(perturb(10, 2, integer)).toBe(9); expect(perturb(0, 2, { ...integer, max: 1 })).toBe(1);
    expect(perturb(1, -2, { ...integer, max: 1 })).toBe(0); expect(perturb(5, 0, integer)).toBe(6);
    expect(perturb(1, -2, { ...integer, min: 1 })).toBe(2);
    const fraction = { ...integer, int: false, min: 0.3, max: 3 };
    expect(perturb(1, 0, fraction)).toBe(1.05); expect(perturb(1, 1, fraction)).toBe(1.28);
    // A boundary step may require a seeded retry; makeChild's validation never lets it escape the range.
    expect(perturb(0.3, -2, fraction)).toBe(0.25);
});
test('score rewards only victory and its simulation-tick speed', () => {
    expect(gameScore('a-win', 13500)).toBe(1.15); expect(gameScore('a-win', 26999)).toBeCloseTo(1, 4);
    expect(gameScore('b-win', 13500)).toBe(0); expect(gameScore('timeout', 27000)).toBe(0);
});
test('selection excludes control and breaks ties by override count then index', () => {
    const rows = [fitness(0, 5, 2), fitness(1, 5, 0), fitness(2, 5, 0), fitness(3, 4), fitness(4, 3), fitness(15, 100)];
    expect(selectParents(rows).map(row => row.index)).toEqual([1, 2, 0, 3]);
});
test('candidate lifetime averages beat a one-generation high score', () => {
    const long = fitness(0, 20, 0, 'long', 6), short = fitness(1, 30, 0, 'short', 20);
    const history = [[fitness(2, 10, 0, 'long', 4)], [fitness(3, 12, 0, 'long', 5)], [long, short]];
    const chosen = chooseCandidate([short, long], history); expect(chosen.candidate.origin).toBe('long'); expect(chosen.meanLead).toBe(5); expect(chosen.evaluations).toBe(3);
});
test('seed-on activates only the four biased founders and retains the off control', async () => {
    const { genome, space } = await inputs(), seeded = structuredClone(genome); seeded.base['assault.tankOpening'] = 0;
    const rows = population(seeded, [], space, 3, 0, false, 'assault.tankOpening');
    expect(rows[15].genome.base['assault.tankOpening']).toBe(0); expect(rows).toHaveLength(16);
    expect(() => population(genome, [], space, 3, 0, false, 'economy.firstRefineryPriority')).toThrow('mutable switch');
});
test('the same genome builds the same fixed-author commit and only changes the parameter file', async () => {
    const { source, genome } = await inputs(); genome.base['assault.minArmorShortMap'] = 5;
    const base = await git(['rev-parse', 'HEAD']), rendered = renderGenome(source, genome), first = await buildCommit(base, rendered), second = await buildCommit(base, rendered);
    expect(first).toBe(second); expect(await git(['diff-tree', '--no-commit-id', '--name-only', '-r', base, first])).toBe(PARAMETER_PATH);
    expect(await git(['show', '-s', '--format=%an|%ae|%cn|%ce|%aI|%cI', first])).toBe('p4-evolve|p4-evolve@invalid|p4-evolve|p4-evolve@invalid|2026-01-01T00:00:00Z|2026-01-01T00:00:00Z');
});
test('collection requires the exact 1024-game schedule with immutable identities and zero errors', () => {
    const jobs = Array.from({ length: 16 }, (_, index) => trainJobs(`g0-i${index}`, 90, 0, 'c8')).flat();
    const manifest: any = { run: 90, generation: 0, individuals: Array.from({ length: 16 }, (_, index) => ({ id: `g0-i${index}`, tree: 'a'.repeat(40) })),
        opponents: Object.fromEntries(['c8', 'c3', 'v5', 'x-infantry-01'].map(id => [id, 'b'.repeat(40)])) };
    const games: ArenaGame[] = jobs.flatMap(job => [false, true].map(swapped => ({ stage: job.stage, run: job.run, generation: job.generation, promotion: job.promotion,
        a: job.a, b: job.b, aTree: 'a'.repeat(40), bTree: 'b'.repeat(40), map: job.map, seed: job.seed, aCountry: job.aCountry, bCountry: job.bCountry,
        swapped, result: 'a-win' as const, reason: 'engine-victory-conditions', ticks: 13500 })));
    expect(() => validateGeneration(games, jobs, manifest, false)).not.toThrow();
    expect(() => validateGeneration(games.slice(1), jobs, manifest, false)).toThrow('1024');
    const error = games.map(game => ({ ...game })); error[0].result = 'error'; expect(() => validateGeneration(error, jobs, manifest, false)).toThrow('invalidates');
    const duplicate = [...games]; duplicate[1023] = duplicate[0]; expect(() => validateGeneration(duplicate, jobs, manifest, false)).toThrow('duplicate');
    const early = games.map(game => ({ ...game })); early[0].reason = 'value-model-early-stop'; expect(() => validateGeneration(early, jobs, manifest, false)).toThrow('termination');
});

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ALL_MAPS, HOLDOUT_MAPS, HOLDOUT_OPPONENTS, MATCHUPS, TRAIN_MAPS, TRAIN_OPPONENTS,
    assertRoundIsolation, holdoutJobs, jobId, promotionSeed, trainJobs, trainMaps, trainMatchups, trainOpponents, trainingSeed, type ArenaJob } from '../../../e2e/league/p4/arena';
import { benchmarkCommand, normalizeReport, samplePlayer, validateJobs } from '../../../e2e/league/p4/play';
import { gitQuery } from '../../../e2e/league/registry';

function changed(job: ArenaJob, fields: Partial<ArenaJob>): ArenaJob {
    const result = { ...job, ...fields };
    return { ...result, id: jobId(result) };
}
function benchmark() {
    const job = trainJobs('g0-i3', 1, 0, 'c8')[1];
    const a = { id: job.a, ref: '1'.repeat(40), commit: '1'.repeat(40), tree: 'a'.repeat(40), profile: 'brutal' as const };
    const b = { id: job.b, ref: '2'.repeat(40), commit: '2'.repeat(40), tree: 'b'.repeat(40), profile: 'brutal' as const };
    const resources = { iniSha256: 'ini', customIniSha256: 'custom', maps: { [job.map]: { mapSha256: 'map', terrainSha256: 'terrain' } } };
    const player = (name: string, credits: number) => ({ name, credits, creditsReceived: 5000, creditsSpent: 6000,
        harvesters: 2, buildings: 7, army: 10, assetValue: 15000, kills: 3, losses: 4,
        counts: { GAREFN: 1, NAREFN: 2, GAWEAP: 2, NAWEAP: 1 } });
    const raw: any = { candidate: { commit: a.commit, profile: a.profile, dirty: false, source: a.commit }, baseline: { commit: b.commit, profile: b.profile },
        engineCommit: 'engine', engineDirty: false, startupIssues: [], resources,
        settings: { maxTicks: 27000, sampleTicks: 900, credits: 10000, unitCount: 0, engineDifficulty: 4,
            pairedSpawnSwap: true, pairedPlayerOrderSwap: true, gameSpeed: 3, simulationTicksPerSecond: 15,
            shortGame: true, superWeapons: false, crates: false, engineStalemateDetection: false },
        matches: [false, true].map(swapped => {
            const candidatePlayerName = swapped ? '@@AI2@@' : '@@AI1@@', baselinePlayerName = swapped ? '@@AI1@@' : '@@AI2@@';
            return { seed: job.seed, candidateCountry: job.aCountry, baselineCountry: job.bCountry,
                map: `${job.map}.map`, mapSha256: 'map', terrainSha256: 'terrain', swapped, candidatePlayerName, baselinePlayerName,
                result: swapped ? 'baseline-win' : 'candidate-win', reason: 'engine-victory-conditions', ticks: 12345,
                startingLocations: swapped ? [{ x: 40, y: 50 }, { x: 10, y: 20 }] : [{ x: 10, y: 20 }, { x: 40, y: 50 }],
                telemetry: { errorCount: 0 }, samples: [0, 9000].map(tick => ({ tick, players: [player(candidatePlayerName, 111), player(baselinePlayerName, 222)] })) };
        }) };
    return { job, a, b, resources, raw, convert: () => normalizeReport(raw, job, a, b, 'engine', resources) };
}

describe('phase 4 arena and isolation', () => {
    test('train and holdout pools are disjoint and all opponents are registered', async () => {
        expect(HOLDOUT_MAPS.length).toBeGreaterThanOrEqual(4); expect(HOLDOUT_MAPS.length).toBeLessThanOrEqual(6);
        expect(TRAIN_MAPS.filter(map => (HOLDOUT_MAPS as readonly string[]).includes(map))).toEqual([]);
        expect(TRAIN_OPPONENTS.filter(id => HOLDOUT_OPPONENTS.includes(id))).toEqual([]);
        const league = await Bun.file(new URL('../../../e2e/league/league.json', import.meta.url)).json();
        const members = new Set(league.members.map((member: any) => member.id));
        for (const id of [...TRAIN_OPPONENTS, ...HOLDOUT_OPPONENTS]) expect(members.has(id)).toBe(true);
    });
    test('32 unique jobs use the fixed four-map/two-matchup/four-opponent schedule', () => {
        const jobs = trainJobs('g0-i3', 1, 0, 'c8');
        expect(jobs).toHaveLength(32); expect(new Set(jobs.map(job => job.id)).size).toBe(32);
        expect(trainMaps(0)).toEqual([TRAIN_MAPS[0], TRAIN_MAPS[2], TRAIN_MAPS[4], TRAIN_MAPS[6]]);
        expect(trainMaps(1)).toEqual([TRAIN_MAPS[1], TRAIN_MAPS[3], TRAIN_MAPS[5], TRAIN_MAPS[7]]);
        expect(trainMatchups(0)).toEqual(MATCHUPS.slice(0, 2)); expect(trainMatchups(2)).toEqual(MATCHUPS.slice(2));
        expect(trainOpponents(0, 'c8')).toEqual(['c8', 'c3', 'v5', 'x-infantry-01']);
        expect(jobs[0]).toMatchObject({ stage: 'train', run: 1, generation: 0, promotion: null, seed: 201001, aRef: 'league/g0-i3', bRef: 'league/c8' });
        expect(validateJobs(jobs)).toEqual(jobs);
    });
    test('four generations cover every training map and country matchup; five cover every training opponent', () => {
        const jobs = Array.from({ length: 4 }, (_, generation) => trainJobs('g0-i0', 1, generation, 'c8')).flat();
        expect([...new Set(jobs.map(job => job.map))].sort()).toEqual([...TRAIN_MAPS].sort());
        expect([...new Set(jobs.map(job => `${job.aCountry}:${job.bCountry}`))].sort()).toEqual(MATCHUPS.map(pair => pair.join(':')).sort());
        const opponents = new Set(Array.from({ length: 5 }, (_, generation) => trainOpponents(generation, 'c8')).flat());
        for (const opponent of TRAIN_OPPONENTS) expect(opponents.has(opponent)).toBe(true);
    });
    test('promotion covers every holdout map and all four country pairs', () => {
        const jobs = holdoutJobs('cand', 'c8', 1);
        expect(jobs).toHaveLength(HOLDOUT_MAPS.length * 4); expect(new Set(jobs.map(job => job.id)).size).toBe(jobs.length);
        expect(jobs[0]).toMatchObject({ stage: 'holdout', run: null, generation: null, promotion: 1, seed: 900029 });
        expect(validateJobs(jobs)).toEqual(jobs);
    });
    test('all specified training and promotion seed ranges are disjoint and greater than 100000', () => {
        const train = new Set<number>(), promotion = new Set<number>();
        for (let run = 1; run <= 99; run++) for (let generation = 0; generation <= 49; generation++)
            for (const map of ALL_MAPS) train.add(trainingSeed(run, generation, map));
        for (let round = 1; round <= 500; round++) for (const map of ALL_MAPS) promotion.add(promotionSeed(round, map));
        expect([...train, ...promotion].every(seed => seed > 100000)).toBe(true);
        expect([...train].some(seed => promotion.has(seed))).toBe(false);
        expect(() => trainingSeed(0, 0, TRAIN_MAPS[0])).toThrow(); expect(() => trainingSeed(100, 0, TRAIN_MAPS[0])).toThrow();
        expect(() => trainingSeed(1, 50, TRAIN_MAPS[0])).toThrow(); expect(() => promotionSeed(501, HOLDOUT_MAPS[0])).toThrow();
    });
    test('training cannot use a holdout map, opponent or tagged opponent alias', () => {
        const job = trainJobs('g0-i0', 1, 0, 'c8')[0];
        expect(() => validateJobs([changed(job, { map: HOLDOUT_MAPS[0] })])).toThrow('holdout');
        expect(() => validateJobs([changed(job, { b: 'x-rearm-01', bRef: 'league/x-rearm-01' })])).toThrow('holdout');
        expect(() => validateJobs([changed(job, { b: 'alias', bRef: 'refs/tags/league/x-rearm-01' })])).toThrow('holdout');
    });
    test('holdout never accepts an early-stop command or job flag', () => {
        const job = holdoutJobs('cand', 'c8', 1)[0];
        expect(() => validateJobs([job], 'model.json')).toThrow('early stopping');
        expect(() => validateJobs([{ ...job, earlyStop: true }])).toThrow('early stopping');
    });
    test('invalid seed, stage metadata, duplicate id and unfrozen refs fail batch validation', () => {
        const train = trainJobs('g0-i0', 1, 0, 'c8')[0], holdout = holdoutJobs('cand', 'c8', 1)[0];
        expect(() => validateJobs([changed(train, { seed: train.seed + 1 })])).toThrow('seed');
        expect(() => validateJobs([changed(holdout, { seed: holdout.seed + 1 })])).toThrow('seed');
        expect(() => validateJobs([changed(train, { promotion: 1 })])).toThrow('stage fields');
        expect(() => validateJobs([changed(holdout, { generation: 0 })])).toThrow('stage fields');
        expect(() => validateJobs([train, train])).toThrow('duplicate'); expect(() => validateJobs([])).toThrow('nonempty');
        expect(() => validateJobs([changed(train, { aRef: 'working-tree' })])).toThrow('frozen');
    });
    test('benchmark settings match the legacy runner and early-stop is only passed through', () => {
        const job = trainJobs('g0-i0', 1, 0, 'c8')[0], command = benchmarkCommand(job, '/cdn', '/out', 'model.json');
        for (const [option, value] of [['--max-ticks', '27000'], ['--sample-ticks', '900'], ['--credits', '10000'], ['--units', '0'], ['--early-stop', 'model.json']])
            expect(command[command.indexOf(option) + 1]).toBe(value);
        expect(command.includes('--no-swap')).toBe(false); expect(command.includes('--shard')).toBe(false);
    });
    test('round 8 rejects holds, active and aliases, while round 7 is unchanged', () => {
        expect(() => assertRoundIsolation(8, { a: 'c8', vs: 'x-rearm-01' })).toThrow('holds out');
        expect(() => assertRoundIsolation(7, { a: 'c8', vs: 'x-rearm-01' })).not.toThrow();
        expect(() => assertRoundIsolation(8, { a: 'c8', vs: 'active' })).toThrow('p4');
        expect(() => assertRoundIsolation(7, { a: 'c8', vs: 'active' })).not.toThrow();
        expect(() => assertRoundIsolation(8, { ref: ['t=refs/tags/league/x-rearm-01'] })).toThrow('holds out');
        expect(() => assertRoundIsolation(8, { 'round-robin': true }, ['c8', 'x-rearm-01'])).toThrow('holds out');
        expect(() => assertRoundIsolation(8, { a: 'c8', vs: 'v5', ref: ['t=1234567'] })).not.toThrow();
    });
    test('real CLI preflight rejects an invalid later job and commit aliases before creating output', async () => {
        const project = resolve(import.meta.dir, '../../..'), temporaryRoot = join(project, '.artifacts/p4/tests');
        await mkdir(temporaryRoot, { recursive: true });
        const directory = await mkdtemp(join(temporaryRoot, 'isolation-'));
        const launch = async (command: string[]) => {
            const child = Bun.spawn([process.execPath, ...command], { cwd: project, stdout: 'pipe', stderr: 'pipe',
                env: { ...process.env, RA2_BENCHMARK_CDN: join(project, '../.cache/ai-resources/cdn') } });
            const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
            expect(code).toBe(1); expect(error).toContain('holdout');
        };
        try {
            const jobs = trainJobs('c8', 1, 0, 'c8').slice(0, 2), input = join(directory, 'jobs.json'), out = join(directory, 'out');
            jobs[1] = changed(jobs[1], { b: 'x-rearm-01', bRef: 'league/x-rearm-01' });
            await writeFile(input, JSON.stringify(jobs));
            await launch(['e2e/league/p4/play.ts', '--jobs', input, '--out', out]); expect(existsSync(out)).toBe(false);
            const commit = await gitQuery(['rev-parse', 'league/x-rearm-01']);
            await writeFile(input, JSON.stringify([changed(jobs[0], { b: 'alias', bRef: commit })]));
            await launch(['e2e/league/p4/play.ts', '--jobs', input, '--out', out]); expect(existsSync(out)).toBe(false);
            const child = Bun.spawn([process.execPath, 'e2e/league/run.ts', '--round', '8', '--kind', 'dev', '--ref', `t=${commit}`,
                '--a', 't', '--vs', 'v5', '--out', out, '--cdn', join(project, '../.cache/ai-resources/cdn')], { cwd: project, stdout: 'pipe', stderr: 'pipe' });
            const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
            expect(code).toBe(1); expect(error).toContain('holds out'); expect(existsSync(out)).toBe(false);
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});

describe('phase 4 result and sample exports', () => {
    test('native paired rows retain fixed stage fields and candidate perspective after a swap', () => {
        const f = benchmark(), result = f.convert();
        expect(result.games.map(game => game.result)).toEqual(['a-win', 'b-win']);
        expect(Object.keys(result.games[0])).toEqual(['stage', 'run', 'generation', 'promotion', 'a', 'b', 'aTree', 'bTree', 'map', 'seed', 'aCountry', 'bCountry', 'swapped', 'result', 'reason', 'ticks']);
        expect(result.samples).toHaveLength(4); expect(result.samples[2].game).toBe(`${f.job.id}#true`);
        for (const sample of result.samples) { expect(sample.a.credits).toBe(111); expect(sample.b.credits).toBe(222); }
        expect(samplePlayer(f.raw.matches[0].samples[0].players[0])).toMatchObject({ refineries: 3, factories: 3 });
    });
    test.each(['missing-pair', 'engine', 'winner', 'startup', 'perspective', 'sampling', 'metric'])( '%s is not a complete resumable report', reason => {
        const f = benchmark();
        if (reason === 'missing-pair') f.raw.matches.pop();
        if (reason === 'engine') f.raw.engineDirty = true;
        if (reason === 'winner') f.raw.matches[0].reason = 'value-model-early-stop';
        if (reason === 'startup') f.raw.startupIssues.push('error');
        if (reason === 'perspective') f.raw.matches[1].samples[0].players.reverse();
        if (reason === 'sampling') f.raw.matches[0].samples[1].tick = 0;
        if (reason === 'metric') delete f.raw.matches[0].samples[0].players[0].assetValue;
        expect(f.convert).toThrow();
    });
    test('runtime errors remain errors and missing samples are not fabricated', () => {
        const f = benchmark(); f.raw.matches[0].result = 'error'; f.raw.matches[0].reason = 'logged-runtime-errors'; f.raw.matches[0].telemetry.errorCount = 1;
        f.raw.matches[0].samples = [];
        const result = f.convert(); expect(result.games[0].result).toBe('error'); expect(result.samples).toHaveLength(2);
    });
});

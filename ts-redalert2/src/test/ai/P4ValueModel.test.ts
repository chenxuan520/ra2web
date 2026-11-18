import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HOLDOUT_MAPS, holdoutJobs, jobId, trainJobs } from '../../../e2e/league/p4/arena';
import { benchmarkCommand, normalizeReport, validateJobs, type ArenaGame, type ArenaSample, type PlayerSample } from '../../../e2e/league/p4/play';
import { advanceStop, evaluate, features, fnv1a, isValidation, predict, train, validateValueModel, SEGMENTS, type ValueModel } from '../../../e2e/league/p4/valueCore';
import { trainingSamples } from '../../../e2e/league/p4/valueModel';

const player = (strong: boolean): PlayerSample => ({ credits: 0, creditsReceived: strong ? 20000 : 1000, creditsSpent: strong ? 15000 : 1000,
    harvesters: strong ? 5 : 1, buildings: strong ? 12 : 3, army: strong ? 20 : 1, assetValue: strong ? 30000 : 1000,
    kills: strong ? 15 : 0, losses: 0, refineries: strong ? 3 : 1, factories: strong ? 3 : 1 });
const model = (): ValueModel => ({ threshold: 0.97, accepted: true, validation: { V1: 1, V2: 0.5, V3: 200 },
    segments: SEGMENTS.map(([start, end]) => ({ start, end, w0: 20, w: Array(9).fill(0), mean: Array(9).fill(0), std: Array(9).fill(1), samples: 20 })) });
function key(validation: boolean): string {
    for (let i = 0; ; i++) if (isValidation('toy-' + i) === validation) return 'toy-' + i;
}
function reportFixture() {
    const job = trainJobs('g0-i3', 1, 0, 'c9')[1];
    const a = { id: job.a, ref: '1'.repeat(40), commit: '1'.repeat(40), tree: 'a'.repeat(40), profile: 'brutal' as const };
    const b = { id: job.b, ref: '2'.repeat(40), commit: '2'.repeat(40), tree: 'b'.repeat(40), profile: 'brutal' as const };
    const resources = { iniSha256: 'ini', customIniSha256: 'custom', maps: { [job.map]: { mapSha256: 'map', terrainSha256: 'terrain' } } };
    const observed = (name: string) => ({ ...player(true), name, counts: { GAREFN: 3, GAWEAP: 3 } });
    const raw: any = { candidate: { commit: a.commit, profile: a.profile, dirty: false, source: a.commit }, baseline: { commit: b.commit, profile: b.profile },
        engineCommit: 'engine', engineDirty: false, startupIssues: [], resources,
        settings: { maxTicks: 27000, sampleTicks: 900, credits: 10000, unitCount: 0, engineDifficulty: 4, pairedSpawnSwap: true, pairedPlayerOrderSwap: true,
            gameSpeed: 3, simulationTicksPerSecond: 15, shortGame: true, superWeapons: false, crates: false, engineStalemateDetection: false,
            earlyStop: { sha256: 'model-hash', threshold: 0.97 } },
        matches: [false, true].map(swapped => {
            const candidatePlayerName = swapped ? '@@AI2@@' : '@@AI1@@', baselinePlayerName = swapped ? '@@AI1@@' : '@@AI2@@';
            return { seed: job.seed, candidateCountry: job.aCountry, baselineCountry: job.bCountry, map: `${job.map}.map`, mapSha256: 'map', terrainSha256: 'terrain',
                swapped, candidatePlayerName, baselinePlayerName, result: 'candidate-win', reason: 'value-model-early-stop', ticks: 9900,
                startingLocations: swapped ? [{ x: 40, y: 50 }, { x: 10, y: 20 }] : [{ x: 10, y: 20 }, { x: 40, y: 50 }], telemetry: { errorCount: 0 },
                samples: [0, 9000, 9900].map(tick => ({ tick, players: [observed(candidatePlayerName), observed(baselinePlayerName)] })) };
        }) };
    const early = { model: model(), sha256: 'model-hash' };
    return { job, a, b, resources, raw, early, convert: () => normalizeReport(raw, job, a, b, 'engine', resources, early) };
}

test('nine mirrored features negate and the fixed FNV-1a split never depends on sampling order', () => {
    const x = features(player(true), player(false)), y = features(player(false), player(true));
    expect(x).toHaveLength(9); x.forEach((value, index) => expect(value + y[index]).toBeCloseTo(0, 12));
    expect(fnv1a('hello')).toBe(1335831723); expect(isValidation(key(true))).toBe(true); expect(isValidation(key(false))).toBe(false);
});
test('full-batch logistic training is deterministic and separates a simple toy dataset', () => {
    const rows: ArenaSample[] = [];
    for (let i = 0; i < 40; i++) {
        const game = `training-${i}`; if (isValidation(game)) continue;
        const wins = i % 2 === 0;
        for (const [tick] of SEGMENTS) rows.push({ game, tick, result: wins ? 'a-win' : 'b-win', a: player(wins), b: player(!wins) });
    }
    const first = train(rows); expect(first).toEqual(train(rows));
    const accuracy = rows.filter(row => (predict(first, row.tick, row.a, row.b)! >= 0.5) === (row.result === 'a-win')).length / rows.length;
    expect(accuracy).toBeGreaterThanOrEqual(0.95); expect(first.segments.every(segment => segment.mean.every(value => value === 0))).toBe(true);
    expect(predict(first, 8999, player(true), player(false))).toBeNull(); expect(predict(first, 27000, player(true), player(false))).not.toBeNull();
    expect(predict(first, 27001, player(true), player(false))).toBeNull();
});
test('zero-variance standard deviations become one and timeout samples are not training labels', () => {
    const row: ArenaSample = { game: key(false), tick: 9000, result: 'a-win', a: player(false), b: player(false) };
    const fitted = train([row, { ...row, result: 'timeout' }]);
    expect(fitted.segments[0].samples).toBe(2); expect(fitted.segments[0].std).toEqual(Array(9).fill(1));
    expect(fitted.segments[0].w.every(Number.isFinite)).toBe(true);
});
test('stopping needs two same-side consecutive samples at or after tick 9000', () => {
    let state = { side: null, count: 0 } as const;
    expect(advanceStop(state, 8999, 1, 0.97).winner).toBeNull();
    const first = advanceStop(state, 9000, 0.97, 0.97); expect(first.winner).toBeNull();
    expect(advanceStop(first.state, 9900, 0.99, 0.97).winner).toBe('a');
    const reset = advanceStop(first.state, 9900, 0.5, 0.97); expect(reset.state.count).toBe(0);
    const opposite = advanceStop(first.state, 9900, 1 - 0.97, 0.97); expect(opposite.winner).toBeNull();
    expect(advanceStop(opposite.state, 10800, 0.01, 0.97).winner).toBe('b');
});
test('validation simulates periodic early stops, not a final native result sample', () => {
    const samples = (end: number): ArenaSample[] => [0, 9000, 9900, end].filter((tick, i, rows) => rows.indexOf(tick) === i)
        .map(tick => ({ game: key(true), tick, result: 'a-win', a: player(true), b: player(false) }));
    expect(evaluate(samples(9900), model()).stoppedGames).toBe(0);
    const evaluation = evaluate(samples(10000), model()); expect(evaluation.stoppedGames).toBe(1); expect(evaluation.meanSavedTicks).toBe(100);
    expect(evaluation.V3).toBe(1); expect(evaluation.accepted).toBe(false);
    expect(evaluate([0, 9000, 9800].map(tick => ({ game: key(true), tick, result: 'a-win', a: player(true), b: player(false) })), model()).stoppedGames).toBe(0);
});
test('accepted models require the exact nine-feature, three-segment format and V1-V3 gates', () => {
    expect(validateValueModel(model())).toEqual(model());
    for (const change of [(m: ValueModel) => { m.validation!.V1 = 0.979; }, (m: ValueModel) => { m.validation!.V2 = 0.299; },
        (m: ValueModel) => { m.validation!.V3 = 149; }, (m: ValueModel) => { m.segments[0].std[0] = 0; },
        (m: ValueModel) => { m.segments[0].w.pop(); }, (m: ValueModel) => { m.segments[1].w0 = NaN; }]) {
        const invalid = model(); change(invalid); expect(() => validateValueModel(invalid)).toThrow();
    }
    const disabled = model(); disabled.accepted = false; expect(() => validateValueModel(disabled)).toThrow('V1-V3');
    expect(validateValueModel(disabled, false)).toBe(disabled);
});
test('early-stop exports preserve their honest reason and require matching model predictions', () => {
    const f = reportFixture(), exported = f.convert();
    expect(exported.games.map(row => row.reason)).toEqual(['value-model-early-stop', 'value-model-early-stop']);
    expect(f.raw.matches[0].reason).toBe('value-model-early-stop'); expect(exported.games.every(row => row.result === 'a-win')).toBe(true);
    expect(() => normalizeReport(f.raw, f.job, f.a, f.b, 'engine', f.resources)).toThrow('unexpected');
    f.raw.matches[0].result = 'baseline-win'; expect(f.convert).toThrow('prediction mismatch');
});
test('model identity, minimum tick, runtime errors and holdout stage cannot bypass early-stop validation', () => {
    for (const change of [(f: ReturnType<typeof reportFixture>) => { f.raw.settings.earlyStop.sha256 = 'changed'; },
        (f: ReturnType<typeof reportFixture>) => { f.raw.matches[0].ticks = 9000; },
        (f: ReturnType<typeof reportFixture>) => { f.raw.matches[0].telemetry.errorCount = 1; },
        (f: ReturnType<typeof reportFixture>) => { f.job.stage = 'holdout'; }]) {
        const f = reportFixture(); change(f); expect(f.convert).toThrow();
    }
});
test('per-job flags route the frozen default model, while off commands and holdouts stay unchanged', () => {
    const job = trainJobs('g0-i0', 1, 0, 'c9')[0];
    expect(benchmarkCommand(job, '/cdn', '/out')).not.toContain('--early-stop');
    const enabled = benchmarkCommand({ ...job, earlyStop: true }, '/cdn', '/out');
    expect(enabled[enabled.indexOf('--early-stop') + 1]).toEndWith('/e2e/league/p4/valueModel.json');
    expect(() => validateJobs([{ ...job, earlyStop: 'true' }])).toThrow('flag');
    expect(() => validateJobs([{ ...holdoutJobs('cand', 'c9', 1)[0], earlyStop: true }])).toThrow('early stopping');
});
test('model sources require complete, native training games and matching final samples', async () => {
    const project = resolve(import.meta.dir, '../../..'), root = join(project, '.artifacts/p4/tests'); await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'value-source-')), file = join(directory, 'samples.jsonl'), job = trainJobs('g0-i3', 1, 0, 'c9')[1];
    const games: ArenaGame[] = [false, true].map(swapped => ({ stage: 'train', run: 1, generation: 0, promotion: null, a: job.a, b: job.b,
        aTree: 'a', bTree: 'b', map: job.map, seed: job.seed, aCountry: job.aCountry, bCountry: job.bCountry, swapped,
        result: 'a-win', reason: 'engine-victory-conditions', ticks: 10000 }));
    const rows = games.flatMap(game => [0, 9000, 9900, 10000].map(tick => ({ game: `${job.id}#${game.swapped}`, tick, result: game.result, a: player(true), b: player(false) })));
    const saveRows = (rows: unknown[]) => writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    try {
        await writeFile(join(directory, 'manifest.json'), JSON.stringify({ config: { jobs: [job], earlyStop: null, versions: { [job.a]: { tree: 'a' }, [job.b]: { tree: 'b' } } } }));
        await writeFile(join(directory, 'games.jsonl'), games.map(game => JSON.stringify(game)).join('\n') + '\n'); await saveRows(rows);
        expect((await trainingSamples([file])).samples).toHaveLength(8);
        await saveRows(rows.slice(0, -1)); await expect(trainingSamples([file])).rejects.toThrow('final');
        await saveRows(rows); games[0].reason = 'value-model-early-stop';
        await writeFile(join(directory, 'games.jsonl'), games.map(game => JSON.stringify(game)).join('\n')); await expect(trainingSamples([file])).rejects.toThrow('full-length');
        await writeFile(join(directory, 'manifest.json'), JSON.stringify({ config: { jobs: holdoutJobs('cand', 'c9', 1), earlyStop: null } }));
        await expect(trainingSamples([file])).rejects.toThrow('holdouts');
    } finally { await rm(directory, { recursive: true, force: true }); }
});
test('the actual benchmark rejects an early-stop holdout map before creating an output or a game', async () => {
    const project = resolve(import.meta.dir, '../../..'), root = join(project, '.artifacts/p4/tests'); await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'value-preflight-'));
    try {
        const file = join(directory, 'model.json'), out = join(directory, 'out.json'); await writeFile(file, JSON.stringify(model()));
        const child = Bun.spawn([process.execPath, 'e2e/ai-benchmark.ts', '--early-stop', file, '--map', HOLDOUT_MAPS[0], '--max-ticks', '27000', '--sample-ticks', '900', '--out', out],
            { cwd: project, stdout: 'pipe', stderr: 'pipe' });
        const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
        expect(code).not.toBe(0); expect(error).toContain('restricted'); expect(await Bun.file(out).exists()).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

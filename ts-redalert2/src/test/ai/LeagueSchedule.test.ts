import { describe, expect, test } from 'bun:test';
import { MAPS, MATCHUPS, pairingJobs, roundRobinJobs, seedFor, convertResult, compareGames, assertSelfMirror, type LeagueGame } from '../../../e2e/league/schedule';
import { reportGames, type FrozenMember } from '../../../e2e/league/run';

function row(swapped = false, result: LeagueGame['result'] = 'a-win'): LeagueGame {
    return { round: 0, kind: 'dev', a: 'm0', b: 'm0', aTree: 'a'.repeat(40), bTree: 'a'.repeat(40), map: 'mp08t2',
        seed: 501, aCountry: 'Americans', bCountry: 'Americans', swapped, result, reason: 'engine-victory-conditions', ticks: 100 };
}
function benchmark() {
    const job = pairingJobs('c1', 'm0', 1, 'qualify')[0];
    const a: FrozenMember = { id: 'c1', ref: '1'.repeat(40), commit: '1'.repeat(40), tree: 'a'.repeat(40), profile: 'brutal' };
    const b: FrozenMember = { id: 'm0', ref: '2'.repeat(40), commit: '2'.repeat(40), tree: 'b'.repeat(40), profile: 'brutal' };
    const resources = { iniSha256: 'ini', customIniSha256: 'custom', maps: { mp08t2: { mapSha256: 'map', terrainSha256: 'terrain' } } };
    const raw: any = { candidate: { commit: a.commit, profile: a.profile, dirty: false, source: a.commit }, baseline: { commit: b.commit, profile: b.profile },
        engineCommit: 'engine', engineDirty: false, startupIssues: [], resources,
        settings: { maxTicks: 27000, sampleTicks: 900, credits: 10000, unitCount: 0, engineDifficulty: 4,
            pairedSpawnSwap: true, pairedPlayerOrderSwap: true, gameSpeed: 3, simulationTicksPerSecond: 15, shortGame: true,
            superWeapons: false, crates: false, engineStalemateDetection: false },
        matches: [false, true].map(swapped => ({ seed: job.seed, candidateCountry: job.aCountry, baselineCountry: job.bCountry,
            map: 'mp08t2.map', mapSha256: 'map', terrainSha256: 'terrain', swapped,
            candidatePlayerName: swapped ? '@@AI2@@' : '@@AI1@@', baselinePlayerName: swapped ? '@@AI1@@' : '@@AI2@@',
            result: swapped ? 'baseline-win' : 'candidate-win', reason: 'engine-victory-conditions', ticks: 12345,
            startingLocations: swapped ? [{ x: 40, y: 50 }, { x: 10, y: 20 }] : [{ x: 10, y: 20 }, { x: 40, y: 50 }],
            telemetry: { errorCount: 0 } })) };
    return { raw, job, a, b, resources, convert: () => reportGames(raw, job, a, b, 1, 'qualify', 'engine', resources) };
}

describe('league schedule', () => {
    test('one pairing covers three maps and four country configurations with unique IDs', () => {
        const jobs = pairingJobs('c1', 'm0', 1, 'qualify');
        expect(jobs).toHaveLength(12); expect(new Set(jobs.map(job => job.id)).size).toBe(12);
        expect(new Set(jobs.map(job => job.map)).size).toBe(3);
        for (const map of MAPS) for (const [aCountry, bCountry] of MATCHUPS)
            expect(jobs.filter(job => job.map === map && job.aCountry === aCountry && job.bCountry === bCountry)).toHaveLength(1);
    });
    test('qualification and development seeds match the handoff', () => {
        expect(seedFor(1, 1, 'qualify')).toBe(1001);
        expect(seedFor(1, 3, 'dev')).toBe(1503);
        expect(seedFor(0, 2, 'qualify')).toBe(2);
    });
    test('rounds 1-50 never reuse qualification seeds for development', () => {
        const qualify = new Set<number>(), dev = new Set<number>();
        for (let round = 1; round <= 50; round++) for (let index = 1; index <= 3; index++) {
            qualify.add(seedFor(round, index, 'qualify')); dev.add(seedFor(round, index, 'dev'));
        }
        expect([...qualify].some(seed => dev.has(seed))).toBe(false);
        expect(qualify.has(101)).toBe(false); expect(dev.has(202)).toBe(false);
    });
    test('eight-member round robin has 336 jobs and preserves input member order', () => {
        const jobs = roundRobinJobs(['orig', 'r4', 'v0', 'v1', 'v2', 'v3', 'v4', 'm0'], 0, 'qualify');
        expect(jobs).toHaveLength(336); expect(new Set(jobs.map(job => job.id)).size).toBe(336);
        expect(jobs[0].a).toBe('orig'); expect(jobs[0].b).toBe('r4');
        expect(roundRobinJobs(['orig', 'r4', 'v0', 'm0'], 0, 'qualify')).toHaveLength(72);
    });
    test.each([['candidate-win', 'a-win'], ['baseline-win', 'b-win'], ['draw', 'timeout'], ['error', 'error']])('%s normalizes to %s', (input, output) => {
        expect(convertResult(input)).toBe(output);
    });
    test('invalid schedule and result inputs are rejected', () => {
        expect(() => seedFor(-1, 1, 'dev')).toThrow(); expect(() => seedFor(0, 0, 'dev')).toThrow();
        expect(() => seedFor(1, 4, 'qualify')).toThrow(); expect(() => pairingJobs('../x', 'm0', 0, 'dev')).toThrow();
        expect(() => roundRobinJobs(['m0', 'm0'], 0, 'dev')).toThrow(); expect(() => convertResult('unknown')).toThrow();
    });
    test('game ordering is stable and false swap precedes true', () => {
        const games = [row(true, 'b-win'), row(false)]; games.sort(compareGames);
        expect(games.map(game => game.swapped)).toEqual([false, true]);
    });
    test('same-country same-member wins and equal-time timeouts are mirrored', () => {
        expect(() => assertSelfMirror([row(), row(true, 'b-win')])).not.toThrow();
        expect(() => assertSelfMirror([row(false, 'timeout'), row(true, 'timeout')])).not.toThrow();
    });
    test.each(['same-winner', 'time', 'missing', 'tree'])( '%s breaks the self-mirror check', reason => {
        const pair = [row(), row(true, 'b-win')];
        if (reason === 'same-winner') pair[1].result = 'a-win';
        if (reason === 'time') pair[1].ticks++;
        if (reason === 'missing') pair.pop();
        if (reason === 'tree') pair[0].bTree = 'b'.repeat(40);
        expect(() => assertSelfMirror(pair)).toThrow();
    });
    test('cross-country same-member matches need not be mirrored', () => {
        const pair = [row(), row(true)]; pair.forEach(game => game.bCountry = 'Russians');
        expect(() => assertSelfMirror(pair)).not.toThrow();
    });
});

describe('league benchmark normalization', () => {
    test('complete native pair uses fixed JSON field order and immutable trees', () => {
        const f = benchmark(), games = f.convert();
        expect(games).toHaveLength(2);
        expect(games.map(game => game.result)).toEqual(['a-win', 'b-win']);
        expect(Object.keys(games[0])).toEqual(['round', 'kind', 'a', 'b', 'aTree', 'bTree', 'map', 'seed', 'aCountry', 'bCountry', 'swapped', 'result', 'reason', 'ticks']);
        expect(games[0].aTree).toBe(f.a.tree); expect(games[1].bTree).toBe(f.b.tree);
    });
    test.each(['missing', 'source', 'profile', 'engine', 'credits', 'swap', 'map', 'native', 'startup', 'starts', 'logged-error'])(
        '%s report is never resumed or scored as a valid pair', reason => {
            const f = benchmark();
            if (reason === 'missing') f.raw.matches.pop();
            if (reason === 'source') f.raw.candidate.commit = 'other';
            if (reason === 'profile') f.raw.baseline.profile = 'normal';
            if (reason === 'engine') f.raw.engineDirty = true;
            if (reason === 'credits') f.raw.settings.credits++;
            if (reason === 'swap') f.raw.matches[1].swapped = false;
            if (reason === 'map') f.raw.matches[0].mapSha256 = 'other';
            if (reason === 'native') f.raw.matches[0].reason = 'tick-limit';
            if (reason === 'startup') f.raw.startupIssues.push('error');
            if (reason === 'starts') delete f.raw.matches[0].startingLocations;
            if (reason === 'logged-error') f.raw.matches[0].telemetry.errorCount = 1;
            expect(f.convert).toThrow();
        });
    test('error result is preserved as error, never a win', () => {
        const f = benchmark(); f.raw.matches[0].result = 'error'; f.raw.matches[0].reason = 'logged-runtime-errors'; f.raw.matches[0].telemetry.errorCount = 1;
        expect(f.convert()[0].result).toBe('error');
    });
});

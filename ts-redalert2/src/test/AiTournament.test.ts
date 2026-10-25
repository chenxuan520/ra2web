import { describe, expect, test } from 'bun:test';
import { TOURNAMENT_COUNTRIES, createTournamentJobs, summarizeTournament, validateJobReport } from '../../e2e/ai-tournament-plan';
import { archiveJobAttempt } from '../../e2e/ai-tournament-storage';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const scenarios = [{ map: 'mp08t2', seed: 1011 }, { map: 'tn01t2', seed: 2022 }, { map: 'mp11t2', seed: 3033 }];
const job = createTournamentJobs(['Americans', 'French'], [scenarios[0]])[0];
const expected = { candidateCommit: 'candidate-sha', baselineCommit: 'baseline-sha', engineCommit: 'engine-sha',
    candidateProfile: 'brutal', baselineProfile: 'brutal', maxTicks: 27000, sampleTicks: 900, credits: 10000, unitCount: 0,
    mapSha256: 'map-sha', iniSha256: 'ini-sha', customIniSha256: 'custom-sha', terrainSha256: 'terrain-sha' };
function report() {
    return {
        candidate: { commit: expected.candidateCommit, profile: 'brutal', source: expected.candidateCommit, dirty: false },
        baseline: { commit: expected.baselineCommit, profile: 'brutal' }, engineCommit: expected.engineCommit, engineDirty: false,
        settings: { maxTicks: 27000, sampleTicks: 900, credits: 10000, unitCount: 0, engineDifficulty: 4,
            pairedSpawnSwap: true, pairedPlayerOrderSwap: true, gameSpeed: 3, simulationTicksPerSecond: 15,
            shortGame: true, superWeapons: false, crates: false, engineStalemateDetection: false },
        resources: { iniSha256: expected.iniSha256, customIniSha256: expected.customIniSha256 },
        matches: [false, true].map(swapped => ({ map: 'mp08t2.map', seed: job.seed, candidateCountry: job.candidateCountry,
            baselineCountry: job.baselineCountry, mapSha256: expected.mapSha256, terrainSha256: expected.terrainSha256,
            swapped, candidatePlayerName: swapped ? '@@AI2@@' : '@@AI1@@', baselinePlayerName: swapped ? '@@AI1@@' : '@@AI2@@',
            result: 'draw', reason: 'tick-limit', ticks: 27000, telemetry: { errorCount: 0 },
            startingLocations: swapped ? [{ x: 5, y: 6 }, { x: 1, y: 2 }] : [{ x: 1, y: 2 }, { x: 5, y: 6 }],
        })),
    };
}

describe('ordered country tournament', () => {
    test('schedules all 9 by 8 ordered matchups three times with two games per job', () => {
        const jobs = createTournamentJobs(TOURNAMENT_COUNTRIES, scenarios);
        expect(jobs).toHaveLength(216);
        expect(new Set(jobs.map(job => job.id)).size).toBe(216);
        const pairs = new Map<string, number>();
        for (const job of jobs) {
            expect(job.candidateCountry).not.toBe(job.baselineCountry);
            const key = `${job.candidateCountry}:${job.baselineCountry}`;
            pairs.set(key, (pairs.get(key) ?? 0) + 1);
        }
        expect(pairs.size).toBe(72);
        expect([...pairs.values()].every(count => count === 3)).toBe(true);
        const summary = summarizeTournament(jobs, new Map());
        expect(summary.total.expectedGames).toBe(432);
        expect(summary.total.winRateAllRecorded).toBeNull();
        expect(summary.matrix.Arabs.French.expectedGames).toBe(6);
        expect(summary.matrix.Arabs.Arabs).toBeUndefined();
    });

    test('refuses duplicate countries, scenarios and map aliases that overwrite job files', () => {
        expect(() => createTournamentJobs(['Arabs', 'Arabs'], scenarios)).toThrow('unique');
        expect(() => createTournamentJobs(['Arabs', 'French'], [scenarios[0], scenarios[0]])).toThrow('unique');
        expect(() => createTournamentJobs(['Arabs', 'French'], [scenarios[0], { map: 'mp08t2.map', seed: 1011 }])).toThrow('duplicate job');
    });

    test('accepts incomplete resume reports without treating the unplayed swap as finished', () => {
        const partial = report(); partial.matches.pop();
        expect(validateJobReport(partial, job, expected)).toBe(false);
        expect(validateJobReport(report(), job, expected)).toBe(true);
    });

    test('refuses mismatched frozen versions, changed rules, handicaps and player order', () => {
        const mutations: ((value: any) => void)[] = [
            value => value.candidate.commit = 'other', value => value.engineDirty = true,
            value => value.resources.iniSha256 = 'other', value => value.settings.credits = 99999,
            value => value.settings.engineDifficulty = 0, value => value.matches[1].candidatePlayerName = '@@AI1@@',
            value => value.matches[1].startingLocations = value.matches[0].startingLocations,
            value => value.matches[1].swapped = false, value => value.matches[0].ticks = 10,
            value => { value.matches[0].result = 'candidate-win'; value.matches[0].reason = 'tick-limit'; },
        ];
        for (const mutate of mutations) { const changed = report(); mutate(changed); expect(() => validateJobReport(changed, job, expected)).toThrow(); }
    });

    test('keeps errors and draws out of wins, makes denominators explicit, and replaces resumed jobs', () => {
        const jobs = createTournamentJobs(['Americans', 'French'], [scenarios[0]]);
        const result = report();
        result.matches[0].result = 'candidate-win'; result.matches[0].reason = 'engine-victory-conditions';
        result.matches[1].result = 'error'; result.matches[1].reason = 'uncaught-runtime-error';
        const reports = new Map([[jobs[0].id, result]]);
        const counts = summarizeTournament(jobs, reports).total;
        expect(counts).toMatchObject({ wins: 1, losses: 0, draws: 0, errors: 1, total: 2, expectedGames: 4, pending: 2,
            winRateValid: 1, winRateAllRecorded: 0.5, winRateDecisive: 1 });
        reports.set(jobs[0].id, report());
        expect(summarizeTournament(jobs, reports).total).toMatchObject({ wins: 0, draws: 2, errors: 0, total: 2, pending: 2,
            winRateAllRecorded: 0, winRateDecisive: null });
    });

    test('archives original errors, logs and verification receipts before retries without overwriting earlier evidence', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'ai-tournament-test-'));
        try {
            await mkdir(join(directory, 'jobs'));
            await writeFile(join(directory, 'jobs', 'job.json'), '{"result":"error"}');
            await writeFile(join(directory, 'jobs', 'job.log'), 'original error');
            await writeFile(join(directory, 'jobs', 'job.verified.json'), '{"reportSha256":"original"}');
            expect(await archiveJobAttempt(directory, 'job')).toHaveLength(3);
            await writeFile(join(directory, 'jobs', 'job.json'), '{"result":"draw"}');
            expect(await archiveJobAttempt(directory, 'job')).toHaveLength(1);
            expect(await readFile(join(directory, 'archives/job/attempt-0001.json'), 'utf8')).toBe('{"result":"error"}');
            expect(await readFile(join(directory, 'archives/job/attempt-0002.json'), 'utf8')).toBe('{"result":"draw"}');
            expect(await readdir(join(directory, 'jobs'))).toEqual([]);
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});

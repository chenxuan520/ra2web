import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPatches, patchDistance, nearestPatch, measureEconomy, summarizeEconomy,
    ECO_TICKS, type ResourceTile, type EcoMap, type EcoMatch, type EcoGame } from '../../../e2e/league/ecoCore';
import { ecoJobs, ecoBenchmarkCommand, reportEcoGames } from '../../../e2e/league/ecoTrial';
import { judgeEconomy, validateEcoReport, ecoGateMarkdown, type EcoReport } from '../../../e2e/league/ecoGate';
import { createEcoTelemetry } from '../../../e2e/ai-eco-telemetry';
import { MAPS } from '../../../e2e/league/schedule';
import { TiberiumType } from '../../engine/type/TiberiumType';
import { TiberiumTrait } from '../../game/gameobject/trait/TiberiumTrait';
import { AiDifficulty } from '../../game/gameopts/GameOpts';
import { GameSpeed } from '../../game/GameSpeed';

const values = { ore: 10, gems: 20 };
const tile = (rx: number, ry: number, ore = 200, gems = 0, spawnsOre = false): ResourceTile => ({ rx, ry, ore, gems, spawnsOre });
const ecoMap = (): EcoMap => ({ values, patches: [
    { id: '0_0', cx: 1, cy: 0, tiles: 2, value: 6000, gemValue: 3000, isGem: true, regrows: false, nearestStart: 0, distToStart: [40, 41] },
    { id: '50_0', cx: 50, cy: 0, tiles: 1, value: 2000, gemValue: 0, isGem: false, regrows: true, nearestStart: 0, distToStart: [50, 60] },
] });
function match(ticks = 9000): EcoMatch {
    return { result: ticks === 9000 ? 'draw' : 'candidate-win', reason: ticks === 9000 ? 'tick-limit' : 'engine-victory-conditions', ticks,
        ecoMap: ecoMap(), samples: Array.from({ length: Math.floor(ticks / 900) + 1 }, (_, index) => {
            const tick = index * 900, miners = Math.min(index, 5);
            return { tick, eco: { oreValue: 10000 - index * 600, gemValue: 4000 - index * 200,
                patchValues: { '0_0': [6000 - index * 400, 3000 - index * 200], '50_0': [2000, 0] } },
                players: [
                    { name: '@@AI1@@', counts: { GAWEAP: index >= 2 ? 1 : 0, NAWEAP: index >= 7 ? 1 : 0 },
                        eco: { miners, minersByPatch: { '0_0': index >= 3 ? miners : 0, '50_0': 0 },
                            refineries: index >= 2 ? [{ x: 0, y: 1, patch: '0_0' }] : [], servedPatches: index >= 2 ? 1 : 0 } },
                    { name: '@@AI2@@', counts: {}, eco: { miners: 0, minersByPatch: { '0_0': 0, '50_0': 0 }, refineries: [], servedPatches: 0 } },
                ],
            };
        }) };
}
function games(): EcoGame[] {
    return ecoJobs().flatMap(job => [false, true].map(swapped => ({ jobId: job.id, map: job.map, seed: job.seed,
        country: job.country, swapped, player: 0, result: 'timeout', reason: 'tick-limit', ticks: 9000,
        ecoMap: ecoMap(), metrics: measureEconomy(match()), error: null } as EcoGame)));
}

describe('economic resource patches', () => {
    test('Chebyshev distance two connects diagonals and transitive components; three does not', () => {
        const patches = findPatches([tile(0, 0), tile(2, 2), tile(4, 4), tile(7, 4)], values);
        expect(patches.map(patch => [patch.id, patch.tiles.length])).toEqual([['0_0', 3], ['7_4', 1]]);
        expect(patches[0].center).toEqual({ rx: 2, ry: 2 });
        expect(patches[0].value).toBe(6000);
    });
    test('gem share at exactly half is a gem patch; a smaller share is not', () => {
        expect(findPatches([tile(0, 0, 100, 50)], values)[0]).toMatchObject({ value: 2000, gemValue: 1000, isGem: true });
        expect(findPatches([tile(0, 0, 101, 50)], values)[0].isGem).toBe(false);
    });
    test('small patches are discarded unless a spawning point is within inclusive Euclidean distance four', () => {
        expect(findPatches([tile(0, 0, 199)], values)).toEqual([]);
        expect(findPatches([tile(0, 0, 200)], values)).toHaveLength(1);
        expect(findPatches([tile(0, 0, 1), tile(4, 0, 0, 0, true)], values)[0].regrows).toBe(true);
        expect(findPatches([tile(0, 0, 1), tile(4, 1, 0, 0, true)], values)).toEqual([]);
        expect(findPatches([tile(0, 0, 0, 0, true)], values)).toEqual([]);
        expect(findPatches([tile(0, 0), tile(2, 0, 0, 0, true), tile(4, 0)], values)).toHaveLength(2);
    });
    test('numeric coordinate order gives stable IDs, sorted unique coordinates and rounded centers without mutating input', () => {
        const input = [tile(10, 0), tile(8, 1), tile(8, 0), tile(8, 0, 0, 0, true)];
        const before = structuredClone(input), patches = findPatches(input, values);
        expect(findPatches([...input].reverse(), values)).toEqual(patches);
        expect(patches[0].id).toBe('8_0');
        expect(patches[0].tiles).toEqual([{ rx: 8, ry: 0 }, { rx: 8, ry: 1 }, { rx: 10, ry: 0 }]);
        expect(patches[0].center).toEqual({ rx: 9, ry: 0 });
        expect(input).toEqual(before);
    });
    test('distance is to the nearest tile, not the center; six and nine are inclusive with stable ties', () => {
        const patches = findPatches([tile(0, 0), tile(2, 0), tile(12, 0)], values);
        expect(patchDistance({ rx: 2, ry: 9 }, patches[0])).toBe(9);
        expect(nearestPatch({ rx: 2, ry: 9 }, patches, 9)?.id).toBe('0_0');
        expect(nearestPatch({ rx: 2, ry: 10 }, patches, 9)).toBeNull();
        expect(nearestPatch({ rx: 2, ry: 6 }, patches, 6)?.id).toBe('0_0');
        expect(nearestPatch({ rx: 2, ry: 7 }, patches, 6)).toBeNull();
        expect(nearestPatch({ rx: 7, ry: 0 }, [...patches].reverse(), 6)?.id).toBe('0_0');
        expect(nearestPatch({ rx: 0, ry: 0 }, [], 6)).toBeNull();
    });
    test('missing or invalid resource values and coordinates are rejected, not replaced by zero', () => {
        expect(() => findPatches([tile(0, 0)], { ore: NaN, gems: 20 })).toThrow('values');
        expect(() => findPatches([tile(0, 0, -1)], values)).toThrow('resource');
        expect(() => findPatches([tile(NaN, 0)], values)).toThrow('coordinate');
    });
});

describe('economic measurements', () => {
    test('all E1 per-game metrics come from the hand-written sample series', () => {
        const result = measureEconomy(match());
        expect(result.mined).toEqual({ 3600: 3200, 5400: 4800, 7200: 6400, 9000: 8000 });
        expect(result.miners).toEqual({ 3600: 4, 5400: 5, 7200: 5, 9000: 5 });
        expect(result.refineries).toEqual({ 3600: 1, 5400: 1, 7200: 1, 9000: 1 });
        expect(result.factories).toEqual({ 3600: 1, 5400: 1, 7200: 2, 9000: 2 });
        expect(result.servedPatches).toEqual({ 3600: 1, 5400: 1, 7200: 1, 9000: 1 });
        expect(result.gemShare).toBe(0.25);
        expect(result.homeGemPatch).toBe(true);
        expect(result.firstGemMinerTick).toBe(2700);
        expect(result.maxMinersOnPatch).toBe(5);
        expect(result.survived).toBe(true);
    });
    test('the measured player index never follows physical slots', () => {
        for (const swapped of [false, true]) {
            const raw = { ...match(), swapped };
            expect(measureEconomy(raw, 0).miners[7200]).toBe(5);
            expect(measureEconomy(raw, 1).miners[7200]).toBe(0);
            expect(measureEconomy(raw, 1).homeGemPatch).toBe(false);
        }
    });
    test('home gems require own side and distance at most forty, not merely any gems', () => {
        const raw = match(); raw.ecoMap.patches[0].distToStart[0] = 41;
        expect(measureEconomy(raw).homeGemPatch).toBe(false);
        expect(measureEconomy(raw).firstGemMinerTick).toBeNull();
        raw.ecoMap.patches[0].distToStart[0] = 40; raw.ecoMap.patches[0].nearestStart = 1;
        expect(measureEconomy(raw).homeGemPatch).toBe(false);
    });
    test('maps without gems, zero net mining and absent gem miners stay null; regrowth clamps only mined', () => {
        const raw = match();
        for (const sample of raw.samples) { sample.eco.gemValue = 0; sample.players[0].eco.minersByPatch['0_0'] = 0; }
        expect(measureEconomy(raw).gemShare).toBeNull();
        expect(measureEconomy(raw).firstGemMinerTick).toBeNull();
        for (const sample of raw.samples) sample.eco.oreValue = 10000;
        expect(measureEconomy(raw).mined[9000]).toBe(0);
        raw.samples.at(-1)!.eco.oreValue = 11000;
        expect(measureEconomy(raw).mined[9000]).toBe(0);
        const unmined = match(); for (const sample of unmined.samples) { sample.eco.oreValue = 10000; sample.eco.gemValue = 4000; }
        expect(measureEconomy(unmined).gemShare).toBeNull();
    });
    test('an early end has no fabricated later observations and is not survived, including victory at tick 9000', () => {
        const result = measureEconomy(match(5400));
        expect(result.mined[5400]).toBe(4800); expect(result.mined[7200]).toBeNull();
        expect(result.miners[9000]).toBeNull(); expect(result.gemShare).toBeNull(); expect(result.survived).toBe(false);
        const ended = match(); ended.result = 'candidate-win'; ended.reason = 'engine-victory-conditions';
        expect(measureEconomy(ended).survived).toBe(false);
    });
    test.each(['map', 'initial', 'middle', 'final', 'eco', 'counts', 'patch', 'player', 'unordered', 'error'])(
        '%s missing or invalid telemetry is rejected', issue => {
            const raw: any = match();
            if (issue === 'map') delete raw.ecoMap;
            if (issue === 'initial') raw.samples.shift();
            if (issue === 'middle') raw.samples.splice(3, 1);
            if (issue === 'final') raw.samples.pop();
            if (issue === 'eco') delete raw.samples[1].eco;
            if (issue === 'counts') delete raw.samples[1].players[0].counts;
            if (issue === 'patch') delete raw.samples[1].players[0].eco.minersByPatch['0_0'];
            if (issue === 'player') raw.samples[1].players.reverse();
            if (issue === 'unordered') raw.samples.reverse();
            if (issue === 'error') raw.result = 'error';
            expect(() => measureEconomy(raw, 0, ['@@AI1@@', '@@AI2@@'])).toThrow();
        });
});

describe('economic trial schedule and integrity', () => {
    test('all eight pool maps have same-country paired jobs with 1-based seeds 7001-7008', () => {
        const jobs = ecoJobs(); expect(jobs).toHaveLength(16);
        expect(new Set(jobs.map(job => job.id)).size).toBe(16);
        expect(jobs.map(job => job.map)).toEqual(MAPS.flatMap(map => [map, map]));
        for (const [index, map] of MAPS.entries()) {
            expect(jobs.filter(job => job.map === map).map(job => [job.seed, job.country])).toEqual([
                [7001 + index, 'Americans'], [7001 + index, 'Russians'],
            ]);
        }
        const command = ecoBenchmarkCommand(jobs[0], 'frozen', '/cdn', '/out');
        expect(command.slice(1)).toEqual(['e2e/ai-benchmark.ts', '--candidate-ref', 'frozen', '--baseline-ref', 'league/x-idle-01',
            '--candidate-profile', 'brutal', '--baseline-profile', 'brutal', '--map', 'mp08t2', '--seeds', '7001',
            '--matchups', 'Americans:Americans', '--max-ticks', '9000', '--sample-ticks', '900', '--credits', '10000', '--units', '0',
            '--cdn', '/cdn', '--out', '/out']);
    });
    test('32 complete games provide four-game map means, whole-pool means and observation counts', () => {
        const report = summarizeEconomy(games());
        expect(report).toMatchObject({ valid: true, complete: true, expectedGames: 32, completedGames: 32, errors: 0, survived: 32 });
        expect(report.byMap.map(row => [row.map, row.games])).toEqual(MAPS.map(map => [map, 4]));
        expect(report.mean.mined[9000]).toBe(8000); expect(report.observations.mined[9000]).toBe(32);
        expect(report.byMap[0].mean.firstGemMinerTick).toBe(2700);
    });
    test('28 survived passes, 27 fails; early nulls are excluded from means with explicit denominators', () => {
        const rows = games();
        for (let index = 0; index < 4; index++) { rows[index].metrics = measureEconomy(match(5400)); rows[index].ticks = 5400; rows[index].result = 'a-win'; rows[index].reason = 'engine-victory-conditions'; }
        const report = summarizeEconomy(rows);
        expect(report.valid).toBe(true); expect(report.survived).toBe(28);
        expect(report.observations.mined[9000]).toBe(28); expect(report.byMap[0].mean.mined[9000]).toBeNull();
        rows[4].metrics!.survived = false;
        expect(summarizeEconomy(rows).valid).toBe(false);
    });
    test('errors, missing or duplicate swaps, wrong scenarios and worker failures invalidate the report', () => {
        const rows = games(); rows[0].result = 'error'; rows[0].metrics = null; rows[0].error = 'runtime';
        expect(summarizeEconomy(rows)).toMatchObject({ valid: false, errors: 1 });
        expect(summarizeEconomy(games().slice(1)).valid).toBe(false);
        const duplicate = games(); duplicate[0].swapped = true;
        expect(summarizeEconomy(duplicate).valid).toBe(false);
        const wrongSeed = games(); wrongSeed[0].seed = 7000;
        expect(summarizeEconomy(wrongSeed).valid).toBe(false);
        expect(summarizeEconomy(games(), { failed: 'exit 1' }).valid).toBe(false);
    });
    test('one runtime error excludes both swaps from every measurement denominator without erasing raw evidence', () => {
        const rows = games(); rows[0].result = 'error'; rows[0].metrics = null; rows[0].error = 'runtime';
        rows[1].metrics!.mined[9000] = 90000;
        const report = summarizeEconomy(rows);
        expect(report).toMatchObject({ valid: false, complete: true, completedGames: 32, errors: 1, survived: 30 });
        expect(report.observations.mined[9000]).toBe(30); expect(report.mean.mined[9000]).toBe(8000);
        expect(report.observations.homeGemPatch).toBe(30);
        expect(report.byMap[0].games).toBe(4); expect(report.byMap[0].observations.mined[9000]).toBe(2);
        expect(report.byMap[0].mean.mined[9000]).toBe(8000);
        expect(rows).toHaveLength(32); expect(rows[0].error).toBe('runtime'); expect(rows[1].metrics!.mined[9000]).toBe(90000);
    });
    test('a failed worker pair never contributes measurements even if its complete error-free rows were supplied', () => {
        const rows = games(), failed = rows[0].jobId;
        rows[0].metrics!.mined[9000] = 90000; rows[1].metrics!.mined[9000] = 90000;
        const report = summarizeEconomy(rows, { [failed]: 'Worker exited 1 despite an error-free report' });
        expect(report).toMatchObject({ valid: false, complete: true, completedGames: 32, errors: 0, survived: 30 });
        expect(report.failures[failed]).toContain('Worker exited 1');
        expect(report.observations.mined[9000]).toBe(30); expect(report.mean.mined[9000]).toBe(8000);
        expect(report.byMap[0].games).toBe(4); expect(report.byMap[0].observations.mined[9000]).toBe(2);
        expect(rows[0].metrics!.mined[9000]).toBe(90000);
    });
    test('native benchmark validation preserves a/b order and rejects incomplete or wrong frozen reports', () => {
        const job = ecoJobs()[0], member = { id: 'c3', ref: 'league/c3', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
        const idle = { id: 'x-idle-01', ref: 'league/x-idle-01', commit: 'c'.repeat(40), tree: 'd'.repeat(40) };
        const resources = { iniSha256: 'ini', customIniSha256: 'custom', mapSha256: 'map', terrainSha256: 'terrain' };
        const raw: any = { candidate: { commit: member.commit, profile: 'brutal', source: member.ref, dirty: false }, baseline: { commit: idle.commit, profile: 'brutal' },
            engineCommit: 'engine', engineDirty: false, startupIssues: [], resources,
            settings: { maxTicks: 9000, sampleTicks: 900, credits: 10000, unitCount: 0, engineDifficulty: AiDifficulty.Normal,
                pairedSpawnSwap: true, pairedPlayerOrderSwap: true, gameSpeed: 3, simulationTicksPerSecond: GameSpeed.BASE_TICKS_PER_SECOND, shortGame: true,
                superWeapons: false, crates: false, engineStalemateDetection: false },
            matches: [false, true].map(swapped => { const data = match();
                const names = swapped ? ['@@AI2@@', '@@AI1@@'] : ['@@AI1@@', '@@AI2@@'];
                for (const sample of data.samples) sample.players.forEach((player, index) => player.name = names[index]);
                return { ...data, map: `${job.map}.map`, mapSha256: 'map', terrainSha256: 'terrain', seed: job.seed,
                    candidateCountry: job.country, baselineCountry: job.country, swapped,
                    candidatePlayerName: names[0], baselinePlayerName: names[1], telemetry: { errorCount: 0 },
                    startingLocations: swapped ? [{ x: 50, y: 0 }, { x: 0, y: 0 }] : [{ x: 0, y: 0 }, { x: 50, y: 0 }] };
            }) };
        const convert = () => reportEcoGames(raw, job, member, idle, 'engine', resources);
        expect(convert().map(row => [row.swapped, row.player, row.metrics!.miners[7200]])).toEqual([[false, 0, 5], [true, 0, 5]]);
        raw.matches[0].telemetry.errorCount = 1; expect(convert).toThrow(); raw.matches[0].telemetry.errorCount = 0;
        raw.matches[0].result = 'error'; raw.matches[0].error = 'initialization failure';
        delete raw.matches[0].ticks; delete raw.matches[0].startingLocations; delete raw.matches[0].ecoMap;
        expect(convert()[0]).toMatchObject({ result: 'error', ticks: null, ecoMap: null, metrics: null, error: 'initialization failure' });
        raw.matches.pop(); expect(convert).toThrow('incomplete');
        expect(ECO_TICKS).toEqual([3600, 5400, 7200, 9000]);
    });
});

describe('read-only economic observer', () => {
    test('uses runtime prices and real owned objects, keeps tick-zero coordinates after depletion and never calls gameplay APIs', () => {
        const resource = (rx: number, amount: number, gems = false) => Object.freeze({ tile: Object.freeze({ rx, ry: 0 }),
            isOverlay: () => true, isTiberium: () => true, isTerrain: () => false,
            traits: { get: (trait: unknown) => { expect(trait).toBe(TiberiumTrait); return { getTiberiumType: () => gems ? TiberiumType.Gems : TiberiumType.Ore, getBailCount: () => amount }; } } });
        const object = (rx: number, miner: boolean, refinery: boolean) => Object.freeze({ tile: Object.freeze({ rx, ry: 0 }),
            rules: Object.freeze({ harvester: miner, refinery }), isBuilding: () => refinery });
        let resources = [resource(0, 200), resource(2, 100, true), resource(20, 200)];
        const owned = Object.freeze([object(0, true, false), object(6, true, false), object(9, false, true), object(30, false, true)]);
        let objects: readonly any[] = owned;
        const players = [{ getOwnedObjects: () => objects }, { getOwnedObjects: () => [] }];
        const forbidden = () => { throw new Error('observer called a gameplay API'); };
        const game: any = { currentTick: 0, map: {}, getWorld: () => ({ getAllObjects: () => resources }),
            rules: { getTiberium: (type: TiberiumType) => ({ value: type === TiberiumType.Ore ? 10 : 20 }) },
            rng: { next: forbidden }, actionsApi: new Proxy({}, { get: forbidden }), getPlayerByName: forbidden, update: forbidden };
        const observer = createEcoTelemetry(game, players, [{ x: 0, y: 0 }, { x: 20, y: 0 }]);
        const initial = observer.sample();
        expect(observer.ecoMap.values).toEqual(values);
        expect(observer.ecoMap.patches.map(patch => [patch.id, patch.nearestStart])).toEqual([['0_0', 0], ['20_0', 1]]);
        expect(initial.eco).toEqual({ oreValue: 4000, gemValue: 2000, patchValues: { '0_0': [4000, 2000], '20_0': [2000, 0] } });
        expect(initial.players[0]).toEqual({ miners: 2, minersByPatch: { '0_0': 2, '20_0': 0 },
            refineries: [{ x: 9, y: 0, patch: '0_0' }, { x: 30, y: 0, patch: null }], servedPatches: 1 });
        game.currentTick = 900; resources = [resource(4, 200), resource(20, 100)];
        expect(observer.sample().eco).toEqual({ oreValue: 3000, gemValue: 0, patchValues: { '0_0': [0, 0], '20_0': [1000, 0] } });
        expect(observer.ecoMap.patches[0]).toMatchObject({ id: '0_0', tiles: 2, value: 4000 });
        expect(owned[0].tile.rx).toBe(0);
        expect(() => createEcoTelemetry(game, players, [{ x: 0, y: 0 }, { x: 20, y: 0 }])).toThrow('tick 0');
        game.currentTick = 0; resources = [resource(0, 200), resource(12, 200)];
        objects = [object(6, false, true), object(6, true, false), object(7, true, false)];
        const shared = createEcoTelemetry(game, players, [{ x: 6, y: 0 }, { x: 6, y: 0 }]);
        expect(shared.ecoMap.patches.every(patch => patch.nearestStart === 0)).toBe(true);
        expect(shared.sample().players[0]).toMatchObject({ miners: 2, minersByPatch: { '0_0': 1, '12_0': 1 },
            refineries: [{ x: 6, y: 0, patch: '0_0' }], servedPatches: 2 });
        players[0].getOwnedObjects = () => undefined as any;
        expect(() => shared.sample()).toThrow('owned objects');
    });
});

// Hand-written economic metrics only; these fixtures are not measured AI scores.
function gateReport(mined7200 = 13000, mined9000 = 14000, miners7200 = 5): EcoReport {
    const rows = games();
    for (const row of rows) {
        row.metrics!.mined[7200] = mined7200; row.metrics!.mined[9000] = mined9000;
        row.metrics!.miners[7200] = miners7200; row.metrics!.servedPatches[9000] = 2;
    }
    return { schema: 1, member: 'fixture', tree: 'a'.repeat(40), games: rows, ...summarizeEconomy(rows) };
}
function editGateReport(report: EcoReport, edit: (rows: EcoGame[]) => void): EcoReport {
    edit(report.games);
    return { ...report, ...summarizeEconomy(report.games) };
}
function earlyGateMap(report: EcoReport): EcoReport {
    return editGateReport(report, rows => {
        for (const row of rows.slice(0, 4)) {
            row.ticks = 5400; row.result = 'a-win'; row.reason = 'engine-victory-conditions';
            row.metrics = measureEconomy(match(5400));
        }
    });
}

describe('economic gates (synthetic fixtures)', () => {
    test('K1 rejects 1.29 at 7200, accepts exactly 1.30 and 1.40, and rejects 1.39 at 9000', () => {
        const baseline = gateReport(10000, 10000);
        expect(judgeEconomy(gateReport(12900), baseline).gates.K1).toBe(false);
        const passing = judgeEconomy(gateReport(), baseline);
        expect(passing.valid).toBe(true); expect(passing.pass).toBe(true);
        expect(passing.gates).toEqual({ K1: true, K2: true, K3: true, K4: true, K5: true });
        expect(judgeEconomy(gateReport(13000, 13900), baseline).gates.K1).toBe(false);
    });
    test('K1 compares unrounded original values, not displayed ratios', () => {
        const baseline = gateReport(10000, 10000);
        expect(judgeEconomy(gateReport(12999.99), baseline).gates.K1).toBe(false);
        expect(judgeEconomy(gateReport(13000, 13999.99), baseline).gates.K1).toBe(false);
    });
    test('K2 rejects one regressing map even when the whole-pool K1 still passes; equality passes', () => {
        const baseline = gateReport(10000, 10000);
        const candidate = editGateReport(gateReport(13000, 16000), rows => {
            rows.slice(0, 4).forEach(row => row.metrics!.mined[9000] = 9999);
        });
        const result = judgeEconomy(candidate, baseline);
        expect(result.valid).toBe(true); expect(result.gates.K1).toBe(true); expect(result.gates.K2).toBe(false);
        expect(result.table[0].gates.K2).toBe(false);
        candidate.games.slice(0, 4).forEach(row => row.metrics!.mined[9000] = 10000);
        expect(judgeEconomy(editGateReport(candidate, () => {}), baseline).gates.K2).toBe(true);
    });
    test('K3 rejects a synthetic 4.9 mean and accepts 5.0 exactly', () => {
        const baseline = gateReport(10000, 10000);
        const below = judgeEconomy(gateReport(13000, 14000, 4.9), baseline);
        expect(below.valid).toBe(true); expect(below.candidate!.miners[7200]).toBeCloseTo(4.9);
        expect(below.gates.K3).toBe(false);
        expect(judgeEconomy(gateReport(), baseline).gates.K3).toBe(true);
    });
    test('K4 needs three non-null gem arrivals, includes 4500 and excludes 4501', () => {
        const baseline = gateReport(10000, 10000), candidate = editGateReport(gateReport(), rows => {
            [4500, 4500, 4501, null].forEach((tick, index) => rows[index].metrics!.firstGemMinerTick = tick);
        });
        let result = judgeEconomy(candidate, baseline);
        expect(result.valid).toBe(true); expect(result.gates.K4).toBe(false);
        expect(result.table[0]).toMatchObject({ homeGemGames: 4, earlyGemGames: 2, participates: { K4: true } });
        candidate.games[2].metrics!.firstGemMinerTick = 4500;
        result = judgeEconomy(editGateReport(candidate, () => {}), baseline);
        expect(result.gates.K4).toBe(true); expect(result.table[0].earlyGemGames).toBe(3);
    });
    test('K4 null arrivals are missing, never tick zero', () => {
        const candidate = editGateReport(gateReport(), rows => rows.slice(0, 4).forEach(row => row.metrics!.firstGemMinerTick = null));
        const result = judgeEconomy(candidate, gateReport(10000, 10000));
        expect(result.valid).toBe(true); expect(result.gates.K4).toBe(false);
        expect(result.table[0].earlyGemGames).toBe(0);
    });
    test.each([1, 4])('K4 skips a map with %s games without a home gem patch', absent => {
        const candidate = editGateReport(gateReport(), rows => {
            rows.slice(0, 4).forEach(row => row.metrics!.firstGemMinerTick = null);
            rows.slice(0, absent).forEach(row => {
                row.ecoMap!.patches[0].isGem = false; row.ecoMap!.patches[0].gemValue = 0;
                row.metrics!.homeGemPatch = false; row.metrics!.gemShare = null;
            });
        });
        const result = judgeEconomy(candidate, gateReport(10000, 10000));
        expect(result.valid).toBe(true); expect(result.gates.K4).toBe(true);
        expect(result.table[0].participates.K4).toBe(false);
    });
    test('K5 rejects four-game mean 1.75 and accepts exactly 2.0', () => {
        const baseline = gateReport(10000, 10000), candidate = editGateReport(gateReport(), rows => rows[0].metrics!.servedPatches[9000] = 1);
        const result = judgeEconomy(candidate, baseline);
        expect(result.valid).toBe(true); expect(result.gates.K5).toBe(false);
        expect(result.table[0].candidate.servedPatches[9000]).toBe(1.75);
        expect(result.table[0].minimumHomePatches).toBe(2);
        expect(judgeEconomy(gateReport(), baseline).gates.K5).toBe(true);
    });
    test('K5 uses the minimum own-side patch count across all four swaps, not an average or physical slot', () => {
        const candidate = editGateReport(gateReport(), rows => {
            rows.slice(0, 4).forEach(row => row.metrics!.servedPatches[9000] = 1);
            rows[1].ecoMap!.patches[1].nearestStart = 1;
        });
        const result = judgeEconomy(candidate, gateReport(10000, 10000));
        expect(result.valid).toBe(true); expect(result.gates.K5).toBe(true);
        expect(result.table[0]).toMatchObject({ minimumHomePatches: 1, participates: { K5: false }, gates: { K5: true } });
        expect(candidate.games[1].swapped).toBe(true); expect(candidate.games[1].player).toBe(0);
    });
    test('a legal 28-survivor candidate with one wholly missing future map cannot satisfy K2 or participating K5', () => {
        const candidate = earlyGateMap(gateReport()), baseline = gateReport(10000, 10000);
        const result = judgeEconomy(candidate, baseline);
        expect(result.valid).toBe(true); expect(result.pass).toBe(false);
        expect(result.gates.K2).toBe(false); expect(result.gates.K5).toBe(false);
        expect(result.table[0].candidate.mined[9000]).toBeNull(); expect(result.table[0].ratios.mined9000).toBeNull();
        expect(candidate.observations.mined[9000]).toBe(28);
    });
    test('a legal baseline missing a whole future map stays missing, not a zero target', () => {
        const result = judgeEconomy(gateReport(), earlyGateMap(gateReport(10000, 10000)));
        expect(result.valid).toBe(true); expect(result.gates.K2).toBe(false);
        expect(result.table[0].baseline.mined[9000]).toBeNull(); expect(result.table[0].ratios.mined9000).toBeNull();
    });
    test('zero baseline values follow the written inequalities while undefined ratios stay null', () => {
        const result = judgeEconomy(gateReport(0, 0), gateReport(0, 0));
        expect(result.valid).toBe(true); expect(result.gates.K1).toBe(true); expect(result.gates.K2).toBe(true);
        expect(result.table[0].ratios.mined7200).toBeNull(); expect(result.table[0].ratios.mined9000).toBeNull();
    });
    test('gemShare above one is preserved because ore regrowth reduces the net-mining denominator', () => {
        const candidate = editGateReport(gateReport(), rows => rows[0].metrics!.gemShare = 1.5);
        const result = judgeEconomy(candidate, gateReport(10000, 10000));
        expect(result.valid).toBe(true); expect(candidate.games[0].metrics!.gemShare).toBe(1.5);
        expect(result.candidate!.gemShare).toBe(candidate.mean.gemShare);
    });
    test('28 survivors are valid but 27 are invalid even with a forged true validity flag', () => {
        const candidate = earlyGateMap(gateReport());
        expect(validateEcoReport(candidate)).toBe(candidate);
        candidate.games[4].ticks = 5400; candidate.games[4].result = 'a-win'; candidate.games[4].reason = 'engine-victory-conditions';
        candidate.games[4].metrics = measureEconomy(match(5400));
        Object.assign(candidate, summarizeEconomy(candidate.games), { valid: true });
        expect(judgeEconomy(candidate, gateReport(10000, 10000)).valid).toBe(false);
    });
    test.each(['candidate', 'baseline'] as const)('%s invalidity is not a lost economic qualification', side => {
        const candidate = gateReport(), baseline = gateReport(10000, 10000);
        (side === 'candidate' ? candidate : baseline).valid = false;
        const result = judgeEconomy(candidate, baseline);
        expect(result.valid).toBe(false); expect(result.pass).toBe(false); expect(result.reason).toBeTruthy();
    });
    test.each(['map-set', 'duplicate-map', 'missing-game', 'duplicate-swap', 'wrong-seed', 'error', 'failure', 'false-complete',
        'schema', 'tree', 'missing-metrics', 'missing-tick', 'string-number', 'nan', 'infinity', 'observed-null', 'forged-mean',
        'forged-map-mean', 'forged-observations', 'forged-map-observations', 'invalid-patch', 'invalid-player', 'forged-survived', 'string-gem-tick']) (
        '%s datasets are invalid without coercion or trusting summary claims', issue => {
            const candidate: any = gateReport();
            if (issue === 'map-set') candidate.byMap[0].map = 'other-map';
            if (issue === 'duplicate-map') candidate.byMap[1].map = candidate.byMap[0].map;
            if (issue === 'missing-game') candidate.games.pop();
            if (issue === 'duplicate-swap') candidate.games[0].swapped = true;
            if (issue === 'wrong-seed') candidate.games[0].seed = 7000;
            if (issue === 'error') { candidate.games[0].result = 'error'; candidate.games[0].error = 'runtime'; }
            if (issue === 'failure') candidate.failures.worker = 'failed';
            if (issue === 'false-complete') candidate.complete = false;
            if (issue === 'schema') candidate.schema = 2;
            if (issue === 'tree') candidate.tree = 'not-a-tree';
            if (issue === 'missing-metrics') candidate.games[0].metrics = null;
            if (issue === 'missing-tick') delete candidate.games[0].metrics.mined[9000];
            if (issue === 'string-number') candidate.games[0].metrics.mined[9000] = '14000';
            if (issue === 'nan') candidate.games[0].metrics.mined[9000] = NaN;
            if (issue === 'infinity') candidate.games[0].metrics.mined[9000] = Infinity;
            if (issue === 'observed-null') candidate.games[0].metrics.mined[9000] = null;
            if (issue === 'forged-mean') candidate.mean.mined[9000]++;
            if (issue === 'forged-map-mean') candidate.byMap[0].mean.mined[9000]++;
            if (issue === 'forged-observations') candidate.observations.mined[9000]--;
            if (issue === 'forged-map-observations') candidate.byMap[0].observations.mined[9000]--;
            if (issue === 'invalid-patch') candidate.games[0].ecoMap.patches[0].nearestStart = 2;
            if (issue === 'invalid-player') candidate.games[0].player = 1;
            if (issue === 'forged-survived') candidate.games[0].metrics.survived = false;
            if (issue === 'string-gem-tick') candidate.games[0].metrics.firstGemMinerTick = '4500';
            const result = judgeEconomy(candidate, gateReport(10000, 10000));
            expect(result.valid).toBe(false); expect(result.pass).toBe(false);
            expect(() => validateEcoReport(candidate)).toThrow();
        });
    test('standalone CLI distinguishes synthetic pass, failed gates and invalid files with exit 0/1/2', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'league-eco-gate-fixture-'));
        try {
            const candidatePath = join(directory, 'candidate.json'), baselinePath = join(directory, 'baseline.json');
            await writeFile(baselinePath, JSON.stringify(gateReport(10000, 10000)));
            for (const [report, expectedCode] of [[gateReport(), 0], [gateReport(12900), 1], [{ ...gateReport(), valid: false }, 2]] as const) {
                await writeFile(candidatePath, JSON.stringify(report));
                const child = Bun.spawn([process.execPath, 'e2e/league/ecoGate.ts', '--candidate', candidatePath, '--baseline', baselinePath],
                    { cwd: join(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe' });
                const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
                expect(code).toBe(expectedCode);
                expect(stdout).toContain(expectedCode === 2 ? '无效原因' : `K1: ${expectedCode === 0 ? 'PASS' : 'FAIL'}`);
            }
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
    test('the comparison includes original means, ratios, participation and all gate results without mutating input', () => {
        const candidate = gateReport(), baseline = gateReport(10000, 10000), before = JSON.stringify([candidate, baseline]);
        const result = judgeEconomy(candidate, baseline), markdown = ecoGateMarkdown(result);
        expect(result.table).toHaveLength(8); expect(result.table[0].ratios).toEqual({ mined7200: 1.3, mined9000: 1.4 });
        expect(markdown).toContain('10000.00 → 13000.00 (1.30×)');
        expect(markdown).toContain('10000.00 → 14000.00 (1.40×)');
        expect(markdown).toContain('全部');
        for (const gate of ['K1', 'K2', 'K3', 'K4', 'K5']) expect(markdown).toContain(`${gate}: PASS`);
        expect(JSON.stringify([candidate, baseline])).toBe(before);
    });
});

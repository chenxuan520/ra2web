import { describe, expect, test } from 'bun:test';
import { findPatches, patchDistance, nearestPatch, measureEconomy, summarizeEconomy,
    ECO_TICKS, type ResourceTile, type EcoMap, type EcoMatch, type EcoGame } from '../../../e2e/league/ecoCore';
import { ecoJobs, ecoBenchmarkCommand, reportEcoGames } from '../../../e2e/league/ecoTrial';
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

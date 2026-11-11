import { describe, expect, test } from 'bun:test';
import { diagnoseGame, summarizeWeaknesses, weaknessMarkdown, type Sample, type DiagnosedGame } from '../../../e2e/league/diagnoseCore';
import { pairingJobs, type LeagueGame } from '../../../e2e/league/schedule';

function game(result: LeagueGame['result'] = 'b-win', ticks = 15000): LeagueGame {
    const job = pairingJobs('x', 'c3', 3, 'dev')[0];
    return { round: 3, kind: 'dev', a: 'x', b: 'c3', aTree: 'a'.repeat(40), bTree: 'b'.repeat(40), map: job.map,
        seed: job.seed, aCountry: 'Americans', bCountry: 'Russians', swapped: false, result,
        reason: result === 'timeout' ? 'tick-limit' : 'engine-victory-conditions', ticks };
}
function sample(tick: number, own = {}, opponent = {}): Sample {
    const base = { army: 6, harvesters: 2, buildings: 5, assetValue: 1000, creditsSpent: 1000 };
    return { tick, players: [{ ...base, ...own }, { ...base, ...opponent }] };
}
const diagnosis = (samples: Sample[], result: LeagueGame['result'] = 'b-win', ticks = 15000) => diagnoseGame(game(result, ticks), 'x', samples)!;

describe('league weakness diagnosis', () => {
    test('cannot-finish is a timeout with at least a 1.5 asset lead', () => {
        expect(diagnosis([sample(0), sample(27000, { assetValue: 1500 })], 'timeout', 27000).label).toBe('cannot-finish');
    });
    test('stalemate is a timeout with assets within the inclusive 1.5 ratio', () => {
        expect(diagnosis([sample(0), sample(27000, {}, { assetValue: 1500 })], 'timeout', 27000).label).toBe('stalemate');
    });
    test('slow-loss is a timeout with the opponent outside the balanced asset range', () => {
        expect(diagnosis([sample(0), sample(27000, {}, { assetValue: 1600 })], 'timeout', 27000).label).toBe('slow-loss');
    });
    test('early-overrun takes precedence over economic and army losses before tick 9000', () => {
        expect(diagnosis([sample(0), sample(8100, { harvesters: 0, army: 1 })], 'b-win', 8100).label).toBe('early-overrun');
    });
    test('eco-starved needs a previously living harvester and a zero before tick 12000', () => {
        const result = diagnosis([sample(0, { harvesters: 0 }), sample(900, { harvesters: 2 }), sample(1800, { harvesters: 0 }), sample(2700, { harvesters: 0 })]);
        expect(result.harvesterZeroTick).toBe(1800); expect(result.label).toBe('eco-starved');
        expect(diagnosis([sample(0, { harvesters: 0 }), sample(900, { harvesters: 0 })]).harvesterZeroTick).toBeNull();
        expect(diagnosis([sample(0), sample(12000, { harvesters: 0 })]).label).toBe('other');
    });
    test('army-wipe retains both armies immediately before the first collapse', () => {
        const result = diagnosis([sample(0, { army: 8 }, { army: 7 }), sample(900, { army: 4 }), sample(1800, { army: 1 })]);
        expect(result.label).toBe('army-wipe'); expect(result.collapseTick).toBe(900);
        expect(result.armyBeforeCollapse).toEqual({ own: 8, opponent: 7 });
    });
    test.each([[4, 2, 900], [3, 1, null], [8, 5, null]] as const)('collapse %s to %s has tick %s', (before, after, tick) => {
        expect(diagnosis([sample(0, { army: before }), sample(900, { army: after })]).collapseTick).toBe(tick);
    });
    test('outproduced uses final cumulative spending and accepts the 1.3 boundary', () => {
        const result = diagnosis([sample(0), sample(900, {}, { creditsSpent: 1300 })]);
        expect(result.spentRatio).toBe(1.3); expect(result.label).toBe('outproduced');
        expect(diagnosis([sample(0, { creditsSpent: 0 })]).spentRatio).toBe(99);
    });
    test('other covers remaining losses including tick 9000 exactly', () => {
        expect(diagnosis([sample(0), sample(900)], 'b-win', 9000).label).toBe('other');
    });
    test('member b reads players[1] in both physical slot orders', () => {
        for (const swapped of [false, true]) {
            const row = { ...game('a-win'), swapped };
            const result = diagnoseGame(row, 'c3', [sample(0), sample(900, { assetValue: 1600, creditsSpent: 1300 }, { assetValue: 500 })])!;
            expect(result.spentRatio).toBe(1.3); expect(result.finalAssets).toEqual({ own: 500, opponent: 1600 });
            expect(result.opponent).toBe('x'); expect(result.ownCountry).toBe('Russians'); expect(result.opponentCountry).toBe('Americans');
        }
    });
    test('wins, errors and nonparticipating members are not diagnosed as losses', () => {
        expect(diagnoseGame(game('a-win'), 'x', [sample(0)])).toBeNull();
        expect(diagnoseGame(game('error'), 'x', [sample(0)])).toBeNull();
        expect(diagnoseGame(game(), 'v5', [sample(0)])).toBeNull();
    });
    test('missing or invalid telemetry is rejected rather than converted to zero', () => {
        expect(() => diagnoseGame(game(), 'x', [])).toThrow('samples');
        const missing = sample(0); delete (missing.players[0] as any).assetValue;
        expect(() => diagnoseGame(game(), 'x', [missing])).toThrow('assetValue');
        expect(() => diagnoseGame(game(), 'x', [sample(0, { creditsSpent: NaN })])).toThrow('creditsSpent');
        expect(() => diagnoseGame(game(), 'x', [sample(900), sample(0)])).toThrow('tick');
    });
    test('summary ties use label order and then map name, with full map denominators', () => {
        const rows = [game(), { ...game(), map: 'mp11t2' }, game('timeout', 27000), game('a-win'), game('a-win')];
        const records = rows.map((row, index) => {
            const result = diagnoseGame(row, 'x', [sample(0), sample(row.ticks, row.result === 'timeout' ? { assetValue: 1500 } : {})]);
            return result && { ...result, jobId: `job${index}` };
        }).filter((entry): entry is DiagnosedGame => entry !== null);
        const report = summarizeWeaknesses(rows, 'x', records);
        expect(report.weaknesses.map(entry => [entry.id, entry.label, entry.map])).toEqual([
            ['W1', 'cannot-finish', 'mp08t2'], ['W2', 'other', 'mp08t2'], ['W3', 'other', 'mp11t2']]);
        expect(report.weaknesses[0].mapGames).toBe(4); expect(report.weaknesses[0].share).toBe(0.25);
        expect(report.weaknesses[0].collapseTickMedian).toBeNull();
        expect(report.opponents[0]).toMatchObject({ opponent: 'c3', wins: 2, losses: 2, timeouts: 1 });
        expect(report.opponents[0].labels.other).toBe(2);
        const markdown = weaknessMarkdown(report);
        expect(markdown).toContain('## 弱点清单'); expect(markdown).toContain('## 逐对手表'); expect(markdown).toContain('25.0%');
    });
    test('the weakness list contains only the first eight sorted groups', () => {
        const labels = ['cannot-finish', 'early-overrun', 'other'] as const, maps = ['mp08t2', 'mp11t2', 'tn01t2'];
        const rows = Array.from({ length: 9 }, (_, index) => ({ ...game(), map: maps[Math.floor(index / 3)] }));
        const records = rows.map((row, index) => ({ ...diagnoseGame(row, 'x', [sample(0)])!, jobId: `job${index}`, label: labels[index % 3] }));
        const report = summarizeWeaknesses(rows, 'x', records);
        expect(report.weaknesses).toHaveLength(8);
        expect(report.records).toHaveLength(9);
        expect(report.weaknesses.at(-1)).toMatchObject({ id: 'W8', label: 'other', map: 'mp11t2' });
    });
    test('typical games are the first three finishing ticks and medians ignore null', () => {
        const rows = [game('b-win', 17000), game('b-win', 16000), game('b-win', 14000), game('b-win', 15000)];
        const records = rows.map((row, index) => ({ ...diagnoseGame(row, 'x', [sample(0), sample(900, { army: 2 })])!, jobId: `job${index}`, collapseTick: index === 0 ? null : index * 900 }));
        const report = summarizeWeaknesses(rows, 'x', records), weakness = report.weaknesses[0];
        expect(weakness.count).toBe(4); expect(weakness.share).toBe(1);
        expect(weakness.typicalGames.map(entry => entry.jobId)).toEqual(['job2', 'job3', 'job1']);
        expect(weakness.collapseTickMedian).toBe(1800); expect(weakness.harvesterZeroTickMedian).toBeNull();
    });
});

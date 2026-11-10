import { describe, expect, test } from 'bun:test';
import { computeRatings } from '../../../e2e/league/rating';
import { pairingJobs, type LeagueGame } from '../../../e2e/league/schedule';

function games(result: LeagueGame['result']): LeagueGame[] {
    return pairingJobs('m0', 'r4', 1, 'qualify').flatMap(job => [false, true].map(swapped => ({
        round: 1, kind: 'qualify' as const, a: job.a, b: job.b, aTree: 'a'.repeat(40), bTree: 'b'.repeat(40),
        map: job.map, seed: job.seed, aCountry: job.aCountry, bCountry: job.bCountry, swapped, result,
        reason: result === 'timeout' ? 'tick-limit' : 'engine-victory-conditions', ticks: result === 'timeout' ? 27000 : 1000,
    })));
}
describe('Bradley-Terry league ratings', () => {
    test('all wins rank the winner above its opponent', () => {
        const ratings = computeRatings(games('a-win'));
        expect(ratings.m0).toBeGreaterThan(ratings.r4);
        expect(Number.isFinite(ratings.m0)).toBe(true);
    });
    test('all timeouts remain symmetric at 1500', () => {
        expect(computeRatings(games('timeout'))).toEqual({ m0: 1500, r4: 1500 });
    });
    test('error rows are ignored rather than losses or timeouts', () => {
        const valid = games('a-win');
        expect(computeRatings([...valid, ...games('error')])).toEqual(computeRatings(valid));
        expect(computeRatings(games('error'))).toEqual({});
    });
    test('MM updates and output ordering are independent of input row order', () => {
        const input = [...games('a-win'), ...games('b-win')];
        expect(computeRatings([...input].reverse())).toEqual(computeRatings(input));
    });
});

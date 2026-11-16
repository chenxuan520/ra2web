import { describe, expect, test } from 'bun:test';
import { compareVersus, type VersusGame } from '../../../e2e/league/versus';

function pair(a: string, b: string, wins = 16, timeouts = 2): VersusGame[] {
    return Array.from({ length: 24 }, (_, index) => ({
        a, b, result: index < wins ? 'a-win' : index < 24 - timeouts ? 'b-win' : 'timeout',
        ticks: index < wins ? 100 + index : index < 24 - timeouts ? 200 : 27000,
    }));
}
function fixture() {
    const opponents = ['r4', 'x-infantry-01', 'x-harass-01'];
    return { base: opponents.flatMap(opponent => pair('c3', opponent)),
        candidate: [...pair('t', 'c3', 12, 1), ...opponents.flatMap(opponent => pair('t', opponent))] };
}

describe('fixed round-three repair comparison (synthetic game rows)', () => {
    test('complete baseline and candidate pass all five gates without mutating input', () => {
        const f = fixture(), before = JSON.stringify(f), result = compareVersus(f.base, f.candidate);
        expect(result.pass).toBe(true);
        expect(result.gates).toEqual({ V1: true, V2: true, V3: true, V4: true, V5: true });
        expect(result.direct).toEqual({ wins: 12, losses: 11, timeouts: 1, total: 24, winningTickMedian: 105.5 });
        expect(result.total.baseline).toMatchObject({ wins: 48, losses: 18, timeouts: 6, total: 72 });
        expect(result.total.candidate.wins).toBe(48);
        expect(JSON.stringify(f)).toBe(before);
    });
    test('eleven direct wins and twelve losses fail V2', () => {
        const f = fixture(); f.candidate.splice(0, 24, ...pair('t', 'c3', 11, 1));
        const result = compareVersus(f.base, f.candidate);
        expect(result.gates.V1).toBe(true); expect(result.gates.V2).toBe(false); expect(result.pass).toBe(false);
    });
    test('three fewer common-opponent wins pass V3 but four fewer fail', () => {
        const f = fixture(); f.candidate.splice(24, 24, ...pair('t', 'r4', 13));
        expect(compareVersus(f.base, f.candidate).gates.V3).toBe(true);
        f.candidate.splice(24, 24, ...pair('t', 'r4', 12));
        const result = compareVersus(f.base, f.candidate);
        expect(result.gates.V3).toBe(false); expect(result.gates.V4).toBe(true); expect(result.pass).toBe(false);
    });
    test('ninety-five candidate games fail V1', () => {
        const f = fixture(); f.candidate.pop();
        const result = compareVersus(f.base, f.candidate);
        expect(result.candidateGames).toBe(95); expect(result.gates.V1).toBe(false); expect(result.pass).toBe(false);
    });
    test('V4 rejects five fewer wins against one opponent even if the total improves', () => {
        const f = fixture();
        f.candidate.splice(24, 72, ...pair('t', 'r4', 12), ...pair('t', 'x-infantry-01', 19), ...pair('t', 'x-harass-01', 19));
        expect(compareVersus(f.base, f.candidate).gates.V4).toBe(true);
        f.candidate.splice(24, 24, ...pair('t', 'r4', 11));
        const result = compareVersus(f.base, f.candidate);
        expect(result.gates.V3).toBe(true); expect(result.gates.V4).toBe(false);
    });
    test('V5 permits six extra common-opponent timeouts, not seven', () => {
        const f = fixture(); f.candidate.splice(24, 24, ...pair('t', 'r4', 16, 8));
        expect(compareVersus(f.base, f.candidate).gates.V5).toBe(true);
        f.candidate.splice(48, 24, ...pair('t', 'x-infantry-01', 16, 3));
        expect(compareVersus(f.base, f.candidate).gates.V5).toBe(false);
    });
    test.each(['base', 'candidate'] as const)('an error in %s invalidates V1, not a timeout', input => {
        const f = fixture(); f[input][0].result = 'error';
        const result = compareVersus(f.base, f.candidate);
        expect(result.errors[input]).toBe(1); expect(result.gates.V1).toBe(false); expect(result.pass).toBe(false);
    });
    test('the correct total cannot hide a missing opponent or a reversed candidate row', () => {
        const f = fixture(); f.candidate[24].b = 'x-infantry-01';
        expect(compareVersus(f.base, f.candidate).gates.V1).toBe(false);
        const g = fixture(); g.candidate[0].a = 'c3';
        expect(compareVersus(g.base, g.candidate).gates.V1).toBe(false);
    });
    test('no wins have no winning-tick median', () => {
        const f = fixture(); f.candidate.splice(0, 24, ...pair('t', 'c3', 0, 24));
        expect(compareVersus(f.base, f.candidate).direct.winningTickMedian).toBeNull();
    });
});

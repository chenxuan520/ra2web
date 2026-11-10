import { describe, expect, test } from 'bun:test';
import { judgeRound0, judgeExploiter, judgeChampion, championGates, trimHistory, trimExploiters, trimPool, applyDecision, leaderboardMarkdown } from '../../../e2e/league/judge';
import { pairingJobs, type LeagueGame } from '../../../e2e/league/schedule';
import { parseGames, type Stats } from '../../../e2e/league/records';
import type { League, Member } from '../../../e2e/league/registry';

function member(id: string, role: Member['role'] = 'history'): Member {
    return { id, tag: `league/${id}`, tree: ({ orig: 'a', r4: 'b', v0: 'c', m0: 'd' }[id] ?? 'e').repeat(40),
        profile: id === 'orig' ? 'normal' : 'brutal', role, active: true, note: id };
}
function league(): League {
    return { schema: 1, round: 0, champion: 'm0', members: [member('orig'), member('r4'), member('m0', 'champion')] };
}
function pair(a: string, b: string, wins = 14, timeouts = 0, round = 1, ticks = 100): LeagueGame[] {
    let index = 0;
    return pairingJobs(a, b, round, 'qualify').flatMap(job => [false, true].map(swapped => {
        const result = index < wins ? 'a-win' : index < 24 - timeouts ? 'b-win' : 'timeout'; index++;
        return { round, kind: 'qualify' as const, a, b, aTree: member(a).tree, bTree: member(b).tree, map: job.map,
            seed: job.seed, aCountry: job.aCountry, bCountry: job.bCountry, swapped, result,
            reason: result === 'timeout' ? 'tick-limit' : 'engine-victory-conditions', ticks: result === 'timeout' ? 27000 : ticks };
    }));
}
function qualification() {
    const pool = league();
    return { pool, candidate: [...pair('c1', 'orig'), ...pair('c1', 'r4'), ...pair('c1', 'm0', 13)],
        baseline: [...pair('m0', 'orig', 10), ...pair('m0', 'r4', 10)] };
}
function stats(wins: number, total = 100, tick = 100, timeouts = 0): Stats {
    return { wins, losses: total - wins - timeouts, timeouts, total, winTicks: Array.from({ length: wins }, () => tick) };
}
function gates(delta = 5, tick = 100, lead = 1, opponentLoss = 0, timeouts = 0) {
    return championGates(stats(50 + delta, 100, tick, timeouts), stats(50),
        { ...stats(12 + lead, 24), losses: 12 - lead }, [{ opponent: 'r4', candidate: stats(10 - opponentLoss, 24), baseline: stats(10, 24), difference: -opponentLoss }]);
}

describe('league admission gates', () => {
    test('complete candidate strictly meets all champion conditions', () => {
        const f = qualification(), result = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1);
        expect(result.valid).toBe(true); expect(result.pass).toBe(true);
        expect(result.gates).toEqual({ G1: true, G2: true, G3: true, G4: true, G5: true });
    });
    test('G2 rejects four points and accepts five points exactly', () => {
        expect(gates(4).G2).toBe(false); expect(gates(5).G2).toBe(true);
    });
    test('G3 rejects tied direct wins', () => {
        expect(gates(5, 100, 0).G3).toBe(false); expect(gates().G3).toBe(true);
    });
    test('G4 permits minus two but rejects minus three against a single opponent', () => {
        expect(gates(5, 100, 1, 2).G4).toBe(true); expect(gates(5, 100, 1, 3).G4).toBe(false);
    });
    test('G5 permits 1.10 but rejects 1.11 winning median and excess timeouts', () => {
        expect(gates(5, 110).G5).toBe(true); expect(gates(5, 111).G5).toBe(false);
        expect(gates(5, 100, 1, 0, 2).G5).toBe(true); expect(gates(5, 100, 1, 0, 3).G5).toBe(false);
    });
    test('timeouts are zero points in qualification, unlike rating', () => {
        const pool = league(), rows = pair('x-rush-01', 'm0', 7, 17);
        const result = judgeExploiter(pool, 'x-rush-01', 'm0', rows);
        expect(result.valid).toBe(true); expect(result.pass).toBe(false); expect(result.candidate!.wins).toBe(7);
    });
    test('exploiter seven wins fail and eight wins pass', () => {
        expect(judgeExploiter(league(), 'x-rush-01', 'm0', pair('x-rush-01', 'm0', 7)).pass).toBe(false);
        expect(judgeExploiter(league(), 'x-rush-01', 'm0', pair('x-rush-01', 'm0', 8)).pass).toBe(true);
    });
    test('one error makes exploiter qualification invalid', () => {
        const rows = pair('x-rush-01', 'm0', 24); rows[0].result = 'error'; rows[0].reason = 'logged-runtime-errors';
        const result = judgeExploiter(league(), 'x-rush-01', 'm0', rows);
        expect(result.valid).toBe(false); expect(result.pass).toBe(false);
    });
    test.each(['missing', 'duplicate', 'tree', 'round', 'seed', 'error', 'attempt'])( '%s cannot pass champion validity', reason => {
        const f = qualification(); let attempt = 1;
        if (reason === 'missing') f.candidate.pop();
        if (reason === 'duplicate') f.candidate[1] = { ...f.candidate[0] };
        if (reason === 'tree') f.candidate[0].bTree = 'f'.repeat(40);
        if (reason === 'round') f.baseline[0].round = 2;
        if (reason === 'seed') f.candidate[0].seed = 1501;
        if (reason === 'error') { f.baseline[0].result = 'error'; f.baseline[0].reason = 'runtime-error'; }
        if (reason === 'attempt') attempt = 4;
        expect(judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, attempt).valid).toBe(false);
    });
    test('input parsing rejects forged wins and incomplete rows', () => {
        const row = pair('c1', 'm0')[0]; row.reason = 'tick-limit';
        expect(() => parseGames(JSON.stringify(row))).toThrow();
        expect(() => parseGames('{"result":"a-win"}')).toThrow();
    });
});

describe('round zero decisions and write policies', () => {
    function tiedRound(direct = 13) {
        const pool: League = { schema: 1, round: 0, champion: null, members: ['orig', 'r4', 'v0', 'm0'].map(id => member(id)) };
        const side = direct === 13 ? 7 : 8;
        const rows = [...pair('orig', 'r4', 16, 0, 0), ...pair('orig', 'v0', 16, 0, 0), ...pair('orig', 'm0', direct, 0, 0),
            ...pair('r4', 'v0', 12, 0, 0), ...pair('r4', 'm0', side, 0, 0), ...pair('v0', 'm0', side, 0, 0)];
        return { pool, rows };
    }
    test('round0 tie resolves by direct wins before registry position', () => {
        const f = tiedRound(); expect(judgeRound0(f.pool, f.rows).winner).toBe('orig');
    });
    test('still-tied round0 chooses later registry member', () => {
        const f = tiedRound(12); expect(judgeRound0(f.pool, f.rows).winner).toBe('m0');
    });
    test('round0 missing pair is invalid', () => {
        const f = tiedRound(); f.rows.splice(0, 24); expect(judgeRound0(f.pool, f.rows).valid).toBe(false);
    });
    test('round0 write retains the winning historical ID and all frozen records', () => {
        const f = tiedRound(12), decision = judgeRound0(f.pool, f.rows);
        const next = applyDecision(f.pool, decision, f.rows, f.rows);
        expect(next.champion).toBe('m0'); expect(next.round).toBe(0);
        expect(next.members.find(member => member.id === 'm0')!.role).toBe('champion');
        expect(next.members.find(member => member.id === 'v0')!.active).toBe(false);
        expect(next.members).toHaveLength(4); expect(f.pool.champion).toBeNull();
    });
    test('repaired c0 is recorded once when it wins round0; unplayed m0 has no fabricated Elo', () => {
        const f = tiedRound(12); f.pool.members[3] = member('c0'); f.pool.members.push({ ...member('m0'), active: false });
        const rows = f.rows.map(game => ({ ...game, ...(game.a === 'm0' ? { a: 'c0', aTree: member('c0').tree } : {}),
            ...(game.b === 'm0' ? { b: 'c0', bTree: member('c0').tree } : {}) }));
        const decision = judgeRound0(f.pool, rows), next = applyDecision(f.pool, decision, rows, rows);
        expect(next.champion).toBe('c0');
        const markdown = leaderboardMarkdown(next, rows);
        expect(markdown.match(/^\| 0 \| c0 \|/gm)).toHaveLength(1);
        expect(markdown).toContain('| m0 | history | 否 | — | 0 | — | — |');
    });
    test('a repaired c0 that never wins round0 is not treated as a former champion', () => {
        const f = tiedRound(); f.pool.members[3] = member('c0'); f.pool.members.push({ ...member('m0'), active: false });
        const rows = f.rows.map(game => ({ ...game, ...(game.a === 'm0' ? { a: 'c0', aTree: member('c0').tree } : {}),
            ...(game.b === 'm0' ? { b: 'c0', bTree: member('c0').tree } : {}) }));
        const decision = judgeRound0(f.pool, rows), next = applyDecision(f.pool, decision, rows, rows);
        expect(next.champion).toBe('orig'); expect(next.members.find(member => member.id === 'c0')!.active).toBe(false);
    });
    test('exploiter write records admission and rejects a previously registered style', () => {
        const pool = league(), rows = pair('x-rush-01', 'm0', 8);
        const decision = judgeExploiter(pool, 'x-rush-01', 'm0', rows);
        const next = applyDecision(pool, decision, rows, rows);
        expect(next.members.at(-1)).toMatchObject({ id: 'x-rush-01', role: 'exploiter', active: true, style: 'rush', target: 'm0', winsVsTarget: 8 });
        const retry = pair('x-rush-02', 'm0', 24), retryDecision = judgeExploiter(next, 'x-rush-02', 'm0', retry);
        expect(() => applyDecision(next, retryDecision, retry, [...rows, ...retry])).toThrow('previously registered exploiter style');
    });
    test('strict history policy keeps protected members and most recent three former champions', () => {
        const pool = league(); pool.champion = 'c5'; pool.members[2].role = 'history';
        pool.members.push(...[1, 2, 3, 4].map(index => member(`c${index}`)), member('c5', 'champion'));
        trimHistory(pool, ['m0', 'c1', 'c2', 'c3', 'c4', 'c5']);
        expect(pool.members.filter(member => member.active).map(member => member.id)).toEqual(['orig', 'r4', 'c2', 'c3', 'c4', 'c5']);
        expect(pool.members).toHaveLength(8);
    });
    test('seventh exploiter deactivates fewest wins, then the oldest member', () => {
        const pool = league();
        const exploiters = Array.from({ length: 7 }, (_, index) => ({ ...member(`x-${String.fromCharCode(97 + index)}-01`, 'exploiter'),
            style: String.fromCharCode(97 + index), target: 'm0', winsVsTarget: index < 2 ? 5 : 8 }));
        pool.members.push(...exploiters); trimExploiters(pool);
        expect(exploiters[0].active).toBe(false); expect(exploiters[1].active).toBe(true);
        expect(pool.members.filter(member => member.role === 'exploiter' && member.active)).toHaveLength(6);
    });
    test('pool capacity never removes orig/r4 or the champion and uses lowest history Elo', () => {
        const pool = league(); pool.members.push(...Array.from({ length: 10 }, (_, index) => member(`v${index}`)));
        trimPool(pool, { orig: 800, r4: 900, v3: 1000 });
        expect(pool.members.find(member => member.id === 'v3')!.active).toBe(false);
        expect(pool.members.filter(member => member.active)).toHaveLength(12);
        expect(pool.members.filter(member => ['orig', 'r4', 'm0'].includes(member.id)).every(member => member.active)).toBe(true);
    });
    test('failed decision never changes the input registry', () => {
        const f = qualification(), decision = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1); decision.pass = false;
        const before = JSON.stringify(f.pool);
        expect(() => applyDecision(f.pool, decision, f.candidate, f.candidate)).toThrow(); expect(JSON.stringify(f.pool)).toBe(before);
    });
    test('champion write updates exploiter target/wins and retains original input', () => {
        const f = qualification(); f.pool.members.push({ ...member('x-rush-01', 'exploiter'), style: 'rush', target: 'm0', winsVsTarget: 8 });
        f.candidate.push(...pair('c1', 'x-rush-01', 15)); f.baseline.push(...pair('m0', 'x-rush-01', 10));
        const decision = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 2);
        const next = applyDecision(f.pool, decision, f.candidate, [...f.candidate, ...f.baseline]);
        expect(next.champion).toBe('c1'); expect(next.round).toBe(1); expect(next.members.find(member => member.id === 'c1')!.attempts).toBe(2);
        expect(next.members.find(member => member.id === 'x-rush-01')!.winsVsTarget).toBe(9);
        expect(next.members.find(member => member.id === 'x-rush-01')!.target).toBe('c1'); expect(f.pool.champion).toBe('m0');
    });
});

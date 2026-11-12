import { describe, expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeRound0, judgeExploiter, judgeChampion, championGates, trimHistory, trimExploiters, trimSparring, trimPool, applyDecision, leaderboardMarkdown } from '../../../e2e/league/judge';
import { pairingJobs, type LeagueGame } from '../../../e2e/league/schedule';
import { parseGames, type Stats } from '../../../e2e/league/records';
import type { League, Member } from '../../../e2e/league/registry';
import { summarizeEconomy, type EcoGame } from '../../../e2e/league/ecoCore';
import { ecoJobs } from '../../../e2e/league/ecoTrial';
import type { EcoReport } from '../../../e2e/league/ecoGate';

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
        baseline: [...pair('m0', 'orig', 10), ...pair('m0', 'r4', 10)],
        history: [...pair('orig', 'r4', 12, 0, 0), ...pair('orig', 'm0', 8, 0, 0), ...pair('r4', 'm0', 8, 0, 0)] };
}
function stats(wins: number, total = 100, tick = 100, timeouts = 0): Stats {
    return { wins, losses: total - wins - timeouts, timeouts, total, winTicks: Array.from({ length: wins }, () => tick) };
}
function gates(delta = 5, tick = 100, lead = 1, opponentLoss = 0, timeouts = 0) {
    return championGates(stats(50 + delta, 100, tick, timeouts), stats(50),
        { ...stats(12 + lead, 24), losses: 12 - lead }, [{ opponent: 'r4', candidate: stats(10 - opponentLoss, 24), baseline: stats(10, 24), difference: -opponentLoss }],
        { fixes: 'map:tn01t2', before: 8, after: 4 });
}

describe('league admission gates', () => {
    test('complete candidate strictly meets all champion conditions', () => {
        const f = qualification(), result = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'map:tn01t2');
        expect(result.valid).toBe(true); expect(result.pass).toBe(true);
        expect(result.gates).toEqual({ G1: true, G2: true, G3: true, G4: true, G5: true, G6: true });
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
    test.each([[11, 0, false], [12, 0, false], [12, 1, true], [13, 0, true]] as const)(
        'exploiter %s wins and %s timeouts require twelve wins and more wins than losses', (wins, timeouts, pass) => {
            const decision = judgeExploiter(league(), 'x-rush-01', 'm0', pair('x-rush-01', 'm0', wins, timeouts));
            expect(decision.valid).toBe(true); expect(decision.pass).toBe(pass);
            expect(decision.gates.winsAtLeastTwelveAndMajority).toBe(pass);
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
        if (reason === 'attempt') attempt = 3;
        expect(judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, attempt, 'map:tn01t2').valid).toBe(false);
    });
    test.each([[11, 8, true], [11, 9, false], [10, 8, false]] as const)(
        'G6 member repair compares %s baseline wins to %s candidate wins', (before, after, pass) => {
            const f = qualification(); f.pool.members.push({ ...member('x-air-01', 'sparring'), style: 'air', target: 'm0', winsVsTarget: 1 });
            f.candidate.push(...pair('c1', 'x-air-01', 24 - after)); f.baseline.push(...pair('m0', 'x-air-01', 24 - before));
            const decision = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'member:x-air-01');
            expect(decision.valid).toBe(true); expect(decision.gates.G6).toBe(pass); expect(decision.pass).toBe(pass);
            expect(decision.repair).toEqual({ fixes: 'member:x-air-01', before, after });
            expect(['G1', 'G2', 'G3', 'G4', 'G5'].every(gate => decision.gates[gate])).toBe(true);
        });
    test.each([[4, true], [3, false]] as const)('G6 map repair needs four fewer common-opponent non-wins, not %s', (reduction, pass) => {
        const f = qualification();
        for (const [opponent, wins] of [['orig', 4], ['r4', reduction]] as const) {
            f.candidate.filter(game => game.b === opponent && game.map === 'tn01t2').forEach((game, index) => { game.result = index < wins ? 'a-win' : 'b-win'; });
        }
        const decision = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'map:tn01t2');
        expect(decision.valid).toBe(true); expect(decision.gates.G6).toBe(pass); expect(decision.pass).toBe(pass);
        expect(decision.repair).toEqual({ fixes: 'map:tn01t2', before: 12, after: 12 - reduction });
        expect(['G1', 'G2', 'G3', 'G4', 'G5'].every(gate => decision.gates[gate])).toBe(true);
    });
    test.each(['missing', 'inactive', 'history', 'absent', 'off-map', 'malformed'])( '%s repair declarations are invalid', kind => {
        const f = qualification(); const target = { ...member('x-air-01', 'sparring'), style: 'air', target: 'm0', winsVsTarget: 12 };
        f.pool.members.push(target); f.candidate.push(...pair('c1', 'x-air-01', 16)); f.baseline.push(...pair('m0', 'x-air-01', 13));
        let fixes: string | undefined = 'member:x-air-01';
        if (kind === 'missing') fixes = undefined;
        if (kind === 'inactive') { target.active = false; f.candidate.splice(-24); f.baseline.splice(-24); }
        if (kind === 'history') target.role = 'history';
        if (kind === 'absent') fixes = 'member:x-rush-01';
        if (kind === 'off-map') fixes = 'map:tn04t2';
        if (kind === 'malformed') fixes = 'unknown:tn01t2';
        const decision = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, fixes);
        expect(decision.valid).toBe(false); expect(decision.pass).toBe(false);
    });
    test('promotion records the declared repair and recomputes its README retest', () => {
        const f = qualification(), decision = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'map:tn01t2');
        const all = [...f.history, ...f.candidate, ...f.baseline], next = applyDecision(f.pool, decision, f.candidate, all);
        expect(next.members.find(member => member.id === 'c1')).toMatchObject({ fixes: 'map:tn01t2', note: 'round 1; G1-G6 passed' });
        expect(leaderboardMarkdown(next, all)).toContain('| map:tn01t2 | 12 → 4 |');
    });
    test('historical promotions without fixes retain blank repair and retest columns', () => {
        const f = qualification(), decision = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'map:tn01t2');
        const all = [...f.history, ...f.candidate, ...f.baseline], next = applyDecision(f.pool, decision, f.candidate, all);
        delete next.members.find(member => member.id === 'c1')!.fixes;
        expect(leaderboardMarkdown(next, all)).toContain('| 1 | c1 | 58.3% | 41.7% | 1 | — | — |');
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
        const pool = league(), rows = pair('x-rush-01', 'm0', 13);
        const decision = judgeExploiter(pool, 'x-rush-01', 'm0', rows);
        const next = applyDecision(pool, decision, rows, rows);
        expect(next.members.at(-1)).toMatchObject({ id: 'x-rush-01', role: 'exploiter', active: true, style: 'rush', target: 'm0', winsVsTarget: 13 });
        const retry = pair('x-rush-02', 'm0', 24), retryDecision = judgeExploiter(next, 'x-rush-02', 'm0', retry);
        expect(() => applyDecision(next, retryDecision, retry, [...rows, ...retry])).toThrow('previously registered exploiter style');
    });
    test('an existing sparring style cannot be admitted again as an exploiter', () => {
        const pool = league(); pool.members.push({ ...member('x-rush-01', 'sparring'), active: false, style: 'rush', target: 'm0', winsVsTarget: 8 });
        const rows = pair('x-rush-02', 'm0', 13), decision = judgeExploiter(pool, 'x-rush-02', 'm0', rows);
        expect(() => applyDecision(pool, decision, rows, rows)).toThrow('previously registered exploiter style');
    });
    test('README separates exploiters from sparring and retains historical admission scores', () => {
        const pool = league(); pool.members.push({ ...member('x-rush-01', 'sparring'), style: 'rush', target: 'm0', winsVsTarget: 5 });
        const markdown = leaderboardMarkdown(pool, pair('x-rush-01', 'm0', 8));
        const [exploiters, sparring] = markdown.slice(markdown.indexOf('## 找茬者')).split('## 陪练');
        expect(exploiters).not.toContain('| x-rush-01 |');
        expect(sparring).toContain('| x-rush-01 | rush | m0 | 8 | 是 | m0 | 5 |');
    });
    test('strict history policy keeps protected members and most recent three former champions', () => {
        const pool = league(); pool.champion = 'c5'; pool.members[2].role = 'history';
        pool.members.push(...[1, 2, 3, 4].map(index => member(`c${index}`)), member('c5', 'champion'));
        trimHistory(pool, ['m0', 'c1', 'c2', 'c3', 'c4', 'c5']);
        expect(pool.members.filter(member => member.active).map(member => member.id)).toEqual(['r4', 'c2', 'c3', 'c4', 'c5']);
        expect(pool.members).toHaveLength(8);
    });
    test('a blocked former champion is not reactivated and does not consume the recent-history quota', () => {
        const pool = league(); pool.champion = 'c4'; pool.members[2].role = 'history'; pool.members[2].active = false;
        pool.members[2].blockedReason = 'invalid coordinate orders';
        pool.members.push(member('v5'), member('c1'), member('c2'), { ...member('c3'), active: false, blockedReason: 'invalid coordinate orders' }, member('c4', 'champion'));
        trimHistory(pool, ['m0', 'v5', 'c1', 'c2', 'c3', 'c4']);
        expect(pool.members.find(member => member.id === 'm0')!.active).toBe(false);
        expect(pool.members.find(member => member.id === 'c3')!.active).toBe(false);
        expect(pool.members.filter(member => member.active).map(member => member.id)).toEqual(['r4', 'v5', 'c1', 'c2', 'c4']);
    });
    test('safety replacement is disclosed separately without inventing a round-zero victory or upgrade', () => {
        const f = tiedRound(12); f.pool.champion = 'v5'; f.pool.members[3].active = false;
        f.pool.members[3].blockedReason = 'invalid coordinate orders';
        f.pool.members.push({ ...member('v5', 'champion'), replaces: 'm0' });
        const markdown = leaderboardMarkdown(f.pool, f.rows);
        expect(markdown).toContain('| 0 | m0 |'); expect(markdown).not.toContain('| 0 | v5 |');
        expect(markdown).toContain('## 安全基线替换'); expect(markdown).toContain('| v5 | m0 | invalid coordinate orders | 非 G1–G5 晋级 |');
    });
    test('the next actual promotion compares against the safety baseline, not the blocked original', () => {
        const f = tiedRound(12); f.pool.members[2].active = false;
        f.pool.members[3].active = false; f.pool.members[3].blockedReason = 'invalid coordinate orders';
        f.pool.members.push({ ...member('v5', 'champion'), replaces: 'm0' }); f.pool.champion = 'v5';
        const candidate = [...pair('c1', 'orig'), ...pair('c1', 'r4'), ...pair('c1', 'v5', 13)];
        const baseline = [...pair('v5', 'orig', 10), ...pair('v5', 'r4', 10)];
        const decision = judgeChampion(f.pool, 'c1', 'v5', candidate, baseline, 2, 'map:tn01t2');
        expect(decision.pass).toBe(true);
        const all = [...f.rows, ...candidate, ...baseline], next = applyDecision(f.pool, decision, candidate, all);
        expect(next.members.find(member => member.id === 'm0')!.active).toBe(false);
        expect(next.members.find(member => member.id === 'v5')!.active).toBe(true);
        expect(leaderboardMarkdown(next, all)).toContain('| 1 | c1 | 58.3% | 41.7% | 2 | map:tn01t2 | 12 → 4 |');
    });
    test('fifth exploiter demotes fewest wins, then the oldest member, without deactivation', () => {
        const pool = league();
        const exploiters = Array.from({ length: 5 }, (_, index) => ({ ...member(`x-${String.fromCharCode(97 + index)}-01`, 'exploiter'),
            style: String.fromCharCode(97 + index), target: 'm0', winsVsTarget: index < 2 ? 9 : 12 }));
        pool.members.push(...exploiters); trimExploiters(pool);
        expect(exploiters[0].role).toBe('sparring'); expect(exploiters[0].active).toBe(true);
        expect(exploiters[1].role).toBe('exploiter');
        expect(pool.members.filter(member => member.role === 'exploiter' && member.active)).toHaveLength(4);
    });
    test('fifth admitted exploiter demotes the weakest registered exploiter to sparring', () => {
        const pool = league(); pool.members.push(...Array.from({ length: 4 }, (_, index) => ({
            ...member(`x-${String.fromCharCode(97 + index)}-01`, 'exploiter'), style: String.fromCharCode(97 + index), target: 'm0', winsVsTarget: 9 + index })));
        const rows = pair('x-rush-01', 'm0', 13), decision = judgeExploiter(pool, 'x-rush-01', 'm0', rows);
        const next = applyDecision(pool, decision, rows, rows);
        expect(next.members.find(member => member.id === 'x-a-01')).toMatchObject({ role: 'sparring', active: true });
        expect(next.members.find(member => member.id === 'x-rush-01')).toMatchObject({ role: 'exploiter', active: true });
    });
    test('seventh sparring deactivates the fewest wins, then the oldest, retaining identity', () => {
        const pool = league(); const sparring = Array.from({ length: 7 }, (_, index) => ({
            ...member(`x-${String.fromCharCode(97 + index)}-01`, 'sparring'), style: String.fromCharCode(97 + index), target: 'm0', winsVsTarget: index < 2 ? 4 : 8 }));
        pool.members.push(...sparring); trimSparring(pool);
        expect(sparring[0].active).toBe(false); expect(sparring[0].role).toBe('sparring'); expect(sparring[1].active).toBe(true);
        expect(pool.members.filter(member => member.active && member.role === 'sparring')).toHaveLength(6);
        expect(pool.members).toHaveLength(10);
    });
    test('pool capacity protects r4 and the champion but can remove orig by history Elo', () => {
        const pool = league(); pool.members.push(...Array.from({ length: 10 }, (_, index) => member(`v${index}`)));
        trimPool(pool, { orig: 800, r4: 900, v3: 1000 });
        expect(pool.members.find(member => member.id === 'orig')!.active).toBe(false);
        expect(pool.members.filter(member => member.active)).toHaveLength(12);
        expect(pool.members.filter(member => ['r4', 'm0'].includes(member.id)).every(member => member.active)).toBe(true);
    });
    test('pool capacity removes the weakest sparring before the lowest-Elo history', () => {
        const pool = league(); pool.members.push(...Array.from({ length: 9 }, (_, index) => member(`v${index}`)),
            { ...member('x-air-01', 'sparring'), style: 'air', target: 'm0', winsVsTarget: 5 },
            { ...member('x-rush-01', 'sparring'), style: 'rush', target: 'm0', winsVsTarget: 5 });
        trimPool(pool, { orig: 800, v3: 900 });
        expect(pool.members.find(member => member.id === 'x-air-01')!.active).toBe(false);
        expect(pool.members.find(member => member.id === 'x-rush-01')!.active).toBe(false);
        expect(pool.members.find(member => member.id === 'orig')!.active).toBe(true);
        pool.members.push(member('v10')); trimPool(pool, { orig: 800 });
        expect(pool.members.find(member => member.id === 'orig')!.active).toBe(false);
    });
    test('failed decision never changes the input registry', () => {
        const f = qualification(), decision = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'map:tn01t2'); decision.pass = false;
        const before = JSON.stringify(f.pool);
        expect(() => applyDecision(f.pool, decision, f.candidate, f.candidate)).toThrow(); expect(JSON.stringify(f.pool)).toBe(before);
    });
    test.each([[16, 8, 'sparring'], [15, 9, 'exploiter']] as const)(
        'promotion updates both tactic roles and demotes an exploiter with %s candidate wins to %s opponent wins', (wins, opponentWins, role) => {
            const f = qualification();
            f.pool.members.push({ ...member('x-rush-01', 'exploiter'), style: 'rush', target: 'm0', winsVsTarget: 12 },
                { ...member('x-air-01', 'sparring'), style: 'air', target: 'm0', winsVsTarget: 8 });
            f.candidate.push(...pair('c1', 'x-rush-01', wins), ...pair('c1', 'x-air-01', 15));
            f.baseline.push(...pair('m0', 'x-rush-01', 10), ...pair('m0', 'x-air-01', 10));
            const decision = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'map:tn01t2');
            const next = applyDecision(f.pool, decision, f.candidate, [...f.candidate, ...f.baseline]);
            expect(next.members.find(member => member.id === 'x-rush-01')).toMatchObject({ role, target: 'c1', winsVsTarget: opponentWins });
            expect(next.members.find(member => member.id === 'x-air-01')).toMatchObject({ role: 'sparring', target: 'c1', winsVsTarget: 9 });
        });
    test('champion write updates exploiter target/wins and retains original input', () => {
        const f = qualification(); f.pool.members.push({ ...member('x-rush-01', 'exploiter'), style: 'rush', target: 'm0', winsVsTarget: 8 });
        f.candidate.push(...pair('c1', 'x-rush-01', 15)); f.baseline.push(...pair('m0', 'x-rush-01', 10));
        const decision = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 2, 'map:tn01t2');
        const next = applyDecision(f.pool, decision, f.candidate, [...f.candidate, ...f.baseline]);
        expect(next.champion).toBe('c1'); expect(next.round).toBe(1); expect(next.members.find(member => member.id === 'c1')!.attempts).toBe(2);
        expect(next.members.find(member => member.id === 'x-rush-01')!.winsVsTarget).toBe(9);
        expect(next.members.find(member => member.id === 'x-rush-01')!.target).toBe('c1'); expect(f.pool.champion).toBe('m0');
    });
});

// Explicit metric fixtures, not real economic trial results.
function judgeEcoReport(id: string, mined7200: number, mined9000: number): EcoReport {
    const games: EcoGame[] = ecoJobs().flatMap(job => [false, true].map(swapped => ({ jobId: job.id, map: job.map, seed: job.seed,
        country: job.country, swapped, player: 0, result: 'timeout', reason: 'tick-limit', ticks: 9000, error: null,
        ecoMap: { values: { ore: 10, gems: 20 }, patches: [
            { id: '0_0', cx: 0, cy: 0, tiles: 1, value: 20000, gemValue: 20000, isGem: true, regrows: false, nearestStart: 0, distToStart: [10, 50] },
            { id: '20_0', cx: 20, cy: 0, tiles: 1, value: 20000, gemValue: 0, isGem: false, regrows: true, nearestStart: 0, distToStart: [20, 60] },
        ] }, metrics: { mined: { 3600: 3000, 5400: 6000, 7200: mined7200, 9000: mined9000 },
            miners: { 3600: 3, 5400: 4, 7200: 5, 9000: 5 }, refineries: { 3600: 1, 5400: 1, 7200: 2, 9000: 2 },
            factories: { 3600: 1, 5400: 1, 7200: 1, 9000: 1 }, servedPatches: { 3600: 1, 5400: 1, 7200: 2, 9000: 2 },
            gemShare: 0.5, homeGemPatch: true, firstGemMinerTick: 4500, maxMinersOnPatch: 3, survived: true },
    })));
    return { schema: 1, member: id, tree: member(id).tree, games, ...summarizeEconomy(games) };
}

describe('eco champion qualification (synthetic fixtures)', () => {
    test.each(['both', 'candidate', 'baseline'])('missing %s eco data is invalid, not a G6 loss', missing => {
        const f = qualification(), candidate = judgeEcoReport('c1', 13000, 14000), baseline = judgeEcoReport('m0', 10000, 10000);
        const result = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'eco',
            missing === 'both' || missing === 'candidate' ? undefined : candidate,
            missing === 'both' || missing === 'baseline' ? undefined : baseline);
        expect(result.valid).toBe(false); expect(result.pass).toBe(false);
        expect(result.reason).toContain('--eco-candidate and --eco-baseline');
    });
    test.each(['both', 'candidate', 'baseline'])('CLI missing %s eco file parameters exits 2 before reading match files', async missing => {
        const args = ['e2e/league/judge.ts', '--mode', 'champion', '--candidate', 'c6', '--champion', 'c3', '--attempt', '1', '--fixes', 'eco',
            '--candidate-games', 'unused-fixture-candidate.jsonl', '--baseline-games', 'unused-fixture-baseline.jsonl'];
        if (missing === 'candidate') args.push('--eco-baseline', 'unused-fixture-baseline-eco.json');
        if (missing === 'baseline') args.push('--eco-candidate', 'unused-fixture-candidate-eco.json');
        const child = Bun.spawn([process.execPath, ...args], { cwd: `${import.meta.dir}/../../..`, stdout: 'pipe', stderr: 'pipe' });
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
        expect(code).toBe(2); expect(stderr).toContain('--eco-candidate and --eco-baseline');
    });
    test('candidate economy tree must equal the validated candidate-games aTree', () => {
        const f = qualification(), candidate = judgeEcoReport('c1', 13000, 14000), baseline = judgeEcoReport('m0', 10000, 10000);
        candidate.tree = 'f'.repeat(40);
        const result = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'eco', candidate, baseline);
        expect(result.valid).toBe(false); expect(result.pass).toBe(false); expect(result.reason).toContain('tree');
    });
    test.each(['member', 'tree'])('economic baseline must still identify the frozen champion %s', issue => {
        const f = qualification(), candidate = judgeEcoReport('c1', 13000, 14000), baseline = judgeEcoReport('m0', 10000, 10000);
        if (issue === 'member') baseline.member = 'c0'; else baseline.tree = 'f'.repeat(40);
        const result = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'eco', candidate, baseline);
        expect(result.valid).toBe(false); expect(result.pass).toBe(false); expect(result.reason).toContain('baseline');
    });
    test('K1-K5 all true makes G6 true while G1-G5 retain their existing values', () => {
        const f = qualification(), candidate = judgeEcoReport('c1', 13000, 14000), baseline = judgeEcoReport('m0', 10000, 10000);
        const result = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'eco', candidate, baseline);
        expect(result.valid).toBe(true); expect(result.pass).toBe(true);
        expect(result.gates).toEqual({ G1: true, G2: true, G3: true, G4: true, G5: true, G6: true });
        expect(result.eco!.gates).toEqual({ K1: true, K2: true, K3: true, K4: true, K5: true });
        expect(result.repair).toEqual({ fixes: 'eco', before: 10000, after: 14000 });
    });
    test('a valid failed economic gate is a G6 failure, while invalid economic data stays invalid', () => {
        const f = qualification(), candidate = judgeEcoReport('c1', 12900, 14000), baseline = judgeEcoReport('m0', 10000, 10000);
        let result = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'eco', candidate, baseline);
        expect(result.valid).toBe(true); expect(result.pass).toBe(false); expect(result.gates.G6).toBe(false);
        expect(['G1', 'G2', 'G3', 'G4', 'G5'].every(gate => result.gates[gate])).toBe(true);
        candidate.valid = false;
        result = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'eco', candidate, baseline);
        expect(result.valid).toBe(false); expect(result.pass).toBe(false);
    });
    test('eco promotion renders a synchronous README from verified data before any eco-c1 file exists', () => {
        const f = qualification(), candidate = judgeEcoReport('c1', 13000, 14000), baseline = judgeEcoReport('m0', 10000, 10000);
        const decision = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'eco', candidate, baseline);
        const all = [...f.history, ...f.candidate, ...f.baseline], next = applyDecision(f.pool, decision, f.candidate, all);
        expect(next.members.find(member => member.id === 'c1')).toMatchObject({ fixes: 'eco', attempts: 1 });
        const markdown = leaderboardMarkdown(next, all, { c1: { candidate, baseline } });
        expect(typeof markdown).toBe('string'); expect(markdown).toContain('| eco | 10000 → 14000 |');
    });
    test('fixture-only --write archives exact validated bytes and --mode readme rebuilds synchronously without real tags', async () => {
        const root = await mkdtemp(join(tmpdir(), 'league-eco-publish-fixture-'));
        try {
            const project = join(root, 'ts-redalert2'), tools = join(project, 'e2e/league'), docs = join(root, 'docs/ai-league'), bin = join(root, 'bin');
            await Promise.all([mkdir(tools, { recursive: true }), mkdir(docs, { recursive: true }), mkdir(bin)]);
            for (const file of ['judge.ts', 'registry.ts', 'schedule.ts', 'records.ts', 'rating.ts', 'ecoGate.ts', 'ecoCore.ts'])
                await copyFile(join(import.meta.dir, '../../../e2e/league', file), join(tools, file));
            const f = qualification(), candidate = judgeEcoReport('c1', 13000, 14000), baseline = judgeEcoReport('m0', 10000, 10000);
            const candidatePath = join(root, 'candidate-eco.json'), baselinePath = join(docs, 'eco-baseline.json');
            const candidateGamesPath = join(root, 'candidate-games.jsonl'), baselineGamesPath = join(root, 'baseline-games.jsonl');
            const registryText = JSON.stringify(f.pool), historyText = f.history.map(game => JSON.stringify(game)).join('\n') + '\n';
            await Promise.all([writeFile(join(tools, 'league.json'), registryText), writeFile(join(docs, 'results.jsonl'), historyText),
                writeFile(baselinePath, JSON.stringify(baseline)), writeFile(candidateGamesPath, f.candidate.map(game => JSON.stringify(game)).join('\n')),
                writeFile(baselineGamesPath, f.baseline.map(game => JSON.stringify(game)).join('\n'))]);
            const trees = Object.fromEntries([...f.pool.members, member('c1')].map(member => [member.id, member.tree]));
            // Inject only fixture git-query responses; this never creates a repository, commit or tag.
            const fakeGit = join(bin, 'git');
            await writeFile(fakeGit, `#!/usr/bin/env bun\nconst args = process.argv.slice(2), ref = args.at(-1), trees = ${JSON.stringify(trees)};\nif (args[0] === 'cat-file' && args[1] === '-e') process.exit(0);\nif (args[0] !== 'rev-parse') throw new Error('Unexpected fixture git query');\nif (ref.endsWith('^{commit}')) console.log('b'.repeat(40));\nelse { const id = /^league\\/([^:]+):/.exec(ref)?.[1]; if (!trees[id]) throw new Error('Unknown fixture tree'); console.log(trees[id]); }\n`);
            await chmod(fakeGit, 0o755);
            const run = async (args: string[]) => {
                const child = Bun.spawn([process.execPath, join(tools, 'judge.ts'), ...args], { cwd: project,
                    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe' });
                const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
                return { code, stdout, stderr };
            };
            const args = ['--mode', 'champion', '--candidate', 'c1', '--champion', 'm0', '--attempt', '1', '--fixes', 'eco', '--write',
                '--candidate-games', candidateGamesPath, '--baseline-games', baselineGamesPath, '--eco-candidate', candidatePath, '--eco-baseline', baselinePath];
            await writeFile(candidatePath, JSON.stringify({ ...candidate, tree: 'f'.repeat(40) }));
            const invalid = await run(args);
            expect(invalid.code).toBe(2); expect(invalid.stdout).toContain('tree');
            expect(await readFile(join(tools, 'league.json'), 'utf8')).toBe(registryText);
            expect(await readFile(join(docs, 'results.jsonl'), 'utf8')).toBe(historyText);
            expect(await Bun.file(join(docs, 'eco-c1.json')).exists()).toBe(false);
            const candidateText = JSON.stringify(candidate, null, 4) + '\n\n';
            await writeFile(candidatePath, candidateText);
            const written = await run(args);
            expect(written.stderr).toBe(''); expect(written.code).toBe(0);
            expect(await readFile(join(docs, 'eco-c1.json'), 'utf8')).toBe(candidateText);
            const markdown = await readFile(join(docs, 'README.md'), 'utf8');
            expect(markdown).toContain('| eco | 10000 → 14000 |');
            const rebuilt = await run(['--mode', 'readme']);
            expect(rebuilt.stderr).toBe(''); expect(rebuilt.code).toBe(0);
            expect(await readFile(join(docs, 'README.md'), 'utf8')).toBe(markdown);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    test('legacy map qualification ignores appended eco inputs and keeps its original semantics', () => {
        const f = qualification();
        const original = judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'map:tn01t2');
        expect(judgeChampion(f.pool, 'c1', 'm0', f.candidate, f.baseline, 1, 'map:tn01t2', { invalid: true }, null)).toEqual(original);
    });
});

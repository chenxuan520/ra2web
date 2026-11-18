import { expect, test } from 'bun:test';
import { economicGate, judgePromotion, promotedLeague, validPromotion, type PromotionPlan } from '../../../e2e/league/p4/promoteCore';
import { holdoutJobs, TRAIN_OPPONENTS, HOLDOUT_OPPONENTS, type ArenaJob } from '../../../e2e/league/p4/arena';
import { BUILTIN, validateLeague, type League } from '../../../e2e/league/registry';
import type { ArenaGame } from '../../../e2e/league/p4/play';

function plan(): PromotionPlan {
    const champion = 'c9', opponents = [...TRAIN_OPPONENTS, ...HOLDOUT_OPPONENTS];
    const jobs = [...[champion, ...opponents].flatMap(b => holdoutJobs('cand', b, 1)), ...opponents.flatMap(b => holdoutJobs(champion, b, 1))];
    return { promotion: 1, champion, candidate: '1'.repeat(40), candidateTree: 'a'.repeat(40), championTree: 'b'.repeat(40), baseCommit: '2'.repeat(40), jobs,
        trees: { cand: 'a'.repeat(40), ...Object.fromEntries([champion, ...opponents].map(id => [id, 'b'.repeat(40)])) }, run: 90 };
}
function row(job: ArenaJob, swapped = false, result: ArenaGame['result'] = 'a-win', ticks = 10000): ArenaGame {
    return { stage: 'holdout', run: null, generation: null, promotion: 1, a: job.a, b: job.b, aTree: job.a === 'cand' ? 'a'.repeat(40) : 'b'.repeat(40), bTree: 'b'.repeat(40),
        map: job.map, seed: job.seed, aCountry: job.aCountry, bCountry: job.bCountry, swapped, result, reason: result === 'timeout' ? 'tick-limit' : 'engine-victory-conditions', ticks: result === 'timeout' ? 27000 : ticks };
}
function series(a: string, b: string, wins: number, losses: number, timeouts = 0, ticks = 10000): ArenaGame[] {
    const job = holdoutJobs(a, b, 1)[0];
    return [...Array.from({ length: wins }, () => row(job, false, 'a-win', ticks)), ...Array.from({ length: losses }, () => row(job, false, 'b-win', ticks)),
        ...Array.from({ length: timeouts }, () => row(job, false, 'timeout'))];
}
const judge = (games: ArenaGame[]) => judgePromotion(games, plan(), null, null);
test('H1 requires all 1104 planned rows, no errors, no early stop and immutable identities', () => {
    const p = plan(), games = p.jobs.flatMap(job => [row(job), row(job, true)]);
    expect(games).toHaveLength(1104); expect(validPromotion(games, p)).toBe(true);
    expect(validPromotion(games.slice(1), p)).toBe(false);
    for (const kind of ['error', 'early', 'tree', 'duplicate']) {
        const bad = games.map(game => ({ ...game }));
        if (kind === 'error') bad[0].result = 'error';
        if (kind === 'early') bad[0].reason = 'value-model-early-stop';
        if (kind === 'tree') bad[0].aTree = 'x'.repeat(40);
        if (kind === 'duplicate') bad[1103] = bad[0];
        expect(validPromotion(bad, p)).toBe(false);
    }
});
test('H2 exact overall and holdout-opponent percentage boundaries', () => {
    const games = (trainWins: number, holdWins: number) => [...series('cand', TRAIN_OPPONENTS[0], trainWins, 1000 - trainWins),
        ...series('cand', HOLDOUT_OPPONENTS[0], holdWins, 1000 - holdWins), ...series('c9', TRAIN_OPPONENTS[0], 200, 800), ...series('c9', HOLDOUT_OPPONENTS[0], 200, 800)];
    expect(judge(games(249, 249)).gates.H2).toBe(false); expect(judge(games(250, 250)).gates.H2).toBe(true);
    expect(judge(games(281, 219)).gates.H2).toBe(false); expect(judge(games(280, 220)).gates.H2).toBe(true);
});
test('H3 net four loses and net five passes', () => {
    expect(judge(series('cand', 'c9', 26, 22)).gates.H3).toBe(false);
    expect(judge(series('cand', 'c9', 26, 21, 1)).gates.H3).toBe(true);
});
test('H4 each opponent may lose four wins but not five', () => {
    const baseline = series('c9', TRAIN_OPPONENTS[0], 20, 28);
    expect(judge([...baseline, ...series('cand', TRAIN_OPPONENTS[0], 15, 33)]).gates.H4).toBe(false);
    expect(judge([...baseline, ...series('cand', TRAIN_OPPONENTS[0], 16, 32)]).gates.H4).toBe(true);
});
test('H5 median and timeout boundaries are exact', () => {
    const baseline = series('c9', TRAIN_OPPONENTS[0], 1, 0, 0, 10000);
    expect(judge([...baseline, ...series('cand', TRAIN_OPPONENTS[0], 1, 0, 0, 10600)]).gates.H5).toBe(false);
    expect(judge([...baseline, ...series('cand', TRAIN_OPPONENTS[0], 1, 0, 0, 10500)]).gates.H5).toBe(true);
    expect(judge([...baseline, ...series('cand', TRAIN_OPPONENTS[0], 1, 0, 6, 10000)]).gates.H5).toBe(false);
    expect(judge([...baseline, ...series('cand', TRAIN_OPPONENTS[0], 1, 0, 5, 10000)]).gates.H5).toBe(true);
});
test('H6 uses valid K1/K2 only, never K3-K5', () => {
    const economy: any = { valid: true, gates: { K1: true, K2: true, K3: false, K4: false, K5: false } };
    expect(economicGate(economy)).toBe(true); economy.gates.K1 = false; expect(economicGate(economy)).toBe(false);
    economy.gates.K1 = true; economy.valid = false; expect(economicGate(economy)).toBe(false);
});
test('promotion appends the new champion, rotates training and deactivates the removed opponent', async () => {
    const league: League = await Bun.file(new URL('../../../e2e/league/league.json', import.meta.url)).json();
    const next = `c${Number(league.champion!.slice(1)) + 1}`, adopted = promotedLeague(league, next, 'f'.repeat(40), 1, TRAIN_OPPONENTS);
    expect(adopted.training).toEqual([...TRAIN_OPPONENTS.slice(1), league.champion]);
    expect(adopted.league.champion).toBe(next); expect(adopted.league.members.find(member => member.id === TRAIN_OPPONENTS[0])?.active).toBe(false);
    expect(adopted.league.members.find(member => member.id === league.champion)?.role).toBe('history');
    const query = (args: readonly string[]) => args[0] === 'cat-file' ? '' : args.at(-1)!.includes(`:${BUILTIN}`)
        ? adopted.league.members.find(member => args.at(-1) === `${member.tag}:${BUILTIN}`)!.tree : '1'.repeat(40);
    expect((await validateLeague(adopted.league, query)).champion).toBe(next);
});

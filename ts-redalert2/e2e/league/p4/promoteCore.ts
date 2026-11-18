import type { League } from '../registry';
import { median } from '../records';
import { judgeEconomy, type EcoGateDecision } from '../ecoGate';
import { jobId, TRAIN_OPPONENTS, HOLDOUT_OPPONENTS, HOLDOUT_MAPS, type ArenaJob } from './arena';
import type { ArenaGame } from './play';

export interface PromotionPlan {
    promotion: number; champion: string; candidate: string; candidateTree: string; championTree: string;
    baseCommit: string; jobs: ArenaJob[]; trees: Record<string, string>; run: number | null;
}
export interface MatchStats { wins: number; losses: number; timeouts: number; total: number; winMedian: number | null; winTicks: number[] }
export function stats(games: readonly ArenaGame[]): MatchStats {
    const winTicks = games.filter(game => game.result === 'a-win').map(game => game.ticks);
    return { wins: winTicks.length, losses: games.filter(game => game.result === 'b-win').length,
        timeouts: games.filter(game => game.result === 'timeout').length, total: games.length, winMedian: median(winTicks), winTicks };
}
export function validPromotion(games: readonly ArenaGame[], plan: PromotionPlan): boolean {
    const expected = new Map<string, ArenaJob>(plan.jobs.flatMap(job => [false, true].map(swapped => [`${job.id}#${swapped}`, job] as const)));
    const seen = new Set<string>();
    if (games.length !== plan.jobs.length * 2) return false;
    for (const game of games) {
        const key = `${jobId(game)}#${game.swapped}`, job = expected.get(key);
        if (!job || seen.has(key) || game.stage !== 'holdout' || game.run !== null || game.generation !== null || game.promotion !== plan.promotion ||
            game.aTree !== plan.trees[game.a] || game.bTree !== plan.trees[game.b] || game.result === 'error' || game.reason === 'value-model-early-stop' ||
            !['a-win', 'b-win', 'timeout'].includes(game.result) || !Number.isSafeInteger(game.ticks) || game.ticks < 1 || game.ticks > 27000 ||
            (game.result === 'timeout' ? game.reason !== 'engine-victory-conditions' && !(game.reason === 'tick-limit' && game.ticks === 27000) : game.reason !== 'engine-victory-conditions')) return false;
        seen.add(key);
    }
    return true;
}
export const economicGate = (economy: EcoGateDecision) => economy.valid && economy.gates.K1 && economy.gates.K2;
const rate = (stat: MatchStats) => stat.total ? stat.wins / stat.total : 0;
// Integer cross-products implement the exact percentage gates without rounding displayed rates.
const improves = (a: MatchStats, b: MatchStats, points: number) => a.total > 0 && b.total > 0 &&
    a.wins * b.total * 100 >= b.wins * a.total * 100 + points * a.total * b.total;
export function judgePromotion(games: readonly ArenaGame[], plan: PromotionPlan, ecoCandidate: unknown, ecoBaseline: unknown) {
    const opponents = [...TRAIN_OPPONENTS, ...HOLDOUT_OPPONENTS];
    const candidateRows = games.filter(game => game.a === 'cand' && opponents.includes(game.b));
    const baselineRows = games.filter(game => game.a === plan.champion && opponents.includes(game.b));
    const candidate = stats(candidateRows), baseline = stats(baselineRows);
    const holdCandidate = stats(candidateRows.filter(game => HOLDOUT_OPPONENTS.includes(game.b)));
    const holdBaseline = stats(baselineRows.filter(game => HOLDOUT_OPPONENTS.includes(game.b)));
    const trainCandidate = stats(candidateRows.filter(game => TRAIN_OPPONENTS.includes(game.b)));
    const trainBaseline = stats(baselineRows.filter(game => TRAIN_OPPONENTS.includes(game.b)));
    const direct = stats(games.filter(game => game.a === 'cand' && game.b === plan.champion));
    const byOpponent = opponents.map(opponent => {
        const cand = stats(candidateRows.filter(game => game.b === opponent)), base = stats(baselineRows.filter(game => game.b === opponent));
        return { opponent, group: HOLDOUT_OPPONENTS.includes(opponent) ? 'holdout' : 'train', candidate: cand, baseline: base, deltaWins: cand.wins - base.wins };
    });
    const byMap = HOLDOUT_MAPS.map(map => ({ map, candidate: stats(candidateRows.filter(game => game.map === map)),
        baseline: stats(baselineRows.filter(game => game.map === map)), direct: stats(games.filter(game => game.a === 'cand' && game.b === plan.champion && game.map === map)) }));
    const economy: EcoGateDecision = judgeEconomy(ecoCandidate, ecoBaseline);
    const gates = { H1: validPromotion(games, plan), H2: improves(candidate, baseline, 5) && improves(holdCandidate, holdBaseline, 2),
        H3: direct.wins - direct.losses >= 5, H4: byOpponent.every(row => row.deltaWins >= -4),
        H5: candidate.winMedian !== null && baseline.winMedian !== null && candidate.winMedian * 20 <= baseline.winMedian * 21 && candidate.timeouts <= baseline.timeouts + 5,
        H6: economicGate(economy) };
    return { promotion: plan.promotion, champion: plan.champion, candidateCommit: plan.candidate, run: plan.run, pass: Object.values(gates).every(Boolean), gates,
        expectedGames: plan.jobs.length * 2, games: games.length, candidate, baseline, direct, economy, byOpponent, byMap,
        rates: { candidate: rate(candidate), baseline: rate(baseline), overallDelta: rate(candidate) - rate(baseline),
            trainDelta: rate(trainCandidate) - rate(trainBaseline), holdoutDelta: rate(holdCandidate) - rate(holdBaseline) } };
}
export type PromotionDecision = ReturnType<typeof judgePromotion>;
export function promotionMarkdown(decision: PromotionDecision): string {
    const count = (stat: MatchStats) => `${stat.wins}/${stat.losses}/${stat.timeouts}`;
    const lines = ['# P4 promotion ' + decision.promotion, '', ...Object.entries(decision.gates).map(([gate, pass]) => `${gate}: ${pass ? 'PASS' : 'FAIL'}`), '',
        `Overall delta: ${decision.rates.overallDelta.toFixed(6)}; train opponents: ${decision.rates.trainDelta.toFixed(6)}; holdout opponents: ${decision.rates.holdoutDelta.toFixed(6)}`,
        `Direct net wins: ${decision.direct.wins - decision.direct.losses}; win median: ${decision.baseline.winMedian} -> ${decision.candidate.winMedian}; timeouts: ${decision.baseline.timeouts} -> ${decision.candidate.timeouts}`, '',
        '| Opponent | Pool | Candidate W/L/T | Champion W/L/T | Delta wins |', '| --- | --- | --- | --- | ---: |',
        ...decision.byOpponent.map(row => `| ${row.opponent} | ${row.group} | ${count(row.candidate)} | ${count(row.baseline)} | ${row.deltaWins} |`), '',
        '| Map | Candidate W/L/T | Champion W/L/T | Direct W/L/T |', '| --- | --- | --- | --- |',
        ...decision.byMap.map(row => `| ${row.map} | ${count(row.candidate)} | ${count(row.baseline)} | ${count(row.direct)} |`), ''];
    return lines.join('\n');
}
export function promotedLeague(league: League, nextId: string, tree: string, promotion: number, trainOpponents: readonly string[]) {
    const previous = league.champion!;
    const training = [...trainOpponents.slice(1), previous], removed = trainOpponents[0];
    const updated: League = structuredClone(league);
    updated.champion = nextId; updated.round = Number(nextId.slice(1));
    updated.members.find(member => member.id === previous)!.role = 'history';
    updated.members.find(member => member.id === removed)!.active = false;
    updated.members.push({ id: nextId, tag: `league/${nextId}`, tree, profile: 'brutal', role: 'champion', active: true,
        note: `p4 promotion ${promotion}; H1-H6 passed` });
    return { league: updated, training, removed };
}

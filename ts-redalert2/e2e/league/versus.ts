import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { median, parseGames } from './records';
import type { LeagueGame } from './schedule';

export type VersusGame = Pick<LeagueGame, 'a' | 'b' | 'result' | 'ticks'>;
const opponents = ['r4', 'x-infantry-01', 'x-harass-01'];
function summarize(games: readonly VersusGame[]) {
    const wins = games.filter(game => game.result === 'a-win');
    return { wins: wins.length, losses: games.filter(game => game.result === 'b-win').length,
        timeouts: games.filter(game => game.result === 'timeout').length, total: games.length,
        winningTickMedian: median(wins.map(game => game.ticks)) };
}

/** Compare a fixed 72-game c3 baseline and a 96-game candidate; wins always belong to side a. */
export function compareVersus(base: readonly VersusGame[], candidate: readonly VersusGame[]) {
    const candidateId = candidate[0]?.a;
    const direct = summarize(candidate.filter(game => game.b === 'c3'));
    const table = opponents.map(opponent => ({ opponent,
        candidate: summarize(candidate.filter(game => game.b === opponent)),
        baseline: summarize(base.filter(game => game.b === opponent)) }));
    const total = { candidate: summarize(candidate.filter(game => opponents.includes(game.b))), baseline: summarize(base) };
    const errors = { base: base.filter(game => game.result === 'error').length,
        candidate: candidate.filter(game => game.result === 'error').length };
    const gates = {
        V1: base.length === 72 && candidate.length === 96 && errors.base === 0 && errors.candidate === 0 &&
            base.every(game => game.a === 'c3' && opponents.includes(game.b)) &&
            !!candidateId && candidateId !== 'c3' && candidate.every(game => game.a === candidateId && (game.b === 'c3' || opponents.includes(game.b))) &&
            direct.total === 24 && table.every(row => row.baseline.total === 24 && row.candidate.total === 24),
        V2: direct.wins >= direct.losses,
        V3: total.candidate.wins >= total.baseline.wins - 3,
        V4: table.every(row => row.candidate.wins >= row.baseline.wins - 4),
        V5: total.candidate.timeouts <= total.baseline.timeouts + 6,
    };
    return { baseGames: base.length, candidateGames: candidate.length, errors, direct, table, total,
        gates, pass: Object.values(gates).every(Boolean) };
}

function markdown(result: ReturnType<typeof compareVersus>) {
    const score = (stats: ReturnType<typeof summarize>) => `${stats.wins}／${stats.losses}／${stats.timeouts}`;
    const tick = (stats: ReturnType<typeof summarize>) => stats.winningTickMedian ?? '—';
    const lines = ['| 对手 | 候选胜／负／超时 | 获胜 tick 中位数 | c3 基线胜／负／超时 | 获胜 tick 中位数 |',
        '| --- | ---: | ---: | ---: | ---: |', `| c3（直接对打） | ${score(result.direct)} | ${tick(result.direct)} | — | — |`];
    for (const row of result.table) lines.push(`| ${row.opponent} | ${score(row.candidate)} | ${tick(row.candidate)} | ${score(row.baseline)} | ${tick(row.baseline)} |`);
    lines.push(`| 三个对手合计 | ${score(result.total.candidate)} | ${tick(result.total.candidate)} | ${score(result.total.baseline)} | ${tick(result.total.baseline)} |`, '');
    const values = {
        V1: `基线 ${result.baseGames}/72，候选 ${result.candidateGames}/96，error ${result.errors.base}＋${result.errors.candidate}；每个对手各24局，a 方身份一致`,
        V2: `${result.direct.wins} 胜 ≥ ${result.direct.losses} 负`,
        V3: `${result.total.candidate.wins} 胜 ≥ ${result.total.baseline.wins} − 3 = ${result.total.baseline.wins - 3}`,
        V4: result.table.map(row => `${row.opponent}: ${row.candidate.wins} ≥ ${row.baseline.wins} − 4 = ${row.baseline.wins - 4}`).join('；'),
        V5: `${result.total.candidate.timeouts} 超时 ≤ ${result.total.baseline.timeouts} ＋ 6 = ${result.total.baseline.timeouts + 6}`,
    };
    for (const gate of Object.keys(result.gates) as (keyof typeof result.gates)[])
        lines.push(`${gate}: ${result.gates[gate] ? 'PASS' : 'FAIL'} — ${values[gate]}`);
    lines.push('', `全部通过: ${result.pass ? 'PASS' : 'FAIL'}`);
    return lines.join('\n');
}
export async function main() {
    const { values } = parseArgs({ options: { base: { type: 'string' }, candidate: { type: 'string' } } });
    if (!values.base || !values.candidate) throw new Error('Usage: bun e2e/league/versus.ts --base DIR --candidate DIR');
    const result = compareVersus(parseGames(await Bun.file(join(values.base, 'games.jsonl')).text()),
        parseGames(await Bun.file(join(values.candidate, 'games.jsonl')).text()));
    console.log(markdown(result));
    process.exitCode = result.pass ? 0 : 1;
}
if (import.meta.main) {
    try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadLeague, validateLeague, LEAGUE_PATH, REPO_ROOT, type League } from './registry';
import { mapsForRound, pairingJobs, roundRobinJobs, compareGames, type LeagueGame } from './schedule';
import { parseGames, validateSchedule, statsFor, median, gameKey, type Stats } from './records';
import { computeRatings } from './rating';
import { judgeEconomy, validateEcoReport, type EcoReport, type EcoGateDecision, type EcoRetestFiles } from './ecoGate';

export type Mode = 'round0' | 'exploiter' | 'champion';
export interface OpponentScore { opponent: string; candidate: Stats; baseline: Stats | null; difference: number | null }
export interface RepairRetest { fixes: string; before: number; after: number }
export interface Decision {
    mode: Mode;
    valid: boolean;
    pass: boolean;
    round: number;
    id?: string;
    target?: string;
    winner?: string;
    attempt?: number;
    fixes?: string;
    repair?: RepairRetest;
    gates: Record<string, boolean>;
    table: OpponentScore[];
    reason?: string;
    candidate?: Stats;
    baseline?: Stats;
    direct?: Stats;
    eco?: EcoGateDecision;
}
function invalid(mode: Mode, error: unknown): Decision {
    return { mode, valid: false, pass: false, round: -1, gates: { G1: false }, table: [], reason: error instanceof Error ? error.message : String(error) };
}
export function initialWinner(league: League, games: readonly LeagueGame[]): string {
    const ids = league.members.filter(member => member.active).map(member => member.id);
    const rates = ids.map(id => ({ id, stats: statsFor(games, id) }));
    const best = Math.max(...rates.map(entry => entry.stats.wins / entry.stats.total));
    const tied = rates.filter(entry => entry.stats.wins / entry.stats.total === best).map(entry => entry.id);
    // For a two-way tie this is direct head-to-head; larger ties use the tied-group mini-league.
    return tied.sort((a, b) => statsFor(games, b, tied.filter(id => id !== b)).wins - statsFor(games, a, tied.filter(id => id !== a)).wins ||
        ids.indexOf(b) - ids.indexOf(a))[0];
}
export function judgeRound0(league: League, games: readonly LeagueGame[]): Decision {
    try {
        validateSchedule(games, roundRobinJobs(league.members.filter(member => member.active).map(member => member.id), 0, 'qualify'), league, 0);
        const winner = initialWinner(league, games);
        return { mode: 'round0', valid: true, pass: true, round: 0, winner, gates: { G1: true }, table: [] };
    } catch (error) { return invalid('round0', error); }
}
export function judgeExploiter(league: League, id: string, target: string, games: readonly LeagueGame[]): Decision {
    try {
        const round = games[0]?.round;
        if (!Number.isInteger(round) || round < 1 || target !== league.champion || league.members.some(member => member.id === id))
            throw new Error('Exploiter must be a new member targeting the current champion in a positive round');
        validateSchedule(games, pairingJobs(id, target, round, 'qualify'), league, round, [id]);
        const candidate = statsFor(games, id, [target]), admitted = candidate.wins >= 12 && candidate.wins > candidate.losses;
        return { mode: 'exploiter', valid: true, pass: admitted, round, id, target,
            gates: { G1: true, winsAtLeastTwelveAndMajority: admitted }, table: [{ opponent: target, candidate, baseline: null, difference: null }], candidate };
    } catch (error) { return invalid('exploiter', error); }
}
function repairRetest(fixes: string, id: string, champion: string, candidateGames: readonly LeagueGame[], baselineGames: readonly LeagueGame[], common: readonly string[], eco?: EcoRetestFiles): RepairRetest {
    if (fixes === 'eco') {
        const directory = resolve(REPO_ROOT, 'docs/ai-league');
        const baseline = eco?.baseline ?? validateEcoReport(JSON.parse(readFileSync(resolve(directory, 'eco-baseline.json'), 'utf8')));
        const candidate = eco?.candidate ?? validateEcoReport(JSON.parse(readFileSync(resolve(directory, `eco-${id}.json`), 'utf8')));
        return { fixes, before: baseline.mean.mined[9000]!, after: candidate.mean.mined[9000]! };
    }
    if (fixes.startsWith('member:')) {
        const opponent = fixes.slice(7);
        return { fixes, before: statsFor(baselineGames, opponent, [champion]).wins, after: statsFor(candidateGames, opponent, [id]).wins };
    }
    const map = fixes.slice(4), candidate = statsFor(candidateGames.filter(game => game.map === map), id, common),
        baseline = statsFor(baselineGames.filter(game => game.map === map), champion, common);
    return { fixes, before: baseline.losses + baseline.timeouts, after: candidate.losses + candidate.timeouts };
}
export function championGates(candidate: Stats, baseline: Stats, direct: Stats, table: readonly OpponentScore[], repair: RepairRetest): Record<string, boolean> {
    const candidateMedian = median(candidate.winTicks), baselineMedian = median(baseline.winTicks);
    return { G1: true,
        G2: baseline.total > 0 && candidate.total === baseline.total && (candidate.wins - baseline.wins) * 20 >= baseline.total,
        G3: direct.wins > direct.losses,
        G4: table.every(row => row.baseline !== null && row.candidate.wins >= row.baseline.wins - 2),
        G5: candidateMedian !== null && baselineMedian !== null && candidateMedian * 10 <= baselineMedian * 11 && candidate.timeouts <= baseline.timeouts + 2,
        G6: repair.fixes.startsWith('member:') ? repair.after <= 8 && repair.after <= repair.before - 3 : repair.after <= repair.before - 4 };
}
export function judgeChampion(league: League, id: string, champion: string, candidateGames: readonly LeagueGame[], baselineGames: readonly LeagueGame[], attempt: number, fixes?: string, ecoCandidate?: unknown, ecoBaseline?: unknown): Decision {
    try {
        const round = candidateGames[0]?.round;
        if (!Number.isInteger(round) || round < 1 || id !== `c${round}` || champion !== league.champion ||
            league.members.some(member => member.id === id) || !Number.isInteger(attempt) || attempt < 1 || attempt > 2)
            throw new Error('Invalid current champion, candidate round/id or attempt (must be 1-2)');
        if (!fixes || !/^(member:(x-[a-z]+-[0-9]{2})|map:[a-z0-9]+|eco)$/.test(fixes)) throw new Error('Missing or invalid --fixes declaration');
        if (fixes.startsWith('member:')) {
            const target = league.members.find(member => member.id === fixes.slice(7));
            if (!target?.active || (target.role !== 'exploiter' && target.role !== 'sparring')) throw new Error('--fixes member must be an active exploiter or sparring');
        } else if (fixes !== 'eco' && !mapsForRound(round).includes(fixes.slice(4))) throw new Error('--fixes map is not used this round');
        const active = league.members.filter(member => member.active).map(member => member.id), common = active.filter(member => member !== champion);
        if (!common.length) throw new Error('Champion qualification needs common opponents');
        validateSchedule(candidateGames, active.flatMap(opponent => pairingJobs(id, opponent, round, 'qualify')), league, round, [id]);
        validateSchedule(baselineGames, common.flatMap(opponent => pairingJobs(champion, opponent, round, 'qualify')), league, round);
        let eco: EcoGateDecision | undefined;
        if (fixes === 'eco') {
            if (ecoCandidate === undefined || ecoBaseline === undefined) throw new Error('--fixes eco requires --eco-candidate and --eco-baseline');
            eco = judgeEconomy(ecoCandidate, ecoBaseline);
            if (!eco.valid) throw new Error(eco.reason);
            if ((ecoCandidate as EcoReport).tree !== candidateGames.find(game => game.a === id)?.aTree) throw new Error('Candidate economic tree differs from candidate-games aTree');
            const measuredBaseline = ecoBaseline as EcoReport;
            if (measuredBaseline.member !== champion || measuredBaseline.tree !== league.members.find(member => member.id === champion)?.tree)
                throw new Error('Economic baseline must identify the frozen champion member/tree');
        }
        const table = common.map(opponent => {
            const candidate = statsFor(candidateGames, id, [opponent]), baseline = statsFor(baselineGames, champion, [opponent]);
            return { opponent, candidate, baseline, difference: candidate.wins - baseline.wins };
        });
        const candidate = statsFor(candidateGames, id, common), baseline = statsFor(baselineGames, champion, common), direct = statsFor(candidateGames, id, [champion]);
        const repair = repairRetest(fixes, id, champion, candidateGames, baselineGames, common,
            eco ? { candidate: ecoCandidate as EcoReport, baseline: ecoBaseline as EcoReport } : undefined), gates = championGates(candidate, baseline, direct, table, repair);
        if (eco) gates.G6 = eco.pass;
        return { mode: 'champion', valid: true, pass: Object.values(gates).every(Boolean), round, id, target: champion, attempt, fixes, repair,
            gates, table: [...table, { opponent: champion, candidate: direct, baseline: null, difference: null }], candidate, baseline, direct, ...(eco ? { eco } : {}) };
    } catch (error) { return invalid('champion', error); }
}

export function trimHistory(league: League, formerChampions: readonly string[]): void {
    const blocked = new Set(league.members.filter(member => member.blockedReason).map(member => member.id));
    const keep = new Set(['r4', ...formerChampions.filter(id => id !== league.champion && !blocked.has(id)).slice(-3)]);
    for (const member of league.members) if (member.role === 'history') member.active = !member.blockedReason && keep.has(member.id);
}
export function trimExploiters(league: League): void {
    const active = league.members.filter(member => member.active && member.role === 'exploiter');
    while (active.length > 4) {
        active.sort((a, b) => (a.winsVsTarget ?? 0) - (b.winsVsTarget ?? 0) || league.members.indexOf(a) - league.members.indexOf(b));
        active.shift()!.role = 'sparring';
    }
}
export function trimSparring(league: League): void {
    const active = league.members.filter(member => member.active && member.role === 'sparring');
    while (active.length > 6) {
        active.sort((a, b) => (a.winsVsTarget ?? 0) - (b.winsVsTarget ?? 0) || league.members.indexOf(a) - league.members.indexOf(b));
        active.shift()!.active = false;
    }
}
export function trimPool(league: League, ratings: Record<string, number>): void {
    while (league.members.filter(member => member.active).length > 12) {
        const sparring = league.members.filter(member => member.active && member.role === 'sparring');
        sparring.sort((a, b) => (a.winsVsTarget ?? 0) - (b.winsVsTarget ?? 0) || league.members.indexOf(a) - league.members.indexOf(b));
        if (sparring.length) { sparring[0].active = false; continue; }
        const candidates = league.members.filter(member => member.active && member.role === 'history' && member.id !== 'r4');
        candidates.sort((a, b) => (ratings[a.id] ?? 1500) - (ratings[b.id] ?? 1500) || league.members.indexOf(a) - league.members.indexOf(b));
        if (!candidates.length) throw new Error('No eligible history member to trim the active pool');
        candidates[0].active = false;
    }
}
function formerChampions(league: League, games: readonly LeagueGame[]): string[] {
    const round0 = games.filter(game => game.round === 0 && game.kind === 'qualify');
    const ids = new Set(round0.flatMap(game => [game.a, game.b]));
    const initial = round0.length ? initialWinner({ ...league, members: league.members.filter(member => ids.has(member.id)).map(member => ({ ...member, active: true })) }, round0) : null;
    const history = [...(initial ? [initial] : []), ...league.members.filter(member => member.id !== 'c0' && /^c[0-9]+$/.test(member.id))
        .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))).map(member => member.id)];
    for (const member of league.members.filter(member => member.replaces)) {
        const previous = history.indexOf(member.replaces!);
        if (previous >= 0) history.splice(previous + 1, 0, member.id);
    }
    return history;
}
export function applyDecision(league: League, decision: Decision, games: readonly LeagueGame[], allGames: readonly LeagueGame[]): League {
    if (!decision.valid || !decision.pass) throw new Error('Failed or invalid qualification may not change the registry');
    const next = structuredClone(league);
    if (decision.mode === 'round0') {
        if (next.champion !== null) throw new Error('Round 0 has already selected a champion');
        next.champion = decision.winner!;
        next.members.find(member => member.id === decision.winner)!.role = 'champion';
    } else {
        if (next.members.some(member => member.id === decision.id)) throw new Error(`Member ${decision.id} already exists`);
        const tree = games.find(game => game.a === decision.id)?.aTree;
        if (!tree) throw new Error('Candidate tree is missing from qualification');
        if (decision.mode === 'exploiter') {
            const style = /^x-([a-z]+)-[0-9]{2}$/.exec(decision.id!)?.[1];
            if (!style || next.members.some(member => (member.role === 'exploiter' || member.role === 'sparring') && member.style === style)) throw new Error('Invalid or previously registered exploiter style');
            next.members.push({ id: decision.id!, tag: `league/${decision.id}`, tree, profile: 'brutal', role: 'exploiter', active: true,
                style, target: decision.target, winsVsTarget: decision.candidate!.wins, note: `admitted round ${decision.round}` });
        } else {
            next.members.find(member => member.id === next.champion)!.role = 'history';
            next.members.push({ id: decision.id!, tag: `league/${decision.id}`, tree, profile: 'brutal', role: 'champion', active: true,
                attempts: decision.attempt, fixes: decision.fixes, note: `round ${decision.round}; G1-G6 passed` });
            next.champion = decision.id!; next.round = decision.round;
            for (const member of next.members.filter(member => (member.role === 'exploiter' || member.role === 'sparring') && member.active)) {
                member.winsVsTarget = statsFor(games, member.id, [decision.id!]).wins; member.target = decision.id;
                if (member.role === 'exploiter' && member.winsVsTarget <= 8) member.role = 'sparring';
            }
        }
    }
    trimHistory(next, formerChampions(next, allGames)); trimExploiters(next); trimSparring(next); trimPool(next, computeRatings(allGames));
    return next;
}
function appendUnique(existing: readonly LeagueGame[], incoming: readonly LeagueGame[]): LeagueGame[] {
    const result = [...existing], byKey = new Map(existing.map(game => [gameKey(game), game]));
    for (const game of [...incoming].sort(compareGames)) {
        const key = gameKey(game), previous = byKey.get(key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(game)) throw new Error(`Conflicting stored result for ${key}`);
        if (!previous) { result.push(game); byKey.set(key, game); }
    }
    return result;
}
const rate = (stats: Stats) => stats.total ? `${(100 * stats.wins / stats.total).toFixed(1)}%` : '—';
export function leaderboardMarkdown(league: League, games: readonly LeagueGame[], eco?: Record<string, EcoRetestFiles>): string {
    const ratings = computeRatings(games), lines = ['# 冷酷 AI 联赛', '', `当前主力：\`${league.champion ?? '未选定'}\`；最近晋级轮次：${league.round}。超时在验收中计零分，Bradley–Terry 展示评分按半分。`, '',
        '## 排行榜', '', '| 编号 | 角色 | 活跃 | Elo | 总局数 | 胜率 | 获胜 tick 中位数 |', '| --- | --- | --- | ---: | ---: | ---: | ---: |'];
    for (const member of [...league.members].sort((a, b) => (ratings[b.id] ?? 1500) - (ratings[a.id] ?? 1500) || league.members.indexOf(a) - league.members.indexOf(b))) {
        const stats = statsFor(games, member.id);
        lines.push(`| ${member.id} | ${member.role} | ${member.active ? '是' : '否'} | ${ratings[member.id] ?? '—'} | ${stats.total} | ${rate(stats)} | ${median(stats.winTicks) ?? '—'} |`);
    }
    lines.push('', '## 主力更替', '', '| 轮次 | 新主力 | 对共同对手胜率 | 前任胜率 | 验收次数 | 声明修复 | 复测 |', '| ---: | --- | ---: | ---: | ---: | --- | --- |');
    const history = formerChampions(league, games);
    for (const [index, id] of history.entries()) {
        if (league.members.find(member => member.id === id)?.replaces) continue;
        const round = /^c[0-9]+$/.test(id) ? Number(id.slice(1)) : 0;
        const rows = games.filter(game => game.round === round && game.kind === 'qualify');
        if (!round) lines.push(`| 0 | ${id} | ${rate(statsFor(rows, id))} | — | 0 | — | — |`);
        else {
            const previous = history[index - 1], candidateRows = rows.filter(game => game.a === id);
            const common = [...new Set(candidateRows.map(game => game.b))].filter(opponent => opponent !== previous);
            const member = league.members.find(member => member.id === id), baselineRows = rows.filter(game => game.a === previous);
            const repair = member?.fixes ? repairRetest(member.fixes, id, previous, candidateRows, baselineRows, common, eco?.[id]) : null;
            lines.push(`| ${round} | ${id} | ${rate(statsFor(candidateRows, id, common))} | ${rate(statsFor(baselineRows, previous, common))} | ${member?.attempts ?? '—'} | ${member?.fixes ?? '—'} | ${repair ? `${repair.before} → ${repair.after}` : '—'} |`);
        }
    }
    const replacements = league.members.filter(member => member.replaces);
    if (replacements.length) {
        lines.push('', '## 安全基线替换', '', '| 安全基线 | 替代冻结版本 | 原因 | 性质 |', '| --- | --- | --- | --- |');
        for (const member of replacements) lines.push(`| ${member.id} | ${member.replaces} | ${league.members.find(previous => previous.id === member.replaces)?.blockedReason} | 非 G1–G5 晋级 |`);
    }
    for (const role of ['exploiter', 'sparring'] as const) {
        lines.push('', role === 'exploiter' ? '## 找茬者' : '## 陪练', '', '| 编号 | 打法 | 入池时针对主力 | 入池胜局数 | 活跃 | 最近针对主力 | 最近胜局数 |', '| --- | --- | --- | ---: | --- | --- | ---: |');
        for (const member of league.members.filter(member => member.role === role)) {
            const admission = games.filter(game => game.a === member.id && game.kind === 'qualify').sort((a, b) => a.round - b.round);
            const target = admission[0]?.b, firstRound = admission[0]?.round;
            const wins = target ? statsFor(admission.filter(game => game.round === firstRound), member.id, [target]).wins : null;
            lines.push(`| ${member.id} | ${member.style} | ${target ?? '—'} | ${wins ?? '—'} | ${member.active ? '是' : '否'} | ${member.target} | ${member.winsVsTarget} |`);
        }
    }
    return lines.join('\n') + '\n';
}
async function atomicText(path: string, text: string) {
    const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, text); await rename(temporary, path);
}
async function publish(league: League, decision: Decision, usedGames: readonly LeagueGame[], candidateGames: readonly LeagueGame[], eco?: EcoRetestFiles & { candidateText: string }) {
    const directory = resolve(REPO_ROOT, 'docs/ai-league'), resultsPath = resolve(directory, 'results.jsonl');
    const file = Bun.file(resultsPath), existing = await file.exists() ? parseGames(await file.text()) : [];
    const all = appendUnique(existing, usedGames), next = applyDecision(league, decision, candidateGames, all);
    // New member tags must already point at the qualified immutable code tree. They need not point at a later documentation amendment.
    await validateLeague(next);
    const markdown = leaderboardMarkdown(next, all, eco ? { [decision.id!]: eco } : undefined); await mkdir(directory, { recursive: true });
    if (eco) await atomicText(resolve(directory, `eco-${decision.id}.json`), eco.candidateText);
    await atomicText(resultsPath, all.map(game => JSON.stringify(game)).join('\n') + '\n');
    await atomicText(resolve(directory, 'README.md'), markdown);
    await atomicText(LEAGUE_PATH, JSON.stringify(next, null, 2) + '\n');
}
function printDecision(decision: Decision) {
    console.log(JSON.stringify({ mode: decision.mode, valid: decision.valid, pass: decision.pass, winner: decision.winner,
        round: decision.round, gates: decision.gates, reason: decision.reason,
        commonWinRate: decision.candidate ? rate(decision.candidate) : undefined,
        baselineWinRate: decision.baseline ? rate(decision.baseline) : undefined,
        candidateWinningTickMedian: decision.candidate ? median(decision.candidate.winTicks) : undefined,
        baselineWinningTickMedian: decision.baseline ? median(decision.baseline.winTicks) : undefined,
        fixes: decision.fixes, repair: decision.repair, ecoGates: decision.eco?.gates }, null, 2));
    if (decision.repair) console.log(`repair\t${decision.repair.fixes}\t${decision.repair.before} → ${decision.repair.after}`);
    if (decision.table.length) {
        console.log('opponent\tcandidate W/L/timeout\tchampion W/L/timeout\tdelta');
        for (const row of decision.table) console.log(`${row.opponent}\t${row.candidate.wins}/${row.candidate.losses}/${row.candidate.timeouts}\t${row.baseline ? `${row.baseline.wins}/${row.baseline.losses}/${row.baseline.timeouts}` : '—'}\t${row.difference ?? '—'}`);
    }
}
export async function main() {
    const { values } = parseArgs({ options: { mode: { type: 'string' }, games: { type: 'string' }, id: { type: 'string' }, target: { type: 'string' },
        candidate: { type: 'string' }, champion: { type: 'string' }, 'candidate-games': { type: 'string' }, 'baseline-games': { type: 'string' },
        attempt: { type: 'string' }, fixes: { type: 'string' }, write: { type: 'boolean' }, 'eco-candidate': { type: 'string' }, 'eco-baseline': { type: 'string' } } });
    const league = await loadLeague();
    if (values.mode === 'readme') {
        const directory = resolve(REPO_ROOT, 'docs/ai-league'), games = parseGames(await Bun.file(resolve(directory, 'results.jsonl')).text());
        await atomicText(resolve(directory, 'README.md'), leaderboardMarkdown(league, games));
        process.exitCode = 0; return;
    }
    let decision: Decision, used: LeagueGame[], candidateGames: LeagueGame[];
    let eco: (EcoRetestFiles & { candidateText: string }) | undefined;
    if (values.mode === 'round0' || values.mode === 'exploiter') {
        if (!values.games) throw new Error('--games is required');
        used = candidateGames = parseGames(await Bun.file(values.games).text());
        if (values.mode === 'round0') decision = judgeRound0(league, used);
        else {
            if (!values.id || !values.target) throw new Error('--id and --target are required');
            decision = judgeExploiter(league, values.id, values.target, used);
        }
    } else if (values.mode === 'champion') {
        if (!values.candidate || !values.champion || !values['candidate-games'] || !values['baseline-games'] || !values.attempt || !values.fixes)
            throw new Error('Champion mode requires --candidate, --champion, --candidate-games, --baseline-games, --attempt and --fixes');
        if (values.fixes === 'eco') {
            if (!values['eco-candidate'] || !values['eco-baseline']) throw new Error('--fixes eco requires --eco-candidate and --eco-baseline');
            const candidateText = await Bun.file(values['eco-candidate']).text();
            eco = { candidate: JSON.parse(candidateText), baseline: await Bun.file(values['eco-baseline']).json(), candidateText };
        }
        candidateGames = parseGames(await Bun.file(values['candidate-games']).text());
        const baselineGames = parseGames(await Bun.file(values['baseline-games']).text());
        used = [...candidateGames, ...baselineGames];
        decision = judgeChampion(league, values.candidate, values.champion, candidateGames, baselineGames, Number(values.attempt), values.fixes, eco?.candidate, eco?.baseline);
    } else throw new Error('--mode must be round0, exploiter, champion or readme');
    printDecision(decision);
    if (values.write && decision.pass) await publish(league, decision, used, candidateGames, eco);
    process.exitCode = !decision.valid ? 2 : decision.pass ? 0 : 1;
}
if (import.meta.main) {
    try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}

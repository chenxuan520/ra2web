import { jobId, type LeagueGame, type Country } from './schedule';
import { median, statsFor, type Stats } from './records';

export const LABELS = ['cannot-finish', 'stalemate', 'slow-loss', 'early-overrun', 'eco-starved', 'army-wipe', 'outproduced', 'other'] as const;
export type WeaknessLabel = typeof LABELS[number];
export interface PlayerSample { army: number; harvesters: number; buildings: number; assetValue: number; creditsSpent: number }
export interface Sample { tick: number; players: readonly [PlayerSample, PlayerSample] }
export interface DiagnosedGame {
    jobId: string;
    swapped: boolean;
    opponent: string;
    map: string;
    ownCountry: Country;
    opponentCountry: Country;
    ticks: number;
    outcome: 'loss' | 'timeout';
    harvesterZeroTick: number | null;
    collapseTick: number | null;
    armyBeforeCollapse: { own: number; opponent: number } | null;
    finalAssets: { own: number; opponent: number };
    spentRatio: number;
    label: WeaknessLabel;
}
export interface Weakness {
    id: string;
    label: WeaknessLabel;
    map: string;
    count: number;
    mapGames: number;
    share: number;
    opponents: { opponent: string; count: number }[];
    typicalGames: { jobId: string; swapped: boolean }[];
    collapseTickMedian: number | null;
    harvesterZeroTickMedian: number | null;
}
export interface OpponentDiagnosis extends Stats { opponent: string; labels: Record<WeaknessLabel, number> }
export interface WeaknessReport { member: string; records: DiagnosedGame[]; weaknesses: Weakness[]; opponents: OpponentDiagnosis[] }
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Benchmark player arrays are always [a, b], even after swapping physical starts and player slots. */
export function diagnoseGame(game: LeagueGame, member: string, samples: readonly Sample[]): DiagnosedGame | null {
    const winner = game.result === 'a-win' ? game.a : game.result === 'b-win' ? game.b : null;
    if (game.a === game.b || (game.a !== member && game.b !== member) || winner === member || game.result === 'error') return null;
    if (!Array.isArray(samples) || !samples.length) throw new Error(`Missing samples for ${jobId(game)}/${game.swapped}`);
    for (const [index, sample] of samples.entries()) {
        if (!sample || !Number.isSafeInteger(sample.tick) || sample.tick < 0 || sample.tick > game.ticks || (index > 0 && sample.tick <= samples[index - 1].tick))
            throw new Error('Invalid or unordered sample tick');
        if (!Array.isArray(sample.players) || sample.players.length !== 2) throw new Error('Missing sample players');
        for (const player of sample.players) for (const field of ['army', 'harvesters', 'buildings', 'assetValue', 'creditsSpent'] as const) {
            if (!player || !Number.isFinite(player[field]) || player[field] < 0) throw new Error(`Missing or invalid sample ${field}`);
        }
    }
    const ownIndex = game.a === member ? 0 : 1, opponentIndex = ownIndex === 0 ? 1 : 0;
    let harvesterSeen = false, harvesterZeroTick: number | null = null, collapseTick: number | null = null;
    let armyBeforeCollapse: DiagnosedGame['armyBeforeCollapse'] = null;
    for (const [index, sample] of samples.entries()) {
        const own = sample.players[ownIndex];
        if (own.harvesters >= 1) harvesterSeen = true;
        else if (own.harvesters === 0 && harvesterSeen && harvesterZeroTick === null) harvesterZeroTick = sample.tick;
        if (index > 0 && collapseTick === null) {
            const previous = samples[index - 1];
            if (previous.players[ownIndex].army >= 4 && own.army <= previous.players[ownIndex].army / 2) {
                collapseTick = sample.tick;
                armyBeforeCollapse = { own: previous.players[ownIndex].army, opponent: previous.players[opponentIndex].army };
            }
        }
    }
    const final = samples.at(-1)!, own = final.players[ownIndex], opponent = final.players[opponentIndex];
    const finalAssets = { own: own.assetValue, opponent: opponent.assetValue };
    const spentRatio = own.creditsSpent === 0 ? 99 : opponent.creditsSpent / own.creditsSpent;
    let label: WeaknessLabel;
    if (game.result === 'timeout') {
        label = finalAssets.own >= finalAssets.opponent * 1.5 ? 'cannot-finish'
            : finalAssets.own * 1.5 >= finalAssets.opponent && finalAssets.opponent * 1.5 >= finalAssets.own ? 'stalemate' : 'slow-loss';
    } else if (game.ticks < 9000) label = 'early-overrun';
    else if (harvesterZeroTick !== null && harvesterZeroTick < 12000) label = 'eco-starved';
    else if (collapseTick !== null) label = 'army-wipe';
    else if (spentRatio >= 1.3) label = 'outproduced';
    else label = 'other';
    return { jobId: jobId(game), swapped: game.swapped, opponent: ownIndex === 0 ? game.b : game.a, map: game.map,
        ownCountry: ownIndex === 0 ? game.aCountry : game.bCountry, opponentCountry: ownIndex === 0 ? game.bCountry : game.aCountry,
        ticks: game.ticks, outcome: game.result === 'timeout' ? 'timeout' : 'loss', harvesterZeroTick, collapseTick, armyBeforeCollapse, finalAssets, spentRatio, label };
}

export function summarizeWeaknesses(games: readonly LeagueGame[], member: string, diagnostics: readonly DiagnosedGame[]): WeaknessReport {
    const relevant = games.filter(game => game.a !== game.b && game.result !== 'error' && (game.a === member || game.b === member));
    const records = [...diagnostics].sort((a, b) => compareText(a.jobId, b.jobId) || Number(a.swapped) - Number(b.swapped));
    const groups = new Map<string, DiagnosedGame[]>();
    for (const record of records) {
        const key = `${record.label}/${record.map}`, group = groups.get(key) ?? [];
        group.push(record); groups.set(key, group);
    }
    const weaknesses = [...groups.values()].sort((a, b) => b.length - a.length || LABELS.indexOf(a[0].label) - LABELS.indexOf(b[0].label) || compareText(a[0].map, b[0].map))
        .slice(0, 8).map((group, index): Weakness => {
            const first = group[0], mapGames = relevant.filter(game => game.map === first.map).length;
            const counts = new Map<string, number>();
            for (const record of group) counts.set(record.opponent, (counts.get(record.opponent) ?? 0) + 1);
            const opponents = [...counts].map(([opponent, count]) => ({ opponent, count }))
                .sort((a, b) => b.count - a.count || compareText(a.opponent, b.opponent));
            const typicalGames = [...group].sort((a, b) => a.ticks - b.ticks || compareText(a.jobId, b.jobId) || Number(a.swapped) - Number(b.swapped))
                .slice(0, 3).map(({ jobId, swapped }) => ({ jobId, swapped }));
            return { id: `W${index + 1}`, label: first.label, map: first.map, count: group.length, mapGames, share: group.length / mapGames,
                opponents, typicalGames, collapseTickMedian: median(group.flatMap(record => record.collapseTick === null ? [] : [record.collapseTick])),
                harvesterZeroTickMedian: median(group.flatMap(record => record.harvesterZeroTick === null ? [] : [record.harvesterZeroTick])) };
        });
    const ids = [...new Set(relevant.map(game => game.a === member ? game.b : game.a))].sort(compareText);
    const opponents = ids.map(opponent => {
        const labels = Object.fromEntries(LABELS.map(label => [label, 0])) as Record<WeaknessLabel, number>;
        for (const record of records.filter(record => record.opponent === opponent)) labels[record.label]++;
        return { opponent, ...statsFor(relevant, member, [opponent]), labels };
    });
    return { member, records, weaknesses, opponents };
}

export function weaknessMarkdown(report: WeaknessReport): string {
    const lines = [`# ${report.member} 败局诊断`, '', '## 弱点清单', '',
        '| 序号 | 标签 | 地图 | 局数 | 占该图比例 | 涉及对手 | 典型对局（job id / swapped） | collapseTick 中位数 | harvesterZeroTick 中位数 |',
        '| --- | --- | --- | ---: | ---: | --- | --- | ---: | ---: |'];
    for (const weakness of report.weaknesses) lines.push(`| ${weakness.id} | ${weakness.label} | ${weakness.map} | ${weakness.count} | ${(weakness.share * 100).toFixed(1)}% | ${weakness.opponents.map(entry => `${entry.opponent}: ${entry.count}`).join(', ')} | ${weakness.typicalGames.map(entry => `\`${entry.jobId}\` / ${entry.swapped}`).join('<br>')} | ${weakness.collapseTickMedian ?? '—'} | ${weakness.harvesterZeroTickMedian ?? '—'} |`);
    lines.push('', '## 逐对手表', '', `| 对手 | 胜 | 负 | 超时 | ${LABELS.join(' | ')} |`, `| --- | ---: | ---: | ---: | ${LABELS.map(() => '---:').join(' | ')} |`);
    for (const opponent of report.opponents) lines.push(`| ${opponent.opponent} | ${opponent.wins} | ${opponent.losses} | ${opponent.timeouts} | ${LABELS.map(label => opponent.labels[label]).join(' | ')} |`);
    return lines.join('\n') + '\n';
}

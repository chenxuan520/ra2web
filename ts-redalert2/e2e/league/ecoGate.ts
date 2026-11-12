import { parseArgs } from 'node:util';
import { ECO_TICKS, ECO_MAX_TICKS, summarizeEconomy, type EcoGame, type EcoMean } from './ecoCore';

export type EcoReport = { schema: 1; member: string; tree: string; games: EcoGame[] } & ReturnType<typeof summarizeEconomy>;
export interface EcoRetestFiles { candidate: EcoReport; baseline: EcoReport }
export interface EcoMapComparison {
    map: string; baseline: EcoMean; candidate: EcoMean;
    ratios: { mined7200: number | null; mined9000: number | null };
    homeGemGames: number; earlyGemGames: number; minimumHomePatches: number;
    participates: { K4: boolean; K5: boolean };
    gates: { K2: boolean; K4: boolean; K5: boolean };
}
export interface EcoGateDecision {
    valid: boolean; pass: boolean; gates: Record<'K1' | 'K2' | 'K3' | 'K4' | 'K5', boolean>;
    table: EcoMapComparison[]; baseline?: EcoMean; candidate?: EcoMean; reason?: string;
}
const timedFields = ['mined', 'miners', 'refineries', 'factories', 'servedPatches'] as const;
const scalarFields = ['gemShare', 'homeGemPatch', 'firstGemMinerTick', 'maxMinersOnPatch', 'survived'] as const;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => nonnegative(value) && Number.isSafeInteger(value);
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Invalid economic report: ${message}`); }
function sameMean(value: unknown, expected: EcoMean): boolean {
    return record(value) && timedFields.every(field => record(value[field]) &&
        ECO_TICKS.every(tick => (value[field] as Record<string, unknown>)[tick] === expected[field][tick])) &&
        scalarFields.every(field => value[field] === expected[field]);
}

/** Validate E1's exact 32-game schedule and recomputed means/counts, never trusting a saved valid flag alone. */
export function validateEcoReport(value: unknown): EcoReport {
    check(record(value) && value.schema === 1, 'schema must be 1');
    check(typeof value.member === 'string' && /^[a-z][a-z0-9-]*$/.test(value.member) &&
        typeof value.tree === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.tree), 'missing or invalid member/tree');
    check(Array.isArray(value.games) && record(value.failures) && Object.values(value.failures).every(message => typeof message === 'string'), 'missing games/failures');
    for (const raw of value.games) {
        check(record(raw), 'game must be an object');
        const game = raw as unknown as EcoGame, map = game.ecoMap, metrics = game.metrics;
        check(['a-win', 'b-win', 'timeout'].includes(game.result) && game.error === null && count(game.ticks) &&
            game.ticks > 0 && game.ticks <= ECO_MAX_TICKS, 'error or invalid game result/ticks');
        check(game.result === 'timeout' ? game.reason === 'tick-limit' && game.ticks === ECO_MAX_TICKS :
            game.reason === 'engine-victory-conditions', 'non-native result');
        check(map && nonnegative(map.values?.ore) && nonnegative(map.values?.gems) && Array.isArray(map.patches), 'missing ecoMap');
        const ids = new Set<string>();
        for (const patch of map.patches) {
            check(patch && typeof patch.id === 'string' && /^-?\d+_-?\d+$/.test(patch.id) && !ids.has(patch.id), 'invalid/duplicate patch id');
            ids.add(patch.id);
            check(Number.isSafeInteger(patch.cx) && Number.isSafeInteger(patch.cy) && count(patch.tiles) && patch.tiles > 0 &&
                nonnegative(patch.value) && nonnegative(patch.gemValue) && patch.gemValue <= patch.value &&
                typeof patch.isGem === 'boolean' && patch.isGem === (patch.gemValue >= patch.value * 0.5) && typeof patch.regrows === 'boolean' &&
                (patch.nearestStart === 0 || patch.nearestStart === 1) && Array.isArray(patch.distToStart) &&
                patch.distToStart.length === 2 && patch.distToStart.every(nonnegative), 'invalid ecoMap patch');
        }
        check(metrics && typeof metrics.homeGemPatch === 'boolean' && typeof metrics.survived === 'boolean' &&
            nonnegative(metrics.maxMinersOnPatch), 'missing or invalid metrics');
        for (const field of timedFields) {
            check(record(metrics[field]), `missing ${field}`);
            for (const tick of ECO_TICKS) check(game.ticks < tick ? metrics[field][tick] === null : nonnegative(metrics[field][tick]),
                `missing/invalid ${field}[${tick}] (only future ticks may be null)`);
        }
        for (const tick of ECO_TICKS) check(metrics.servedPatches[tick] === null || metrics.servedPatches[tick]! <= map.patches.length, 'invalid served patch count');
        check(metrics.survived === (game.result === 'timeout' && game.ticks === ECO_MAX_TICKS), 'survived disagrees with result');
        check(metrics.homeGemPatch === map.patches.some(patch => patch.isGem && patch.nearestStart === game.player && patch.distToStart[game.player] <= 40), 'home gem flag disagrees with ecoMap');
        check(metrics.firstGemMinerTick === null || count(metrics.firstGemMinerTick) && metrics.firstGemMinerTick <= game.ticks && metrics.homeGemPatch,
            'invalid firstGemMinerTick');
        check(metrics.gemShare === null || typeof metrics.gemShare === 'number' && Number.isFinite(metrics.gemShare) && game.ticks === ECO_MAX_TICKS, 'invalid gemShare');
    }
    const report = value as unknown as EcoReport, summary = summarizeEconomy(report.games, report.failures);
    check(summary.valid, summary.issues.join('; '));
    check(report.valid === true && report.complete === true && report.expectedGames === 32 && report.completedGames === 32 &&
        report.errors === 0 && report.survived === summary.survived && Array.isArray(report.issues) && report.issues.length === 0,
        'invalid or inconsistent validity summary');
    check(sameMean(report.mean, summary.mean) && sameMean(report.observations, summary.observations), 'inconsistent whole-pool means/observations');
    check(Array.isArray(report.byMap) && report.byMap.length === summary.byMap.length &&
        new Set(report.byMap.map(row => row?.map)).size === report.byMap.length, 'map set is incomplete or duplicated');
    for (const row of report.byMap) {
        const expected = summary.byMap.find(expected => expected.map === row?.map);
        check(expected && row.games === 4 && sameMean(row.mean, expected.mean) && sameMean(row.observations, expected.observations), 'inconsistent map set/means/observations');
    }
    return report;
}
const atLeast = (candidate: number | null, baseline: number | null, factor = 1) => candidate !== null && baseline !== null && candidate >= baseline * factor;
const ratio = (candidate: number | null, baseline: number | null) => candidate === null || baseline === null || baseline === 0 ? null : candidate / baseline;

/** Pure K1-K5 decision; an unusable dataset is invalid, not a failed economic gate. */
export function judgeEconomy(candidateValue: unknown, baselineValue: unknown): EcoGateDecision {
    try {
        const candidate = validateEcoReport(candidateValue), baseline = validateEcoReport(baselineValue);
        check(candidate.byMap.length === baseline.byMap.length && candidate.byMap.every(row => baseline.byMap.some(other => other.map === row.map)), 'candidate/baseline map sets differ');
        const table = baseline.byMap.map(before => {
            const after = candidate.byMap.find(row => row.map === before.map)!, games = candidate.games.filter(game => game.map === before.map);
            const homeGemGames = games.filter(game => game.metrics!.homeGemPatch).length;
            const earlyGemGames = games.filter(game => game.metrics!.firstGemMinerTick !== null && game.metrics!.firstGemMinerTick! <= 4500).length;
            const minimumHomePatches = Math.min(...games.map(game => game.ecoMap!.patches.filter(patch => patch.nearestStart === game.player).length));
            const participates = { K4: homeGemGames === 4, K5: minimumHomePatches >= 2 };
            return { map: before.map, baseline: before.mean, candidate: after.mean,
                ratios: { mined7200: ratio(after.mean.mined[7200], before.mean.mined[7200]), mined9000: ratio(after.mean.mined[9000], before.mean.mined[9000]) },
                homeGemGames, earlyGemGames, minimumHomePatches, participates,
                gates: { K2: atLeast(after.mean.mined[9000], before.mean.mined[9000]), K4: !participates.K4 || earlyGemGames >= 3,
                    K5: !participates.K5 || after.mean.servedPatches[9000] !== null && after.mean.servedPatches[9000] >= 2.0 } };
        });
        const gates = { K1: atLeast(candidate.mean.mined[7200], baseline.mean.mined[7200], 1.30) && atLeast(candidate.mean.mined[9000], baseline.mean.mined[9000], 1.40),
            K2: table.every(row => row.gates.K2), K3: candidate.mean.miners[7200] !== null && candidate.mean.miners[7200] >= 5.0,
            K4: table.every(row => row.gates.K4), K5: table.every(row => row.gates.K5) };
        return { valid: true, pass: Object.values(gates).every(Boolean), gates, table, baseline: baseline.mean, candidate: candidate.mean };
    } catch (error) {
        return { valid: false, pass: false, gates: { K1: false, K2: false, K3: false, K4: false, K5: false }, table: [],
            reason: error instanceof Error ? error.message : String(error) };
    }
}

export function ecoGateMarkdown(decision: EcoGateDecision): string {
    const lines = ['# 经济门槛', '', `有效: ${decision.valid}；通过: ${decision.pass}`, ''];
    if (!decision.valid) return [...lines, `无效原因: ${decision.reason}`, ''].join('\n');
    const number = (value: number | null) => value === null ? '—' : value.toFixed(2);
    const comparison = (before: number | null, after: number | null) => `${number(before)} → ${number(after)} (${number(ratio(after, before))}×)`;
    const result = (pass: boolean) => pass ? 'PASS' : 'FAIL';
    lines.push('| 地图 | mined[7200] 基准 → 候选 (倍数) | mined[9000] 基准 → 候选 (倍数) | miners[7200] 基准 → 候选 (倍数) | servedPatches[9000] 基准 → 候选 (倍数) | K2 | K4 (≤4500 局数) | K5 (最小己侧矿区数) |',
        '| --- | ---: | ---: | ---: | ---: | --- | --- | --- |');
    const values = (before: EcoMean, after: EcoMean) => [comparison(before.mined[7200], after.mined[7200]), comparison(before.mined[9000], after.mined[9000]),
        comparison(before.miners[7200], after.miners[7200]), comparison(before.servedPatches[9000], after.servedPatches[9000])].join(' | ');
    for (const row of decision.table) lines.push(`| ${row.map} | ${values(row.baseline, row.candidate)} | ${result(row.gates.K2)} | ${row.participates.K4 ? result(row.gates.K4) : 'SKIP'} (${row.earlyGemGames}/4) | ${row.participates.K5 ? result(row.gates.K5) : 'SKIP'} (${row.minimumHomePatches}) |`);
    lines.push(`| 全部 | ${values(decision.baseline!, decision.candidate!)} | — | — | — |`, '',
        ...Object.entries(decision.gates).map(([gate, pass]) => `${gate}: ${result(pass)}`), '', '均值沿用 E1 的实际观测口径；null 保持缺失，不补零。判定使用原值，不使用表中四舍五入后的倍数。');
    return lines.join('\n') + '\n';
}
export async function main() {
    const { values } = parseArgs({ options: { candidate: { type: 'string' }, baseline: { type: 'string' } } });
    if (!values.candidate || !values.baseline) throw new Error('Usage: bun e2e/league/ecoGate.ts --candidate ECO.json --baseline ECO.json');
    const decision = judgeEconomy(await Bun.file(values.candidate).json(), await Bun.file(values.baseline).json());
    console.log(ecoGateMarkdown(decision));
    process.exitCode = !decision.valid ? 2 : decision.pass ? 0 : 1;
}
if (import.meta.main) {
    try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}

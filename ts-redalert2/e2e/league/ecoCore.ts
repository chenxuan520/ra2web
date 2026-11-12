import { MAPS, type Country, type GameResult } from './schedule';

export const ECO_TICKS = [3600, 5400, 7200, 9000] as const;
export const ECO_MAX_TICKS = 9000;
export const ECO_SAMPLE_TICKS = 900;
export const ECO_COUNTRIES = ['Americans', 'Russians'] as const;
export type EcoTick = typeof ECO_TICKS[number];
export type Point = { rx: number; ry: number };
export type ResourceValues = { ore: number; gems: number };
export interface ResourceTile extends Point { ore: number; gems: number; spawnsOre: boolean }
export interface Patch {
    id: string; tiles: Point[]; center: Point; value: number; gemValue: number; isGem: boolean; regrows: boolean;
}
export interface EcoMap {
    values: ResourceValues;
    patches: { id: string; cx: number; cy: number; tiles: number; value: number; gemValue: number;
        isGem: boolean; regrows: boolean; nearestStart: 0 | 1; distToStart: [number, number] }[];
}
export interface EcoSample { oreValue: number; gemValue: number; patchValues: Record<string, [number, number]> }
export interface PlayerEcoSample {
    miners: number; minersByPatch: Record<string, number>;
    refineries: { x: number; y: number; patch: string | null }[]; servedPatches: number;
}
export interface EcoPlayerSample { name?: string; counts: Record<string, number>; eco: PlayerEcoSample }
export interface EcoMatch {
    result: string; reason: string; ticks: number; ecoMap: EcoMap;
    samples: { tick: number; eco: EcoSample; players: EcoPlayerSample[] }[];
}
export type TickValues = Record<EcoTick, number | null>;
export interface EcoMetrics {
    mined: TickValues; miners: TickValues; refineries: TickValues; factories: TickValues; servedPatches: TickValues;
    gemShare: number | null; homeGemPatch: boolean; firstGemMinerTick: number | null; maxMinersOnPatch: number; survived: boolean;
}
export interface EcoGame {
    jobId: string; map: string; seed: number; country: Country; swapped: boolean; player: 0 | 1;
    result: GameResult; reason: string; ticks: number | null; ecoMap: EcoMap | null; metrics: EcoMetrics | null; error: string | null;
}
export interface EcoMean extends Omit<EcoMetrics, 'homeGemPatch' | 'maxMinersOnPatch' | 'survived'> {
    homeGemPatch: number | null; maxMinersOnPatch: number | null; survived: number | null;
}
const comparePoints = (a: Point, b: Point) => a.rx - b.rx || a.ry - b.ry;
const keyOf = (point: Point) => `${point.rx}_${point.ry}`;
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => nonnegative(value) && Number.isSafeInteger(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Pure observer-side E1 clustering. Only positive resources connect; zero-resource spawning points never bridge patches. */
export function findPatches(tiles: readonly ResourceTile[], values: ResourceValues): Patch[] {
    check(values && nonnegative(values.ore) && nonnegative(values.gems), 'Missing or invalid resource credit values');
    check(Array.isArray(tiles), 'Missing resource tiles');
    const resources = new Map<string, ResourceTile>(), spawns: Point[] = [];
    for (const tile of tiles) {
        check(tile && Number.isSafeInteger(tile.rx) && Number.isSafeInteger(tile.ry), 'Invalid resource coordinate');
        check(nonnegative(tile.ore) && nonnegative(tile.gems) && typeof tile.spawnsOre === 'boolean', 'Invalid resource data');
        if (tile.spawnsOre) spawns.push({ rx: tile.rx, ry: tile.ry });
        if (tile.ore <= 0 && tile.gems <= 0) continue;
        const previous = resources.get(keyOf(tile));
        resources.set(keyOf(tile), { ...tile, ore: tile.ore + (previous?.ore ?? 0), gems: tile.gems + (previous?.gems ?? 0) });
    }
    const points = [...resources.values()].sort(comparePoints), visited = new Set<string>(), patches: Patch[] = [];
    for (const first of points) {
        if (visited.has(keyOf(first))) continue;
        const component = [first]; visited.add(keyOf(first));
        for (let index = 0; index < component.length; index++) {
            const point = component[index];
            for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
                const key = `${point.rx + dx}_${point.ry + dy}`, neighbor = resources.get(key);
                if (neighbor && !visited.has(key)) { visited.add(key); component.push(neighbor); }
            }
        }
        component.sort(comparePoints);
        const value = component.reduce((sum, point) => sum + point.ore * values.ore + point.gems * values.gems, 0);
        const gemValue = component.reduce((sum, point) => sum + point.gems * values.gems, 0);
        const regrows = component.some(point => spawns.some(spawn => Math.hypot(point.rx - spawn.rx, point.ry - spawn.ry) <= 4));
        if (value < 2000 && !regrows) continue;
        patches.push({ id: keyOf(component[0]), tiles: component.map(({ rx, ry }) => ({ rx, ry })),
            center: { rx: Math.round(component.reduce((sum, point) => sum + point.rx, 0) / component.length),
                ry: Math.round(component.reduce((sum, point) => sum + point.ry, 0) / component.length) },
            value, gemValue, isGem: gemValue >= value * 0.5, regrows });
    }
    return patches;
}

export function patchDistance(point: Point, patch: Pick<Patch, 'tiles'>): number {
    return patch.tiles.reduce((nearest, tile) => Math.min(nearest, Math.hypot(point.rx - tile.rx, point.ry - tile.ry)), Infinity);
}

/** Inclusive distance limit; tied distances use the stable patch ID. */
export function nearestPatch(point: Point, patches: readonly Patch[], limit: number): Patch | null {
    let nearest: Patch | null = null, distance = limit;
    for (const patch of patches) {
        const candidate = patchDistance(point, patch);
        if (candidate < distance || candidate === distance && (!nearest || patch.id < nearest.id)) {
            nearest = patch; distance = candidate;
        }
    }
    return nearest;
}

function validateMap(map: EcoMap): void {
    check(map && nonnegative(map.values?.ore) && nonnegative(map.values?.gems) && Array.isArray(map.patches), 'Missing or invalid ecoMap');
    const ids = new Set<string>();
    for (const patch of map.patches) {
        check(patch && typeof patch.id === 'string' && /^-?\d+_-?\d+$/.test(patch.id) && !ids.has(patch.id), 'Invalid or duplicate ecoMap patch id');
        ids.add(patch.id);
        check(Number.isSafeInteger(patch.cx) && Number.isSafeInteger(patch.cy) && count(patch.tiles) && patch.tiles > 0 &&
            nonnegative(patch.value) && nonnegative(patch.gemValue) && patch.gemValue <= patch.value &&
            typeof patch.isGem === 'boolean' && patch.isGem === (patch.gemValue >= patch.value * 0.5) && typeof patch.regrows === 'boolean' &&
            (patch.nearestStart === 0 || patch.nearestStart === 1) && Array.isArray(patch.distToStart) && patch.distToStart.length === 2 &&
            patch.distToStart.every(nonnegative), 'Invalid ecoMap patch');
    }
}

/** Benchmark arrays stay [a, b] after physical swaps. Missing future samples after an early end remain null. */
export function measureEconomy(match: EcoMatch, player: 0 | 1 = 0, playerNames?: readonly [string, string]): EcoMetrics {
    check(match && ['candidate-win', 'baseline-win', 'draw'].includes(match.result), 'Cannot measure an error or invalid match');
    check(count(match.ticks) && match.ticks > 0 && match.ticks <= ECO_MAX_TICKS && (player === 0 || player === 1), 'Invalid economic match ticks/player');
    validateMap(match.ecoMap);
    check(Array.isArray(match.samples) && match.samples.length, 'Missing economic samples');
    const expectedTicks: number[] = [];
    for (let tick = 0; tick <= match.ticks; tick += ECO_SAMPLE_TICKS) expectedTicks.push(tick);
    if (expectedTicks.at(-1) !== match.ticks) expectedTicks.push(match.ticks);
    check(match.samples.length === expectedTicks.length, 'Incomplete economic sample timeline');
    const ids = match.ecoMap.patches.map(patch => patch.id), knownIds = new Set(ids);
    const patchRecord = (value: unknown) => record(value) && Object.keys(value).length === ids.length && ids.every(id => Object.hasOwn(value, id));
    for (const [index, sample] of match.samples.entries()) {
        check(sample && sample.tick === expectedTicks[index], 'Missing or unordered economic sample tick');
        check(sample.eco && nonnegative(sample.eco.oreValue) && nonnegative(sample.eco.gemValue) && patchRecord(sample.eco.patchValues), 'Missing or invalid sample eco');
        for (const value of Object.values(sample.eco.patchValues))
            check(Array.isArray(value) && value.length === 2 && value.every(nonnegative) && value[1] <= value[0], 'Invalid sample patch values');
        check(Array.isArray(sample.players) && sample.players.length === 2, 'Missing economic sample players');
        for (const [side, own] of sample.players.entries()) {
            check(own && (!playerNames || own.name === playerNames[side]), 'Economic sample player order mismatch');
            check(record(own.counts) && Object.values(own.counts).every(count), 'Missing or invalid sample counts');
            const eco = own.eco;
            check(eco && count(eco.miners) && count(eco.servedPatches) && eco.servedPatches <= ids.length &&
                patchRecord(eco.minersByPatch) && Object.values(eco.minersByPatch).every(count) &&
                Object.values(eco.minersByPatch).reduce((sum, number) => sum + number, 0) <= eco.miners &&
                Array.isArray(eco.refineries), 'Missing or invalid player eco/minersByPatch');
            for (const refinery of eco.refineries)
                check(refinery && Number.isFinite(refinery.x) && Number.isFinite(refinery.y) &&
                    (refinery.patch === null || knownIds.has(refinery.patch)), 'Invalid sampled refinery');
            check(eco.servedPatches >= new Set(eco.refineries.flatMap(refinery => refinery.patch === null ? [] : [refinery.patch])).size,
                'Invalid sampled servedPatches');
        }
    }
    const initial = match.samples[0].eco, total = initial.oreValue + initial.gemValue;
    const samples = new Map(match.samples.map(sample => [sample.tick, sample]));
    const atTicks = (read: (sample: EcoMatch['samples'][number]) => number): TickValues =>
        Object.fromEntries(ECO_TICKS.map(tick => [tick, samples.has(tick) ? read(samples.get(tick)!) : null])) as TickValues;
    const mined = atTicks(sample => Math.max(0, total - sample.eco.oreValue - sample.eco.gemValue));
    const homeGems = match.ecoMap.patches.filter(patch => patch.isGem && patch.nearestStart === player && patch.distToStart[player] <= 40);
    const firstGem = match.samples.find(sample => homeGems.some(patch => sample.players[player].eco.minersByPatch[patch.id] > 0));
    const final = samples.get(ECO_MAX_TICKS);
    return {
        mined, miners: atTicks(sample => sample.players[player].eco.miners),
        refineries: atTicks(sample => sample.players[player].eco.refineries.length),
        factories: atTicks(sample => (sample.players[player].counts.GAWEAP ?? 0) + (sample.players[player].counts.NAWEAP ?? 0)),
        servedPatches: atTicks(sample => sample.players[player].eco.servedPatches),
        gemShare: initial.gemValue > 0 && final && mined[9000]! > 0 ? (initial.gemValue - final.eco.gemValue) / mined[9000]! : null,
        homeGemPatch: homeGems.length > 0, firstGemMinerTick: firstGem?.tick ?? null,
        maxMinersOnPatch: match.samples.reduce((maximum, sample) =>
            Math.max(maximum, ...Object.values(sample.players[player].eco.minersByPatch)), 0),
        survived: match.ticks === ECO_MAX_TICKS && match.result === 'draw' && match.reason === 'tick-limit',
    };
}

const timedFields = ['mined', 'miners', 'refineries', 'factories', 'servedPatches'] as const;
const scalarFields = ['gemShare', 'homeGemPatch', 'firstGemMinerTick', 'maxMinersOnPatch', 'survived'] as const;
function averages(games: readonly EcoGame[]): { mean: EcoMean; observations: EcoMean } {
    const metrics = games.flatMap(game => game.metrics === null ? [] : [game.metrics]);
    const mean = {} as EcoMean, observations = {} as EcoMean;
    const average = (values: (number | null)[]) => {
        const observed = values.filter((value): value is number => value !== null);
        return { mean: observed.length ? observed.reduce((sum, value) => sum + value, 0) / observed.length : null, count: observed.length };
    };
    for (const field of timedFields) {
        mean[field] = {} as TickValues; observations[field] = {} as TickValues;
        for (const tick of ECO_TICKS) {
            const result = average(metrics.map(metric => metric[field][tick]));
            mean[field][tick] = result.mean; observations[field][tick] = result.count;
        }
    }
    for (const field of scalarFields) {
        const result = average(metrics.map(metric => typeof metric[field] === 'boolean' ? Number(metric[field]) : metric[field] as number | null));
        mean[field] = result.mean; observations[field] = result.count;
    }
    return { mean, observations };
}

/** A usable trial is the exact full-pool schedule, error-free and at least 28 full tick-limit games. */
export function summarizeEconomy(games: readonly EcoGame[], failures: Record<string, string> = {}) {
    const expected = new Set(MAPS.flatMap(map => ECO_COUNTRIES.flatMap(country => [false, true].map(swapped => `${map}__${country}/${swapped}`))));
    const seen = new Set<string>(), issues = Object.entries(failures).map(([id, message]) => `${id}: ${message}`);
    for (const game of games) {
        const key = `${game.map}__${game.country}/${game.swapped}`, index = (MAPS as readonly string[]).indexOf(game.map);
        if (!expected.has(key) || seen.has(key) || typeof game.swapped !== 'boolean' || game.seed !== 7001 + index ||
            game.jobId !== `${game.map}__${game.country}` || game.player !== 0) issues.push(`Invalid/duplicate economic scenario ${key}`);
        seen.add(key);
        if (game.result !== 'error' && (!game.metrics || game.error)) issues.push(`Missing measurements for ${key}`);
    }
    const complete = games.length === expected.size && seen.size === expected.size && [...expected].every(key => seen.has(key));
    const errors = games.filter(game => game.result === 'error').length;
    const failedPairs = new Set([...Object.keys(failures), ...games.filter(game => game.result === 'error' || game.error || !game.metrics)
        .map(game => `${game.map}__${game.country}`)]);
    const measuredGames = games.filter(game => !failedPairs.has(`${game.map}__${game.country}`));
    const survived = measuredGames.filter(game => game.metrics?.survived).length;
    if (!complete) issues.push(`Incomplete trial: expected ${expected.size} unique games`);
    if (errors) issues.push(`${errors} error games`);
    if (survived < 28) issues.push(`Only ${survived} survived; at least 28 required`);
    return { valid: issues.length === 0, complete, expectedGames: expected.size, completedGames: games.length, errors, survived, failures, issues,
        byMap: MAPS.map(map => { const rows = games.filter(game => game.map === map); return { map, games: rows.length, ...averages(measuredGames.filter(game => game.map === map)) }; }),
        ...averages(measuredGames) };
}

export function ecoMarkdown(report: { member: string; tree: string } & ReturnType<typeof summarizeEconomy>): string {
    const number = (value: number | null) => value === null ? '—' : value.toFixed(2);
    const lines = [`# ${report.member} 经济试跑`, '', `BUILTIN tree: \`${report.tree}\``, '',
        `有效: ${report.valid}；完整对局: ${report.completedGames}/${report.expectedGames}；error: ${report.errors}；survived: ${report.survived}`, '',
        '| 地图 | mined[5400] | mined[7200] | mined[9000] | miners[7200] | refineries[9000] | servedPatches[9000] | gemShare | firstGemMinerTick |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
    const row = (map: string, mean: EcoMean) => `| ${map} | ${[mean.mined[5400], mean.mined[7200], mean.mined[9000], mean.miners[7200],
        mean.refineries[9000], mean.servedPatches[9000], mean.gemShare, mean.firstGemMinerTick].map(number).join(' | ')} |`;
    for (const map of report.byMap) lines.push(row(map.map, map.mean));
    lines.push(row('全部', report.mean), '', '均值只包含实际观测；缺失的未来采样、无宝石/零采矿的 gemShare、未到达宝石的 tick 为 null，不补零。各列观测数见 eco.json 的 observations。',
        '普通矿再生不作修正；mined 是全图资源价值净减少量。');
    if (report.issues.length) lines.push('', '无效原因：', ...report.issues.map(issue => `- ${issue}`));
    return lines.join('\n') + '\n';
}

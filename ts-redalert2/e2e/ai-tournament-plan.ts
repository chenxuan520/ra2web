/** Stable game names from Rules.getMultiplayerCountries(), not translated UI labels. */
export const TOURNAMENT_COUNTRIES = ['Americans', 'Alliance', 'French', 'Germans', 'British', 'Africans', 'Arabs', 'Confederation', 'Russians'];
export const COUNTRY_LABELS: Record<string, string> = {
    Americans: '美国', Alliance: '韩国', French: '法国', Germans: '德国', British: '英国',
    Africans: '利比亚', Arabs: '伊拉克', Confederation: '古巴', Russians: '苏俄',
};
export type Scenario = { map: string; seed: number };
export type TournamentJob = Scenario & { id: string; candidateCountry: string; baselineCountry: string };

export function createTournamentJobs(countries: string[], scenarios: Scenario[]): TournamentJob[] {
    if (new Set(countries).size !== countries.length || countries.some(country => !TOURNAMENT_COUNTRIES.includes(country))) {
        throw new Error('Countries must be unique supported game country names');
    }
    if (countries.length < 2) throw new Error('At least two countries are required');
    const keys = scenarios.map(scenario => `${scenario.map}:${scenario.seed}`);
    if (!scenarios.length || new Set(keys).size !== keys.length) throw new Error('Scenarios must be nonempty and unique');
    if (scenarios.some(scenario => !/^[a-zA-Z0-9_-]+(?:\.map|\.mpr)?$/.test(scenario.map) || !Number.isSafeInteger(scenario.seed) || scenario.seed < 0)) {
        throw new Error('Scenario maps must be local map names and seeds must be nonnegative integers');
    }
    const jobs: TournamentJob[] = [];
    for (const scenario of scenarios) for (const candidateCountry of countries) for (const baselineCountry of countries) {
        if (candidateCountry === baselineCountry) continue;
        jobs.push({ ...scenario, candidateCountry, baselineCountry,
            id: `${scenario.map.replace(/\.(map|mpr)$/, '')}-${scenario.seed}__${candidateCountry}-vs-${baselineCountry}` });
    }
    if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error('Map aliases would overwrite duplicate job IDs');
    return jobs;
}

export function validateJobReport(report: any, job: TournamentJob, expected: {
    candidateCommit: string; baselineCommit: string; engineCommit: string; candidateProfile: string; baselineProfile: string;
    maxTicks: number; sampleTicks: number; credits: number; unitCount: number; mapSha256: string;
    iniSha256: string; customIniSha256: string; terrainSha256?: string;
}): boolean {
    const fail = (message: string): never => { throw new Error(`${job.id}: ${message}`); };
    if (report.candidate?.commit !== expected.candidateCommit || report.baseline?.commit !== expected.baselineCommit) fail('bot snapshot mismatch');
    if (report.candidate?.profile !== expected.candidateProfile || report.baseline?.profile !== expected.baselineProfile) fail('bot profile mismatch');
    if (report.candidate?.dirty || report.candidate?.source === 'working-tree') fail('candidate was not frozen');
    if (report.engineCommit !== expected.engineCommit || report.engineDirty) fail('engine snapshot mismatch or dirty engine');
    const settings = report.settings;
    for (const key of ['maxTicks', 'sampleTicks', 'credits', 'unitCount'] as const) if (settings?.[key] !== expected[key]) fail(`setting mismatch: ${key}`);
    if (settings?.engineDifficulty !== 4 || !settings.pairedSpawnSwap || !settings.pairedPlayerOrderSwap) fail('fairness settings mismatch');
    if (settings.gameSpeed !== 3 || settings.simulationTicksPerSecond !== 15 || settings.shortGame !== true ||
        settings.superWeapons !== false || settings.crates !== false || settings.engineStalemateDetection !== false) fail('game rules mismatch');
    if (report.resources?.iniSha256 !== expected.iniSha256 || report.resources?.customIniSha256 !== expected.customIniSha256) fail('resource rules mismatch');
    if (!Array.isArray(report.matches) || report.matches.length > 2) fail('invalid match count');
    const swaps = new Set<boolean>();
    for (const match of report.matches) {
        if (match.seed !== job.seed || match.candidateCountry !== job.candidateCountry || match.baselineCountry !== job.baselineCountry ||
            match.map.replace(/\.(map|mpr)$/, '') !== job.map.replace(/\.(map|mpr)$/, '') || match.mapSha256 !== expected.mapSha256 ||
            (expected.terrainSha256 && match.terrainSha256 !== expected.terrainSha256)) fail('scenario mismatch');
        if (typeof match.swapped !== 'boolean' || swaps.has(match.swapped)) fail('duplicate or invalid swap');
        swaps.add(match.swapped);
        if (match.candidatePlayerName !== (match.swapped ? '@@AI2@@' : '@@AI1@@') ||
            match.baselinePlayerName !== (match.swapped ? '@@AI1@@' : '@@AI2@@')) fail('player order mismatch');
        if (!['candidate-win', 'baseline-win', 'draw', 'error'].includes(match.result)) fail('invalid result');
        if (match.result === 'draw' && match.reason === 'tick-limit' && match.ticks !== expected.maxTicks) fail('premature timeout');
        if (match.result !== 'error' && (match.telemetry?.errorCount || match.error || match.disposeError)) fail('runtime error counted as a valid result');
        if ((match.result === 'candidate-win' || match.result === 'baseline-win') && match.reason !== 'engine-victory-conditions') fail('winner was not determined by the engine');
        if (match.result !== 'error' && (!Number.isSafeInteger(match.ticks) || match.ticks < 1 || match.ticks > expected.maxTicks)) fail('invalid elapsed ticks');
    }
    if (report.matches.length === 2 && report.matches.every((match: any) => match.startingLocations?.length === 2)) {
        const first = report.matches.find((match: any) => !match.swapped);
        const second = report.matches.find((match: any) => match.swapped);
        if (JSON.stringify(first.startingLocations) !== JSON.stringify([...second.startingLocations].reverse())) fail('starting positions were not swapped');
    }
    return report.matches.length === 2;
}

type Counts = { wins: number; losses: number; draws: number; errors: number; total: number };
const emptyCounts = (): Counts => ({ wins: 0, losses: 0, draws: 0, errors: 0, total: 0 });
const withRates = (counts: Counts, expectedGames: number) => ({ ...counts, expectedGames, pending: expectedGames - counts.total,
    winRateValid: counts.wins + counts.losses + counts.draws ? counts.wins / (counts.wins + counts.losses + counts.draws) : null,
    winRateAllRecorded: counts.total ? counts.wins / counts.total : null,
    winRateDecisive: counts.wins + counts.losses ? counts.wins / (counts.wins + counts.losses) : null });

export function summarizeTournament(jobs: TournamentJob[], reports: Map<string, any>) {
    const total = emptyCounts();
    const byCountry: Record<string, Counts> = {};
    const matrix: Record<string, Record<string, Counts>> = {};
    const expectedByCountry: Record<string, number> = {};
    const expectedByPair: Record<string, Record<string, number>> = {};
    for (const job of jobs) {
        byCountry[job.candidateCountry] ??= emptyCounts();
        (matrix[job.candidateCountry] ??= {})[job.baselineCountry] ??= emptyCounts();
        expectedByCountry[job.candidateCountry] = (expectedByCountry[job.candidateCountry] ?? 0) + 2;
        const expected = expectedByPair[job.candidateCountry] ??= {};
        expected[job.baselineCountry] = (expected[job.baselineCountry] ?? 0) + 2;
        // Each planned job is visited once. Resume reports replace their own job, never append matches twice.
        const swaps = new Set<boolean>();
        for (const match of reports.get(job.id)?.matches ?? []) {
            if (swaps.has(match.swapped)) throw new Error(`${job.id}: duplicate match in summary`);
            swaps.add(match.swapped);
            const key = ({ 'candidate-win': 'wins', 'baseline-win': 'losses', draw: 'draws', error: 'errors' } as const)[match.result];
            if (!key) throw new Error(`${job.id}: unknown result`);
            for (const counts of [total, byCountry[job.candidateCountry], matrix[job.candidateCountry][job.baselineCountry]]) {
                counts[key]++; counts.total++;
            }
        }
    }
    return {
        rateDefinitions: {
            winRateValid: 'wins / (wins + losses + draws); primary rate, invalid error games reported separately',
            winRateAllRecorded: 'wins / (wins + losses + draws + errors); unplayed games are pending, never wins',
            winRateDecisive: 'wins / (wins + losses); excludes both draws and errors; null when no decisive games',
        },
        total: withRates(total, jobs.length * 2),
        byCountry: Object.fromEntries(Object.entries(byCountry).map(([country, counts]) => [country, withRates(counts, expectedByCountry[country])])),
        matrix: Object.fromEntries(Object.entries(matrix).map(([country, opponents]) => [country,
            Object.fromEntries(Object.entries(opponents).map(([opponent, counts]) => [opponent, withRates(counts, expectedByPair[country][opponent])]))])),
    };
}

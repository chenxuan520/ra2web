export const MAPS = ['mp08t2', 'tn01t2', 'mp11t2', 'tn04t2', 'mp06t2', 'mp29u2', 'mp31s2', 'mp02t2'] as const;
export const MATCHUPS = [
    ['Americans', 'Americans'], ['Russians', 'Russians'],
    ['Americans', 'Russians'], ['Russians', 'Americans'],
] as const;
export type Kind = 'qualify' | 'dev' | 'evolve';
export type Country = typeof MATCHUPS[number][number];
export type GameResult = 'a-win' | 'b-win' | 'timeout' | 'error';
export interface LeagueJob {
    id: string;
    a: string;
    b: string;
    map: string;
    seed: number;
    aCountry: Country;
    bCountry: Country;
}
export interface LeagueGame {
    round: number;
    kind: Kind;
    a: string;
    b: string;
    aTree: string;
    bTree: string;
    map: string;
    seed: number;
    aCountry: Country;
    bCountry: Country;
    swapped: boolean;
    result: GameResult;
    reason: string;
    ticks: number;
}
export function seedFor(round: number, mapIndex: number, kind: Kind, generation?: number): number {
    if (!Number.isSafeInteger(round) || round < 0 || !Number.isInteger(mapIndex) || mapIndex < 1 || mapIndex > MAPS.length ||
        !['qualify', 'dev', 'evolve'].includes(kind)) throw new Error('Invalid league seed inputs');
    if (kind === 'evolve' ? !Number.isInteger(generation) || generation! < 0 || generation! > 39 : generation !== undefined)
        throw new Error('Evolve generation must be 0-39 and is only valid for evolve seeds');
    const seed = round * 1000 + (kind === 'evolve' ? 600 + generation! * 10 : kind === 'dev' ? 500 : 0) + mapIndex;
    if (!Number.isSafeInteger(seed)) throw new Error('League seed exceeds safe integer range');
    return seed;
}
export function jobId(job: Omit<LeagueJob, 'id'>): string {
    return `${job.a}__${job.b}__${job.map}__${job.seed}__${job.aCountry}-${job.bCountry}`;
}
export function mapsForRound(round: number): string[] {
    if (round <= 3) return MAPS.slice(0, 3);
    return [0, 1, 2].map(index => MAPS[(2 * (round - 4) + 2 + index) % MAPS.length]);
}
export function pairingJobs(a: string, b: string, round: number, kind: Kind, generation?: number): LeagueJob[] {
    if (![a, b].every(id => /^[a-z][a-z0-9-]*$/.test(id))) throw new Error('Invalid pairing member id');
    return mapsForRound(round).flatMap(map => MATCHUPS.map(([aCountry, bCountry]) => {
        const job = { a, b, map, seed: seedFor(round, (MAPS as readonly string[]).indexOf(map) + 1, kind, generation), aCountry, bCountry };
        return { id: jobId(job), ...job };
    }));
}
export function lightPairingJobs(a: string, b: string, round: number, kind: Kind, generation?: number): LeagueJob[] {
    const maps = mapsForRound(round).slice(0, 2);
    return pairingJobs(a, b, round, kind, generation).filter(job => maps.includes(job.map));
}
export function roundRobinJobs(members: string[], round: number, kind: Kind, generation?: number): LeagueJob[] {
    if (new Set(members).size !== members.length) throw new Error('Duplicate round-robin member');
    return members.flatMap((a, index) => members.slice(index + 1).flatMap(b => pairingJobs(a, b, round, kind, generation)));
}
export function shardJobs(jobs: readonly LeagueJob[], shard: string): LeagueJob[] {
    const match = /^(\d+)\/(\d+)$/.exec(shard);
    const shardIndex = Number(match?.[1]), shardCount = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(shardIndex) || !Number.isSafeInteger(shardCount) ||
        shardCount < 1 || shardIndex < 0 || shardIndex >= shardCount) throw new Error(`Invalid shard ${shard}; expected I/M with 0 <= I < M`);
    return [...jobs].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        .filter((_, index) => index % shardCount === shardIndex);
}
export function convertResult(result: string): GameResult {
    const value = ({ 'candidate-win': 'a-win', 'baseline-win': 'b-win', draw: 'timeout', error: 'error' } as const)[result];
    if (!value) throw new Error(`Unknown benchmark result ${result}`);
    return value;
}
export function compareGames(a: LeagueGame, b: LeagueGame): number {
    const left = jobId(a), right = jobId(b);
    return (left < right ? -1 : left > right ? 1 : 0) || Number(a.swapped) - Number(b.swapped);
}
export function assertSelfMirror(games: LeagueGame[]): void {
    const sameCountry = games.filter(game => game.a === game.b && game.aCountry === game.bCountry);
    const pairs = new Map<string, LeagueGame[]>();
    for (const game of sameCountry) {
        const id = jobId(game), pair = pairs.get(id) ?? []; pair.push(game); pairs.set(id, pair);
    }
    for (const [id, pair] of pairs) {
        const a = pair.find(game => !game.swapped), b = pair.find(game => game.swapped);
        if (pair.length !== 2 || !a || !b || a.aTree !== a.bTree || a.aTree !== b.aTree || a.bTree !== b.bTree || a.ticks !== b.ticks ||
            !((a.result === 'timeout' && b.result === 'timeout') ||
                (a.result === 'a-win' && b.result === 'b-win') || (a.result === 'b-win' && b.result === 'a-win'))) {
            throw new Error(`Same-member same-country match is not mirrored: ${id}`);
        }
    }
}

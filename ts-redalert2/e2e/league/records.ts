import { MATCHUPS, MAPS, seedFor, jobId, type LeagueGame, type LeagueJob } from './schedule';
import type { League } from './registry';

export interface Stats { wins: number; losses: number; timeouts: number; total: number; winTicks: number[] }
const fields = ['round', 'kind', 'a', 'b', 'aTree', 'bTree', 'map', 'seed', 'aCountry', 'bCountry', 'swapped', 'result', 'reason', 'ticks'];
export function gameKey(game: LeagueGame): string { return `${game.round}/${game.kind}/${game.aTree}/${game.bTree}/${jobId(game)}/${game.swapped}`; }
export function validateGame(value: unknown): asserts value is LeagueGame {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Game row must be an object');
    const game = value as LeagueGame;
    if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error('Game row fields are incomplete');
    if (!Number.isSafeInteger(game.round) || game.round < 0 || !['qualify', 'dev'].includes(game.kind)) throw new Error('Invalid game round/kind');
    if (![game.a, game.b].every(id => typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id)) ||
        ![game.aTree, game.bTree].every(tree => typeof tree === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree))) throw new Error('Invalid game member identity');
    const index = (MAPS as readonly string[]).indexOf(game.map);
    if (index < 0 || game.seed !== seedFor(game.round, index + 1, game.kind) ||
        !MATCHUPS.some(([a, b]) => a === game.aCountry && b === game.bCountry)) throw new Error('Invalid game scenario or seed');
    if (typeof game.swapped !== 'boolean' || !['a-win', 'b-win', 'timeout', 'error'].includes(game.result) ||
        typeof game.reason !== 'string' || !game.reason || !Number.isSafeInteger(game.ticks) || game.ticks < 0 || game.ticks > 27000) throw new Error('Invalid game result fields');
    if ((game.result === 'a-win' || game.result === 'b-win') && (game.reason !== 'engine-victory-conditions' || game.ticks < 1)) throw new Error('Non-native win');
    if (game.result === 'timeout' && game.reason === 'tick-limit' && game.ticks !== 27000) throw new Error('Premature timeout');
}
export function parseGames(text: string): LeagueGame[] {
    return text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
        try { const game: unknown = JSON.parse(line); validateGame(game); return game; }
        catch (error) { throw new Error(`Invalid game line ${index + 1}: ${error instanceof Error ? error.message : error}`); }
    });
}
export function validateSchedule(games: readonly LeagueGame[], jobs: readonly LeagueJob[], league: League, round: number, unknown: string[] = []): void {
    const expected = new Set(jobs.flatMap(job => [false, true].map(swapped => `${job.id}/${swapped}`)));
    const seen = new Set<string>(), trees = new Map<string, string>();
    if (!jobs.length || games.length !== expected.size) throw new Error(`Incomplete schedule: ${games.length}/${expected.size} games`);
    for (const game of games) {
        validateGame(game);
        if (game.round !== round || game.kind !== 'qualify') throw new Error('Only this round qualification seeds may be admitted');
        const key = `${jobId(game)}/${game.swapped}`;
        if (!expected.has(key) || seen.has(key)) throw new Error(`Unexpected or duplicate game ${key}`); seen.add(key);
        if (game.result === 'error') throw new Error('Runtime error invalidates qualification');
        for (const [id, tree] of [[game.a, game.aTree], [game.b, game.bTree]]) {
            const member = league.members.find(member => member.id === id);
            if (member ? tree !== member.tree : !unknown.includes(id)) throw new Error(`Unknown or changed tree for ${id}`);
            if (trees.has(id) && trees.get(id) !== tree) throw new Error(`Candidate tree changed during qualification: ${id}`);
            trees.set(id, tree);
        }
    }
}
export function statsFor(games: readonly LeagueGame[], id: string, opponents?: readonly string[]): Stats {
    const stats: Stats = { wins: 0, losses: 0, timeouts: 0, total: 0, winTicks: [] };
    for (const game of games) {
        if (game.a === game.b || game.result === 'error' || (game.a !== id && game.b !== id)) continue;
        const opponent = game.a === id ? game.b : game.a;
        if (opponents && !opponents.includes(opponent)) continue;
        stats.total++;
        const winner = game.result === 'a-win' ? game.a : game.result === 'b-win' ? game.b : null;
        if (winner === id) { stats.wins++; stats.winTicks.push(game.ticks); }
        else if (winner) stats.losses++;
        else stats.timeouts++;
    }
    return stats;
}
export function median(values: readonly number[]): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b), index = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[index] : (sorted[index - 1] + sorted[index]) / 2;
}

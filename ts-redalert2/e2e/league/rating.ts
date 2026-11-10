import { parseArgs } from 'node:util';
import type { LeagueGame } from './schedule';
import { parseGames } from './records';

/** Bradley-Terry MM, with a fixed-strength virtual opponent and 1W/1L prior per member. */
export function computeRatings(games: readonly LeagueGame[]): Record<string, number> {
    const valid = games.filter(game => game.result !== 'error');
    const ids = [...new Set(valid.flatMap(game => [game.a, game.b]))].sort();
    const wins = new Map(ids.map(id => [id, 1]));
    const counts = new Map(ids.map(id => [id, new Map<string, number>()]));
    for (const game of valid) {
        if (game.a === game.b) continue; // Selfchecks carry no information about relative strength.
        const aScore = game.result === 'a-win' ? 1 : game.result === 'timeout' ? 0.5 : 0;
        wins.set(game.a, wins.get(game.a)! + aScore); wins.set(game.b, wins.get(game.b)! + 1 - aScore);
        counts.get(game.a)!.set(game.b, (counts.get(game.a)!.get(game.b) ?? 0) + 1);
        counts.get(game.b)!.set(game.a, (counts.get(game.b)!.get(game.a) ?? 0) + 1);
    }
    let strength = new Map(ids.map(id => [id, 1]));
    for (let iteration = 0; iteration < 200; iteration++) {
        const next = new Map<string, number>();
        for (const id of ids) {
            const own = strength.get(id)!;
            let denominator = 2 / (own + 1);
            for (const [opponent, number] of counts.get(id)!) denominator += number / (own + strength.get(opponent)!);
            next.set(id, wins.get(id)! / denominator);
        }
        strength = next;
    }
    return Object.fromEntries(ids.map(id => [id, Math.round(1500 + 400 * Math.log10(strength.get(id)!))]));
}
if (import.meta.main) {
    try {
        const { values } = parseArgs({ options: { games: { type: 'string' } } });
        if (!values.games) throw new Error('Usage: bun e2e/league/rating.ts --games FILE');
        const text = await Bun.file(values.games).text();
        console.log(JSON.stringify(computeRatings(parseGames(text)), null, 2));
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

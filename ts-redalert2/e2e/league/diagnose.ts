import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseGames } from './records';
import { jobId, convertResult } from './schedule';
import { diagnoseGame, summarizeWeaknesses, weaknessMarkdown, type DiagnosedGame, type WeaknessReport } from './diagnoseCore';

export async function diagnoseDirectory(directory: string, member: string): Promise<WeaknessReport> {
    const games = parseGames(await Bun.file(resolve(directory, 'games.jsonl')).text());
    if (!games.some(game => game.a === member || game.b === member)) throw new Error(`Member ${member} is not in this run`);
    if (games.some(game => game.result === 'error')) throw new Error('An errored run cannot provide a complete weakness diagnosis');
    const reports = new Map<string, any>(), records: DiagnosedGame[] = [];
    for (const game of games) {
        const winner = game.result === 'a-win' ? game.a : game.result === 'b-win' ? game.b : null;
        if (game.a === game.b || (game.a !== member && game.b !== member) || winner === member) continue;
        const id = jobId(game);
        if (!reports.has(id)) reports.set(id, await Bun.file(resolve(directory, 'jobs', `${id}.json`)).json());
        const report = reports.get(id);
        if (!Array.isArray(report.matches)) throw new Error(`Missing paired matches in ${id}`);
        const matches = report.matches.filter((match: any) => match.swapped === game.swapped && match.seed === game.seed &&
            match.candidateCountry === game.aCountry && match.baselineCountry === game.bCountry && match.map === `${game.map}.map`);
        if (matches.length !== 1) throw new Error(`Missing or duplicated benchmark match ${id}/${game.swapped}`);
        const match = matches[0];
        if (convertResult(match.result) !== game.result || match.reason !== game.reason || match.ticks !== game.ticks || match.samples?.at(-1)?.tick !== game.ticks)
            throw new Error(`Benchmark result or final sample differs from ${id}/${game.swapped}`);
        const diagnosis = diagnoseGame(game, member, match.samples);
        if (diagnosis) records.push(diagnosis);
    }
    return summarizeWeaknesses(games, member, records);
}

export async function main() {
    const { values } = parseArgs({ options: { dir: { type: 'string' }, member: { type: 'string' }, out: { type: 'string' } } });
    if (!values.dir || !values.member || !values.out) throw new Error('Usage: bun e2e/league/diagnose.ts --dir DIR --member ID --out DIR');
    const report = await diagnoseDirectory(resolve(values.dir), values.member), output = resolve(values.out);
    await mkdir(output, { recursive: true });
    await Bun.write(resolve(output, 'weakness.json'), JSON.stringify(report, null, 2) + '\n');
    await Bun.write(resolve(output, 'weakness.md'), weaknessMarkdown(report));
    console.log(JSON.stringify({ member: report.member, nonWins: report.records.length, weaknesses: report.weaknesses.length, opponents: report.opponents.length, output }, null, 2));
}
if (import.meta.main) {
    try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

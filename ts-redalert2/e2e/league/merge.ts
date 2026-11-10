import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { FrozenMember } from './run';
import { shardJobs, jobId, compareGames, assertSelfMirror, type Kind, type LeagueGame, type LeagueJob } from './schedule';
import { parseGames, validateGame } from './records';

export interface ShardOutput {
    manifest: { schema: number; fingerprint: string; config: {
        round: number; kind: Kind; versions: Record<string, FrozenMember>; jobs: LeagueJob[]; shard: string | null;
        [key: string]: unknown;
    } };
    games: LeagueGame[];
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function mergeShards(outputs: readonly ShardOutput[]): LeagueGame[] {
    if (!outputs.length) throw new Error('No league shards provided');
    let frozen: string | undefined;
    const seen = new Set<string>(), games: LeagueGame[] = [];
    for (const { manifest, games: rows } of outputs) {
        const config = manifest.config;
        if (manifest.schema !== 1 || manifest.fingerprint !== hash(JSON.stringify(config)) || !Array.isArray(config.jobs) || !config.jobs.length)
            throw new Error('Invalid league shard manifest');
        const { shard, ...common } = config, serialized = JSON.stringify(common);
        if (frozen !== undefined && frozen !== serialized) throw new Error('Shards have different frozen schedules, versions or runtimes');
        frozen = serialized;
        const jobs = shard === null ? config.jobs : shardJobs(config.jobs, shard);
        const expected = new Set(jobs.flatMap(job => [false, true].map(swapped => `${job.id}/${swapped}`)));
        if (rows.length !== expected.size) throw new Error(`Incomplete shard ${shard ?? 'all'}: ${rows.length}/${expected.size} games`);
        for (const game of rows) {
            validateGame(game);
            const key = `${jobId(game)}/${game.swapped}`;
            if (!expected.has(key) || seen.has(key)) throw new Error(`Unexpected or duplicate game ${key}`);
            if (game.round !== config.round || game.kind !== config.kind || game.aTree !== config.versions[game.a]?.tree ||
                game.bTree !== config.versions[game.b]?.tree) throw new Error(`Game identity differs from frozen manifest: ${key}`);
            seen.add(key); games.push(game);
        }
    }
    const total = outputs[0].manifest.config.jobs.length * 2;
    if (seen.size !== total) throw new Error(`Missing league jobs: ${seen.size}/${total} games`);
    games.sort(compareGames);
    if (!games.some(game => game.result === 'error')) assertSelfMirror(games);
    return games;
}
if (import.meta.main) {
    try {
        const { values } = parseArgs({ options: { in: { type: 'string' }, out: { type: 'string' } } });
        if (!values.in || !values.out) throw new Error('Usage: bun e2e/league/merge.ts --in DIR1,DIR2,... --out FILE');
        const outputs = await Promise.all(values.in.split(',').map(async directory => ({
            manifest: await Bun.file(resolve(directory, 'manifest.json')).json(),
            games: parseGames(await Bun.file(resolve(directory, 'games.jsonl')).text()),
        })));
        const games = mergeShards(outputs), path = resolve(values.out);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, games.map(game => JSON.stringify(game)).join('\n') + '\n');
        console.log(JSON.stringify({ games: games.length, file: path }));
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

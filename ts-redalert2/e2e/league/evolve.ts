import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BUILTIN, REPO_ROOT, gitQuery, loadLeague } from './registry';
import { parseGames, statsFor } from './records';
import { generateMutants, parseParams, replaceParams, parameterDiff, selectMutation, type Params } from './evolveCore';

const projectRoot = resolve(import.meta.dir, '../..');
const parameterPath = `${BUILTIN}/bot/strategy/brutalParams.ts`;
function integer(value: string | undefined, name: string, minimum = 1): number {
    const number = Number(value);
    if (!value || !Number.isSafeInteger(number) || number < minimum) throw new Error(`Invalid --${name}`);
    return number;
}
async function indexedGit(args: string[], index: string): Promise<string> {
    const child = Bun.spawn(['git', ...args], { cwd: REPO_ROOT, env: { ...process.env, GIT_INDEX_FILE: index }, stdout: 'pipe', stderr: 'pipe' });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(`git ${args[0]}: ${errors.trim()}`);
    return output.trim();
}
export async function main() {
    const started = performance.now();
    const { values } = parseArgs({ options: { round: { type: 'string' }, generations: { type: 'string', default: '5' },
        concurrency: { type: 'string', default: '4' }, out: { type: 'string' }, cdn: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) {
        console.log('bun e2e/league/evolve.ts --round N --generations 5 --concurrency K --out DIR [--cdn PATH]'); return;
    }
    const round = integer(values.round, 'round'), generations = integer(values.generations, 'generations'), concurrency = integer(values.concurrency, 'concurrency');
    if (generations > 40) throw new Error('--generations must be 1-40');
    if (!values.out) throw new Error('--out is required');
    const cdn = values.cdn ?? process.env.RA2_BENCHMARK_CDN;
    if (!cdn) throw new Error('Pass --cdn or set RA2_BENCHMARK_CDN');
    const base = await gitQuery(['rev-parse', 'refs/heads/master']);
    if (base !== await gitQuery(['rev-parse', 'HEAD'])) throw new Error('Evolution must start from the frozen master HEAD');
    if (await gitQuery(['status', '--porcelain', '--untracked-files=all', '--', BUILTIN])) throw new Error('Freeze BUILTIN before evolution');
    if (await gitQuery(['for-each-ref', '--format=%(refname)', 'refs/league-scratch/'])) throw new Error('Existing league-scratch refs must be resolved before a new search');
    const sourcePath = resolve(REPO_ROOT, parameterPath), initialSource = await Bun.file(sourcePath).text();
    if (initialSource.trim() !== await gitQuery(['show', `${base}:${parameterPath}`])) throw new Error('Working parameters differ from frozen master');
    const initial = parseParams(initialSource), league = await loadLeague();
    if (!league.champion) throw new Error('Select the initial league champion before evolution');
    const exploiters = league.members.filter(member => member.active && member.role === 'exploiter')
        .sort((a, b) => (b.winsVsTarget ?? 0) - (a.winsVsTarget ?? 0) || league.members.indexOf(a) - league.members.indexOf(b)).slice(0, 3);
    const opponents = [league.champion, ...exploiters.map(member => member.id)];
    const output = resolve(values.out), scratch = join(output, 'scratch');
    let entries: string[] = [];
    try { entries = await readdir(output); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (entries.length) throw new Error('Choose a new evolution output directory; previous evidence will not be overwritten');
    await mkdir(scratch, { recursive: true });
    await writeFile(join(output, 'manifest.json'), JSON.stringify({ round, generations, concurrency, base, opponents, initial }, null, 2) + '\n');
    const ownedRefs: { ref: string; commit: string }[] = [], active = new Set<ReturnType<typeof Bun.spawn>>();
    const history: unknown[] = [];
    let parent: Params = initial, stopped = false;
    const stop = () => { stopped = true; for (const child of active) child.kill(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
        for (let generation = 0; generation < generations; generation++) {
            if (stopped) throw new Error('Evolution interrupted');
            const mutants = generateMutants(parent, round * 100 + generation);
            const individuals = [parent, ...mutants].map((params, index) => ({ id: index === 0 ? 'p' : `u${index}`, params, index, commit: '' }));
            for (const individual of individuals) {
                const name = `r${round}-g${generation}-m${individual.index}`, file = join(scratch, `${name}.ts`), index = join(scratch, `${name}.index`);
                await writeFile(file, replaceParams(initialSource, individual.params));
                const blob = await gitQuery(['hash-object', '-w', file]);
                try {
                    await indexedGit(['read-tree', base], index);
                    await indexedGit(['update-index', '--add', '--cacheinfo', `100644,${blob},${parameterPath}`], index);
                    const tree = await indexedGit(['write-tree'], index);
                    individual.commit = await gitQuery(['commit-tree', tree, '-p', base, '-m', `league-scratch ${name}`]);
                    const ref = `refs/league-scratch/${name}`;
                    await gitQuery(['update-ref', ref, individual.commit, '']); ownedRefs.push({ ref, commit: individual.commit });
                } finally { await rm(index, { force: true }); await rm(`${index}.lock`, { force: true }); }
            }
            const directory = join(output, `generation-${generation}`); await mkdir(directory, { recursive: true });
            const fitness: { id: string; wins: number; losses: number; timeouts: number; total: number }[] = [];
            const perRun = Math.max(1, Math.floor(concurrency / individuals.length));
            const workers = Math.min(individuals.length, Math.floor(concurrency / perRun));
            let next = 0, failure: unknown;
            const worker = async () => {
                while (!stopped && next < individuals.length) {
                    const individual = individuals[next++], resultDirectory = join(directory, individual.id);
                    try {
                        const command = [process.execPath, 'e2e/league/run.ts', '--round', String(round), '--kind', 'evolve', '--generation', String(generation),
                            '--ref', `${individual.id}=${individual.commit}`, '--a', individual.id, '--vs', opponents.join(','),
                            '--concurrency', String(perRun), '--cdn', resolve(cdn), '--out', resultDirectory];
                        const child = Bun.spawn(command, { cwd: projectRoot, stdout: 'ignore', stderr: Bun.file(join(directory, `${individual.id}.log`)) });
                        active.add(child); const code = await child.exited; active.delete(child);
                        if (code) throw new Error(`Evolution match run failed for g${generation}/${individual.id}; inspect its raw reports`);
                        const games = parseGames(await Bun.file(join(resultDirectory, 'games.jsonl')).text());
                        if (games.length !== opponents.length * 16 || games.some(game => game.result === 'error' || game.a !== individual.id || game.kind !== 'evolve' || game.round !== round))
                            throw new Error(`Invalid evolution fitness for ${individual.id}`);
                        const stats = statsFor(games, individual.id);
                        fitness[individual.index] = { id: individual.id, wins: stats.wins, losses: stats.losses, timeouts: stats.timeouts, total: stats.total };
                        console.error(`g${generation} ${individual.id}: ${stats.wins}/${stats.losses}/${stats.timeouts}`);
                    } catch (error) { failure ??= error; stop(); }
                }
            };
            await Promise.all(Array.from({ length: workers }, worker));
            if (failure || stopped || fitness.length !== individuals.length || fitness.some(row => !row)) throw failure ?? new Error('Evolution generation incomplete');
            const winner = selectMutation(fitness[0].wins, fitness.slice(1).map(row => row.wins));
            if (winner !== null) parent = individuals[winner + 1].params;
            const report = { generation, mutationSeed: round * 100 + generation, fitness, selected: winner === null ? 'p' : individuals[winner + 1].id };
            history.push(report); await writeFile(join(directory, 'fitness.json'), JSON.stringify(report, null, 2) + '\n');
            console.log(JSON.stringify(report));
        }
        if (await Bun.file(sourcePath).text() !== initialSource) throw new Error('Working parameters changed during evolution; refusing to overwrite them');
        const diff = parameterDiff(initial, parent), summary = { round, generations, opponents, history, diff, wallSeconds: (performance.now() - started) / 1000 };
        await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
        await writeFile(sourcePath, replaceParams(initialSource, parent));
        console.log('parameter\tbefore\tafter');
        for (const row of diff) console.log(`${row.parameter}\t${row.before}\t${row.after}`);
        console.log(JSON.stringify({ wallSeconds: summary.wallSeconds, changedParameters: diff.length, output }, null, 2));
    } finally {
        process.off('SIGINT', stop); process.off('SIGTERM', stop);
        for (const { ref, commit } of ownedRefs) await gitQuery(['update-ref', '-d', ref, commit]);
    }
}
if (import.meta.main) {
    try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

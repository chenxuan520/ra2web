import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BUILTIN, REPO_ROOT, loadLeague } from '../registry';
import { trainJobs, jobId, type ArenaJob } from './arena';
import { buildCommit, git, PARAMETER_PATH } from './commit';
import { chooseCandidate, measureFitness, population, selectParents, type Child, type Fitness } from './evolveCore';
import { parseGenome, renderGenome, validateGenome, type Genome, type ParamSpace } from './paramSpace';
import type { ArenaGame } from './play';

const projectRoot = resolve(REPO_ROOT, 'ts-redalert2');
const stateRoot = join(projectRoot, '.artifacts/p4/evo-state');
interface State {
    run: number; champion: string; baseCommit: string; generation: number; parents: Genome[]; parentOrigins: string[];
    history: { generation: number; bestScore: number; controlScore: number; lead: number; seconds: number }[];
    earlyStop: boolean; fromRun?: number; seedOn?: string;
}
interface Individual extends Child { index: number; id: string; origin: string; commit: string; tree: string }
interface Manifest { run: number; generation: number; baseCommit: string; individuals: Individual[]; opponents: Record<string, string>; spawnSeconds: number }
const runFolder = (run: number) => join(stateRoot, 'runs', String(run));
const generationFolder = (run: number, generation: number) => join(runFolder(run), `g${generation}`);
const rawFolder = (run: number, generation: number) => join(projectRoot, `.artifacts/p4/run-${run}/g${generation}`);
async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')); }
async function save(path: string, value: unknown) {
    await mkdir(resolve(path, '..'), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n'); await rename(temporary, path);
}
async function state(run: number): Promise<State> { return json(join(runFolder(run), 'state.json')); }
function integer(value: string | undefined, name: string, min: number, max: number): number {
    const number = Number(value); if (value === undefined || !Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Invalid --${name}`);
    return number;
}
async function inputs(s: State) {
    const source = await git(['show', `${s.baseCommit}:${PARAMETER_PATH}`]);
    const space: ParamSpace = await json(join(import.meta.dir, 'paramSpace.json'));
    const genome = parseGenome(source + '\n');
    const errors = validateGenome(genome, space); if (errors.length) throw new Error(errors.join('; '));
    return { source: source + '\n', space, genome };
}
async function requireBase(s: State) {
    const league = await loadLeague();
    if (league.champion !== s.champion || await git(['rev-parse', 'HEAD']) !== s.baseCommit || await git(['rev-parse', 'refs/heads/master']) !== s.baseCommit)
        throw new Error('Champion/baseCommit changed; do not continue this evolution run');
    if (await git(['status', '--porcelain', '--untracked-files=all', '--', BUILTIN])) throw new Error('Freeze BUILTIN before evolution');
    const champion = league.members.find(member => member.id === s.champion)!;
    if (await git(['rev-parse', `${s.baseCommit}:${BUILTIN}`]) !== champion.tree) throw new Error('master BUILTIN tree must equal the registered champion');
    return league;
}
export function validateGeneration(games: readonly ArenaGame[], jobs: readonly ArenaJob[], manifest: Manifest, earlyStop: boolean): void {
    if (jobs.length !== 512 || games.length !== 1024) throw new Error('Generation must contain exactly 512 paired jobs / 1024 games');
    const expected = new Map<string, ArenaJob>(jobs.flatMap(job => [false, true].map(swapped => [`${job.id}#${swapped}`, job] as const))), seen = new Set<string>();
    const trees = Object.fromEntries(manifest.individuals.map(individual => [individual.id, individual.tree]));
    for (const game of games) {
        const key = `${jobId(game)}#${game.swapped}`, job = expected.get(key);
        if (!job || seen.has(key)) throw new Error('Unexpected or duplicate generation game'); seen.add(key);
        if (game.stage !== 'train' || game.run !== manifest.run || game.generation !== manifest.generation || game.promotion !== null || game.aTree !== trees[game.a] || game.bTree !== manifest.opponents[game.b])
            throw new Error('Generation game identity/stage mismatch');
        if (game.result === 'error' || !['a-win', 'b-win', 'timeout'].includes(game.result) || !Number.isSafeInteger(game.ticks) || game.ticks < 1 || game.ticks > 27000)
            throw new Error('Error or invalid tick count invalidates the whole generation');
        if (game.reason === 'value-model-early-stop' ? !earlyStop || game.ticks < 9000 || game.result === 'timeout' :
            game.reason !== 'engine-victory-conditions' && !(game.reason === 'tick-limit' && game.ticks === 27000 && game.result === 'timeout'))
            throw new Error('Invalid generation termination');
    }
}
async function spawn(s: State) {
    await requireBase(s);
    if (s.generation >= 12) throw new Error('The fixed twelve generations are already complete');
    const folder = generationFolder(s.run, s.generation), manifestFile = join(folder, 'manifest.json'), jobsFile = join(folder, 'jobs.json');
    if (await Bun.file(jobsFile).exists()) return;
    const start = performance.now(), { source, space, genome } = await inputs(s), league = await loadLeague();
    let manifest: Manifest;
    if (await Bun.file(manifestFile).exists()) manifest = await json(manifestFile);
    else {
        const children = population(genome, s.parents, space, s.run, s.generation, !!s.fromRun && s.generation === 0, s.generation === 0 ? s.seedOn : undefined);
        const individuals: Individual[] = [];
        for (const [index, child] of children.entries()) {
            const commit = await buildCommit(s.baseCommit, renderGenome(source, child.genome));
            const tree = await git(['rev-parse', `${commit}:${BUILTIN}`]);
            const origin = index === 15 ? `${s.run}/control` : (s.generation > 0 && index < 4) ? s.parentOrigins[index] : `${s.run}/g${s.generation}-i${index}`;
            individuals.push({ ...child, index, id: `g${s.generation}-i${index}`, origin, commit, tree });
        }
        manifest = { run: s.run, generation: s.generation, baseCommit: s.baseCommit, individuals,
            opponents: Object.fromEntries(league.members.map(member => [member.id, member.tree])), spawnSeconds: (performance.now() - start) / 1000 };
        await save(manifestFile, manifest);
    }
    for (const individual of manifest.individuals) {
        const reference = `refs/evo/${s.run}/g${s.generation}-i${individual.index}`;
        const old = await git(['for-each-ref', '--format=%(objectname)', reference]);
        if (old && old !== individual.commit) throw new Error(`Conflicting local individual reference ${reference}`);
        await git(['update-ref', reference, individual.commit, old]);
    }
    const jobs = manifest.individuals.flatMap(individual => trainJobs(individual.id, s.run, s.generation, s.champion)
        .map(job => ({ ...job, aRef: individual.commit, earlyStop: s.earlyStop })));
    await save(jobsFile, jobs);
}
async function collect(s: State, file: string) {
    await requireBase(s);
    const folder = generationFolder(s.run, s.generation), manifest: Manifest = await json(join(folder, 'manifest.json')), jobs: ArenaJob[] = await json(join(folder, 'jobs.json'));
    const text = await readFile(file, 'utf8'), games: ArenaGame[] = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    validateGeneration(games, jobs, manifest, s.earlyStop);
    const fitness = manifest.individuals.map(individual => measureFitness(individual.index, individual.id, individual.origin, individual.genome, games.filter(game => game.a === individual.id)));
    const controlScore = fitness[15].score;
    for (const row of fitness) row.lead = row.score - controlScore;
    const selected = selectParents(fitness); for (const row of selected) row.selected = true;
    const summary = await json<{ wallSeconds: number }>(join(resolve(file, '..'), 'summary.json'));
    const seconds = manifest.spawnSeconds + summary.wallSeconds;
    if (s.run === 90 && seconds > 21600) throw new Error(`Run 90 generation exceeds the six-hour limit: ${seconds}s`);
    await writeFile(join(folder, 'games.jsonl'), text); await save(join(folder, 'fitness.json'), fitness);
    s.parents = selected.map(row => manifest.individuals[row.index].genome); s.parentOrigins = selected.map(row => row.origin);
    s.history.push({ generation: s.generation, bestScore: selected[0].score, controlScore, lead: selected[0].lead, seconds });
    s.generation++; await save(join(runFolder(s.run), 'state.json'), s);
    for (const individual of manifest.individuals) await git(['update-ref', '-d', `refs/evo/${s.run}/g${manifest.generation}-i${individual.index}`, individual.commit]);
    console.log(`g${manifest.generation}\tbest=${selected[0].score.toFixed(4)}\ti15=${controlScore.toFixed(4)}\tlead=${selected[0].lead.toFixed(4)}\tseconds=${seconds.toFixed(3)}`);
}
async function candidate(s: State) {
    if (!s.generation) throw new Error('No generation has been collected');
    const histories: Fitness[][] = [];
    for (let generation = 0; generation < s.generation; generation++) histories.push(await json(join(generationFolder(s.run, generation), 'fitness.json')));
    const parents = selectParents(histories.at(-1)!), chosen = chooseCandidate(parents, histories), folder = generationFolder(s.run, s.generation - 1);
    const manifest: Manifest = await json(join(folder, 'manifest.json')), individual = manifest.individuals[chosen.candidate.index];
    const { source, genome } = await inputs(s), rendered = renderGenome(source, individual.genome), commit = await buildCommit(s.baseCommit, rendered);
    const output = join(projectRoot, `.artifacts/p4/run-${s.run}/candidate`); await mkdir(output, { recursive: true });
    await writeFile(join(output, 'brutalParams.ts'), rendered);
    const result = { run: s.run, commit, baseCommit: s.baseCommit, champion: s.champion, genome: individual.genome,
        meanLead: chosen.meanLead, evaluations: chosen.evaluations, origin: individual.origin, score: chosen.candidate.score };
    await save(join(output, 'candidate.json'), result);
    console.log('parameter\tbefore\tafter');
    for (const path of Object.keys(genome.base).sort()) if (genome.base[path] !== individual.genome.base[path]) console.log(`${path}\t${genome.base[path]}\t${individual.genome.base[path]}`);
    for (const [table, entries] of Object.entries(individual.genome.overrides)) for (const [path, value] of Object.entries(entries)) console.log(`${table}:${path}\t-\t${value}`);
    console.log(JSON.stringify({ run: s.run, commit, meanLead: result.meanLead, evaluations: result.evaluations, output }, null, 2));
}
async function report(s: State) {
    console.log('generation\tbest\ti15\tlead\twins/losses/timeouts\twinMedian\toverrides\tseconds');
    for (const row of s.history) {
        const fitness: Fitness[] = await json(join(generationFolder(s.run, row.generation), 'fitness.json')), best = selectParents(fitness)[0];
        console.log(`${row.generation}\t${row.bestScore.toFixed(4)}\t${row.controlScore.toFixed(4)}\t${row.lead.toFixed(4)}\t${best.wins}/${best.losses}/${best.timeouts}\t${best.winMedian}\t${best.overrides}\t${row.seconds.toFixed(3)}`);
    }
}
export async function main() {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { run: { type: 'string' }, games: { type: 'string' },
        concurrency: { type: 'string' }, generations: { type: 'string' }, 'early-stop': { type: 'boolean' }, 'from-run': { type: 'string' }, 'seed-on': { type: 'string' } } });
    const run = integer(values.run, 'run', 1, 99), command = positionals[0];
    if (command === 'init') {
        if (await Bun.file(join(runFolder(run), 'state.json')).exists()) throw new Error('Run state already exists; resume with run, never reset it');
        const league = await loadLeague(); if (!league.champion) throw new Error('A champion is required');
        const s: State = { run, champion: league.champion, baseCommit: await git(['rev-parse', 'HEAD']), generation: 0, parents: [], parentOrigins: [], history: [], earlyStop: !!values['early-stop'] };
        await requireBase(s);
        if (values['from-run'] && values['seed-on']) throw new Error('from-run and seed-on are mutually exclusive');
        if (values['from-run']) {
            const previous = await state(integer(values['from-run'], 'from-run', 1, 99));
            if (previous.generation !== 12 || previous.champion !== s.champion || previous.baseCommit !== s.baseCommit) throw new Error('from-run requires a complete run with identical champion/baseCommit');
            s.fromRun = previous.run; s.parents = previous.parents;
        }
        if (values['seed-on']) {
            const { space } = await inputs(s), bound = space[values['seed-on']];
            if (!bound?.mutable || !bound.int || bound.min !== 0 || bound.max !== 1) throw new Error('seed-on must name a mutable switch');
            s.seedOn = values['seed-on'];
        }
        if (s.earlyStop && !(await json<{ accepted: boolean }>(join(import.meta.dir, 'valueModel.json'))).accepted) throw new Error('Early stopping has not passed V1-V3');
        await save(join(runFolder(run), 'state.json'), s); console.log(JSON.stringify(s, null, 2)); return;
    }
    const s = await state(run);
    if (command === 'spawn') await spawn(s);
    else if (command === 'collect') { if (!values.games) throw new Error('--games is required'); await collect(s, resolve(values.games)); }
    else if (command === 'candidate') await candidate(s);
    else if (command === 'report') await report(s);
    else if (command === 'run') {
        const concurrency = integer(values.concurrency, 'concurrency', 1, 1024), count = values.generations ? integer(values.generations, 'generations', 1, 12) : 12;
        let completed = 0, active: ReturnType<typeof Bun.spawn> | undefined, interrupted = false;
        const stop = () => { interrupted = true; active?.kill(); };
        process.on('SIGINT', stop); process.on('SIGTERM', stop);
        try {
            while (s.generation < 12 && completed < count) {
                if (interrupted) throw new Error('Evolution interrupted; state retained');
                await spawn(s);
                const out = rawFolder(run, s.generation);
                if (await Bun.file(join(out, 'summary.json')).exists()) {
                    const previous = await json<{ results: { error: number } }>(join(out, 'summary.json'));
                    if (previous.results.error) throw new Error('Error-invalidated generation cannot be selectively resumed; repair BUILTIN and restart as specified in 12.2');
                }
                active = Bun.spawn([process.execPath, 'e2e/league/p4/play.ts', '--jobs', join(generationFolder(run, s.generation), 'jobs.json'), '--out', out,
                    '--concurrency', String(concurrency), '--resume'], { cwd: projectRoot, stdout: 'inherit', stderr: 'inherit' });
                const code = await active.exited; active = undefined;
                if (code || interrupted) throw new Error(`Generation play failed (${code}); no collection or next generation`);
                await collect(s, join(out, 'games.jsonl')); completed++;
            }
        } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    } else throw new Error('Usage: evolve.ts init|spawn|collect|run|candidate|report --run R');
}
if (import.meta.main) {
    try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

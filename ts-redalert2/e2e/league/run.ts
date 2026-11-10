import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { archiveJobAttempt } from '../ai-tournament-storage';
import { validateJobReport } from '../ai-tournament-plan';
import { BUILTIN, loadLeague, gitQuery, type Profile } from './registry';
import { MAPS, pairingJobs, lightPairingJobs, roundRobinJobs, shardJobs, compareGames, convertResult, assertSelfMirror, type Kind, type LeagueGame, type LeagueJob } from './schedule';

const projectRoot = resolve(import.meta.dir, '../..');
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export interface FrozenMember { id: string; ref: string; commit: string; tree: string; profile: Profile }
type Resources = { iniSha256: string; customIniSha256: string; maps: Record<string, { mapSha256: string; terrainSha256: string }> };
function integer(value: string | undefined, name: string, minimum = 0): number {
    const number = Number(value);
    if (value === undefined || !Number.isSafeInteger(number) || number < minimum) throw new Error(`Invalid --${name}: ${value}`);
    return number;
}
async function digestFiles(directory: string, include: (path: string) => boolean) {
    const digest = createHash('sha256');
    for (const path of (await readdir(directory, { recursive: true })).filter(include).sort())
        digest.update(path).update('\0').update(await readFile(join(directory, path))).update('\0');
    return digest.digest('hex');
}
async function runtimeSnapshot() {
    const engineStatus = await gitQuery(['status', '--porcelain', '--untracked-files=all', '--', 'ts-redalert2/src',
        ':(exclude)ts-redalert2/src/game/ai/thirdpartbot/builtIn', ':(exclude)ts-redalert2/src/test']);
    if (engineStatus) throw new Error('Freeze the engine source before running the league');
    return { engineCommit: await gitQuery(['rev-parse', 'HEAD']),
        engineSource: await digestFiles(join(projectRoot, 'src'), path => /\.(ts|tsx)$/.test(path) && !path.startsWith('test/') &&
            (!path.startsWith('game/ai/thirdpartbot/builtIn/') || path === 'game/ai/thirdpartbot/builtIn/game-api.ts')),
        benchmarkSources: await digestFiles(join(projectRoot, 'e2e'), path => /^ai-.*\.ts$/.test(path)),
        leagueSources: Object.fromEntries(await Promise.all(['registry.ts', 'schedule.ts', 'run.ts'].map(async path =>
            [path, hash(await readFile(join(import.meta.dir, path)))]))),
        lockfile: hash(await readFile(join(projectRoot, 'bun.lock'))),
        resourceLoader: hash(await readFile(join(projectRoot, 'deploy/prepare-resources.ts'))), bunVersion: Bun.version };
}
async function readResources(cdn: string): Promise<Resources> {
    const maps: Resources['maps'] = {};
    for (const map of MAPS) {
        const bytes = await readFile(join(cdn, 'maps', `${map}.map`));
        const theater = /^\s*Theater\s*=\s*([^;\r\n]+)/im.exec(bytes.toString())?.[1].trim().toUpperCase();
        const terrain = ({ TEMPERATE: 'isotemp.mix', URBAN: 'isourb.mix', SNOW: 'isosnow.mix' } as Record<string, string>)[theater ?? ''];
        if (!terrain) throw new Error(`Missing/unsupported theater in ${map}`);
        maps[map] = { mapSha256: hash(bytes), terrainSha256: hash(await readFile(join(cdn, 'game-res/v2', terrain))) };
    }
    return { maps, iniSha256: hash(await readFile(join(projectRoot, 'public/ini.mix'))),
        customIniSha256: hash(await readFile(join(projectRoot, 'public/res/ra2cd.mix'))) };
}
async function atomicJson(path: string, value: unknown) {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n'); await rename(temporary, path);
}
export function reportGames(report: any, job: LeagueJob, a: FrozenMember, b: FrozenMember,
    round: number, kind: Kind, engineCommit: string, resources: Resources): LeagueGame[] {
    const expected = { candidateCommit: a.commit, baselineCommit: b.commit, engineCommit,
        candidateProfile: a.profile, baselineProfile: b.profile, maxTicks: 27000, sampleTicks: 900, credits: 10000, unitCount: 0,
        iniSha256: resources.iniSha256, customIniSha256: resources.customIniSha256, ...resources.maps[job.map] };
    if (!validateJobReport(report, { id: job.id, map: job.map, seed: job.seed,
        candidateCountry: job.aCountry, baselineCountry: job.bCountry }, expected)) throw new Error(`${job.id}: incomplete paired report`);
    if (!Array.isArray(report.startupIssues) || report.startupIssues.length) throw new Error(`${job.id}: invalid benchmark startup`);
    if (report.matches.some((match: any) => !Array.isArray(match.startingLocations) || match.startingLocations.length !== 2 ||
        match.startingLocations.some((point: any) => !Number.isFinite(point.x) || !Number.isFinite(point.y))))
        throw new Error(`${job.id}: missing physical starts`);
    return [...report.matches].sort((x, y) => Number(x.swapped) - Number(y.swapped)).map(match => ({
        round, kind, a: job.a, b: job.b, aTree: a.tree, bTree: b.tree, map: job.map, seed: job.seed,
        aCountry: job.aCountry, bCountry: job.bCountry, swapped: match.swapped,
        result: convertResult(match.result), reason: match.reason, ticks: match.ticks,
    }));
}

export async function main() {
    const started = performance.now();
    const { values } = parseArgs({ options: {
        round: { type: 'string' }, kind: { type: 'string' }, generation: { type: 'string' }, a: { type: 'string' }, vs: { type: 'string' },
        'round-robin': { type: 'boolean' }, ref: { type: 'string', multiple: true },
        concurrency: { type: 'string', default: '4' }, out: { type: 'string' }, resume: { type: 'boolean' },
        cdn: { type: 'string' }, shard: { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help) {
        console.log('bun e2e/league/run.ts --round N --kind qualify|dev|evolve (--round-robin | --a ID --vs active|ID,ID) [--generation G for evolve/light games] [--ref ID=COMMIT] --out DIR [--resume] [--concurrency 4] [--cdn PATH] [--shard I/M]');
        return;
    }
    const round = integer(values.round, 'round'), concurrency = integer(values.concurrency, 'concurrency', 1);
    if (!['qualify', 'dev', 'evolve'].includes(values.kind ?? '')) throw new Error('--kind must be qualify, dev or evolve');
    const kind = values.kind as Kind;
    const generation = kind === 'evolve' ? integer(values.generation, 'generation') : undefined;
    if ((generation !== undefined && generation > 39) || (kind !== 'evolve' && values.generation !== undefined))
        throw new Error('--generation 0-39 is required only for evolve games');
    if (!values.out) throw new Error('--out is required');
    const cdnInput = values.cdn ?? process.env.RA2_BENCHMARK_CDN;
    if (!cdnInput) throw new Error('Pass --cdn or set RA2_BENCHMARK_CDN');
    const cdn = resolve(cdnInput), output = resolve(values.out);
    const league = await loadLeague();
    const overrides = new Map<string, string>();
    for (const value of values.ref ?? []) {
        const separator = value.indexOf('='), id = value.slice(0, separator), ref = value.slice(separator + 1);
        if (separator < 1 || !/^[a-z][a-z0-9-]*$/.test(id) || !ref || ref === 'working-tree' || overrides.has(id))
            throw new Error(`Invalid or duplicate --ref ${value}`);
        if (league.members.some(member => member.id === id)) throw new Error(`--ref is only for unregistered candidates: ${id}`);
        overrides.set(id, ref);
    }
    let jobs: LeagueJob[];
    if (values['round-robin']) {
        if (values.a || values.vs || overrides.size) throw new Error('--round-robin is mutually exclusive with --a, --vs and --ref');
        jobs = roundRobinJobs(league.members.filter(member => member.active).map(member => member.id), round, kind, generation);
    } else {
        if (!values.a || !values.vs) throw new Error('--a and --vs are required without --round-robin');
        const opponents = values.vs === 'active' ? league.members.filter(member => member.active && member.id !== values.a).map(member => member.id) : values.vs.split(',');
        if (!opponents.length || new Set(opponents).size !== opponents.length) throw new Error('--vs must contain unique members');
        if (opponents.some(id => !league.members.some(member => member.id === id))) throw new Error('--vs must identify registered opponents');
        jobs = opponents.flatMap(b => kind === 'evolve' ? lightPairingJobs(values.a!, b, round, kind, generation) : pairingJobs(values.a!, b, round, kind));
    }
    jobs.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (!jobs.length) throw new Error('League schedule is empty');
    const versions: Record<string, FrozenMember> = {};
    for (const id of [...new Set(jobs.flatMap(job => [job.a, job.b]))].sort()) {
        const member = league.members.find(member => member.id === id), ref = overrides.get(id) ?? member?.tag;
        if (!ref) throw new Error(`Unknown member or candidate ${id}`);
        const commit = await gitQuery(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
        const tree = await gitQuery(['rev-parse', '--verify', '--end-of-options', `${commit}:${BUILTIN}`]);
        await gitQuery(['cat-file', '-e', `${commit}:${BUILTIN}/BuiltInBotAdapter.ts`]);
        if (member && tree !== member.tree) throw new Error(`Changed tree for ${id}`);
        versions[id] = { id, ref, commit, tree, profile: member?.profile ?? 'brutal' };
    }
    if ([...overrides.keys()].some(id => !versions[id])) throw new Error('Unused --ref candidate');
    const runtime = await runtimeSnapshot(), resources = await readResources(cdn);
    const config = { round, kind, generation: generation ?? null, versions, runtime, resources, jobs, cdn, shard: values.shard ?? null };
    if (values.shard !== undefined) jobs = shardJobs(jobs, values.shard);
    const fingerprint = hash(JSON.stringify(config)), manifestPath = join(output, 'manifest.json');
    const verifyRuntime = async () => {
        if (JSON.stringify(await runtimeSnapshot()) !== JSON.stringify(runtime) || JSON.stringify(await readResources(cdn)) !== JSON.stringify(resources))
            throw new Error('Frozen runtime/resources changed during league execution');
    };
    const existing = Bun.file(manifestPath);
    if (await existing.exists()) {
        if (!values.resume) throw new Error('Output exists; choose a new --out or explicitly --resume');
        const manifest = await existing.json();
        if (manifest.fingerprint !== fingerprint || JSON.stringify(manifest.config) !== JSON.stringify(config)) throw new Error('Resume refused: frozen schedule/configuration changed');
    } else {
        if (values.resume) throw new Error('--resume requires the original manifest');
        let entries: string[] = []; try { entries = await readdir(output); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (entries.length) throw new Error('Refusing to overwrite an existing output directory without a league manifest');
        await mkdir(join(output, 'jobs'), { recursive: true });
        await atomicJson(manifestPath, { schema: 1, fingerprint, createdAt: new Date().toISOString(), config });
    }
    const games = new Map<string, LeagueGame[]>(), pending: LeagueJob[] = [];
    const reportPath = (job: LeagueJob) => join(output, 'jobs', `${job.id}.json`);
    for (const job of jobs) {
        const file = Bun.file(reportPath(job));
        if (await file.exists()) {
            if (!values.resume) throw new Error(`Refusing to overwrite ${job.id}`);
            try {
                const rows = reportGames(await file.json(), job, versions[job.a], versions[job.b], round, kind, runtime.engineCommit, resources);
                const receipt = await Bun.file(join(output, 'jobs', `${job.id}.verified.json`)).json();
                if (!rows.some(row => row.result === 'error') && receipt.fingerprint === fingerprint && receipt.reportSha256 === hash(await file.text())) {
                    games.set(job.id, rows); continue;
                }
            } catch { /* Interrupted, invalid or error jobs are archived before a fresh paired run. */ }
        }
        pending.push(job);
    }
    let index = 0, interrupted = false;
    const active = new Set<ReturnType<typeof Bun.spawn>>(), failures: Record<string, string> = {};
    const stop = () => { interrupted = true; for (const child of active) child.kill(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const worker = async () => {
        while (!interrupted && index < pending.length) {
            const job = pending[index++];
            try {
                await verifyRuntime();
                await archiveJobAttempt(output, job.id);
                const command = [process.execPath, 'e2e/ai-benchmark.ts', '--candidate-ref', versions[job.a].ref,
                    '--baseline-ref', versions[job.b].ref, '--candidate-profile', versions[job.a].profile, '--baseline-profile', versions[job.b].profile,
                    '--map', job.map, '--seeds', String(job.seed), '--matchups', `${job.aCountry}:${job.bCountry}`,
                    '--max-ticks', '27000', '--sample-ticks', '900', '--credits', '10000', '--units', '0', '--cdn', cdn, '--out', reportPath(job)];
                console.error(`Starting ${job.id}`);
                const child = Bun.spawn(command, { cwd: projectRoot, stdout: 'ignore', stderr: Bun.file(join(output, 'jobs', `${job.id}.log`)) });
                active.add(child); const code = await child.exited; active.delete(child);
                await verifyRuntime();
                const text = await Bun.file(reportPath(job)).text();
                const rows = reportGames(JSON.parse(text), job, versions[job.a], versions[job.b], round, kind, runtime.engineCommit, resources);
                if (code && !rows.some(row => row.result === 'error')) throw new Error(`Worker exit ${code} despite complete error-free report`);
                games.set(job.id, rows);
                await atomicJson(join(output, 'jobs', `${job.id}.verified.json`), { fingerprint, reportSha256: hash(text) });
                console.error(`Finished ${job.id}: ${rows.map(row => row.result).join(', ')} (${games.size}/${jobs.length} jobs)`);
            } catch (error) {
                failures[job.id] = error instanceof Error ? error.message : String(error);
                console.error(`Failed ${job.id}: ${failures[job.id]}`);
                interrupted = true;
            }
        }
    };
    try { await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker)); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    const rows = [...games.values()].flat().sort(compareGames);
    if (!rows.some(row => row.result === 'error')) assertSelfMirror(rows);
    await writeFile(join(output, 'games.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
    const summary = { round, kind, expectedJobs: jobs.length, completedJobs: games.size, expectedGames: jobs.length * 2,
        games: rows.length, results: Object.fromEntries(['a-win', 'b-win', 'timeout', 'error'].map(result => [result, rows.filter(row => row.result === result).length])),
        failures, interrupted, wallSeconds: (performance.now() - started) / 1000, gamesFile: join(output, 'games.jsonl') };
    await atomicJson(join(output, 'summary.json'), summary); console.log(JSON.stringify(summary, null, 2));
    if (interrupted || Object.keys(failures).length || rows.length !== jobs.length * 2 || rows.some(row => row.result === 'error')) process.exitCode = 1;
}
if (import.meta.main) {
    try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

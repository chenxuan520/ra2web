import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validateJobReport } from '../ai-tournament-plan';
import { BUILTIN, gitQuery, loadLeague } from './registry';
import { MAPS, convertResult } from './schedule';
import { ECO_COUNTRIES, ECO_MAX_TICKS, ECO_SAMPLE_TICKS, measureEconomy, summarizeEconomy, ecoMarkdown, type EcoGame } from './ecoCore';

const projectRoot = resolve(import.meta.dir, '../..');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export interface EcoMember { id: string; ref: string; commit: string; tree: string }
export interface EcoJob { id: string; map: string; seed: number; country: typeof ECO_COUNTRIES[number] }
export interface EcoResources { iniSha256: string; customIniSha256: string; mapSha256: string; terrainSha256: string }

/** This full-pool schedule is independent of the rotating official league rounds. */
export function ecoJobs(): EcoJob[] {
    return MAPS.flatMap((map, index) => ECO_COUNTRIES.map(country => ({ id: `${map}__${country}`, map, seed: 7001 + index, country })));
}
export function ecoBenchmarkCommand(job: EcoJob, candidateRef: string, cdn: string, out: string): string[] {
    return [process.execPath, 'e2e/ai-benchmark.ts', '--candidate-ref', candidateRef, '--baseline-ref', 'league/x-idle-01',
        '--candidate-profile', 'brutal', '--baseline-profile', 'brutal', '--map', job.map, '--seeds', String(job.seed),
        '--matchups', `${job.country}:${job.country}`, '--max-ticks', String(ECO_MAX_TICKS), '--sample-ticks', String(ECO_SAMPLE_TICKS),
        '--credits', '10000', '--units', '0', '--cdn', cdn, '--out', out];
}
export function reportEcoGames(report: any, job: EcoJob, member: EcoMember, idle: EcoMember,
    engineCommit: string, resources: EcoResources): EcoGame[] {
    const expected = { candidateCommit: member.commit, baselineCommit: idle.commit, engineCommit,
        candidateProfile: 'brutal', baselineProfile: 'brutal', maxTicks: ECO_MAX_TICKS, sampleTicks: ECO_SAMPLE_TICKS,
        credits: 10000, unitCount: 0, ...resources };
    if (!validateJobReport(report, { id: job.id, map: job.map, seed: job.seed, candidateCountry: job.country, baselineCountry: job.country }, expected))
        throw new Error(`${job.id}: incomplete paired economic report`);
    if (!Array.isArray(report.startupIssues) || report.startupIssues.length) throw new Error(`${job.id}: invalid benchmark startup`);
    return [...report.matches].sort((a, b) => Number(a.swapped) - Number(b.swapped)).map(match => {
        if (match.result !== 'error' && (!Array.isArray(match.startingLocations) || match.startingLocations.length !== 2 ||
            match.startingLocations.some((point: any) => !Number.isFinite(point.x) || !Number.isFinite(point.y))))
            throw new Error(`${job.id}: missing physical starts`);
        if (!Number.isSafeInteger(match.telemetry?.errorCount) || match.telemetry.errorCount < 0)
            throw new Error(`${job.id}: missing runtime error count`);
        const error = match.result === 'error';
        return { jobId: job.id, map: job.map, seed: job.seed, country: job.country, swapped: match.swapped, player: 0,
            result: convertResult(match.result), reason: match.reason, ticks: match.ticks ?? null, ecoMap: match.ecoMap ?? null,
            metrics: error ? null : measureEconomy(match, 0, [match.candidatePlayerName, match.baselinePlayerName]),
            error: error ? String(match.error ?? match.disposeError ?? match.reason) : null };
    });
}

async function readResources(cdn: string) {
    const iniSha256 = hash(await readFile(join(projectRoot, 'public/ini.mix')));
    const customIniSha256 = hash(await readFile(join(projectRoot, 'public/res/ra2cd.mix')));
    const terrains = new Map<string, string>(), maps: Record<string, EcoResources> = {};
    for (const map of MAPS) {
        const bytes = await readFile(join(cdn, 'maps', `${map}.map`));
        const theater = /^\s*Theater\s*=\s*([^;\r\n]+)/im.exec(bytes.toString())?.[1].trim().toUpperCase();
        const terrain = ({ TEMPERATE: 'isotemp.mix', URBAN: 'isourb.mix', SNOW: 'isosnow.mix' } as Record<string, string>)[theater ?? ''];
        if (!terrain) throw new Error(`Missing/unsupported theater in ${map}`);
        if (!terrains.has(terrain)) terrains.set(terrain, hash(await readFile(join(cdn, 'game-res/v2', terrain))));
        maps[map] = { iniSha256, customIniSha256, mapSha256: hash(bytes), terrainSha256: terrains.get(terrain)! };
    }
    return maps;
}
async function requireFrozenSources() {
    const status = await gitQuery(['status', '--porcelain', '--untracked-files=all', '--', 'ts-redalert2/src', 'ts-redalert2/e2e',
        'ts-redalert2/bun.lock', 'ts-redalert2/deploy/prepare-resources.ts']);
    if (status) throw new Error('Freeze engine, bot and measurement sources before an economic trial');
}
async function freezeMember(id: string, ref: string, expectedTree?: string): Promise<EcoMember> {
    const commit = await gitQuery(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
    const tree = await gitQuery(['rev-parse', '--verify', '--end-of-options', `${commit}:${BUILTIN}`]);
    await gitQuery(['cat-file', '-e', `${commit}:${BUILTIN}/BuiltInBotAdapter.ts`]);
    if (expectedTree !== undefined && tree !== expectedTree) throw new Error(`Changed tree for ${id}`);
    return { id, ref, commit, tree };
}

export async function main() {
    const { values } = parseArgs({ options: { member: { type: 'string' }, ref: { type: 'string' }, concurrency: { type: 'string', default: '4' },
        out: { type: 'string' }, cdn: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) {
        console.log('bun e2e/league/ecoTrial.ts (--member ID | --ref NAME=COMMIT) --concurrency K --out DIR [--cdn PATH]');
        return;
    }
    if (!!values.member === !!values.ref) throw new Error('Pass exactly one of --member or --ref');
    if (!values.out) throw new Error('--out is required');
    const concurrency = Number(values.concurrency);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid --concurrency');
    const cdn = resolve(values.cdn ?? process.env.RA2_BENCHMARK_CDN ?? join(projectRoot, '../.cache/ai-resources/cdn'));
    const output = resolve(values.out), league = await loadLeague();
    let member: EcoMember;
    if (values.member) {
        const registered = league.members.find(member => member.id === values.member);
        if (!registered) throw new Error(`Unknown registered member ${values.member}`);
        member = await freezeMember(registered.id, registered.tag, registered.tree);
    } else {
        const separator = values.ref!.indexOf('='), id = values.ref!.slice(0, separator), ref = values.ref!.slice(separator + 1);
        if (separator < 1 || !/^[a-z][a-z0-9-]*$/.test(id) || !ref || ref === 'working-tree' || league.members.some(member => member.id === id))
            throw new Error('Invalid --ref; use an unregistered NAME=COMMIT');
        member = await freezeMember(id, ref);
    }
    const registeredIdle = league.members.find(member => member.id === 'x-idle-01');
    if (!registeredIdle || registeredIdle.active || registeredIdle.role !== 'sparring' || registeredIdle.profile !== 'brutal' || registeredIdle.style !== 'idle')
        throw new Error('Register and freeze inactive brutal sparring member x-idle-01 before an economic trial');
    const idle = await freezeMember(registeredIdle.id, registeredIdle.tag, registeredIdle.tree);
    await requireFrozenSources();
    const engineCommit = await gitQuery(['rev-parse', 'HEAD']), resources = await readResources(cdn);
    const sourcePaths = ['ai-benchmark.ts', 'ai-eco-telemetry.ts', 'league/ecoCore.ts', 'league/ecoTrial.ts'];
    const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, hash(await readFile(join(projectRoot, 'e2e', path)))])));
    const verifyFrozen = async () => {
        await requireFrozenSources();
        if (await gitQuery(['rev-parse', 'HEAD']) !== engineCommit ||
            await gitQuery(['rev-parse', '--verify', '--end-of-options', `${idle.ref}^{commit}`]) !== idle.commit)
            throw new Error('Frozen engine or idle reference changed during economic trial');
    };
    let entries: string[] = [];
    try { entries = await readdir(output); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (entries.length) throw new Error('Refusing to overwrite an existing economic output directory');
    await mkdir(join(output, 'jobs'), { recursive: true });
    const started = performance.now(), jobs = ecoJobs(), games = new Map<string, EcoGame[]>(), failures: Record<string, string> = {};
    let index = 0, interrupted = false;
    const active = new Set<ReturnType<typeof Bun.spawn>>();
    const stop = () => { interrupted = true; for (const child of active) child.kill(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const worker = async () => {
        while (!interrupted && index < jobs.length) {
            const job = jobs[index++], reportPath = join(output, 'jobs', `${job.id}.json`);
            try {
                await verifyFrozen();
                console.error(`Starting ${job.id}`);
                const child = Bun.spawn(ecoBenchmarkCommand(job, member.commit, cdn, reportPath), {
                    cwd: projectRoot, stdout: 'ignore', stderr: Bun.file(join(output, 'jobs', `${job.id}.log`)),
                });
                active.add(child); const code = await child.exited; active.delete(child);
                await verifyFrozen();
                const rows = reportEcoGames(await Bun.file(reportPath).json(), job, member, idle, engineCommit, resources[job.map]);
                if (code && !rows.some(row => row.result === 'error')) throw new Error(`Worker exited ${code} despite an error-free report`);
                games.set(job.id, rows);
                console.error(`Finished ${job.id}: ${rows.map(row => row.result).join(', ')} (${games.size}/${jobs.length} jobs)`);
            } catch (error) {
                failures[job.id] = error instanceof Error ? error.message : String(error);
                console.error(`Failed ${job.id}: ${failures[job.id]}`);
                interrupted = true;
            }
        }
    };
    try { await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker)); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    try {
        await verifyFrozen();
        if (JSON.stringify(await readResources(cdn)) !== JSON.stringify(resources)) throw new Error('Frozen resource files changed during economic trial');
    } catch (error) { failures.runtime = error instanceof Error ? error.message : String(error); }
    if (interrupted && !Object.keys(failures).length) failures.interrupted = 'Economic trial interrupted';
    const rows = jobs.flatMap(job => games.get(job.id) ?? []);
    const summary = summarizeEconomy(rows, failures);
    const report = { schema: 1, member: member.id, tree: member.tree, ref: member.ref, commit: member.commit, opponent: idle,
        engineCommit, bunVersion: Bun.version, sources, resources, settings: { maxTicks: ECO_MAX_TICKS, sampleTicks: ECO_SAMPLE_TICKS, credits: 10000, unitCount: 0 },
        games: rows, ...summary, wallSeconds: (performance.now() - started) / 1000 };
    await writeFile(join(output, 'eco.json'), JSON.stringify(report, null, 2) + '\n');
    const markdown = ecoMarkdown(report);
    await writeFile(join(output, 'eco.md'), markdown); console.log(markdown);
    if (!summary.valid) process.exitCode = 2;
}
if (import.meta.main) {
    try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}

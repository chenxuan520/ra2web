/** Run the full ordered country matrix as resumable, isolated real-engine benchmark jobs. */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { COUNTRY_LABELS, TOURNAMENT_COUNTRIES, createTournamentJobs, summarizeTournament, validateJobReport } from './ai-tournament-plan';
import { archiveJobAttempt } from './ai-tournament-storage';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = dirname(projectRoot.replace(/\/$/, ''));
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
async function git(...args: string[]) {
    const child = Bun.spawn(['git', ...args], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
    const [output, errors, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (status) throw new Error(`git ${args[0]}: ${errors}`);
    return output.trim();
}
async function sourceDigest(directory: string, include: (relative: string) => boolean) {
    const paths = (await readdir(directory, { recursive: true })).filter(include).sort();
    const digest = createHash('sha256');
    for (const path of paths) digest.update(path).update('\0').update(await readFile(join(directory, path))).update('\0');
    return digest.digest('hex');
}
async function atomicJson(path: string, value: unknown) {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
    await rename(temporary, path);
}
function integer(value: string, name: string, minimum = 1) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`Invalid --${name}: ${value}`);
    return number;
}

async function main() {
    const { values: args } = parseArgs({ options: {
        'candidate-ref': { type: 'string' }, 'baseline-ref': { type: 'string', default: '04a9f7a' },
        'candidate-profile': { type: 'string', default: 'brutal' }, 'baseline-profile': { type: 'string', default: 'brutal' },
        countries: { type: 'string', default: TOURNAMENT_COUNTRIES.join(',') },
        scenarios: { type: 'string', default: 'mp08t2:1011,tn01t2:2022,mp11t2:3033' },
        concurrency: { type: 'string', default: '3' }, 'max-ticks': { type: 'string', default: '27000' },
        'sample-ticks': { type: 'string', default: '900' }, credits: { type: 'string', default: '10000' }, units: { type: 'string', default: '0' },
        cdn: { type: 'string', default: process.env.RA2_BENCHMARK_CDN ?? resolve(repoRoot, '.cache/ai-resources/cdn') },
        out: { type: 'string', default: resolve(projectRoot, '.artifacts/ai-tournament/final') },
        resume: { type: 'boolean', default: false }, 'retry-errors': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
    } });
    if (args.help) {
        process.stdout.write(`Usage: bun e2e/ai-tournament.ts --candidate-ref COMMIT [options]
  --baseline-ref 04a9f7a          Fixed previous stable bot; both profiles default to brutal
  --countries NAME,...           Default all 9 countries, every ordered distinct-country pair
  --scenarios mp08t2:1011,tn01t2:2022,mp11t2:3033
  --concurrency 3 --max-ticks 27000 --sample-ticks 900
  --cdn PATH --out PATH          Prepared resources and tournament output directory
  --resume                      Verify the original manifest and reuse complete paired jobs
  --retry-errors                With --resume, archive and rerun paired jobs containing errors
  --dry-run                     Validate inputs and print the schedule without running games
Each job runs both spawn/player-order swaps. Defaults: 216 jobs, 432 real games.
summary.json contains W/L/D/errors, primary wins/valid-including-draws, and explicit auxiliary rates.
Incomplete jobs are rerun in place on resume; complete error games remain errors.
Do not change engine or runner code during a tournament. SIGINT preserves completed reports.
These are fresh seeds on known maps; the schedule does not establish unseen-map or human performance.
`);
        return;
    }
    if (!args['candidate-ref'] || args['candidate-ref'] === 'working-tree') throw new Error('--candidate-ref must identify an immutable Git commit');
    if (args['retry-errors'] && !args.resume) throw new Error('--retry-errors requires --resume');
    for (const key of ['candidate-profile', 'baseline-profile'] as const) if (!['normal', 'brutal'].includes(args[key]!)) throw new Error(`Invalid --${key}`);
    const concurrency = integer(args.concurrency!, 'concurrency');
    const maxTicks = integer(args['max-ticks']!, 'max-ticks');
    const sampleTicks = integer(args['sample-ticks']!, 'sample-ticks');
    const credits = integer(args.credits!, 'credits', 0), unitCount = integer(args.units!, 'units', 0);
    const countries = args.countries!.split(',');
    const scenarios = args.scenarios!.split(',').map(value => {
        const parts = value.split(':');
        if (parts.length !== 2) throw new Error(`Invalid scenario ${value}`);
        return { map: parts[0], seed: integer(parts[1], 'scenarios', 0) };
    });
    const jobs = createTournamentJobs(countries, scenarios);
    const resolveCommit = (ref: string) => git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
    const [candidateCommit, baselineCommit, engineCommit] = await Promise.all([
        resolveCommit(args['candidate-ref']), resolveCommit(args['baseline-ref']!), git('rev-parse', 'HEAD'),
    ]);
    for (const commit of [candidateCommit, baselineCommit]) await git('cat-file', '-e', `${commit}:ts-redalert2/src/game/ai/thirdpartbot/builtIn/BuiltInBotAdapter.ts`);
    const engineStatus = await git('status', '--porcelain', '--untracked-files=all', '--', 'ts-redalert2/src',
        ':(exclude)ts-redalert2/src/game/ai/thirdpartbot/builtIn', ':(exclude)ts-redalert2/src/test');
    if (engineStatus && !args['dry-run']) throw new Error('Freeze the engine before running a tournament; engine source has uncommitted changes');
    const engineSourceSha256 = await sourceDigest(join(projectRoot, 'src'), path => /\.(ts|tsx)$/.test(path) && !path.startsWith('test/') &&
        (!path.startsWith('game/ai/thirdpartbot/builtIn/') || path === 'game/ai/thirdpartbot/builtIn/game-api.ts'));
    const runnerSourceSha256 = await sourceDigest(join(projectRoot, 'e2e'), path => /^ai-.*\.ts$/.test(path));
    const iniSha256 = hash(await readFile(join(projectRoot, 'public/ini.mix')));
    const customIniSha256 = hash(await readFile(join(projectRoot, 'public/res/ra2cd.mix')));
    const resourceScenarios = await Promise.all(scenarios.map(async scenario => {
        const mapFile = /\.(map|mpr)$/.test(scenario.map) ? scenario.map : `${scenario.map}.map`;
        const bytes = await readFile(resolve(args.cdn!, 'maps', mapFile));
        const theater = /^\s*Theater\s*=\s*([^;\r\n]+)/im.exec(bytes.toString())?.[1].trim().toUpperCase();
        const terrainFile = ({ TEMPERATE: 'isotemp.mix', URBAN: 'isourb.mix', SNOW: 'isosnow.mix' } as Record<string, string>)[theater ?? ''];
        if (!terrainFile) throw new Error(`Unsupported/missing theater in ${mapFile}: ${theater}`);
        return { ...scenario, mapSha256: hash(bytes), terrainFile,
            terrainSha256: hash(await readFile(resolve(args.cdn!, 'game-res/v2', terrainFile))) };
    }));
    const config = { candidateCommit, baselineCommit, candidateProfile: args['candidate-profile']!, baselineProfile: args['baseline-profile']!,
        engineCommit, engineSourceSha256, runnerSourceSha256, bunVersion: Bun.version, lockfileSha256: hash(await readFile(join(projectRoot, 'bun.lock'))),
        resourceLoaderSha256: hash(await readFile(join(projectRoot, 'deploy/prepare-resources.ts'))),
        countries, scenarios: resourceScenarios, maxTicks, sampleTicks, credits, unitCount, iniSha256, customIniSha256,
        engineDifficulty: 4, pairedSpawnSwap: true, pairedPlayerOrderSwap: true };
    const fingerprint = hash(JSON.stringify(config));
    const verifyRuntimeSources = async () => {
        const [head, engineHash, runnerHash, lockHash, loaderHash] = await Promise.all([
            git('rev-parse', 'HEAD'),
            sourceDigest(join(projectRoot, 'src'), path => /\.(ts|tsx)$/.test(path) && !path.startsWith('test/') &&
                (!path.startsWith('game/ai/thirdpartbot/builtIn/') || path === 'game/ai/thirdpartbot/builtIn/game-api.ts')),
            sourceDigest(join(projectRoot, 'e2e'), path => /^ai-.*\.ts$/.test(path)),
            readFile(join(projectRoot, 'bun.lock')).then(hash),
            readFile(join(projectRoot, 'deploy/prepare-resources.ts')).then(hash),
        ]);
        if (head !== config.engineCommit || engineHash !== config.engineSourceSha256 || runnerHash !== config.runnerSourceSha256 ||
            lockHash !== config.lockfileSha256 || loaderHash !== config.resourceLoaderSha256) {
            throw new Error('Runtime source changed during tournament; this job is unverified and must be rerun with the frozen configuration');
        }
    };
    if (args['dry-run']) {
        process.stdout.write(JSON.stringify({ fingerprint, jobs: jobs.length, games: jobs.length * 2, concurrency,
            scenarios: resourceScenarios, countries, countryLabels: COUNTRY_LABELS, candidateCommit, baselineCommit,
            engineDirty: !!engineStatus, firstJobs: jobs.slice(0, 3) }, null, 2) + '\n');
        return;
    }
    const output = resolve(args.out!), manifestPath = join(output, 'manifest.json');
    await mkdir(join(output, 'jobs'), { recursive: true });
    const existingManifest = Bun.file(manifestPath);
    if (await existingManifest.exists()) {
        if (!args.resume) throw new Error(`Output already has a manifest. Use --resume or choose another --out: ${output}`);
        const manifest = await existingManifest.json();
        if (manifest.fingerprint !== fingerprint || JSON.stringify(manifest.config) !== JSON.stringify(config)) throw new Error('Resume refused: frozen versions, source hashes, resources or schedule do not match the original manifest');
    } else {
        if (args.resume) throw new Error('--resume requires an existing manifest.json');
        await atomicJson(manifestPath, { format: 1, fingerprint, createdAt: new Date().toISOString(), config,
            countryLabels: COUNTRY_LABELS, jobs });
    }
    const reports = new Map<string, any>();
    const active = new Map<string, ReturnType<typeof Bun.spawn>>();
    const failures: Record<string, string> = {};
    const completed = new Set<string>();
    const pending = [] as typeof jobs;
    const reportPath = (id: string) => join(output, 'jobs', `${id}.json`);
    const receiptPath = (id: string) => join(output, 'jobs', `${id}.verified.json`);
    const expected = (job: typeof jobs[number]) => ({ ...config,
        ...resourceScenarios.find(scenario => scenario.map === job.map && scenario.seed === job.seed)! });
    for (const job of jobs) {
        const file = Bun.file(reportPath(job.id));
        if (await file.exists()) {
            let report: any, raw: string;
            try { raw = await file.text(); report = JSON.parse(raw); } catch { pending.push(job); continue; }
            let complete: boolean;
            try { complete = validateJobReport(report, job, expected(job)); }
            catch (error) {
                if (!args['retry-errors']) throw error;
                pending.push(job); continue;
            }
            let verified = false;
            try {
                const receipt = await Bun.file(receiptPath(job.id)).json();
                verified = receipt.fingerprint === fingerprint && receipt.reportSha256 === hash(raw!);
            } catch { /* An interrupted worker may finish writing before the coordinator verifies its sources. */ }
            if (complete && verified && !(args['retry-errors'] && report.matches.some((match: any) => match.result === 'error'))) {
                reports.set(job.id, report); completed.add(job.id); continue;
            }
        }
        pending.push(job);
    }
    let writeChain = Promise.resolve();
    const save = () => writeChain = writeChain.then(async () => {
        await atomicJson(join(output, 'summary.json'), { format: 1, fingerprint, updatedAt: new Date().toISOString(),
            completedJobs: completed.size, expectedJobs: jobs.length, activeJobs: [...active.keys()], failedJobs: failures,
            ...summarizeTournament(jobs, reports) });
    });
    let interrupted = false;
    let runtimeChanged = false;
    const stop = () => { interrupted = true; for (const child of active.values()) child.kill(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    let polling = false;
    const timer = setInterval(async () => {
        if (polling) return;
        polling = true;
        try {
            for (const job of jobs.filter(job => active.has(job.id))) {
                try {
                    const report = await Bun.file(reportPath(job.id)).json();
                    validateJobReport(report, job, expected(job));
                    if (active.has(job.id) && !completed.has(job.id)) reports.set(job.id, report);
                } catch { /* A running writer may temporarily expose partial JSON; completion validation is strict. */ }
            }
            await save();
            const counts = summarizeTournament(jobs, reports).total;
            process.stderr.write(`Progress jobs=${completed.size}/${jobs.length} active=${active.size} games=${counts.total}/${jobs.length * 2} W/L/D/E=${counts.wins}/${counts.losses}/${counts.draws}/${counts.errors}\n`);
        } finally { polling = false; }
    }, 15000);
    await save();
    let index = 0;
    const worker = async () => {
        while (!interrupted && index < pending.length) {
            const job = pending[index++];
            const logPath = join(output, 'jobs', `${job.id}.log`);
            process.stderr.write(`Starting ${job.id}\n`);
            const command = [process.execPath, 'e2e/ai-benchmark.ts', '--candidate-ref', candidateCommit, '--baseline-ref', baselineCommit,
                '--candidate-profile', config.candidateProfile, '--baseline-profile', config.baselineProfile,
                '--map', job.map, '--seeds', String(job.seed), '--matchups', `${job.candidateCountry}:${job.baselineCountry}`,
                '--max-ticks', String(maxTicks), '--sample-ticks', String(sampleTicks), '--credits', String(credits), '--units', String(unitCount),
                '--cdn', resolve(args.cdn!), '--out', reportPath(job.id)];
            try {
                await verifyRuntimeSources();
                await archiveJobAttempt(output, job.id);
                reports.delete(job.id);
                const child = Bun.spawn(command, { cwd: projectRoot, stdout: 'ignore', stderr: Bun.file(logPath) });
                active.set(job.id, child);
                await save();
                const exitCode = await child.exited;
                await verifyRuntimeSources();
                const raw = await Bun.file(reportPath(job.id)).text();
                const report = JSON.parse(raw);
                const complete = validateJobReport(report, job, expected(job));
                if (!complete) throw new Error(`incomplete paired report (exit ${exitCode})`);
                if (exitCode && !report.matches.some((match: any) => match.result === 'error')) throw new Error(`worker exited ${exitCode} despite a complete error-free report`);
                await atomicJson(receiptPath(job.id), { fingerprint, reportSha256: hash(raw), verifiedAt: new Date().toISOString() });
                reports.set(job.id, report);
                completed.add(job.id);
                process.stderr.write(`Finished ${job.id}: ${report.matches.map((match: any) => match.result).join(', ')}\n`);
            } catch (error) {
                reports.delete(job.id);
                failures[job.id] = String(error);
                process.stderr.write(`Failed ${job.id}: ${error}; see ${logPath}\n`);
                if (String(error).includes('Runtime source changed')) { runtimeChanged = true; stop(); }
            } finally {
                active.delete(job.id);
            }
            await save();
        }
    };
    try { await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker)); }
    finally {
        clearInterval(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
        await save();
    }
    const summary = summarizeTournament(jobs, reports);
    process.stdout.write(JSON.stringify({ ...summary.total, completedJobs: completed.size, failedJobs: failures,
        summaryPath: join(output, 'summary.json') }, null, 2) + '\n');
    if (interrupted && !runtimeChanged) process.exitCode = 130;
    else if (Object.keys(failures).length || summary.total.errors || summary.total.pending) process.exitCode = 1;
}

if (import.meta.main) await main();

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { archiveJobAttempt } from '../../ai-tournament-storage';
import { validateJobReport } from '../../ai-tournament-plan';
import { BUILTIN, gitQuery, loadLeague } from '../registry';
import type { FrozenMember } from '../run';
import { convertResult, type GameResult } from '../schedule';
import { ALL_MAPS, HOLDOUT_MAPS, HOLDOUT_OPPONENTS, MATCHUPS, TRAIN_MAPS, jobId, promotionSeed, trainingSeed, type ArenaJob } from './arena';
import { advanceStop, predict, validateValueModel, type StopState, type ValueModel } from './valueCore';

const projectRoot = resolve(import.meta.dir, '../../..');
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export interface ArenaGame {
    stage: ArenaJob['stage'];
    run: number | null;
    generation: number | null;
    promotion: number | null;
    a: string;
    b: string;
    aTree: string;
    bTree: string;
    map: string;
    seed: number;
    aCountry: ArenaJob['aCountry'];
    bCountry: ArenaJob['bCountry'];
    swapped: boolean;
    result: GameResult;
    reason: string;
    ticks: number;
}
export interface PlayerSample {
    credits: number;
    creditsReceived: number;
    creditsSpent: number;
    harvesters: number;
    buildings: number;
    army: number;
    assetValue: number;
    kills: number;
    losses: number;
    refineries: number;
    factories: number;
}
export interface ArenaSample { game: string; tick: number; result: GameResult; a: PlayerSample; b: PlayerSample }
export interface ArenaResources {
    iniSha256: string;
    customIniSha256: string;
    maps: Record<string, { mapSha256: string; terrainSha256: string }>;
}

/** Validate the whole batch before resolving refs, creating output files or starting any child process. */
export function validateJobs(value: unknown, earlyStop?: string): ArenaJob[] {
    if (!Array.isArray(value) || !value.length) throw new Error('Jobs must be a nonempty JSON array');
    const seen = new Set<string>();
    for (const raw of value) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Job must be an object');
        const job = raw as ArenaJob;
        if (job.earlyStop !== undefined && typeof job.earlyStop !== 'boolean') throw new Error('Invalid early-stop job flag');
        if (![job.a, job.b].every(id => typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id))) throw new Error('Invalid job member');
        if (![job.aRef, job.bRef].every(ref => typeof ref === 'string' && ref.trim() && ref !== 'working-tree')) throw new Error('Job refs must be frozen');
        if (![job.aProfile, job.bProfile].every(profile => profile === 'normal' || profile === 'brutal')) throw new Error('Invalid job profile');
        if (!MATCHUPS.some(([a, b]) => a === job.aCountry && b === job.bCountry)) throw new Error('Invalid country matchup');
        if (job.stage === 'train') {
            if (!(TRAIN_MAPS as readonly string[]).includes(job.map)) throw new Error('Train job cannot use a holdout or unknown map');
            if ([job.a, job.b, job.aRef, job.bRef].some(reference => HOLDOUT_OPPONENTS.some(id => reference.split(/[=,/~^:]/).includes(id))))
                throw new Error(`Train job cannot use a holdout opponent`);
            if (job.promotion !== null || job.run === null || job.generation === null || job.seed !== trainingSeed(job.run, job.generation, job.map))
                throw new Error('Invalid train job seed or stage fields');
        } else if (job.stage === 'holdout') {
            if (!(HOLDOUT_MAPS as readonly string[]).includes(job.map)) throw new Error('Holdout job must use a holdout map');
            if (earlyStop !== undefined || raw.earlyStop === true) throw new Error('Holdout jobs must never use early stopping');
            if (job.run !== null || job.generation !== null || job.promotion === null || job.seed !== promotionSeed(job.promotion, job.map))
                throw new Error('Invalid holdout job seed or stage fields');
        } else throw new Error('Job stage must be train or holdout');
        if (job.id !== jobId(job) || seen.has(job.id)) throw new Error('Invalid or duplicate job id');
        seen.add(job.id);
    }
    return value as ArenaJob[];
}
export function benchmarkCommand(job: ArenaJob, cdn: string, out: string, earlyStop?: string): string[] {
    const command = [process.execPath, 'e2e/ai-benchmark.ts', '--candidate-ref', job.aRef, '--baseline-ref', job.bRef,
        '--candidate-profile', job.aProfile, '--baseline-profile', job.bProfile, '--map', job.map, '--seeds', String(job.seed),
        '--matchups', `${job.aCountry}:${job.bCountry}`, '--max-ticks', '27000', '--sample-ticks', '900',
        '--credits', '10000', '--units', '0', '--cdn', cdn, '--out', out];
    const model = earlyStop ?? (job.earlyStop ? join(import.meta.dir, 'valueModel.json') : undefined);
    if (model !== undefined) command.push('--early-stop', model);
    return command;
}
export function samplePlayer(player: any): PlayerSample {
    const fields = ['credits', 'creditsReceived', 'creditsSpent', 'harvesters', 'buildings', 'army', 'assetValue', 'kills', 'losses'] as const;
    if (!player?.counts || fields.some(field => !Number.isFinite(player[field]) || player[field] < 0)) throw new Error('Missing or invalid player sampling data');
    return { credits: player.credits, creditsReceived: player.creditsReceived, creditsSpent: player.creditsSpent,
        harvesters: player.harvesters, buildings: player.buildings, army: player.army, assetValue: player.assetValue,
        kills: player.kills, losses: player.losses,
        refineries: (player.counts.GAREFN ?? 0) + (player.counts.NAREFN ?? 0),
        factories: (player.counts.GAWEAP ?? 0) + (player.counts.NAWEAP ?? 0) };
}
export interface EarlyStopModel { model: ValueModel; sha256: string }
export function normalizeReport(report: any, job: ArenaJob, a: FrozenMember, b: FrozenMember, engineCommit: string, resources: ArenaResources, earlyStop?: EarlyStopModel) {
    let validationReport = report;
    if (earlyStop) {
        if (job.stage !== 'train' || report.settings?.earlyStop?.sha256 !== earlyStop.sha256 || report.settings.earlyStop.threshold !== earlyStop.model.threshold)
            throw new Error(`${job.id}: early-stop model or stage mismatch`);
        validationReport = { ...report, matches: report.matches?.map((match: any) => {
            if (match.reason !== 'value-model-early-stop') return match;
            if (!['candidate-win', 'baseline-win'].includes(match.result) || !Number.isSafeInteger(match.ticks) || match.ticks < 9900 || match.ticks >= 27000 || match.ticks % 900 !== 0)
                throw new Error(`${job.id}: invalid early-stop ending`);
            let state: StopState = { side: null, count: 0 }, winner: 'a' | 'b' | null = null, stopTick = -1;
            for (const sample of match.samples ?? []) {
                if (sample.tick % 900 !== 0 || sample.tick >= 27000) continue;
                const probability = predict(earlyStop.model, sample.tick, samplePlayer(sample.players?.[0]), samplePlayer(sample.players?.[1]));
                const next = advanceStop(state, sample.tick, probability, earlyStop.model.threshold); state = next.state;
                if (next.winner) { winner = next.winner; stopTick = sample.tick; break; }
            }
            if (stopTick !== match.ticks || winner !== (match.result === 'candidate-win' ? 'a' : 'b')) throw new Error(`${job.id}: early-stop prediction mismatch`);
            // The legacy validator knows only native winners. Adapt its input after verifying the training-only prediction;
            // the original report and exported reason remain value-model-early-stop, never an engine victory.
            return { ...match, reason: 'engine-victory-conditions' };
        }) };
    } else if (report.settings?.earlyStop) throw new Error(`${job.id}: unexpected early-stop model`);
    const expected = { candidateCommit: a.commit, baselineCommit: b.commit, engineCommit, candidateProfile: a.profile, baselineProfile: b.profile,
        maxTicks: 27000, sampleTicks: 900, credits: 10000, unitCount: 0, iniSha256: resources.iniSha256,
        customIniSha256: resources.customIniSha256, ...resources.maps[job.map] };
    if (!validateJobReport(validationReport, { id: job.id, map: job.map, seed: job.seed, candidateCountry: job.aCountry, baselineCountry: job.bCountry }, expected))
        throw new Error(`${job.id}: incomplete paired report`);
    if (!Array.isArray(report.startupIssues) || report.startupIssues.length) throw new Error(`${job.id}: invalid benchmark startup`);
    const games: ArenaGame[] = [], samples: ArenaSample[] = [];
    for (const match of [...report.matches].sort((x, y) => Number(x.swapped) - Number(y.swapped))) {
        if (match.result !== 'error' && (!Array.isArray(match.startingLocations) || match.startingLocations.length !== 2 ||
            match.startingLocations.some((point: any) => !Number.isFinite(point.x) || !Number.isFinite(point.y)))) throw new Error(`${job.id}: missing physical starts`);
        const result = convertResult(match.result);
        games.push({ stage: job.stage, run: job.run, generation: job.generation, promotion: job.promotion,
            a: job.a, b: job.b, aTree: a.tree, bTree: b.tree, map: job.map, seed: job.seed,
            aCountry: job.aCountry, bCountry: job.bCountry, swapped: match.swapped, result, reason: match.reason, ticks: match.ticks ?? 0 });
        if (!Array.isArray(match.samples) || (!match.samples.length && result !== 'error')) throw new Error(`${job.id}: missing samples`);
        let previousTick = -1;
        for (const sample of match.samples) {
            if (!Number.isSafeInteger(sample.tick) || sample.tick <= previousTick || sample.tick > match.ticks ||
                sample.players?.length !== 2 || sample.players[0].name !== match.candidatePlayerName || sample.players[1].name !== match.baselinePlayerName)
                throw new Error(`${job.id}: invalid sample order or player perspective`);
            samples.push({ game: `${job.id}#${match.swapped}`, tick: sample.tick, result, a: samplePlayer(sample.players[0]), b: samplePlayer(sample.players[1]) });
            previousTick = sample.tick;
        }
    }
    return { games, samples };
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
    if (engineStatus) throw new Error('Freeze the engine source before running the arena');
    return { engineCommit: await gitQuery(['rev-parse', 'HEAD']),
        engineSource: await digestFiles(join(projectRoot, 'src'), path => /\.(ts|tsx)$/.test(path) && !path.startsWith('test/') &&
            (!path.startsWith('game/ai/thirdpartbot/builtIn/') || path === 'game/ai/thirdpartbot/builtIn/game-api.ts')),
        benchmarkSources: await digestFiles(join(projectRoot, 'e2e'), path => /^ai-.*\.ts$/.test(path)),
        arenaSources: Object.fromEntries(await Promise.all(['arena.ts', 'play.ts', '../registry.ts', '../schedule.ts'].map(async path =>
            [path, hash(await readFile(join(import.meta.dir, path)))]))),
        lockfile: hash(await readFile(join(projectRoot, 'bun.lock'))),
        resourceLoader: hash(await readFile(join(projectRoot, 'deploy/prepare-resources.ts'))), bunVersion: Bun.version };
}
async function readResources(cdn: string): Promise<ArenaResources> {
    const maps: ArenaResources['maps'] = {}, terrains = new Map<string, string>();
    for (const map of ALL_MAPS) {
        const bytes = await readFile(join(cdn, 'maps', `${map}.map`));
        const theater = /^\s*Theater\s*=\s*([^;\r\n]+)/im.exec(bytes.toString())?.[1].trim().toUpperCase();
        const terrain = ({ TEMPERATE: 'isotemp.mix', URBAN: 'isourb.mix', SNOW: 'isosnow.mix' } as Record<string, string>)[theater ?? ''];
        if (!terrain) throw new Error(`Missing/unsupported theater in ${map}`);
        if (!terrains.has(terrain)) terrains.set(terrain, hash(await readFile(join(cdn, 'game-res/v2', terrain))));
        maps[map] = { mapSha256: hash(bytes), terrainSha256: terrains.get(terrain)! };
    }
    return { maps, iniSha256: hash(await readFile(join(projectRoot, 'public/ini.mix'))), customIniSha256: hash(await readFile(join(projectRoot, 'public/res/ra2cd.mix'))) };
}
async function atomicJson(path: string, value: unknown) {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n'); await rename(temporary, path);
}

export async function main() {
    const started = performance.now();
    const { values } = parseArgs({ options: { jobs: { type: 'string' }, out: { type: 'string' }, concurrency: { type: 'string', default: '4' },
        resume: { type: 'boolean' }, 'early-stop': { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) { console.log('bun e2e/league/p4/play.ts --jobs FILE --out DIR --concurrency K [--resume] [--early-stop MODEL]'); return; }
    if (!values.jobs || !values.out) throw new Error('--jobs and --out are required');
    const concurrency = Number(values.concurrency);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid --concurrency');
    const jobs = validateJobs(await Bun.file(values.jobs).json(), values['early-stop']).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const modelPath = values['early-stop'] ?? (jobs.some(job => job.earlyStop) ? join(import.meta.dir, 'valueModel.json') : undefined);
    const modelText = modelPath === undefined ? undefined : await readFile(modelPath, 'utf8');
    const earlyStop: EarlyStopModel | undefined = modelText === undefined ? undefined : { model: validateValueModel(JSON.parse(modelText)), sha256: hash(modelText) };
    const valueModel = earlyStop ? { path: modelPath!, sha256: earlyStop.sha256, coreSha256: hash(await readFile(join(import.meta.dir, 'valueCore.ts'))) } : undefined;
    const modelForJob = (job: ArenaJob) => values['early-stop'] !== undefined || job.earlyStop ? earlyStop : undefined;
    const cdnInput = process.env.RA2_BENCHMARK_CDN;
    if (!cdnInput) throw new Error('Set RA2_BENCHMARK_CDN');
    const cdn = resolve(cdnInput), output = resolve(values.out), league = await loadLeague();
    const versions: Record<string, FrozenMember> = {};
    for (const job of jobs) for (const side of ['a', 'b'] as const) {
        const id = job[side], ref = job[`${side}Ref`], profile = job[`${side}Profile`];
        if (versions[id]) {
            if (versions[id].ref !== ref || versions[id].profile !== profile) throw new Error(`Conflicting snapshots for ${id}`);
            continue;
        }
        const member = league.members.find(member => member.id === id);
        const commit = await gitQuery(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
        const tree = await gitQuery(['rev-parse', '--verify', '--end-of-options', `${commit}:${BUILTIN}`]);
        await gitQuery(['cat-file', '-e', `${commit}:${BUILTIN}/BuiltInBotAdapter.ts`]);
        if (member && (tree !== member.tree || profile !== member.profile)) throw new Error(`Changed registered snapshot/profile for ${id}`);
        versions[id] = { id, ref, commit, tree, profile };
    }
    const holdoutTrees = new Set(league.members.filter(member => HOLDOUT_OPPONENTS.includes(member.id)).map(member => member.tree));
    for (const job of jobs) if (job.stage === 'train' && [job.a, job.b].some(id => holdoutTrees.has(versions[id].tree)))
        throw new Error(`Train job ${job.id} aliases a holdout snapshot`);
    const runtime = await runtimeSnapshot(), resources = await readResources(cdn);
    const config = { jobs, versions, runtime, resources, cdn, earlyStop: values['early-stop'] ?? null, ...(valueModel ? { valueModel } : {}) };
    const fingerprint = hash(JSON.stringify(config)), manifestPath = join(output, 'manifest.json');
    const verifyRuntime = async () => {
        if (valueModel && (hash(await readFile(valueModel.path)) !== valueModel.sha256 || hash(await readFile(join(import.meta.dir, 'valueCore.ts'))) !== valueModel.coreSha256))
            throw new Error('Frozen value model changed during arena execution');
        if (JSON.stringify(await runtimeSnapshot()) !== JSON.stringify(runtime) || JSON.stringify(await readResources(cdn)) !== JSON.stringify(resources))
            throw new Error('Frozen runtime/resources changed during arena execution');
    };
    if (await Bun.file(manifestPath).exists()) {
        if (!values.resume) throw new Error('Output exists; choose a new --out or explicitly --resume');
        const manifest = await Bun.file(manifestPath).json();
        if (manifest.fingerprint !== fingerprint || JSON.stringify(manifest.config) !== JSON.stringify(config)) throw new Error('Resume refused: frozen schedule/configuration changed');
    } else {
        let entries: string[] = []; try { entries = await readdir(output); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (entries.length) throw new Error('Refusing to overwrite an existing output directory without an arena manifest');
        await mkdir(join(output, 'jobs'), { recursive: true });
        await atomicJson(manifestPath, { schema: 1, fingerprint, config });
    }
    const results = new Map<string, ReturnType<typeof normalizeReport>>(), pending: ArenaJob[] = [];
    const reportPath = (job: ArenaJob) => join(output, 'jobs', `${job.id}.json`);
    for (const job of jobs) {
        const file = Bun.file(reportPath(job));
        if (await file.exists()) {
            if (!values.resume) throw new Error(`Refusing to overwrite ${job.id}`);
            try {
                const text = await file.text(), rows = normalizeReport(JSON.parse(text), job, versions[job.a], versions[job.b], runtime.engineCommit, resources, modelForJob(job));
                const receipt = await Bun.file(join(output, 'jobs', `${job.id}.verified.json`)).json();
                if (!rows.games.some(row => row.result === 'error') && receipt.fingerprint === fingerprint && receipt.reportSha256 === hash(text)) { results.set(job.id, rows); continue; }
            } catch { /* Interrupted, invalid or error jobs are preserved before a fresh paired run. */ }
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
                await verifyRuntime(); await archiveJobAttempt(output, job.id);
                console.error(`Starting ${job.id}`);
                const child = Bun.spawn(benchmarkCommand(job, cdn, reportPath(job), values['early-stop']), {
                    cwd: projectRoot, stdout: 'ignore', stderr: Bun.file(join(output, 'jobs', `${job.id}.log`)) });
                active.add(child); const code = await child.exited; active.delete(child);
                await verifyRuntime();
                const text = await Bun.file(reportPath(job)).text(), rows = normalizeReport(JSON.parse(text), job, versions[job.a], versions[job.b], runtime.engineCommit, resources, modelForJob(job));
                if (code && !rows.games.some(row => row.result === 'error')) throw new Error(`Worker exit ${code} despite complete error-free report`);
                results.set(job.id, rows);
                await atomicJson(join(output, 'jobs', `${job.id}.verified.json`), { fingerprint, reportSha256: hash(text) });
                console.error(`Finished ${job.id}: ${rows.games.map(row => row.result).join(', ')} (${results.size}/${jobs.length} jobs)`);
            } catch (error) {
                failures[job.id] = error instanceof Error ? error.message : String(error); console.error(`Failed ${job.id}: ${failures[job.id]}`); interrupted = true;
            }
        }
    };
    try { await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker)); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    const games = jobs.flatMap(job => results.get(job.id)?.games ?? []), samples = jobs.flatMap(job => results.get(job.id)?.samples ?? []);
    for (const [name, rows] of [['games', games], ['samples', samples]] as const) {
        const temporary = join(output, `${name}.jsonl.${process.pid}.tmp`);
        await writeFile(temporary, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')); await rename(temporary, join(output, `${name}.jsonl`));
    }
    const summary = { expectedJobs: jobs.length, completedJobs: results.size, expectedGames: jobs.length * 2, games: games.length, samples: samples.length,
        results: Object.fromEntries(['a-win', 'b-win', 'timeout', 'error'].map(result => [result, games.filter(row => row.result === result).length])),
        failures, interrupted, wallSeconds: (performance.now() - started) / 1000 };
    await atomicJson(join(output, 'summary.json'), summary); console.log(JSON.stringify(summary, null, 2));
    if (interrupted || Object.keys(failures).length || games.length !== jobs.length * 2 || games.some(row => row.result === 'error')) process.exitCode = 1;
}
if (import.meta.main) {
    try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

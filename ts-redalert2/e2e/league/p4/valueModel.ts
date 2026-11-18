import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { jobId } from './arena';
import { validateJobs, type ArenaGame, type ArenaSample } from './play';
import { evaluate, features, train, validateValueModel } from './valueCore';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export async function trainingSamples(files: readonly string[]) {
    const samples: ArenaSample[] = [], sources: { file: string; sha256: string; gamesSha256: string; manifestSha256: string; samples: number }[] = [];
    const seen = new Set<string>();
    for (const supplied of files) {
        const file = resolve(supplied), text = await readFile(file, 'utf8');
        const manifestText = await readFile(resolve(dirname(file), 'manifest.json'), 'utf8'), manifest = JSON.parse(manifestText);
        const jobs = validateJobs(manifest.config?.jobs);
        if (jobs.some(job => job.stage !== 'train' || job.earlyStop) || manifest.config.earlyStop || manifest.config.valueModel)
            throw new Error('Value-model data must be complete training games without early stopping; holdouts are forbidden');
        const gamesText = await readFile(resolve(dirname(file), 'games.jsonl'), 'utf8');
        const games: ArenaGame[] = gamesText.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
        const truth = new Map<string, ArenaGame>(games.map(game => [`${jobId(game)}#${game.swapped}`, game]));
        const expected = new Map(jobs.flatMap(job => [false, true].map(swapped => [`${job.id}#${swapped}`, job] as const)));
        if (games.length !== expected.size || truth.size !== games.length || games.some(game => {
            const job = expected.get(`${jobId(game)}#${game.swapped}`);
            return !job || game.stage !== 'train' || game.run !== job.run || game.generation !== job.generation || game.promotion !== null ||
                game.aTree !== manifest.config.versions?.[game.a]?.tree || game.bTree !== manifest.config.versions?.[game.b]?.tree ||
                !['a-win', 'b-win', 'timeout'].includes(game.result) || !Number.isSafeInteger(game.ticks) || game.ticks < 1 || game.ticks > 27000 ||
                game.reason !== 'engine-victory-conditions' && !(game.reason === 'tick-limit' && game.result === 'timeout' && game.ticks === 27000);
        })) throw new Error('Invalid or incomplete full-length training games');
        const rows: ArenaSample[] = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
        const lastTicks = new Map<string, number>();
        for (const row of rows) {
            const game = truth.get(row.game), key = `${row.game}/${row.tick}`, previous = lastTicks.get(row.game);
            if (!game || seen.has(key) || row.result !== game.result || !Number.isSafeInteger(row.tick) || row.tick < 0 || row.tick > game.ticks ||
                (previous === undefined ? row.tick !== 0 : row.tick <= previous) ||
                [row.a, row.b].some(player => !player || Object.values(player).some(value => !Number.isFinite(value) || value < 0)) ||
                features(row.a, row.b).some(value => !Number.isFinite(value)))
                throw new Error('Sample identity/result/tick or metrics do not match its training game');
            seen.add(key); lastTicks.set(row.game, row.tick);
        }
        if (games.some(game => lastTicks.get(`${jobId(game)}#${game.swapped}`) !== game.ticks)) throw new Error('Missing final training samples');
        samples.push(...rows); sources.push({ file: supplied, sha256: hash(text), gamesSha256: hash(gamesText), manifestSha256: hash(manifestText), samples: rows.length });
    }
    return { samples, sources };
}
export async function main() {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { samples: { type: 'string' }, out: { type: 'string' }, model: { type: 'string' } } });
    if (!values.samples) throw new Error('--samples F1[,F2...] is required');
    const { samples, sources } = await trainingSamples(values.samples.split(','));
    if (positionals[0] === 'train') {
        if (!values.out) throw new Error('--out is required');
        const model = train(samples), first = evaluate(samples, model, 0.97);
        const evaluation = first.V1 < 0.98 ? evaluate(samples, model, 0.99) : first;
        model.threshold = evaluation.threshold; model.accepted = evaluation.accepted;
        const stored = { ...model, sources, sampleCount: samples.length, validation: { V1: evaluation.V1, V2: evaluation.V2, V3: evaluation.V3,
            accuracies: evaluation.accuracies, stoppedGames: evaluation.stoppedGames, meanSavedTicks: evaluation.meanSavedTicks },
            thresholdAttempts: first.V1 < 0.98 ? [0.97, 0.99] : [0.97] };
        validateValueModel(stored, false);
        await mkdir(dirname(resolve(values.out)), { recursive: true }); await writeFile(resolve(values.out), JSON.stringify(stored, null, 2) + '\n');
        console.log(JSON.stringify(stored, null, 2));
    } else if (positionals[0] === 'eval') {
        if (!values.model) throw new Error('--model is required');
        const model = validateValueModel(JSON.parse(await readFile(resolve(values.model), 'utf8')), false), evaluation = evaluate(samples, model);
        console.log(JSON.stringify(evaluation, null, 2));
    } else throw new Error('Usage: valueModel.ts train|eval --samples FILE[,FILE] (--out MODEL | --model MODEL)');
}
if (import.meta.main) {
    try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

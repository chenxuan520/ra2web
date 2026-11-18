import type { ArenaSample, PlayerSample } from './play';

export interface SegmentModel { start: number; end: number; w0: number; w: number[]; mean: number[]; std: number[]; samples: number }
export interface ValueModel {
    segments: SegmentModel[]; threshold: number; accepted: boolean;
    validation?: { V1: number; V2: number; V3: number };
}
export const SEGMENTS = [[9000, 13500], [13500, 18000], [18000, 27000]] as const;
const inSegment = (tick: number, start: number, end: number) => tick >= start && (tick < end || end === 27000 && tick === end);
export function features(a: PlayerSample, b: PlayerSample): number[] {
    return [Math.log((a.assetValue + 1000) / (b.assetValue + 1000)), Math.log((a.army + 1) / (b.army + 1)),
        Math.log((a.harvesters + 1) / (b.harvesters + 1)), Math.log((a.creditsReceived + 1000) / (b.creditsReceived + 1000)),
        Math.log((a.creditsSpent + 1000) / (b.creditsSpent + 1000)), Math.log((a.kills + 1) / (b.kills + 1)),
        Math.log((a.buildings + 1) / (b.buildings + 1)), a.factories - b.factories, a.refineries - b.refineries];
}
export function fnv1a(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
    return hash;
}
export const isValidation = (game: string) => fnv1a(game) % 5 === 0;
export const sigmoid = (value: number) => value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
export function trainSegment(samples: readonly ArenaSample[], start: number, end: number): SegmentModel {
    const rows = samples.filter(sample => !isValidation(sample.game) && inSegment(sample.tick, start, end) && (sample.result === 'a-win' || sample.result === 'b-win'));
    const observations = rows.flatMap(sample => {
        const vector = features(sample.a, sample.b), label = sample.result === 'a-win' ? 1 : 0;
        return [{ vector, label }, { vector: vector.map(value => -value), label: 1 - label }];
    });
    const mean = Array(9).fill(0), std = Array(9).fill(0), w = Array(9).fill(0);
    for (const row of observations) for (let index = 0; index < 9; index++) mean[index] += row.vector[index];
    for (let index = 0; index < 9; index++) mean[index] = observations.length ? mean[index] / observations.length : 0;
    for (const row of observations) for (let index = 0; index < 9; index++) std[index] += (row.vector[index] - mean[index]) ** 2;
    for (let index = 0; index < 9; index++) std[index] = Math.sqrt(observations.length ? std[index] / observations.length : 0) || 1;
    const normalized = observations.map(row => ({ label: row.label, vector: row.vector.map((value, index) => (value - mean[index]) / std[index]) }));
    let w0 = 0;
    if (normalized.length) for (let iteration = 0; iteration < 2000; iteration++) {
        const gradient = Array(9).fill(0); let intercept = 0;
        for (const row of normalized) {
            let sum = w0; for (let index = 0; index < 9; index++) sum += w[index] * row.vector[index];
            const error = sigmoid(sum) - row.label; intercept += error;
            for (let index = 0; index < 9; index++) gradient[index] += error * row.vector[index];
        }
        w0 -= 0.1 * intercept / normalized.length;
        for (let index = 0; index < 9; index++) w[index] -= 0.1 * (gradient[index] / normalized.length + 0.01 * w[index]);
    }
    return { start, end, w0, w, mean, std, samples: observations.length };
}
export function train(samples: readonly ArenaSample[]): ValueModel {
    return { segments: SEGMENTS.map(([start, end]) => trainSegment(samples, start, end)), threshold: 0.97, accepted: false };
}
export function validateValueModel(value: unknown, requireAccepted = true): ValueModel {
    const model = value as ValueModel;
    if (!model || !Array.isArray(model.segments) || model.segments.length !== 3 || ![0.97, 0.99].includes(model.threshold) || typeof model.accepted !== 'boolean')
        throw new Error('Invalid value model');
    for (const [index, segment] of model.segments.entries()) {
        if (!segment || segment.start !== SEGMENTS[index][0] || segment.end !== SEGMENTS[index][1] || !Number.isFinite(segment.w0) ||
            !Number.isSafeInteger(segment.samples) || segment.samples < 0 || [segment.w, segment.mean, segment.std].some(vector =>
                !Array.isArray(vector) || vector.length !== 9 || vector.some(value => !Number.isFinite(value))) || segment.std.some(value => value <= 0))
            throw new Error('Invalid value-model segment');
    }
    const validation = model.validation;
    if (model.accepted && (!validation || !Number.isFinite(validation.V1) || validation.V1 < 0.98 || validation.V1 > 1 ||
        !Number.isFinite(validation.V2) || validation.V2 < 0.30 || validation.V2 > 1 || !Number.isSafeInteger(validation.V3) || validation.V3 < 150))
        throw new Error('Value model has not passed V1-V3');
    if (requireAccepted && !model.accepted) throw new Error('Value model has not passed V1-V3');
    return model;
}
export function predict(model: ValueModel, tick: number, a: PlayerSample, b: PlayerSample): number | null {
    if (tick < 9000) return null;
    const segment = model.segments.find(segment => inSegment(tick, segment.start, segment.end)); if (!segment) return null;
    const vector = features(a, b); let score = segment.w0;
    for (let index = 0; index < 9; index++) score += segment.w[index] * (vector[index] - segment.mean[index]) / segment.std[index];
    return sigmoid(score);
}
export interface StopState { side: 'a' | 'b' | null; count: number }
export function advanceStop(state: StopState, tick: number, probability: number | null, threshold: number): { state: StopState; winner: 'a' | 'b' | null } {
    const side = tick < 9000 || probability === null ? null : probability >= threshold ? 'a' : probability <= 1 - threshold ? 'b' : null;
    const count = side ? state.side === side ? state.count + 1 : 1 : 0;
    return { state: { side, count }, winner: side && count >= 2 ? side : null };
}
export function evaluate(samples: readonly ArenaSample[], model: ValueModel, threshold = model.threshold) {
    const games = new Map<string, ArenaSample[]>();
    for (const sample of samples) if (isValidation(sample.game)) { const rows = games.get(sample.game) ?? []; rows.push(sample); games.set(sample.game, rows); }
    const stopped: { game: string; tick: number; winner: 'a' | 'b'; result: ArenaSample['result']; savedTicks: number; correct: boolean }[] = [];
    const accuracies = SEGMENTS.map(([start, end]) => {
        const rows = samples.filter(sample => isValidation(sample.game) && inSegment(sample.tick, start, end) && (sample.result === 'a-win' || sample.result === 'b-win'));
        const correct = rows.filter(sample => (predict(model, sample.tick, sample.a, sample.b)! >= 0.5) === (sample.result === 'a-win')).length;
        return { start, end, samples: rows.length, accuracy: rows.length ? correct / rows.length : null };
    });
    for (const [game, rows] of games) {
        rows.sort((a, b) => a.tick - b.tick); let state: StopState = { side: null, count: 0 };
        const endTick = rows.at(-1)!.tick;
        for (const row of rows) {
            // The live runner checks periodic samples only, before a native ending or the tick limit.
            if (row.tick % 900 !== 0 || row.tick >= endTick) continue;
            const next = advanceStop(state, row.tick, predict(model, row.tick, row.a, row.b), threshold); state = next.state;
            if (next.winner) {
                const correct = next.winner === 'a' ? row.result === 'a-win' : row.result === 'b-win';
                stopped.push({ game, tick: row.tick, winner: next.winner, result: row.result, savedTicks: endTick - row.tick, correct }); break;
            }
        }
    }
    const V1 = stopped.length ? stopped.filter(game => game.correct).length / stopped.length : 0, V2 = games.size ? stopped.length / games.size : 0, V3 = games.size;
    return { threshold, V1, V2, V3, accepted: V1 >= 0.98 && V2 >= 0.30 && V3 >= 150, accuracies, stoppedGames: stopped.length,
        meanSavedTicks: stopped.length ? stopped.reduce((sum, game) => sum + game.savedTicks, 0) / stopped.length : 0, stopped };
}

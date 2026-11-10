import { describe, expect, test } from 'bun:test';
import { BRUTAL_PARAMS } from '../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams';
import { generateMutants, mutateParameter, parseParams, replaceParams, parameterDiff, selectMutation, type Params } from '../../../e2e/league/evolveCore';

const sample: Params = {
    economy: { armor: 4, credits: 800, radius: 25, zero: 0, tiny: 0.01, radarPriority: 24,
        firstFactoryPriorityAllied: 30, maxRefineries: 4, maxFactories: 3, defenseMaxCount: 1, teslaMaxCount: 1, harvestersPerRefinery: 2 },
    assault: { forceRatio: 1.2, hpFraction: 0.7, floorRatio: 0.3, count: 1, ticks: 10000 },
};
const source = `export const BRUTAL_PARAMS = {
    economy: {
        armor: 4,
        credits: 800,
    },
    assault: {
        forceRatio: 1.2,
    },
};
export type BrutalParams = typeof BRUTAL_PARAMS;
`;

describe('deterministic league parameter evolution', () => {
    test('six mutants are identical for the same seed and leave the parent intact', () => {
        const before = structuredClone(sample), first = generateMutants(sample, 100);
        expect(first).toHaveLength(6); expect(first).toEqual(generateMutants(sample, 100)); expect(sample).toEqual(before);
    });
    test('every mutant changes exactly three real parameters, including at clipping boundaries', () => {
        for (let seed = 0; seed < 30; seed++) for (const child of generateMutants(sample, seed))
            expect(parameterDiff(sample, child)).toHaveLength(3);
        for (const child of generateMutants(BRUTAL_PARAMS, 100)) expect(parameterDiff(BRUTAL_PARAMS, child)).toHaveLength(3);
    });
    test('excluded keys never change; only a Priority suffix is excluded', () => {
        const excluded = ['radarPriority', 'maxRefineries', 'maxFactories', 'defenseMaxCount', 'teslaMaxCount', 'harvestersPerRefinery'];
        let factoryChanged = false;
        for (let seed = 0; seed < 20; seed++) for (const child of generateMutants(sample, seed)) {
            expect(excluded.every(key => child.economy[key] === sample.economy[key])).toBe(true);
            factoryChanged ||= child.economy.firstFactoryPriorityAllied !== sample.economy.firstFactoryPriorityAllied;
        }
        expect(factoryChanged).toBe(true);
    });
    test('integer rounding and integer collisions follow multiplier direction', () => {
        expect(mutateParameter('armor', 4, 0.8)).toBe(3);
        expect(mutateParameter('count', 1, 0.8)).toBe(0);
        expect(mutateParameter('count', 1, 1.25)).toBe(2);
    });
    test('decimal values retain two places and bounds clip values', () => {
        expect(mutateParameter('forceRatio', 1.2, 0.8)).toBe(0.96);
        expect(mutateParameter('hpFraction', 0.7, 1.25)).toBe(0.88);
        expect(mutateParameter('floorRatio', 0.3, 0.8)).toBe(0.3);
        expect(mutateParameter('forceRatio', 2.5, 1.25)).toBe(3);
        expect(mutateParameter('zero', 0, 0.8)).toBe(0);
    });
    test('less than three effective mutable knobs and non-finite values are rejected', () => {
        expect(() => generateMutants({ economy: { one: 1, tiny: 0.01 }, assault: { radarPriority: 24 } }, 0)).toThrow();
        expect(() => mutateParameter('invalid', NaN, 0.8)).toThrow();
    });
    test('two extra wins retain the parent; three replace it; ties choose the first mutant', () => {
        expect(selectMutation(10, [12, 11])).toBeNull(); expect(selectMutation(10, [13, 13])).toBe(0);
        expect(selectMutation(10, [11, 15, 15])).toBe(1);
    });
    test('parsing and replacing change only numeric source tokens and preserve CRLF', () => {
        const parsed = parseParams(source); expect(parsed).toEqual({ economy: { armor: 4, credits: 800 }, assault: { forceRatio: 1.2 } });
        expect(replaceParams(source, parsed)).toBe(source);
        parsed.economy.credits = 1000;
        expect(replaceParams(source, parsed)).toBe(source.replace('credits: 800,', 'credits: 1000,'));
        const windows = source.replaceAll('\n', '\r\n');
        expect(replaceParams(windows, parseParams(windows))).toBe(windows);
    });
    test('duplicate parameters, changed key sets and unsupported precision are rejected', () => {
        expect(() => parseParams(source.replace('armor: 4,', 'armor: 4,\n        armor: 5,'))).toThrow();
        const parsed = parseParams(source); parsed.economy.extra = 1; expect(() => replaceParams(source, parsed)).toThrow();
        const precision = parseParams(source); precision.assault.forceRatio = 1.234; expect(() => replaceParams(source, precision)).toThrow();
    });
});

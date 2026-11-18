import { expect, test } from 'bun:test';
import { boundsFor, initSpace, parseParams, renderParams, type ParamSpace } from '../../../e2e/league/p4/paramSpace';
import { sp, type ParamPath } from '../../game/ai/thirdpartbot/builtIn/bot/strategy/params';

const sourceFile = new URL('../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams.ts', import.meta.url);
const spaceFile = new URL('../../../e2e/league/p4/paramSpace.json', import.meta.url);

test('every strategy parameter has exactly one valid search-space record', async () => {
    const params = parseParams(await Bun.file(sourceFile).text()), space: ParamSpace = await Bun.file(spaceFile).json();
    expect(Object.keys(space).sort()).toEqual(Object.keys(params).sort());
    for (const [path, value] of Object.entries(params)) {
        const record = space[path];
        expect(value).toBeGreaterThanOrEqual(record.min); expect(value).toBeLessThanOrEqual(record.max);
        expect(record.weight).toBe(record.mutable ? ['pressure', 'production', 'assault'].includes(path.split('.')[0]) ? 3 : 1 : 0);
        expect(record.int ? Number.isInteger(value) : true).toBe(true);
    }
});
test('each documented category and the approved legacy/default compatibility follow their exact rules', () => {
    expect(boundsFor('production.enableExample', 0)).toEqual({ min: 0, max: 1, int: true, mutable: true, weight: 3 });
    expect(boundsFor('economy.ecoOnly', 0)).toEqual({ min: 0, max: 1, int: true, mutable: false, weight: 0 });
    expect(boundsFor('production.examplePriority', 70)).toEqual({ min: 70, max: 70, int: true, mutable: false, weight: 0 });
    expect(boundsFor('assault.exampleRatio', 1.2)).toEqual({ min: 0.3, max: 3, int: false, mutable: true, weight: 3 });
    expect(boundsFor('economy.exampleFactor', 2)).toEqual({ min: 0, max: 5, int: true, mutable: true, weight: 1 });
    expect(boundsFor('production.exampleCap', 4)).toEqual({ min: 1, max: 7, int: true, mutable: true, weight: 3 });
    expect(boundsFor('economy.maxExample', 4)).toEqual({ min: 1, max: 7, int: true, mutable: true, weight: 1 });
    expect(boundsFor('scout.exampleTicks', 600)).toEqual({ min: 600, max: 600, int: true, mutable: false, weight: 0 });
    expect(boundsFor('pressure.exampleTick', 300)).toEqual({ min: 120, max: 750, int: true, mutable: true, weight: 3 });
    expect(boundsFor('assault.exampleFactor', 0.15).min).toBe(0.15);
    for (const name of ['marchCohesion', 'engageSpread', 'dogHunt', 'tankOpening'])
        expect(boundsFor(`assault.${name}`, 1)).toEqual({ min: 0, max: 1, int: true, mutable: true, weight: 3 });
    for (const name of ['firstFactoryPrioritySoviet', 'firstFactoryPriorityAllied']) expect(boundsFor(`economy.${name}`, 60).mutable).toBe(false);
});
test('init only appends new records and never rewrites an existing search range', () => {
    const previous = { 'pressure.exampleTick': { min: 25, max: 75, int: true, mutable: true, weight: 3 } };
    const result = initSpace({ 'pressure.exampleTick': 50, 'scout.exampleTicks': 600 }, previous);
    expect(result['pressure.exampleTick']).toEqual(previous['pressure.exampleTick']);
    expect(result['scout.exampleTicks']).toEqual(boundsFor('scout.exampleTicks', 600));
});
test('sp returns the original value and rejects unknown paths without reading game state', () => {
    const game: any = { getPlayerData() { throw new Error('P3 must not read player state'); } };
    expect(sp(game, 'bot', 'economy.firstRefineryPriority')).toBe(50);
    for (const path of ['economy.missing', 'missing.value', 'economy.firstRefineryPriority.extra', 'economy.__proto__'])
        expect(() => sp(game, 'bot', path as ParamPath)).toThrow('Unknown strategy parameter');
});
test('the parser rejects duplicate/invalid lines and replacement cannot add a parameter', async () => {
    const source = await Bun.file(sourceFile).text(), parsed = parseParams(source);
    expect(renderParams(source, parsed)).toBe(source);
    expect(() => renderParams(source, { ...parsed, 'economy.missing': 1 })).toThrow('keys');
    expect(() => parseParams(source.replace('firstRefineryPriority: 50,', 'firstRefineryPriority: NaN,'))).toThrow('line');
});

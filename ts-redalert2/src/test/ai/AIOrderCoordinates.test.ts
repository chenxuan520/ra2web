import { describe, expect, test } from 'bun:test';
import { ActionBatcher, BatchableAction } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher';
import { OrderType, Vector2 } from '../../game/ai/thirdpartbot/builtIn/game-api';

function fixture() {
    const orders: any[][] = [], checked: number[][] = [];
    const mapApi: any = { getTile(x: number, y: number) {
        checked.push([x, y]); return x === 10 && y === 20 ? { rx: x, ry: y } : undefined;
    } };
    const actions: any = { orderUnits(...args: any[]) {
        if (args[3] !== undefined && (args[2] !== 10 || args[3] !== 20)) throw new Error(`No tile found at rx,ry=${args[2]},${args[3]}`);
        orders.push(args);
    } };
    return { batcher: new ActionBatcher(), mapApi, actions, orders, checked };
}

describe('AI coordinate orders at the map boundary', () => {
    test.each([[61, 21], [62, 22]])('absent tile %i,%i is filtered before calling the engine action API', (x, y) => {
        const f = fixture(); f.batcher.push(BatchableAction.toPoint(1, OrderType.Move, new Vector2(x, y)));
        expect(() => f.batcher.resolve(f.actions, f.mapApi)).not.toThrow();
        expect(f.orders).toEqual([]); expect(f.checked).toEqual([[x, y]]);
    });
    test('an invalid point does not prevent other grouped, target or no-target orders', () => {
        const f = fixture(); f.batcher.push(BatchableAction.toPoint(1, OrderType.Move, new Vector2(61, 21)));
        for (const id of [2, 3]) f.batcher.push(BatchableAction.toPoint(id, OrderType.Move, new Vector2(10, 20)));
        f.batcher.push(BatchableAction.toTargetId(4, OrderType.Attack, 88));
        f.batcher.push(BatchableAction.noTarget(5, OrderType.Stop));
        expect(() => f.batcher.resolve(f.actions, f.mapApi)).not.toThrow();
        expect(f.orders).toContainEqual([[2, 3], OrderType.Move, 10, 20]);
        expect(f.orders).toContainEqual([[4], OrderType.Attack, 88]);
        expect(f.orders).toContainEqual([[5], OrderType.Stop]); expect(f.orders).toHaveLength(3);
    });
    test('validate the actual serialized integers, without changing historical rounding', () => {
        const f = fixture(); f.batcher.push(BatchableAction.toPoint(1, OrderType.Move, new Vector2(10.9, 20.9)));
        f.batcher.resolve(f.actions, f.mapApi);
        expect(f.checked).toEqual([[10, 20]]); expect(f.orders).toEqual([[[1], OrderType.Move, 10, 20]]);
    });
    test('unrelated engine errors are not caught or hidden', () => {
        const f = fixture(); f.batcher.push(BatchableAction.toPoint(1, OrderType.Move, new Vector2(10, 20)));
        expect(() => f.batcher.resolve({ orderUnits() { throw new Error('unrelated engine failure'); } } as any, f.mapApi)).toThrow('unrelated engine failure');
    });
    test('existing isolated fixtures may still resolve valid orders without a map argument', () => {
        const f = fixture(); f.batcher.push(BatchableAction.toPoint(1, OrderType.Move, new Vector2(10, 20)));
        f.batcher.resolve(f.actions); expect(f.orders).toEqual([[[1], OrderType.Move, 10, 20]]);
    });
});

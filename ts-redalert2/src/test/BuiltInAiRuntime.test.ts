import { describe, expect, test } from 'bun:test';
import { BuiltInBotAdapter } from '../game/ai/thirdpartbot/builtIn/BuiltInBotAdapter';
import { BuiltInBot } from '../game/ai/thirdpartbot/builtIn/bot/bot';
import { Countries } from '../game/ai/thirdpartbot/builtIn/bot/logic/common/utils';
import { getCachedTechnoRules } from '../game/ai/thirdpartbot/builtIn/bot/logic/common/rulesCache';
import { ObjectType } from '../engine/type/ObjectType';
import { QueueStatus, QueueType } from '../game/player/production/ProductionQueue';
import { Vector2 } from '../game/math/Vector2';
import { OrderType } from '../game/order/OrderType';

function fallbackFixture(names = ['GACNST', 'GAPOWR']) {
    let tick = 0;
    const orders: unknown[][] = [];
    const buildings = names.map((name, id) => ({ id, name, rules: { name, constructionYard: name === 'GACNST', type: ObjectType.Building } }));
    const queue = { status: QueueStatus.Idle, items: [] as any[] };
    const power = { total: 200, drain: 50, isLowPower: false };
    const game = {
        getCurrentTick: () => tick,
        getVisibleUnits: (_name: string, _type: string, filter = (_r: any) => true) => buildings.filter(b => filter(b.rules)).map(b => b.id),
        getGameObjectData: (id: number) => buildings[id],
        getPlayerData: () => ({ power }),
    };
    const bot = new BuiltInBotAdapter('Computer', 'Americans', 'brutal');
    (bot as any).innerBot.onGameTick = () => {};
    bot.setActionsApi({ queueForProduction: (...args: unknown[]) => orders.push(args) });
    bot.setProductionApi({
        getQueueData: () => queue,
        getAvailableObjects: () => ['GAPOWR', 'GAREFN', 'GAPILE', 'GAWEAP'].map(name => ({ name })),
    });
    return { bot, orders, power, queue, advance: (next: number) => { tick = next; bot.onGameTick(game); } };
}

describe('built-in AI recovery', () => {
    test('gives normal strategy actions time to reach the production queue', () => {
        const f = fallbackFixture();
        f.advance(0);
        f.advance(15);
        f.advance(135);
        expect(f.orders).toHaveLength(0);
        f.advance(150);
        expect(f.orders).toEqual([[QueueType.Structures, ObjectType.Building, 'GAREFN', 1]]);
        f.advance(165);
        expect(f.orders).toHaveLength(1);
    });

    test('does not spam power plants when the basic economy is complete', () => {
        const f = fallbackFixture(['GACNST', 'GAPOWR', 'GAREFN', 'GAPILE', 'GAWEAP']);
        for (const tick of [0, 150, 300, 450]) f.advance(tick);
        expect(f.orders).toHaveLength(0);
        f.power.isLowPower = true;
        f.advance(600);
        expect(f.orders[0]?.[2]).toBe('GAPOWR');
    });

    test('does not interfere with a long-running production item', () => {
        const f = fallbackFixture();
        f.advance(0);
        f.queue.status = QueueStatus.Active;
        f.queue.items = [{ rules: { name: 'GAREFN' } }];
        for (const tick of [150, 300, 600]) f.advance(tick);
        expect(f.orders).toHaveLength(0);
    });

    test('respects a queue paused by the strategy budget', () => {
        const f = fallbackFixture();
        f.queue.status = QueueStatus.OnHold;
        f.queue.items = [{ rules: { name: 'GAREFN' } }];
        for (const tick of [0, 150, 300]) f.advance(tick);
        expect(f.orders).toHaveLength(0);
    });
});

test('MCV recovery leaves expansion missions in control and moves to the foundation center', () => {
    let tick = 0;
    let assigned = true;
    const orders: unknown[][] = [];
    const mcv = { tile: { rx: 10, ry: 10 }, rules: { name: 'AMCV', deploysInto: 'GACNST' } };
    const game: any = {
        getCurrentTick: () => tick,
        getGeneralRules: () => ({ baseUnit: ['AMCV'] }),
        getVisibleUnits: (_name: string, _type: string, filter: any) => filter(mcv.rules) ? [1] : [],
        getUnitData: () => mcv,
        canPlaceBuilding: (_name: string, _type: string, tile: any) => tile.rx === 11 && tile.ry === 12,
        getBuildingPlacementData: () => ({ foundationCenter: { x: 1, y: 1 } }),
    };
    const bot = new BuiltInBot('Computer', Countries.USA);
    bot.setActionsApi({ orderUnits: (...args: unknown[]) => orders.push(args) });
    (bot as any).missionController = { getMissions: () => assigned ? [{ getUnitIds: () => [1] }] : [] };
    (bot as any).tryInitialMcvDeploy(game);
    expect(orders).toHaveLength(0);
    assigned = false;
    for (tick = 0; tick <= 150; tick += 30) (bot as any).tryInitialMcvDeploy(game);
    expect(orders).toHaveLength(6);
    expect(orders[0]).toEqual([[1], OrderType.DeploySelected]);
    expect(orders[5]).toEqual([[1], OrderType.Move, 12, 13]);
});

describe('AI simulation cadence', () => {
    for (const difficulty of ['normal', 'brutal'] as const) {
        test(`${difficulty} updates missions at the same simulation ticks at every game speed`, () => {
            const traces: number[][] = [];
            for (const tickRate of [15, 30, 60]) {
                let tick = 0;
                const decisions: number[] = [];
                const strategy = { onAiUpdate(context: any) {
                    expect(context.difficulty).toBe(difficulty);
                    decisions.push(tick);
                    return strategy;
                } };
                const game: any = {
                    getTickRate: () => tickRate,
                    getCurrentTick: () => tick,
                    getPlayerData: () => ({ country: { side: 0 }, startLocation: new Vector2(0, 0) }),
                    getVisibleUnits: () => [1],
                    mapApi: {
                        getRealMapSize: () => ({ width: 2, height: 2 }),
                        getTilesInRect: () => [], getStartingLocations: () => [], getTile: () => undefined,
                    },
                };
                const bot = new BuiltInBot('Computer', Countries.USA, [], false, strategy, difficulty);
                bot.setGameApi(game);
                bot.onGameStart(game);
                (bot as any).matchAwareness = { getThreatCache: () => null, onAiUpdate() {} };
                (bot as any).missionController = { onAiUpdate() {}, getRequestedUnitTypes: () => new Map() };
                (bot as any).queueController = { onAiUpdate() {} };
                for (tick = 1; tick <= 12; tick++) bot.onGameTick(game);
                traces.push(decisions);
            }
            const expected = difficulty === 'brutal' ? [2, 4, 6, 8, 10, 12] : [3, 6, 9, 12];
            for (const trace of traces) expect(trace).toEqual(expected);
        });
    }
});

test('AI rules cache respects custom map rules when starting a second match', () => {
    const match = (cost: number) => ({
        getGameObjectData: () => ({ name: 'HTNK' }),
        rulesApi: {
            aircraftRules: new Map(), buildingRules: new Map(), infantryRules: new Map(),
            vehicleRules: new Map([['HTNK', { name: 'HTNK', cost }]]),
        },
    });
    const first = match(900);
    const second = match(1200);
    expect(getCachedTechnoRules(first as any, 1)?.cost).toBe(900);
    expect(getCachedTechnoRules(second as any, 1)?.cost).toBe(1200);
    expect(getCachedTechnoRules(first as any, 1)?.cost).toBe(900);
});

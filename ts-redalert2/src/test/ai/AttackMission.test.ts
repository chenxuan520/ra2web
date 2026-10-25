import { describe, expect, test } from 'bun:test';
import { AttackMission, AttackFailReason } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/attackMission';
import { ActionBatcher } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher';
import { MovementZone, ObjectType, OrderType, QueueStatus, QueueType, StanceType, Vector2 } from '../../game/ai/thirdpartbot/builtIn/game-api';
import type { MissionContext } from '../../game/ai/thirdpartbot/builtIn/bot/logic/common/context';

const tankRules = { name: 'MTNK', type: ObjectType.Vehicle, isSelectableCombatant: true, movementZone: MovementZone.Normal };
const aaRules = { ...tankRules, name: 'FV' };
const giRules = { ...tankRules, name: 'E1', type: ObjectType.Infantry, movementZone: MovementZone.Infantry };
const composition = { composition: { MTNK: 5, FV: 1 }, minimumUnits: 4, maximumUnits: 6 };

function fixture(difficulty: 'normal' | 'brutal' = 'brutal', desiredComposition = composition) {
    let tick = 0;
    let queueStatus = QueueStatus.Active;
    let enemies: any[] = [];
    const own = new Map<number, any>();
    const queries: Vector2[] = [];
    const orders: any[][] = [];
    const mission = new AttackMission('wave', 1, new Vector2(), new Vector2(30, 30), 10, desiredComposition, () => {});
    const game = {
        getCurrentTick: () => tick,
        getGameObjectData: (id: number) => own.get(id) ?? enemies.find(enemy => enemy.id === id),
        getUnitData: (id: number) => own.get(id) ?? enemies.find(enemy => enemy.id === id),
        getPlayerData: () => ({ name: 'bot', isCombatant: true, startLocation: new Vector2() }),
        getVisibleUnits: (_name: string, side: string) => side === 'enemy' ? enemies.map(enemy => enemy.id) : [...own.keys()],
        generateRandomInt: () => 1,
        mapApi: { getTile: (rx: number, ry: number) => ({ rx, ry }) },
        rulesApi: { vehicleRules: new Map([['MTNK', tankRules], ['FV', aaRules]]),
            infantryRules: new Map([['E1', giRules]]), aircraftRules: new Map(), buildingRules: new Map() },
    };
    const context = {
        difficulty, game,
        player: { name: 'bot', actions: {}, production: {
            getAvailableObjects: () => [tankRules, aaRules], getQueueTypeForObject: () => QueueType.Vehicles,
            getQueueData: () => ({ status: queueStatus, items: queueStatus === QueueStatus.Idle ? [] : [{ rules: tankRules, quantity: 1 }] }),
        } },
        matchAwareness: {
            getHostilesNearPoint2d: (point: Vector2, radius: number) => {
                queries.push(point.clone());
                return enemies.filter(enemy => point.distanceTo(new Vector2(enemy.tile.rx, enemy.tile.ry)) <= radius)
                    .map(enemy => ({ unitId: enemy.id }));
            },
            getHostilesNearPoint: (x: number, y: number, radius: number) => enemies
                .filter(enemy => new Vector2(x, y).distanceTo(new Vector2(enemy.tile.rx, enemy.tile.ry)) <= radius)
                .map(enemy => ({ unitId: enemy.id })),
            getMainRallyPoint: () => new Vector2(),
        },
    };
    return {
        mission, queries, game, orders,
        step(nextTick: number) {
            tick = nextTick;
            const actionBatcher = new ActionBatcher();
            const action = mission.onAiUpdate({ ...context, actionBatcher } as unknown as MissionContext);
            actionBatcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any);
            return action;
        },
        add(name: 'MTNK' | 'FV' | 'E1', amount = 1) {
            for (let i = 0; i < amount; i++) {
                const id = own.size + 1;
                own.set(id, { id, name, owner: 'bot', rules: name === 'MTNK' ? tankRules : name === 'E1' ? giRules : aaRules,
                    tile: { rx: 0, ry: 0 }, isIdle: true });
                mission.addUnit(id);
            }
        },
        setQueue(status: QueueStatus) { queueStatus = status; },
        setEnemy(x: number, y: number) { enemies = [{ id: 100, name: 'target', owner: 'enemy', tile: { rx: x, ry: y },
            rules: {}, type: ObjectType.Building, maxHitPoints: 1000, hitPoints: 1000 }]; },
    };
}

describe('attack mission preparation', () => {
    test('keeps a six-unit request alive beyond the old 368-tick restart cycle', () => {
        const f = fixture();
        f.add('MTNK');
        for (let tick = 0; tick <= 1800; tick += 2) expect(f.step(tick).type).toBe('request');
        expect((f.mission as any).requestedUnitCount).toBe(6);
        expect(f.mission.getUnitIds()).toHaveLength(1);
    });

    test('allocates production priorities using actual deficits', () => {
        const f = fixture();
        f.add('MTNK', 4);
        const action = f.step(0);
        expect(action.type).toBe('request');
        if (action.type !== 'request') throw new Error('Expected production request');
        expect(action.unitNameToPriority.MTNK).toBe(action.unitNameToPriority.FV);
        f.add('MTNK');
        const next = f.step(2);
        expect(next.type).toBe('request');
        if (next.type !== 'request') throw new Error('Expected production request');
        expect(next.unitNameToPriority.MTNK).toBeUndefined();
        expect(next.unitNameToPriority.FV).toBeGreaterThan(0);
    });

    test('launches the minimum mixed force after 30 seconds without waiting for the maximum', () => {
        const f = fixture();
        f.add('MTNK', 3);
        f.add('FV');
        expect(f.step(0).type).toBe('request');
        expect(f.step(449).type).toBe('request');
        expect(f.step(450).type).toBe('noop');
        expect(f.mission.getState()).toBe(1);
        expect(f.mission.getUnitIds()).toHaveLength(4);
    });

    test('launches immediately when the full composition is present', () => {
        const f = fixture();
        f.add('MTNK', 5);
        f.add('FV');
        expect(f.step(0).type).toBe('noop');
        expect(f.mission.getState()).toBe(1);
    });

    test('refreshes the stall timer on reinforcements and eventually releases abandoned requests', () => {
        const f = fixture();
        f.setQueue(QueueStatus.Idle);
        expect(f.step(0).type).toBe('request');
        f.add('MTNK');
        expect(f.step(1000).type).toBe('request');
        expect(f.step(2300).type).toBe('request');
        expect(f.step(2350)).toEqual({ type: 'disband', reason: AttackFailReason.UnableToAcquireUnits });
    });

    test('does not wait forever on a blocked production queue', () => {
        const f = fixture();
        f.step(0);
        expect(f.step(4499).type).toBe('request');
        expect(f.step(4500)).toEqual({ type: 'disband', reason: AttackFailReason.UnableToAcquireUnits });
    });
});

describe('brutal preparation defense', () => {
    test('guards the rally point while waiting instead of sending an incomplete wave to the enemy base', () => {
        const f = fixture();
        f.add('MTNK');
        f.step(0);
        expect(f.step(6).type).toBe('request');
        expect(f.mission.getState()).toBe(0);
        expect(f.orders).toEqual([[[1], OrderType.AttackMove, 0, 0]]);

        f.add('MTNK', 4);
        f.add('FV');
        f.step(12);
        f.step(14);
        f.step(20);
        expect(f.mission.getState()).toBe(1);
        expect(f.orders.at(-1)).toEqual([[1, 2, 3, 4, 5, 6], OrderType.AttackMove, 30, 30]);
    });

    test('deploys a GI against a nearby threat and attacks while reinforcements are still requested', () => {
        const f = fixture('brutal', { composition: { E1: 1 } as any, minimumUnits: 3, maximumUnits: 6 });
        f.add('E1');
        const gi = f.game.getUnitData(1);
        const weapon = (range: number) => ({ maxRange: range, rules: { damage: 25, rof: 15 },
            projectileRules: { isAntiGround: true, isAntiAir: false } });
        gi.primaryWeapon = weapon(4);
        gi.secondaryWeapon = weapon(5);
        f.setEnemy(4, 0);
        f.step(0);
        expect(f.step(6).type).toBe('request');
        expect(f.orders).toEqual([[[1], OrderType.DeploySelected]]);
        gi.stance = StanceType.Deployed;
        expect(f.step(12).type).toBe('request');
        expect(f.orders.at(-1)).toEqual([[1], OrderType.Attack, 100]);
        expect(f.mission.getState()).toBe(0);
    });

    test('does not change normal preparation behavior', () => {
        const f = fixture('normal');
        f.add('MTNK');
        f.step(0);
        f.step(12);
        expect(f.orders).toEqual([]);
        expect(f.mission.getState()).toBe(0);
    });
});

describe('attack target lifetime', () => {
    test('a late-game attack gets its own observation timeout', () => {
        const f = fixture();
        f.add('MTNK', 5);
        f.add('FV');
        f.step(9000);
        expect(f.step(9002).type).toBe('noop');
        expect(f.step(9599).type).toBe('noop');
        expect(f.step(9602)).toEqual({ type: 'disband', reason: AttackFailReason.NoTargets });
    });

    test('retargeting updates both squad orders and the area checked for remaining enemies', () => {
        const f = fixture();
        f.add('MTNK', 5);
        f.add('FV');
        f.step(9000);
        f.setEnemy(70, 70);
        expect(f.step(9302).type).toBe('noop');
        expect(f.step(9304).type).toBe('noop');
        expect(f.queries.at(-1)).toEqual(new Vector2(70, 70));
        expect(f.step(10000).type).toBe('noop');
    });
});

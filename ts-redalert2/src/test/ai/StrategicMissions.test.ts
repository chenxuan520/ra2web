import { describe, expect, test } from 'bun:test';
import { MovementZone, ObjectType, OrderType, Vector2, ZoneType } from '../../game/ai/thirdpartbot/builtIn/game-api';
import { Mission, noop } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/mission';
import { MissionController } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController';
import { ActionBatcher } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher';
import { DefenceMission } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/defenceMission';
import { HarassmentMission, HarassmentMissionFactory } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/harassmentMission';

class MainForce extends Mission {
    constructor(private target: Vector2, name = 'main-force') { super(name, () => {}); }
    _onAiUpdate() { return noop(); }
    getPriority() { return 1; }
    getGlobalDebugText() { return undefined; }
    getAttackArea() { return this.target; }
}

function fixture(mainCount = 6, freeCount = 3, difficulty: 'brutal' | 'normal' = 'brutal') {
    let tick = 0;
    const weapon = { maxRange: 5, rules: { damage: 65, rof: 60 },
        warheadRules: { verses: new Map([[0, 1]]) }, projectileRules: { isAntiGround: true, isAntiAir: false } };
    const tankRules = { name: 'MTNK', type: ObjectType.Vehicle, armor: 0, isSelectableCombatant: true, movementZone: MovementZone.Normal };
    const objects = new Map<number, any>();
    function unit(id: number, name: string, owner: string, x: number, y: number, rules: any = tankRules) {
        const data = { id, name, owner, tile: { rx: x, ry: y }, type: rules.type, rules, zone: ZoneType.Ground,
            primaryWeapon: weapon, hitPoints: 300, maxHitPoints: 300, isIdle: true, isWarpedOut: false };
        objects.set(id, data);
        return data;
    }
    const base = unit(1000, 'GACNST', 'bot', 0, 0, { type: ObjectType.Building, constructionYard: true, armor: 0 });
    base.primaryWeapon = undefined as any;
    const main = new MainForce(new Vector2(70, 0));
    for (let i = 1; i <= mainCount + freeCount; i++) {
        unit(i, 'MTNK', 'bot', 40, 0);
        if (i <= mainCount) main.addUnit(i);
    }
    const target = unit(2000, 'HARV', 'enemy', 80, 30, { ...tankRules, name: 'HARV', harvester: true });
    const orders: any[][] = [];
    const controller = new MissionController(() => {});
    controller.addMission(main);
    const context = {
        difficulty,
        game: {
            getCurrentTick: () => tick,
            getVisibleUnits: (_name: string, side: string, predicate?: (rules: any) => boolean) => [...objects.values()]
                .filter(object => (side === 'self' ? object.owner === 'bot' : object.owner === 'enemy') && (!predicate || predicate(object.rules)))
                .map(object => object.id),
            getGameObjectData: (id: number) => objects.get(id), getUnitData: (id: number) => objects.get(id),
            getPlayerData: () => ({ name: 'bot', startLocation: new Vector2(), isCombatant: true }),
            mapApi: { getTile: (rx: number, ry: number) => ({ rx, ry }) },
            rulesApi: { vehicleRules: new Map([['MTNK', tankRules]]), infantryRules: new Map(), aircraftRules: new Map(), buildingRules: new Map() },
        },
        player: { name: 'bot', actions: { setUnitDebugText() {}, orderUnits: (...args: any[]) => orders.push(args) } },
        matchAwareness: {
            getMainRallyPoint: () => new Vector2(),
            getHostilesNearPoint2d: (point: Vector2, radius: number) => [...objects.values()]
                .filter(object => object.owner === 'enemy' && point.distanceTo(new Vector2(object.tile.rx, object.tile.ry)) <= radius)
                .map(object => ({ unitId: object.id })),
        },
    } as any;
    const factory = new HarassmentMissionFactory();
    return {
        context, controller, main, target, orders, objects, unit, weapon,
        launch(nextTick = 0, forces: MainForce[] = [main]) { tick = nextTick; factory.maybeCreateMissions(context, controller, () => {}, forces); },
        step(nextTick: number) { tick = nextTick; controller.onAiUpdate(context); },
        raids: () => controller.getMissions().filter((mission): mission is HarassmentMission => mission instanceof HarassmentMission),
    };
}

describe('surplus armor harassment', () => {
    test('claims exactly three existing free tanks, keeps the main force and requests no production', () => {
        const f = fixture();
        f.launch();
        expect(f.raids()).toHaveLength(1);
        f.step(0);
        expect(f.raids()[0].getUnitIds()).toEqual([7, 8, 9]);
        expect(f.main.getUnitIds()).toEqual([1, 2, 3, 4, 5, 6]);
        expect(f.controller.getRequestedUnitTypes().size).toBe(0);
        f.launch(60);
        expect(f.raids()).toHaveLength(1);
    });

    test('can split a large existing army while preserving six combatants and three main tanks', () => {
        const f = fixture(9, 0);
        f.launch();
        expect(f.main.getUnitIds()).toHaveLength(6);
        f.step(0);
        expect(f.raids()[0].getUnitIds()).toHaveLength(3);
        const allIds = f.controller.getMissions().flatMap(mission => mission.getUnitIds());
        expect(new Set(allIds).size).toBe(allIds.length);
        expect(f.controller.getRequestedUnitTypes().size).toBe(0);
    });

    test('pools surplus from two smaller attacking waves without emptying either wave', () => {
        const f = fixture(5, 4);
        const second = new MainForce(new Vector2(60, -10), 'second-main');
        for (const id of [6, 7, 8, 9]) second.addUnit(id);
        f.controller.addMission(second);
        f.launch(0, [f.main, second]);
        expect(f.main.getUnitIds()).toHaveLength(3);
        expect(second.getUnitIds()).toHaveLength(3);
        f.step(0);
        expect(f.raids()[0].getUnitIds()).toEqual([4, 5, 9]);
        const ids = f.controller.getMissions().flatMap(mission => mission.getUnitIds());
        expect(new Set(ids).size).toBe(9);
        expect(ids).toHaveLength(9);
        expect(f.controller.getRequestedUnitTypes().size).toBe(0);
    });

    test('never borrows the last core tanks from a support-heavy donor or any preparing wave', () => {
        const f = fixture(5, 4);
        const preparing = new MainForce(new Vector2(60, -10), 'preparing');
        for (const id of [6, 7, 8, 9]) preparing.addUnit(id);
        f.controller.addMission(preparing);
        // Only attacking waves are offered; preparing ownership excludes the free pool.
        f.launch();
        expect(f.raids()).toEqual([]);
        expect(preparing.getUnitIds()).toEqual([6, 7, 8, 9]);
        for (const id of [1, 2, 3]) f.objects.get(id).name = 'FV';
        f.launch(60, [f.main, preparing]);
        expect(f.raids()).toEqual([]);
        expect(f.main.getUnitIds()).toHaveLength(5);
    });

    test('will not cannibalize a small main force or split at normal difficulty', () => {
        const tooSmall = fixture(8, 0);
        tooSmall.launch();
        expect(tooSmall.raids()).toEqual([]);
        expect(tooSmall.main.getUnitIds()).toHaveLength(8);
        const normal = fixture(9, 3, 'normal');
        normal.launch();
        expect(normal.raids()).toEqual([]);
    });

    test('support, dogs and damaged armor do not count as surplus main tanks', () => {
        const f = fixture(9, 0);
        for (const id of [1, 2, 3, 4]) {
            f.objects.get(id).name = 'FV';
        }
        f.launch();
        expect(f.raids()).toEqual([]);
        for (const id of [1, 2, 3, 4]) f.objects.get(id).name = 'MTNK';
        for (const id of [1, 2, 3, 4]) f.objects.get(id).hitPoints = 100;
        f.launch(60);
        expect(f.raids()).toEqual([]);
    });

    test('ignores targets on the main attack lane or protected by an armed tower', () => {
        const f = fixture();
        f.target.tile = { rx: 71, ry: 0 };
        f.launch();
        expect(f.raids()).toEqual([]);
        f.target.tile = { rx: 80, ry: 30 };
        const tower = f.unit(2001, 'GTGCAN', 'enemy', 90, 30, { type: ObjectType.Building, armor: 0 });
        tower.primaryWeapon = { ...f.weapon, maxRange: 15 };
        f.launch(60);
        expect(f.raids()).toEqual([]);
    });

    test('does not launch when a base is under attack', () => {
        const f = fixture();
        f.unit(2001, 'HTNK', 'enemy', 5, 0);
        f.launch();
        expect(f.raids()).toEqual([]);
    });

    test.each(['base', 'lost-target', 'ambush', 'main-convergence'])('recalls a live raid after %s, then releases without a second movement order', reason => {
        const f = fixture();
        f.launch();
        f.step(0);
        const raid = f.raids()[0];
        if (reason === 'base') f.unit(2001, 'HTNK', 'enemy', 5, 0);
        if (reason === 'lost-target') f.objects.delete(f.target.id);
        if (reason === 'ambush') for (let i = 0; i < 4; i++) f.unit(2001 + i, 'HTNK', 'enemy', 40 + i, 2);
        if (reason === 'main-convergence') f.main.getAttackArea().set(80, 30);
        f.step(2);
        expect(raid.getState()).toBe('returning');
        expect(f.orders).toEqual([[[7, 8, 9], OrderType.Move, 0, 0]]);
        for (const id of raid.getUnitIds()) f.objects.get(id).tile = { rx: 0, ry: 1 };
        f.step(4);
        expect(f.raids()).toEqual([]);
        expect(f.orders).toHaveLength(1);
        expect(f.controller.getRequestedUnitTypes().size).toBe(0);
    });

    test('a blocked return eventually relinquishes its units', () => {
        const f = fixture();
        f.launch(); f.step(0);
        f.objects.delete(f.target.id);
        f.step(2);
        f.step(902);
        expect(f.raids()).toEqual([]);
    });

    test('returning tanks keep their active path and retry only an idle unit after ninety ticks', () => {
        const f = fixture();
        f.launch(); f.step(0);
        f.objects.delete(f.target.id);
        f.step(2);
        for (const id of [7, 8, 9]) f.objects.get(id).isIdle = false;
        f.step(32);
        f.objects.get(7).isIdle = true;
        f.step(60);
        expect(f.orders).toHaveLength(1);
        f.step(92);
        expect(f.orders).toHaveLength(2);
        expect(f.orders[1]).toEqual([[7], OrderType.Move, 0, 0]);
    });
});

describe('local base defense', () => {
    test.each(['brutal', 'normal'] as const)('%s uses its intended grab radius', difficulty => {
        const f = fixture(0, 0, difficulty);
        f.unit(2001, 'HTNK', 'enemy', 5, 0);
        const mission = new DefenceMission('defend', 10, new Vector2(), new Vector2(), 12, () => {});
        const action = mission.onAiUpdate({ ...f.context, actionBatcher: new ActionBatcher() });
        expect(action).toEqual({ type: 'requestCombatants', point: new Vector2(), radius: difficulty === 'brutal' ? 12 : 100 });
    });
});

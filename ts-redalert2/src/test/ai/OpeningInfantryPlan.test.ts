import { describe, expect, mock, test } from 'bun:test';
import { ObjectType, OrderType, QueueStatus, QueueType, Vector2, ZoneType } from '../../game/ai/thirdpartbot/builtIn/game-api';
import { DefaultStrategy } from '../../game/ai/thirdpartbot/builtIn/bot/strategy/defaultStrategy';
import { ActionBatcher } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher';
import { FieldArmyMission } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/fieldArmyMission';
import { BaseReserveMission } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseReserveMission';
import { InfantryHomeMission } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/infantryHomeMission';
import { MissionController } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController';
import { QueueController, QUEUES } from '../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController';

function fixture() {
    let tick = 3000;
    const foot: any = { name: 'E2', type: ObjectType.Infantry, strength: 100, isSelectableCombatant: true };
    const units = new Map<number, any>(Array.from({ length: 8 }, (_, i) => [i + 1, { id: i + 1, name: 'E2', owner: 'bot',
        type: ObjectType.Infantry, rules: foot, tile: { rx: 0, ry: 0 }, hitPoints: 100, maxHitPoints: 100, zone: ZoneType.Ground, isIdle: true, canMove: true }]));
    const enemies = new Map<number, any>();
    units.set(100, { id: 100, name: 'HARV', owner: 'bot', tile: { rx: 0, ry: 0 }, rules: { name: 'HARV', harvester: true } });
    units.set(101, { id: 101, name: 'NAWEAP', owner: 'bot', tile: { rx: 0, ry: 0 }, rules: { name: 'NAWEAP', weaponsFactory: true } });
    const player: any = { name: 'bot', country: { name: 'Russians', side: 1 }, credits: 5000, startLocation: new Vector2() };
    const available = [foot, { name: 'HTNK' }, { name: 'HTK' }];
    const game: any = { getCurrentTick: () => tick, getPlayers: () => ['bot', 'enemy'], areAlliedPlayers: () => false, generateRandomInt: () => 0,
        getPlayerData: (name: string) => name === 'bot' ? player : { name, isCombatant: true },
        getVisibleUnits: (_: string, relation: string, predicate = (_: any) => true) =>
            [...(relation === 'enemy' ? enemies : units).values()].filter(unit => predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => units.get(id) ?? enemies.get(id), getGameObjectData: (id: number) => units.get(id) ?? enemies.get(id),
        rulesApi: { infantryRules: new Map([['E2', foot]]), vehicleRules: new Map(), aircraftRules: new Map(), buildingRules: new Map() },
        mapApi: { getTile: (rx: number, ry: number) => ({ rx, ry }), getStartingLocations: () => [new Vector2(), new Vector2(80, 0)],
            isVisibleTile: () => false, getRealMapSize: () => ({ width: 80, height: 80 }), isPassableTile: () => true } };
    const controller = new MissionController(() => {});
    const context: any = { difficulty: 'brutal', game, player: { name: 'bot', production: { getAvailableObjects: () => available } },
        matchAwareness: { getMainRallyPoint: () => new Vector2(4, 0), getThreatCache: () => null, getHostilesNearPoint: () => [] } };
    const strategy = new DefaultStrategy();
    return { units, enemies, game, context, controller, player, at(value: number) { tick = value; },
        plan() { return (strategy as any).selectRandomAttackComposition(context, () => {}, controller); } };
}

function recruitFixture(reverse = false) {
    const f = fixture();
    for (let id = 4; id <= 8; id++) f.units.delete(id);
    f.context.player.actions = { setUnitDebugText: mock(() => {}), orderUnits: mock(() => {}) };
    const reserve = new BaseReserveMission(() => {}), home = new InfantryHomeMission(f.controller, () => {});
    const army = new FieldArmyMission(f.plan(), f.controller, () => {});
    reserve.addUnit(1); reserve.addUnit(2);
    const missions = [reserve, home, army];
    for (const mission of reverse ? missions.reverse() : missions) f.controller.addMission(mission);
    return { ...f, reserve, home, army, update: () => f.controller.onAiUpdate(f.context) };
}

describe('fresh opening recruits use the real mission priority allocator', () => {
    test.each([false, true])('an E2 recruit reaches FieldArmy95 rather than a prior specific-ID home20 claim, reverse=%s', reverse => {
        const f = recruitFixture(reverse); f.update();
        expect(f.army.getUnitIds()).toEqual([3]); expect(f.home.getUnitIds()).toEqual([]);
        expect(f.reserve.getUnitIds()).toEqual([1, 2]); expect(f.reserve.isUnitsLocked()).toBe(true);
    });
    test('fresh deliveries form the existing eight-conscript strike without borrowing its locked reserve', () => {
        const f = recruitFixture(), recruit = f.units.get(3)!; f.update();
        for (let id = 4; id <= 10; id++) {
            f.units.set(id, { ...recruit, id }); f.at(3000 + id * 2); f.update();
        }
        f.at(3022); f.update();
        expect(f.army.getUnitIds()).toHaveLength(8); expect(f.army.isAttacking()).toBe(true);
        expect(f.home.getUnitIds()).toEqual([]); expect(f.reserve.getUnitIds()).toEqual([1, 2]);
    });
    test.each(['countered', 'expired'])('a %s opening still leaves fresh conscripts eligible for their original home role', condition => {
        const f = recruitFixture(); f.at(condition === 'expired' ? 7000 : 3002);
        if (condition === 'countered') for (let id = 1000; id < 1003; id++) f.enemies.set(id, { id, name: 'MTNK', owner: 'enemy',
            type: ObjectType.Vehicle, rules: { name: 'MTNK', type: ObjectType.Vehicle, isSelectableCombatant: true },
            tile: { rx: 80, ry: 0 }, hitPoints: 500, maxHitPoints: 500, zone: ZoneType.Ground });
        f.update(); expect(f.home.getUnitIds()).toEqual([3]); expect(f.army.getUnitIds()).toEqual([]);
        expect(f.home.isUnitsLocked()).toBe(true); expect(f.reserve.getUnitIds()).toEqual([1, 2]);
    });
    test('the original home-to-reserve casualty replacement and locks remain unchanged after the opening', () => {
        const f = recruitFixture(); f.at(7000); f.units.delete(2); f.reserve.removeUnit(2); f.home.addUnit(3);
        f.units.set(102, { id: 102, name: 'HTNK', owner: 'bot', type: ObjectType.Vehicle,
            rules: { name: 'HTNK', type: ObjectType.Vehicle, isSelectableCombatant: true },
            tile: { rx: 0, ry: 0 }, hitPoints: 900, maxHitPoints: 900, zone: ZoneType.Ground, isIdle: true });
        f.update(); expect(f.reserve.getUnitIds()).toEqual([1, 3]); expect(f.home.getUnitIds()).toEqual([]);
        expect(f.reserve.isUnitsLocked()).toBe(true);
    });
});

describe('bounded paid infantry support during armor assembly', () => {
    test('the explicit opening plan launches eight conscripts and requests bounded paid reinforcements', () => {
        const f = fixture(), plan = f.plan(); expect(plan.minimumUnits).toBe(8); expect(plan.maximumUnits).toBe(16);
        const army = new FieldArmyMission(plan, f.controller, () => {}); f.controller.addMission(army);
        for (let id = 1; id <= 8; id++) army.addUnit(id);
        const actionBatcher = new ActionBatcher(), orders: any[][] = [];
        const result: any = army.onAiUpdate({ ...f.context, actionBatcher });
        actionBatcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any, f.game.mapApi);
        expect(army.isAttacking()).toBe(true); expect(orders.some(order => order[1] === OrderType.AttackMove && order[2] === 80)).toBe(true);
        expect(result.unitNameToPriority.E2).toBe(95);
        f.at(7000); expect(army.onAiUpdate({ ...f.context, actionBatcher }).type).toBe('releaseUnits');
    });
    test('the paid continuation window keeps a formed infantry strike on the field after tick 4000', () => {
        const f = fixture(); f.at(6500); const plan = f.plan(); expect(plan.minimumUnits).toBe(8);
        const army = new FieldArmyMission(plan, f.controller, () => {}); f.controller.addMission(army);
        for (let id = 1; id <= 8; id++) army.addUnit(id);
        const actionBatcher = new ActionBatcher(), result: any = army.onAiUpdate({ ...f.context, actionBatcher });
        expect(result.type).not.toBe('releaseUnits'); expect(army.isAttacking()).toBe(true); expect(result.unitNameToPriority.E2).toBe(95);
        f.at(7000); expect(army.onAiUpdate({ ...f.context, actionBatcher }).type).toBe('releaseUnits');
    });
    test.each(['fortified', 'armor', 'air'])('the opening stops paid foot reinforcements when visible %s already prevents its infantry push', counter => {
        const f = fixture(), plan = f.plan(), army = new FieldArmyMission(plan, f.controller, () => {});
        f.controller.addMission(army);
        const type = counter === 'fortified' ? ObjectType.Building : counter === 'armor' ? ObjectType.Vehicle : ObjectType.Aircraft;
        const count = counter === 'fortified' ? 2 : counter === 'armor' ? 3 : 1;
        const name = counter === 'fortified' ? 'GAPILL' : counter === 'armor' ? 'MTNK' : 'ORCA';
        for (let i = 0; i < count; i++) f.enemies.set(1000 + i, { id: 1000 + i, name, owner: 'enemy', type,
            rules: { name, type, primary: 'weapon', isSelectableCombatant: true }, tile: { rx: 80, ry: i },
            hitPoints: 500, maxHitPoints: 500, zone: counter === 'air' ? ZoneType.Air : ZoneType.Ground });
        f.at(3002);
        const result: any = army.onAiUpdate({ ...f.context, actionBatcher: new ActionBatcher() });
        expect(result.unitNameToPriority.E2).toBeUndefined();
        expect(result.unitNameToPriority.HTNK).toBe(75);
    });
    test('one tower and two vehicles keep the original viable paid infantry opening', () => {
        const f = fixture(), army = new FieldArmyMission(f.plan(), f.controller, () => {}); f.controller.addMission(army);
        for (const [id, type, name] of [[1000, ObjectType.Building, 'GAPILL'], [1001, ObjectType.Vehicle, 'MTNK'], [1002, ObjectType.Vehicle, 'MTNK']] as const)
            f.enemies.set(id, { id, name, owner: 'enemy', type, rules: { name, type, primary: 'weapon', isSelectableCombatant: true },
                tile: { rx: 80, ry: 0 }, hitPoints: 500, maxHitPoints: 500, zone: ZoneType.Ground });
        f.at(3002);
        expect((army.onAiUpdate({ ...f.context, actionBatcher: new ActionBatcher() }) as any).unitNameToPriority.E2).toBe(95);
    });
    test('no income, normal difficulty and the fixed deadline do not opt into this plan', () => {
        const noIncome = fixture(); noIncome.units.delete(100); expect(noIncome.plan()?.minimumUnits).not.toBe(8);
        const normal = fixture(); normal.context.difficulty = 'normal'; expect(normal.plan().minimumUnits).toBe(3);
        const late = fixture(); late.at(7000); expect(late.plan()?.composition.E2).toBeUndefined();
    });
    test('ordinary infantry plans preserve the original Soviet home role', () => {
        const f = fixture(), army = new FieldArmyMission({ composition: { E2: 1 }, minimumUnits: 3, maximumUnits: 10 }, f.controller, () => {});
        army.addUnit(1); expect(army.onAiUpdate({ ...f.context, actionBatcher: new ActionBatcher() }).type).toBe('releaseUnits');
    });
});

function guardedApproachFixture(baseX = 40) {
    const f = fixture(); f.at(8000);
    const tankRules = { name: 'HTNK', type: ObjectType.Vehicle, isSelectableCombatant: true };
    f.game.rulesApi.vehicleRules.set('HTNK', tankRules);
    for (let id = 1; id <= 4; id++) f.units.set(id, { id, name: 'HTNK', owner: 'bot', type: ObjectType.Vehicle,
        rules: tankRules, tile: { rx: 0, ry: 0 }, hitPoints: 400, maxHitPoints: 400,
        zone: ZoneType.Ground, isIdle: true, canMove: true });
    for (let i = 0; i < 4; i++) f.enemies.set(1000 + i, { id: 1000 + i, owner: 'enemy', name: 'HTNK', type: ObjectType.Vehicle,
        rules: { ...tankRules, strength: 400 }, tile: { rx: 36, ry: i % 2 }, zone: ZoneType.Ground });
    const base = { id: 1200, name: 'NAWEAP', owner: 'enemy', type: ObjectType.Building,
        rules: { name: 'NAWEAP', type: ObjectType.Building, weaponsFactory: true, strength: 1000 },
        tile: { rx: baseX, ry: 0 } };
    f.enemies.set(base.id, base);
    const army = new FieldArmyMission(null, f.controller, () => {});
    f.controller.addMission(army); for (let id = 1; id <= 4; id++) army.addUnit(id);
    const orders: any[][] = [];
    const run = () => {
        const actionBatcher = new ActionBatcher(); army.onAiUpdate({ ...f.context, actionBatcher });
        actionBatcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any, f.game.mapApi);
    };
    return { ...f, base, army, orders, run };
}

describe('assembling armor distinguishes a visible enemy garrison from an approach', () => {
    test('equal armor guarding its currently visible factory does not draw the assembly into the enemy base', () => {
        const f = guardedApproachFixture(); f.run();
        expect(f.army.isAttacking()).toBe(false); expect(f.army.getAttackArea()).toEqual(new Vector2(4, 0));
        expect((f.army as any).squad.radius).toBe(7);
        expect(f.orders).toEqual([[[1, 2, 3, 4], OrderType.AttackMove, 4, 0]]);
    });
    test.each([22, 23])('the existing twenty-two-tile base neighborhood remains inclusive at%i', gap => {
        const f = guardedApproachFixture(36 + gap);
        for (const enemy of f.enemies.values()) if (enemy.type === ObjectType.Vehicle) enemy.tile.ry = 0;
        f.run(); expect(f.army.getAttackArea().x).toBe(gap === 22 ? 4 : 36);
        expect((f.army as any).squad.radius).toBe(gap === 22 ? 7 : 25);
    });
    test('a real approaching raider is selected instead of a slightly closer guarded tank', () => {
        const f = guardedApproachFixture(); f.enemies.get(1003)!.tile = { rx: 24, ry: 28 }; f.run();
        expect(f.army.getAttackArea()).toEqual(new Vector2(24, 28));
        expect((f.army as any).squad.radius).toBe(25);
        expect(f.orders).toEqual([[[1, 2, 3, 4], OrderType.AttackMove, 24, 28]]);
    });
    test('the original interception resumes when the actual garrison leaves its visible base neighborhood', () => {
        const f = guardedApproachFixture(); f.run(); expect(f.army.getAttackArea().x).toBe(4);
        for (const enemy of f.enemies.values()) if (enemy.type === ObjectType.Vehicle) enemy.tile = { rx: 12, ry: 24 };
        f.at(8032); f.run();
        expect(f.army.getAttackArea()).toEqual(new Vector2(12, 24)); expect((f.army as any).squad.radius).toBe(25);
    });
    test('overlapping enemy and own base neighborhoods do not prevent direct home defense', () => {
        const f = guardedApproachFixture(20);
        for (const enemy of f.enemies.values()) if (enemy.type === ObjectType.Vehicle) enemy.tile = { rx: 18, ry: 0 };
        f.run(); expect(f.army.getAttackArea()).toEqual(new Vector2(18, 0)); expect((f.army as any).squad.radius).toBe(25);
    });
    test('a hidden base cannot identify currently seen armor as a garrison', () => {
        const f = guardedApproachFixture(), visible = f.game.getVisibleUnits;
        f.game.getVisibleUnits = (name: string, relation: string, predicate: any) =>
            visible(name, relation, predicate).filter((id: number) => id !== f.base.id);
        Object.defineProperty(f.base, 'tile', { get() { throw Error('hidden enemy base coordinate'); } });
        f.run(); expect(f.army.getAttackArea().x).toBe(36); expect((f.army as any).squad.radius).toBe(25);
    });
    test('normal approach selection retains its original behavior around an enemy base', () => {
        const f = guardedApproachFixture(); f.context.difficulty = 'normal'; f.run();
        expect(f.army.getAttackArea().x).toBe(36); expect((f.army as any).squad.radius).toBe(25);
    });
});

function production(ownedCount: number, tick: number, priority: number) {
    const rule: any = { name: 'E2', cost: 100, type: ObjectType.Infantry };
    const own = Array.from({ length: ownedCount }, () => rule), queues = new Map(QUEUES.map(type => [type, { type, status: QueueStatus.Idle, items: [], size: 0 }]));
    const actions = { queueForProduction: mock(() => {}), unqueueFromProduction: mock(() => {}), pauseProduction: mock(() => {}), resumeProduction: mock(() => {}) };
    new QueueController().onAiUpdate({ difficulty: 'brutal', player: { name: 'bot', actions, production: {
        getAvailableObjects: (type: number) => type === QueueType.Infantry ? [rule] : [], getQueueData: (type: number) => queues.get(type) } },
        game: { getCurrentTick: () => tick, getPlayerData: () => ({ name: 'bot', country: { name: 'Russians' }, credits: 3000, startLocation: new Vector2() }),
            getVisibleUnits: (_: string, relation: string, predicate = (_: any) => true) => (relation === 'enemy' ? [] : own).filter(predicate).map((_, id) => id) } } as any,
        null, new Map([['E2', { priority, specificLocation: null }]]), () => {});
    return actions;
}

test('opening production remains paid, capped and does not change ordinary requests', () => {
    expect(production(8, 3000, 95).queueForProduction).toHaveBeenCalledWith(QueueType.Infantry, 'E2', ObjectType.Infantry, 1);
    expect(production(8, 6500, 95).queueForProduction).toHaveBeenCalledWith(QueueType.Infantry, 'E2', ObjectType.Infantry, 1);
    for (const [count, tick, priority] of [[16, 3000, 95], [8, 7000, 95], [8, 3000, 20]])
        expect(production(count, tick, priority).queueForProduction).not.toHaveBeenCalled();
});

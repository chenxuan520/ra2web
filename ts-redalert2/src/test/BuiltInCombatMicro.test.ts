import { describe, expect, test } from 'bun:test';
import { AttackState, MovementZone, ObjectType, OrderType, Vector2, ZoneType } from '../game/ai/thirdpartbot/builtIn/game-api';
import type { UnitData } from '../game/api/interface/UnitData';
import { SpeedType } from '../game/type/SpeedType';
import { ActionBatcher, BatchableAction } from '../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher';
import { CombatSquad } from '../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/combatSquad';
import { DefenceMissionFactory } from '../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/defenceMission';
import { getAttackWeight } from '../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/common';
import { chooseTacticalTarget, getCombatWeapon, getTacticalRetreatPoint } from '../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/tacticalTargeting';

function weapon(damage = 40, range = 6, aa = false, ag = true) {
    return {
        rules: { damage, burst: 1, rof: 30 },
        projectileRules: { isAntiAir: aa, isAntiGround: ag },
        warheadRules: { verses: new Map([[0, 1], [1, 1]]) },
        maxRange: range, minRange: 0, cooldownTicks: 0,
    };
}

function unit(id: number, x = 0, extra: Partial<UnitData> = {}): UnitData {
    return {
        id, name: 'MTNK', type: ObjectType.Vehicle as any, owner: 'enemy',
        tile: { rx: x, ry: 0 }, rules: { armor: 0, speedType: SpeedType.Track, isSelectableCombatant: true, movementZone: MovementZone.Normal },
        hitPoints: 200, maxHitPoints: 200, primaryWeapon: weapon(),
        canMove: true, isIdle: false, zone: ZoneType.Ground, attackState: AttackState.Idle as any,
        ...extra,
    } as UnitData;
}

describe('built-in combat target selection', () => {
    test('secondary anti-air weapons can engage aircraft, while ground-only weapons cannot', () => {
        const plane = unit(2, 3, { zone: ZoneType.Air });
        const tank = unit(1);
        expect(getAttackWeight(tank, plane)).toBeNull();
        tank.secondaryWeapon = weapon(30, 8, true, false);
        expect(getAttackWeight(tank, plane)).not.toBeNull();
        expect(getCombatWeapon(tank, plane)?.weapon).toBe(tank.secondaryWeapon);
    });

    test('air-only weapons cannot target buildings with undefined zone or waterborne units', () => {
        const aa = unit(1, 0, { primaryWeapon: weapon(30, 8, true, false) });
        expect(getAttackWeight(aa, unit(2, 4, { type: ObjectType.Building as any, zone: undefined }))).toBeNull();
        expect(getAttackWeight(aa, unit(3, 4, { zone: ZoneType.Water }))).toBeNull();
    });

    test('ignores armor immunity, dead/warped targets and healing weapons', () => {
        const tank = unit(1);
        tank.primaryWeapon.warheadRules.verses.set(1, 0);
        expect(getCombatWeapon(tank, unit(2, 3, { rules: { armor: 1 } }))).toBeNull();
        expect(getCombatWeapon(tank, unit(2, 3, { hitPoints: 0 }))).toBeNull();
        expect(getCombatWeapon(tank, unit(2, 3, { isWarpedOut: true }))).toBeNull();
        expect(getCombatWeapon(unit(1, 0, { primaryWeapon: weapon(-50) }), unit(2))).toBeNull();
    });

    test('finishes a wounded armed enemy before an equally near healthy one', () => {
        const tank = unit(1);
        const wounded = unit(2, 4, { hitPoints: 30 });
        const healthy = unit(3, 4);
        expect(chooseTacticalTarget(tank, [healthy, wounded], new Map())?.id).toBe(wounded.id);
    });

    test('matches weapon armor effectiveness instead of always attacking the closest enemy', () => {
        const tank = unit(1);
        tank.primaryWeapon.warheadRules.verses.set(1, 0.1);
        const ineffective = unit(2, 3, { rules: { armor: 1 } });
        const effective = unit(3, 4);
        expect(chooseTacticalTarget(tank, [ineffective, effective], new Map())?.id).toBe(effective.id);
    });

    test('reserves enough fire to finish a target, then spreads excess volleys', () => {
        const tank = unit(1);
        const wounded = unit(2, 4, { hitPoints: 30 });
        const healthy = unit(3, 4);
        const reserved = new Map<number, number>([[wounded.id, 40]]);
        expect(chooseTacticalTarget(tank, [wounded, healthy], reserved)?.id).toBe(healthy.id);
        expect(chooseTacticalTarget(tank, [healthy], reserved)?.id).toBe(healthy.id);
    });

    test('preserves a firing burst and breaks ties by ID regardless of query order', () => {
        const a = unit(2, 4);
        const b = unit(3, 4);
        expect(chooseTacticalTarget(unit(1), [b, a], new Map())?.id).toBe(a.id);
        expect(chooseTacticalTarget(unit(1), [a, b], new Map())?.id).toBe(a.id);
        const firing = unit(1, 0, { attackState: AttackState.Firing as any });
        expect(chooseTacticalTarget(firing, [unit(4, 3, { hitPoints: 1 }), b], new Map(), b.id)?.id).toBe(b.id);
    });
});

describe('brutal survival micro', () => {
    const passableMap = { getTile: (rx: number, ry: number) => ({ rx, ry }), isPassableTile: () => true } as any;
    test('kites only with a range advantage and a known cooldown', () => {
        const ranged = unit(1, 5, { primaryWeapon: weapon(40, 8) });
        const closeEnemy = unit(2, 1, { primaryWeapon: weapon(40, 5) });
        expect(getTacticalRetreatPoint(ranged, [closeEnemy], passableMap)).toBeNull();
        ranged.primaryWeapon.cooldownTicks = 15;
        expect(getTacticalRetreatPoint(ranged, [closeEnemy], passableMap)?.x).toBeGreaterThan(ranged.tile.rx);
        ranged.attackState = AttackState.Firing as any;
        expect(getTacticalRetreatPoint(ranged, [closeEnemy], passableMap)).toBeNull();
    });

    test('pulls injured units away from threats without retreating from harmless targets', () => {
        const injured = unit(1, 5, { hitPoints: 40 });
        expect(getTacticalRetreatPoint(injured, [unit(2, 1)], passableMap)?.x).toBe(8);
        expect(getTacticalRetreatPoint(injured, [unit(2, 1, { primaryWeapon: undefined })], passableMap)).toBeNull();
        expect(getTacticalRetreatPoint(injured, [unit(2, 20)], passableMap)).toBeNull();
        expect(getTacticalRetreatPoint({ ...injured, canMove: false }, [unit(2, 1)], passableMap)).toBeNull();
    });

    test('rejects blocked and off-map retreats', () => {
        const injured = unit(1, 5, { hitPoints: 40 });
        expect(getTacticalRetreatPoint(injured, [unit(2, 1)], { ...passableMap, getTile: () => undefined })).toBeNull();
        expect(getTacticalRetreatPoint(injured, [unit(2, 1)], { ...passableMap, isPassableTile: () => false })).toBeNull();
    });

    test('pulls crushable infantry away from nearby heavy tanks with crusher capability', () => {
        const infantry = unit(1, 5, { type: ObjectType.Infantry as any, rules: { crushable: true, speedType: SpeedType.Foot, isSelectableCombatant: true, movementZone: MovementZone.Infantry } as any });
        const tank = unit(2, 4, { rules: { crusher: true, speedType: SpeedType.Track, isSelectableCombatant: true, movementZone: MovementZone.Normal } as any });
        expect(getTacticalRetreatPoint(infantry, [tank], passableMap)?.x).toBe(8);
    });
});

describe('command preservation', () => {
    test('deduplicates identical coordinates and retains nonce changes', () => {
        const point = new Vector2(3, 4);
        const action = BatchableAction.toPoint(1, OrderType.Move, point);
        expect(action.isSameAs(BatchableAction.toPoint(1, OrderType.Move, new Vector2(3, 4)))).toBe(true);
        expect(action.isSameAs(BatchableAction.toPoint(1, OrderType.Move, new Vector2(3, 4), 1))).toBe(false);
        point.x = 20;
        expect(action.point?.x).toBe(3);
    });

    test('target ID zero is sent as a targeted order', () => {
        const batcher = new ActionBatcher();
        const orders: any[][] = [];
        batcher.push(BatchableAction.toTargetId(1, OrderType.Attack, 0));
        batcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any);
        expect(orders).toEqual([[[1], OrderType.Attack, 0]]);
    });
});

function squadHarness(difficulty: 'normal' | 'brutal', friendly: UnitData[], enemies: UnitData[]) {
    let tick = 0;
    const orders: any[][] = [];
    const units = new Map([...friendly, ...enemies].map(unit => [unit.id, unit]));
    const mission = {
        getUnitIds: () => friendly.map(unit => unit.id),
        getUnitsMatchingByRule: (_: unknown, filter: (rules: any) => boolean) => friendly.filter(unit => filter(unit.rules)).map(unit => unit.id),
        getCenterOfMass: () => new Vector2(10, 0), getMaxDistanceToCenterOfMass: () => 10, getUniqueName: () => 'test',
    };
    const context = {
        difficulty, player: { name: 'bot' },
        game: { getCurrentTick: () => tick, getPlayerData: () => ({ startLocation: new Vector2() }),
            getUnitData: (id: number) => units.get(id), mapApi: { getTile: () => ({}), isPassableTile: () => true } },
        matchAwareness: { getHostilesNearPoint: (x: number, y: number, range: number) => enemies.filter(unit =>
            new Vector2(unit.tile.rx, unit.tile.ry).distanceTo(new Vector2(x, y)) <= range).map(unit => ({ unitId: unit.id })) },
    };
    const squad = new CombatSquad(new Vector2(), new Vector2(40, 0), 10);
    return {
        orders,
        step(nextTick: number) {
            tick = nextTick;
            const actionBatcher = new ActionBatcher();
            squad.onAiUpdate({ ...context, actionBatcher } as any, mission as any, () => {});
            actionBatcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any);
        },
    };
}

test('brutal squads cover their flanks and do not repeatedly reset active attacks', () => {
    const harness = squadHarness('brutal', [unit(1, 0), unit(2, 20)], [unit(3, 24)]);
    harness.step(0);
    harness.step(6);
    expect(harness.orders).toContainEqual([[2], OrderType.Attack, 3]);
    const count = harness.orders.length;
    harness.step(12);
    expect(harness.orders.length).toBe(count);
});

test('normal squads never issue an impossible attack against the only airborne target', () => {
    const harness = squadHarness('normal', [unit(1, 0)], [unit(3, 4, { zone: ZoneType.Air })]);
    harness.step(0);
    harness.step(10);
    expect(harness.orders.some(order => order[1] === OrderType.Attack)).toBe(false);
    expect(harness.orders.some(order => order[1] === OrderType.AttackMove)).toBe(true);
});

test('brutal micro preserves autonomous AttackMove fire until the firing sequence completes', () => {
    const tank = unit(1, 0);
    const enemy = unit(2, 50);
    const harness = squadHarness('brutal', [tank], [enemy]);
    harness.step(0);
    harness.step(6);
    expect(harness.orders[0][1]).toBe(OrderType.AttackMove);
    enemy.tile.rx = 4;
    let tick = 12;
    for (const state of [AttackState.PrepareToFire, AttackState.FireUp, AttackState.Firing]) {
        tank.attackState = state as any;
        harness.step(tick);
        tick += 6;
        expect(harness.orders).toHaveLength(1);
    }
    tank.attackState = AttackState.Idle as any;
    harness.step(tick);
    expect(harness.orders[1]).toEqual([[1], OrderType.Attack, 2]);
});

test('an interrupted idle attack retries after 30 ticks while live orders remain deduplicated', () => {
    const harness = squadHarness('brutal', [unit(1, 0, { isIdle: true })], [unit(2, 4)]);
    harness.step(0);
    harness.step(6);
    harness.step(12);
    expect(harness.orders).toHaveLength(1);
    harness.step(36);
    expect(harness.orders).toHaveLength(2);
    expect(harness.orders[1]).toEqual(harness.orders[0]);
});

test('retreat uses a move command and holds it long enough to avoid attack/move oscillation', () => {
    const injured = unit(1, 5, { hitPoints: 40 });
    const harness = squadHarness('brutal', [injured], [unit(2, 1)]);
    harness.step(0);
    expect(harness.orders).toEqual([[[1], OrderType.Move, 8, 0]]);
    // The retreat is still active even if the next update would prefer an attack.
    injured.hitPoints = 200;
    harness.step(6);
    expect(harness.orders).toHaveLength(1);
    harness.step(12);
    expect(harness.orders[1]).toEqual([[1], OrderType.Attack, 2]);
});

test('brutal defense responds to a refinery raid outside the original conyard defense zone', () => {
    const refinery = unit(1, 20, { rules: { refinery: true } });
    const raider = unit(2, 30);
    function missionsFor(difficulty: 'normal' | 'brutal') {
        const missions: unknown[] = [];
        const context = {
            difficulty, player: { name: 'bot' },
            game: { getCurrentTick: () => 30,
                getVisibleUnits: (_name: string, _side: string, filter: (rules: any) => boolean) => filter(refinery.rules) ? [refinery.id] : [],
                getGameObjectData: () => refinery, getUnitData: () => raider },
            matchAwareness: { getMainRallyPoint: () => new Vector2(),
                getHostilesNearPoint2d: (point: Vector2, radius: number) =>
                    point.distanceTo(new Vector2(raider.tile.rx, raider.tile.ry)) <= radius ? [{ unitId: raider.id }] : [] },
        };
        new DefenceMissionFactory().maybeCreateMissions(context as any, { addMission: (mission: unknown) => missions.push(mission) } as any, () => {});
        return missions;
    }
    expect(missionsFor('normal')).toHaveLength(0);
    expect(missionsFor('brutal')).toHaveLength(1);
});

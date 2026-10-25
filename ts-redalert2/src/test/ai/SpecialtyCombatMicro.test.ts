import { describe, expect, test } from "bun:test";
import { GameApi } from "../../game/api/GameApi";
import { AttackState, MovementZone, ObjectType, OrderType, SpeedType, StanceType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import type { UnitData } from "../../game/api/interface/UnitData";
import { ActionBatcher, BatchableAction } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";
import { CombatSquad } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/combatSquad";
import { DesolatorTactics, getRadiationDeployment } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/desolatorTactics";
import { chooseTacticalTarget, getCombatWeapon, getTacticalRetreatPoint, isFiringBurst } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/tacticalTargeting";
import { manageAttackMicro } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/common";

function weapon(damage = 90, range = 6, minRange = 0) {
    return { rules: { damage, rof: 60, burst: 1 }, maxRange: range, minRange, cooldownTicks: 0,
        projectileRules: { isAntiGround: true }, warheadRules: { verses: new Map([[0, 1], [1, 0.1]]) } };
}
function tank(id: number, x: number, y = 0, extra: any = {}): UnitData {
    return { id, name: "HTNK", owner: "bot", type: ObjectType.Vehicle, tile: { rx: x, ry: y },
        rules: { name: "HTNK", armor: 1, speedType: SpeedType.Track, movementZone: MovementZone.Normal, isSelectableCombatant: true },
        hitPoints: 400, maxHitPoints: 400, purchaseValue: 900, primaryWeapon: weapon(), canMove: true,
        zone: ZoneType.Ground, isIdle: true, isWarpedOut: false, attackState: AttackState.Idle, ...extra } as unknown as UnitData;
}
function infantry(id: number, x: number, y = 0, extra: any = {}): UnitData {
    return tank(id, x, y, { name: "E1", type: ObjectType.Infantry, hitPoints: 125, maxHitPoints: 125, purchaseValue: 200,
        rules: { name: "E1", armor: 0, speedType: SpeedType.Foot, movementZone: MovementZone.Infantry, isSelectableCombatant: true },
        ...extra });
}
function desolator(id = 1, x = 0, y = 0): UnitData {
    return infantry(id, x, y, { name: "DESO", hitPoints: 150, maxHitPoints: 150, purchaseValue: 600,
        rules: { name: "DESO", deployFire: true, deployFireWeapon: 1, immuneToRadiation: true,
            armor: 0, speedType: SpeedType.Foot, movementZone: MovementZone.Infantry, isSelectableCombatant: true },
        primaryWeapon: { ...weapon(125, 6), warheadRules: { radiation: true, verses: new Map([[0, 1], [1, 0.2]]) } },
        secondaryWeapon: { ...weapon(1, 4), rules: { damage: 1, areaFire: true, radLevel: 500, rof: 60 },
            warheadRules: { radiation: true, cellSpread: 10, verses: new Map([[0, 1], [1, 0.1]]) } } });
}
function fixture(allies = [desolator()], enemies = [infantry(20, 4, 1, { owner: "enemy" }), infantry(21, 4, -1, { owner: "enemy" })]) {
    let tick = 0;
    const radiation = { radDurationMultiple: 1, radLevelDelay: 90, radApplicationDelay: 16,
        radLevelFactor: 0.2, radLevelMax: 500, radSiteWarhead: "RadSite" };
    const game = {
        getCurrentTick: () => tick,
        getVisibleUnits: (_name: string, relation: string, filter: (rules: any) => boolean = () => true) =>
            (relation === "enemy" ? enemies : allies).filter(unit => filter(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => [...allies, ...enemies].find(unit => unit.id === id),
        getPlayerData: () => ({ startLocation: new Vector2() }),
        rulesApi: { radiation, getWarhead: () => ({ verses: new Map([[0, 1], [1, 0.1]]) }) },
        mapApi: { getTile: (rx: number, ry: number) => ({ rx, ry }), isPassableTile: () => true },
    };
    const context = { game, difficulty: "brutal", player: { name: "bot" },
        matchAwareness: { getHostilesNearPoint: (x: number, y: number, range: number) => enemies.filter(unit =>
            new Vector2(x, y).distanceTo(new Vector2(unit.tile.rx, unit.tile.ry)) <= range).map(unit => ({ unitId: unit.id })) } } as any;
    const tactics = new DesolatorTactics();
    return { allies, enemies, game, context, tactics, radiation,
        at(nextTick: number) { tick = nextTick; tactics.observe(context, allies); },
        decision(unit = allies[0], members = allies, destination = new Vector2(40, 0)) {
            return tactics.decide(context, unit, enemies, members, destination);
        } };
}

describe("desolator deployment", () => {
    test("uses cell spread, real decay timing and current stance's actual weapon", () => {
        const f = fixture();
        const deso = f.allies[0];
        expect(getRadiationDeployment(deso, f.game as any)).toMatchObject({ radius: 11, lifetime: 546 });
        expect(getCombatWeapon(deso, f.enemies[0], true)?.weapon).toBe(deso.primaryWeapon);
        deso.stance = StanceType.Deployed as any;
        expect(getCombatWeapon(deso, f.enemies[0], true)).toBeNull();
        expect(getCombatWeapon(desolator(), desolator(2, 3), true)).toBeNull();
        expect(getCombatWeapon(desolator(), tank(2, 3, 0, { type: ObjectType.Building }), true)).toBeNull();
    });

    test("deploys against an exposed enemy group, then waits for acknowledgement without toggling twice", () => {
        const f = fixture();
        f.at(0);
        expect(f.decision().action?.orderType).toBe(OrderType.Deploy);
        f.at(6);
        expect(f.decision()).toEqual({ handled: true });
        f.allies[0].stance = StanceType.Deployed as any;
        f.at(12);
        expect(f.decision()).toEqual({ handled: true });
        f.at(24);
        expect(f.decision()).toEqual({ handled: true });
    });

    test("protects allied infantry beyond the nominal four-tile weapon range and production exits", () => {
        for (const friend of [infantry(2, 9), tank(2, 9, 0, { type: ObjectType.Building, rules: { weaponsFactory: true } })]) {
            const f = fixture([desolator(), friend]);
            f.at(0);
            expect(f.decision().action).toBeUndefined();
        }
    });

    test("allows a safe heavy tank on the distant edge but protects its next advance", () => {
        const friend = tank(2, -11);
        const f = fixture([desolator(), friend]);
        f.at(0);
        expect(f.decision(f.allies[0], f.allies, new Vector2(40, 0)).action).toBeUndefined();
        expect(f.decision(f.allies[0], [f.allies[0]], new Vector2(40, 0)).action?.orderType).toBe(OrderType.Deploy);
    });

    test("immune allies do not prevent deployment, while injured armor and moving allies do", () => {
        const immune = desolator(2, 3);
        const f = fixture([desolator(), immune]); f.at(0);
        expect(f.decision().action?.orderType).toBe(OrderType.Deploy);
        for (const friend of [tank(2, -11, 0, { hitPoints: 100 }), tank(2, -13, 0, { velocity: { x: 1, z: 0 } })]) {
            const blocked = fixture([desolator(), friend]); blocked.at(0);
            expect(blocked.decision(blocked.allies[0], [blocked.allies[0]]).action).toBeUndefined();
        }
    });

    test("does not deploy for isolated, immune, airborne or distant enemies, or on a bridge", () => {
        for (const enemies of [[infantry(20, 4)], [desolator(20, 4), desolator(21, 4)],
            [infantry(20, 4, 0, { zone: ZoneType.Air }), infantry(21, 4, 0, { zone: ZoneType.Air })],
            [infantry(20, 12), infantry(21, 13)]]) {
            const f = fixture([desolator()], enemies); f.at(0);
            expect(f.decision().action).toBeUndefined();
        }
        const f = fixture(); f.allies[0].onBridge = true; f.at(0);
        expect(f.decision().action).toBeUndefined();
    });

    test("independent deploy firing animation is preserved even when AttackTrait is idle", () => {
        const f = fixture();
        f.allies[0].stance = StanceType.Deployed as any;
        f.allies[0].isFiring = true;
        f.enemies.length = 0; f.at(0);
        expect(isFiringBurst(f.allies[0])).toBe(true);
        expect(f.decision()).toEqual({ handled: true });
        f.allies[0].isFiring = false; f.at(6);
        expect(f.decision().action?.orderType).toBe(OrderType.Deploy);
    });

    test("withdraws before another automatic plume and applies a redeploy cooldown", () => {
        const f = fixture(); f.allies[0].stance = StanceType.Deployed as any;
        f.at(0); expect(f.decision().action).toBeUndefined();
        f.at(180); expect(f.decision().action?.orderType).toBe(OrderType.Deploy);
        f.allies[0].stance = StanceType.None as any;
        f.at(186); expect(f.decision().action).toBeUndefined();
        f.at(300); expect(f.decision().action?.orderType).toBe(OrderType.Deploy);
    });

    test("a desolator withdrawal is not batched with an infantry deployment", () => {
        const f = fixture(); f.allies[0].stance = StanceType.Deployed as any;
        f.enemies.length = 0; f.at(0);
        const batcher = new ActionBatcher(), orders: any[] = [];
        batcher.push(f.decision().action!);
        batcher.push(BatchableAction.noTarget(2, OrderType.DeploySelected));
        batcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any);
        expect(orders).toContainEqual([[1], OrderType.Deploy, 1]);
        expect(orders).toContainEqual([[2], OrderType.DeploySelected]);
    });
});

describe("residual radiation movement", () => {
    test("another squad remembers an observed plume after the desolator undeploys or disappears", () => {
        const f = fixture(); f.allies[0].stance = StanceType.Deployed as any; f.at(0);
        f.allies.length = 0;
        const otherSquad = new DesolatorTactics(), friend = tank(2, -15);
        f.at(100); otherSquad.observe(f.context, [friend]);
        expect(otherSquad.isSafeMove(friend, new Vector2(15, 0))).toBe(false);
        const waypoint = otherSquad.getSafeWaypoint(friend, new Vector2(15, 0), f.game as any);
        expect(waypoint).not.toBeNull();
        expect(waypoint).not.toEqual(new Vector2(15, 0));
        expect(otherSquad.isSafeMove(friend, waypoint!)).toBe(true);
        f.at(546); otherSquad.observe(f.context, [friend]);
        expect(otherSquad.isSafeMove(friend, new Vector2(15, 0))).toBe(true);
    });

    test("escapes outward, rejects blocked paths, and never diverts radiation-immune units", () => {
        const f = fixture(); f.allies[0].stance = StanceType.Deployed as any; f.at(0);
        const friend = tank(2, 3);
        const escape = f.tactics.getSafeWaypoint(friend, new Vector2(3, 0), f.game as any);
        expect(escape).not.toBeNull(); expect(escape!.length()).toBeGreaterThan(3);
        f.game.mapApi.isPassableTile = () => false;
        expect(f.tactics.getSafeWaypoint(friend, new Vector2(3, 0), f.game as any)).toBeNull();
        const immune = desolator(3, -15);
        expect(f.tactics.getSafeWaypoint(immune, new Vector2(15, 0), f.game as any)).toEqual(new Vector2(15, 0));
    });

    test("waits at the safe edge instead of circling a destination inside the plume", () => {
        const f = fixture(); f.allies[0].stance = StanceType.Deployed as any; f.at(0);
        const friend = tank(2, 12);
        for (const tick of [6, 12, 24, 36]) {
            f.at(tick);
            expect(f.tactics.getSafeWaypoint(friend, new Vector2(), f.game as any)).toBeNull();
        }
    });

    test("isolates each player's observations even when BotManager shares a GameApi", () => {
        const f = fixture(); f.allies[0].stance = StanceType.Deployed as any;
        const other = tank(3, -15, 0, { owner: "other" }); f.allies.push(other);
        f.game.getVisibleUnits = (name, relation) => relation === "enemy" ? [] : name === "bot" ? [1] : [3];
        f.at(0);
        const tactics = new DesolatorTactics();
        tactics.observe({ ...f.context, player: { name: "other" } }, [other]);
        expect(f.tactics.isSafeMove(other, new Vector2(15, 0))).toBe(false);
        expect(tactics.isSafeMove(other, new Vector2(15, 0))).toBe(true);
    });
    test("follows the engine's reverse-ordered safe route and checks the ordinary Move route too", () => {
        const f = fixture(); f.allies[0].stance = StanceType.Deployed as any; f.at(0);
        const friend = tank(2, -15), destination = new Vector2(15, 0);
        let unsafeOrdinaryPath = false;
        (f.game.mapApi as any).findPath = (_speed: any, start: any, end: any, options: any) => {
            if (!options.excludeNodes) return [{ tile: end.tile, onBridge: false },
                ...(unsafeOrdinaryPath ? [{ tile: { rx: 0, ry: 0 }, onBridge: false }] : []),
                { tile: start.tile, onBridge: false }];
            return [[-15, 0], [-14, 1], [-13, 3], [-12, 6], [-6, 12], [0, 13],
                [6, 12], [12, 6], [13, 3], [14, 1], [15, 0]]
                .map(([rx, ry]) => ({ tile: { rx, ry }, onBridge: false })).reverse();
        };
        expect(f.tactics.getSafeWaypoint(friend, destination, f.game as any)).toEqual(new Vector2(-13, 3));
        unsafeOrdinaryPath = true;
        expect(f.tactics.getSafeWaypoint(friend, destination, f.game as any)).toEqual(new Vector2(-14, 1));
    });
});

describe("tank and artillery coordination", () => {
    const map = { getTile: (rx: number, ry: number) => ({ rx, ry }), isPassableTile: () => true } as any;
    test("recognizes the engine's PrepareToFire recovery without cancelling an initial or active shot", () => {
        const firing = tank(1, 5, 0, { attackState: AttackState.PrepareToFire, isFiring: false });
        expect(isFiringBurst(firing)).toBe(true);
        firing.primaryWeapon.cooldownTicks = 40;
        expect(isFiringBurst(firing)).toBe(false);
        firing.primaryWeapon.cooldownTicks = 6;
        expect(isFiringBurst(firing)).toBe(true);
        firing.primaryWeapon.cooldownTicks = 40;
        firing.isFiring = undefined;
        expect(isFiringBurst(firing)).toBe(true);
        firing.isFiring = true;
        expect(isFiringBurst(firing)).toBe(true);
        firing.isFiring = false;
        for (const state of [AttackState.FireUp, AttackState.Firing]) {
            firing.attackState = state as any;
            expect(isFiringBurst(firing)).toBe(true);
        }
    });
    test("keeps burst weapons, missile launch sequences and deploy animations protected", () => {
        const firing = tank(1, 5, 0, { attackState: AttackState.PrepareToFire, isFiring: false });
        firing.primaryWeapon.cooldownTicks = 40;
        firing.primaryWeapon.rules.burst = 2;
        expect(isFiringBurst(firing)).toBe(true);
        firing.primaryWeapon.rules.burst = 1;
        firing.primaryWeapon.rules.spawner = true;
        expect(isFiringBurst(firing)).toBe(true);
        const deso = desolator(); deso.isFiring = true;
        deso.primaryWeapon.cooldownTicks = 40;
        expect(isFiringBurst(deso)).toBe(true);
    });
    test("prefers an in-range target over an equally dangerous distant target", () => {
        const attacker = tank(1, 0), near = tank(2, 5), far = tank(3, 10);
        expect(chooseTacticalTarget(attacker, [far, near], new Map())?.id).toBe(near.id);
    });
    test("plans GI deployment without mistaking its handheld range for its only engagement option", () => {
        const gi = infantry(1, 0, 0, { primaryWeapon: weapon(15, 4), secondaryWeapon: weapon(25, 5),
            rules: { armor: 0, deployFire: true, deployFireWeapon: 1 } });
        const armor = tank(2, 3), enemyInfantry = infantry(3, 5, 0, { owner: "enemy" });
        expect(getCombatWeapon(gi, enemyInfantry, true)?.range).toBe(4);
        expect(chooseTacticalTarget(gi, [armor, enemyInfantry], new Map())?.id).toBe(enemyInfantry.id);
        expect(manageAttackMicro(gi, enemyInfantry).orderType).toBe(OrderType.DeploySelected);
    });
    test("keeps firing artillery in place and only uses cooldown to restore its range margin", () => {
        const artillery = tank(1, 5, 0, { primaryWeapon: weapon(100, 10, 3) });
        const enemy = tank(2, 0);
        expect(getTacticalRetreatPoint(artillery, [enemy], map)).toBeNull();
        artillery.primaryWeapon.cooldownTicks = 50;
        const retreat = getTacticalRetreatPoint(artillery, [enemy], map)!;
        expect(retreat.x).toBeGreaterThan(5); expect(retreat.length()).toBeLessThanOrEqual(10);
        artillery.isFiring = true;
        expect(getTacticalRetreatPoint(artillery, [enemy], map)).toBeNull();
    });
    test("uses a safe side step when the straight path is blocked and never retreats into stronger crossfire", () => {
        const injured = tank(1, 5, 0, { hitPoints: 50 });
        const blocked = { ...map, isPassableTile: (tile: any) => tile.rx !== 6 || tile.ry !== 0 };
        const retreat = getTacticalRetreatPoint(injured, [tank(2, 0)], blocked)!;
        expect(retreat).not.toBeNull(); expect(retreat.y).not.toBe(0);
        const rear = tank(3, 10, 0, { primaryWeapon: weapon(900, 6) });
        const crossfire = getTacticalRetreatPoint(injured, [tank(2, 0), rear], map);
        expect(crossfire === null || crossfire.x <= injured.tile.rx).toBe(true);
    });
    test("does not abandon a cannon's blind spot or ignore an unsafe radiation path", () => {
        const injured = tank(1, 2, 0, { hitPoints: 50 });
        expect(getTacticalRetreatPoint(injured, [tank(2, 0, 0, { primaryWeapon: weapon(150, 15, 3) })], map)).toBeNull();
        expect(getTacticalRetreatPoint(tank(1, 5, 0, { hitPoints: 50 }), [tank(2, 0)], map, () => false)).toBeNull();
    });
    test("rejects unreachable paths and bridge-level changes even if destination terrain is passable", () => {
        const injured = tank(1, 5, 0, { hitPoints: 50 });
        expect(getTacticalRetreatPoint(injured, [tank(2, 0)], { ...map, findPath: () => [] })).toBeNull();
        expect(getTacticalRetreatPoint(injured, [tank(2, 0)], { ...map,
            findPath: (_speed: any, _start: any, end: any) => [{ tile: end.tile, onBridge: true }] })).toBeNull();
    });
    test("accepts real engine paths returned in destination-to-origin order", () => {
        const injured = tank(1, 5, 0, { hitPoints: 50 });
        const reversePathMap = { ...map, findPath: (_speed: any, start: any, end: any) =>
            [{ tile: end.tile, onBridge: false }, { tile: start.tile, onBridge: false }] };
        expect(getTacticalRetreatPoint(injured, [tank(2, 0)], reversePathMap)?.x).toBe(8);
    });
    test("V3 launcher damage is unknown and its targets are visible stationary buildings", () => {
        const launcher = tank(1, 0, 0, { name: "V3", primaryWeapon: { ...weapon(1, 18, 5),
            rules: { damage: 1, rof: 200, spawner: true } } });
        const moving = tank(2, 7), structure = tank(3, 14, 0, { type: ObjectType.Building });
        expect(getCombatWeapon(launcher, structure, true)).toMatchObject({ damage: 0, damageKnown: false, range: 18 });
        expect(chooseTacticalTarget(launcher, [moving, structure], new Map())?.id).toBe(structure.id);
        expect(chooseTacticalTarget(launcher, [moving], new Map())).toBeNull();
        const closeStructure = tank(4, 2, 0, { type: ObjectType.Building, primaryWeapon: undefined });
        expect(getTacticalRetreatPoint(launcher, [closeStructure], map)?.x).toBeLessThan(0);
    });
});

test("CombatSquad activates desolator tactics only for Brutal", () => {
    for (const difficulty of ["normal", "brutal"] as const) {
        const f = fixture(); f.context.difficulty = difficulty;
        const orders: any[] = [], unit = f.allies[0];
        const mission = { getUnitIds: () => [unit.id], getUnitsMatchingByRule: () => [unit.id],
            getCenterOfMass: () => new Vector2(), getMaxDistanceToCenterOfMass: () => 0, getUniqueName: () => "test" };
        const squad = new CombatSquad(new Vector2(), new Vector2(30, 0), 10);
        for (const tick of [0, 12, 24]) {
            f.at(tick); const actionBatcher = new ActionBatcher();
            squad.onAiUpdate({ ...f.context, actionBatcher }, mission as any, () => {});
            actionBatcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any);
        }
        expect(orders.filter(order => order[1] === OrderType.Deploy)).toHaveLength(difficulty === "brutal" ? 1 : 0);
    }
});

test("GameApi exposes the actual deploy animation flag", () => {
    const unit = { owner: { name: "bot" }, isTechno: () => true, isInfantry: () => true, isVehicle: () => false,
        isBuilding: () => false, isAircraft: () => false, isUnit: () => true, isFiring: true,
        attackTrait: { attackState: AttackState.Idle }, unitOrderTrait: { hasTasks: () => false },
        moveTrait: { isDisabled: () => false, velocity: { clone: () => ({ x: 0, z: 0 }) } },
        warpedOutTrait: { isActive: () => false } };
    const api = { getGameObjectData: () => ({ id: 1 }), game: { getObjectById: () => unit } };
    const data = GameApi.prototype.getUnitData.call(api as any, 1)!;
    expect(data.isFiring).toBe(true);
    expect(data.attackState as any).toBe(AttackState.Idle);
    expect(isFiringBurst(data)).toBe(true);
});

test("a wounded tank keeps its rear position instead of immediately charging back after retreat", () => {
    const friendly = tank(1, 5, 0, { hitPoints: 50, isIdle: false }), enemy = tank(20, 0, 0, { owner: "enemy" });
    const f = fixture([friendly], [enemy]);
    const orders: any[] = [], squad = new CombatSquad(new Vector2(), new Vector2(30, 0), 10);
    const mission = { getUnitIds: () => [1], getUnitsMatchingByRule: () => [1], getCenterOfMass: () => new Vector2(5, 0),
        getMaxDistanceToCenterOfMass: () => 0, getUniqueName: () => "test" };
    const step = (tick: number) => {
        f.at(tick); const actionBatcher = new ActionBatcher();
        squad.onAiUpdate({ ...f.context, actionBatcher }, mission as any, () => {});
        actionBatcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any);
    };
    step(0); step(6);
    expect(orders.at(-1)[1]).toBe(OrderType.Move);
    friendly.tile.rx = 8;
    step(18); step(30);
    expect(orders).toHaveLength(2);
    expect(orders.at(-1)[1]).toBe(OrderType.Stop);
    step(96);
    expect(orders.at(-1)[1]).toBe(OrderType.Attack);
});

test("V3 without a siege target follows its tank screen with Move and does not pursue mobile enemies", () => {
    for (const hasEscort of [false, true]) {
        const launcher = tank(1, 0, 0, { name: "V3", primaryWeapon: { ...weapon(1, 18, 5),
            rules: { damage: 1, rof: 200, spawner: true } } });
        const allies = hasEscort ? [launcher, tank(2, 10)] : [launcher];
        const f = fixture(allies, [tank(20, 14, 0, { owner: "enemy" })]);
        const orders: any[] = [], squad = new CombatSquad(new Vector2(), new Vector2(40, 0), 10);
        const mission = { getUnitIds: () => allies.map(u => u.id), getUnitsMatchingByRule: () => allies.map(u => u.id),
            getCenterOfMass: () => new Vector2(5, 0), getMaxDistanceToCenterOfMass: () => 5, getUniqueName: () => "test" };
        for (const tick of [0, 6]) {
            f.at(tick); const actionBatcher = new ActionBatcher();
            squad.onAiUpdate({ ...f.context, actionBatcher }, mission as any, () => {});
            actionBatcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any);
        }
        const launcherOrders = orders.filter(order => order[0].includes(1));
        expect(launcherOrders).toEqual(hasEscort ? [[[1], OrderType.Move, 7, 0]] : []);
    }
});

import { describe, expect, test } from "bun:test";
import { AttackState, ObjectType, OrderType, SpeedType, StanceType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { ActionBatcher } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";
import { RadiationGuardMission, getRadiationGuardWaypoint, isRadiationGuardPointSafe, selectRadiationGuardPoint } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/radiationGuardMission";

function fixture() {
    let tick = 0, explored = true;
    const weapon = (damage = 15, range = 4) => ({ rules: { damage, rof: 20 }, maxRange: range,
        projectileRules: { isAntiGround: true }, warheadRules: { verses: new Map([[0, 1]]) } });
    const objects = new Map<number, any>();
    const add = (id: number, name: string, owner: string, x: number, y: number, rules: any = {}) => {
        const unit = { id, name, owner, tile: { rx: x, ry: y }, type: ObjectType.Infantry,
            zone: ZoneType.Ground, hitPoints: 125, maxHitPoints: 125, purchaseValue: 100,
            rules: { name, armor: 0, speedType: SpeedType.Foot, isSelectableCombatant: true, ...rules },
            canMove: true, isIdle: true, attackState: AttackState.Idle, primaryWeapon: weapon() };
        objects.set(id, unit);
        return unit as any;
    };
    const base = add(100, "NACNST", "bot", 0, 0, { constructionYard: true });
    base.type = ObjectType.Building;
    const factory = add(101, "NAWEAP", "bot", -4, 0, { weaponsFactory: true });
    factory.type = ObjectType.Building;
    const deso = add(1, "DESO", "bot", 16, 0, { deployFire: true, deployFireWeapon: 1, immuneToRadiation: true });
    deso.hitPoints = deso.maxHitPoints = 150;
    deso.secondaryWeapon = { ...weapon(1, 4), rules: { damage: 1, areaFire: true, radLevel: 500 },
        warheadRules: { cellSpread: 10, verses: new Map([[0, 1]]) } };
    for (let id = 20; id < 23; id++) add(id, "E2", "enemy", 30, id - 21);
    const tiles = new Map<string, any>();
    const tile = (x: number, y: number) => {
        const key = `${x},${y}`;
        if (!tiles.has(key)) tiles.set(key, { rx: x, ry: y });
        return tiles.get(key);
    };
    const orders: any[][] = [];
    const game = {
        getCurrentTick: () => tick,
        getGameObjectData: (id: number) => objects.get(id), getUnitData: (id: number) => objects.get(id),
        getVisibleUnits: (_name: string, relation: string, filter = (_rules: any) => true) => [...objects.values()]
            .filter(unit => (relation === "enemy" ? unit.owner === "enemy" : unit.owner === "bot") && filter(unit.rules)).map(unit => unit.id),
        getPlayers: () => ["bot", "enemy"], areAlliedPlayers: () => false,
        getPlayerData: (name: string) => ({ name, country: { name: "Arabs" }, credits: 5000, isCombatant: true,
            startLocation: new Vector2(name === "bot" ? 0 : 60, 0) }),
        rulesApi: { radiation: { radDurationMultiple: 1, radLevelDelay: 90, radApplicationDelay: 16,
            radLevelFactor: 0.2, radLevelMax: 500, radSiteWarhead: "RadSite" },
            getWarhead: () => ({ verses: new Map([[0, 1]]) }) },
        mapApi: { getTile: tile, isVisibleTile: () => explored, hasBridgeOnTile: () => false, isPassableTile: () => true,
            findPath: (_speed: number, from: any, to: any, options: any) => {
                const nodes = [from];
                let x = from.tile.rx, y = from.tile.ry;
                while (x !== to.tile.rx || y !== to.tile.ry) {
                    x += Math.sign(to.tile.rx - x); y += Math.sign(to.tile.ry - y);
                    const next = { tile: tile(x, y), onBridge: false };
                    if (options.excludeNodes?.(next)) return [];
                    nodes.push(next);
                }
                return nodes.reverse();
            } },
    };
    const context: any = { game, difficulty: "brutal", player: { name: "bot", production: { getAvailableObjects: () => [] } } };
    const mission = new RadiationGuardMission(() => {});
    mission.addUnit(1);
    return { context, game, objects, deso, factory, add, orders, mission,
        hideTerrain() { explored = false; },
        step(at: number) {
            tick = at;
            const batcher = new ActionBatcher();
            const result = mission.onAiUpdate({ ...context, actionBatcher: batcher });
            batcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any);
            return result;
        } };
}

describe("positional radiation defence", () => {
    test("chooses an explored intercept position clear of production and friendly infantry", () => {
        const f = fixture();
        const guard = selectRadiationGuardPoint(f.context, 11)!;
        expect(guard.x).toBeGreaterThan(11);
        expect(guard.distanceTo(new Vector2(-4, 0))).toBeGreaterThanOrEqual(14);
        expect(isRadiationGuardPointSafe(f.context, guard, 11)).toBe(true);
        f.add(2, "E2", "bot", guard.x, guard.y + 10);
        expect(isRadiationGuardPointSafe(f.context, guard, 11)).toBe(false);
        f.objects.delete(2);
        f.factory.tile = { rx: guard.x, ry: guard.y + 13 };
        expect(isRadiationGuardPointSafe(f.context, guard, 11)).toBe(false);
    });

    test("holds its chosen ground, deploys for an approaching group and never chases distant infantry", () => {
        const f = fixture();
        f.step(0);
        const guard = (f.mission as any).guard as Vector2;
        f.deso.tile = { rx: guard.x, ry: guard.y };
        f.orders.length = 0;
        f.step(6);
        expect(f.orders).toEqual([]);
        for (let id = 20; id < 23; id++) f.objects.get(id).tile = { rx: guard.x + 4, ry: guard.y + id - 21 };
        f.step(12);
        expect(f.orders).toContainEqual([[1], OrderType.Deploy, 1]);
        expect(f.orders.some(order => order[1] === OrderType.Attack || order[1] === OrderType.AttackMove)).toBe(false);
    });

    test("does not send a desolator into unexplored terrain when no safe position exists", () => {
        const f = fixture();
        f.hideTerrain();
        for (const tick of [0, 60, 240, 900]) f.step(tick);
        expect(f.orders).toEqual([]);
        expect((f.mission as any).guard).toBeUndefined();
    });

    test("withdraws from deployment when new friendly infantry makes the position unsafe", () => {
        const f = fixture();
        f.step(0);
        const guard = (f.mission as any).guard as Vector2;
        f.deso.tile = { rx: guard.x, ry: guard.y };
        f.deso.stance = StanceType.Deployed;
        f.add(2, "E2", "bot", guard.x - 5, guard.y);
        f.orders.length = 0;
        f.step(60);
        expect(f.orders).toContainEqual([[1], OrderType.Deploy, 1]);
        const replacement = (f.mission as any).guard as Vector2 | undefined;
        expect(!replacement || replacement.distanceTo(new Vector2(guard.x - 5, guard.y)) >= 14).toBe(true);
    });

    test("refuses a transfer path crossing a known enemy gun's range", () => {
        const f = fixture();
        f.objects.get(20).tile = { rx: 24, ry: 0 };
        expect(getRadiationGuardWaypoint(f.context, f.deso, new Vector2(32, 0))).toBeUndefined();
        f.objects.delete(20); f.objects.delete(21); f.objects.delete(22);
        expect(getRadiationGuardWaypoint(f.context, f.deso, new Vector2(32, 0))).toEqual(new Vector2(20, 0));
    });
});

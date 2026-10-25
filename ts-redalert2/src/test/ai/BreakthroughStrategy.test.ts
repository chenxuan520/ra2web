import { describe, expect, test } from "bun:test";
import { MovementZone, ObjectType, OrderType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { Mission, noop, requestUnits } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/mission";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { FieldArmyMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/fieldArmyMission";
import { InfantryHomeMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/infantryHomeMission";
import { BaseReserveMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseReserveMission";
import { ActionBatcher } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";
import { calculateGlobalThreat } from "../../game/ai/thirdpartbot/builtIn/bot/logic/threat/threatCalculator";

class RequestMission extends Mission {
    requested: Record<string, number> = {};
    constructor() { super("requests", () => {}); }
    _onAiUpdate() { return Object.keys(this.requested).length ? requestUnits(this.requested) : noop(); }
    getPriority() { return 1; }
    getGlobalDebugText() { return undefined; }
}

describe("mission production snapshots", () => {
    test.each(["normal", "brutal"] as const)("%s handles fulfilled requests without changing the other profile", difficulty => {
        const controller = new MissionController(() => {}), mission = new RequestMission();
        controller.addMission(mission);
        const context = { difficulty, game: { getVisibleUnits: () => [], getGameObjectData: () => undefined },
            player: { name: "bot", actions: { orderUnits() {} } } } as any;
        mission.requested = { HTNK: 50, NAWEAP: 40 };
        controller.onAiUpdate(context);
        expect(controller.getRequestedUnitTypes().get("HTNK")?.priority).toBe(50);
        // A newly delivered tank/factory no longer appears in the mission's deficits.
        mission.requested = { HTK: 45 };
        controller.onAiUpdate(context);
        const requests = controller.getRequestedUnitTypes();
        expect(requests.get("HTK")?.priority).toBe(45);
        if (difficulty === "brutal") {
            expect(requests.has("HTNK")).toBe(false);
            expect(requests.has("NAWEAP")).toBe(false);
        } else expect(requests.get("HTNK")?.priority).toBe(36.5);
    });
});

test("a NeverUse dog scanner does not count as Brutal anti-air, while real flak still does", () => {
    const rules = new Map<string, any>([
        ["DOG", { name: "DOG", type: ObjectType.Infantry, primary: "Teeth", secondary: "Scanner" }],
        ["HTK", { name: "HTK", type: ObjectType.Vehicle, primary: "FlakGround", secondary: "FlakAir" }],
        ["NASAM", { name: "NASAM", type: ObjectType.Building, primary: "FlakAir" }],
    ]);
    const weapons = new Map<string, any>([
        ["Teeth", { damage: 30, range: 1.5, rof: 30, projectile: "ground" }],
        ["Scanner", { damage: 1, range: 5, rof: 0, projectile: "all", neverUse: true }],
        ["FlakGround", { damage: 25, range: 5, rof: 40, projectile: "ground" }],
        ["FlakAir", { damage: 35, range: 8, rof: 40, projectile: "air" }],
    ]);
    const enemy = [{ id: 1, name: "DOG", hitPoints: 100, maxHitPoints: 100 }];
    const game: any = {
        getVisibleUnits: (_name: string, relation: string, filter: any) => relation === "enemy" ? enemy.filter(u => filter(rules.get(u.name))).map(u => u.id) : [],
        getGameObjectData: (id: number) => enemy.find(u => u.id === id),
        rulesApi: { infantryRules: new Map([["DOG", rules.get("DOG")]]), vehicleRules: new Map([["HTK", rules.get("HTK")]]),
            aircraftRules: new Map(), buildingRules: new Map([["NASAM", rules.get("NASAM")]]), getWeapon: (name: string) => weapons.get(name),
            getProjectile: (name: string) => ({ isAntiGround: name !== "air", isAntiAir: name !== "ground" }) },
    };
    expect(calculateGlobalThreat(game, { name: "bot" } as any, 1).totalOffensiveAntiAirThreat).toBeGreaterThan(0);
    expect(calculateGlobalThreat(game, { name: "bot" } as any, 1, true).totalOffensiveAntiAirThreat).toBe(0);
    enemy.push({ id: 2, name: "HTK", hitPoints: 180, maxHitPoints: 180 });
    expect(calculateGlobalThreat(game, { name: "bot" } as any, 1, true).totalOffensiveAntiAirThreat).toBeGreaterThan(0);
    enemy.splice(0, enemy.length, { id: 3, name: "NASAM", hitPoints: 180, maxHitPoints: 180 });
    expect(calculateGlobalThreat(game, { name: "bot" } as any, 1).totalOffensiveAntiAirThreat).toBe(0);
    expect(calculateGlobalThreat(game, { name: "bot" } as any, 1, true).totalOffensiveAntiAirThreat).toBeGreaterThan(0);
});

function fieldFixture() {
    const objects = new Map<number, any>();
    const add = (id: number, name: string, x = 0, owner = "bot") => {
        const type = ["NACNST"].includes(name) ? ObjectType.Building : ["E2", "E1", "DESO"].includes(name) ? ObjectType.Infantry : ObjectType.Vehicle;
        const unit = { id, name, owner, type, tile: { rx: x, ry: 0 }, hitPoints: 400, maxHitPoints: 400,
            zone: ZoneType.Ground, isIdle: true, rules: { name, type, isSelectableCombatant: type !== ObjectType.Building,
                constructionYard: name === "NACNST", harvester: name === "HARV", armor: 0, movementZone: MovementZone.Destroyer },
            primaryWeapon: { maxRange: 5.75, rules: { damage: 90, rof: 65 }, projectileRules: { isAntiGround: true },
                warheadRules: { verses: new Map([[0, 1]]) } } };
        objects.set(id, unit);
        return unit;
    };
    add(100, "NACNST"); add(101, "HARV");
    const controller = new MissionController(() => {});
    const mission = new FieldArmyMission(null, controller, () => {});
    controller.addMission(mission);
    const orders: any[][] = [];
    let tick = 0;
    const game = {
        getCurrentTick: () => tick,
        getVisibleUnits: (_name: string, relation: string, filter = (_: any) => true) => [...objects.values()]
            .filter(u => (relation === "enemy" ? u.owner === "enemy" : u.owner === "bot") && filter(u.rules)).map(u => u.id),
        getUnitData: (id: number) => objects.get(id), getGameObjectData: (id: number) => objects.get(id),
        getPlayerData: () => ({ name: "bot", country: { name: "Russians" }, startLocation: new Vector2(), credits: 5000 }),
        getPlayers: () => ["bot"],
        rulesApi: { vehicleRules: new Map(), infantryRules: new Map(), aircraftRules: new Map(), buildingRules: new Map() },
        mapApi: { getTile: (rx: number, ry: number) => ({ rx, ry }), isVisibleTile: () => false,
            getStartingLocations: () => [new Vector2(), new Vector2(120, 0)],
            getRealMapSize: () => ({ width: 60, height: 60 }) },
    };
    const context = { difficulty: "brutal", game, player: { name: "bot", production: {
        getAvailableObjects: () => ["HTNK", "HTK", "E2"].map(name => ({ name })) } },
        matchAwareness: { getMainRallyPoint: () => new Vector2(10, 0), getThreatCache: () => null,
            getHostilesNearPoint: () => [...objects.values()].filter(u => u.owner === "enemy").map(u => ({ unitId: u.id })) } };
    return { mission, controller, add, objects, orders, game, context, step(at = 0) {
        tick = at;
        for (const unit of objects.values()) {
            const map = unit.type === ObjectType.Infantry ? game.rulesApi.infantryRules : game.rulesApi.vehicleRules;
            map.set(unit.name, unit.rules);
        }
        const batcher = new ActionBatcher();
        const result = mission.onAiUpdate({ ...context, actionBatcher: batcher } as any);
        batcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any);
        return result;
    } };
}

describe("persistent field army", () => {
    test("two tanks can pressure only after actual home defenders are assigned and nearby", () => {
        const f = fieldFixture();
        for (let id = 1; id <= 2; id++) { f.add(id, "HTNK"); f.mission.addUnit(id); }
        f.add(200, "E2", 15, "enemy");
        f.step(); expect(f.mission.getAttackArea()).toEqual(new Vector2(4, 0));
        const home = new BaseReserveMission(() => {}); f.controller.addMission(home);
        for (let id = 10; id < 22; id++) { f.add(id, "E2", 40); home.addUnit(id); }
        f.step(30); expect(f.mission.getAttackArea()).toEqual(new Vector2(4, 0));
        for (let id = 10; id < 22; id++) f.objects.get(id)!.tile.rx = 0;
        f.orders.length = 0; f.step(60);
        expect(f.mission.getAttackArea()).toEqual(new Vector2(15, 0));
        expect(f.orders.flatMap(o => o[0]).every(id => id === 1 || id === 2)).toBe(true);
    });
    test("keeps free conscripts out of the mobile army and releases misplaced infantry", () => {
        const f = fieldFixture();
        for (let id = 1; id <= 32; id++) f.add(id, "E2");
        const request = f.step();
        expect(request.type).toBe("request");
        if (request.type === "request") expect(request.unitNameToPriority.E2).toBeUndefined();
        f.mission.addUnit(1);
        expect(f.step(2)).toMatchObject({ type: "releaseUnits", unitIds: [1] });
        expect(f.orders).toHaveLength(0);
    });
    test("home infantry preserves the old field request and total spending cap", () => {
        const f = fieldFixture();
        const home = new InfantryHomeMission(f.controller, () => {});
        f.controller.addMission(home);
        const update = () => home.onAiUpdate({ ...f.context, actionBatcher: new ActionBatcher() } as any);
        expect(update()).toMatchObject({ type: "request", unitNameToPriority: { E2: 20 } });
        for (let id = 1; id <= 12; id++) f.add(id, "E2");
        const reserve = new RequestMission(); f.controller.addMission(reserve);
        for (let id = 1; id <= 12; id++) reserve.addUnit(id);
        expect(update()).toMatchObject({ type: "request", unitNameToPriority: { E2: 20 } });
        for (let id = 13; id <= 32; id++) { f.add(id, "E2"); home.addUnit(id); }
        expect(update().type).toBe("noop");
        home.removeUnit(32);
        expect(update()).toMatchObject({ type: "requestSpecific", unitIds: [32], priority: 20 });
    });
    test("home infantry stays on a defensive approach without seizing the locked reserve", () => {
        const f = fieldFixture();
        const home = new InfantryHomeMission(f.controller, () => {}); f.controller.addMission(home);
        f.add(1, "E2"); home.addUnit(1); f.add(200, "E2", 40, "enemy");
        const batcher = new ActionBatcher();
        home.onAiUpdate({ ...f.context, actionBatcher: batcher } as any);
        batcher.resolve({ orderUnits: (...args: any[]) => f.orders.push(args) } as any);
        expect(f.orders.some(order => order[1] === OrderType.Attack && order[2] === 200)).toBe(false);
        expect(home.isUnitsLocked()).toBe(true);
    });
    test("home role never changes normal or allied strategy", () => {
        const f = fieldFixture(); const home = new InfantryHomeMission(f.controller, () => {});
        expect(home.onAiUpdate({ ...f.context, difficulty: "normal", actionBatcher: new ActionBatcher() } as any).type).toBe("noop");
        const data = f.game.getPlayerData();
        f.game.getPlayerData = () => ({ ...data, country: { name: "Americans" } });
        expect(home.onAiUpdate({ ...f.context, actionBatcher: new ActionBatcher() } as any).type).toBe("noop");
    });
    test("the opening does not fund more than two rocketeers before its second miner", () => {
        const f = fieldFixture();
        f.context.player.production.getAvailableObjects = () => ["MTNK", "JUMPJET"].map(name => ({ name }));
        f.mission.setPlan({ composition: { JUMPJET: 1 }, minimumUnits: 2, maximumUnits: 4 });
        for (let id = 1; id <= 2; id++) { f.add(id, "JUMPJET"); f.mission.addUnit(id); }
        const opening = f.step();
        expect(opening.type).toBe("request");
        if (opening.type === "request") expect(opening.unitNameToPriority.JUMPJET).toBeUndefined();
        f.add(102, "HARV");
        const funded = f.step(2);
        expect(funded.type).toBe("request");
        if (funded.type === "request") expect(funded.unitNameToPriority.JUMPJET).toBeGreaterThan(0);
    });
    test("assembling armor defends a short home perimeter instead of chasing the first infantry wave", () => {
        const f = fieldFixture();
        f.add(1, "HTNK"); f.mission.addUnit(1);
        f.add(200, "E2", 15, "enemy");
        f.step();
        expect(f.orders.some(order => order[1] === OrderType.Attack)).toBe(false);
        expect(f.mission.getAttackArea()).toEqual(new Vector2(4, 0));
        for (let id = 2; id <= 4; id++) { f.add(id, "HTNK"); f.mission.addUnit(id); }
        f.orders.length = 0; f.step(30);
        expect(f.orders.some(order => order[1] === OrderType.Attack && order[2] === 200)).toBe(true);
    });

    test("claims free paradrops but leaves the locked reserve and radioactive defenders alone", () => {
        const f = fieldFixture();
        for (let id = 1; id <= 8; id++) f.add(id, "E1");
        f.add(9, "DESO");
        const result = f.step();
        expect(result).toMatchObject({ type: "requestSpecific", unitIds: [1, 2, 3, 4, 5, 6, 7, 8] });
        f.objects.delete(9);
        for (let id = 1; id <= 8; id++) f.objects.delete(id);
        for (let id = 1; id <= 5; id++) f.add(id, "E1");
        expect(f.step(2).type).toBe("request");
    });

    test("after clearing an explored enemy start, searches shroud without reading hidden objects or terrain", () => {
        const f = fieldFixture();
        for (let id = 1; id <= 4; id++) { f.add(id, "HTNK"); f.mission.addUnit(id); }
        let revealed = false;
        f.game.mapApi.isVisibleTile = (tile: any) => revealed || tile.rx !== 20 || tile.ry !== 20;
        f.game.mapApi.getTile = (rx: number, ry: number) => ({ rx, ry,
            get landType(): never { throw new Error("Hidden terrain must not inform target selection"); } });
        f.step();
        expect(f.mission.getAttackArea()).toEqual(new Vector2(20, 20));
        f.step(30);
        expect(f.mission.getAttackArea()).toEqual(new Vector2(20, 20));
        revealed = true;
        f.step(60);
        expect(f.mission.getAttackArea()).toEqual(new Vector2(10, 0));
    });
});


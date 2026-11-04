import { expect, test } from "bun:test";
import { MovementZone, ObjectType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { FieldArmyMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/fieldArmyMission";

function scenario(tankCount: number, threatX: number) {
    let tick = 7000;
    const own: any[] = Array.from({ length: tankCount }, (_, i) => ({
        id: i + 1, name: "HTNK", owner: "bot", type: ObjectType.Vehicle, zone: ZoneType.Ground,
        tile: { rx: 0, ry: i % 2 }, hitPoints: 400, maxHitPoints: 400,
        rules: { name: "HTNK", type: ObjectType.Vehicle, movementZone: MovementZone.Normal, isSelectableCombatant: true },
    }));
    own.push({ id: 20, owner: "bot", name: "NACNST", type: ObjectType.Building, tile: { rx: 0, ry: 0 },
        rules: { name: "NACNST", type: ObjectType.Building, constructionYard: true } });
    own.push({ id: 21, owner: "bot", name: "NAWEAP", type: ObjectType.Building, tile: { rx: 0, ry: 2 },
        rules: { name: "NAWEAP", type: ObjectType.Building, weaponsFactory: true } });
    const enemies: any[] = [30, 31].map((id, index) => ({
        id, owner: "enemy", name: "HTNK", type: ObjectType.Vehicle, zone: ZoneType.Ground,
        tile: { rx: threatX, ry: index },
        rules: { name: "HTNK", type: ObjectType.Vehicle, movementZone: MovementZone.Normal,
            isSelectableCombatant: true, primary: "120mm" },
    }));
    const game: any = {
        getCurrentTick: () => tick,
        getPlayerData: (name: string) => name === "bot"
            ? { name, startLocation: new Vector2(), credits: 62, country: { name: "Russians" } }
            : { name, isCombatant: true },
        getPlayers: () => ["bot", "enemy"],
        areAlliedPlayers: (a: string, b: string) => a === b,
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "self" ? own : enemies).filter(unit => predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => [...own, ...enemies].find(unit => unit.id === id),
        getGameObjectData: (id: number) => [...own, ...enemies].find(unit => unit.id === id),
        mapApi: {
            getStartingLocations: () => [new Vector2(), new Vector2(70, 0)],
            getRealMapSize: () => ({ width: 80, height: 80 }),
            getTile: (rx: number, ry: number) => ({ rx, ry }),
            isVisibleTile: () => false,
        },
    };
    let defensiveRadius: number | undefined;
    const controller = new MissionController(() => {});
    const army = new FieldArmyMission(null, controller, () => {});
    Object.assign(army, { squad: {
        setAirSafety() {}, setAttackArea() {}, onAiUpdate() {},
        setDefensiveRadius(value: number | undefined) { defensiveRadius = value; },
    } });
    for (let id = 1; id <= tankCount; id++) army.addUnit(id);
    const context: any = { game, difficulty: "brutal", player: { name: "bot", production: { getAvailableObjects: () => [] } },
        matchAwareness: { getMainRallyPoint: () => new Vector2(10, 0), getThreatCache: () => null } };
    return { army, own, enemies, at(value: number) { tick = value; },
        run() { army.onAiUpdate(context); }, radius: () => defensiveRadius };
}

test("two surviving tanks regroup at home instead of chasing a distant approaching column", () => {
    const f = scenario(2, 40);
    f.run();
    expect(f.army.isAttacking()).toBe(false);
    expect(f.army.getAttackArea().distanceTo(new Vector2())).toBeLessThanOrEqual(4);
    expect(f.radius()).toBe(7);
});

test("an assembled four-tank force can still intercept visible approaching armor", () => {
    const f = scenario(4, 40);
    f.run();
    expect(f.army.getAttackArea().x).toBe(40);
    expect(f.radius()).toBe(25);
});

test("an incomplete force still responds when enemy armor is already inside the base", () => {
    const f = scenario(2, 10);
    f.run();
    expect(f.army.getAttackArea().x).toBe(10);
    expect(f.radius()).toBe(25);
});

function addLightHomeDefence(f: ReturnType<typeof scenario>) {
    f.enemies.push({ id: 35, name: "NALASR", owner: "enemy", type: ObjectType.Building, zone: ZoneType.Ground,
        tile: { rx: 80, ry: 2 }, rules: { name: "NALASR", type: ObjectType.Building, primary: "Vulcan" } });
    for (let id = 40; id < 43; id++) f.enemies.push({
        id, name: "E2", owner: "enemy", type: ObjectType.Infantry, zone: ZoneType.Ground,
        tile: { rx: 80, ry: id - 37 },
        rules: { name: "E2", type: ObjectType.Infantry, movementZone: MovementZone.Infantry,
            isSelectableCombatant: true, primary: "M1Carbine" },
    });
}

test("a healthy late three-tank numerical advantage can pressure a lightly defended two-tank opponent", () => {
    const f = scenario(3, 80);
    addLightHomeDefence(f);
    f.at(24000);
    f.run();
    expect(f.army.isAttacking()).toBe(true);
    expect(f.army.getAttackArea().x).toBe(80);
    for (const unit of f.enemies) expect(Object.hasOwn(unit, "hitPoints")).toBe(false);
});

test("the numerical opportunity does not relax the early-game formation threshold", () => {
    const f = scenario(3, 80);
    addLightHomeDefence(f);
    f.run();
    expect(f.army.isAttacking()).toBe(false);
});

test("three late tanks still do not attack an equal or larger tank force", () => {
    for (const count of [3, 4]) {
        const f = scenario(3, 80);
        while (f.enemies.length < count) f.enemies.push({ ...f.enemies[0], id: 30 + f.enemies.length });
        addLightHomeDefence(f);
        f.at(24000);
        f.run();
        expect(f.army.isAttacking()).toBe(false);
    }
});

test("damaged own armor does not trigger a small late-game opportunity attack", () => {
    const f = scenario(3, 80);
    addLightHomeDefence(f);
    f.own[0].hitPoints = 240;
    f.at(24000);
    f.run();
    expect(f.army.isAttacking()).toBe(false);
});

test("a real high-tech cannon is not treated as light machinegun defence", () => {
    const f = scenario(3, 80);
    addLightHomeDefence(f);
    const tower = f.enemies.find(unit => unit.id === 35)!;
    tower.name = "ATESLA";
    tower.rules = { name: "ATESLA", type: ObjectType.Building, primary: "PrismShot" };
    f.at(24000);
    f.run();
    expect(f.army.isAttacking()).toBe(false);
});

test("a small ground opportunity does not ignore visible air pressure", () => {
    const f = scenario(3, 80);
    addLightHomeDefence(f);
    f.enemies.push({ id: 50, name: "JUMPJET", owner: "enemy", type: ObjectType.Infantry, zone: ZoneType.Air,
        tile: { rx: 80, ry: 7 }, rules: { name: "JUMPJET", type: ObjectType.Infantry, movementZone: MovementZone.Fly,
            isSelectableCombatant: true, primary: "20mm" } });
    f.at(24000);
    f.run();
    expect(f.army.isAttacking()).toBe(false);
});

test("unknown own health is not assumed to satisfy the healthy-armor exception", () => {
    const f = scenario(3, 80);
    addLightHomeDefence(f);
    delete f.own[0].hitPoints;
    f.at(24000);
    f.run();
    expect(f.army.isAttacking()).toBe(false);
});

import { describe, expect, mock, test } from "bun:test";
import { ArmorType } from "../../game/type/ArmorType";
import { BuildStatus } from "../../game/gameobject/Building";
import { MovementZone, ObjectType, OrderType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { FieldArmyMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/fieldArmyMission";
import { BaseReserveMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseReserveMission";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { CombatSquad } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/combatSquad";
import { ActionBatcher } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";
import { readPressure } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/pressure";

// D2's eight complete-equivalent B4 games record a defending cohort retargeting a
// nearby DOG/ADOG with radius25. These normalized public fixtures prove target
// selection and close-fire controls, not native wins or opposing exact health.
function scenario(country = "Russians", foot = 8, enemyFoot = 12, enemyX = 40, tick = 3932) {
    let id = 1, radius: number | undefined;
    const soviet = country === "Russians", infantry = soviet ? "E2" : "E1", core = soviet ? "HTNK" : "MTNK";
    const own: any[] = [], enemies: any[] = [], hidden = new Set<number>();
    const player: any = { name: "bot", country: { name: country }, startLocation: new Vector2(), credits: 2000 };
    const rulesMaps = { vehicleRules: new Map(), infantryRules: new Map(), aircraftRules: new Map(), buildingRules: new Map() };
    const gun = (damage: number, range: number) => ({ maxRange: range, minRange: 0, cooldownTicks: 0,
        rules: { damage, rof: 30 }, projectileRules: { isAntiGround: true, isAntiAir: false },
        warheadRules: { verses: new Map([[ArmorType.None, 1], [ArmorType.Heavy, 1], [ArmorType.Concrete, 1]]) } });
    function add(name: string, owner = "bot", x = 0, extra = {}) {
        const isInfantry = ["E1", "E2", "DOG", "ADOG"].includes(name), vehicle = ["HTNK", "MTNK", "HARV", "CMIN"].includes(name);
        const type = isInfantry ? ObjectType.Infantry : vehicle ? ObjectType.Vehicle : ObjectType.Building;
        const rules = { name, type, strength: 100, movementZone: MovementZone.Normal,
            armor: isInfantry ? ArmorType.None : vehicle ? ArmorType.Heavy : ArmorType.Concrete,
            isSelectableCombatant: isInfantry || ["HTNK", "MTNK"].includes(name),
            harvester: ["HARV", "CMIN"].includes(name), constructionYard: ["NACNST", "GACNST"].includes(name),
            refinery: ["NAREFN", "GAREFN"].includes(name), weaponsFactory: ["NAWEAP", "GAWEAP"].includes(name),
            primary: ["DOG", "ADOG"].includes(name) ? "Teeth" : isInfantry ? "Rifle" : vehicle ? "Cannon" : undefined,
            crushable: !["DOG", "ADOG"].includes(name), ...extra };
        const unit: any = { id: id++, name, owner, type, rules, zone: ZoneType.Ground, tile: { rx: x, ry: 0 },
            foundation: { width: 1, height: 1 }, buildStatus: BuildStatus.Ready, isWarpedOut: false, isIdle: true, canMove: true };
        if (owner === "bot") {
            unit.hitPoints = unit.maxHitPoints = name === "HTNK" ? 400 : name === "MTNK" ? 300 : isInfantry ? 125 : 1000;
            if (rules.isSelectableCombatant) unit.primaryWeapon = gun(isInfantry ? 15 : 90, isInfantry ? 4 : 5.75);
        }
        (owner === "bot" ? own : enemies).push(unit);
        (type === ObjectType.Infantry ? rulesMaps.infantryRules : type === ObjectType.Vehicle ? rulesMaps.vehicleRules : rulesMaps.buildingRules).set(name, rules);
        return unit;
    }
    add(soviet ? "NACNST" : "GACNST"); add(soviet ? "NAWEAP" : "GAWEAP"); add(soviet ? "NAREFN" : "GAREFN", "bot", 5);
    add(soviet ? "HARV" : "CMIN", "bot", 5); add(soviet ? "HARV" : "CMIN", "bot", 5);
    const missions = new MissionController(() => {}), reserve = new BaseReserveMission(() => {});
    const army = new FieldArmyMission({ composition: { [infantry]: 1 }, minimumUnits: 8, maximumUnits: soviet ? 16 : 12 }, missions, () => {});
    Object.assign(army, { squad: { setAirSafety() {}, setAttackArea() {}, onAiUpdate() {}, setDefensiveRadius(value?: number) { radius = value; } } });
    missions.addMission(reserve); missions.addMission(army);
    const reserved = [add(infantry).id, add(infantry).id]; reserved.forEach(uid => reserve.addUnit(uid));
    for (let i = 0; i < foot; i++) army.addUnit(add(infantry).id);
    army.addUnit(add(core).id);
    for (let i = 0; i < enemyFoot; i++) add("E1", "enemy", enemyX);
    add("MTNK", "enemy", enemyX);
    const actions = { orderUnits: mock((_ids: number[], ..._args: any[]) => {}) };
    const game: any = { getCurrentTick: () => tick, getPlayers: () => ["bot", "enemy"], areAlliedPlayers: () => false,
        getPlayerData: (name: string) => name === "bot" ? player : { name, isCombatant: true },
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "self" ? own : enemies).filter(unit => !hidden.has(unit.id) && predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (uid: number) => { if (hidden.has(uid)) throw Error("hidden unit lookup"); return [...own, ...enemies].find(unit => unit.id === uid); },
        getGameObjectData: (uid: number) => game.getUnitData(uid),
        rulesApi: { ...rulesMaps,
            getWeapon: (name: string) => ({ damage: name === "Teeth" ? 30 : 15, range: name === "Teeth" ? 1.5 : 4,
                rof: 30, projectile: "ground", warhead: name === "Teeth" ? "Infantry" : "SA" }),
            getProjectile: () => ({ isAntiGround: true, isAntiAir: false }),
            getWarhead: (name: string) => ({ verses: new Map([[ArmorType.None, 1], [ArmorType.Heavy, name === "Infantry" ? 0 : 1]]) }) },
        mapApi: { getStartingLocations: () => [player.startLocation, new Vector2(200, 0)], getRealMapSize: () => ({ width: 80, height: 80 }),
            getTile: (rx: number, ry: number) => ({ rx, ry }), isVisibleTile: () => false,
            findPath: (_speed: any, _start: any, end: any) => [end] } };
    const context: any = { game, difficulty: "brutal", player: { name: "bot", actions, production: {
        getAvailableObjects: () => [core, soviet ? "HTK" : "FV", infantry].map(name => ({ name })) } },
        matchAwareness: { getMainRallyPoint: () => new Vector2(10, 0), getThreatCache: () => null,
            getHostilesNearPoint: (x: number, y: number, scan: number) => enemies.filter(unit => !hidden.has(unit.id) &&
                Math.hypot(unit.tile.rx - x, unit.tile.ry - y) <= scan).map(unit => ({ unitId: unit.id })) } };
    return { army, reserve, reserved, own, enemies, hidden, add, game, context, actions, infantry,
        run() { return army.onAiUpdate(context); }, radius: () => radius };
}

describe("B5 a nearby scout cannot redirect an outmatched defending field army", () => {
    test.each([["Russians", "DOG"], ["Russians", "ADOG"], ["Americans", "DOG"], ["Americans", "ADOG"]])(
        "%s keeps its weak cohort at reserve instead of chasing %s", (country, name) => {
            const f = scenario(country), dog = f.add(name, "enemy", 18), ids = [...f.army.getUnitIds()];
            f.run(); expect(readPressure(f.context).earlyPressure).toBe(true); expect(f.army.isAttacking()).toBe(false);
            expect(f.army.getAttackArea().distanceTo(new Vector2())).toBeLessThanOrEqual(4);
            expect(f.army.getAttackArea()).not.toEqual(new Vector2(dog.tile.rx, dog.tile.ry)); expect(f.radius()).toBe(7);
            expect(f.army.getUnitIds()).toEqual(ids); expect(f.reserve.getUnitIds()).toEqual(f.reserved);
        });
    test.each(["Russians", "Americans"])("%s still selects real enemy armor in the base when a closer dog is present", country => {
        const f = scenario(country); f.add("DOG", "enemy", 10); const tank = f.add("MTNK", "enemy", 18);
        f.run(); expect(f.army.isAttacking()).toBe(false); expect(f.army.getAttackArea()).toEqual(new Vector2(tank.tile.rx, tank.tile.ry));
        expect(f.radius()).toBe(25);
    });
    test("an actual infantry intrusion next to the owned base is not displaced by a nearer dog", () => {
        const f = scenario(); f.add("ADOG", "enemy", 2); const intruder = f.add("E1", "enemy", 5);
        f.run(); expect(f.army.getAttackArea()).toEqual(new Vector2(intruder.tile.rx, intruder.tile.ry)); expect(f.radius()).toBe(25);
    });
    test.each(["Russians", "Americans"])("%s original weak-rush behaviour without a scout is unchanged", country => {
        const f = scenario(country); f.run(); expect(f.army.isAttacking()).toBe(false);
        expect(f.army.getAttackArea().distanceTo(new Vector2())).toBeLessThanOrEqual(4); expect(f.radius()).toBe(7);
    });
    test.each(["Russians", "Americans"])("%s favorable assault keeps its original scout/intruder response", country => {
        const f = scenario(country, 10, 3); const dog = f.add("DOG", "enemy", 18); f.run();
        expect(f.army.isAttacking()).toBe(true); expect(f.army.getAttackArea()).toEqual(new Vector2(dog.tile.rx, dog.tile.ry));
    });
    test.each(["Russians", "Americans"])("Normal %s does not opt into the new target filter", country => {
        const f = scenario(country); f.context.difficulty = "normal"; const dog = f.add("DOG", "enemy", 18); f.run();
        expect(f.army.getAttackArea()).toEqual(new Vector2(dog.tile.rx, dog.tile.ry)); expect(f.radius()).toBe(25);
    });
    test("the original deadline remains outside the new early-infantry target filter", () => {
        const f = scenario("Americans", 8, 12, 40, 7000); const dog = f.add("ADOG", "enemy", 18); f.run();
        expect(f.army.getAttackArea()).toEqual(new Vector2(dog.tile.rx, dog.tile.ry)); expect(f.radius()).toBe(25);
    });
    test("a dog alone cannot fabricate an early armed-ground rush", () => {
        const f = scenario("Americans", 8, 12, 100); const dog = f.add("DOG", "enemy", 18); f.run();
        expect(readPressure(f.context).earlyPressure).toBe(false); expect(f.army.getAttackArea()).toEqual(new Vector2(dog.tile.rx, dog.tile.ry));
    });
    test("hidden scouts never enter the target filter", () => {
        const f = scenario(); const dog = f.add("DOG", "enemy", 18); f.hidden.add(dog.id);
        Object.defineProperty(dog, "tile", { get() { throw Error("hidden position query"); } }); f.run();
        expect(f.army.getAttackArea().distanceTo(new Vector2())).toBeLessThanOrEqual(4);
    });
    test("ecoOnly leaves the historical direct mission behaviour unchanged", () => {
        const f = scenario(); const dog = f.add("ADOG", "enemy", 18), previous = BRUTAL_PARAMS.economy.ecoOnly;
        BRUTAL_PARAMS.economy.ecoOnly = 1;
        try { f.run(); expect(f.army.getAttackArea()).toEqual(new Vector2(dog.tile.rx, dog.tile.ry)); }
        finally { BRUTAL_PARAMS.economy.ecoOnly = previous; }
    });
    test("reserve-radius close fire still attacks a nearby dog through the real squad/action batcher", () => {
        const f = scenario(); const dog = f.add("DOG", "enemy", 3), batcher = new ActionBatcher();
        const squad = new CombatSquad(new Vector2(4, 0), new Vector2(4, 0), 7);
        squad.setDefensiveRadius(7); squad.onAiUpdate({ ...f.context, actionBatcher: batcher }, f.army, () => {});
        batcher.resolve(f.actions as any, f.game.mapApi);
        expect(f.actions.orderUnits.mock.calls.some(call => call[1] === OrderType.Attack && call[2] === dog.id)).toBe(true);
    });
});

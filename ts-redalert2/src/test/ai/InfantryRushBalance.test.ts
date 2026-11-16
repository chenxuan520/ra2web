import { describe, expect, mock, test } from "bun:test";
import { BuildStatus } from "../../game/gameobject/Building";
import { MovementZone, ObjectType, QueueType, QueueStatus, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { DefaultStrategy } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/defaultStrategy";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";
import { FieldArmyMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/fieldArmyMission";
import { BaseReserveMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseReserveMission";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { QueueController, QUEUES } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController";
import { readPressure, setPressureWatchPost } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/pressure";

// B3's blanket planner diversion is empirically rejected, not a contract to preserve.
// These normalized public fixtures test selective posture with the existing paid
// cohort. B2/D1's fully equivalent4500 deficit motivates the weak-force witness;
// they are not native replays or evidence that a future candidate wins the matrix.
function fixture(country = "Russians", foot = 8, core = 1, enemyFoot = 12, enemyCore = 1, enemyX = 40) {
    let tick = 3000, id = 1, radius: number | undefined;
    const soviet = country === "Russians", infantryName = soviet ? "E2" : "E1", tankName = soviet ? "HTNK" : "MTNK";
    const minerName = soviet ? "HARV" : "CMIN", owned: any[] = [], enemies: any[] = [], hidden = new Set<number>();
    const player: any = { name: "bot", country: { name: country, side: soviet ? 1 : 0 }, startLocation: new Vector2(), credits: 5000,
        power: { total: 300, drain: 0, isLowPower: false }, isAi: true, isCombatant: true };
    function add(name: string, owner = "bot", x = 0, extra = {}) {
        const infantry = ["E1", "E2", "DOG", "ADOG", "ENGINEER"].includes(name);
        const vehicle = ["HTNK", "MTNK", "CMIN", "HARV"].includes(name);
        const type = infantry ? ObjectType.Infantry : vehicle ? ObjectType.Vehicle : ObjectType.Building;
        const rules = { name, type, movementZone: MovementZone.Normal, harvester: ["CMIN", "HARV"].includes(name),
            isSelectableCombatant: infantry || ["HTNK", "MTNK"].includes(name), constructionYard: ["NACNST", "GACNST"].includes(name),
            refinery: ["NAREFN", "GAREFN"].includes(name), weaponsFactory: ["NAWEAP", "GAWEAP"].includes(name),
            primary: infantry ? "M60" : vehicle ? "120mm" : undefined, ...extra };
        const unit: any = { id: id++, name, owner, type, rules, tile: { rx: x, ry: 0 }, zone: ZoneType.Ground,
            foundation: { width: 1, height: 1 }, buildStatus: BuildStatus.Ready, isWarpedOut: false, isIdle: true };
        if (owner === "bot") unit.hitPoints = unit.maxHitPoints = name === "HTNK" ? 400 : name === "MTNK" ? 300 : infantry ? 125 : 1000;
        (owner === "bot" ? owned : enemies).push(unit); return unit;
    }
    add(soviet ? "NACNST" : "GACNST"); add(soviet ? "NAWEAP" : "GAWEAP"); add(soviet ? "NAREFN" : "GAREFN", "bot", 5);
    add(minerName, "bot", 5); add(minerName, "bot", 5);
    const missions = new MissionController(() => {}), reserve = new BaseReserveMission(() => {});
    const army = new FieldArmyMission({ composition: { [infantryName]: 1 }, minimumUnits: 8, maximumUnits: soviet ? 16 : 12 }, missions, () => {});
    Object.assign(army, { squad: { setAirSafety() {}, setAttackArea() {}, onAiUpdate() {}, setDefensiveRadius(value?: number) { radius = value; } } });
    missions.addMission(reserve); missions.addMission(army);
    const reserved = [add(infantryName).id, add(infantryName).id]; reserved.forEach(uid => reserve.addUnit(uid));
    for (let i = 0; i < foot; i++) army.addUnit(add(infantryName).id);
    for (let i = 0; i < core; i++) army.addUnit(add(tankName).id);
    for (let i = 0; i < enemyFoot; i++) add("E1", "enemy", enemyX);
    for (let i = 0; i < enemyCore; i++) add("MTNK", "enemy", enemyX);
    const available = new Map(QUEUES.map(type => [type, [] as any[]]));
    available.set(QueueType.Vehicles, [{ name: tankName, type: ObjectType.Vehicle, cost: soviet ? 900 : 700 },
        { name: soviet ? "HTK" : "FV", type: ObjectType.Vehicle, cost: 500 }, { name: minerName, type: ObjectType.Vehicle, cost: 1400, harvester: true }]);
    available.set(QueueType.Infantry, [{ name: infantryName, type: ObjectType.Infantry, cost: soviet ? 100 : 200 }]);
    const queues = new Map(QUEUES.map(type => [type, { type, status: QueueStatus.Idle, size: 0, items: [] as any[] }]));
    const production: any = { getAvailableObjects: (type?: QueueType) => type === undefined ? [...available.values()].flat() : available.get(type)!,
        getQueueData: (type: QueueType) => queues.get(type)! };
    const actions = { queueForProduction: mock((_type: QueueType, _name: string, _object: ObjectType, _quantity: number) => {}),
        unqueueFromProduction: mock(() => {}), pauseProduction: mock(() => {}), resumeProduction: mock(() => {}), toggleRepairWrench: mock(() => {}), sellBuilding: mock(() => {}) };
    const game: any = { getCurrentTick: () => tick, getPlayers: () => ["bot", "enemy"], areAlliedPlayers: () => false,
        getPlayerData: (name: string) => name === "bot" ? player : { name, isCombatant: true }, generateRandomInt: () => 0,
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "self" ? owned : enemies).filter(unit => !hidden.has(unit.id) && predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (uid: number) => { if (hidden.has(uid)) throw Error("hidden lookup"); return [...owned, ...enemies].find(unit => unit.id === uid); },
        getGameObjectData: (uid: number) => game.getUnitData(uid),
        rulesApi: { vehicleRules: new Map(), infantryRules: new Map(), aircraftRules: new Map(), buildingRules: new Map() },
        mapApi: { getStartingLocations: () => [player.startLocation, new Vector2(200, 0)], getRealMapSize: () => ({ width: 80, height: 80 }),
            getTile: (rx: number, ry: number) => ({ rx, ry }), isVisibleTile: (tile: any) => tile.rx === 5,
            getAllTilesResourceData: () => [{ tile: { rx: 5, ry: 0 }, ore: 8000, gems: 0 }], getResourceCreditValues: () => ({ ore: 10, gems: 20 }),
            getTileResourceData: () => undefined, findPath: (_speed: any, _start: any, end: any) => [end] } };
    const context: any = { game, difficulty: "brutal", player: { name: "bot", production, actions },
        matchAwareness: { getMainRallyPoint: () => new Vector2(10, 0), getThreatCache: () => null, getNextExpansionCandidates: () => [] } };
    return { army, missions, reserve, reserved, context, game, enemies, owned, hidden, add, actions, tankName, minerName, infantryName,
        at(value: number) { tick = value; }, radius: () => radius,
        step() { return army.onAiUpdate(context); },
        plan() { return (new DefaultStrategy() as any).selectRandomAttackComposition(context, () => {}, missions); },
        buy() { new QueueController().onAiUpdate(context, null, new Map(), () => {}, !army.isAttacking()); } };
}

describe("B4 defend a real unfavorable rush without deleting a viable cohort", () => {
    test.each(["Russians", "Americans"])("%s keeps its paid opening plan instead of B3's unconditional armored diversion", country => {
        const f = fixture(country);
        expect(f.plan()).toMatchObject({ minimumUnits: 8, composition: { [f.infantryName]: 1 } });
    });
    test.each(["Russians", "Americans"])("%s weak visible rush closes the infantry assault exception but preserves paid fighters and reinforcements", country => {
        const f = fixture(country), ids = [...f.army.getUnitIds()];
        const result: any = f.step();
        expect(readPressure(f.context).earlyPressure).toBe(true);
        expect(f.army.isAttacking()).toBe(false);
        expect(f.army.getAttackArea().distanceTo(new Vector2())).toBeLessThanOrEqual(4);
        expect(f.radius()).toBe(7);
        expect(result.type).toBe("request"); expect(result.unitNameToPriority[f.infantryName]).toBe(95);
        expect(f.army.getUnitIds()).toEqual(ids); expect(f.reserve.getUnitIds()).toEqual(f.reserved);
    });
    test.each(["Russians", "Americans"])("%s clearly favorable early infantry battle still attacks; public pressure is not a blanket retreat", country => {
        const f = fixture(country, 10, 1, 3, 1), ids = [...f.army.getUnitIds()]; f.step();
        expect(readPressure(f.context).earlyPressure).toBe(true); expect(f.army.isAttacking()).toBe(true);
        expect(f.army.getUnitIds()).toEqual(ids);
    });
    test("an already attacking three-tank cohort retreats even above the old decimation floor when the approaching mixed force is stronger", () => {
        const f = fixture("Russians", 8, 3, 20, 2, 100); f.step(); expect(f.army.isAttacking()).toBe(true);
        for (const enemy of f.enemies) enemy.tile.rx = 40; f.at(3030); f.step();
        expect(f.army.isAttacking()).toBe(false); expect(f.army.getUnitsOfTypes(f.game, "E2")).toHaveLength(8);
    });
    test("temporary fog after an unfavorable rush does not instantly relaunch; the existing warning expiry releases the hold", () => {
        const f = fixture(); f.step(); expect(f.army.isAttacking()).toBe(false);
        f.enemies.length = 0; f.at(3030); f.step();
        expect(readPressure(f.context).earlyPressure).toBe(true); expect(f.army.isAttacking()).toBe(false);
        f.at(5700); f.step(); expect(readPressure(f.context).earlyPressure).toBe(false); expect(f.army.isAttacking()).toBe(true);
    });
    test("a newly favorable visible force releases defence before the warning timer expires", () => {
        const f = fixture(); f.step(); expect(f.army.isAttacking()).toBe(false);
        f.army.addUnit(f.add("HTNK").id); f.army.addUnit(f.add("E2").id); f.at(3030); f.step();
        expect(readPressure(f.context).earlyPressure).toBe(true); expect(f.army.isAttacking()).toBe(true);
    });
    test("the original ready six-tank assault remains available even though the pure infantry matchup is countered", () => {
        const f = fixture("Russians", 8, 6, 12, 3); f.step(); expect(f.army.isAttacking()).toBe(true);
    });
    test("P1 outside the home radius carries the same legal unfavorable-rush signal", () => {
        const f = fixture("Russians", 8, 1, 12, 1, 92); setPressureWatchPost(f.game, "bot", { rx: 80, ry: 0 }); f.step();
        expect(readPressure(f.context)).toMatchObject({ earlyPressure: true, baseUnderSiege: false });
        expect(f.army.isAttacking()).toBe(false);
    });
    test("a distant visible force alone does not widen this bounded early-rush rule", () => {
        const f = fixture("Russians", 8, 1, 12, 1, 100); f.step();
        expect(readPressure(f.context).earlyPressure).toBe(false); expect(f.army.isAttacking()).toBe(true);
    });
    test("an existing successful assault is not stopped merely because its opponents move back into fog", () => {
        const f = fixture("Russians", 10, 1, 3, 1); f.step(); expect(f.army.isAttacking()).toBe(true);
        f.enemies.length = 0; f.at(3030); f.step(); expect(f.army.isAttacking()).toBe(true);
    });
    test("hidden opponents are never inspected to classify a rush", () => {
        const f = fixture(); for (const unit of f.enemies) { f.hidden.add(unit.id); Object.defineProperty(unit, "tile", { get() { throw Error("hidden position"); } }); }
        f.step(); expect(f.army.isAttacking()).toBe(true);
    });
    test("Normal remains outside the new posture signal", () => {
        const f = fixture(); f.context.difficulty = "normal"; f.step();
        expect(f.army.isAttacking()).toBe(false); expect(f.army.getUnitsOfTypes(f.game, "E2")).toHaveLength(8);
        expect(readPressure(f.context).earlyPressureUntil).toBe(5700);
    });
    test("ecoOnly does not acquire a new combat posture from an early warning", () => {
        const f = fixture(), previous = BRUTAL_PARAMS.economy.ecoOnly; BRUTAL_PARAMS.economy.ecoOnly = 1;
        try { f.step(); expect(f.army.isAttacking()).toBe(true); } finally { BRUTAL_PARAMS.economy.ecoOnly = previous; }
    });
    test("defence uses real own-field state for B2 funding, then the quiet window restores110 optional income", () => {
        const f = fixture(); f.step(); expect(f.army.isAttacking()).toBe(false); f.buy();
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.tankName, ObjectType.Vehicle, 1);
        f.enemies.length = 0; f.at(5700); f.step(); f.actions.queueForProduction.mockClear(); f.buy();
        expect(readPressure(f.context).homeQuiet).toBe(true);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.minerName, ObjectType.Vehicle, 1);
    });
    test("the original7000 cohort handoff and reserve locks are not extended", () => {
        const f = fixture(); f.at(7000); expect(f.step()).toMatchObject({ type: "releaseUnits" });
        expect(f.reserve.getUnitIds()).toEqual(f.reserved); expect(f.reserve.isUnitsLocked()).toBe(true);
    });
});

import { describe, expect, mock, test } from "bun:test";
import { BuildStatus } from "../../game/gameobject/Building";
import { ProductionQueue } from "../../game/player/production/ProductionQueue";
import { ProductionTrait } from "../../game/trait/ProductionTrait";
import { NotifyTick } from "../../game/trait/interface/NotifyTick";
import { observePressureEvent, readPressure } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/pressure";
import { ApiEventType, MovementZone, ObjectType, OrderType, QueueStatus, QueueType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { getDronePriority, getDroneProductionState, observeDroneProductionEvent } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/droneProduction";
import { QueueController, QUEUES } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController";
import { DroneRaidMission, DroneRaidMissionFactory } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/droneRaidMission";
import { HarassmentMission, HarassmentMissionFactory } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/harassmentMission";
import { RAID_TARGET_SEPARATION, selectEarlyRaidTarget } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/strategicTargets";
import { Mission, grabCombatants, noop } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/mission";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";

function fixture(miners = 3, core = 4, country = "Russians") {
    let tick = 100, nextId = 1;
    const objects = new Map<number, any>(), offworld = new Set<number>(), hidden = new Set<number>(), lookups: number[] = [];
    const player: any = { name: "bot", country: { name: country, side: country === "Russians" ? 1 : 0 }, startLocation: new Vector2(),
        credits: 5000, power: { total: 300, drain: 0 }, isAi: true, isCombatant: true };
    const weapon = { maxRange: 5, rules: { damage: 65, rof: 60 }, warheadRules: { verses: new Map([[0, 1]]) },
        projectileRules: { isAntiGround: true, isAntiAir: false } };
    const rulesApi = { vehicleRules: new Map<string, any>(), infantryRules: new Map(), aircraftRules: new Map(), buildingRules: new Map() };
    const add = (name: string, owner = "bot", rx = 0, ry = 0, type = ObjectType.Vehicle) => {
        const rule: any = { name, type, cost: name === "DRON" ? 500 : ["HARV", "CMIN"].includes(name) ? 1400 : 900,
            harvester: ["HARV", "CMIN"].includes(name), refinery: name === "NAREFN", weaponsFactory: name === "NAWEAP",
            constructionYard: name === "NACNST", isSelectableCombatant: type !== ObjectType.Building, movementZone: MovementZone.Normal,
            baseNormal: type === ObjectType.Building, armor: 0 };
        const object: any = { id: nextId++, name, owner, rules: rule, type, tile: { rx, ry }, foundation: { width: 1, height: 1 },
            hitPoints: 300, maxHitPoints: 300, isIdle: true, canMove: true, zone: type === ObjectType.Aircraft ? ZoneType.Air : ZoneType.Ground,
            buildStatus: BuildStatus.Ready, primaryWeapon: type === ObjectType.Vehicle ? weapon : undefined };
        objects.set(object.id, object);
        const table = type === ObjectType.Building ? rulesApi.buildingRules : type === ObjectType.Aircraft ? rulesApi.aircraftRules : rulesApi.vehicleRules;
        table.set(name, rule);
        return object;
    };
    add("NACNST", "bot", 0, 0, ObjectType.Building); add("NAWEAP", "bot", 0, 0, ObjectType.Building);
    add("NAREFN", "bot", 5, 0, ObjectType.Building);
    for (let i = 0; i < miners; i++) add("HARV", "bot", 10);
    for (let i = 0; i < core; i++) add(country === "Russians" ? "HTNK" : "MTNK", "bot", 40);
    const queues = new Map(QUEUES.map(type => [type, { type, status: QueueStatus.Idle, items: [] as any[], size: 0 }]));
    const vehicles = ["DRON", "HARV", "HTNK", "HTK"].map(name => ({ name, type: ObjectType.Vehicle, cost: name === "HARV" ? 1400 : name === "HTNK" ? 900 : 500, harvester: name === "HARV" }));
    const actions = { queueForProduction: mock((_queue: QueueType, _name: string, _type: ObjectType, _quantity: number) => {}),
        orderUnits: mock((_ids: number[], _order: OrderType, ..._target: any[]) => {}), setUnitDebugText: mock((_id: number, _text: any) => {}),
        unqueueFromProduction: mock(() => {}), pauseProduction: mock(() => {}), resumeProduction: mock(() => {}), sellBuilding: mock(() => {}), toggleRepairWrench: mock(() => {}) };
    const game: any = { getCurrentTick: () => tick, getGeneralRules: () => ({ baseUnit: ["AMCV", "SMCV"] }), rulesApi,
        getPlayerData: (name: string) => { if (name !== player.name) throw Error("private enemy metadata"); return player; },
        getVisibleUnits: (_name: string, relation: string, predicate = (_rule: any) => true) => [...objects.values()]
            .filter(object => !offworld.has(object.id) && !hidden.has(object.id) && (relation === "self" ? object.owner === "bot" : object.owner === "enemy") && predicate(object.rules)).map(object => object.id),
        getGameObjectData: (id: number) => { lookups.push(id); return offworld.has(id) || hidden.has(id) ? undefined : objects.get(id); },
        getUnitData: (id: number) => game.getGameObjectData(id),
        mapApi: { getAllTilesResourceData: () => [{ tile: { rx: 10, ry: 0 }, ore: 8000, gems: 0 }], isVisibleTile: () => true,
            getResourceCreditValues: () => ({ ore: 1, gems: 2 }), getStartingLocations: () => [player.startLocation, new Vector2(200, 0)],
            getTile: (rx: number, ry: number) => ({ rx, ry }), getTileResourceData: () => undefined,
            findPath: (_speed: any, _start: any, end: any) => [end] },
    };
    const context: any = { game, difficulty: "brutal", player: { name: player.name, actions, production: {
        getAvailableObjects: (type?: QueueType) => type === undefined || type === QueueType.Vehicles ? vehicles : [],
        getQueueData: (type: QueueType) => queues.get(type)!,
    } }, matchAwareness: { getThreatCache: () => null, getNextExpansionCandidates: () => [], getMainRallyPoint: () => new Vector2(),
        getHostilesNearPoint: (x: number, y: number, radius: number) => [...objects.values()].filter(object => object.owner === "enemy" && !hidden.has(object.id) &&
            Math.hypot(object.tile.rx - x, object.tile.ry - y) <= radius).map(object => ({ unitId: object.id })),
        getHostilesNearPoint2d: (point: Vector2, radius: number) => context.matchAwareness.getHostilesNearPoint(point.x, point.y, radius) } };
    const controller = new MissionController(() => {});
    return { context, player, game, objects, offworld, hidden, lookups, queues, vehicles, actions, add, controller,
        at(value: number) { tick = value; },
        spawnDrone() { const drone = add("DRON"); observeDroneProductionEvent(game, player.name, { type: ApiEventType.ObjectSpawn, target: drone.id }); return drone; },
        destroy(id: number) { objects.delete(id); observeDroneProductionEvent(game, player.name, { type: ApiEventType.ObjectDestroy, target: id }); },
        produce() { new QueueController().onAiUpdate(context, null, new Map(), () => {}); } };
}

describe("paid drone production and public own lifecycle", () => {
    test.each([
        { built: 0, miners: 1, core: 0, enemy: false, priority: 112 },
        { built: 1, miners: 2, core: 0, enemy: false, priority: 0 },
        { built: 1, miners: 3, core: 0, enemy: false, priority: 0 },
        { built: 1, miners: 3, core: 3, enemy: true, priority: 0 },
        { built: 1, miners: 3, core: 4, enemy: false, priority: 0 },
        { built: 1, miners: 3, core: 4, enemy: true, priority: 60 },
        { built: 2, miners: 3, core: 3, enemy: true, priority: 0 },
        { built: 2, miners: 3, core: 4, enemy: false, priority: 0 },
        { built: 2, miners: 3, core: 4, enemy: true, priority: 60 },
        { built: 3, miners: 3, core: 4, enemy: true, priority: 60 },
        { built: 4, miners: 3, core: 8, enemy: true, priority: 0 },
    ])("production table %j", row => {
        const f = fixture(row.miners, row.core);
        for (let i = 0; i < row.built; i++) f.destroy(f.spawnDrone().id);
        if (row.enemy) f.add("HARV", "enemy", 80);
        expect(getDronePriority(f.context)).toBe(row.priority);
    });
    test.each(["pressure", "deadline", "no-factory", "no-miner", "allied"])("first drone is blocked by %s", reason => {
        const f = fixture(reason === "no-miner" ? 0 : 1, 0, reason === "allied" ? "Americans" : "Russians");
        if (reason === "pressure") f.add("HTNK", "enemy", 22);
        if (reason === "deadline") f.at(9000);
        if (reason === "no-factory") for (const [id, object] of f.objects) if (object.name === "NAWEAP") f.objects.delete(id);
        expect(getDronePriority(f.context)).toBe(0);
    });
    test("the first drone retains its opening request during distant infantry warning without relaxing economic pressure", () => {
        const f = fixture(1, 0); f.at(3122);
        for (let i = 0; i < 3; i++) f.add("E2", "enemy", 40, i, ObjectType.Infantry);
        expect(readPressure(f.context).pressured).toBe(true);
        expect(readPressure(f.context).baseUnderSiege).toBe(false);
        expect(getDronePriority(f.context)).toBe(112);
        f.produce(); expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "DRON", ObjectType.Vehicle, 1);
        expect(readPressure(f.context).pressured).toBe(true);
    });
    test.each([1, 2, 3])("produced count%i keeps later drones suppressed during the same warning", built => {
        const f = fixture(); for (let i = 0; i < built; i++) f.destroy(f.spawnDrone().id);
        f.add("HARV", "enemy", 80);
        for (let i = 0; i < 3; i++) f.add("E2", "enemy", 40, i, ObjectType.Infantry);
        f.at(3122); expect(getDronePriority(f.context)).toBe(0);
    });
    test.each([899, 900])("the first drone respects the actual economic-loss recovery window at%i", elapsed => {
        const f = fixture(1, 0), yard = [...f.objects.values()].find(object => object.name === "NACNST")!;
        f.at(3000); observePressureEvent(f.game, f.player.name, { type: ApiEventType.ObjectSpawn, target: yard.id });
        observePressureEvent(f.game, f.player.name, { type: ApiEventType.ObjectDestroy, target: yard.id });
        f.objects.delete(yard.id); f.at(3000 + elapsed);
        expect(getDronePriority(f.context)).toBe(elapsed < 900 ? 0 : 112);
    });
    test("an actual attacked remote refinery still prevents the first drone without redefining public-home pressure", () => {
        const f = fixture(1, 0); f.at(3122);
        [...f.objects.values()].find(object => object.name === "NAREFN")!.tile.rx = 95;
        f.add("E2", "enemy", 100, 0, ObjectType.Infantry);
        expect(readPressure(f.context).pressured).toBe(false);
        f.produce(); expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HARV", ObjectType.Vehicle, 1);
    });
    test("a genuinely paid first drone completes its native queue instead of being replaced by ordinary armor85 on a warning", () => {
        const f = fixture(1, 0), queue = new ProductionQueue(QueueType.Vehicles, 1, 1);
        for (const option of f.vehicles) Object.assign(option, { owner: [], buildTimeMultiplier: 1 });
        const drone = f.vehicles.find(option => option.name === "DRON")!, controller = new QueueController();
        const actions = { ...f.actions,
            queueForProduction: mock((type: QueueType, name: string) => { const rules = f.vehicles.find(option => option.name === name)!; queue.push(rules, 1, rules.cost); }),
            unqueueFromProduction: mock((type: QueueType, name: string) => { const item = queue.getFirst()!; f.player.credits += item.creditsSpent; queue.pop(item.rules, 1); }),
        };
        f.context.player.actions = actions;
        f.context.player.production.getQueueData = (type: QueueType) => type === QueueType.Vehicles
            ? { type, status: queue.status, items: queue.getAll().map(item => ({ rules: item.rules, quantity: item.quantity })) } : f.queues.get(type)!;
        f.player.production = { buildSpeedModifier: 1, getAllQueues: () => [queue], getFactoryTypeForQueueType: () => QueueType.Vehicles, getFactoryCount: () => 1 };
        const native: NotifyTick = new ProductionTrait({ general: { buildSpeed: 1, multipleFactory: 1, wallBuildSpeedCoefficient: 1 },
            buildingRules: new Map(), infantryRules: new Map(), vehicleRules: new Map(f.vehicles.map(option => [option.name, option])), aircraftRules: new Map() }, { value: false });
        const world = { getCombatants: () => [f.player], events: { dispatch() {} } };
        f.player.credits = drone.cost; f.at(3122); controller.onAiUpdate(f.context, null, new Map(), () => {});
        for (let i = 0; i < 200; i++) native[NotifyTick.onTick](world);
        const paidItem = queue.getFirst()!, paid = paidItem.creditsSpent;
        expect(paid).toBeGreaterThan(0); expect(paid).toBeLessThan(drone.cost);
        for (let i = 0; i < 3; i++) f.add("E2", "enemy", 40, i, ObjectType.Infantry);
        f.at(3244); controller.onAiUpdate(f.context, null, new Map(), () => {});
        expect(actions.unqueueFromProduction).not.toHaveBeenCalled(); expect(queue.getFirst()).toBe(paidItem);
        for (let i = 0; i < 400 && queue.status !== QueueStatus.Ready; i++) native[NotifyTick.onTick](world);
        expect(queue.status).toBe(QueueStatus.Ready); expect(queue.getFirst()!.creditsSpent).toBe(drone.cost);
        expect(f.player.credits).toBe(0);
    });
    test("two alive drones include parasite limbo, not only current world counts", () => {
        const f = fixture(), a = f.spawnDrone(), b = f.spawnDrone();
        for (const drone of [a, b]) { observeDroneProductionEvent(f.game, f.player.name, { type: ApiEventType.ObjectUnspawn, target: drone.id }); f.offworld.add(drone.id); }
        expect(f.game.getVisibleUnits("bot", "self", (rule: any) => rule.name === "DRON")).toEqual([]);
        expect(getDroneProductionState(f.game, f.player.name).aliveIds.size).toBe(2);
        expect(getDronePriority(f.context)).toBe(0);
        const lookups = f.lookups.length; f.destroy(a.id); expect(f.lookups.length).toBe(lookups);
        expect(getDroneProductionState(f.game, f.player.name).built).toBe(2);
        expect(getDroneProductionState(f.game, f.player.name).aliveIds.size).toBe(1);
    });
    test("same-ID transport/limbo respawns never increase production", () => {
        const f = fixture(), drone = f.spawnDrone();
        observeDroneProductionEvent(f.game, f.player.name, { type: ApiEventType.ObjectUnspawn, target: drone.id });
        observeDroneProductionEvent(f.game, f.player.name, { type: ApiEventType.ObjectSpawn, target: drone.id });
        expect(getDroneProductionState(f.game, f.player.name).built).toBe(1);
    });
    test("capturing a previously produced foreign drone consumes the alive cap but is not production", () => {
        const f = fixture(), drone = f.add("DRON", "enemy", 80); drone.owner = "bot";
        observeDroneProductionEvent(f.game, f.player.name, { type: ApiEventType.ObjectOwnerChange, target: drone.id, newOwnerName: "bot", prevOwnerName: "enemy" });
        observeDroneProductionEvent(f.game, f.player.name, { type: ApiEventType.ObjectSpawn, target: drone.id });
        expect(getDroneProductionState(f.game, f.player.name).built).toBe(0);
        expect(getDroneProductionState(f.game, f.player.name).aliveIds.size).toBe(1);
        drone.owner = "enemy";
        observeDroneProductionEvent(f.game, f.player.name, { type: ApiEventType.ObjectOwnerChange, target: drone.id, newOwnerName: "enemy" });
        expect(getDroneProductionState(f.game, f.player.name).aliveIds.size).toBe(0);
    });
    test("foreign or hidden spawns cannot create an own drone history", () => {
        const f = fixture(), drone = f.add("DRON", "enemy");
        Object.defineProperty(drone, "rules", { get() { throw Error("unneeded foreign rules read"); } });
        observeDroneProductionEvent(f.game, f.player.name, { type: ApiEventType.ObjectSpawn, target: drone.id });
        f.hidden.add(drone.id); observeDroneProductionEvent(f.game, f.player.name, { type: ApiEventType.ObjectSpawn, target: drone.id });
        expect(getDroneProductionState(f.game, f.player.name).built).toBe(0);
    });
    test.each([1, 2])("enemy-miner evidence for produced count%i expires at 1800 simulation ticks", built => {
        const f = fixture(); for (let i = 0; i < built; i++) f.destroy(f.spawnDrone().id);
        const miner = f.add("HARV", "enemy", 80); expect(getDronePriority(f.context)).toBe(60); f.objects.delete(miner.id);
        f.at(1899); expect(getDronePriority(f.context)).toBe(60);
        f.at(1900); expect(getDronePriority(f.context)).toBe(0);
    });
    test("the restored first drone112 precedes new income110, while AA115 remains first", () => {
        const f = fixture(1, 0); f.produce();
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "DRON", ObjectType.Vehicle, 1);
        const funded = fixture(3, 0); funded.produce();
        expect(funded.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "DRON", ObjectType.Vehicle, 1);
        const aa = fixture(1, 0); aa.add("ORCA", "enemy", 100, 0, ObjectType.Aircraft); aa.produce();
        expect(aa.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HTK", ObjectType.Vehicle, 1);
    });
    test.each([1, 2])("%i income miners still fund the existing visible-armor counter before the optional first drone", miners => {
        const f = fixture(miners, 0); f.at(4500); f.add("MTNK", "enemy", 48); f.produce();
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HTNK", ObjectType.Vehicle, 1);
    });
    test.each([QueueStatus.Active, QueueStatus.OnHold])("restored drone priority preserves an existing paid miner in status%i", status => {
        const f = fixture(3, 0), miner = f.vehicles.find(option => option.name === "HARV")!;
        Object.assign(f.queues.get(QueueType.Vehicles)!, { status, items: [{ rules: miner, quantity: 1 }] });
        f.produce(); expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
        expect(f.actions.queueForProduction).not.toHaveBeenCalled();
    });
    test.each(["normal", "eco-only"])("%s produces no drone request", mode => {
        const f = fixture(1, 0), previous = BRUTAL_PARAMS.economy.ecoOnly;
        if (mode === "normal") f.context.difficulty = "normal"; else BRUTAL_PARAMS.economy.ecoOnly = 1;
        try { expect(getDronePriority(f.context)).toBe(0); f.produce(); } finally { BRUTAL_PARAMS.economy.ecoOnly = previous; }
        expect(f.actions.queueForProduction.mock.calls.every(call => call[1] !== "DRON")).toBe(true);
    });
    test("a persistent raid exists before delivery and wins ownership before generic combat grabs", () => {
        const f = fixture(1, 0); new DroneRaidMissionFactory().maybeCreateMissions(f.context, f.controller, () => {});
        class Grabber extends Mission { _onAiUpdate() { return grabCombatants(new Vector2(), 100); } getPriority() { return 200; } getGlobalDebugText() { return undefined; } }
        const grabber = new Grabber("generic-grab", () => {}); f.controller.addMission(grabber);
        const drone = f.spawnDrone(); f.controller.onAiUpdate(f.context);
        const raid = f.controller.getMissions().find(mission => mission instanceof DroneRaidMission)!;
        expect(raid.getUnitIds()).toEqual([drone.id]); expect(grabber.getUnitIds()).not.toContain(drone.id);
        expect(f.controller.getRequestedUnitTypes().has("DRON")).toBe(false);
        expect((raid as DroneRaidMission).getState()).toMatchObject({ dronesBuilt: 1, dronesAlive: 1 });
    });
});

class MainForce extends Mission {
    constructor() { super("early-main", () => {}); }
    _onAiUpdate() { return noop(); }
    getPriority() { return 1; }
    getGlobalDebugText() { return undefined; }
    getAttackArea() { return new Vector2(70, 0); }
}
function earlyFixture(count = 5) {
    const f = fixture(0, 0, "Americans"), main = new MainForce(), factory = new HarassmentMissionFactory();
    for (let i = 0; i < count; i++) main.addUnit(f.add("MTNK", "bot", 40).id);
    f.controller.addMission(main); const miner = f.add("HARV", "enemy", 80, 30);
    return { ...f, main, factory, miner,
        launch(at = 100) { f.at(at); factory.maybeCreateMissions(f.context, f.controller, () => {}, [main]); },
        raids: () => f.controller.getMissions().filter(mission => mission.isActive() && mission instanceof HarassmentMission) as HarassmentMission[] };
}

describe("two-tank early miner detachment without changing the three-tank rule", () => {
    test.each([4, 5])("%i main core tanks leave the required three after detachment", count => {
        const f = earlyFixture(count); f.launch();
        expect(f.raids()).toHaveLength(count === 5 ? 1 : 0);
        if (count === 5) { f.controller.onAiUpdate(f.context); expect(f.main.getUnitIds()).toHaveLength(3); expect(f.raids()[0].getUnitIds()).toHaveLength(2); }
        expect(f.controller.getRequestedUnitTypes().size).toBe(0);
    });
    test.each(["deadline", "pressure", "no-target", "armed-building", "two-guards", "ongoing"])("early rule rejects %s", reason => {
        const f = earlyFixture();
        if (reason === "pressure") f.add("HTNK", "enemy", 10);
        if (reason === "no-target") f.objects.delete(f.miner.id);
        if (reason === "armed-building") { const tower = f.add("GAPILL", "enemy", 95, 30, ObjectType.Building); tower.rules.primary = "Vulcan"; }
        if (reason === "two-guards") { f.add("HTNK", "enemy", 80, 31); f.add("HTNK", "enemy", 80, 32); }
        if (reason === "ongoing") f.controller.addMission(new HarassmentMission("existing", [], f.miner.id, new Vector2(), new Vector2(80, 30), 100, () => {}));
        f.launch(reason === "deadline" ? 9000 : 100);
        expect(f.raids().length).toBe(reason === "ongoing" ? 1 : 0); expect(f.main.getUnitIds()).toHaveLength(5);
    });
    test("captured former members cannot count toward the three own cores retained at home", () => {
        const f = earlyFixture(), captured = f.main.getUnitIds().slice(-2);
        for (const id of captured) { const tank = f.objects.get(id)!; tank.owner = "enemy"; tank.tile.rx = 100; }
        f.launch();
        expect(f.raids()).toHaveLength(0);
        expect(f.main.getUnits(f.game).filter(unit => unit.owner === "bot")).toHaveLength(3);
    });
    test("one guard is allowed, and the closest visible isolated miner fixes the objective", () => {
        const f = earlyFixture(), nearer = f.add("HARV", "enemy", 60, 30);
        f.add("HTNK", "enemy", 60, 31);
        expect(selectEarlyRaidTarget(f.context, new Vector2(40, 0))?.id).toBe(nearer.id);
        f.launch(); expect((f.raids()[0] as any).targetId).toBe(nearer.id);
    });
    test("an early miner raid does not donate tanks into its own existing main-force convergence condition", () => {
        const f = earlyFixture(); f.miner.tile = { rx: 70, ry: 0 };
        f.launch();
        expect(f.raids()).toHaveLength(0);
        expect(f.main.getUnitIds()).toHaveLength(5);
        expect(f.actions.orderUnits).not.toHaveBeenCalled();
        expect(f.controller.getRequestedUnitTypes().size).toBe(0);
    });
    test.each([RAID_TARGET_SEPARATION - 1, RAID_TARGET_SEPARATION])("early detachment uses the unchanged main-target separation boundary: %i", gap => {
        const f = earlyFixture(); f.miner.tile = { rx: 70 + gap, ry: 0 }; f.launch();
        expect(f.raids()).toHaveLength(gap === RAID_TARGET_SEPARATION ? 1 : 0);
        expect(f.main.getUnitIds()).toHaveLength(gap === RAID_TARGET_SEPARATION ? 3 : 5);
    });
    test.each([1799, 1800])("a second early raid observes cooldown %i", delta => {
        const f = earlyFixture(); f.launch(); f.controller.onAiUpdate(f.context);
        f.raids()[0].endMission("test-complete"); f.at(102); f.controller.onAiUpdate(f.context);
        f.launch(100 + delta); expect(f.raids()).toHaveLength(delta === 1800 ? 1 : 0);
    });
    test("normal keeps the historical no-detachment path", () => {
        const f = earlyFixture(); f.context.difficulty = "normal"; f.launch(); expect(f.raids()).toHaveLength(0);
    });
});

import { describe, expect, mock, test } from "bun:test";
import { BuildStatus } from "../../game/gameobject/Building";
import { ProductionQueue } from "../../game/player/production/ProductionQueue";
import { ProductionTrait } from "../../game/trait/ProductionTrait";
import { NotifyTick } from "../../game/trait/interface/NotifyTick";
import { ObjectType, QueueStatus, QueueType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { getEconomyBuildingPriority } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/economyPlan";
import { BaseBuildingMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseBuildingMission";
import { QueueController, QUEUES } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController";
import { planRefinery } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/resourceCollectionBuilding";
import { getRefineryEconomics, getRefineryEconomyState, noteMinerRefineryRequest, observeRefineryEconomy,
    planMinerRefinery, recordRefineryOrder, sellDuplicateRefinery } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/refineryEconomy";

function fixture(miners = 2, refineries = 1) {
    let tick = 100, nextId = 1;
    const player: any = { name: "bot", startLocation: new Vector2(), country: { name: "Russians" }, credits: 2000,
        power: { total: 200, drain: 0 }, isAi: false };
    const rules: any = { name: "NAREFN", refinery: true, freeUnit: "HARV", cost: 2000, adjacent: 100, type: ObjectType.Building };
    const units: any[] = [], enemies: any[] = [];
    function own(name: string, rx: number, extra = {}) {
        const building = !["HARV", "HTNK"].includes(name);
        const object = { id: nextId++, name, owner: player.name, tile: { rx, ry: 0 }, foundation: { width: 1, height: 1 },
            buildStatus: BuildStatus.Ready, hitPoints: 1000, maxHitPoints: 1000,
            rules: { name, type: building ? ObjectType.Building : ObjectType.Vehicle, baseNormal: building,
                harvester: name === "HARV", refinery: name === "NAREFN", weaponsFactory: name === "NAWEAP", ...extra } };
        units.push(object); return object;
    }
    own("NACNST", 0, { constructionYard: true }); own("NAWEAP", 0);
    for (let i = 0; i < refineries; i++) own("NAREFN", 5 + i * 20);
    for (let i = 0; i < miners; i++) own("HARV", 10);
    const resources = [5, 25, 45].map(rx => ({ tile: { rx, ry: 0 }, ore: 800, gems: 0, spawnsOre: false }));
    const candidates = [{ id: "24_0", rx: 24, ry: 0 }, { id: "4_0", rx: 4, ry: 0 }, { id: "44_0", rx: 44, ry: 0 }];
    const legal = new Set(candidates.map(tile => tile.id));
    const queues = new Map(QUEUES.map(type => [type,
        { type, status: QueueStatus.Idle, items: [] as any[], size: 0 }]));
    const actions = { sellBuilding: mock((_id: number) => {}), queueForProduction: mock(() => {}), unqueueFromProduction: mock(() => {}),
        pauseProduction: mock(() => {}), resumeProduction: mock(() => {}), toggleRepairWrench: mock(() => {}), placeBuilding: mock(() => {}) };
    const game: any = { getCurrentTick: () => tick, getPlayerData: () => player,
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "self" ? units : enemies).filter(unit => predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => [...units, ...enemies].find(unit => unit.id === id),
        getGameObjectData: (id: number) => game.getUnitData(id), getGeneralRules: () => ({ refundPercent: 0.5 }),
        rulesApi: { vehicleRules: new Map([["HARV", { name: "HARV", harvester: true, cost: 1400 }]]) },
        getBuildingPlacementData: () => ({ foundation: { width: 1, height: 1 } }),
        canPlaceBuilding: (_player: string, _name: string, tile: any) => legal.has(`${tile.rx}_${tile.ry}`),
        mapApi: { getAllTilesResourceData: () => resources, isVisibleTile: () => true,
            getResourceCreditValues: () => ({ ore: 10, gems: 20 }), getStartingLocations: () => [player.startLocation, new Vector2(200, 0)],
            getTilesInRect: (rect: any) => candidates.filter(tile => tile.rx >= rect.x && tile.rx < rect.x + rect.width && tile.ry >= rect.y && tile.ry < rect.y + rect.height) },
    };
    const context: any = { difficulty: "brutal", game, player: { name: player.name, actions, production: {
        getQueueData: (queue: QueueType) => queues.get(queue)!, getAvailableObjects: (queue?: QueueType) => queue === undefined || queue === QueueType.Structures ? [rules] : [],
    } }, matchAwareness: { getThreatCache: () => null } };
    return { game, player, context, rules, units, enemies, resources, candidates, legal, queues, actions, own,
        at(value: number) { tick = value; }, priority(committed = false) { return getEconomyBuildingPriority(game, player, rules, committed, context); },
        subsidy() { return planMinerRefinery(context, player, rules, planRefinery(game, player, rules)); } };
}

function recoveryFundingFixture(status = QueueStatus.Idle) {
    const f = fixture(2); f.player.credits = 859;
    f.units.find(unit => unit.name === "NAREFN")!.tile.rx = -20;
    Object.assign(f.queues.get(QueueType.Structures)!, { status: QueueStatus.Active, items: [{ rules: f.rules, quantity: 1 }] });
    const tank = { name: "HTNK", type: ObjectType.Vehicle, cost: 900 };
    const miner = { name: "HARV", type: ObjectType.Vehicle, cost: 1400, harvester: true };
    const aa = { name: "HTK", type: ObjectType.Vehicle, cost: 500 };
    const available = f.context.player.production.getAvailableObjects;
    f.context.player.production.getAvailableObjects = (type: QueueType) => type === QueueType.Vehicles ? [tank, miner, aa] : available(type);
    Object.assign(f.queues.get(QueueType.Vehicles)!, { status, items: status === QueueStatus.Idle ? [] : [{ rules: tank, quantity: 1 }] });
    const requests = new Map<string, any>([["NAREFN", { priority: 50, specificLocation: new Vector2(4, 0) }], ["HTNK", { priority: 85, specificLocation: null }]]);
    const controller = new QueueController();
    return { ...f, requests, run: () => controller.onAiUpdate(f.context, null, requests, () => {}) };
}

/** Native debit/progress, not a mock that treats a production request as a delivered unit. */
function nativeFundingFixture(priority: number, active: boolean, engineerStatus?: QueueStatus) {
    const f = fixture(5); Object.assign(f.rules, { owner: [], buildTimeMultiplier: 1 });
    const vehicle: any = { name: priority === 115 ? "HTK" : "HTNK", type: ObjectType.Vehicle,
        cost: priority === 115 ? 500 : 900, owner: [], buildTimeMultiplier: 1 };
    const engineer: any = engineerStatus === undefined ? undefined : { name: "SENGINEER", type: ObjectType.Infantry,
        cost: 500, owner: [], buildTimeMultiplier: 1 };
    const queues = new Map(QUEUES.map(type => [type, new ProductionQueue(type, 1, 1)]));
    const options = [f.rules, vehicle, ...(engineer ? [engineer] : [])];
    const actions = { ...f.actions,
        queueForProduction: mock((type: QueueType, name: string) => {
            const rules = options.find(rules => rules.name === name)!;
            queues.get(type)!.push(rules, 1, rules.cost);
        }),
        pauseProduction: mock((type: QueueType) => { queues.get(type)!.status = QueueStatus.OnHold; }),
        resumeProduction: mock((type: QueueType) => { queues.get(type)!.status = QueueStatus.Active; }),
    };
    f.context.player.actions = actions;
    f.context.player.production.getQueueData = (type: QueueType) => ({ type, status: queues.get(type)!.status, items: queues.get(type)!.getAll() });
    f.context.player.production.getAvailableObjects = (type: QueueType) => type === QueueType.Vehicles ? [vehicle] : type === QueueType.Structures ? [f.rules]
        : type === QueueType.Infantry && engineer ? [engineer] : [];
    f.player.production = { buildSpeedModifier: 1, getAllQueues: () => [...queues.values()],
        getFactoryTypeForQueueType: (type: QueueType) => type, getFactoryCount: () => 1 };
    const rules = { general: { buildSpeed: 1, multipleFactory: 1, wallBuildSpeedCoefficient: 1 },
        buildingRules: new Map([[f.rules.name, f.rules]]), infantryRules: new Map(engineer ? [[engineer.name, engineer]] : []), vehicleRules: new Map([[vehicle.name, vehicle]]), aircraftRules: new Map() };
    const native: NotifyTick = new ProductionTrait(rules, { value: false });
    if (active) queues.get(QueueType.Structures)!.push(f.rules, 1, f.rules.cost);
    if (engineer && engineerStatus !== QueueStatus.Idle) {
        queues.get(QueueType.Infantry)!.push(engineer, 1, engineer.cost);
        queues.get(QueueType.Infantry)!.status = engineerStatus!;
    }
    const controller = new QueueController();
    const requests = (priority: number) => new Map([[f.rules.name, { priority: 50, specificLocation: new Vector2(24, 0) }],
        [vehicle.name, { priority, specificLocation: null }], ...(engineer ? [[engineer.name, { priority: 100, specificLocation: null }] as const] : [])]);
    return { ...f, actions, vehicle, engineer, nativeQueues: queues,
        run(tick: number, responsePriority = priority) {
            f.at(tick); controller.onAiUpdate(f.context, null, requests(responsePriority), () => {});
        },
        spend(tick: number, credits = 1) {
            f.player.credits = credits;
            f.at(tick); controller.onAiUpdate(f.context, null, requests(priority), () => {});
            native[NotifyTick.onTick]({ getCombatants: () => [f.player], events: { dispatch() {} } });
        },
    };
}

function nativeBasicFundingFixture(footName = "E2", vehicleKind: "counter" | "miner" = "counter", status = QueueStatus.Idle) {
    const f = fixture(2); Object.assign(f.rules, { owner: [], buildTimeMultiplier: 1 });
    const foot: any = { name: footName, type: ObjectType.Infantry, cost: 100, owner: [], buildTimeMultiplier: 1 };
    const vehicle: any = { name: vehicleKind === "miner" ? "HARV" : "HTNK", type: ObjectType.Vehicle,
        cost: vehicleKind === "miner" ? 1400 : 900, harvester: vehicleKind === "miner", owner: [], buildTimeMultiplier: 1 };
    const nativeQueues = new Map(QUEUES.map(type => [type, new ProductionQueue(type, 1, 1)]));
    const options = [f.rules, foot, vehicle];
    const actions = { ...f.actions,
        queueForProduction: mock((type: QueueType, name: string) => {
            const rules = options.find(rule => rule.name === name)!; nativeQueues.get(type)!.push(rules, 1, rules.cost);
        }),
        pauseProduction: mock((type: QueueType) => { nativeQueues.get(type)!.status = QueueStatus.OnHold; }),
        resumeProduction: mock((type: QueueType) => { nativeQueues.get(type)!.status = QueueStatus.Active; }),
    };
    f.context.player.actions = actions;
    f.context.player.production = {
        getQueueData: (type: QueueType) => ({ type, status: nativeQueues.get(type)!.status, items: nativeQueues.get(type)!.getAll() }),
        getAvailableObjects: (type: QueueType) => type === QueueType.Vehicles ? [vehicle] : type === QueueType.Infantry ? [foot]
            : type === QueueType.Structures && vehicleKind === "counter" ? [f.rules] : [],
    };
    f.player.production = { buildSpeedModifier: 1, getAllQueues: () => [...nativeQueues.values()],
        getFactoryTypeForQueueType: (type: QueueType) => type, getFactoryCount: () => 1 };
    const native: NotifyTick = new ProductionTrait({ general: { buildSpeed: 1, multipleFactory: 1, wallBuildSpeedCoefficient: 1 },
        buildingRules: new Map([[f.rules.name, f.rules]]), infantryRules: new Map([[foot.name, foot]]),
        vehicleRules: new Map([[vehicle.name, vehicle]]), aircraftRules: new Map() }, { value: false });
    const world = { getCombatants: () => [f.player], events: { dispatch() {} } };
    if (vehicleKind === "counter") nativeQueues.get(QueueType.Structures)!.push(f.rules, 1, f.rules.cost);
    if (status !== QueueStatus.Idle) {
        nativeQueues.get(QueueType.Infantry)!.push(foot, 1, foot.cost);
        f.player.credits = 20; native[NotifyTick.onTick](world); nativeQueues.get(QueueType.Infantry)!.status = status;
    }
    const controller = new QueueController();
    return { ...f, actions, nativeQueues, foot, vehicle,
        spend(tick: number, credits = 1, priority = vehicleKind === "miner" ? 110 : 100) {
            f.at(tick); f.player.credits = credits;
            controller.onAiUpdate(f.context, null, new Map<string, any>([
                [vehicle.name, { priority, specificLocation: null }], [foot.name, { priority: 95, specificLocation: null }],
                ...(vehicleKind === "counter" ? [[f.rules.name, { priority: 50, specificLocation: new Vector2(24, 0) }] as const] : []),
            ]), () => {});
            native[NotifyTick.onTick](world);
        },
    };
}

function subsidyFixture() {
    const f = fixture(2);
    f.resources.splice(1); // no reachable unserved field
    f.legal.delete("24_0"); f.legal.delete("44_0");
    Object.assign(f.queues.get(QueueType.Vehicles)!, { status: QueueStatus.Active, items: [{ rules: { name: "HTNK" }, quantity: 1 }] });
    return f;
}

describe("brutal refinery investment", () => {
    test("first refinery retains priority fifty", () => { expect(fixture(0, 0).priority()).toBe(50); });
    test("unpressured second refinery uses factory, reachability and three miners or cash 1500", () => {
        const f = fixture(); f.player.credits = 1499; expect(f.priority()).toBe(0);
        f.player.credits = 1500; f.at(102); expect(f.priority()).toBe(50);
        f.player.credits = 0; f.own("HARV", 10); f.at(104); expect(f.priority()).toBe(50);
        f.units.splice(f.units.findIndex(unit => unit.name === "NAWEAP"), 1); f.at(106); expect(f.priority()).toBe(0);
        expect(f.priority(true)).toBe(50);
        const blocked = fixture(3); blocked.legal.clear(); expect(blocked.priority()).toBe(0);
    });
    test("two miners can incrementally fund a reachable rich second field only in the quiet window", () => {
        const f = fixture(2); f.player.credits = 1; f.at(2700);
        expect(f.priority()).toBe(50);
        const plan: any = new BaseBuildingMission(QueueType.Structures, () => {})._onAiUpdate(f.context);
        expect(plan).toMatchObject({ type: "buildStructureAtLocation", rulesName: "NAREFN", rx: 24, ry: 0, priority: 50 });
        new QueueController().onAiUpdate(f.context, null, new Map([[f.rules.name, {
            priority: plan.priority, specificLocation: new Vector2(plan.rx, plan.ry),
        }]]), () => {});
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Structures, f.rules.name, ObjectType.Building, 1);
    });
    test.each(["before", "one-miner", "cash", "small-field", "contact", "pressure", "hidden"])("quiet two-miner investment still rejects %s", condition => {
        const f = fixture(condition === "one-miner" ? 1 : 2); f.player.credits = condition === "cash" ? 0 : 1;
        f.at(condition === "before" ? 2699 : 2700);
        if (condition === "small-field") f.resources[1].ore = 599;
        if (condition === "contact" || condition === "pressure") f.enemies.push({ id: 999, tile: { rx: condition === "contact" ? 60 : 22, ry: 0 },
            rules: { name: "MTNK", type: ObjectType.Vehicle, isSelectableCombatant: true } });
        if (condition === "hidden") {
            f.resources.splice(2); f.game.mapApi.isVisibleTile = (tile: any) => tile.rx !== 25;
            Object.defineProperty(f.resources[1], "ore", { get() { throw Error("quiet investment cannot inspect unseen income"); } });
        }
        expect(f.priority()).toBe(0);
    });
    test("an unserved sole refinery can repair income at a reachable known field without the miner-cap cash deadlock", () => {
        for (const served of [false, true]) {
            const f = fixture(2); f.player.credits = 859;
            if (!served) f.units.find(unit => unit.name === "NAREFN")!.tile.rx = -20;
            expect(f.priority()).toBe(served ? 0 : 50);
        }
        const f = fixture(2); f.player.credits = 859; f.units.find(unit => unit.name === "NAREFN")!.tile.rx = -20;
        f.legal.clear(); expect(f.priority()).toBe(0);
        f.legal.add("4_0"); f.enemies.push({ id: 999, tile: { rx: 22, ry: 0 }, rules: { isSelectableCombatant: true } });
        f.at(102); expect(f.priority()).toBe(0);
    });
    test("pressure keeps the old core/cash/intruder conditions", () => {
        const f = fixture(2);
        f.enemies.push({ id: 999, tile: { rx: 22, ry: 0 }, rules: { isSelectableCombatant: true, type: ObjectType.Vehicle } });
        f.player.credits = 500; expect(f.priority()).toBe(0);
        for (let i = 0; i < 4; i++) f.own("HTNK", 0);
        f.at(102); expect(f.priority()).toBe(50);
        for (let i = 0; i < 2; i++) f.enemies.push({ id: 998 - i, tile: { rx: 22, ry: 0 }, rules: { isSelectableCombatant: true } });
        f.at(104); expect(f.priority()).toBe(0); expect(f.priority(true)).toBe(50);
    });
    test("third and later refineries require reachable ore, cash 1000, clear base and max six", () => {
        const f = fixture(2, 2); f.player.credits = 999; expect(f.priority()).toBe(0);
        f.player.credits = 1000; f.at(102); expect(f.priority()).toBe(40);
        f.enemies.push({ id: 999, tile: { rx: 22, ry: 0 }, rules: { isSelectableCombatant: true } });
        f.at(104); expect(f.priority()).toBe(0);
        f.enemies.length = 0; f.legal.clear(); f.at(106); expect(f.priority()).toBe(0);
        const capped = fixture(2, 6); expect(capped.priority()).toBe(0);
    });
    test("E7's quiet enemy window lowers only the extra-refinery cash floor to 600", () => {
        const f = fixture(2, 2); f.at(5400); f.player.credits = 599;
        expect(f.priority()).toBe(0);
        f.player.credits = 600; f.at(5402); expect(f.priority()).toBe(40);
        f.enemies.push({ id: 999, tile: { rx: 60, ry: 0 }, rules: { isSelectableCombatant: true } });
        f.at(5404); expect(f.priority()).toBe(0);
        f.enemies.length = 0; f.at(8104); expect(f.priority()).toBe(40);
    });
    test("one refinery request reuses its E3 plan for priority and placement", () => {
        const f = fixture(3);
        f.game.canPlaceBuilding = mock(f.game.canPlaceBuilding);
        f.game.getBuildingPlacementData = mock(f.game.getBuildingPlacementData);
        expect(new BaseBuildingMission(QueueType.Structures, () => {})._onAiUpdate(f.context)).toMatchObject({
            type: "buildStructureAtLocation", rulesName: "NAREFN", rx: 24, ry: 0,
        });
        expect(f.game.canPlaceBuilding).toHaveBeenCalledTimes(1);
        expect(f.game.getBuildingPlacementData).toHaveBeenCalledTimes(2);
    });
    test("a legal unpressured second refinery can begin paid incremental construction at its specified cash gate", () => {
        const f = fixture(2); f.player.credits = 1500;
        const mission = new BaseBuildingMission(QueueType.Structures, () => {}), plan: any = mission._onAiUpdate(f.context);
        expect(plan).toMatchObject({ type: "buildStructureAtLocation", rulesName: "NAREFN", priority: 50 });
        const available = f.context.player.production.getAvailableObjects;
        f.context.player.production.getAvailableObjects = (type: QueueType) => type === QueueType.Vehicles
            ? [{ name: "HTNK", type: ObjectType.Vehicle, cost: 900 }] : available(type);
        new QueueController().onAiUpdate(f.context, null, new Map<string, any>([
            ["NAREFN", { priority: plan.priority, specificLocation: new Vector2(plan.rx, plan.ry) }],
            ["HTNK", { priority: 85, specificLocation: null }],
        ]), () => {});
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Structures, "NAREFN", ObjectType.Building, 1);
    });
    test.each(["expansion", "first", "normal"])("a paid %s refinery keeps the appropriate placement when its request expires", kind => {
        const f = fixture(3, kind === "first" ? 0 : 1); f.rules.soylent = 300;
        f.candidates.push({ id: "0_4", rx: 0, ry: 4 }); f.legal.add("0_4"); f.legal.delete("4_0");
        expect(f.game.canPlaceBuilding(f.player.name, f.rules.name, { rx: 24, ry: 0 })).toBe(true);
        expect(f.game.canPlaceBuilding(f.player.name, f.rules.name, { rx: 0, ry: 4 })).toBe(true);
        if (kind === "normal") f.context.difficulty = "normal";
        const controller = new QueueController(), requests = new Map([["NAREFN", { priority: 50, specificLocation: new Vector2(24, 0) }]]);
        controller.onAiUpdate(f.context, null, requests, () => {});
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Structures, "NAREFN", ObjectType.Building, 1);
        Object.assign(f.queues.get(QueueType.Structures)!, { status: QueueStatus.Ready, items: [{ rules: f.rules, quantity: 1 }] });
        f.resources.length = 0; f.at(190);
        controller.onAiUpdate(f.context, null, new Map(), () => {});
        expect(f.actions.placeBuilding).toHaveBeenCalledWith("NAREFN", kind === "expansion" ? 24 : 0, kind === "expansion" ? 0 : 4);
    });
    test("a blocked paid ordinary expansion cannot be relocated into an already served home field", () => {
        const f = fixture(3); f.rules.soylent = 300;
        f.candidates.push({ id: "0_4", rx: 0, ry: 4 }); f.legal.add("0_4"); f.legal.delete("4_0");
        const controller = new QueueController();
        controller.onAiUpdate(f.context, null, new Map([["NAREFN", { priority: 50, specificLocation: new Vector2(24, 0) }]]), () => {});
        Object.assign(f.queues.get(QueueType.Structures)!, { status: QueueStatus.Ready, items: [{ rules: f.rules, quantity: 1 }] });
        f.legal.delete("24_0"); f.at(190);
        controller.onAiUpdate(f.context, null, new Map(), () => {});
        expect(f.actions.placeBuilding).not.toHaveBeenCalled();
        expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
    });
    test("a completed or cancelled expansion cannot leak its saved site into a later unmarked refinery", () => {
        const f = fixture(3); f.rules.soylent = 300;
        f.candidates.push({ id: "0_4", rx: 0, ry: 4 }); f.legal.add("0_4"); f.legal.delete("4_0");
        const controller = new QueueController();
        controller.onAiUpdate(f.context, null, new Map([["NAREFN", { priority: 50, specificLocation: new Vector2(24, 0) }]]), () => {});
        f.at(102); controller.onAiUpdate(f.context, null, new Map(), () => {});
        Object.assign(f.queues.get(QueueType.Structures)!, { status: QueueStatus.Ready, items: [{ rules: f.rules, quantity: 1 }] });
        f.at(104); controller.onAiUpdate(f.context, null, new Map(), () => {});
        expect(f.actions.placeBuilding).toHaveBeenCalledWith("NAREFN", 0, 4);
    });
    test("a quiet paid expansion first completes the paid third miner, then resumes its real supplied-miner construction", () => {
        const f = fixture(2); f.at(2700); f.player.credits = 100; f.resources[0].ore = 1200;
        Object.assign(f.queues.get(QueueType.Structures)!, { status: QueueStatus.Active, items: [{ rules: f.rules, quantity: 1 }] });
        const miner = { name: "HARV", type: ObjectType.Vehicle, cost: 1400, harvester: true };
        const available = f.context.player.production.getAvailableObjects;
        f.context.player.production.getAvailableObjects = (queue: QueueType) => queue === QueueType.Vehicles ? [miner] : available(queue);
        Object.assign(f.queues.get(QueueType.Vehicles)!, { status: QueueStatus.Active, items: [{ rules: miner, quantity: 1 }] });
        const controller = new QueueController(), requests = new Map([[f.rules.name, { priority: 50, specificLocation: new Vector2(24, 0) }]]);
        controller.onAiUpdate(f.context, null, requests, () => {});
        expect(f.actions.pauseProduction).toHaveBeenCalledWith(QueueType.Structures);
        expect(f.actions.pauseProduction).not.toHaveBeenCalledWith(QueueType.Vehicles);
        expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
        f.queues.get(QueueType.Structures)!.status = QueueStatus.OnHold;
        f.at(2702); controller.onAiUpdate(f.context, null, requests, () => {});
        expect(f.actions.resumeProduction).not.toHaveBeenCalledWith(QueueType.Structures);
        f.own("HARV", 10); f.player.credits = 100;
        f.at(2704); controller.onAiUpdate(f.context, null, new Map(), () => {});
        expect(f.actions.resumeProduction).toHaveBeenCalledWith(QueueType.Structures);
    });
    test.each(["pre-held", "cancelled"])("income funding does not resume an unrelated %s refinery", condition => {
        const f = fixture(2); f.at(2700); f.player.credits = 100; f.resources[0].ore = 1200;
        const miner = { name: "HARV", type: ObjectType.Vehicle, cost: 1400, harvester: true };
        const available = f.context.player.production.getAvailableObjects;
        f.context.player.production.getAvailableObjects = (queue: QueueType) => queue === QueueType.Vehicles ? [miner] : available(queue);
        Object.assign(f.queues.get(QueueType.Vehicles)!, { status: QueueStatus.Active, items: [{ rules: miner, quantity: 1 }] });
        Object.assign(f.queues.get(QueueType.Structures)!, { status: condition === "cancelled" ? QueueStatus.Active : QueueStatus.OnHold,
            items: [{ rules: f.rules, quantity: 1 }] });
        const controller = new QueueController();
        controller.onAiUpdate(f.context, null, new Map([[f.rules.name, { priority: 50, specificLocation: new Vector2(24, 0) }]]), () => {});
        if (condition === "cancelled") {
            Object.assign(f.queues.get(QueueType.Structures)!, { status: QueueStatus.Idle, items: [] });
            f.at(2702); controller.onAiUpdate(f.context, null, new Map(), () => {});
            Object.assign(f.queues.get(QueueType.Structures)!, { status: QueueStatus.OnHold, items: [{ rules: f.rules, quantity: 1 }] });
        }
        f.own("HARV", 10); f.at(2704);
        controller.onAiUpdate(f.context, null, new Map(), () => {});
        expect(f.actions.resumeProduction).not.toHaveBeenCalledWith(QueueType.Structures);
    });
    test.each(["first", "multiple", "unsupplied", "unserved", "poor", "pressure", "contact", "low-power", "funded", "normal"])("funded-miner priority preserves the existing %s building investment", condition => {
        const f = fixture(2, condition === "first" ? 0 : condition === "multiple" ? 2 : 1); f.at(2700); f.player.credits = condition === "funded" ? 1400 : 100;
        f.resources[0].ore = condition === "poor" ? 599 : 1200;
        if (condition === "unsupplied") f.rules.freeUnit = "DOG";
        if (condition === "unserved") f.units.find(unit => unit.name === "NAREFN")!.tile.rx = -20;
        if (condition === "pressure" || condition === "contact") f.enemies.push({ id: 999, tile: { rx: condition === "pressure" ? 22 : 60, ry: 0 },
            rules: { name: "MTNK", type: ObjectType.Vehicle, isSelectableCombatant: true } });
        if (condition === "low-power") f.player.power.isLowPower = true;
        if (condition === "normal") f.context.difficulty = "normal";
        const miner = { name: "HARV", type: ObjectType.Vehicle, cost: 1400, harvester: true };
        const available = f.context.player.production.getAvailableObjects;
        f.context.player.production.getAvailableObjects = (queue: QueueType) => queue === QueueType.Vehicles ? [miner] : available(queue);
        Object.assign(f.queues.get(QueueType.Structures)!, { status: QueueStatus.Active, items: [{ rules: f.rules, quantity: 1 }] });
        Object.assign(f.queues.get(QueueType.Vehicles)!, { status: QueueStatus.Active, items: [{ rules: miner, quantity: 1 }] });
        new QueueController().onAiUpdate(f.context, null, new Map([[f.rules.name, {
            priority: 50, specificLocation: new Vector2(24, 0),
        }]]), () => {});
        expect(f.actions.pauseProduction).not.toHaveBeenCalledWith(QueueType.Structures);
    });
    test.each([["E1", "counter"], ["E2", "counter"], ["E1", "miner"], ["E2", "miner"]] as const)(
        "new %s spending cannot drain the unfunded higher-tier %s vehicle", (name, kind) => {
            const f = nativeBasicFundingFixture(name, kind);
            for (let i = 0; i < 54; i++) f.spend(5400 + i * 2);
            expect(f.nativeQueues.get(QueueType.Vehicles)!.getFirst()!.creditsSpent).toBe(54);
            expect(f.nativeQueues.get(QueueType.Infantry)!.status).toBe(QueueStatus.Idle);
            expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
        });
    test.each([QueueStatus.Active, QueueStatus.OnHold])("an already paid basic infantry queue in status%i retains its original progress", status => {
        const f = nativeBasicFundingFixture("E2", "counter", status);
        const paid = f.nativeQueues.get(QueueType.Infantry)!.getFirst()!.creditsSpent; expect(paid).toBeGreaterThan(0);
        for (let i = 0; i < 54; i++) f.spend(5400 + i * 2);
        expect(f.nativeQueues.get(QueueType.Infantry)!.getFirst()!.creditsSpent).toBeGreaterThan(paid);
        expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
    });
    test.each(["ordinary", "funded", "normal"])("basic infantry retains its original start for the %s funding condition", condition => {
        const f = nativeBasicFundingFixture(); if (condition === "normal") f.context.difficulty = "normal";
        f.spend(5400, condition === "funded" ? f.vehicle.cost : 1, condition === "ordinary" ? 85 : 100);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Infantry, "E2", ObjectType.Infantry, 1);
        expect(f.nativeQueues.get(QueueType.Infantry)!.status).toBe(QueueStatus.Active);
    });
    test.each([85, 100, 115])("native funds reach the %i-priority vehicle before idle or active discretionary expansion", priority => {
        for (const active of [false, true]) {
            const f = nativeFundingFixture(priority, active);
            if (priority === 85) f.enemies.push({ id: 999, tile: { rx: 22, ry: 0 }, rules: { name: "MTNK", type: ObjectType.Vehicle, isSelectableCombatant: true } });
            for (let i = 0; i < 54; i++) f.spend(2700 + i * 2);
            expect(f.nativeQueues.get(QueueType.Vehicles)!.getFirst()!.creditsSpent).toBe(54);
            expect(f.nativeQueues.get(QueueType.Structures)!.getFirst()?.creditsSpent ?? 0).toBe(0);
            expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
            f.enemies.length = 0; f.player.credits = 1;
            f.run(priority === 85 && !active ? 5508 : 2810, 85);
            expect(f.nativeQueues.get(QueueType.Structures)!.status).toBe(QueueStatus.Active);
        }
    });
    test("visible core armor deficit reaches the existing native counter-funding path without a birth-point siege", () => {
        const f = nativeFundingFixture(85, true);
        f.enemies.push({ id: 999, tile: { rx: 80, ry: 0 }, rules: { name: "MTNK", type: ObjectType.Vehicle, isSelectableCombatant: true } });
        for (let i = 0; i < 54; i++) f.spend(5400 + i * 2);
        expect(f.nativeQueues.get(QueueType.Vehicles)!.getFirst()!.creditsSpent).toBe(54);
        expect(f.nativeQueues.get(QueueType.Structures)!.getFirst()!.creditsSpent).toBe(0);
    });
    test("a settled late-game army does not gain new opening-only precedence over native refinery funding", () => {
        const f = nativeFundingFixture(85, true);
        for (let i = 0; i < 4; i++) f.own("HTNK", 0);
        for (let i = 0; i < 5; i++) f.enemies.push({ id: 900 + i, tile: { rx: 80, ry: 0 },
            rules: { name: "MTNK", type: ObjectType.Vehicle, isSelectableCombatant: true } });
        for (let i = 0; i < 9; i++) f.enemies.push({ id: 950 + i, tile: { rx: 80, ry: 0 },
            rules: { name: "E1", type: ObjectType.Infantry, isSelectableCombatant: true } });
        for (let i = 0; i < 54; i++) f.spend(9990 + i * 2);
        expect(f.nativeQueues.get(QueueType.Structures)!.getFirst()!.creditsSpent).toBe(54);
        expect(f.nativeQueues.get(QueueType.Vehicles)!.getFirst()!.creditsSpent).toBe(0);
    });
    test.each(["quiet", "warning"])("ordinary 85-priority tanks do not take over native refinery funding during %s", condition => {
        const f = nativeFundingFixture(85, true);
        if (condition === "warning") {
            f.own("HTNK", 0); f.own("HTNK", 0);
            f.enemies.push({ id: 999, tile: { rx: 28, ry: 0 }, rules: { name: "MTNK", type: ObjectType.Vehicle, isSelectableCombatant: true } });
        }
        for (let i = 0; i < 54; i++) f.spend(2700 + i * 2);
        expect(f.nativeQueues.get(QueueType.Structures)!.getFirst()!.creditsSpent).toBe(54);
        expect(f.nativeQueues.get(QueueType.Vehicles)!.getFirst()!.creditsSpent).toBe(0);
    });
    test.each(["first", "unserved", "no-field", "no-miner", "funded", "low-power", "miner", "normal"])("vehicle funding preserves the existing %s refinery investment", condition => {
        const f = nativeFundingFixture(115, true); f.player.credits = 1;
        if (condition === "first") f.units.splice(f.units.findIndex(unit => unit.name === "NAREFN"), 1);
        if (condition === "unserved") f.units.find(unit => unit.name === "NAREFN")!.tile.rx = -20;
        if (condition === "no-field") f.resources.length = 0;
        if (condition === "no-miner") f.units.splice(f.units.findIndex(unit => unit.name === "HARV"), 5);
        if (condition === "funded") f.player.credits = f.vehicle.cost;
        if (condition === "low-power") f.player.power.isLowPower = true;
        if (condition === "miner") Object.assign(f.vehicle, { name: "HARV", cost: 1400, harvester: true });
        if (condition === "normal") {
            f.context.difficulty = "normal";
            f.game.mapApi.getAllTilesResourceData = () => { throw Error("normal funding cannot gain a resource scan"); };
        }
        f.run(2700, condition === "miner" ? 120 : 115);
        expect(f.actions.pauseProduction).not.toHaveBeenCalledWith(QueueType.Structures);
    });
    test.each([false, true])("native armor85 funding is protected at an attacked refinery with discretionary expansion active=%s", active => {
        const f = nativeFundingFixture(85, active); f.own("NAREFN", 25);
        f.enemies.push({ id: 999, tile: { rx: 30, ry: 0 }, rules: { name: "MTNK", type: ObjectType.Vehicle, isSelectableCombatant: true } });
        for (let i = 0; i < 54; i++) f.spend(5400 + i * 2);
        expect(f.nativeQueues.get(QueueType.Vehicles)!.getFirst()!.creditsSpent).toBe(54);
        expect(f.nativeQueues.get(QueueType.Structures)!.getFirst()?.creditsSpent ?? 0).toBe(0);
    });
    test("income recovery must not pause ordinary armor85 at a real attacked remote refinery", () => {
        const f = recoveryFundingFixture(QueueStatus.Active);
        f.units.find(unit => unit.name === "NAREFN")!.tile.rx = 95;
        f.enemies.push({ id: 999, tile: { rx: 100, ry: 0 }, rules: { name: "MTNK", type: ObjectType.Vehicle, isSelectableCombatant: true } });
        f.at(5400); f.run();
        expect(f.actions.pauseProduction).not.toHaveBeenCalledWith(QueueType.Vehicles);
    });
    test("owned-base attack does not remove the low-cash first-refinery start", () => {
        const f = fixture(0, 0); f.player.credits = 1; f.own("NAWEAP", 25); f.at(5400);
        f.enemies.push({ id: 999, tile: { rx: 30, ry: 0 }, rules: { name: "MTNK", type: ObjectType.Vehicle, isSelectableCombatant: true } });
        const available = f.context.player.production.getAvailableObjects;
        f.context.player.production.getAvailableObjects = (type: QueueType) => type === QueueType.Vehicles
            ? [{ name: "HTNK", type: ObjectType.Vehicle, cost: 900 }] : available(type);
        new QueueController().onAiUpdate(f.context, null, new Map<string, any>([
            ["NAREFN", { priority: 50, specificLocation: new Vector2(4, 0) }], ["HTNK", { priority: 100, specificLocation: null }],
        ]), () => {});
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Structures, "NAREFN", ObjectType.Building, 1);
    });
    test("a previously held refinery is not claimed by the new vehicle-funding pause", () => {
        const f = nativeFundingFixture(115, true); f.player.credits = 1;
        f.nativeQueues.get(QueueType.Structures)!.status = QueueStatus.OnHold;
        f.run(2700); f.run(2702, 85);
        expect(f.actions.pauseProduction).not.toHaveBeenCalledWith(QueueType.Structures);
        expect(f.actions.resumeProduction).not.toHaveBeenCalledWith(QueueType.Structures);
    });
    test("new capture spending yields the finite native cash stockpile to a real income-restoration refinery", () => {
        const f = nativeFundingFixture(85, true, QueueStatus.Idle); f.units.find(unit => unit.name === "NAREFN")!.tile.rx = -20;
        f.own("CAOILD", 80, { capturable: true, produceCashAmount: 20 }); f.player.credits = 200;
        for (let i = 0; i < 216; i++) f.spend(5400 + i * 2, f.player.credits);
        expect(f.nativeQueues.get(QueueType.Structures)!.getFirst()!.creditsSpent).toBe(200);
        expect(f.nativeQueues.get(QueueType.Infantry)!.status).toBe(QueueStatus.Idle);
        expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
        f.own("NAREFN", 4); f.run(6000);
        expect(f.nativeQueues.get(QueueType.Infantry)!.status).toBe(QueueStatus.Active);
    });
    test.each(["first-capture", "paid", "normal"])("income restoration preserves the existing %s engineer commitment", condition => {
        const f = nativeFundingFixture(85, true, condition === "paid" ? QueueStatus.Active : QueueStatus.Idle);
        f.units.find(unit => unit.name === "NAREFN")!.tile.rx = -20;
        if (condition !== "first-capture") f.own("CAOILD", 80, { capturable: true, produceCashAmount: 20 });
        if (condition === "normal") f.context.difficulty = "normal";
        f.player.credits = 200;
        for (let i = 0; i < 108; i++) f.spend(5400 + i * 2, f.player.credits);
        expect(f.nativeQueues.get(QueueType.Infantry)!.getFirst()!.creditsSpent).toBeGreaterThan(0);
        expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
    });
    test("an unfunded unserved sole-refinery recovery defers new ordinary tanks and pauses only their paid queue", () => {
        const idle = recoveryFundingFixture(); idle.run();
        expect(idle.actions.queueForProduction).not.toHaveBeenCalledWith(QueueType.Vehicles, "HTNK", ObjectType.Vehicle, 1);
        const active = recoveryFundingFixture(QueueStatus.Active); active.run();
        expect(active.actions.pauseProduction).toHaveBeenCalledWith(QueueType.Vehicles);
        expect(active.actions.unqueueFromProduction).not.toHaveBeenCalled();
        active.queues.get(QueueType.Vehicles)!.status = QueueStatus.OnHold; active.at(102); active.run();
        expect(active.actions.resumeProduction).not.toHaveBeenCalledWith(QueueType.Vehicles);
        active.queues.get(QueueType.Structures)!.items = []; active.queues.get(QueueType.Structures)!.status = QueueStatus.Idle;
        active.own("NAREFN", 4); active.requests.delete("NAREFN"); active.at(104); active.run();
        expect(active.actions.resumeProduction).toHaveBeenCalledWith(QueueType.Vehicles);
    });
    test.each(["served", "pressure", "air", "cash", "no-field", "normal"])("recovery funding preserves the existing %s production choice", condition => {
        const f = recoveryFundingFixture();
        if (condition === "served") f.units.find(unit => unit.name === "NAREFN")!.tile.rx = 5;
        if (condition === "pressure") f.enemies.push({ id: 999, tile: { rx: 22, ry: 0 }, rules: { type: ObjectType.Vehicle, isSelectableCombatant: true } });
        if (condition === "air") f.enemies.push({ id: 999, tile: { rx: 70, ry: 0 }, rules: { type: ObjectType.Aircraft, isSelectableCombatant: true } });
        if (condition === "cash") f.player.credits = f.rules.cost;
        if (condition === "no-field") f.resources.length = 0;
        if (condition === "normal") {
            f.context.difficulty = "normal";
            f.game.mapApi.getAllTilesResourceData = () => { throw Error("normal funding must not inspect fields"); };
        }
        f.run();
        const expected = condition === "air" ? "HTK" : condition === "served" ? "HARV" : "HTNK";
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, expected, ObjectType.Vehicle, 1);
    });
    test("the mission uses a subsidy landing site instead of E3's unreachable fallback", () => {
        const f = subsidyFixture();
        expect(f.priority()).toBe(40);
        expect(new BaseBuildingMission(QueueType.Structures, () => {})._onAiUpdate(f.context)).toMatchObject({
            type: "buildStructureAtLocation", rulesName: "NAREFN", priority: 40, rx: 4, ry: 0,
        });
    });
});

describe("paid subsidy refinery conditions and real lifecycle", () => {
    test("costs and sale return use the actual engine AI branch, public refund rule and fallback", () => {
        const f = subsidyFixture();
        expect(getRefineryEconomics(f.game, f.player, f.rules)).toMatchObject({ refineryCost: 2000, minerCost: 1400, refundPercent: 0.5, refund: 1000, worthwhile: true });
        f.game.getGeneralRules = () => ({ refundPercent: 0.25 });
        expect(getRefineryEconomics(f.game, f.player, f.rules).worthwhile).toBe(false);
        f.player.isAi = true;
        expect(getRefineryEconomics(f.game, f.player, f.rules)).toMatchObject({ refundPercent: 1, refund: 2000, worthwhile: true });
        f.player.isAi = false; f.game.getGeneralRules = () => ({});
        expect(getRefineryEconomics(f.game, f.player, f.rules).refund).toBe(1000);
        f.rules.soylent = 500;
        expect(getRefineryEconomics(f.game, f.player, f.rules).worthwhile).toBe(false);
    });
    test.each(["reachable", "full", "pressure", "building-busy", "vehicle-idle", "cost", "cooldown", "no-placement"])(
        "subsidy does not trigger when %s fails", condition => {
            const f = subsidyFixture();
            if (condition === "reachable") {
                f.resources.push({ tile: { rx: 25, ry: 0 }, ore: 800, gems: 0, spawnsOre: false }); f.legal.add("24_0");
            }
            if (condition === "full") { f.own("HARV", 10); f.own("HARV", 10); }
            if (condition === "pressure") f.enemies.push({ id: 999, tile: { rx: 22, ry: 0 }, rules: { isSelectableCombatant: true } });
            if (condition === "building-busy") f.queues.get(QueueType.Structures)!.items.push({ rules: { name: "NAPOWR" }, quantity: 1 });
            if (condition === "vehicle-idle") f.queues.get(QueueType.Vehicles)!.items.length = 0;
            if (condition === "cost") f.game.getGeneralRules = () => ({ refundPercent: 0.25 });
            if (condition === "cooldown") {
                const plan = f.subsidy()!;
                noteMinerRefineryRequest(f.game, f.player.name, f.rules.name, plan);
                recordRefineryOrder(f.game, f.player.name, f.rules.name, new Vector2(plan.location.rx, plan.location.ry));
                Object.assign(f.queues.get(QueueType.Structures)!, { status: QueueStatus.Active, items: [{ rules: f.rules, quantity: 1 }] });
                f.at(102); observeRefineryEconomy(f.context);
                f.queues.get(QueueType.Structures)!.items.length = 0; f.at(1001);
            }
            if (condition === "no-placement") f.legal.clear();
            expect(f.subsidy()).toBeUndefined();
        });
    test("subsidy selects the largest served capacity deficit and never a landing beyond nine", () => {
        const f = fixture(2, 2); f.resources.splice(2);
        f.candidates.push({ id: "20_0", rx: 20, ry: 0 }); f.legal.add("20_0");
        f.queues.get(QueueType.Vehicles)!.items.push({ rules: { name: "HTNK" }, quantity: 1 });
        expect(f.subsidy()?.patch.id).toBe("25_0");
        f.legal.clear(); f.legal.add("44_0");
        expect(f.subsidy()).toBeUndefined();
    });
    test("no factory satisfies the busy-vehicle alternative, but an unsupplied refinery cannot buy a miner", () => {
        const f = subsidyFixture();
        f.units.splice(f.units.findIndex(unit => unit.name === "NAWEAP"), 1);
        f.queues.get(QueueType.Vehicles)!.items.length = 0;
        expect(f.subsidy()).toBeDefined();
        f.rules.freeUnit = "DOG";
        expect(f.subsidy()).toBeUndefined();
    });
    test("request/order alone is not a queue start or placed refinery; cooldown begins with real active queue", () => {
        const f = subsidyFixture(), plan = f.subsidy()!;
        noteMinerRefineryRequest(f.game, f.player.name, f.rules.name, plan);
        recordRefineryOrder(f.game, f.player.name, f.rules.name, new Vector2(plan.location.rx, plan.location.ry));
        observeRefineryEconomy(f.context);
        expect(getRefineryEconomyState(f.game, f.player.name).lastMinerRefineryStart).toBe(-Infinity);
        expect(getRefineryEconomyState(f.game, f.player.name).refineries.size).toBe(1);
        Object.assign(f.queues.get(QueueType.Structures)!, { status: QueueStatus.Active, items: [{ rules: f.rules, quantity: 1 }] });
        f.at(102); observeRefineryEconomy(f.context);
        expect(getRefineryEconomyState(f.game, f.player.name).lastMinerRefineryStart).toBe(102);
        f.queues.get(QueueType.Structures)!.items.length = 0;
        f.at(1001); expect(f.subsidy()).toBeUndefined();
        f.at(1002); expect(f.subsidy()).toBeDefined();
    });
    test("a paid subsidy cannot fall back to an unrelated refinery site when its specific tile becomes blocked", () => {
        const f = subsidyFixture(), plan = f.subsidy()!;
        noteMinerRefineryRequest(f.game, f.player.name, f.rules.name, plan);
        recordRefineryOrder(f.game, f.player.name, f.rules.name, new Vector2(plan.location.rx, plan.location.ry));
        Object.assign(f.queues.get(QueueType.Structures)!, { status: QueueStatus.Active, items: [{ rules: f.rules, quantity: 1 }] });
        f.at(102); observeRefineryEconomy(f.context);
        f.queues.get(QueueType.Structures)!.status = QueueStatus.Ready;
        f.legal.clear(); f.legal.add("24_0"); f.at(104);
        const controller = new QueueController(), requests = new Map([[f.rules.name, { priority: 40, specificLocation: new Vector2(4, 0) }]]);
        for (let i = 0; i < 10; i++) {
            f.at(104 + i * 2); controller.onAiUpdate(f.context, null, requests, () => {});
        }
        expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
        f.at(124); controller.onAiUpdate(f.context, null, requests, () => {});
        expect(f.actions.unqueueFromProduction).toHaveBeenCalledWith(QueueType.Structures, "NAREFN", ObjectType.Building, 1);
        expect(f.actions.placeBuilding).not.toHaveBeenCalled();
    });
    test("an unmarked first refinery must keep E3's visible-patch replanning while production is active", () => {
        const f = fixture(0, 0);
        const initial = planRefinery(f.game, f.player, f.rules);
        expect(initial.location).toMatchObject({ rx: 4, ry: 0 });
        recordRefineryOrder(f.game, f.player.name, f.rules.name, new Vector2(initial.location!.rx, initial.location!.ry));
        Object.assign(f.queues.get(QueueType.Structures)!, { status: QueueStatus.Active, items: [{ rules: f.rules, quantity: 1 }] });
        f.at(102); observeRefineryEconomy(f.context);
        f.resources[0].ore = 0; f.resources[1].ore = 0; f.resources[1].gems = 400;
        f.at(190);
        expect(new BaseBuildingMission(QueueType.Structures, () => {})._onAiUpdate(f.context)).toMatchObject({ rx: 24, ry: 0 });
    });
    test("a non-refinery queue start cannot consume the subsidy cooldown", () => {
        const f = subsidyFixture(), plan = f.subsidy()!;
        noteMinerRefineryRequest(f.game, f.player.name, f.rules.name, plan);
        recordRefineryOrder(f.game, f.player.name, "NAPOWR", new Vector2(1, 0));
        observeRefineryEconomy(f.context);
        expect(getRefineryEconomyState(f.game, f.player.name).lastMinerRefineryStart).toBe(-Infinity);
    });
});

describe("same-field old refinery sales", () => {
    test("zero or one refinery needs no resource query and cannot be sold", () => {
        for (const count of [0, 1]) {
            const f = fixture(2, count); f.game.mapApi = undefined; f.at(150);
            expect(() => sellDuplicateRefinery(f.context)).not.toThrow();
            expect(f.actions.sellBuilding).not.toHaveBeenCalled();
        }
    });
    test("sells the oldest same-field refinery only after the newest has really become ready for over 150 ticks", () => {
        const f = subsidyFixture(); observeRefineryEconomy(f.context);
        const old = f.units.find(unit => unit.name === "NAREFN")!;
        f.at(200); const newest = f.own("NAREFN", 4); newest.buildStatus = BuildStatus.BuildUp;
        observeRefineryEconomy(f.context); f.at(390); sellDuplicateRefinery(f.context);
        expect(f.actions.sellBuilding).not.toHaveBeenCalled();
        newest.buildStatus = BuildStatus.Ready; f.at(421); observeRefineryEconomy(f.context);
        f.at(570); sellDuplicateRefinery(f.context); expect(f.actions.sellBuilding).not.toHaveBeenCalled();
        f.at(600); sellDuplicateRefinery(f.context); expect(f.actions.sellBuilding).toHaveBeenCalledWith(old.id);
    });
    test("old refinery miners within three, distinct fields and normal profile cannot be sold", () => {
        for (const reason of ["miner", "other-patch", "normal"]) {
            const f = subsidyFixture(); observeRefineryEconomy(f.context);
            f.at(200); f.own("NAREFN", reason === "other-patch" ? 25 : 4);
            if (reason === "other-patch") f.resources.push({ tile: { rx: 25, ry: 0 }, ore: 800, gems: 0, spawnsOre: false });
            if (reason === "miner") f.units.find(unit => unit.name === "HARV")!.tile.rx = 8;
            if (reason === "normal") f.context.difficulty = "normal";
            observeRefineryEconomy(f.context); f.at(570); sellDuplicateRefinery(f.context);
            expect(f.actions.sellBuilding).not.toHaveBeenCalled();
        }
    });
    test("a sale cannot leave fewer refineries than visible served fields", () => {
        const f = subsidyFixture(); observeRefineryEconomy(f.context);
        f.at(200); f.own("NAREFN", 9);
        f.resources.push({ tile: { rx: 15, ry: 0 }, ore: 800, gems: 0, spawnsOre: false });
        observeRefineryEconomy(f.context); f.at(570); sellDuplicateRefinery(f.context);
        expect(f.actions.sellBuilding).not.toHaveBeenCalled();
    });
    test("selling a nearest-field duplicate cannot remove another served field's sole coverage", () => {
        const f = fixture(0, 1), old = f.units.find(unit => unit.name === "NAREFN")!;
        old.tile.rx = 9;
        f.resources.splice(0, f.resources.length, ...[5, 17, 45].map(rx => ({ tile: { rx, ry: 0 }, ore: 800, gems: 0, spawnsOre: false })));
        f.own("NAREFN", 45); f.own("NAREFN", 46); observeRefineryEconomy(f.context);
        f.at(200); f.own("NAREFN", 4); observeRefineryEconomy(f.context);
        f.at(570); sellDuplicateRefinery(f.context);
        expect(f.actions.sellBuilding).not.toHaveBeenCalledWith(old.id);
        const soldId = f.actions.sellBuilding.mock.calls[0]?.[0];
        const remaining = f.units.filter(unit => unit.name === "NAREFN" && unit.id !== soldId);
        expect(f.resources.every(resource => remaining.some(refinery => Math.abs(refinery.tile.rx - resource.tile.rx) <= 9))).toBe(true);
    });
    test("actual build-down starts the 300-tick sale cooldown", () => {
        const f = subsidyFixture(); observeRefineryEconomy(f.context);
        f.at(200); f.own("NAREFN", 4); f.own("NAREFN", 3); observeRefineryEconomy(f.context);
        f.at(570); sellDuplicateRefinery(f.context);
        const old = f.units.find(unit => unit.id === f.actions.sellBuilding.mock.calls[0][0])!;
        old.buildStatus = BuildStatus.BuildDown; f.at(572); observeRefineryEconomy(f.context);
        f.units.splice(f.units.indexOf(old), 1); f.actions.sellBuilding.mockClear();
        f.at(870); sellDuplicateRefinery(f.context); expect(f.actions.sellBuilding).not.toHaveBeenCalled();
        f.at(900); sellDuplicateRefinery(f.context); expect(f.actions.sellBuilding).toHaveBeenCalledTimes(1);
    });
});

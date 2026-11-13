import { describe, expect, mock, test } from "bun:test";
import { ApiEventType, ObjectType, QueueStatus, QueueType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { Harvester, desiredMiners, patchCapacity } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/harvester";
import { QueueController, QUEUES } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController";
import { observeDroneProductionEvent } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/droneProduction";
import { getEconomyBuildingPriority } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/economyPlan";
import { getEconomyPressureLimits, isPressured, observePressureEvent, readPressure, setPressureWatchPost } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/pressure";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";
import { DefaultStrategy } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/defaultStrategy";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";

function fixture(miners = 3, core = 2, country = "Russians") {
    let tick = 100;
    let nextId = 1;
    const player: any = { name: "bot", startLocation: new Vector2(), country: { name: country },
        credits: 5000, power: { total: 200, drain: 0 }, isAi: true };
    const units: any[] = [], enemies: any[] = [];
    const minerName = country === "Russians" ? "HARV" : "CMIN";
    function own(name: string, rx = 0, ry = 0, extra = {}) {
        const rules = { name, type: ["HARV", "CMIN", "HTNK", "MTNK"].includes(name) ? ObjectType.Vehicle : ObjectType.Building,
            harvester: ["HARV", "CMIN"].includes(name), refinery: ["GAREFN", "NAREFN"].includes(name),
            weaponsFactory: ["GAWEAP", "NAWEAP"].includes(name), ...extra };
        const unit = { id: nextId++, owner: player.name, name, type: rules.type, rules,
            tile: { rx, ry }, foundation: { width: 1, height: 1 }, hitPoints: 1000, maxHitPoints: 1000, isIdle: true };
        units.push(unit);
        return unit;
    }
    own("NACNST", 0, 0, { constructionYard: true, baseNormal: true });
    own("NAREFN", 5); own("NAREFN", 25); own("NAWEAP");
    for (let i = 0; i < miners; i++) own(minerName, 5);
    for (let i = 0; i < core; i++) own(country === "Russians" ? "HTNK" : "MTNK");
    const resources = [5, 25].map(rx => ({ tile: { rx, ry: 0 }, ore: 800, gems: 0, spawnsOre: false }));
    const options = new Map(QUEUES.map(queue => [queue, [] as any[]]));
    options.set(QueueType.Vehicles, [
        { name: minerName, harvester: true, cost: 1400, type: ObjectType.Vehicle },
        { name: country === "Russians" ? "HTNK" : "MTNK", cost: 900, type: ObjectType.Vehicle },
        { name: "HTK", cost: 500, type: ObjectType.Vehicle },
    ]);
    const queues = new Map(QUEUES.map(type => [type, { type, status: QueueStatus.Idle, items: [] as any[], size: 0 }]));
    const actions = { queueForProduction: mock((_queue: QueueType, _name: string, _type: ObjectType, _quantity: number) => {}), unqueueFromProduction: mock(() => {}),
        pauseProduction: mock(() => {}), resumeProduction: mock(() => {}), toggleRepairWrench: mock(() => {}),
        orderUnits: mock(() => {}), sellBuilding: mock(() => {}) };
    const production: any = { getAvailableObjects: (queue?: QueueType) => queue === undefined ? [...options.values()].flat() : options.get(queue)!,
        getQueueData: (queue: QueueType) => queues.get(queue)! };
    const game: any = {
        getCurrentTick: () => tick, getPlayerData: () => player,
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "self" ? units : enemies).filter(unit => predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => [...units, ...enemies].find(unit => unit.id === id),
        getGameObjectData: (id: number) => game.getUnitData(id),
        getGeneralRules: () => ({ baseUnit: ["AMCV", "SMCV"] }),
        mapApi: { getAllTilesResourceData: () => resources, getResourceCreditValues: () => ({ ore: 10, gems: 20 }),
            isVisibleTile: () => true, getStartingLocations: () => [player.startLocation, new Vector2(200, 0)],
            getTileResourceData: () => ({ ore: 0, gems: 0 }), findPath: (_speed: any, _start: any, end: any) => [end] },
    };
    const context: any = { game, player: { name: player.name, production, actions }, difficulty: "brutal",
        matchAwareness: { getThreatCache: () => null, getNextExpansionCandidates: () => [] } };
    const controller = new QueueController(), requests = new Map<string, any>();
    function enemy(id: number, rx: number, type = ObjectType.Vehicle, extra = {}) {
        const unit = { id, owner: "enemy", type, tile: { rx, ry: 0 }, rules: {
            name: type === ObjectType.Infantry ? "E1" : "MTNK", type, isSelectableCombatant: true, harvester: false, ...extra } };
        enemies.push(unit);
        return unit;
    }
    return { game, player, context, units, enemies, resources, queues, options, actions, requests, own, enemy,
        at(value: number) { tick = value; },
        run() { controller.onAiUpdate(context, null, requests, () => {}); },
        priority() { this.run(); return Number(controller.getGlobalDebugText(game, production).match(new RegExp(`${minerName}\\(([^)]+)\\)`))?.[1] ?? 0); },
    };
}

function onlyEconomy(run: () => void) {
    const previous = BRUTAL_PARAMS.economy.ecoOnly;
    BRUTAL_PARAMS.economy.ecoOnly = 1;
    try { run(); } finally { BRUTAL_PARAMS.economy.ecoOnly = previous; }
}

describe("brutal miner capacity and production table", () => {
    test.each([[2999, 1], [3000, 2], [5999, 2], [6000, 4]])("value %i has ordinary capacity %i", (value, expected) => {
        expect(patchCapacity({ value } as any, false)).toBe(expected);
    });
    test("chrono miners get five only in the richest band", () => {
        expect(patchCapacity({ value: 6000 } as any, true)).toBe(5);
        expect(patchCapacity({ value: 5999 } as any, true)).toBe(2);
    });
    test("sums only visible served patches, floors a refinery at two and caps at twelve", () => {
        const f = fixture();
        expect(desiredMiners(f.game, f.player)).toBe(8);
        f.resources.push({ tile: { rx: 100, ry: 0 }, ore: 800, gems: 0, spawnsOre: false });
        f.game.mapApi.isVisibleTile = (tile: any) => tile.rx !== 100;
        expect(desiredMiners(f.game, f.player)).toBe(8);
        for (const rx of [45, 65, 85]) {
            f.own("NAREFN", rx); f.resources.push({ tile: { rx, ry: 0 }, ore: 800, gems: 0, spawnsOre: false });
        }
        f.at(190);
        expect(desiredMiners(f.game, f.player)).toBe(12);
        f.resources.length = 0; f.at(280);
        expect(desiredMiners(f.game, f.player)).toBe(2);
        f.units.splice(0, f.units.length);
        expect(desiredMiners(f.game, f.player)).toBe(0);
    });
    test("normal priority and ten-miner cap do not inspect patches", () => {
        const f = fixture(3);
        f.game.mapApi.getAllTilesResourceData = () => { throw new Error("normal must not read patches"); };
        const logic = new Harvester(15, 4, 2);
        expect(logic.getPriority(f.game, f.player, {} as any, null, "normal")).toBe(18.75);
        expect(logic.getMaxCount(f.game, f.player, {} as any, null, "normal")).toBe(10);
        expect(logic.getMaxCount(f.game, f.player, {} as any, null, "brutal")).toBe(12);
    });
    test.each([[0, 0, 120], [1, 0, 110], [2, 0, 110], [3, 0, 0], [3, 1, 78], [3, 2, 78], [4, 1, 0], [4, 2, 78], [4, 3, 78], [4, 4, 78], [5, 2, 0], [5, 3, 78], [6, 3, 0], [6, 4, 78], [8, 20, 0]])(
        "without pressure miners=%i core=%i gives priority %i", (miners, core, expected) => {
            expect(fixture(miners, core).priority()).toBe(expected);
        });
    test.each([[1, 1, 0], [1, 2, 90], [2, 3, 0], [2, 4, 78], [3, 0, 0], [3, 1, 78], [3, 2, 78]])(
        "early pressure miners=%i core=%i gives priority %i", (miners, core, expected) => {
            const f = fixture(miners, core); f.enemy(100, 40); f.enemy(101, 40);
            expect(f.priority()).toBe(expected);
        });
    test("direct base combat blocks later miners but not the specified pressured second/third miner rows", () => {
        const f = fixture(3, 20); f.enemy(100, 22);
        expect(f.priority()).toBe(0);
        const third = fixture(2, 4); third.enemy(100, 22);
        expect(third.priority()).toBe(78);
        const allied = fixture(1, 1, "Americans"); allied.enemy(100, 22);
        expect(allied.priority()).toBe(90);
    });
    test.each([1, 2, 3, 5, 7])("a requested/active supplied refinery reserves only its one future miner (miners=%i)", miners => {
        for (const active of [false, true]) {
            const f = fixture(miners, 6);
            const refinery = { name: "NAREFN", refinery: true, freeUnit: "HARV", cost: 2000, type: ObjectType.Building };
            f.options.set(QueueType.Structures, [refinery]); f.requests.set("NAREFN", { priority: 50, specificLocation: null });
            if (active) Object.assign(f.queues.get(QueueType.Structures)!, { status: QueueStatus.Active, items: [{ rules: refinery, quantity: 1 }] });
            expect(f.priority()).toBe(miners < 3 ? 110 : miners < 7 ? 78 : 0);
        }
    });
    test.each([
        [3, 0, "new", 110], [4, 0, "new", 110], [5, 3, "new", 78], [6, 4, "new", 78], [7, 6, "new", 0],
        [3, 2, "duplicate", 0], [4, 0, "cancelled", 0], [4, 0, "hidden", 0], [3, 0, "pressure", 0],
    ] as const)("paid refinery capacity miners=%i core=%i %s gives factory priority%i with only one supplied-miner reservation", (miners, core, condition, expected) => {
        const f = fixture(miners, core);
        f.units.splice(f.units.findIndex(unit => unit.name === "NAREFN" && unit.tile.rx === 25), 1);
        f.resources[1].tile.rx = 45;
        const refinery = { name: "NAREFN", refinery: true, freeUnit: "HARV", cost: 2000, type: ObjectType.Building, adjacent: 100 };
        f.options.set(QueueType.Structures, [refinery]);
        f.requests.set(refinery.name, { priority: 50, specificLocation: new Vector2(condition === "duplicate" ? 5 : 44, 0) });
        f.game.getBuildingPlacementData = () => ({ foundation: { width: 1, height: 1 } });
        f.game.canPlaceBuilding = () => true;
        f.game.mapApi.getTilesInRect = () => [{ id: "44_0", rx: 44, ry: 0 }];
        f.run();
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Structures, refinery.name, ObjectType.Building, 1);
        Object.assign(f.queues.get(QueueType.Structures)!, { status: QueueStatus.Active, items: [{ rules: refinery, quantity: 1 }] });
        Object.assign(f.queues.get(QueueType.Vehicles)!, { status: QueueStatus.Active, items: [{ rules: f.options.get(QueueType.Vehicles)![1], quantity: 1 }] });
        if (condition === "cancelled") { f.queues.get(QueueType.Structures)!.items = []; f.requests.delete(refinery.name); }
        if (condition === "hidden") {
            f.game.mapApi.isVisibleTile = (tile: any) => tile.rx !== 45;
            Object.defineProperty(f.resources[1], "ore", { get() { throw Error("unseen future income cannot be counted"); } });
        }
        if (condition === "pressure") f.enemy(100, 22);
        f.at(2700);
        expect(desiredMiners(f.game, f.player)).toBe(4);
        expect(f.priority()).toBe(expected);
        if (expected === 110) expect(f.actions.unqueueFromProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HTNK", ObjectType.Vehicle, 1);
        else expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
    });
    test("the authorized one-core factor applies even ahead of the visible miner peak or under pressure", () => {
        for (const [miners, core, expected] of [[4, 2, 78], [5, 3, 78], [5, 2, 0]]) {
            const f = fixture(miners, core);
            for (let i = 0; i < 4; i++) f.enemy(100 + i, 80, ObjectType.Vehicle, { harvester: true });
            expect(f.priority()).toBe(expected);
            f.enemy(200, 40); f.enemy(201, 40); f.at(102);
            expect(getEconomyPressureLimits(f.context, miners)).toMatchObject({ minerCoreFactor: 1, crawlMiners: 2, extraRefineryCredits: 1000 });
            expect(f.priority()).toBe(expected);
        }
    });
    test.each(["Russians", "Americans"])("%s expands the first five miners only in the real quiet-home window", country => {
        const f = fixture(4, 0, country); f.at(2699); expect(f.priority()).toBe(0);
        f.at(2700); expect(f.priority()).toBe(110);
        expect(getEconomyPressureLimits(f.context, 4).minerCoreFactor).toBe(0);
        expect(readPressure(f.context)).toMatchObject({ homeQuiet: true, passiveEnemy: false });
        expect(getEconomyPressureLimits(f.context, 5).minerCoreFactor).toBe(1);
        expect(getEconomyPressureLimits(f.context, 4).extraRefineryCredits).toBe(1000);
        f.enemy(100, 60); f.at(2702); expect(f.priority()).toBe(0);
        f.enemies.length = 0; f.at(5402); expect(f.priority()).toBe(110);
        f.resources.length = 0; f.at(5492); expect(f.priority()).toBe(0);
    });
    test.each([QueueStatus.Active, QueueStatus.OnHold])("needed early income can replace ordinary paid armor or a later drone in queue status%i", status => {
        for (const country of ["Russians", "Americans"]) for (const kind of ["armor", "drone"]) {
            const f = fixture(3, kind === "drone" ? 4 : 2, country); f.at(2700);
            const options = f.options.get(QueueType.Vehicles)!;
            let current = options[1];
            if (kind === "drone") {
                current = { name: "DRON", cost: 500, type: ObjectType.Vehicle };
                options.push(current);
                const firstDrone = f.own("DRON", 0, 0, { type: ObjectType.Vehicle });
                observeDroneProductionEvent(f.game, f.player.name, { type: ApiEventType.ObjectSpawn, target: firstDrone.id });
                f.enemy(100, 80, ObjectType.Vehicle, { harvester: true });
                if (country === "Americans") f.requests.set("DRON", { priority: 60, specificLocation: null });
            }
            Object.assign(f.queues.get(QueueType.Vehicles)!, { status, items: [{ rules: current, quantity: 1 }] });
            expect(f.priority()).toBe(110);
            expect(f.actions.unqueueFromProduction).toHaveBeenCalledWith(QueueType.Vehicles, current.name, ObjectType.Vehicle, 1);
            expect(f.actions.resumeProduction).not.toHaveBeenCalled();
        }
    });
    test.each([QueueStatus.Active, QueueStatus.OnHold])("early income does not replace protected production in queue status%i", status => {
        for (const condition of ["counter", "first-drone", "air", "contact", "before", "full", "normal"]) {
            const f = fixture(condition === "full" ? 5 : 3, 2); f.at(condition === "before" ? 2699 : 2700);
            const options = f.options.get(QueueType.Vehicles)!;
            let current = options[1];
            if (condition === "counter") f.requests.set(current.name, { priority: 100, specificLocation: null });
            if (condition === "first-drone") { current = { name: "DRON", cost: 500, type: ObjectType.Vehicle }; options.push(current); }
            if (condition === "air") { current = options[2]; f.requests.set("HTK", { priority: 115, specificLocation: null }); f.enemy(100, 80, ObjectType.Aircraft); }
            if (condition === "contact") f.enemy(100, 60);
            if (condition === "normal") { f.context.difficulty = "normal"; f.requests.set(current.name, { priority: 85, specificLocation: null }); }
            Object.assign(f.queues.get(QueueType.Vehicles)!, { status, items: [{ rules: current, quantity: 1 }] });
            const priority = f.priority(); expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
            if (condition === "counter") expect(priority).toBe(110);
        }
    });
    test.each(["Russians", "Americans"])("%s preserves the actual 100-priority infantry counter instead of overwriting it with ordinary armor85", country => {
        const f = fixture(3, 0, country); f.at(2700);
        for (let i = 0; i < 8; i++) f.enemy(100 + i, 80, ObjectType.Infantry);
        expect(f.priority()).toBe(78);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, country === "Russians" ? "HTNK" : "MTNK", ObjectType.Vehicle, 1);
    });
    test("an approved unpressured miner78 wins actual arbitration over the regular tank85, not only the debug priority", () => {
        const f = fixture(3, 2); f.run();
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HARV", ObjectType.Vehicle, 1);
        const pressure = fixture(3, 2); pressure.enemy(100, 40); pressure.enemy(101, 40); pressure.run();
        expect(pressure.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HTNK", ObjectType.Vehicle, 1);
        const response = fixture(3, 2); response.enemy(100, 70, ObjectType.Aircraft); response.run();
        expect(response.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HTK", ObjectType.Vehicle, 1);
    });
    test.each(["drone", "armor", "air", "capped"])("an optional drone cannot cancel a paid miner; the %s arbitration keeps emergency and cap behavior", response => {
        const f = fixture(response === "capped" ? 12 : 2, 0); f.resources.splice(1); f.resources[0].ore = 500;
        const options = f.options.get(QueueType.Vehicles)!;
        if (response !== "armor") options.push({ name: "DRON", cost: 500, type: ObjectType.Vehicle });
        if (response === "air") f.enemy(100, 70, ObjectType.Aircraft);
        Object.assign(f.queues.get(QueueType.Vehicles)!, { status: QueueStatus.Active, items: [{ rules: options[0], quantity: 1 }] });
        expect(desiredMiners(f.game, f.player)).toBe(2);
        f.run();
        if (response === "drone") expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
        else expect(f.actions.unqueueFromProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HARV", ObjectType.Vehicle, 1);
    });
    test.each(["Russians", "Americans"])("%s keeps a needed paid miner during advance warning, not a real emergency", country => {
        for (const response of ["warning", "siege", "air", "infantry", "capped"]) {
            const f = fixture(response === "capped" ? 12 : 1, 0, country); f.resources.splice(1);
            f.enemy(100, response === "siege" ? 22 : 40);
            if (response === "air") {
                f.enemy(200, 70, ObjectType.Aircraft); f.requests.set("HTK", { priority: 115, specificLocation: null });
            }
            if (response === "infantry") for (let i = 0; i < 8; i++) f.enemy(200 + i, 40, ObjectType.Infantry);
            const miner = f.options.get(QueueType.Vehicles)![0];
            Object.assign(f.queues.get(QueueType.Vehicles)!, { status: QueueStatus.Active, items: [{ rules: miner, quantity: 1 }] });
            expect(desiredMiners(f.game, f.player)).toBe(country === "Russians" ? 4 : 5);
            f.run();
            if (response === "warning") expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
            else expect(f.actions.unqueueFromProduction).toHaveBeenCalledWith(QueueType.Vehicles, miner.name, ObjectType.Vehicle, 1);
        }
    });
    test("protecting a paid miner does not start an unneeded one or change normal cancellation", () => {
        const idle = fixture(2, 0); idle.resources.splice(1); idle.resources[0].ore = 500;
        idle.options.get(QueueType.Vehicles)!.push({ name: "DRON", cost: 500, type: ObjectType.Vehicle });
        idle.run(); expect(idle.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "DRON", ObjectType.Vehicle, 1);
        const normal = fixture(2, 0); normal.context.difficulty = "normal";
        const options = normal.options.get(QueueType.Vehicles)!;
        options.push({ name: "DRON", cost: 500, type: ObjectType.Vehicle });
        normal.requests.set("DRON", { priority: 100, specificLocation: null });
        Object.assign(normal.queues.get(QueueType.Vehicles)!, { status: QueueStatus.Active, items: [{ rules: options[0], quantity: 1 }] });
        normal.run(); expect(normal.actions.unqueueFromProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HARV", ObjectType.Vehicle, 1);
    });
    test("115 flak response still outranks the 110 income opening", () => {
        const f = fixture(1, 0); f.enemy(100, 70, ObjectType.Aircraft);
        f.run();
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HTK", ObjectType.Vehicle, 1);
    });
});

describe("visible pressure and own event history", () => {
    test("base threat is current, excludes miners, and includes distance twenty-two", () => {
        const f = fixture(); f.at(5400);
        const enemy = f.enemy(100, 22, ObjectType.Vehicle, { harvester: true });
        expect(isPressured(f.context)).toBe(false);
        enemy.rules.harvester = false; f.at(5402);
        expect(readPressure(f.context).baseUnderSiege).toBe(true);
        enemy.tile.rx = 46; f.at(5404);
        expect(isPressured(f.context)).toBe(false);
    });
    test.each([ObjectType.Vehicle, ObjectType.Infantry])("early %i signal lasts 2700 ticks and retains real mean position", type => {
        const f = fixture();
        const count = type === ObjectType.Vehicle ? 1 : 3;
        for (let i = 0; i < count; i++) f.enemy(100 + i, 40 + i, type);
        expect(readPressure(f.context)).toMatchObject({ pressured: true, earlyPressure: true,
            earlyPressureUntil: 2800, earlyPressurePosition: { rx: 40 + (count - 1) / 2, ry: 0 } });
        f.enemies.length = 0; f.at(2799);
        expect(isPressured(f.context)).toBe(true);
        f.at(2800);
        expect(readPressure(f.context).earlyPressure).toBe(false);
        expect(isPressured(f.context)).toBe(false);
    });
    test.each([ObjectType.Vehicle, ObjectType.Infantry])("below the adjusted early %i threshold does not trigger pressure", type => {
        const f = fixture(), count = type === ObjectType.Vehicle ? 0 : 2;
        for (let i = 0; i < count; i++) f.enemy(100 + i, 40 + i, type);
        expect(readPressure(f.context).earlyPressure).toBe(false);
    });
    test("dogs, engineers, hidden enemies and signals first seen at 5400 cannot trigger early pressure", () => {
        const f = fixture();
        for (let i = 0; i < 4; i++) f.enemy(100 + i, 40, ObjectType.Infantry, { name: i < 2 ? "DOG" : "ENGINEER", engineer: i >= 2 });
        expect(isPressured(f.context)).toBe(false);
        f.enemies.length = 0; f.at(5400); f.enemy(200, 40); f.enemy(201, 40);
        expect(readPressure(f.context).earlyPressure).toBe(false);
    });
    test.each(["NAREFN", "HARV"])("a real own %s destroy records loss for 900 ticks, not a disappearance", name => {
        const f = fixture();
        const unit = f.units.find(unit => unit.name === name)!;
        readPressure(f.context);
        observePressureEvent(f.game, f.player.name, { type: ApiEventType.ObjectDestroy, target: unit.id });
        expect(readPressure(f.context)).toMatchObject({ pressured: true, lastEconomicLossTick: 100 });
        f.at(999); expect(isPressured(f.context)).toBe(true);
        f.at(1000); expect(isPressured(f.context)).toBe(false);
    });
    test("voluntary sales, packing and invisible enemy destroys are not economic losses", () => {
        const f = fixture(); readPressure(f.context);
        const refinery = f.units.find(unit => unit.name === "NAREFN")!;
        observePressureEvent(f.game, f.player.name, { type: ApiEventType.ObjectUnspawn, target: refinery.id });
        f.units.splice(f.units.indexOf(refinery), 1);
        observePressureEvent(f.game, f.player.name, { type: ApiEventType.ObjectDestroy, target: 999 });
        f.at(102); expect(isPressured(f.context)).toBe(false);
    });
    test("unrelated global spawns never scan the own inventory; an own economic spawn still records loss", () => {
        const f = fixture();
        f.game.getVisibleUnits = mock(f.game.getVisibleUnits);
        for (let i = 0; i < 1000; i++) observePressureEvent(f.game, f.player.name, { type: ApiEventType.ObjectSpawn, target: 99999 + i });
        expect(f.game.getVisibleUnits).not.toHaveBeenCalled();
        const refinery = f.own("NAREFN", 50);
        observePressureEvent(f.game, f.player.name, { type: ApiEventType.ObjectSpawn, target: refinery.id });
        expect(f.game.getVisibleUnits).not.toHaveBeenCalled();
        observePressureEvent(f.game, f.player.name, { type: ApiEventType.ObjectDestroy, target: refinery.id });
        expect(readPressure(f.context).lastEconomicLossTick).toBe(100);
    });
    test("P1 is a public optional trigger supplied by the later watch-post task", () => {
        const f = fixture();
        f.enemy(100, 80); f.enemy(101, 80);
        expect(isPressured(f.context)).toBe(false);
        setPressureWatchPost(f.game, f.player.name, { rx: 80, ry: 0 }); f.at(102);
        expect(readPressure(f.context).earlyPressure).toBe(true);
    });
    test("enemy miner peak and passive history expire by simulation tick, with independent games", () => {
        const f = fixture();
        for (let i = 0; i < 4; i++) f.enemy(100 + i, 80, ObjectType.Vehicle, { harvester: true });
        expect(readPressure(f.context).enemyMinersSeen).toBe(4);
        f.enemies.length = 0; f.at(2799); expect(readPressure(f.context).enemyMinersSeen).toBe(4);
        f.at(2800); expect(readPressure(f.context).enemyMinersSeen).toBe(0);
        f.at(5400); expect(readPressure(f.context).passiveEnemy).toBe(true);
        f.enemy(200, 60); f.at(5402); expect(readPressure(f.context).passiveEnemy).toBe(false);
        f.enemies.length = 0; f.at(8102); expect(readPressure(f.context).passiveEnemy).toBe(true);
        expect(isPressured(fixture().context)).toBe(false);
        f.at(0); expect(readPressure(f.context).enemyMinersSeen).toBe(0);
    });
});

describe("factory income ratio and real eco-only mode", () => {
    test.each([[4, 0], [5, 35], [6, 35]])("second factory with %i miners gives %i", (miners, expected) => {
        const f = fixture(miners, 5);
        expect(getEconomyBuildingPriority(f.game, f.player, { name: "NAWEAP" } as any, false, f.context)).toBe(expected);
    });
    test("pressure permits a cash-funded four-miner second factory at exactly 3000", () => {
        const f = fixture(4, 5); f.enemy(100, 22); f.player.credits = 2999;
        expect(getEconomyBuildingPriority(f.game, f.player, { name: "NAWEAP" } as any, false, f.context)).toBe(0);
        f.player.credits = 3000; f.at(102);
        expect(getEconomyBuildingPriority(f.game, f.player, { name: "NAWEAP" } as any, false, f.context)).toBe(35);
    });
    test("the third factory requires six miners and still caps at three factories", () => {
        for (const miners of [5, 6]) {
            const f = fixture(miners, 10); f.own("NAWEAP");
            expect(getEconomyBuildingPriority(f.game, f.player, { name: "NAWEAP" } as any, false, f.context)).toBe(miners === 6 ? 35 : 0);
            f.own("NAWEAP"); f.at(102);
            expect(getEconomyBuildingPriority(f.game, f.player, { name: "NAWEAP" } as any, false, f.context)).toBe(0);
        }
    });
    test("ecoOnly removes actual military requests and missions without fabricating core tanks", () => onlyEconomy(() => {
        const f = fixture(3, 0);
        f.options.set(QueueType.Armory, [{ name: "NALASR", type: ObjectType.Building, cost: 500 }]);
        f.options.set(QueueType.Structures, [{ name: "NATECH", type: ObjectType.Building, cost: 2000 },
            { name: "NARADR", type: ObjectType.Building, cost: 1000 }]);
        for (const name of ["HTNK", "HTK", "NALASR", "NATECH", "NARADR"]) f.requests.set(name, { priority: 150, specificLocation: null });
        expect(f.priority()).toBe(78);
        expect(f.actions.queueForProduction.mock.calls.every(call => call[1] === "HARV")).toBe(true);
        f.enemy(100, 22); f.at(102); expect(isPressured(f.context)).toBe(false);
        expect(readPressure(f.context).baseUnderSiege).toBe(true); // real observation, not forged away
        expect(f.units.some(unit => unit.name === "HTNK")).toBe(false);
        const missions = new MissionController(() => {});
        new DefaultStrategy().onAiUpdate(f.context, missions, () => {});
        expect(missions.getMissions()).toEqual([]);
        expect(getEconomyBuildingPriority(f.game, f.player, { name: "NARADR" } as any, true, f.context)).toBe(0);
        expect(getEconomyBuildingPriority(f.game, f.player, { name: "NALASR" } as any, true, f.context)).toBe(0);
        f.context.difficulty = "normal";
        expect(isPressured(f.context)).toBe(true);
    }));
});

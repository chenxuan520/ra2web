import { describe, expect, mock, test } from "bun:test";
import { BuildStatus } from "../../game/gameobject/Building";
import { LandType, ObjectType, OrderType, QueueStatus, QueueType, SpeedType, TerrainType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { getAdjacencyTiles, planRefinery } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/buildingRules";
import { QueueController, QUEUES } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController";
import { getBaseCrawlState, isCrawlBlocked, isCrawlDefense, observeBaseCrawl, planBaseCrawl, recordBaseCrawlOrder }
    from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/baseCrawl";
import { ExpansionMission, ExpansionMissionFactory, PackConyardMission, isMcvRelocating, planMcvExpansion }
    from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/expansionMission";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { BuiltInBot } from "../../game/ai/thirdpartbot/builtIn/bot/bot";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";
import { patchDistance } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/orePatches";

function fixture(targetX = 45) {
    let tick = 100, nextId = 1;
    const player: any = { name: "bot", country: { name: "Russians" }, startLocation: new Vector2(), credits: 2000,
        power: { total: 150, drain: 0 } };
    const units: any[] = [], enemies: any[] = [];
    function own(name: string, rx = 0, status = BuildStatus.Ready) {
        const vehicle = ["HARV", "HTNK", "SMCV"].includes(name);
        const unit = { id: nextId++, name, owner: player.name, type: vehicle ? ObjectType.Vehicle : ObjectType.Building,
            tile: { rx, ry: 0 }, foundation: { width: 1, height: 1 }, buildStatus: status, hitPoints: 1000, maxHitPoints: 1000,
            rules: { name, type: vehicle ? ObjectType.Vehicle : ObjectType.Building, baseNormal: !vehicle && !["NALASR", "GAPILL"].includes(name),
                harvester: name === "HARV", refinery: name === "NAREFN", weaponsFactory: name === "NAWEAP",
                constructionYard: name === "NACNST", undeploysInto: name === "NACNST" ? "SMCV" : undefined,
                deploysInto: name === "SMCV" ? "NACNST" : undefined, speedType: vehicle ? SpeedType.Track : undefined }, isIdle: true };
        units.push(unit); return unit;
    }
    own("NACNST"); own("NAWEAP"); own("NAREFN", 5);
    for (let i = 0; i < 3; i++) own("HARV", 10);
    const resources = [{ tile: { rx: 5, ry: 0 }, ore: 8000, gems: 0 }, { tile: { rx: targetX, ry: 0 }, ore: 12000, gems: 0 }];
    const refinery: any = { name: "NAREFN", refinery: true, freeUnit: "HARV", cost: 2000, type: ObjectType.Building, adjacent: 4 };
    const power: any = { name: "NAPOWR", cost: 800, type: ObjectType.Building, adjacent: 4, baseNormal: true };
    const defense: any = { name: "NALASR", cost: 500, type: ObjectType.Building, adjacent: 4, baseNormal: false };
    const candidates = [{ id: "8_0", rx: 8, ry: 0 }];
    const expansions = [new Vector2(targetX, 0)];
    const queues = new Map(QUEUES.map(type => [type, { type, status: QueueStatus.Idle, items: [] as any[] }]));
    const actions = { orderUnits: mock(() => {}), pauseProduction: mock(() => {}), resumeProduction: mock(() => {}),
        queueForProduction: mock(() => {}), unqueueFromProduction: mock(() => {}), placeBuilding: mock(() => {}), toggleRepairWrench: mock(() => {}) };
    const game: any = { getCurrentTick: () => tick, getPlayerData: () => player,
        getGeneralRules: () => ({ baseUnit: ["AMCV", "SMCV"] }),
        rulesApi: { vehicleRules: new Map([["SMCV", { name: "SMCV", speedType: SpeedType.Track }]]) },
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "self" ? units : enemies).filter(unit => predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => [...units, ...enemies].find(unit => unit.id === id), getGameObjectData: (id: number) => game.getUnitData(id),
        getUnitsInArea: (box: any) => units.filter(unit => box.containsPoint(new Vector2(unit.tile.rx, unit.tile.ry))).map(unit => unit.id),
        getBuildingPlacementData: () => ({ foundation: { width: 1, height: 1 } }),
        canPlaceBuilding: (_name: string, _rule: string, tile: any) => !units.some(unit => unit.rules.type === ObjectType.Building && unit.tile.rx === tile.rx && unit.tile.ry === tile.ry),
        mapApi: { getAllTilesResourceData: () => resources, isVisibleTile: () => true, getResourceCreditValues: () => ({ ore: 1, gems: 2 }),
            getStartingLocations: () => [player.startLocation, new Vector2(200, 0)],
            getTile: (rx: number, ry: number) => ({ id: `${rx}_${ry}`, rx, ry }),
            findPath: mock((_speed: any, start: any, end: any) => [end, start]),
            getTilesInRect: (rect: any) => candidates.filter(tile => tile.rx >= rect.x && tile.rx < rect.x + rect.width && tile.ry >= rect.y && tile.ry < rect.y + rect.height) },
    };
    const context: any = { difficulty: "brutal", game, player: { name: player.name, actions, production: {
        getQueueData: (queue: QueueType) => queues.get(queue)!, getAvailableObjects: (queue: QueueType) => queue === QueueType.Structures ? [refinery, power] : queue === QueueType.Armory ? [defense] : [],
    } }, matchAwareness: { getNextExpansionCandidates: () => expansions, getThreatCache: () => ({ totalAvailableAntiGroundFirepower: 100, totalOffensiveLandThreat: 0 }) } };
    function build() {
        const plan = planBaseCrawl(context)!;
        expect(plan).toBeDefined();
        recordBaseCrawlOrder(game, player.name, plan.rules.name, new Vector2(plan.location.rx, plan.location.ry));
        const queue = queues.get(plan.queue)!;
        queue.status = QueueStatus.Active; queue.items = [{ rules: plan.rules, quantity: 1 }];
        tick += 2; observeBaseCrawl(context);
        const unit = own(plan.rules.name, plan.location.rx, BuildStatus.BuildUp);
        unit.rules.baseNormal = plan.rules.baseNormal;
        queue.items = []; queue.status = QueueStatus.Idle;
        tick += 2; observeBaseCrawl(context);
        unit.buildStatus = BuildStatus.Ready; tick += 2; observeBaseCrawl(context);
        candidates.splice(0, candidates.length, { id: `${unit.tile.rx + 3}_0`, rx: unit.tile.rx + 3, ry: 0 });
        return unit;
    }
    return { game, context, player, units, enemies, resources, queues, candidates, expansions, refinery, power, defense, own, build,
        at(value: number) { tick = value; }, run: () => planBaseCrawl(context) };
}

describe("legal visible base crawl", () => {
    test.each(["reachable", "no-target", "hidden", "far", "factory", "miners", "pressure", "queue", "credits", "normal"])(
        "does not crawl when %s fails", reason => {
            const f = fixture(reason === "far" ? 46 : 45);
            if (reason === "reachable") { f.candidates.push({ id: "44_0", rx: 44, ry: 0 }); f.refinery.adjacent = 100; }
            if (reason === "hidden") {
                f.game.mapApi.isVisibleTile = (tile: any) => tile.rx !== 45;
                Object.defineProperty(f.resources[1], "ore", { get() { throw new Error("hidden ore read"); } });
            }
            if (reason === "no-target") f.resources.splice(1);
            if (reason === "factory") f.units.splice(f.units.findIndex(unit => unit.name === "NAWEAP"), 1);
            if (reason === "miners") f.units.splice(f.units.findIndex(unit => unit.name === "HARV"), 2);
            if (reason === "pressure") f.enemies.push({ id: 999, tile: { rx: 22, ry: 0 }, rules: { isSelectableCombatant: true } });
            if (reason === "queue") f.queues.get(QueueType.Structures)!.items.push({ rules: f.power, quantity: 1 });
            if (reason === "credits") f.player.credits = 799;
            if (reason === "normal") f.context.difficulty = "normal";
            expect(f.run()).toBeUndefined();
        });
    test("the authorized two-miner crawl adjustment starts earlier but never bypasses real pressure", () => {
        const f = fixture(); f.units.splice(f.units.findIndex(unit => unit.name === "HARV"), 1);
        f.at(3000); expect(f.run()).toBeDefined();
        f.enemies.push({ id: 999, tile: { rx: 22, ry: 0 }, rules: { isSelectableCombatant: true } });
        f.at(3002); expect(f.run()).toBeUndefined();
        f.enemies.length = 0; f.at(3004); expect(f.run()).toBeDefined();
    });
    test("g forty is eligible; real non-adjacency towers fall back to paid power even with margin 150", () => {
        const f = fixture(); f.player.credits = 800;
        expect(planRefinery(f.game, f.player, f.refinery).unreachable[0].g).toBe(40);
        f.player.power.total = 149; expect(f.run()).toMatchObject({ rules: { name: "NAPOWR", cost: 800 }, priority: 45, location: { rx: 8, ry: 0 } });
        f.player.power.total = 150; expect(f.run()).toMatchObject({ rules: { name: "NAPOWR", cost: 800 }, priority: 45 });
    });
    test("an explicitly adjacency-enabled tower rule retains the two-tower limit and actual ID classification", () => {
        const f = fixture(); f.defense.baseNormal = true;
        const first = f.build(), second = f.build();
        expect(first.name).toBe("NALASR"); expect(second.name).toBe("NALASR");
        expect(isCrawlDefense(f.game, f.player.name, first.id)).toBe(true);
        expect(isCrawlDefense(f.game, f.player.name, second.id)).toBe(true);
        expect(isCrawlDefense(f.game, f.player.name, 999)).toBe(false);
        expect(f.run()?.rules.name).toBe("NAPOWR");
    });
    test("a request and active queue cannot consume the five-building cap before real placed Ready IDs", () => {
        const f = fixture(); f.defense.baseNormal = true;
        const plan = f.run()!;
        expect(getBaseCrawlState(f.game, f.player.name).targets.get(plan.patch.id)?.builtIds.size ?? 0).toBe(0);
        recordBaseCrawlOrder(f.game, f.player.name, plan.rules.name, new Vector2(plan.location.rx, plan.location.ry));
        const queue = f.queues.get(plan.queue)!;
        queue.status = QueueStatus.Active; queue.items = [{ rules: plan.rules, quantity: 1 }];
        f.at(102); observeBaseCrawl(f.context);
        expect(getBaseCrawlState(f.game, f.player.name).targets.get(plan.patch.id)?.builtIds.size ?? 0).toBe(0);
        const unit = f.own(plan.rules.name, plan.location.rx, BuildStatus.BuildUp);
        f.at(104); observeBaseCrawl(f.context);
        expect(isCrawlDefense(f.game, f.player.name, unit.id)).toBe(true);
        expect(getBaseCrawlState(f.game, f.player.name).targets.get(plan.patch.id)?.builtIds.size ?? 0).toBe(0);
        unit.buildStatus = BuildStatus.Ready; f.at(106); observeBaseCrawl(f.context);
        expect(getBaseCrawlState(f.game, f.player.name).targets.get(plan.patch.id)?.builtIds.size).toBe(1);
    });
    test("zero legal progress blocks terrain for 2700 ticks, then retries without counting a building", () => {
        const f = fixture(15); f.own("NAPOWR", 5).tile.ry = 3;
        const location = { id: "7_6", rx: 7, ry: 6 }; f.candidates[0] = location;
        const entry = planRefinery(f.game, f.player, f.refinery).unreachable[0];
        expect(f.game.canPlaceBuilding(f.player.name, f.power.name, location)).toBe(true);
        expect(getAdjacencyTiles(f.game, f.player, f.power, false, 0)
            .some(tile => tile.rx === location.rx && tile.ry === location.ry)).toBe(true);
        expect(patchDistance(location, entry.patch)).toBe(entry.g);
        expect(f.run()).toBeUndefined();
        const patch = entry.patch;
        expect(isCrawlBlocked(f.game, f.player.name, patch)).toBe(true);
        f.at(2799); expect(f.run()).toBeUndefined();
        f.candidates[0] = { id: "6_1", rx: 6, ry: 1 }; f.at(2800);
        expect(f.run()).toBeDefined();
    });
    test("a strictly positive legal short step is not mistaken for terrain blocking", () => {
        const f = fixture(); f.candidates[0] = { id: "6_0", rx: 6, ry: 0 };
        expect(f.run()).toMatchObject({ location: { rx: 6, ry: 0 }, rules: { name: "NAPOWR" } });
        const patch = planRefinery(f.game, f.player, f.refinery).unreachable[0].patch;
        expect(isCrawlBlocked(f.game, f.player.name, patch)).toBe(false);
    });
    test("five actual buildings with no reachable refinery block the target for 5400 ticks", () => {
        const f = fixture();
        for (let i = 0; i < 5; i++) f.build();
        const patch = planRefinery(f.game, f.player, f.refinery).unreachable[0].patch;
        expect(f.run()).toBeUndefined();
        const state = getBaseCrawlState(f.game, f.player.name).targets.get(patch.id)!;
        expect(state.builtIds.size).toBe(5);
        expect(state.blockedUntil - f.game.getCurrentTick()).toBe(5400);
        expect(isCrawlBlocked(f.game, f.player.name, patch)).toBe(true);
    });
    test("pressure pauses an existing line and no longer requests its active building", () => {
        const f = fixture(), plan = f.run()!;
        recordBaseCrawlOrder(f.game, f.player.name, plan.rules.name, new Vector2(plan.location.rx, plan.location.ry));
        const queue = f.queues.get(plan.queue)!;
        queue.status = QueueStatus.Active; queue.items = [{ rules: plan.rules, quantity: 1 }];
        f.at(102); observeBaseCrawl(f.context);
        f.enemies.push({ id: 999, tile: { rx: 22, ry: 0 }, rules: { isSelectableCombatant: true } }); f.at(104);
        expect(f.run()).toBeUndefined();
        f.enemies.length = 0; f.at(106); expect(f.run()?.location).toEqual(plan.location);
    });
    test("a legal unpressured crawl starts at its real cost without the unrelated four-hundred cash margin", () => {
        for (const marked of [true, false]) {
            const f = fixture(); f.power.cost = 600; f.player.credits = 997;
            if (!marked) f.resources.splice(1);
            const available = f.context.player.production.getAvailableObjects;
            f.context.player.production.getAvailableObjects = (queue: QueueType) => queue === QueueType.Vehicles
                ? [{ name: "HTNK", cost: 900, type: ObjectType.Vehicle }] : available(queue);
            const requests = new Map<string, any>([["HTNK", { priority: 85, specificLocation: null }]]);
            if (!marked) requests.set("NAPOWR", { priority: 45, specificLocation: new Vector2(8, 0) });
            new QueueController().onAiUpdate(f.context, null, requests, () => {});
            if (marked) expect(f.context.player.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Structures, "NAPOWR", ObjectType.Building, 1);
            else expect(f.context.player.actions.queueForProduction.mock.calls.some((call: any[]) => call[0] === QueueType.Structures)).toBe(false);
        }
    });
    test("a paid unpressured crawl keeps its investment while normal queue funding remains unchanged", () => {
        const f = fixture(), plan = f.run()!;
        recordBaseCrawlOrder(f.game, f.player.name, plan.rules.name, new Vector2(plan.location.rx, plan.location.ry));
        const queue = f.queues.get(QueueType.Structures)!; queue.status = QueueStatus.Active; queue.items = [{ rules: f.power, quantity: 1 }];
        const available = f.context.player.production.getAvailableObjects;
        f.context.player.production.getAvailableObjects = (type: QueueType) => type === QueueType.Vehicles ? [{ name: "HTNK", cost: 900, type: ObjectType.Vehicle }] : available(type);
        f.player.credits = 100; f.at(102);
        const controller = new QueueController(), requests = new Map([["HTNK", { priority: 85, specificLocation: null }]]);
        controller.onAiUpdate(f.context, null, requests, () => {});
        expect(f.context.player.actions.pauseProduction).not.toHaveBeenCalledWith(QueueType.Structures);
        queue.status = QueueStatus.OnHold; f.at(104); controller.onAiUpdate(f.context, null, requests, () => {});
        expect(f.context.player.actions.resumeProduction).toHaveBeenCalledWith(QueueType.Structures);
    });
    test("the real queue integration pauses/resumes a paid crawl and never substitutes a non-progress site", () => {
        const f = fixture(), controller = new QueueController();
        controller.onAiUpdate(f.context, null, new Map(), () => {});
        expect(f.context.player.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Structures, "NAPOWR", ObjectType.Building, 1);
        const queue = f.queues.get(QueueType.Structures)!;
        queue.status = QueueStatus.Active; queue.items = [{ rules: f.power, quantity: 1 }];
        f.enemies.push({ id: 999, tile: { rx: 22, ry: 0 }, rules: { isSelectableCombatant: true } }); f.at(102);
        controller.onAiUpdate(f.context, null, new Map(), () => {});
        expect(f.context.player.actions.pauseProduction).toHaveBeenCalledWith(QueueType.Structures);
        queue.status = QueueStatus.OnHold; f.enemies.length = 0; f.at(104);
        controller.onAiUpdate(f.context, null, new Map(), () => {});
        expect(f.context.player.actions.resumeProduction).toHaveBeenCalledWith(QueueType.Structures);
        queue.status = QueueStatus.Ready; f.game.canPlaceBuilding = (_name: string, _rule: string, tile: any) => tile.rx !== 8; f.at(106);
        controller.onAiUpdate(f.context, null, new Map(), () => {});
        expect(f.context.player.actions.placeBuilding).not.toHaveBeenCalled();
    });
    test("native non-adjacency towers neither count as progress nor replace an advancing power plant", () => {
        const f = fixture(); f.defense.baseNormal = false;
        const tower = f.own("NALASR", 9); tower.rules.baseNormal = false;
        expect(planRefinery(f.game, f.player, f.refinery).unreachable[0].g).toBe(36);
        expect(f.run()).toMatchObject({ rules: { name: "NAPOWR" }, location: { rx: 8, ry: 0 } });
        const plant = f.build();
        expect(plant.name).toBe("NAPOWR");
        expect(f.run()).toMatchObject({ rules: { name: "NAPOWR" }, location: { rx: 11, ry: 0 } });
        expect(isCrawlBlocked(f.game, f.player.name, planRefinery(f.game, f.player, f.refinery).unreachable[0].patch)).toBe(false);
        const far = fixture(46), falseAnchor = far.own("NALASR", 40); falseAnchor.rules.baseNormal = false;
        expect(far.run()).toBeUndefined();
    });
    test("ecoOnly crawls with power instead of violating its no-defense-production rule", () => {
        const f = fixture(), previous = BRUTAL_PARAMS.economy.ecoOnly;
        BRUTAL_PARAMS.economy.ecoOnly = 1;
        try { expect(f.run()?.rules.name).toBe("NAPOWR"); } finally { BRUTAL_PARAMS.economy.ecoOnly = previous; }
    });
});

function mcvFixture() {
    const f = fixture(70); f.at(9000); f.resources[0].ore = 5999;
    for (let i = 0; i < 6; i++) f.own("HTNK");
    return f;
}

function quietMcvFixture(targetX = 35) {
    const f = fixture(targetX); f.at(5400);
    f.units.splice(f.units.findIndex(unit => unit.name === "HARV"), 1);
    return f;
}

describe("quiet existing-MCV relocation instead of long paid crawl", () => {
    test.each(["ore", "gems"])("a quiet two-miner %s field can use the existing safe candidate before nine thousand without invented armor", kind => {
        const f = quietMcvFixture();
        if (kind === "gems") { f.resources[1].ore = 0; f.resources[1].gems = 1000; }
        expect(planMcvExpansion(f.context, { rx: 0, ry: 0 })).toMatchObject({ candidate: { x: 35, y: 0 } });
        expect(f.units.some(unit => unit.name === "HTNK")).toBe(false);
    });
    test("quiet relocation uses the existing rich ore band and a far gem field without waiting for a failed plant", () => {
        const ore = quietMcvFixture(); ore.resources[1].ore = 6000;
        expect(planMcvExpansion(ore.context, { rx: 0, ry: 0 })).toBeDefined();
        const gem = quietMcvFixture(); gem.resources[1].ore = 0; gem.resources[1].gems = 1000; gem.own("NAPOWR", 20);
        expect(planMcvExpansion(gem.context, { rx: 0, ry: 0 })).toBeDefined();
        const late = mcvFixture(); late.resources[1].ore = 11999;
        expect(planMcvExpansion(late.context, { rx: 0, ry: 0 })).toBeUndefined();
    });
    test.each(["tick", "contact", "pressure", "one-miner", "queue", "near", "far", "small-ore", "gem-cost", "hidden", "normal"])("the early relocation rejects %s", reason => {
        const f = quietMcvFixture(reason === "near" ? 29 : reason === "far" ? 46 : 35);
        if (reason === "tick") f.at(5399);
        if (reason === "contact" || reason === "pressure") f.enemies.push({ id: 999, tile: { rx: reason === "contact" ? 60 : 22, ry: 0 },
            rules: { name: "HTNK", type: ObjectType.Vehicle, isSelectableCombatant: true } });
        if (reason === "one-miner") f.units.splice(f.units.findIndex(unit => unit.name === "HARV"), 1);
        if (reason === "queue") f.queues.get(QueueType.Structures)!.items.push({ rules: f.power, quantity: 1 });
        if (reason === "small-ore") f.resources[1].ore = 5999;
        if (reason === "gem-cost") { f.resources[1].ore = 0; f.resources[1].gems = 1000; f.refinery.cost = 2500; }
        if (reason === "hidden") {
            f.game.mapApi.isVisibleTile = (tile: any) => tile.rx !== 35;
            Object.defineProperty(f.resources[1], "ore", { get() { throw Error("an unseen field cannot justify relocation"); } });
        }
        if (reason === "normal") { f.context.difficulty = "normal"; f.game.mapApi.getAllTilesResourceData = () => { throw Error("normal relocation must not inspect patches"); }; }
        expect(planMcvExpansion(f.context, { rx: 0, ry: 0 })).toBeUndefined();
    });
    test.each(["unsafe", "cooldown", "no-near-refinery", "empty-path", "partial-path"])("early relocation retains the original %s factory guard", reason => {
        const f = quietMcvFixture(), missions = new MissionController(() => {});
        if (reason === "unsafe") f.context.matchAwareness.getThreatCache = () => ({ totalAvailableAntiGroundFirepower: 0, totalOffensiveLandThreat: 100 });
        if (reason === "no-near-refinery") f.units.find(unit => unit.name === "NAREFN")!.tile.rx = -15;
        if (reason === "empty-path") f.game.mapApi.findPath = mock(() => []);
        if (reason === "partial-path") f.game.mapApi.findPath = mock(() => [{ tile: { rx: 34, ry: 0 } }, { tile: { rx: 0, ry: 0 } }]);
        expect(planMcvExpansion(f.context, { rx: 0, ry: 0 })).toBeDefined();
        new ExpansionMissionFactory(reason === "cooldown" ? 5400 : undefined).maybeCreateMissions(f.context, missions, () => {});
        expect(missions.getMissions()).toEqual([]);
    });
    test("early packing hands only the selected destination to the original MCV and never queues a second one", () => {
        const f = quietMcvFixture(), missions = new MissionController(() => {}), factory = new ExpansionMissionFactory();
        factory.maybeCreateMissions(f.context, missions, () => {});
        expect(missions.getMissions().map(m => m.getUniqueName())).toEqual(["pack-up-1"]);
        expect(isMcvRelocating(f.game, f.player.name)).toBe(true);
        f.units.splice(f.units.findIndex(unit => unit.name === "NACNST"), 1);
        const mcv = f.own("SMCV", 5); f.at(5402);
        factory.maybeCreateMissions(f.context, missions, () => {});
        const expansion: any = missions.getMissions().find(m => m.getUniqueName() === `expansion-mcv-${mcv.id}`)!;
        expect(expansion.candidates).toEqual([new Vector2(35, 0)]);
        expansion.addUnit(mcv.id); expansion._onAiUpdate(f.context);
        expect(f.context.player.actions.orderUnits).toHaveBeenCalledWith([mcv.id], OrderType.Move, 35, 0);
        expect(f.context.player.actions.queueForProduction).not.toHaveBeenCalled();
    });
});

function localMcvFixture() {
    const f = quietMcvFixture(); f.expansions.length = 0;
    const hidden = new Set<string>(), blocked = new Set<string>();
    const key = (tile: any) => `${tile.rx}_${tile.ry}`;
    const tiles = Array.from({ length: 25 }, (_, i) => ({ id: `${30 + i % 5}_${Math.floor(i / 5)}`,
        rx: 30 + i % 5, ry: Math.floor(i / 5), z: 0, rampType: 0, terrainType: TerrainType.Clear, landType: LandType.Clear }));
    f.game.getBuildingPlacementData = () => ({ foundation: { width: 3, height: 3 }, foundationCenter: new Vector2(1, 1) });
    f.game.mapApi.getTilesInRect = (rect: any) => tiles.filter(tile => tile.rx >= rect.x && tile.rx < rect.x + rect.width &&
        tile.ry >= rect.y && tile.ry < rect.y + rect.height);
    f.game.mapApi.isVisibleTile = (tile: any) => !hidden.has(key(tile));
    f.game.mapApi.isPassableTile = (tile: any) => !blocked.has(key(tile));
    f.game.map = f.game.mapApi;
    return { ...f, tiles, hidden, blocked };
}

describe("early MCV visible footprint fallback", () => {
    test("a real visible three-by-three footprint works without the old nine-clear-space/four-thousand sector candidate", () => {
        const f = localMcvFixture(), missions = new MissionController(() => {});
        expect(planMcvExpansion(f.context, { rx: 0, ry: 0 })?.candidate).toEqual(new Vector2(33, 1));
        new ExpansionMissionFactory().maybeCreateMissions(f.context, missions, () => {});
        expect(missions.getMissions().map(mission => mission.getUniqueName())).toEqual(["pack-up-1"]);
        expect(f.context.player.actions.queueForProduction).not.toHaveBeenCalled();
    });
    test.each(["hidden", "too-small", "blocked", "center-hole", "ore", "height", "no-yard"])("the local fallback rejects %s rather than packing toward an invalid footprint", reason => {
        const f = localMcvFixture(), missions = new MissionController(() => {});
        if (reason === "hidden") for (const tile of f.tiles) {
            f.hidden.add(tile.id);
            Object.defineProperty(tile, "terrainType", { get() { throw Error("unseen deployment terrain cannot be read"); } });
        }
        if (reason === "too-small") f.tiles.splice(0, 23);
        if (reason === "blocked") f.tiles.forEach(tile => f.blocked.add(tile.id));
        if (reason === "center-hole") f.blocked.add("32_2");
        if (reason === "ore") f.tiles.forEach(tile => tile.landType = LandType.Tiberium);
        if (reason === "height") f.tiles.forEach(tile => tile.z = (tile.rx + tile.ry) % 2 * 2);
        if (reason === "no-yard") f.units.splice(f.units.findIndex(unit => unit.name === "NACNST"), 1);
        expect(planMcvExpansion(f.context, { rx: 0, ry: 0 })).toBeUndefined();
        new ExpansionMissionFactory().maybeCreateMissions(f.context, missions, () => {});
        expect(missions.getMissions()).toEqual([]);
    });
    test("an existing suitable candidate stays preferred and the late rule does not gain the new fallback", () => {
        const f = localMcvFixture(); f.expansions.push(new Vector2(35, 0));
        f.game.mapApi.getTilesInRect = () => { throw Error("a valid existing candidate needs no local scan"); };
        expect(planMcvExpansion(f.context, { rx: 0, ry: 0 })?.candidate).toEqual(new Vector2(35, 0));
        const late = mcvFixture(); late.expansions.length = 0;
        expect(planMcvExpansion(late.context, { rx: 0, ry: 0 })).toBeUndefined();
    });
});

describe("existing MCV economy expansion", () => {
    test.each(["tick", "pressure", "queue", "home", "target-value", "served", "core", "candidate", "near"])(
        "does not pack when %s fails", reason => {
            const f = mcvFixture();
            if (reason === "tick") f.at(8999);
            if (reason === "pressure") f.enemies.push({ id: 999, tile: { rx: 22, ry: 0 }, rules: { isSelectableCombatant: true } });
            if (reason === "queue") f.queues.get(QueueType.Structures)!.items.push({ rules: f.power, quantity: 1 });
            if (reason === "home") f.resources[0].ore = 6000;
            if (reason === "target-value") f.resources[1].ore = 11999;
            if (reason === "served") f.own("NAREFN", 65);
            if (reason === "core") f.units.splice(f.units.findIndex(unit => unit.name === "HTNK"), 1);
            if (reason === "candidate") f.expansions[0] = new Vector2(83, 0);
            if (reason === "near") f.own("NAPOWR", 35);
            expect(planMcvExpansion(f.context, { rx: 0, ry: 0 })).toBeUndefined();
        });
    test("home value 5999 and target 12000 qualify; picks just the closest existing candidate within twelve", () => {
        const f = mcvFixture(); f.expansions.splice(0, 1, new Vector2(82, 0), new Vector2(71, 0));
        expect(planMcvExpansion(f.context, { rx: 0, ry: 0 })).toMatchObject({ patch: { id: "70_0" }, candidate: { x: 71, y: 0 } });
        f.expansions.splice(1); expect(planMcvExpansion(f.context, { rx: 0, ry: 0 })?.candidate.x).toBe(82);
    });
    test("a presently blocked crawl target qualifies even with g no greater than forty", () => {
        const f = fixture(); f.at(8990); f.resources[0].ore = 5999;
        for (let i = 0; i < 6; i++) f.own("HTNK");
        for (let i = 0; i < 5; i++) f.build();
        expect(f.run()).toBeUndefined();
        expect(planMcvExpansion(f.context, { rx: 0, ry: 0 })).toMatchObject({ patch: { id: "45_0" }, candidate: { x: 45, y: 0 } });
    });
    test.each(["unsafe", "cooldown", "no-near-refinery"])("the existing %s pack guard remains in force", reason => {
        const f = mcvFixture(), missions = new MissionController(() => {});
        if (reason === "unsafe") f.context.matchAwareness.getThreatCache = () => ({ totalAvailableAntiGroundFirepower: 0, totalOffensiveLandThreat: 100 });
        if (reason === "no-near-refinery") f.units.find(unit => unit.name === "NAREFN")!.tile.rx = 15;
        new ExpansionMissionFactory(reason === "cooldown" ? 9000 : undefined).maybeCreateMissions(f.context, missions, () => {});
        expect(missions.getMissions()).toEqual([]);
    });
    test("actual selected packing intent prevents immediate initial redeploy and gives the existing MCV only its selected candidate", () => {
        const f = mcvFixture(), missions = new MissionController(() => {}), factory = new ExpansionMissionFactory();
        factory.maybeCreateMissions(f.context, missions, () => {});
        expect(missions.getMissions().map(m => m.getUniqueName())).toEqual(["pack-up-1"]);
        expect(isMcvRelocating(f.game, f.player.name)).toBe(true);
        f.units.splice(f.units.findIndex(unit => unit.name === "NACNST"), 1);
        const mcv = f.own("SMCV", 5); f.at(9002);
        const bot: any = new BuiltInBot("bot", "Russians" as any, [], false, undefined, "brutal");
        bot.setGameApi(f.game); bot.setActionsApi(f.context.player.actions); bot.missionController = missions;
        bot.tryInitialMcvDeploy(f.game);
        expect(f.context.player.actions.orderUnits).not.toHaveBeenCalledWith([mcv.id], OrderType.DeploySelected);
        factory.maybeCreateMissions(f.context, missions, () => {});
        const expansion: any = missions.getMissions().find(m => m.getUniqueName() === `expansion-mcv-${mcv.id}`)!;
        expect(expansion.candidates).toEqual([new Vector2(70, 0)]);
        f.units.splice(f.units.indexOf(mcv), 1); f.own("NACNST", 70); f.at(9004);
        factory.maybeCreateMissions(f.context, missions, () => {});
        expect(isMcvRelocating(f.game, f.player.name)).toBe(false);
    });
    test.each(["empty", "partial"])("an economic pack requires a full path, rejecting a %s route", reason => {
        const f = mcvFixture(), missions = new MissionController(() => {});
        f.game.mapApi.findPath = mock((_speed: any, start: any) => reason === "empty" ? [] : [start]);
        new ExpansionMissionFactory().maybeCreateMissions(f.context, missions, () => {});
        expect(missions.getMissions()).toEqual([]);
        expect(isMcvRelocating(f.game, f.player.name)).toBe(false);
        expect(f.game.mapApi.findPath).toHaveBeenCalledTimes(1);
        expect(f.game.mapApi.findPath.mock.calls[0][3]).toMatchObject({ bestEffort: false });
    });
    test("existing economic pack and move missions pause on live pressure, without changing normal pack behavior", () => {
        const f = mcvFixture(), missions = new MissionController(() => {}), factory = new ExpansionMissionFactory();
        factory.maybeCreateMissions(f.context, missions, () => {});
        const pack = missions.getMissions()[0];
        f.enemies.push({ id: 999, tile: { rx: 22, ry: 0 }, rules: { isSelectableCombatant: true } }); f.at(9002);
        expect(pack._onAiUpdate(f.context)).toMatchObject({ type: "noop" });
        expect(f.context.player.actions.orderUnits).not.toHaveBeenCalled();
        f.enemies.length = 0; f.units.splice(f.units.findIndex(unit => unit.name === "NACNST"), 1);
        const mcv = f.own("SMCV", 5); f.at(9004); factory.maybeCreateMissions(f.context, missions, () => {});
        const expand = missions.getMissions().find(mission => mission.getUniqueName() === `expansion-mcv-${mcv.id}`)!;
        expand.addUnit(mcv.id);
        f.enemies.push({ id: 999, tile: { rx: 22, ry: 0 }, rules: { isSelectableCombatant: true } }); f.at(9006);
        expect(expand._onAiUpdate(f.context)).toMatchObject({ type: "noop" });
        expect(f.context.player.actions.orderUnits).not.toHaveBeenCalled();
        f.enemies.length = 0; f.at(9008); expand._onAiUpdate(f.context);
        expect(f.context.player.actions.orderUnits).toHaveBeenCalledWith([mcv.id], OrderType.Move, 70, 0);
        f.context.player.actions.orderUnits.mockClear();
        f.context.difficulty = "normal"; new PackConyardMission("normal-pack", mcv.id, () => {})._onAiUpdate(f.context);
        expect(f.context.player.actions.orderUnits).toHaveBeenCalledWith([mcv.id], OrderType.Move, 5, 0);
    });
    test("a lost selected MCV cannot trigger production of another MCV in brutal", () => {
        const f = mcvFixture();
        expect(new ExpansionMission("lost-mcv", 100, 999, [new Vector2(70, 0)], () => {})._onAiUpdate(f.context)).toMatchObject({ type: "disband" });
    });
});

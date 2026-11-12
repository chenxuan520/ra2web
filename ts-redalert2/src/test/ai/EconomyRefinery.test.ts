import { describe, expect, mock, test } from "bun:test";
import { BuildStatus } from "../../game/gameobject/Building";
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
    const actions = { sellBuilding: mock(() => {}), queueForProduction: mock(() => {}), unqueueFromProduction: mock(() => {}),
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
            if (condition === "full") f.own("HARV", 10);
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

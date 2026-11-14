import { describe, expect, test } from "bun:test";
import { BaseBuildingMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseBuildingMission";
import { ObjectType, QueueStatus, QueueType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";
import type { MissionContext } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/context";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";
import { getEconomyBuildingPriority } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/economyPlan";

function fixture(difficulty?: "normal" | "brutal") {
    const rules = (name: string) => ({ name, type: ObjectType.Building, adjacent: 8, power: 200 });
    const options = [rules("GAWEAP"), rules("AMRADR")];
    const units = [
        { id: 1, tile: { rx: 0, ry: 0 }, foundation: { width: 3, height: 3 },
            rules: { ...rules("GACNST"), constructionYard: true, baseNormal: true } },
        { id: 2, tile: { rx: 30, ry: 30 }, foundation: { width: 3, height: 3 },
            rules: { ...rules("GAWEAP"), baseNormal: true } },
    ];
    const tiles = [{ id: "near", rx: 3, ry: 0 }, { id: "far", rx: 6, ry: 0 }];
    const legalLocations = new Set(["AMRADR:6:0"]);
    const placementChecks: string[] = [];
    const game = {
        getCurrentTick: () => 0,
        getPlayerData: () => ({ name: "bot", credits: 10000, startLocation: new Vector2(), power: { total: 200, drain: 85 } }),
        getVisibleUnits: (_name: string, _relation: string, predicate: (rules: any) => boolean) => units.filter(u => predicate(u.rules)).map(u => u.id),
        getUnitData: (id: number) => units.find(u => u.id === id),
        getGameObjectData: (id: number) => units.find(u => u.id === id),
        getBuildingPlacementData: () => ({ foundation: { width: 2, height: 2 } }),
        canPlaceBuilding: (_name: string, building: string, tile: { rx: number; ry: number }) => {
            const key = `${building}:${tile.rx}:${tile.ry}`;
            placementChecks.push(key);
            return legalLocations.has(key);
        },
        mapApi: { getTilesInRect: (rect: { x: number; y: number; width: number; height: number }) => tiles.filter(tile =>
            tile.rx >= rect.x && tile.rx < rect.x + rect.width && tile.ry >= rect.y && tile.ry < rect.y + rect.height) },
    };
    const context = {
        difficulty, game,
        player: { name: "bot", production: { getQueueData: () => ({ items: [] }), getAvailableObjects: (queue: QueueType) => {
            expect(queue).toBe(QueueType.Structures);
            return options;
        } } },
        matchAwareness: { getThreatCache: () => null },
    };
    const mission = new BaseBuildingMission(QueueType.Structures, () => {});
    // These cases isolate placement fallback from the independently tested
    // economic policy. Both options have the same explicit priority.
    (mission as any).getPriorityForBuildingOption = (option: any) => ["GAWEAP", "AMRADR", "GAAIRC"].includes(option.name) ? 10 : 0;
    return { options, rules, legalLocations, placementChecks, run: () => mission._onAiUpdate(context as unknown as MissionContext) };
}

describe("brutal building placement fallback", () => {
    test.each([18, 30, 50])("an ongoing investment survives a new priority %i request unless it is urgent", newPriority => {
        const mission = new BaseBuildingMission(QueueType.Structures, () => {});
        (mission as any).getPriorityForBuildingOption = (option: any) => option.name === "AMRADR" ? 18 : newPriority;
        (mission as any).getBestLocationForStructure = () => ({ rx: 1, ry: 1 });
        const context = { difficulty: "brutal", game: { getCurrentTick: () => 0, getPlayerData: () => ({}) },
            matchAwareness: { getThreatCache: () => null }, player: { name: "bot", production: {
                getAvailableObjects: () => [{ name: "GAREFN" }, { name: "AMRADR" }],
                getQueueData: () => ({ items: [{ rules: { name: "AMRADR" } }] }),
            } } };
        for (let update = 0; update < 3; update++) {
            expect(mission._onAiUpdate(context as any)).toMatchObject({ rulesName: newPriority > 36 ? "GAREFN" : "AMRADR" });
        }
    });
    test("a blocked second war factory does not prevent a legal radar request", () => {
        const f = fixture("brutal");
        expect(f.run()).toEqual({ type: "buildStructureAtLocation", rulesName: "AMRADR", priority: 10, rx: 6, ry: 0 });
        expect(f.placementChecks).toEqual(["GAWEAP:6:0", "AMRADR:6:0"]);
    });

    test.each(["normal", undefined] as const)("%s retains the single preferred-building decision", difficulty => {
        const f = fixture(difficulty);
        expect(f.run()).toEqual({ type: "noop" });
        expect(f.placementChecks).toEqual(["GAWEAP:6:0"]);
    });

    test("a legal highest-priority building stops the search", () => {
        const f = fixture("brutal");
        f.legalLocations.add("GAWEAP:6:0");
        expect(f.run()).toMatchObject({ type: "buildStructureAtLocation", rulesName: "GAWEAP" });
        expect(f.placementChecks).toEqual(["GAWEAP:6:0"]);
    });

    test("unavailable production options are never requested", () => {
        const f = fixture("brutal");
        f.options.splice(1);
        expect(f.run()).toEqual({ type: "noop" });
        expect(f.placementChecks).toEqual(["GAWEAP:6:0"]);
    });

    test("nonpositive priorities do not trigger placement or production requests", () => {
        const f = fixture("brutal");
        f.options.splice(0, f.options.length, f.rules("GAPOWR"), f.rules("GAYARD"));
        expect(f.run()).toEqual({ type: "noop" });
        expect(f.placementChecks).toEqual([]);
    });

    test("fallback preserves the two-tile spacing rule even when a closer site is legal", () => {
        const f = fixture("brutal");
        f.legalLocations.clear();
        f.legalLocations.add("AMRADR:3:0");
        expect(f.run()).toEqual({ type: "noop" });
        expect(f.placementChecks).toEqual(["GAWEAP:6:0", "AMRADR:6:0"]);
    });

    test("equal priorities preserve available-option order", () => {
        const f = fixture("brutal");
        f.options.splice(0, f.options.length, f.rules("GAAIRC"), f.rules("AMRADR"));
        f.legalLocations.add("GAAIRC:6:0");
        expect(f.run()).toMatchObject({ type: "buildStructureAtLocation", rulesName: "GAAIRC" });
        expect(f.placementChecks).toEqual(["GAAIRC:6:0"]);
    });
});

function reservePowerFixture(country: "Russians" | "Americans") {
    let tick = 3122;
    const soviet = country === "Russians", powerName = soviet ? "NAPOWR" : "GAPOWR", tankName = soviet ? "HTNK" : "MTNK";
    const player: any = { name: "bot", country: { name: country }, credits: 2439, startLocation: new Vector2(),
        power: { total: 150, drain: 85, isLowPower: false } };
    const power = { name: powerName, type: ObjectType.Building, power: 150, cost: 600 };
    const owned: any[] = [];
    const add = (name: string) => owned.push({ id: owned.length + 1, name, owner: "bot", tile: { rx: 0, ry: 0 }, rules: {
        name, type: ["HARV", "CMIN", "HTNK", "MTNK"].includes(name) ? ObjectType.Vehicle : ObjectType.Building,
        harvester: name === "HARV" || name === "CMIN", refinery: name.endsWith("REFN"), weaponsFactory: name.endsWith("WEAP"),
    } });
    for (const name of [powerName, soviet ? "NAREFN" : "GAREFN", soviet ? "NAWEAP" : "GAWEAP", soviet ? "HARV" : "CMIN"]) add(name);
    const enemies = [0, 1, 2].map(i => ({ id: 100 + i, tile: { rx: 40, ry: i }, rules: {
        name: "E2", type: ObjectType.Infantry, isSelectableCombatant: true } }));
    const queue: any = { status: QueueStatus.Idle, items: [] };
    const game: any = { getCurrentTick: () => tick, getPlayerData: () => player,
        getVisibleUnits: (_: string, relation: string, predicate = (_: any) => true) =>
            (relation === "self" ? owned : enemies).filter(u => predicate(u.rules)).map(u => u.id),
        getUnitData: (id: number) => [...owned, ...enemies].find(u => u.id === id),
    };
    const context: any = { difficulty: "brutal", game, player: { name: "bot", production: {
        getAvailableObjects: () => [power], getQueueData: () => queue } }, matchAwareness: { getThreatCache: () => null } };
    const mission = new BaseBuildingMission(QueueType.Structures, () => {});
    (mission as any).getBestLocationForStructure = () => ({ rx: 4, ry: 4 });
    return { player, context, owned, enemies, power, queue, add, tankName,
        at(value: number) { tick = value; }, run: () => mission._onAiUpdate(context) };
}

describe("reserve power while a single income needs its protective core", () => {
    test.each([["Russians", 0], ["Russians", 1], ["Americans", 0]] as const)("%s with%i cores defers a new reserve plant through the actual building selector", (country, cores) => {
        const f = reservePowerFixture(country); for (let i = 0; i < cores; i++) f.add(f.tankName);
        expect(f.run()).toEqual({ type: "noop" });
    });
    test.each(["Russians", "Americans"] as const)("%s resumes its original reserve request after actual protective core delivery", country => {
        const f = reservePowerFixture(country);
        expect(f.run()).toEqual({ type: "noop" });
        for (let i = 0; i < (country === "Russians" ? 2 : 1); i++) f.add(f.tankName);
        f.at(3124);
        expect(f.run()).toMatchObject({ type: "buildStructureAtLocation", rulesName: f.power.name, priority: 20 });
    });
    test("two incomes wait for protective armor before a new reserve plant", () => {
        const f = reservePowerFixture("Russians"); f.add("HARV");
        expect(f.run()).toEqual({ type: "noop" });
        f.add(f.tankName); f.add(f.tankName); f.at(3124);
        expect(f.run()).toMatchObject({ type: "buildStructureAtLocation", rulesName: f.power.name, priority: 20 });
    });
    test.each(["low-power", "first-plant", "active-commitment", "quiet", "normal", "ecoOnly"])(
        "the original %s power behavior is retained", condition => {
            const f = reservePowerFixture("Russians");
            if (condition === "low-power") Object.assign(f.player.power, { total: 84, isLowPower: true });
            if (condition === "first-plant") { f.owned.splice(0, 1); Object.assign(f.player.power, { total: 0, isLowPower: true }); }
            if (condition === "active-commitment") Object.assign(f.queue, { status: QueueStatus.Active, items: [{ rules: f.power, quantity: 1 }] });
            if (condition === "quiet") f.enemies.length = 0;
            if (condition === "normal") f.context.difficulty = "normal";
            const previous = BRUTAL_PARAMS.economy.ecoOnly;
            if (condition === "ecoOnly") BRUTAL_PARAMS.economy.ecoOnly = 1;
            try {
                expect(f.run()).toMatchObject({ type: "buildStructureAtLocation", rulesName: f.power.name,
                    priority: condition === "low-power" || condition === "first-plant" ? 100 : 20 });
            } finally { BRUTAL_PARAMS.economy.ecoOnly = previous; }
        });
});

function guardedInvestmentFixture(country: "Russians" | "Americans") {
    const f = reservePowerFixture(country);
    f.enemies.splice(0, f.enemies.length, { id: 100, tile: { rx: 50, ry: 0 }, rules: {
        name: "DOG", type: ObjectType.Infantry, isSelectableCombatant: true } });
    f.context.game.getGameObjectData = f.context.game.getUnitData;
    f.context.game.mapApi = { getAllTilesResourceData: () => [{ tile: { rx: 4, ry: 0 }, ore: 800, gems: 0, spawnsOre: false }],
        getResourceCreditValues: () => ({ ore: 10, gems: 20 }), isVisibleTile: () => true,
        getStartingLocations: () => [new Vector2(), new Vector2(200, 0)] };
    const refinery = { name: country === "Russians" ? "NAREFN" : "GAREFN", refinery: true, cost: 2000,
        freeUnit: country === "Russians" ? "HARV" : "CMIN", type: ObjectType.Building };
    return { ...f, refinery, refineryPriority: (committed = false) => getEconomyBuildingPriority(f.context.game, f.player,
        refinery as any, committed, f.context, { patch: undefined, location: { rx: 20, ry: 0 }, reachable: true, unreachable: [] }) };
}

const guardedOpeningCases = [["Russians", 0, 1], ["Russians", 1, 1], ["Americans", 0, 1],
    ["Russians", 0, 2], ["Russians", 1, 2], ["Americans", 0, 2]] as const;

describe("new building investment waits for the observed-contact protective core", () => {
    test.each(guardedOpeningCases)("%s core%i income%i defers only a new refinery", (country, core, income) => {
        const f = guardedInvestmentFixture(country);
        for (let i = 0; i < core; i++) f.add(f.tankName);
        if (income === 2) f.add(country === "Russians" ? "HARV" : "CMIN");
        expect(f.refineryPriority()).toBe(0);
    });
    test.each(guardedOpeningCases)("%s core%i income%i defers a sufficient-power reserve through the actual selector", (country, core, income) => {
        const f = guardedInvestmentFixture(country);
        for (let i = 0; i < core; i++) f.add(f.tankName);
        if (income === 2) f.add(country === "Russians" ? "HARV" : "CMIN");
        expect(f.run()).toEqual({ type: "noop" });
    });
    test.each(["Russians", "Americans"] as const)("%s restores original refinery and reserve requests at its actual protective core count", country => {
        const f = guardedInvestmentFixture(country); expect(f.refineryPriority()).toBe(0);
        for (let i = 0; i < (country === "Russians" ? 2 : 1); i++) f.add(f.tankName);
        f.at(3124); expect(f.refineryPriority()).toBe(50);
        expect(f.run()).toMatchObject({ type: "buildStructureAtLocation", rulesName: f.power.name, priority: 20 });
    });
    test.each([QueueStatus.Active, QueueStatus.OnHold])("paid commitments remain available in status%i", status => {
        const f = guardedInvestmentFixture("Russians");
        Object.assign(f.queue, { status, items: [{ rules: f.power, quantity: 1 }] });
        expect(f.refineryPriority(true)).toBe(50);
        expect(f.run()).toMatchObject({ type: "buildStructureAtLocation", rulesName: f.power.name, priority: 20 });
        expect(f.queue.items[0].rules).toBe(f.power);
    });
    test.each(["quiet", "three-incomes", "pre-window", "late", "normal", "ecoOnly"])("%s retains the original new investment requests", condition => {
        const f = guardedInvestmentFixture("Russians");
        if (condition === "quiet") f.enemies.length = 0;
        if (condition === "three-incomes") { f.add("HARV"); f.add("HARV"); }
        if (condition === "pre-window") f.at(2698);
        if (condition === "late") f.at(9000);
        if (condition === "normal") f.context.difficulty = "normal";
        const previous = BRUTAL_PARAMS.economy.ecoOnly;
        if (condition === "ecoOnly") BRUTAL_PARAMS.economy.ecoOnly = 1;
        try {
            expect(f.refineryPriority()).toBe(50);
            expect(f.run()).toMatchObject({ type: "buildStructureAtLocation", rulesName: f.power.name, priority: 20 });
        } finally { BRUTAL_PARAMS.economy.ecoOnly = previous; }
    });
    test("actual low power keeps the original100 plant priority even if the convenience flag is stale", () => {
        for (const isLowPower of [true, false]) {
            const f = guardedInvestmentFixture("Russians"); Object.assign(f.player.power, { total: 84, isLowPower });
            expect(f.run()).toMatchObject({ type: "buildStructureAtLocation", rulesName: f.power.name, priority: 100 });
        }
    });
    test("first refinery and first power plant retain their original admission", () => {
        const firstRefinery = guardedInvestmentFixture("Russians");
        firstRefinery.owned.splice(firstRefinery.owned.findIndex(unit => unit.rules.refinery), 1);
        expect(firstRefinery.refineryPriority()).toBe(50);
        const firstPower = guardedInvestmentFixture("Russians"); firstPower.owned.splice(0, 1);
        Object.assign(firstPower.player.power, { total: 0, isLowPower: true });
        expect(firstPower.run()).toMatchObject({ type: "buildStructureAtLocation", rulesName: firstPower.power.name, priority: 100 });
    });
});

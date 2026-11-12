import { expect, test } from "bun:test";
import { getEconomyBuildingPriority } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/economyPlan";
import { ObjectType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";

function scenario(names: string[], credits = 5000, distance = 120, country = "Arabs", pressured = false) {
    const player: any = { name: "bot", country: { name: country }, credits, startLocation: new Vector2() };
    const owned = names.map((name, i) => ({ id: i + 1, tile: { rx: name.endsWith("REFN") ? 5 : 0, ry: 0 }, foundation: { width: 1, height: 1 }, rules: {
        name, harvester: ["HARV", "CMIN"].includes(name), refinery: name.endsWith("REFN"), weaponsFactory: name.endsWith("WEAP"),
        type: ["HARV", "CMIN", "HTNK", "MTNK", "JUMPJET"].includes(name) ? ObjectType.Vehicle : ObjectType.Building, baseNormal: true,
    } }));
    const enemy = { id: 999, tile: { rx: 22, ry: 0 }, rules: { name: "MTNK", isSelectableCombatant: true, type: ObjectType.Vehicle } };
    const game: any = { getCurrentTick: () => 6000, getPlayerData: () => player,
        getVisibleUnits: (_: string, relation: string, filter: any) => (relation === "self" ? owned : pressured ? [enemy] : []).filter(unit => filter(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => id === 999 ? enemy : owned.find(unit => unit.id === id),
        getGameObjectData: (id: number) => game.getUnitData(id), getBuildingPlacementData: () => ({ foundation: { width: 1, height: 1 } }),
        canPlaceBuilding: () => true,
        mapApi: { getStartingLocations: () => [player.startLocation, new Vector2(distance, 0)],
            getAllTilesResourceData: () => [{ tile: { rx: 25, ry: 0 }, ore: 800, gems: 0 }],
            isVisibleTile: () => true, getResourceCreditValues: () => ({ ore: 10, gems: 20 }),
            getTilesInRect: () => [{ id: "24_0", rx: 24, ry: 0 }] },
    };
    return (name: string, extra = {}, committed = false) => getEconomyBuildingPriority(game, player, { name, cost: 2000, adjacent: 100, ...extra } as any, committed);
}

test.each(["Americans", "Alliance", "French", "Germans", "British"])("%s funds a first factory before a new radar at nearby possible starts", country => {
    const opening = scenario(["GAREFN", "CMIN"], 5000, 65, country);
    expect(opening("GAWEAP")).toBeGreaterThan(0);
    expect(opening(country === "Americans" ? "AMRADR" : "GAAIRC")).toBe(0);
    const established = scenario(["GAREFN", "GAWEAP", "CMIN", "CMIN", "MTNK", "MTNK"], 5000, 65, country);
    expect(established("GAAIRC")).toBeUndefined(); // Existing later tech rules can now consider it.
});

test("distant allied starts retain the existing funded air opening", () => {
    const distant = scenario(["GAREFN", "CMIN"], 5000, 120, "French");
    expect(distant("GAAIRC")).toBeGreaterThan(distant("GAWEAP")!);
});

test("losing a factory does not cancel the radar investment already in progress", () => {
    const rebuilding = scenario(["GAREFN", "CMIN"], 5000, 65, "French");
    expect(rebuilding("GAAIRC", {}, true)).toBeGreaterThan(0);
});

test("captured allied tech does not change a Soviet opening policy", () => {
    const soviet = scenario(["NAREFN", "HARV"], 5000, 65);
    expect(soviet("GAAIRC")).toBe(45);
});

test("an opening funds barracks, income and its first factory before optional Soviet tech", () => {
    const empty = scenario([]);
    expect(empty("NAHAND")).toBeGreaterThan(empty("NAREFN", { refinery: true })!);
    expect(empty("NAWEAP")).toBe(0);
    const opening = scenario(["NAHAND", "NAREFN", "HARV"]);
    expect(opening("NAWEAP")).toBeGreaterThan(0);
    expect(opening("NARADR")).toBe(0);
    expect(opening("NADEPT")).toBe(0);
    expect(opening("NAREFN", { refinery: true })).toBe(0);
});

test("Soviet tech and duplicate factories require miners and an existing armor core", () => {
    const established = scenario(["NAREFN", "NAWEAP", "HARV", "HARV", "HARV", "HTNK", "HTNK"]);
    expect(established("NARADR")).toBeGreaterThan(0);
    expect(established("NATECH")).toBeGreaterThan(0);
    expect(established("NAWEAP")).toBe(0);
    const rich = scenario(["NAREFN", "NAWEAP", "HARV", "HARV", "HARV", "HARV", "HARV", "HARV", "HTNK", "HTNK"]);
    expect(rich("NAWEAP")).toBeGreaterThan(0);
});

test("under pressure the existing two-rocketeer refinery exception is retained", () => {
    const one = scenario(["GAREFN", "CMIN", "GAAIRC", "JUMPJET"], 5000, 120, "Arabs", true);
    expect(one("GAREFN", { refinery: true })).toBe(0);
    const covered = scenario(["GAREFN", "CMIN", "GAAIRC", "JUMPJET", "JUMPJET"], 5000, 120, "Arabs", true);
    expect(covered("GAREFN", { refinery: true })).toBeGreaterThan(covered("GAWEAP")!);
});

test("two miners and four tanks can fund a second refinery incrementally when cash is drained", () => {
    for (const credits of [62, 500, 999]) {
        const established = scenario(["NAREFN", "NAWEAP", "HARV", "HARV", "HTNK", "HTNK", "HTNK", "HTNK"], credits, 120, "Arabs", true);
        expect(established("NAREFN", { refinery: true })).toBeGreaterThan(0);
    }
});

test("under pressure a cash-starved one-miner or incomplete tank opening does not add a second refinery", () => {
    for (const names of [
        ["NAREFN", "NAWEAP", "HARV", "HTNK", "HTNK", "HTNK", "HTNK"],
        ["NAREFN", "NAWEAP", "HARV", "HARV", "HTNK", "HTNK"],
    ]) {
        expect(scenario(names, 62, 120, "Arabs", true)("NAREFN", { refinery: true })).toBe(0);
    }
});

test.each([
    ["NAREFN", "NAWEAP", "HARV", "HTNK"],
    ["GAREFN", "GAWEAP", "CMIN", "MTNK"],
])("a funded %s opening uses the second refinery's supplied miner after the first tank", (refinery, factory, miner, tank) => {
    const opening = scenario([refinery, factory, miner, tank], 3000, 120, "Arabs", true);
    expect(opening(refinery, { refinery: true, cost: 2000, freeUnit: miner })).toBeGreaterThan(0);
    expect(scenario([refinery, factory, miner, tank], 2399, 120, "Arabs", true)(refinery, { refinery: true, cost: 2000, freeUnit: miner })).toBe(0);
    expect(scenario([refinery, factory, miner], 3000, 120, "Arabs", true)(refinery, { refinery: true, cost: 2000, freeUnit: miner })).toBe(0);
    expect(opening(refinery, { refinery: true, cost: 2000, freeUnit: "DOG" })).toBe(0);
});

function defensiveScenario(name: string, initialTick: number) {
    let tick = initialTick;
    const own = { id: 1, tile: { rx: 0, ry: 0 }, type: ObjectType.Building,
        rules: { name: "NACNST", constructionYard: true } };
    const enemy = { id: 2, tile: { rx: 3, ry: 3 }, type: ObjectType.Vehicle,
        rules: { name: "HTNK", type: ObjectType.Vehicle, isSelectableCombatant: true, primary: "120mm" } };
    const player: any = { name, credits: 5000, country: { name: "Arabs" }, startLocation: new Vector2() };
    const game: any = {
        getCurrentTick: () => tick,
        getVisibleUnits: (_name: string, relation: string, predicate: any) =>
            [relation === "self" ? own : enemy].filter(unit => predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => id === own.id ? own : enemy,
    };
    return { game, player, at(value: number) { tick = value; },
        priority: (committed = false) => getEconomyBuildingPriority(game, player, { name: "NALASR" } as any, committed) };
}

test("a previous match cannot suppress reactive defence for the same player name", () => {
    const previous = defensiveScenario("defence-restart", 1000);
    expect(previous.priority(true)).toBe(70);
    const next = defensiveScenario("defence-restart", 1500);
    expect(next.priority()).toBe(70);
});

test("independent games at the same tick retain independent defence cooldowns", () => {
    const first = defensiveScenario("defence-parallel", 6000);
    expect(first.priority(true)).toBe(70);
    const second = defensiveScenario("defence-parallel", 6000);
    expect(second.priority()).toBe(70);
});

test("reactive defence still respects its cooldown within a match", () => {
    const current = defensiveScenario("defence-current", 1000);
    expect(current.priority(true)).toBe(70);
    current.at(1449);
    expect(current.priority()).toBe(0);
    current.at(1450);
    expect(current.priority()).toBe(70);
});

test("different players sharing a game do not share a defence cooldown", () => {
    const current = defensiveScenario("defence-player-one", 1000);
    expect(current.priority(true)).toBe(70);
    expect(getEconomyBuildingPriority(current.game, { ...current.player, name: "defence-player-two" }, { name: "NALASR" } as any, false)).toBe(70);
});

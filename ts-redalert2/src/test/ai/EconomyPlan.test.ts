import { expect, test } from "bun:test";
import { getEconomyBuildingPriority } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/economyPlan";

function scenario(names: string[], credits = 5000, distance = 120, country = "Arabs") {
    const owned = names.map(name => ({ name, harvester: ["HARV", "CMIN"].includes(name) }));
    const game: any = { getCurrentTick: () => 6000,
        mapApi: { getStartingLocations: () => [{ distanceTo: () => distance }] },
        getVisibleUnits: (_: string, relation: string, filter: any) => relation === "self" ? owned.filter(filter).map((_, i) => i) : [] };
    const player: any = { name: "bot", country: { name: country }, credits };
    return (name: string, extra = {}, committed = false) => getEconomyBuildingPriority(game, player, { name, ...extra } as any, committed);
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
    const rich = scenario(["NAREFN", "NAWEAP", "HARV", "HARV", "HARV", "HARV", "HTNK", "HTNK"]);
    expect(rich("NAWEAP")).toBeGreaterThan(0);
});

test("two opening rocketeers fund a second refinery before another military factory investment", () => {
    const one = scenario(["GAREFN", "CMIN", "GAAIRC", "JUMPJET"]);
    expect(one("GAREFN", { refinery: true })).toBe(0);
    const covered = scenario(["GAREFN", "CMIN", "GAAIRC", "JUMPJET", "JUMPJET"]);
    expect(covered("GAREFN", { refinery: true })).toBeGreaterThan(covered("GAWEAP")!);
});

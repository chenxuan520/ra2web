import { expect, test } from "bun:test";
import { getEconomyBuildingPriority } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/economyPlan";

function scenario(names: string[], credits = 5000) {
    const owned = names.map(name => ({ name, harvester: ["HARV", "CMIN"].includes(name) }));
    const game: any = { getCurrentTick: () => 6000,
        getVisibleUnits: (_: string, relation: string, filter: any) => relation === "self" ? owned.filter(filter).map((_, i) => i) : [] };
    const player: any = { name: "bot", country: { name: "Arabs" }, credits };
    return (name: string, extra = {}) => getEconomyBuildingPriority(game, player, { name, ...extra } as any, false);
}

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

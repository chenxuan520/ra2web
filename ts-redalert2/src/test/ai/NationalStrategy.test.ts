import { describe, expect, test } from "bun:test";
import { readStrategicSituation, selectNationalComposition, type StrategicSituation } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/nationalComposition";
import { ObjectType } from "../../game/ai/thirdpartbot/builtIn/game-api";

function situation(country = "Arabs"): StrategicSituation {
    return { country, tick: 6000, credits: 1500, harvesters: 2, own: { HTNK: 4 },
        enemy: { infantry: 5, vehicles: 0, aircraft: 0, defences: 0 } };
}
const soviet = { composition: { HTNK: 5, HTK: 1 }, minimumUnits: 4, maximumUnits: 6 };
const allied = { composition: { MTNK: 5, FV: 1 }, minimumUnits: 4, maximumUnits: 6 };

describe("national and late-game army composition", () => {
    test("Iraq leaves desolators to the independent positional defence mission", () => {
        const result = selectNationalComposition(soviet, new Set(["HTNK", "HTK", "DESO"]), situation());
        expect(result).toBe(soviet);
        expect(soviet.composition).toEqual({ HTNK: 5, HTK: 1 });
    });

    test.each(["unavailable", "unscouted", "poor", "capped", "wrong-country"])("does not request a desolator when %s", reason => {
        const state = situation();
        const available = new Set(["HTNK", "HTK", "DESO"]);
        if (reason === "unavailable") available.delete("DESO");
        if (reason === "unscouted") state.enemy.infantry = 0;
        if (reason === "poor") state.harvesters = 1;
        if (reason === "capped") state.own.DESO = 2;
        if (reason === "wrong-country") state.country = "Russians";
        expect(selectNationalComposition(soviet, available, state)).toBe(soviet);
    });

    test("British snipers answer infantry, German destroyers answer armored forces", () => {
        const state = situation("British");
        expect(selectNationalComposition(allied, new Set(["SNIPE"]), state).supportUnits).toEqual({ SNIPE: 1 });
        state.country = "Germans";
        expect(selectNationalComposition(allied, new Set(["TNKD"]), state)).toBe(allied);
        state.enemy = { infantry: 1, vehicles: 5, aircraft: 0, defences: 0 };
        expect(selectNationalComposition(allied, new Set(["TNKD"]), state).supportUnits).toEqual({ TNKD: 1 });
    });

    test("Russian tesla support requires ground targets and an affordable established army", () => {
        const state = situation("Russians");
        expect(selectNationalComposition(soviet, new Set(["TTNK"]), state).supportUnits).toEqual({ TTNK: 1 });
        state.credits = 500;
        expect(selectNationalComposition(soviet, new Set(["TTNK"]), state)).toBe(soviet);
    });

    test("late heavy support requires economy, actual tech and armor targets while retaining the core", () => {
        const state = situation("Americans");
        state.tick = 9000;
        state.credits = 3000;
        state.own = { MTNK: 5 };
        state.enemy = { infantry: 0, vehicles: 5, aircraft: 0, defences: 0 };
        expect(selectNationalComposition(allied, new Set(), state)).toBe(allied);
        const result = selectNationalComposition(allied, new Set(["MGTK"]), state);
        expect(result.supportUnits).toEqual({ MGTK: 1 });
        expect(result.composition.MTNK).toBe(5);
        expect(result.composition.FV).toBe(1);
        expect(result.maximumUnits).toBe(8);
        state.own.MGTK = 4;
        expect(selectNationalComposition(allied, new Set(["MGTK"]), state)).toBe(allied);
    });

    test("barracks-only waves do not acquire expensive or radioactive support", () => {
        const infantry = { composition: { E2: 1 }, minimumUnits: 3, maximumUnits: 6 };
        expect(selectNationalComposition(infantry, new Set(["DESO"]), situation())).toBe(infantry);
    });

    test("another preparing wave's undelivered support occupies the global cap", () => {
        const state = situation();
        state.own.DESO = 1;
        expect(selectNationalComposition(soviet, new Set(["DESO"]), state, { DESO: 1 })).toBe(soviet);
    });

    test("strategic observations use only visible enemies and cache within one game tick", () => {
        let tick = 1;
        let scans = 0;
        const own = [{ name: "HARV", harvester: true }, { name: "HTNK", type: ObjectType.Vehicle }];
        const visible: any[] = [{ name: "E1", type: ObjectType.Infantry, isSelectableCombatant: true },
            { name: "GAPILL", type: ObjectType.Building, isSelectableCombatant: false, primary: "Vulcan2" },
            { name: "GAWEAP", type: ObjectType.Building, isSelectableCombatant: false }];
        const game = { getCurrentTick: () => tick,
            getVisibleUnits: (_name: string, side: string, filter: (rules: any) => boolean) => {
                scans++;
                expect(["self", "enemy"]).toContain(side);
                return (side === "self" ? own : visible).filter(filter).map((_, id) => id);
            } };
        const player = { name: "bot", country: { name: "Arabs" }, credits: 1000 };
        const first = readStrategicSituation(game as any, player as any);
        expect(first.harvesters).toBe(1);
        expect(first.enemy.infantry).toBe(1);
        expect(first.enemy.defences).toBe(1);
        expect(readStrategicSituation(game as any, player as any)).toBe(first);
        expect(scans).toBe(2);
        tick++;
        visible.length = 0;
        expect(readStrategicSituation(game as any, player as any).enemy.infantry).toBe(0);
    });
});

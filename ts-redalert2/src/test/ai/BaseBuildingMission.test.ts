import { describe, expect, test } from "bun:test";
import { BaseBuildingMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseBuildingMission";
import { ObjectType, QueueType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";
import type { MissionContext } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/context";

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
        player: { name: "bot", production: { getAvailableObjects: (queue: QueueType) => {
            expect(queue).toBe(QueueType.Structures);
            return options;
        } } },
        matchAwareness: { getThreatCache: () => null },
    };
    const mission = new BaseBuildingMission(QueueType.Structures, () => {});
    return { options, rules, legalLocations, placementChecks, run: () => mission._onAiUpdate(context as unknown as MissionContext) };
}

describe("brutal building placement fallback", () => {
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

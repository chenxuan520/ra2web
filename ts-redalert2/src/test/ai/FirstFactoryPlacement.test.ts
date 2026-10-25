import { describe, expect, test } from "bun:test";
import { getCompactFirstFactoryPlacement, hasClearWarFactoryExit } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/firstFactoryPlacement";
import { BaseBuildingMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseBuildingMission";
import { ObjectType, QueueType, SpeedType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";

function fixture() {
    const player = { name: "bot", credits: 6000, startLocation: new Vector2(10, 10) };
    const factory = { name: "NAWEAP", type: ObjectType.Building, adjacent: 2 };
    const objects: any[] = [{ id: 1, name: "NACNST", tile: { rx: 10, ry: 10, z: 0 }, foundation: { width: 3, height: 3 },
        rules: { name: "NACNST", type: ObjectType.Building, constructionYard: true, baseNormal: true } }];
    const candidates = [{ id: "wrong-door", rx: 4, ry: 10, z: 0 }, { id: "clear-door", rx: 14, ry: 10, z: 0 }];
    const blocked = new Set<string>();
    const hidden = new Set<string>();
    const bridges = new Set<string>();
    const heights = new Map<string, number>();
    const speedChecks: number[] = [];
    let legal = true;
    const game = {
        getPlayerData: () => player,
        getVisibleUnits: (_name: string, _side: string, filter: (rules: any) => boolean) => objects.filter(object => filter(object.rules)).map(object => object.id),
        getGameObjectData: (id: number) => objects.find(object => object.id === id),
        getUnitData: (id: number) => objects.find(object => object.id === id),
        getBuildingPlacementData: () => ({ foundation: { width: 5, height: 3 } }),
        canPlaceBuilding: () => legal,
        mapApi: {
            getTilesInRect: (rect: any) => candidates.filter(tile => tile.rx >= rect.x && tile.rx < rect.x + rect.width &&
                tile.ry >= rect.y && tile.ry < rect.y + rect.height),
            getTile: (rx: number, ry: number) => ({ rx, ry, z: heights.get(`${rx},${ry}`) ?? 0 }),
            isVisibleTile: (tile: any) => !hidden.has(`${tile.rx},${tile.ry}`),
            hasBridgeOnTile: (tile: any) => bridges.has(`${tile.rx},${tile.ry}`),
            isPassableTile: (tile: any, speed: number, onBridge: boolean, isFoot: boolean) => {
                expect(onBridge).toBe(false);
                expect(isFoot).toBe(false);
                speedChecks.push(speed);
                return !blocked.has(`${tile.rx},${tile.ry}`);
            },
            getObjectsOnTile: (tile: any) => objects.filter(object => tile.rx >= object.tile.rx &&
                tile.rx < object.tile.rx + (object.foundation?.width ?? 1) && tile.ry >= object.tile.ry &&
                tile.ry < object.tile.ry + (object.foundation?.height ?? 1)).map(object => object.id),
        },
    };
    const context = { game, player: { name: "bot", production: { getAvailableObjects: () => [factory], getQueueData: () => ({ items: [] }) } },
        matchAwareness: { getThreatCache: () => null } };
    return { game, player, factory, objects, blocked, hidden, bridges, heights, speedChecks, setLegal: (value: boolean) => legal = value,
        run: (difficulty: "normal" | "brutal") => new BaseBuildingMission(QueueType.Structures, () => {})._onAiUpdate({ ...context, difficulty } as any) };
}

describe("first war factory placement fallback", () => {
    test("only brutal retries a one-tile gap and rejects a door pointing into the conyard", () => {
        const f = fixture();
        expect(f.run("normal")).toEqual({ type: "noop" });
        expect(f.run("brutal")).toMatchObject({ type: "buildStructureAtLocation", rulesName: "NAWEAP", rx: 14, ry: 10 });
        expect(f.speedChecks).toContain(SpeedType.Track);
        expect(f.speedChecks).toContain(SpeedType.Wheel);
    });

    test("never relaxes additional factories or another building type", () => {
        const f = fixture();
        expect(getCompactFirstFactoryPlacement(f.game as any, f.player as any, { ...f.factory, name: "NARADR" } as any)).toBeUndefined();
        f.objects.push({ id: 2, tile: { rx: 30, ry: 30 }, rules: { name: "GAWEAP", type: ObjectType.Building } });
        expect(getCompactFirstFactoryPlacement(f.game as any, f.player as any, f.factory as any)).toBeUndefined();
    });

    test("engine placement legality remains mandatory", () => {
        const f = fixture();
        f.setLegal(false);
        expect(f.run("brutal")).toEqual({ type: "noop" });
    });

    test.each(["terrain", "height", "bridge", "hidden", "unit"])("rejects a fixed external exit with %s obstruction", reason => {
        const f = fixture();
        if (reason === "terrain") f.blocked.add("19,11");
        if (reason === "height") f.heights.set("19,11", 1);
        if (reason === "bridge") f.bridges.add("19,11");
        if (reason === "hidden") f.hidden.add("19,11");
        if (reason === "unit") f.objects.push({ id: 2, tile: { rx: 19, ry: 11 }, zone: ZoneType.Ground,
            rules: { name: "MTNK", type: ObjectType.Vehicle } });
        expect(hasClearWarFactoryExit(f.game as any, f.player as any, { rx: 14, ry: 10, z: 0 } as any, 5, 3)).toBe(false);
    });

    test("a flying unit over the exit does not obstruct the ground route", () => {
        const f = fixture();
        f.objects.push({ id: 2, tile: { rx: 19, ry: 11 }, zone: ZoneType.Air, rules: { name: "ZEP", type: ObjectType.Vehicle } });
        expect(hasClearWarFactoryExit(f.game as any, f.player as any, { rx: 14, ry: 10, z: 0 } as any, 5, 3)).toBe(true);
    });
});

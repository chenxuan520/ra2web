import { describe, expect, test } from "bun:test";
import { getCompactFirstFactoryPlacement, getEconomicFirstFactoryPlacement, hasClearWarFactoryExit } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/firstFactoryPlacement";
import { BaseBuildingMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseBuildingMission";
import { ObjectType, QueueType, SpeedType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";

function fixture() {
    const player = { name: "bot", credits: 6000, startLocation: new Vector2(10, 10) };
    const factory = { name: "NAWEAP", type: ObjectType.Building, adjacent: 2 };
    const objects: any[] = [{ id: 1, name: "NACNST", tile: { rx: 10, ry: 10, z: 0 }, foundation: { width: 3, height: 3 },
        rules: { name: "NACNST", type: ObjectType.Building, constructionYard: true, baseNormal: true } },
        { id: 99, name: "NAREFN", tile: { rx: 40, ry: 40, z: 0 }, foundation: { width: 3, height: 3 },
            rules: { name: "NAREFN", type: ObjectType.Building, refinery: true, baseNormal: true } }];
    const candidates = [{ id: "wrong-door", rx: 4, ry: 10, z: 0 }, { id: "clear-door", rx: 14, ry: 10, z: 0 }];
    const blocked = new Set<string>();
    const hidden = new Set<string>();
    const bridges = new Set<string>();
    const heights = new Map<string, number>();
    const speedChecks: number[] = [];
    const resources: any[] = [];
    let legal = true;
    const game = {
        getCurrentTick: () => 0,
        getPlayerData: () => player,
        getVisibleUnits: (_name: string, side: string, filter: (rules: any) => boolean) => objects
            .filter(object => (side === "enemy" ? object.owner === "enemy" : object.owner !== "enemy") && filter(object.rules)).map(object => object.id),
        getGameObjectData: (id: number) => objects.find(object => object.id === id),
        getUnitData: (id: number) => objects.find(object => object.id === id),
        getBuildingPlacementData: () => ({ foundation: { width: 5, height: 3 } }),
        canPlaceBuilding: () => legal,
        mapApi: {
            getAllTilesResourceData: () => resources,
            getResourceCreditValues: () => ({ ore: 10, gems: 20 }),
            getStartingLocations: () => [player.startLocation, new Vector2(100, 100)],
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
    return { game, player, factory, objects, candidates, resources, blocked, hidden, bridges, heights, speedChecks, setLegal: (value: boolean) => legal = value,
        run: (difficulty: "normal" | "brutal") => new BaseBuildingMission(QueueType.Structures, () => {})._onAiUpdate({ ...context, difficulty } as any) };
}

describe("first war factory placement fallback", () => {
    test("a legal backward generic site cannot suppress a clear first-factory advance toward a known unserved field", () => {
        const f = fixture(); f.factory.adjacent = 3;
        f.candidates.push({ id: "backward", rx: 3, ry: 10, z: 0 });
        f.resources.push({ tile: { rx: 30, ry: 10 }, ore: 800, gems: 0, spawnsOre: false });
        expect(f.run("normal")).toMatchObject({ rx: 3, ry: 10 });
        expect(f.run("brutal")).toMatchObject({ rx: 14, ry: 10 });
    });
    test("the first factory reaches the nearer visible income field before chasing a richer distant one", () => {
        const f = fixture(); f.factory.adjacent = 3;
        f.candidates.push({ id: "near-income", rx: 3, ry: 10, z: 0 });
        f.resources.push({ tile: { rx: 0, ry: 10 }, ore: 800, gems: 0, spawnsOre: false },
            { tile: { rx: 30, ry: 10 }, ore: 8000, gems: 0, spawnsOre: false });
        expect(f.run("brutal")).toMatchObject({ rx: 3, ry: 10 });
    });
    test.each(["pressure", "hidden"])("a %s field cannot redirect the first factory away from its original legal site", condition => {
        const f = fixture(); f.factory.adjacent = 3;
        f.candidates.push({ id: "backward", rx: 3, ry: 10, z: 0 });
        const resource = { tile: { rx: 30, ry: 10 }, ore: 800, gems: 0, spawnsOre: false };
        f.resources.push(resource);
        if (condition === "pressure") f.objects.push({ id: 200, owner: "enemy", tile: { rx: 22, ry: 10 },
            rules: { name: "MTNK", type: ObjectType.Vehicle, isSelectableCombatant: true } });
        else {
            f.hidden.add("30,10");
            Object.defineProperty(resource, "ore", { get() { throw Error("hidden ore cannot guide construction"); } });
        }
        expect(f.run("brutal")).toMatchObject({ rx: 3, ry: 10 });
    });
    test.each(["second", "type", "illegal", "exit", "served", "far", "backward", "defence"])("economic first-factory placement rejects the %s condition", condition => {
        const f = fixture(); f.factory.adjacent = 3;
        f.candidates.push({ id: "backward", rx: 3, ry: 10, z: 0 });
        const resource = { tile: { rx: 30, ry: 10 }, ore: 800, gems: 0, spawnsOre: false }; f.resources.push(resource);
        if (condition === "second") f.objects.push({ id: 2, tile: { rx: 40, ry: 30 }, rules: { name: "GAWEAP", type: ObjectType.Building } });
        if (condition === "type") f.factory.name = "NARADR";
        if (condition === "illegal") f.setLegal(false);
        if (condition === "exit") f.blocked.add("19,11");
        if (condition === "served") f.objects[1].tile = { rx: 30, ry: 10, z: 0 };
        if (condition === "far") resource.tile.rx = 80;
        if (condition === "backward") f.candidates.splice(0, 2);
        if (condition === "defence") f.objects.push({ id: 200, owner: "enemy", tile: { rx: 30, ry: 10 },
            rules: { name: "NALASR", type: ObjectType.Building, primary: {} } });
        expect(getEconomicFirstFactoryPlacement(f.game as any, f.player as any, f.factory as any)).toBeUndefined();
    });
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

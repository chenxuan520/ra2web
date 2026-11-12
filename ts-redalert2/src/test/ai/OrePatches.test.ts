import { describe, expect, test } from "bun:test";
import { ObjectType, QueueType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { BaseBuildingMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseBuildingMission";
import { ResourceCollectionBuilding, planRefinery } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/resourceCollectionBuilding";
import { findVisiblePatches, isServed, minersOn, patchDistance, scorePatch, type OrePatch }
    from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/orePatches";
import { findPatches } from "../../../e2e/league/ecoCore";

const values = { ore: 10, gems: 20 };
const point = (rx: number, ry: number) => ({ rx, ry });
const resource = (rx: number, ry: number, ore = 200, gems = 0, spawnsOre = false) =>
    ({ tile: point(rx, ry), ore, gems, spawnsOre });
const object = (id: number, rx: number, ry: number, rules: Record<string, any> = {}) =>
    ({ id, tile: point(rx, ry), foundation: { width: 1, height: 1 },
        rules: { name: "GACNST", type: ObjectType.Building, baseNormal: true, ...rules } });
const key = (tile: { rx: number; ry: number }) => `${tile.rx}_${tile.ry}`;

function fixture() {
    let tick = 0, resourceReads = 0;
    const player = { name: "bot", startLocation: new Vector2(), credits: 10000, power: { total: 200, drain: 0 } };
    const rules = { name: "GAREFN", type: ObjectType.Building, refinery: true, adjacent: 100 };
    const buildings = [object(1, 0, 0, { constructionYard: true })];
    const enemies: ReturnType<typeof object>[] = [];
    const resources = [resource(2, 0, 1000), resource(0, 6, 0, 400)];
    const candidates = [point(3, 0), point(0, 5)].map(tile => ({ ...tile, id: key(tile) }));
    const hidden = new Map<string, Set<string>>();
    const hiddenUnits = new Set<number>();
    const legal = new Set(candidates.map(key));
    const starts = [player.startLocation, new Vector2(200, 0)];
    const game: any = {
        getCurrentTick: () => tick,
        getPlayerData: (name: string) => {
            if (name !== "bot" && name !== "bot2") throw new Error("Private enemy player read");
            return { ...player, name };
        },
        getVisibleUnits: (name: string, relation: string, predicate = (_rules: any) => true) => {
            expect(["bot", "bot2"]).toContain(name);
            return (relation === "self" ? buildings : enemies)
                .filter(unit => !hiddenUnits.has(unit.id) && predicate(unit.rules)).map(unit => unit.id);
        },
        getGameObjectData: (id: number) => {
            if (hiddenUnits.has(id)) throw new Error("Hidden enemy object read");
            return [...buildings, ...enemies].find(unit => unit.id === id);
        },
        getUnitData: (id: number) => game.getGameObjectData(id),
        getUnitsInArea: (box: any) => buildings.filter(unit => box.containsPoint(new Vector2(unit.tile.rx, unit.tile.ry))).map(unit => unit.id),
        getBuildingPlacementData: () => ({ foundation: { width: 1, height: 1 } }),
        canPlaceBuilding: (_name: string, _building: string, tile: { rx: number; ry: number }) => {
            return legal.has(key(tile));
        },
        mapApi: {
            getAllTilesResourceData: () => { resourceReads++; return resources; },
            getResourceCreditValues: () => values,
            isVisibleTile: (tile: { rx: number; ry: number }, name: string) => !hidden.get(name)?.has(key(tile)),
            getStartingLocations: () => starts,
            getTilesInRect: (rect: { x: number; y: number; width: number; height: number }) => candidates.filter(tile =>
                tile.rx >= rect.x && tile.rx < rect.x + rect.width && tile.ry >= rect.y && tile.ry < rect.y + rect.height),
        },
    };
    const logic = new ResourceCollectionBuilding(10, 3);
    const placement = (difficulty?: "normal" | "brutal") =>
        (logic.getPlacementLocation as any)(game, player, rules, difficulty);
    const mission = new BaseBuildingMission(QueueType.Structures, () => {});
    const run = (difficulty: "normal" | "brutal") => mission._onAiUpdate({ game, difficulty,
        player: { name: player.name, production: { getAvailableObjects: () => [rules], getQueueData: () => ({ items: [] }) } },
        matchAwareness: { getThreatCache: () => null } } as any);
    return { game, player, rules, buildings, enemies, resources, candidates, hidden, hiddenUnits, legal, starts,
        placement, run, at(value: number) { tick = value; }, reads: () => resourceReads };
}

function patch(rx: number, ry: number, value = 8000, gemValue = 0, tiles = [point(rx, ry)]): OrePatch {
    return { id: key(tiles[0]), tiles,
        center: point(Math.round(tiles.reduce((sum, tile) => sum + tile.rx, 0) / tiles.length),
            Math.round(tiles.reduce((sum, tile) => sum + tile.ry, 0) / tiles.length)),
        value, gemValue, isGem: gemValue >= value * 0.5, regrows: false };
}

function setCandidates(f: ReturnType<typeof fixture>, tiles: { rx: number; ry: number }[]) {
    f.candidates.splice(0, f.candidates.length, ...tiles.map(tile => ({ ...tile, id: key(tile) })));
    f.legal.clear();
    tiles.forEach(tile => f.legal.add(key(tile)));
}

describe("visible economic patches", () => {
    test.each([
        [resource(0, 0), resource(2, 2), resource(4, 4), resource(7, 4)],
        [resource(0, 0, 100, 50), resource(10, 0, 101, 50)],
        [resource(0, 0, 199), resource(10, 0, 200)],
        [resource(0, 0, 1), resource(4, 0, 0, 0, true), resource(10, 0, 1), resource(14, 1, 0, 0, true)],
        [resource(0, 0), resource(2, 0, 0, 0, true), resource(4, 0)],
        [resource(10, 0), resource(8, 1), resource(8, 0), resource(8, 0, 100, 25), resource(8, 0, 0, 0, true)],
        [resource(-2, -2), resource(-1, -1)],
    ])("matches every E1 field for clustering, values, IDs, centers and regrowth (%#)", (...input) => {
        const f = fixture();
        f.resources.splice(0, f.resources.length, ...input);
        const before = structuredClone(input);
        const expected = findPatches(input.map(({ tile, ...data }) => ({ ...tile, ...data })), values);
        expect(findVisiblePatches(f.game, f.player.name)).toEqual(expected);
        expect(findVisiblePatches({ ...f.game } as any, f.player.name)).toEqual(expected);
        expect(input).toEqual(before);
    });

    test("runtime resource prices determine total value and the inclusive half-gem boundary", () => {
        const f = fixture();
        f.resources.splice(0, f.resources.length, resource(0, 0, 100, 100), resource(10, 0, 101, 100));
        f.game.mapApi.getResourceCreditValues = () => ({ ore: 20, gems: 20 });
        expect(findVisiblePatches(f.game, "bot").map(p => [p.value, p.gemValue, p.isGem])).toEqual([
            [4000, 2000, true], [4020, 2000, false],
        ]);
    });

    test("filters visibility before reading hidden amounts or spawning flags; hidden points cannot connect or regrow patches", () => {
        const f = fixture();
        f.resources.splice(0, f.resources.length, resource(0, 0), resource(2, 0), resource(4, 0),
            resource(20, 0, 1), resource(24, 0, 0, 0, true));
        f.hidden.set("bot", new Set(["2_0", "24_0"]));
        for (const hidden of [f.resources[1], f.resources[4]]) for (const field of ["ore", "gems", "spawnsOre"]) {
            Object.defineProperty(hidden, field, { get() { throw new Error("Hidden resource read"); } });
        }
        expect(findVisiblePatches(f.game, "bot").map(p => p.id)).toEqual(["0_0", "4_0"]);
    });

    test("caches for ninety simulation ticks independently for each player and game, and refreshes on tick rollback", () => {
        const f = fixture();
        f.at(25);
        const first = findVisiblePatches(f.game, "bot");
        f.resources[0].ore = 200;
        f.hidden.set("bot2", new Set(["0_6"]));
        f.at(114);
        expect(findVisiblePatches(f.game, "bot")).toBe(first);
        expect(f.reads()).toBe(1);
        expect(findVisiblePatches(f.game, "bot2").map(p => p.id)).toEqual(["2_0"]);
        expect(f.reads()).toBe(2);
        f.at(115);
        const updated = findVisiblePatches(f.game, "bot");
        expect(updated).not.toBe(first);
        expect(updated.find(p => p.id === "2_0")?.value).toBe(2000);
        expect(f.reads()).toBe(3);
        expect(findVisiblePatches({ ...f.game } as any, "bot")).toEqual(updated);
        expect(f.reads()).toBe(4);
        f.at(0);
        expect(findVisiblePatches(f.game, "bot")).not.toBe(updated);
        expect(f.reads()).toBe(5);
    });

    test("serving and miner distances use the nearest tile, include nine and six, and assign a miner only to its nearest patch", () => {
        const p = patch(0, 0, 8000, 0, [point(0, 0), point(2, 0)]), other = patch(12, 0);
        expect(patchDistance(point(2, 9), p)).toBe(9);
        expect(isServed(p, [point(2, 9)])).toBe(true);
        expect(isServed(p, [point(2, 10)])).toBe(false);
        expect(minersOn(p, [point(2, 6), point(2, 7)])).toBe(1);
        const miners = [point(7, 0), point(8, 0)];
        expect(minersOn(p, miners, [other, p])).toBe(1);
        expect(minersOn(other, miners, [p, other])).toBe(1);
        expect(isServed(p, [])).toBe(false);
        expect(minersOn(p, [])).toBe(0);
    });
});

describe("economic patch scores", () => {
    test("near gems score 10000 versus ordinary ore 8333; far gems score 5333", () => {
        const f = fixture();
        expect(scorePatch(f.game, f.player as any, patch(0, 6, 8000, 8000))).toMatchObject({ g: 6, score: 10000 });
        expect(scorePatch(f.game, f.player as any, patch(2, 0, 10000))?.score).toBeCloseTo(10000 / 1.2);
        expect(scorePatch(f.game, f.player as any, patch(0, 20, 8000, 8000))?.score).toBeCloseTo(16000 / 3);
    });

    test("caps effective value at 40000 and ignores actual wall rules and nonbuilding units as anchors", () => {
        const f = fixture();
        const wall = object(2, 0, 5, { wall: true });
        Object.defineProperty(wall.rules, "isWall", { get() { throw new Error("Invented wall field"); } });
        f.buildings.push(wall, object(3, 0, 6, { type: ObjectType.Vehicle, isSelectableCombatant: true }));
        expect(scorePatch(f.game, f.player as any, patch(0, 6, 30000, 30000))).toMatchObject({ g: 6, score: 25000 });
        f.buildings.push(object(4, 0, 4));
        expect(scorePatch(f.game, f.player as any, patch(0, 6, 30000, 30000))).toMatchObject({ g: 2, score: 40000 / 1.2 });
    });

    test("already served patches are excluded at nine tiles, not ten", () => {
        const f = fixture(), refinery = object(2, 0, -3, { refinery: true });
        f.buildings.push(refinery);
        expect(scorePatch(f.game, f.player as any, patch(0, 6))).toBeUndefined();
        refinery.tile.ry = -4;
        expect(scorePatch(f.game, f.player as any, patch(0, 6))).toBeDefined();
    });

    test("opponent-half exclusion ends exactly at tick 9000; midpoint ties and swapped public starts stay correct", () => {
        const f = fixture();
        f.starts[1] = new Vector2(100, 0);
        f.at(8999);
        expect(scorePatch(f.game, f.player as any, patch(60, 0))).toBeUndefined();
        expect(scorePatch(f.game, f.player as any, patch(50, 0))).toBeDefined();
        f.at(9000);
        expect(scorePatch(f.game, f.player as any, patch(60, 0))).toBeDefined();
        f.player.startLocation = new Vector2(100, 0);
        f.starts.splice(0, 2, new Vector2(), f.player.startLocation);
        f.at(8999);
        expect(scorePatch(f.game, f.player as any, patch(40, 0))).toBeUndefined();
        expect(scorePatch(f.game, f.player as any, patch(60, 0))).toBeDefined();
    });

    test("half comparison is to the closest patch tile rather than its center and uses the nearest public opposing start", () => {
        const f = fixture();
        f.starts.splice(0, 2, new Vector2(), new Vector2(20, 0), new Vector2(200, 0));
        const p = patch(0, 0, 8000, 0, Array.from({ length: 10 }, (_, i) => point(i * 2, 0)));
        expect(scorePatch(f.game, f.player as any, p)).toBeDefined();
        f.player.startLocation = new Vector2(200, 0);
        expect(scorePatch(f.game, f.player as any, p)).toBeUndefined();
    });

    test.each(["tank", "primary", "secondary"])("visible %s threats reject within inclusive center distance fourteen", kind => {
        const f = fixture();
        const rules = kind === "tank" ? { type: ObjectType.Vehicle, isSelectableCombatant: true }
            : { type: ObjectType.Building, [kind]: "weapon" };
        const enemy = object(10, 14, 6, rules);
        f.enemies.push(enemy);
        expect(scorePatch(f.game, f.player as any, patch(0, 6))).toBeUndefined();
        enemy.tile.ry = 7;
        expect(scorePatch(f.game, f.player as any, patch(0, 6))).toBeDefined();
    });

    test("enemy danger measures the center, not the nearest resource tile", () => {
        const f = fixture();
        const p = patch(0, 6, 8000, 0, [point(0, 6), point(2, 6), point(4, 6), point(6, 6), point(8, 6)]);
        f.enemies.push(object(10, 19, 6, { type: ObjectType.Vehicle, isSelectableCombatant: true }));
        expect(scorePatch(f.game, f.player as any, p)).toBeDefined();
        f.enemies[0].tile.rx = 18;
        expect(scorePatch(f.game, f.player as any, p)).toBeUndefined();
    });

    test("hidden enemies, unarmed buildings and harvesters are not combat danger; private data, queues and randomness are never read", () => {
        const f = fixture();
        f.enemies.push(object(10, 0, 6, { type: ObjectType.Vehicle, isSelectableCombatant: true }),
            object(11, 0, 6, { type: ObjectType.Building, isSelectableCombatant: true }),
            object(12, 0, 6, { type: ObjectType.Vehicle, isSelectableCombatant: true, harvester: true }));
        f.hiddenUnits.add(10);
        const forbidden = () => { throw new Error("Private or nondeterministic data read"); };
        Object.defineProperty(f.player, "credits", { get: forbidden });
        f.game.getPlayerData = forbidden;
        f.game.getPlayers = forbidden;
        f.game.generateRandom = forbidden;
        f.game.productionApi = new Proxy({}, { get: forbidden });
        expect(scorePatch(f.game, f.player as any, patch(0, 6))).toBeDefined();
        expect(planRefinery(f.game, f.player as any, f.rules as any).patch?.id).toBe("0_6");
    });
});

describe("refinery patch placement", () => {
    test("brutal chooses nearby gems rather than the nearest ordinary ore tile", () => {
        const f = fixture();
        expect(f.placement("brutal")).toMatchObject(point(0, 5));
    });

    test("gems at distance twenty lose to ordinary ore at distance two", () => {
        const f = fixture();
        f.resources[1].tile.ry = 20;
        expect(f.placement("brutal")).toMatchObject(point(3, 0));
    });

    test.each(["normal", undefined] as const)("%s keeps the original nearest-visible-ore placement", difficulty => {
        const f = fixture();
        f.game.mapApi.getResourceCreditValues = () => { throw new Error("Normal placement must not score patches"); };
        expect(f.placement(difficulty)).toMatchObject(point(3, 0));
    });

    test("the existing mission forwards the brutal profile while normal still uses the original location", () => {
        expect(fixture().run("brutal")).toMatchObject({ type: "buildStructureAtLocation", rulesName: "GAREFN", ...point(0, 5) });
        expect(fixture().run("normal")).toMatchObject({ type: "buildStructureAtLocation", rulesName: "GAREFN", ...point(3, 0) });
    });

    test("a landing distance of ten records the top patch as unreachable and selects the next one; nine is reachable", () => {
        const f = fixture();
        setCandidates(f, [point(0, -4)]);
        const plan = planRefinery(f.game, f.player as any, f.rules as any);
        expect(plan).toMatchObject({ reachable: true, patch: { id: "2_0" }, location: point(0, -4) });
        expect(plan.unreachable).toMatchObject([{ patch: { id: "0_6" }, g: 6, score: 10000, distance: 10, location: point(0, -4) }]);
        setCandidates(f, [point(0, -3)]);
        expect(planRefinery(f.game, f.player as any, f.rules as any)).toMatchObject({ reachable: true, patch: { id: "0_6" } });
    });

    test("all unreachable patches stay score-sorted; an existing refinery forbids the legacy fallback and mission requests nothing", () => {
        const f = fixture();
        f.buildings.push(object(2, 100, 100, { name: "GAREFN", refinery: true }));
        f.legal.clear();
        const plan = planRefinery(f.game, f.player as any, f.rules as any);
        expect(plan).toMatchObject({ reachable: false, patch: { id: "0_6" } });
        expect(plan.location).toBeUndefined();
        expect(plan.unreachable.map(p => p.patch.id)).toEqual(["0_6", "2_0"]);
        expect(plan.unreachable.every(p => p.location === undefined && p.distance === undefined)).toBe(true);
        expect(f.placement("brutal")).toBeUndefined();
        expect(f.run("brutal")).toEqual({ type: "noop" });
    });

    test("the first refinery alone can fall back to the old nearest-ore placement when all patches are beyond nine", () => {
        const f = fixture();
        f.resources.splice(0, f.resources.length, resource(2, 0), resource(0, 30, 0, 400));
        setCandidates(f, [point(0, 20)]);
        expect(planRefinery(f.game, f.player as any, f.rules as any).reachable).toBe(false);
        expect(f.placement("brutal")).toMatchObject(point(0, 20));
        f.buildings.push(object(2, 100, 100, { refinery: true }));
        expect(f.placement("brutal")).toBeUndefined();
    });

    test("no eligible patch after a served first refinery does not fall back to the same ore field", () => {
        const f = fixture();
        f.buildings.push(object(2, 0, -3, { name: "GAREFN", refinery: true }));
        expect(planRefinery(f.game, f.player as any, f.rules as any)).toMatchObject({ reachable: false, unreachable: [] });
        expect(f.placement("brutal")).toBeUndefined();
    });

    test("retains the legal two, one, zero spacing fallback without relaxing the reach distance", () => {
        const f = fixture();
        setCandidates(f, [point(0, 2)]);
        expect(planRefinery(f.game, f.player as any, f.rules as any)).toMatchObject({ reachable: true, location: point(0, 2) });
        setCandidates(f, [point(0, 1)]);
        expect(planRefinery(f.game, f.player as any, f.rules as any)).toMatchObject({ reachable: true, location: point(0, 1) });
        f.legal.clear();
        expect(planRefinery(f.game, f.player as any, f.rules as any).reachable).toBe(false);
    });

    test("targets the patch tile closest to the nearest owned building, not its center or the conyard", () => {
        const f = fixture();
        f.buildings.push(object(2, 40, 0));
        f.resources.splice(0, f.resources.length, ...Array.from({ length: 8 }, (_, i) => resource(20 + i * 2, 0)));
        setCandidates(f, [point(21, 5), point(33, 5)]);
        expect(planRefinery(f.game, f.player as any, f.rules as any)).toMatchObject({ reachable: true, location: point(33, 5) });
    });

    test("score ties prefer lower g, then lexical IDs rather than numeric coordinate order", () => {
        const f = fixture();
        f.resources[0].ore = 1200;
        f.resources[1].ore = 1600;
        f.resources[1].gems = 0;
        expect(planRefinery(f.game, f.player as any, f.rules as any).patch?.id).toBe("2_0");
        const tied = fixture();
        tied.buildings[0].tile = point(6, 0);
        tied.resources.splice(0, tied.resources.length, resource(2, 0), resource(10, 0));
        setCandidates(tied, [point(7, 3)]);
        expect(planRefinery(tied.game, tied.player as any, tied.rules as any).patch?.id).toBe("10_0");
        tied.resources.reverse();
        tied.at(90);
        expect(planRefinery(tied.game, tied.player as any, tied.rules as any).patch?.id).toBe("10_0");
    });

    test("normal visibility guards and the no-conyard result are unchanged", () => {
        const f = fixture();
        f.hidden.set("bot", new Set(["0_6"]));
        Object.defineProperty(f.resources[1], "gems", { get() { throw new Error("Hidden resource read"); } });
        expect(f.placement("normal")).toMatchObject(point(3, 0));
        f.buildings.length = 0;
        expect(f.placement("normal")).toBeUndefined();
    });
});

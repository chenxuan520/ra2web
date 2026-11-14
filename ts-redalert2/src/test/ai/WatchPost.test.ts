import { describe, expect, test } from "bun:test";
import { ActionsApi, AttackState, GameApi, ObjectType, OrderType, PlayerData, ProductionApi, SpeedType, TechnoRules, UnitData, Vector2 }
    from "../../game/ai/thirdpartbot/builtIn/game-api";
import { BuildStatus } from "../../game/gameobject/Building";
import { MatchAwareness } from "../../game/ai/thirdpartbot/builtIn/bot/logic/awareness";
import { MissionContext, SupabotContext } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/context";
import { PatchPoint } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/orePatches";
import { PrioritisedScoutTarget } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/scout";
import { ActionBatcher } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";
import { Mission, grabCombatants, noop, requestUnits } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/mission";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { OpeningScoutingMission, ScoutingMission, ScoutingMissionFactory }
    from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/scoutingMission";
import { HomeDogMission, WatchPostMission, WatchPostMissions, getPublicEnemyStart, legalDogPoint, selectWatchPost }
    from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/watchPostMission";
import { isPressured, readPressure } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/pressure";
import { planRefinery } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/buildingRules";

interface TestTile extends PatchPoint { id: string }
interface TestRules extends Partial<TechnoRules> { name: string; type: ObjectType }
interface TestUnit extends Omit<UnitData, "id" | "tile" | "rules"> { id: number; tile: TestTile; rules: TestRules }
interface RecordedOrder { ids: number[]; type: OrderType; xOrTarget?: number; y?: number }
const tile = (rx: number, ry: number): TestTile => ({ rx, ry, id: `${rx}_${ry}` });
const key = (point: PatchPoint) => `${point.rx}_${point.ry}`;

/** Own inventory, explored terrain and current enemy appearances are separate. */
function fixture(difficulty: "normal" | "brutal" = "brutal", dogName = "DOG", hiddenEnemyStart = new Vector2(140, 20)) {
    let tick = 0, overallVisibility = 0, allTerrainVisible = false, privateReads = 0, queueReads = 0, resourceReads = 0;
    const player: PlayerData = { name: "bot", startLocation: new Vector2(20, 20), country: { name: "Russians" },
        credits: 1000, isAi: true, isObserver: false, isCombatant: true, radarDisabled: false,
        power: { total: 200, drain: 0, isLowPower: false } };
    const starts = [player.startLocation as Vector2, new Vector2(140, 20)];
    const objects = new Map<number, TestUnit>(), visibleEnemies = new Set<number>();
    const explored = new Set<string>(["20_20", "21_20", "37_3", "44_20", "37_37", "20_44", "3_37", "3_3"]), blocked = new Set<string>();
    const extraRadii: number[] = [];
    const orders: RecordedOrder[] = [], debug = new Map<number, string | undefined>(), passabilityReads: string[] = [], logs: string[] = [];
    const placementTiles = [tile(24, 20)];
    const queue = [new PrioritisedScoutTarget(800, new Vector2(20, 80))];
    const resources: { tile: TestTile; ore: number; gems: number; spawnsOre: boolean }[] = [];
    const available: TestRules[] = [{ name: dogName, type: ObjectType.Infantry, cost: 200, speedType: SpeedType.Foot }];
    function add(id: number, name: string, rx: number, ry = 20, owner = "bot", extra: Partial<TechnoRules> = {}) {
        const type = ["GACNST", "GAPILE", "NAHAND", "GAREFN", "GAWEAP", "GAPILL"].includes(name) ? ObjectType.Building
            : ["HTNK", "MTNK", "HARV"].includes(name) ? ObjectType.Vehicle : ObjectType.Infantry;
        const rules: TestRules = { name, type, speedType: SpeedType.Foot, cost: 200,
            isSelectableCombatant: type !== ObjectType.Building, constructionYard: name === "GACNST",
            refinery: name === "GAREFN", weaponsFactory: name === "GAWEAP", baseNormal: type === ObjectType.Building,
            harvester: name === "HARV", engineer: name === "ENGINEER" || name === "SENGINEER", ...extra };
        const unit: TestUnit = { id, name, owner, type: type as unknown as string, rules, tile: tile(rx, ry),
            tileElevation: 0, worldPosition: {}, foundation: { width: 1, height: 1 }, hitPoints: 100,
            maxHitPoints: 100, direction: 0, isIdle: true, canMove: true, buildStatus: String(BuildStatus.Ready) };
        objects.set(id, unit);
        return unit;
    }
    add(100, "GACNST", 20);
    add(101, "NAHAND", 21);
    const actions = {
        setUnitDebugText(id: number, text: string | undefined) { debug.set(id, text); },
        orderUnits(ids: number[], type: OrderType, xOrTarget?: number, y?: number) {
            orders.push({ ids: [...ids], type, xOrTarget, y });
            for (const id of ids) {
                const unit = objects.get(id);
                if (!unit || unit.owner !== player.name) throw new Error(`Commanding foreign/dead unit ${id}`);
                unit.isIdle = type === OrderType.Stop;
            }
        },
    } as unknown as ActionsApi;
    const production = { getAvailableObjects: () => available } as unknown as ProductionApi;
    const map = {
        getStartingLocations: () => starts.map(start => start.clone()),
        getTile(rx: number, ry: number) { return Number.isInteger(rx) && Number.isInteger(ry) && rx >= 0 && ry >= 0 && rx <= 200 && ry <= 200 ? tile(rx, ry) : undefined; },
        getTilesInRect: (rect: { x: number; y: number; width: number; height: number }) => placementTiles.filter(point =>
            point.rx >= rect.x && point.rx < rect.x + rect.width && point.ry >= rect.y && point.ry < rect.y + rect.height),
        isVisibleTile: (point: PatchPoint, name: string) => {
            if (name !== player.name) throw new Error("Foreign shroud read");
            return allTerrainVisible || explored.has(key(point));
        },
        hasBridgeOnTile(point: PatchPoint) {
            if (!allTerrainVisible && !explored.has(key(point))) throw new Error("Hidden bridge read");
            return false;
        },
        isPassableTile(point: PatchPoint, speed: SpeedType, bridge: boolean, isFoot: boolean) {
            if (!allTerrainVisible && !explored.has(key(point))) throw new Error("Hidden terrain read");
            expect(speed).toBe(SpeedType.Foot); expect(isFoot).toBe(true); expect(typeof bridge).toBe("boolean");
            passabilityReads.push(key(point));
            return !blocked.has(key(point));
        },
        getAllTilesResourceData() { resourceReads++; return resources; },
        getResourceCreditValues: () => ({ ore: 10, gems: 20 }),
    };
    const readUnit = (id: number): UnitData | undefined => {
        const unit = objects.get(id);
        if (!unit || unit.hitPoints <= 0) return undefined;
        if (unit.owner !== player.name && !visibleEnemies.has(id)) throw new Error("Hidden enemy unit read");
        return unit;
    };
    const game = {
        getCurrentTick: () => tick,
        getPlayerData(name: string) {
            if (name !== player.name) { privateReads++; throw new Error(`Private enemy metadata read (${hiddenEnemyStart.x},${hiddenEnemyStart.y})`); }
            return player;
        },
        getVisibleUnits(name: string, relation: string, predicate: (rules: TestRules) => boolean = () => true) {
            if (name !== player.name) throw new Error("Foreign visibility read");
            return [...objects.values()].filter(unit => unit.hitPoints > 0 && (relation === "self" ? unit.owner === name
                : unit.owner === "enemy" && visibleEnemies.has(unit.id)) && predicate(unit.rules)).map(unit => unit.id);
        },
        getGameObjectData: readUnit, getUnitData: readUnit,
        getBuildingPlacementData: () => ({ foundation: { width: 1, height: 1 } }),
        canPlaceBuilding: (_name: string, _building: string, point: PatchPoint) => placementTiles.some(legal => key(legal) === key(point)),
        mapApi: map,
    } as unknown as GameApi;
    const awareness = {
        getSectorCache: () => ({ getOverallVisibility: () => overallVisibility }),
        getScoutingManager: () => ({ hasScoutTargets: () => queue.length > 0,
            getNewScoutTarget() { queueReads++; return queue.shift(); },
            addRadiusToScout(_game: GameApi, _home: Vector2, _sectors: unknown, radius: number) { extraRadii.push(radius); } }),
    } as unknown as MatchAwareness;
    const context: SupabotContext = { game, player: { name: player.name, production, actions }, difficulty,
        matchAwareness: awareness };
    const controller = new MissionController(message => logs.push(message)), factory = new ScoutingMissionFactory();
    function missionStep(mission: Mission<unknown>, at = tick, missionContext = context) {
        tick = at;
        const batcher = new ActionBatcher();
        const action = mission.onAiUpdate({ ...missionContext, actionBatcher: batcher });
        batcher.resolve(actions, game.mapApi);
        return action;
    }
    return { player, starts, objects, explored, visibleEnemies, blocked, resources, available, orders, debug, logs, placementTiles,
        passabilityReads, extraRadii, context, game, map, queue, controller, factory, add, missionStep,
        at(value: number) { tick = value; },
        revealAll(value = true) { allTerrainVisible = value; },
        visibility(value: number) { overallVisibility = value; },
        ensure() { factory.maybeCreateMissions(context, controller, () => {}); },
        scout() { return controller.getMissions().find(mission => mission.getUniqueName() === "globalScout")!; },
        watch(index: 1 | 2) { return controller.getMissions().find(mission => mission.getUniqueName() === `watchPostP${index}`) as WatchPostMission; },
        home() { return controller.getMissions().find(mission => mission.getUniqueName() === "homeDog") as HomeDogMission; },
        privateReads: () => privateReads, queueReads: () => queueReads, resourceReads: () => resourceReads,
    };
}

describe("T2 opening scout budget", () => {
    test("one brutal mission has the entire two-dog budget, rather than doubling two old missions", () => {
        const f = fixture(); f.ensure(); f.ensure();
        expect(f.controller.getMissions().filter(mission => mission.getUniqueName().startsWith("globalScout"))).toHaveLength(1);
    });

    test("holds both initial dogs and releases only the third", () => {
        const f = fixture(); f.ensure();
        f.add(1, "DOG", 23); f.add(2, "DOG", 24); f.add(3, "DOG", 25);
        f.scout().addUnit(1); f.scout().addUnit(2);
        expect(f.missionStep(f.scout()).type).not.toBe("releaseUnits");
        f.scout().addUnit(3);
        expect(f.missionStep(f.scout(), 32)).toEqual({ type: "releaseUnits", unitIds: [3] });
    });

    test("first dog visits the nearest other public start and second dog uses the old queue", () => {
        const f = fixture(); f.ensure();
        f.add(1, "DOG", 23); f.add(2, "DOG", 24); f.scout().addUnit(1); f.scout().addUnit(2);
        f.missionStep(f.scout(), 32); f.objects.get(1)!.tile = tile(80, 28); f.missionStep(f.scout(), 64);
        expect(f.orders).toContainEqual({ ids: [1], type: OrderType.AttackMove, xOrTarget: 140, y: 20 });
        expect(f.orders).toContainEqual({ ids: [2], type: OrderType.AttackMove, xOrTarget: 20, y: 80 });
        expect(f.privateReads()).toBe(0);
    });

    test.each(["DOG", "ADOG"])("requests exactly two initial %s receipts, even when the first dies", name => {
        const f = fixture("brutal", name); f.ensure();
        expect(f.missionStep(f.scout())).toEqual({ type: "request", unitNameToPriority: { [name]: 85 } });
        f.add(1, name, 23); f.scout().addUnit(1);
        expect(f.missionStep(f.scout(), 32)).toEqual({ type: "request", unitNameToPriority: { [name]: 85 } });
        f.objects.delete(1); f.scout().removeUnit(1);
        expect(f.missionStep(f.scout(), 64)).toEqual({ type: "request", unitNameToPriority: { [name]: 85 } });
        f.add(2, name, 24); f.scout().addUnit(2); f.missionStep(f.scout(), 96);
        f.objects.delete(2); f.scout().removeUnit(2);
        expect(f.missionStep(f.scout(), 128).type).toBe("disband");
    });

    test("normal still creates one old single-scout mission and has no T2 terrain/resource reads", () => {
        const f = fixture("normal");
        f.map.getAllTilesResourceData = () => { throw new Error("Normal must not score watch patches"); };
        f.ensure(); f.ensure();
        expect(f.controller.getMissions()).toHaveLength(1);
        expect(f.scout()).toBeInstanceOf(ScoutingMission);
        f.add(1, "DOG", 23); f.add(2, "DOG", 24); f.scout().addUnit(1); f.scout().addUnit(2);
        expect(f.missionStep(f.scout())).toEqual({ type: "releaseUnits", unitIds: [2] });
        expect(f.passabilityReads).toHaveLength(0);
    });
});

function watchFixture() {
    const f = fixture(); f.revealAll(); f.ensure();
    f.watch(1).activate(); f.watch(2).activate();
    return f;
}

function homeFixture(name = "DOG") {
    const f = fixture("brutal", name); f.revealAll(); f.ensure();
    f.add(1, name, 60); f.add(2, name, 70);
    f.scout().addUnit(1); f.scout().addUnit(2);
    return f;
}

class OtherDogMission extends Mission {
    constructor(name: string, private action: "grab" | "request" = "grab") { super(name, () => {}); }
    getPriority() { return 200; }
    getGlobalDebugText() { return "other mission"; }
    _onAiUpdate(_context: MissionContext) {
        return this.action === "grab" ? grabCombatants(new Vector2(80, 20), 200) : requestUnits({ DOG: 200 });
    }
}

describe("T2 scout directions, recruitment and real handoff", () => {
    test("the first scout takes a public flank waypoint then continues to the unchanged public enemy start", () => {
        const f = fixture(); f.ensure(); const dog = f.add(1, "DOG", 23); f.scout().addUnit(1);
        f.missionStep(f.scout(), 32);
        expect(f.orders[0]).toEqual({ ids: [1], type: OrderType.Move, xOrTarget: 80, y: 28 });
        expect(f.passabilityReads).toHaveLength(0); expect(f.privateReads()).toBe(0);
        dog.tile = tile(80, 28); f.missionStep(f.scout(), 64);
        expect(f.orders.at(-1)).toEqual({ ids: [1], type: OrderType.AttackMove, xOrTarget: 140, y: 20 });
        expect((f.scout() as OpeningScoutingMission).getTotalUnitsReceived()).toBe(1);
    });
    test("the public flank mirrors deterministically after swapping the known home start", () => {
        const f = fixture(); f.player.startLocation = new Vector2(140, 20);
        f.explored.delete("20_20"); f.explored.add("140_20");
        f.objects.get(100)!.tile = tile(140, 20); f.objects.get(101)!.tile = tile(141, 20); f.ensure();
        f.add(1, "DOG", 139); f.scout().addUnit(1); f.missionStep(f.scout(), 32);
        expect(f.orders[0]).toEqual({ ids: [1], type: OrderType.Move, xOrTarget: 80, y: 12 });
        expect(f.privateReads()).toBe(0); expect(f.passabilityReads).toHaveLength(0);
    });
    test("an already visible enemy start skips the public flank and preserves the original post handoff", () => {
        const f = fixture(); f.explored.add("140_20"); f.ensure(); f.add(1, "DOG", 23); f.scout().addUnit(1);
        f.missionStep(f.scout(), 32);
        expect(f.orders[0]).toEqual({ ids: [1], type: OrderType.Move, xOrTarget: 80, y: 20 });
    });
    test("a blocked known flank with no legal fallback retains the original public enemy-start order", () => {
        const f = fixture(); f.explored.add("80_28"); f.blocked.add("80_28"); f.ensure();
        f.add(1, "DOG", 23); f.scout().addUnit(1); f.missionStep(f.scout(), 32);
        expect(f.orders[0]).toEqual({ ids: [1], type: OrderType.AttackMove, xOrTarget: 140, y: 20 });
        expect(f.privateReads()).toBe(0);
    });
    test("private enemy start assignment cannot change either public direction or the first-dog order", () => {
        const a = fixture("brutal", "DOG", new Vector2(140, 20)), b = fixture("brutal", "DOG", new Vector2(20, 140));
        for (const f of [a, b]) {
            f.starts.push(new Vector2(20, 100));
            f.ensure(); f.add(1, "DOG", 23); f.scout().addUnit(1); f.missionStep(f.scout(), 32);
        }
        expect(a.orders).toEqual(b.orders);
        expect(a.orders[0]).toEqual({ ids: [1], type: OrderType.Move, xOrTarget: 12, y: 60 });
        expect(a.watch(1).getPosition()).toEqual({ rx: 20, ry: 60 });
        expect(a.watch(1).getPosition()).toEqual(b.watch(1).getPosition());
        expect(a.privateReads() + b.privateReads()).toBe(0);
    });

    test("public-start ties, duplicates and enumeration order are deterministic; invalid points are ignored", () => {
        const f = fixture();
        f.starts.splice(0, f.starts.length, new Vector2(100, 20), new Vector2(20, 100),
            new Vector2(20, 100), new Vector2(-1, -1), new Vector2(20, 20));
        expect(getPublicEnemyStart(f.game, f.player)).toEqual(new Vector2(20, 100));
        f.starts.reverse();
        expect(getPublicEnemyStart(f.game, f.player)).toEqual(new Vector2(20, 100));
        f.starts.splice(0, f.starts.length, new Vector2(20, 20), new Vector2(-1, -1));
        expect(getPublicEnemyStart(f.game, f.player)).toBeUndefined();
        expect(selectWatchPost(f.context, 1)).toBeUndefined();
    });

    test("second dog skips the public start reserved for the first and then follows the old queue", () => {
        const f = fixture(); f.queue.unshift(new PrioritisedScoutTarget(900, new Vector2(140, 20), true));
        f.ensure(); f.add(1, "DOG", 23); f.add(2, "DOG", 24); f.scout().addUnit(1); f.scout().addUnit(2);
        f.missionStep(f.scout(), 32);
        expect(f.orders).toContainEqual({ ids: [2], type: OrderType.AttackMove, xOrTarget: 20, y: 80 });
        expect(f.queueReads()).toBe(2);
    });

    test("the second scout consumes original public sector priorities before any extra home sweep", () => {
        const f = fixture(); f.queue.unshift(new PrioritisedScoutTarget(880, new Vector2(28, 36))); f.ensure();
        f.add(1, "DOG", 23); f.add(2, "DOG", 24); f.scout().addUnit(1); f.scout().addUnit(2);
        f.map.getAllTilesResourceData = () => { throw Error("original public sector orders must not inspect hidden resources"); };
        f.missionStep(f.scout(), 32);
        expect(f.orders).toContainEqual({ ids: [2], type: OrderType.AttackMove, xOrTarget: 28, y: 36 });
        expect(f.queueReads()).toBe(1); expect(f.extraRadii).toEqual([]);
        expect(f.privateReads()).toBe(0);
    });
    test("the finite public near24 opening is retained ahead of adaptive sectors", () => {
        const f = fixture(); f.player.startLocation.set(20, 50);
        f.objects.get(100)!.tile = tile(20, 50); f.objects.get(101)!.tile = tile(21, 50); f.ensure();
        f.add(1, "DOG", 23, 50); f.add(2, "DOG", 24, 50); f.scout().addUnit(1); f.scout().addUnit(2);
        f.map.getAllTilesResourceData = () => { throw Error("public near goals cannot inspect hidden minerals"); };
        f.missionStep(f.scout(), 32);
        expect(f.orders).toContainEqual({ ids: [2], type: OrderType.AttackMove, xOrTarget: 20, y: 26 });
        expect(f.queueReads()).toBe(0); expect(f.privateReads()).toBe(0);
        expect((f.scout() as OpeningScoutingMission).getTotalUnitsReceived()).toBe(2);
    });
    test("an empty early queue keeps the original two receipts until more sector goals or the real deadline", () => {
        const f = fixture(); f.queue.length = 0; f.explored.add("140_20"); f.ensure();
        f.add(1, "DOG", 23); f.add(2, "DOG", 24); f.scout().addUnit(1); f.scout().addUnit(2);
        expect(f.missionStep(f.scout(), 32).type).toBe("noop");
        expect(f.scout().getUnitIds()).toEqual([1, 2]);
        f.queue.push(new PrioritisedScoutTarget(800, new Vector2(20, 80)));
        f.missionStep(f.scout(), 64);
        expect(f.orders).toContainEqual({ ids: [2], type: OrderType.AttackMove, xOrTarget: 20, y: 80 });
        expect(f.missionStep(f.scout(), 3600).type).toBe("disband");
        expect((f.scout() as OpeningScoutingMission).getTotalUnitsReceived()).toBe(2);
    });
    test("the extra forty-radius sweep waits until3600 so it cannot overtake the funded near opening", () => {
        const f = fixture(); f.add(102, "GAWEAP", 22); f.add(103, "GAREFN", 30);
        f.resources.push({ tile: tile(30, 20), ore: 800, gems: 0, spawnsOre: false }); f.explored.add("30_20");
        f.ensure(); f.add(1, "DOG", 23); f.add(2, "DOG", 24); f.scout().addUnit(1); f.scout().addUnit(2);
        f.missionStep(f.scout(), 32); f.missionStep(f.scout(), 64);
        expect(f.extraRadii).toEqual([]);
        f.missionStep(f.scout(), 3600); f.missionStep(f.scout(), 3602);
        expect(f.extraRadii).toEqual([40]); expect(f.privateReads()).toBe(0);
        expect(f.scout().getUnitIds()).toEqual([1, 2]);
    });
    test.each(["opaque", "center-only", "blocked"])("missing home fields use late public outer goals only after3600 (%s)", condition => {
        const f = fixture(); f.player.startLocation.set(20, 50);
        f.objects.get(100)!.tile = tile(20, 50); f.objects.get(101)!.tile = tile(21, 50);
        f.add(102, "GAWEAP", 22, 50); f.add(103, "GAREFN", 30, 50);
        f.resources.push({ tile: tile(30, 50), ore: 800, gems: 0, spawnsOre: false }); f.explored.add("30_50");
        for (const [dx, dy] of [[0, -24], [17, -17], [24, 0], [17, 17], [0, 24], [-17, 17], [-24, 0], [-17, -17]]) f.explored.add(`${20 + dx}_${50 + dy}`);
        if (condition !== "opaque") f.explored.add("20_10");
        if (condition === "blocked") { f.blocked.add("20_10"); f.explored.add("21_10"); }
        f.ensure(); f.add(1, "DOG", 23, 50); f.add(2, "DOG", 24, 50); f.scout().addUnit(1); f.scout().addUnit(2);
        f.missionStep(f.scout(), 32);
        expect(f.orders).toContainEqual({ ids: [2], type: OrderType.AttackMove, xOrTarget: 20, y: 80 });
        f.missionStep(f.scout(), 3600); f.missionStep(f.scout(), 3602);
        expect(f.orders.filter(order => order.ids.includes(2)).at(-1)).toMatchObject({ xOrTarget: condition === "blocked" ? 21 : 20, y: 10 });
        expect((f.scout() as OpeningScoutingMission).getTotalUnitsReceived()).toBe(2);
        expect(f.privateReads()).toBe(0);
        expect(f.missionStep(f.scout(), 5400).type).toBe("disband");
    });
    test.each(["quiet", "pressure", "second-field", "deadline"])("home-economy scouting extension respects %s", condition => {
        const f = fixture(); f.add(102, "GAWEAP", 22); f.add(103, "GAREFN", 30);
        f.resources.push({ tile: tile(30, 20), ore: 800, gems: 0, spawnsOre: false }); f.explored.add("30_20");
        if (condition === "second-field") { f.resources.push({ tile: tile(60, 20), ore: 800, gems: 0, spawnsOre: false }); f.explored.add("60_20"); }
        if (condition === "pressure") { f.add(200, "MTNK", 40, 20, "enemy"); f.visibleEnemies.add(200); }
        f.ensure(); f.add(1, "DOG", 23); f.add(2, "DOG", 24); f.scout().addUnit(1); f.scout().addUnit(2);
        const action = f.missionStep(f.scout(), condition === "deadline" ? 5400 : 3600);
        expect(action.type).toBe(condition === "quiet" ? "noop" : "disband");
        if (condition === "quiet") {
            expect(f.scout().getUnitIds()).toEqual([1, 2]);
            expect(f.missionStep(f.scout(), 5400).type).toBe("disband");
        }
        expect(f.privateReads()).toBe(0);
    });
    test("an empty old queue does not suppress the first public-start scout", () => {
        const f = fixture(); f.queue.length = 0; f.ensure();
        expect(f.scout()).toBeInstanceOf(OpeningScoutingMission);
        expect(f.missionStep(f.scout())).toEqual({ type: "request", unitNameToPriority: { DOG: 85 } });
    });

    test("duplicate receipts and a released third dog do not increase or reopen the lifetime budget", () => {
        const f = fixture(); f.ensure();
        for (const id of [1, 2, 3]) f.add(id, "DOG", 20 + id);
        f.scout().addUnit(1); f.scout().addUnit(1); f.scout().addUnit(2); f.scout().addUnit(3);
        expect((f.scout() as OpeningScoutingMission).getTotalUnitsReceived()).toBe(2);
        expect(f.scout().getUnitIds()).toEqual([1, 2, 3]);
        expect(f.missionStep(f.scout()).type).toBe("releaseUnits");
        f.scout().removeUnit(3); f.scout().removeUnit(1); f.scout().removeUnit(2);
        expect(f.missionStep(f.scout(), 32).type).toBe("disband");
        expect(f.watch(1).getUnitIds()).toEqual([]);
    });

    test.each([false, true])("the first two receipts retain scout priority before/after factory (%s) before home recruitment", factory => {
        const f = fixture(); if (factory) f.add(102, "GAWEAP", 22); f.ensure();
        expect(f.missionStep(f.home())).toEqual(noop());
        expect(f.missionStep(f.scout())).toEqual({ type: "request", unitNameToPriority: { DOG: factory ? 50 : 85 } });
        f.add(1, "DOG", 60); f.scout().addUnit(1);
        expect(f.missionStep(f.home(), 32)).toEqual(noop());
        f.add(2, "DOG", 70); f.scout().addUnit(2);
        expect(f.missionStep(f.home(), 64)).toEqual({ type: "request", unitNameToPriority: { DOG: 60 } });
    });

    test.each(["DOG", "ADOG"])("MissionController grants initial %s receipts to scouts before a home specific-ID claim", name => {
        const f = fixture("brutal", name); f.add(102, "GAWEAP", 22); f.ensure();
        f.add(1, name, 20); f.controller.onAiUpdate(f.context);
        expect(f.scout().getUnitIds()).toEqual([1]); expect(f.home().getUnitIds()).toEqual([]);
        f.at(2); f.add(2, name, 20); f.controller.onAiUpdate(f.context);
        expect(f.scout().getUnitIds()).toEqual([1, 2]); expect(f.home().getUnitIds()).toEqual([]);
        f.objects.get(1)!.tile = tile(40, 20); f.objects.get(2)!.tile = tile(20, 40);
        f.at(4); f.controller.onAiUpdate(f.context);
        expect(f.controller.getRequestedUnitTypes().get(name)?.priority).toBe(60);
        f.at(6); f.add(3, name, 20); f.controller.onAiUpdate(f.context);
        expect(f.home().getUnitIds()).toEqual([3]); expect(f.scout().getUnitIds()).toEqual([1, 2]);
        expect(f.logs.filter(message => message.includes("multiple missions"))).toEqual([]);
    });

    test("unsupported brutal dog production has no infantry/vehicle fallback; normal retains its old fallback", () => {
        const f = fixture(); f.available.splice(0, 1, { name: "E1", type: ObjectType.Infantry }); f.ensure();
        expect(f.missionStep(f.scout())).toEqual(noop());
        const n = fixture("normal"); n.available.length = 0; n.ensure();
        expect(n.missionStep(n.scout())).toEqual({ type: "request", unitNameToPriority: { ADOG: 85, DOG: 85, E1: 85, E2: 85, FV: 85, HTK: 85 } });
    });

    test.each(["explored", "deadline"] as const)("%s hands actual surviving IDs into locked post slots before other missions can claim them", condition => {
        const f = fixture(); f.ensure();
        f.add(1, "DOG", 70); f.add(2, "DOG", 70, 21); f.scout().addUnit(1); f.scout().addUnit(2);
        const source = f.scout();
        for (const name of ["fieldArmy", "dogEscort", "baseReserve", "infantryHome"]) f.controller.addMission(new OtherDogMission(name));
        if (condition === "explored") f.visibility(0.91); else f.at(3600);
        f.controller.onAiUpdate(f.context);
        expect(source.getUnitIds()).toEqual([]); expect(source.isActive()).toBe(false);
        expect(f.watch(1).getUnitIds()).toEqual([1]); expect(f.watch(2).getUnitIds()).toEqual([2]);
        expect(f.watch(1).isUnitsLocked() && f.watch(2).isUnitsLocked()).toBe(true);
        expect(f.controller.getMissions().filter(mission => ["fieldArmy", "dogEscort", "baseReserve", "infantryHome"].includes(mission.getUniqueName()))
            .flatMap(mission => mission.getUnitIds())).toEqual([]);
        f.at(condition === "deadline" ? 3602 : 2); f.controller.onAiUpdate(f.context); f.ensure();
        expect(f.watch(1).getUnitIds()).toEqual([1]); expect(f.watch(2).getUnitIds()).toEqual([2]);
        expect(f.controller.getMissions().filter(mission => mission.getUniqueName().startsWith("globalScout"))).toEqual([]);
        const assigned = f.controller.getMissions().flatMap(mission => mission.getUnitIds());
        expect(new Set(assigned).size).toBe(assigned.length);
        expect(f.logs.filter(message => message.includes("multiple missions"))).toEqual([]);
    });

    test("finishing the public target or an early queue is not a false ownership transfer before the deadline", () => {
        const f = fixture(); f.ensure();
        f.add(1, "DOG", 70); f.add(2, "DOG", 24); f.scout().addUnit(1); f.scout().addUnit(2);
        f.explored.add("140_20");
        expect(f.missionStep(f.scout(), 32).type).toBe("noop");
        expect(f.scout().getUnitIds()).toEqual([1, 2]); expect(f.watch(1).getUnitIds()).toEqual([]);
        f.explored.add("20_80");
        expect(f.missionStep(f.scout(), 64).type).toBe("noop");
        expect(f.missionStep(f.scout(), 3600).type).toBe("disband");
        expect(f.scout().getUnitIds()).toEqual([]); expect(f.watch(1).getUnitIds()).toEqual([1]);
        expect(f.watch(2).getUnitIds()).toEqual([2]);
    });

    test("3600 is the exact deadline even without a known enemy building", () => {
        const f = fixture(); f.ensure(); f.add(1, "DOG", 60); f.add(2, "DOG", 70);
        f.scout().addUnit(1); f.scout().addUnit(2);
        expect(f.missionStep(f.scout(), 3599).type).toBe("noop");
        expect(f.missionStep(f.scout(), 3600).type).toBe("disband");
        expect(f.watch(1).getUnitIds()).toEqual([1]); expect(f.watch(2).getUnitIds()).toEqual([2]);
    });

    test("handoff ignores dead or no-longer-owned IDs, and activates empty slots for later refill", () => {
        const f = fixture(); f.ensure(); f.add(1, "DOG", 60); const captured = f.add(2, "DOG", 70);
        f.scout().addUnit(1); f.scout().addUnit(2); f.objects.delete(1); captured.owner = "enemy"; f.visibleEnemies.add(2);
        f.at(3600); f.controller.onAiUpdate(f.context);
        expect(f.watch(1).getUnitIds()).toEqual([]); expect(f.watch(2).getUnitIds()).toEqual([]);
        expect(f.orders.flatMap(order => order.ids)).toEqual([]);
        expect(f.missionStep(f.watch(1), 3602)).toEqual({ type: "request", unitNameToPriority: { DOG: 40 } });
        expect(f.missionStep(f.watch(2), 3602)).toEqual({ type: "request", unitNameToPriority: { DOG: 40 } });
    });

    test("the surviving field scout keeps P2; scout survivors do not spend the shared replacement budget", () => {
        const f = fixture(); f.ensure(); f.add(1, "DOG", 60); f.add(2, "DOG", 70);
        f.scout().addUnit(1); f.scout().addUnit(2); f.objects.delete(1);
        f.at(3600); f.controller.onAiUpdate(f.context);
        expect(f.watch(1).getUnitIds()).toEqual([]); expect(f.watch(2).getUnitIds()).toEqual([2]);
        for (let i = 0; i < 4; i++) {
            const post = f.watch(1), id = 10 + i;
            expect(f.missionStep(post, 3602 + i * 2).type).toBe("request");
            f.add(id, "DOG", 45); post.addUnit(id); f.objects.delete(id); post.removeUnit(id);
        }
        expect(f.missionStep(f.watch(1), 3610).type).toBe("noop");
    });
    test.each([1, 2])("survivor %i retains its original public-start/field role after the other initial ID is removed", survivor => {
        const f = fixture(); f.revealAll();
        f.resources.push({ tile: tile(60, 30), ore: 800, gems: 0, spawnsOre: false }); f.ensure();
        f.add(1, "DOG", 70); f.add(2, "DOG", 70); f.scout().addUnit(1); f.scout().addUnit(2);
        f.objects.delete(3 - survivor); f.scout().removeUnit(3 - survivor);
        expect(f.missionStep(f.scout(), 3600).type).toBe("disband");
        expect(f.watch(survivor as 1 | 2).getUnitIds()).toEqual([survivor]);
        expect(f.watch((3 - survivor) as 1 | 2).getUnitIds()).toEqual([]);
        f.missionStep(f.watch(survivor as 1 | 2), 3602);
        expect(f.orders.at(-1)).toEqual({ ids: [survivor], type: OrderType.Move,
            xOrTarget: survivor === 1 ? 80 : 60, y: survivor === 1 ? 20 : 30 });
        expect((f.scout() as OpeningScoutingMission).getTotalUnitsReceived()).toBe(2);
        expect(f.privateReads()).toBe(0);
    });
});

describe("T2 watch-post points and information boundary", () => {
    test("P1 is the public midpoint and P2 defaults to the 25-tile public direction", () => {
        const f = fixture(); f.ensure();
        expect(f.watch(1).getPosition()).toEqual({ rx: 80, ry: 20 });
        expect(f.watch(2).getPosition()).toEqual({ rx: 45, ry: 20 });
        expect(f.passabilityReads).toHaveLength(0); // both unexplored goals are opaque
    });

    test("P1 uses the nearest legal tile within six, with stable coordinate ties", () => {
        const f = fixture(); f.revealAll(); f.blocked.add("80_20"); f.ensure();
        expect(f.watch(1).getPosition()).toEqual({ rx: 79, ry: 20 });
        expect(f.passabilityReads).not.toHaveLength(0);
        for (let x = 74; x <= 86; x++) for (let y = 14; y <= 26; y++) f.blocked.add(`${x}_${y}`);
        f.blocked.delete("86_20");
        expect(legalDogPoint(f.context, { rx: 80, ry: 20 })).toEqual({ rx: 86, ry: 20 });
        f.blocked.add("86_20"); f.blocked.delete("87_20");
        expect(legalDogPoint(f.context, { rx: 80, ry: 20 })).toBeUndefined();
    });

    test("a fractional midpoint's fallback radius is measured from the true public midpoint", () => {
        const f = fixture(); f.revealAll();
        for (let x = 74; x <= 88; x++) for (let y = 13; y <= 27; y++) f.blocked.add(`${x}_${y}`);
        f.blocked.delete("87_20");
        expect(legalDogPoint(f.context, { rx: 80.5, ry: 20 })).toBeUndefined();
        f.blocked.delete("86_20");
        expect(legalDogPoint(f.context, { rx: 80.5, ry: 20 })).toEqual({ rx: 86, ry: 20 });
    });

    test("unexplored blocked terrain is never consulted; once explored it is resolved legally", () => {
        const f = fixture(); f.blocked.add("80_20"); f.ensure();
        expect(f.watch(1).getPosition()).toEqual({ rx: 80, ry: 20 });
        expect(f.passabilityReads).toHaveLength(0);
        f.explored.add("80_20"); f.explored.add("79_20"); f.ensure();
        expect(f.watch(1).getPosition()).toEqual({ rx: 79, ry: 20 });
        expect(f.passabilityReads.every(point => f.explored.has(point))).toBe(true);
    });

    test("out-of-bounds derived goals use only legal map tiles, not an invented coordinate clamp", () => {
        const f = fixture(); f.revealAll();
        expect(legalDogPoint(f.context, { rx: -1, ry: 20 })).toEqual({ rx: 0, ry: 20 });
        expect(legalDogPoint(f.context, { rx: -7, ry: 20 })).toBeUndefined();
    });

    test("P2 picks the highest scored unserved known field, even when planRefinery reaches a lower field", () => {
        const f = fixture(); f.revealAll();
        f.resources.push({ tile: tile(22, 20), ore: 1000, gems: 0, spawnsOre: false },
            { tile: tile(20, 40), ore: 0, gems: 1000, spawnsOre: false });
        const rules = { name: "GAREFN", type: ObjectType.Building, refinery: true, adjacent: 100 } as TechnoRules;
        const plan = planRefinery(f.game, f.player, rules);
        expect(plan.reachable).toBe(true); expect(plan.patch?.id).toBe("22_20");
        expect(plan.unreachable[0].patch.id).toBe("20_40");
        expect(selectWatchPost(f.context, 2)).toEqual({ rx: 20, ry: 40 });
        f.add(102, "GAREFN", 20, 40);
        expect(selectWatchPost(f.context, 2)).toEqual({ rx: 22, ry: 20 });
    });

    test("hidden resource quantities and hidden tanks cannot redirect P2", () => {
        const f = fixture();
        const known = { tile: tile(20, 40), ore: 0, gems: 400, spawnsOre: false };
        const hidden = { tile: tile(20, 60), ore: 0, gems: 2000, spawnsOre: false };
        f.resources.push(known, hidden); f.explored.add("20_40"); f.explored.delete("20_60");
        for (const property of ["ore", "gems", "spawnsOre"]) Object.defineProperty(hidden, property, {
            get() { throw new Error("Hidden resource quantity read"); },
        });
        f.add(200, "MTNK", 20, 40, "enemy");
        expect(selectWatchPost(f.context, 2)).toEqual({ rx: 20, ry: 40 });
        f.visibleEnemies.add(200);
        expect(selectWatchPost(f.context, 2)).toEqual({ rx: 45, ry: 20 });
        expect(f.privateReads()).toBe(0);
    });

    test("P2 score ties use E3 g and lexical ID ordering", () => {
        const f = fixture(); f.revealAll();
        f.resources.push({ tile: tile(10, 20), ore: 1000, gems: 0, spawnsOre: false },
            { tile: tile(20, 30), ore: 1000, gems: 0, spawnsOre: false });
        // Remove the nearby barracks, otherwise E3 quite correctly changes g.
        f.objects.delete(101);
        expect(selectWatchPost(f.context, 2)).toEqual({ rx: 10, ry: 20 });
        f.resources.reverse(); f.at(90);
        expect(selectWatchPost(f.context, 2)).toEqual({ rx: 10, ry: 20 });
    });

    test("P2 recomputes exactly every 900 ticks, moving only when the change exceeds ten", () => {
        const f = fixture(); f.revealAll();
        f.resources.push({ tile: tile(20, 40), ore: 1000, gems: 0, spawnsOre: false }); f.ensure();
        const post = f.watch(2); post.activate(); f.add(1, "DOG", 20, 40); post.acceptScout(1);
        expect(post.getPosition()).toEqual({ rx: 20, ry: 40 });
        f.resources[0].tile = tile(20, 50); f.missionStep(post, 899);
        expect(post.getPosition()).toEqual({ rx: 20, ry: 40 });
        f.missionStep(post, 900); expect(post.getPosition()).toEqual({ rx: 20, ry: 40 });
        f.resources[0].tile = tile(20, 51); f.missionStep(post, 1799);
        expect(post.getPosition()).toEqual({ rx: 20, ry: 40 });
        f.missionStep(post, 1800); expect(post.getPosition()).toEqual({ rx: 20, ry: 51 });
        expect(f.orders.at(-1)).toEqual({ ids: [1], type: OrderType.Move, xOrTarget: 20, y: 51 });
    });

    test("P2's 900-tick field selection does not keep an illegal newly blocked standing tile", () => {
        const f = watchFixture(), post = f.watch(2);
        f.add(1, "DOG", 40); post.acceptScout(1); f.missionStep(post, 100);
        f.blocked.add("45_20"); f.missionStep(post, 200);
        expect(post.getPosition()).toEqual({ rx: 44, ry: 20 });
        expect(f.orders.at(-1)).toEqual({ ids: [1], type: OrderType.Move, xOrTarget: 44, y: 20 });
    });
});

describe("T2 watch-post behavior and replacement budget", () => {
    test("standing dogs stay put and identical busy movement orders do not restart pathfinding", () => {
        const f = watchFixture(), post = f.watch(1), dog = f.add(1, "DOG", 70); post.acceptScout(1);
        f.missionStep(post, 100); f.missionStep(post, 102);
        expect(f.orders).toHaveLength(1);
        dog.tile = tile(80, 20); f.missionStep(post, 104);
        expect(f.orders.at(-1)?.type).toBe(OrderType.Stop);
        const count = f.orders.length; f.missionStep(post, 150); f.missionStep(post, 180);
        expect(f.orders).toHaveLength(count);
    });

    test.each(["MTNK", "GAPILL"])("a visible %s at distance five retreats eight and returns at exactly 300 ticks", name => {
        const f = watchFixture(), post = f.watch(1), dog = f.add(1, "DOG", 80); post.acceptScout(1);
        f.add(200, name, 85, 20, "enemy", name === "GAPILL" ? { primary: "Vulcan" } : {}); f.visibleEnemies.add(200);
        f.missionStep(post, 100);
        expect(f.orders.at(-1)).toEqual({ ids: [1], type: OrderType.Move, xOrTarget: 72, y: 20 });
        dog.tile = tile(72, 20); dog.isIdle = true; f.missionStep(post, 399);
        expect(f.orders).toHaveLength(1);
        f.missionStep(post, 400);
        expect(f.orders.at(-1)).toEqual({ ids: [1], type: OrderType.Move, xOrTarget: 80, y: 20 });
    });

    test.each(["distance-six", "hidden", "unarmed", "infantry"] as const)("%s does not trigger a retreat", condition => {
        const f = watchFixture(), post = f.watch(1); f.add(1, "DOG", 80); post.acceptScout(1);
        const name = condition === "unarmed" ? "GAPILL" : condition === "infantry" ? "E2" : "MTNK";
        f.add(200, name, condition === "distance-six" ? 86 : 85, 20, "enemy");
        if (condition !== "hidden") f.visibleEnemies.add(200);
        f.missionStep(post, 100); expect(f.orders).toHaveLength(0);
    });

    test("retreat and home stand fallbacks issue legal tiles rather than blocked desired coordinates", () => {
        const f = watchFixture(), post = f.watch(1); f.add(1, "DOG", 80); post.acceptScout(1);
        f.blocked.add("72_20"); f.add(200, "MTNK", 85, 20, "enemy"); f.visibleEnemies.add(200);
        f.missionStep(post, 100);
        expect(f.orders.at(-1)).toEqual({ ids: [1], type: OrderType.Move, xOrTarget: 71, y: 20 });
        const h = homeFixture(); h.add(3, "DOG", 20); h.home().addUnit(3); h.add(102, "GAREFN", 30); h.blocked.add("25_20");
        h.missionStep(h.home(), 100);
        expect(h.orders.at(-1)).toEqual({ ids: [3], type: OrderType.Move, xOrTarget: 24, y: 20 });
    });

    test.each(["cash", "tick", "pressure"] as const)("watch replacement is blocked by the %s condition", condition => {
        const f = watchFixture(); f.at(condition === "tick" ? 13500 : 100);
        if (condition === "cash") f.player.credits = 299;
        if (condition === "pressure") { f.add(200, "MTNK", 42, 20, "enemy"); f.visibleEnemies.add(200); }
        expect(f.missionStep(f.watch(1)).type).toBe("noop");
        expect(f.missionStep(f.watch(2)).type).toBe("noop");
    });

    test("tick 13499 and cash 300 allow the unchanged priority 40", () => {
        const f = watchFixture(); f.player.credits = 300;
        expect(f.missionStep(f.watch(1), 13499)).toEqual({ type: "request", unitNameToPriority: { DOG: 40 } });
    });

    test("both posts share four replacements total, not four each, and duplicate IDs spend nothing twice", () => {
        const f = watchFixture();
        for (let i = 0; i < 4; i++) {
            const post = f.watch(i % 2 ? 2 : 1), id = 10 + i;
            expect(f.missionStep(post, 100 + i * 2)).toEqual({ type: "request", unitNameToPriority: { DOG: 40 } });
            f.add(id, "DOG", post.getPosition()!.rx, post.getPosition()!.ry); post.addUnit(id); post.addUnit(id);
            expect(post.getUnitIds()).toEqual([id]); f.objects.delete(id); post.removeUnit(id);
        }
        expect(f.missionStep(f.watch(1), 108)).toEqual(noop()); expect(f.missionStep(f.watch(2), 108)).toEqual(noop());
        f.add(20, "DOG", 80); f.watch(1).addUnit(20);
        expect(f.missionStep(f.watch(1), 110)).toEqual({ type: "releaseUnits", unitIds: [20] });
    });

    test("initial survivors of both scouts are free handoff receipts, not replacement production requests", () => {
        const f = fixture(); f.ensure(); f.add(1, "DOG", 70); f.add(2, "DOG", 70, 21);
        f.scout().addUnit(1); f.scout().addUnit(2); f.at(3600); f.controller.onAiUpdate(f.context);
        expect(f.missionStep(f.watch(1), 3602)).toEqual(noop()); expect(f.missionStep(f.watch(2), 3602)).toEqual(noop());
        for (const index of [1, 2] as const) { const post = f.watch(index); for (const id of post.getUnitIds()) f.objects.delete(id); post.getUnitIds().slice().forEach(id => post.removeUnit(id)); }
        for (let i = 0; i < 4; i++) {
            const post = f.watch(i % 2 ? 2 : 1), id = 10 + i;
            expect(f.missionStep(post, 3604 + i * 2).type).toBe("request");
            f.add(id, "DOG", 70); post.addUnit(id); post.removeUnit(id); f.objects.delete(id);
        }
        expect(f.missionStep(f.watch(1), 3612).type).toBe("noop"); expect(f.missionStep(f.watch(2), 3612).type).toBe("noop");
    });

    test("MissionController refill receipts stop both posts after the fourth real assignment", () => {
        const f = fixture(); f.ensure(); f.at(3600); f.controller.onAiUpdate(f.context);
        // Give HomeDog its initial receipt so the lower-priority posts can recruit.
        f.at(3602); f.add(1, "DOG", 20); f.controller.onAiUpdate(f.context);
        expect(f.home().getUnitIds()).toEqual([1]);
        for (let i = 0; i < 4; i++) {
            f.at(3604 + i * 2); f.add(10 + i, "DOG", 20); f.controller.onAiUpdate(f.context);
            const assigned = [...f.watch(1).getUnitIds(), ...f.watch(2).getUnitIds()];
            expect(assigned).toContain(10 + i);
            f.objects.delete(10 + i);
        }
        f.at(3612); f.controller.onAiUpdate(f.context);
        expect(f.controller.getRequestedUnitTypes().has("DOG")).toBe(false);
        expect(f.watch(1).getUnitIds()).toEqual([]); expect(f.watch(2).getUnitIds()).toEqual([]);
        expect(f.logs.filter(message => message.includes("multiple missions"))).toEqual([]);
    });

    test("all dog roles are explicitly inert under normal difficulty", () => {
        const f = watchFixture(), normal = { ...f.context, difficulty: "normal" as const };
        f.add(1, "DOG", 70); f.watch(1).acceptScout(1); f.add(2, "DOG", 20); f.home().addUnit(2);
        f.map.getAllTilesResourceData = () => { throw new Error("Normal watch resources"); };
        expect(f.missionStep(f.watch(1), 0, normal)).toEqual(noop()); expect(f.missionStep(f.home(), 0, normal)).toEqual(noop());
        const missions = new MissionController(() => {}); new WatchPostMissions(missions, () => {}).ensure(normal);
        expect(missions.getMissions()).toEqual([]); expect(f.orders).toEqual([]);
    });
});

describe("T2 P1 integrates the real E7 pressure module", () => {
    test("one visible vehicle exactly twelve from P1 triggers the adjusted threshold outside base range for 2700 ticks", () => {
        const f = fixture(); f.ensure();
        f.add(200, "MTNK", 92, 20, "enemy");
        f.visibleEnemies.add(200); f.at(100);
        expect(readPressure(f.context)).toMatchObject({ pressured: true, baseUnderSiege: false, earlyPressure: true,
            earlyPressureUntil: 2800, earlyPressurePosition: { rx: 92, ry: 20 } });
        f.visibleEnemies.clear(); f.at(2799); expect(isPressured(f.context)).toBe(true);
        f.at(2800); expect(isPressured(f.context)).toBe(false);
    });

    test("P1 registers the real legal fallback coordinate rather than the blocked raw midpoint", () => {
        const f = fixture(); f.revealAll(); f.blocked.add("80_20"); f.ensure();
        expect(f.watch(1).getPosition()).toEqual({ rx: 79, ry: 20 });
        f.add(200, "MTNK", 67, 20, "enemy"); f.add(201, "MTNK", 67, 20, "enemy");
        f.visibleEnemies.add(200); f.visibleEnemies.add(201); f.at(100);
        expect(readPressure(f.context).earlyPressure).toBe(true); // 47 from home, 12 from the legal P1
    });

    test.each(["zero", "thirteen", "hidden", "late"] as const)("%s does not trigger early P1 pressure", condition => {
        const f = fixture(); f.ensure();
        for (let i = 0; i < (condition === "zero" ? 0 : 2); i++) {
            f.add(200 + i, "MTNK", condition === "thirteen" ? 93 : 92, 20, "enemy");
            if (condition !== "hidden") f.visibleEnemies.add(200 + i);
        }
        f.at(condition === "late" ? 5400 : 100);
        expect(readPressure(f.context).earlyPressure).toBe(false);
        expect(isPressured(f.context)).toBe(false);
    });

    test("the authorized three-infantry threshold retains dog and engineer exclusions", () => {
        const f = fixture(); f.ensure();
        for (let i = 0; i < 4; i++) { f.add(200 + i, i % 2 ? "SENGINEER" : "DOG", 92, 20, "enemy"); f.visibleEnemies.add(200 + i); }
        f.at(100); expect(isPressured(f.context)).toBe(false);
        for (const id of [200, 201, 202]) { const unit = f.objects.get(id)!; unit.name = "E2"; unit.rules.name = "E2"; unit.rules.engineer = false; }
        f.at(102); expect(readPressure(f.context).earlyPressure).toBe(true);
    });

    test("unchanged P1 ensure calls do not invalidate pressure's once-per-tick cache", () => {
        const f = fixture(); f.ensure(); f.at(100);
        expect(isPressured(f.context)).toBe(false);
        f.add(200, "MTNK", 92, 20, "enemy"); f.add(201, "MTNK", 92, 20, "enemy");
        f.visibleEnemies.add(200); f.visibleEnemies.add(201); f.ensure(); f.ensure();
        expect(isPressured(f.context)).toBe(false);
        f.at(102); expect(isPressured(f.context)).toBe(true);
    });
});

describe("T2 HomeDog conditions, orders and replacement limit", () => {
    test("built barracks and no base-six dog request one at sixty, without a pressure or cash override", () => {
        const f = homeFixture(); f.player.credits = 0;
        f.add(200, "MTNK", 42, 20, "enemy"); f.visibleEnemies.add(200);
        expect(f.missionStep(f.home(), 100)).toEqual({ type: "request", unitNameToPriority: { DOG: 60 } });
        f.objects.get(101)!.buildStatus = String(BuildStatus.BuildUp);
        expect(f.missionStep(f.home(), 102)).toEqual(noop());
        f.objects.get(101)!.buildStatus = String(BuildStatus.BuildDown);
        expect(f.missionStep(f.home(), 104)).toEqual(noop());
        f.objects.delete(101); expect(f.missionStep(f.home(), 106)).toEqual(noop());
    });

    test("a locked dog at exactly six suppresses buying but is not stolen; at seven recruitment resumes", () => {
        const f = homeFixture(), other = new OtherDogMission("other"); f.controller.addMission(other);
        const dog = f.add(3, "DOG", 26); other.addUnit(3);
        expect(f.missionStep(f.home())).toEqual(noop());
        dog.tile = tile(27, 20);
        expect(f.missionStep(f.home(), 2)).toEqual({ type: "request", unitNameToPriority: { DOG: 60 } });
        f.controller.onAiUpdate(f.context); expect(f.home().getUnitIds()).toEqual([]); expect(other.getUnitIds()).toEqual([3]);
    });

    test("a free base dog is adopted by ID only after both initial scout receipts; assigned scout/watch dogs are never claimed", () => {
        const f = fixture(); f.ensure(); f.add(3, "DOG", 20);
        expect(f.missionStep(f.home())).toEqual(noop());
        f.add(1, "DOG", 60); f.scout().addUnit(1);
        expect(f.missionStep(f.home(), 2)).toEqual(noop());
        f.add(2, "DOG", 70); f.scout().addUnit(2);
        expect(f.missionStep(f.home(), 4)).toEqual({ type: "requestSpecific", unitIds: [3], priority: 60 });
        f.watch(1).acceptScout(3);
        expect(f.missionStep(f.home(), 6)).toEqual(noop());
        expect(f.watch(1).getUnitIds()).toEqual([3]);
    });

    test("one assigned home dog stays between home and the nearest owned refinery, with no extra request", () => {
        const f = homeFixture(); f.add(3, "DOG", 20); f.home().addUnit(3);
        f.add(102, "GAREFN", 60); f.add(103, "GAREFN", 30); f.add(200, "GAREFN", 22, 20, "enemy");
        expect(f.missionStep(f.home(), 100)).toEqual(noop());
        expect(f.orders.at(-1)).toEqual({ ids: [3], type: OrderType.Move, xOrTarget: 25, y: 20 });
        f.missionStep(f.home(), 102); expect(f.orders).toHaveLength(1);
        f.objects.get(3)!.tile = tile(25, 20); f.missionStep(f.home(), 104);
        expect(f.orders.at(-1)?.type).toBe(OrderType.Stop);
        const count = f.orders.length; f.missionStep(f.home(), 106); expect(f.orders).toHaveLength(count);
    });

    test.each(["ENGINEER", "SENGINEER"])("visible %s has priority over closer conscripts, then the dog returns when targets disappear", engineer => {
        const f = homeFixture(); f.add(3, "DOG", 20); f.home().addUnit(3); f.add(102, "GAREFN", 30);
        f.add(200, "E2", 22, 20, "enemy"); f.add(201, engineer, 32, 20, "enemy");
        f.visibleEnemies.add(200); f.visibleEnemies.add(201);
        f.missionStep(f.home(), 100);
        expect(f.orders.at(-1)).toEqual({ ids: [3], type: OrderType.Attack, xOrTarget: 201, y: undefined });
        f.missionStep(f.home(), 102); expect(f.orders).toHaveLength(1);
        f.visibleEnemies.clear(); f.missionStep(f.home(), 104);
        expect(f.orders.at(-1)).toEqual({ ids: [3], type: OrderType.Move, xOrTarget: 25, y: 20 });
    });

    test.each(["DOG", "ADOG"])("%s does not replace a live firing sequence with a home move when the visible target disappears", name => {
        for (const phase of ["public-firing", "fire-up", "firing", "initial-aim"]) {
            const f = homeFixture(name), dog = f.add(3, name, 30); f.home().addUnit(3); f.add(102, "GAREFN", 30);
            f.add(200, "E2", 28, 20, "enemy"); f.visibleEnemies.add(200); f.missionStep(f.home(), 100);
            expect(f.orders.at(-1)?.type).toBe(OrderType.Attack);
            dog.isFiring = phase === "public-firing";
            dog.attackState = (phase === "fire-up" ? AttackState.FireUp : phase === "firing" ? AttackState.Firing :
                phase === "initial-aim" ? AttackState.PrepareToFire : AttackState.Idle) as unknown as UnitData["attackState"];
            dog.primaryWeapon = { rules: { burst: 1 }, cooldownTicks: 0 } as unknown as UnitData["primaryWeapon"];
            f.visibleEnemies.clear(); f.missionStep(f.home(), 102);
            expect(f.orders).toHaveLength(1);
            dog.isFiring = false; dog.attackState = AttackState.Idle as unknown as UnitData["attackState"];
            f.missionStep(f.home(), 104);
            expect(f.orders.at(-1)).toEqual({ ids: [3], type: OrderType.Move, xOrTarget: 25, y: 20 });
        }
    });
    test.each(["DOG", "ADOG"])("%s can return home during a known post-shot single-bite cooldown", name => {
        const f = homeFixture(name), dog = f.add(3, name, 30); f.home().addUnit(3); f.add(102, "GAREFN", 30);
        f.add(200, "E2", 28, 20, "enemy"); f.visibleEnemies.add(200); f.missionStep(f.home(), 100);
        dog.isFiring = false; dog.attackState = AttackState.PrepareToFire as unknown as UnitData["attackState"];
        dog.primaryWeapon = { rules: { burst: 1 }, cooldownTicks: 7 } as unknown as UnitData["primaryWeapon"];
        f.visibleEnemies.clear(); f.missionStep(f.home(), 102);
        expect(f.orders.at(-1)).toEqual({ ids: [3], type: OrderType.Move, xOrTarget: 25, y: 20 });
    });
    test("home targets use visible infantry only within twelve, then nearest dog distance and ID ties", () => {
        const f = homeFixture(); f.add(3, "DOG", 25); f.home().addUnit(3);
        f.add(200, "ENGINEER", 33, 20, "enemy"); f.add(201, "E2", 22, 20, "enemy");
        f.add(202, "E2", 28, 20, "enemy"); f.add(203, "MTNK", 25, 20, "enemy");
        f.add(204, "SENGINEER", 25, 20, "enemy"); // hidden, not a candidate
        for (const id of [200, 201, 202, 203]) f.visibleEnemies.add(id);
        f.missionStep(f.home(), 100);
        expect(f.orders.at(-1)).toEqual({ ids: [3], type: OrderType.Attack, xOrTarget: 201, y: undefined });
        f.objects.get(202)!.tile = tile(27, 20); f.missionStep(f.home(), 102);
        expect(f.orders.at(-1)).toEqual({ ids: [3], type: OrderType.Attack, xOrTarget: 202, y: undefined });
    });

    test("no refinery means a legal home stand, not an undefined midpoint", () => {
        const f = homeFixture(); f.add(3, "DOG", 25); f.home().addUnit(3);
        f.missionStep(f.home(), 100);
        expect(f.orders.at(-1)).toEqual({ ids: [3], type: OrderType.Move, xOrTarget: 20, y: 20 });
    });

    test("initial home dog plus exactly three replacements, including true controller assignments", () => {
        const f = homeFixture();
        for (let i = 0; i < 4; i++) {
            const id = 10 + i; f.at(100 + i * 2); f.add(id, "DOG", 20);
            f.controller.onAiUpdate(f.context); expect(f.home().getUnitIds()).toEqual([id]);
            f.objects.delete(id);
        }
        f.at(108); f.controller.onAiUpdate(f.context);
        expect(f.home().getUnitIds()).toEqual([]);
        expect(f.missionStep(f.home(), 110)).toEqual(noop());
        f.add(20, "DOG", 20); f.home().addUnit(20);
        expect(f.missionStep(f.home(), 112)).toEqual({ type: "releaseUnits", unitIds: [20] });
    });

    test("HomeDog releases excess live dogs rather than becoming a multi-dog reserve", () => {
        const f = homeFixture(); f.add(3, "DOG", 20); f.add(4, "DOG", 21);
        f.home().addUnit(3); f.home().addUnit(4);
        expect(f.missionStep(f.home())).toEqual({ type: "releaseUnits", unitIds: [4] });
    });
});

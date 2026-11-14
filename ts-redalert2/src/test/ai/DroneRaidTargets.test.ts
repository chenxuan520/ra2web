import { describe, expect, test } from "bun:test";
import { ApiEventType, ObjectType, OrderType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { ActionBatcher } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";
import { Mission, requestSpecificUnits } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/mission";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { DroneRaidMission, DroneRaidMissionFactory, getDroneRaidAmbushPoint }
    from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/droneRaidMission";

const forbidden = () => { throw new Error("Hidden or out-of-scope read"); };
const key = (tile: { rx: number; ry: number }) => `${tile.rx}_${tile.ry}`;

function fixture() {
    let tick = 0, enemyReads = 0;
    const objects = new Map<number, any>(), hidden = new Set<number>(), offworld = new Set<number>();
    const unseenResources = new Set<string>(), invalidTiles = new Set<string>();
    const resources: any[] = [], orders: any[][] = [];
    const home = { name: "bot", startLocation: new Vector2() };
    Object.defineProperty(home, "credits", { get: forbidden });
    const starts = [home.startLocation, new Vector2(100, 0)];
    const add = (id: number, name: string, owner = "bot", rx = 0, ry = 0, extra = {}) => {
        const unit: any = { id, name, owner, type: ObjectType.Vehicle, tile: { rx, ry },
            zone: ZoneType.Ground, canMove: true, isWarpedOut: false, isIdle: true,
            rules: { name, type: ObjectType.Vehicle, harvester: name === "HARV" || name === "CMIN", ...extra } };
        objects.set(id, unit);
        return unit;
    };
    const drone = add(1, "DRON");
    const data = (id: number) => {
        if (hidden.has(id)) throw new Error(`Invisible object lookup ${id}`);
        return offworld.has(id) ? undefined : objects.get(id);
    };
    const game: any = {
        getCurrentTick: () => tick,
        getUnitData: data, getGameObjectData: data,
        getPlayerData: (name: string) => { if (name !== "bot") return forbidden(); return home; },
        getVisibleUnits: (name: string, relation: string, filter = (_rules: any) => true) => {
            expect(name).toBe("bot");
            expect(["self", "enemy"]).toContain(relation);
            if (relation === "enemy") enemyReads++;
            return [...objects.values()].filter(unit => !hidden.has(unit.id) && !offworld.has(unit.id) &&
                (relation === "self" ? unit.owner === "bot" : unit.owner === "enemy") && filter(unit.rules)).map(unit => unit.id);
        },
        getAllUnits: forbidden, getUnitsInArea: forbidden, getPlayers: forbidden, getGeneralRules: forbidden,
        generateRandom: forbidden, generateRandomInt: forbidden, getCurrentTime: forbidden,
        mapApi: {
            getStartingLocations: () => starts,
            getAllTilesResourceData: () => resources,
            getResourceCreditValues: () => ({ ore: 10, gems: 20 }),
            isVisibleTile: (tile: any, name: string) => { expect(name).toBe("bot"); return !unseenResources.has(key(tile)); },
            getTile: (rx: number, ry: number) => !invalidTiles.has(`${rx}_${ry}`) &&
                Number.isInteger(rx) && Number.isInteger(ry) && rx >= 0 && ry >= 0 && rx <= 200 && ry <= 200 ? { rx, ry } : undefined,
            getObjectsOnTile: forbidden, findPath: forbidden, isPassableTile: forbidden,
        },
    };
    const actions: any = { orderUnits: (...args: any[]) => orders.push(args), setUnitDebugText: () => {},
        queueForProduction: forbidden, unqueueFromProduction: forbidden };
    const context: any = { game, player: { name: "bot", actions, production: new Proxy({}, { get: forbidden }) },
        difficulty: "brutal", matchAwareness: new Proxy({}, { get: forbidden }) };
    const mission = new DroneRaidMission(() => {});
    mission.addUnit(drone.id);
    return { context, home, starts, hidden, offworld, resources, unseenResources, invalidTiles,
        drone, mission, orders, add, enemyReads: () => enemyReads,
        step(value: number) {
            tick = value;
            const actionBatcher = new ActionBatcher();
            const result = mission.onAiUpdate({ ...context, actionBatcher });
            actionBatcher.resolve(actions, game.mapApi);
            return result;
        } };
}

function resource(rx: number, ry: number) {
    return { tile: { rx, ry }, ore: 200, gems: 0, spawnsOre: false };
}

function guard(f: ReturnType<typeof fixture>, id: number, name: string, rx: number, ry: number) {
    const unit = f.add(id, name, "enemy", rx, ry, { type: ObjectType.Building });
    unit.type = ObjectType.Building;
    return unit;
}

describe("drone raid visible targets", () => {
    test("a distant miner takes priority over a nearby ground tank", () => {
        const f = fixture();
        f.add(10, "CMIN", "enemy", 20); f.add(11, "MTNK", "enemy", 4);
        f.step(0);
        expect(f.orders).toEqual([[[1], OrderType.Attack, 10]]);
    });

    test.each([8, 8.01])("the non-miner fallback attacks only within eight current tiles: %s", distance => {
        const f = fixture(); f.add(10, "HTNK", "enemy", distance);
        f.step(0);
        expect(f.orders).toEqual(distance <= 8 ? [[[1], OrderType.Attack, 10]] : [[[1], OrderType.Move, 80, 0]]);
    });
    test("no miner sighting does not lure a staged drone into a long vehicle pursuit", () => {
        const f = fixture(); f.resources.push(resource(40, 68)); f.drone.tile = { rx: 40, ry: 68 };
        const tank = f.add(10, "HTNK", "enemy", 75, 87); f.step(0);
        expect(f.orders).toEqual([]);
        tank.tile = { rx: 48, ry: 68 }; f.step(30);
        expect(f.orders).toEqual([[[1], OrderType.Attack, 10]]);
    });
    test.each(["GAPILL", "NALASR", "TESLA", "ATESLA"])("%s excludes a miner at six tiles, not seven", name => {
        const f = fixture();
        f.add(10, "HARV", "enemy", 20); f.add(11, "HTNK", "enemy", 4, 4);
        const defence = guard(f, 12, name, 26, 0);
        f.step(0);
        expect(f.orders).toEqual([[[1], OrderType.Attack, 11]]);
        defence.tile.rx = 27;
        f.step(30);
        expect(f.orders.at(-1)).toEqual([[1], OrderType.Attack, 10]);
    });

    test("the same defence exclusion applies to the vehicle fallback", () => {
        const f = fixture();
        f.add(10, "HTNK", "enemy", 8); guard(f, 11, "NALASR", 14, 0);
        f.step(0);
        expect(f.orders).toEqual([[[1], OrderType.Move, 80, 0]]);
    });

    test("nearest eligible targets use stable ID ties, independent of enumeration", () => {
        for (const reversed of [false, true]) {
            const f = fixture();
            for (const id of reversed ? [10, 11, 12] : [12, 11, 10]) {
                f.add(id, "HARV", "enemy", id === 12 ? 11 : 10);
            }
            f.step(0);
            expect(f.orders).toEqual([[[1], OrderType.Attack, 10]]);
        }
    });

    test("infantry, aircraft, water vehicles and enemy DRON are not vehicle targets", () => {
        const f = fixture();
        f.add(10, "DRON", "enemy", 1);
        f.add(11, "SUB", "enemy", 2).zone = ZoneType.Water;
        f.add(12, "DLPH", "enemy", 3).zone = ZoneType.Air;
        f.add(13, "E1", "enemy", 4).type = ObjectType.Infantry;
        f.add(14, "ORCA", "enemy", 5).type = ObjectType.Aircraft;
        f.add(15, "MTNK", "enemy", 8);
        f.step(0);
        expect(f.orders).toEqual([[[1], OrderType.Attack, 15]]);
    });

    test("two drones do not choose the same miner, even with reversed owned IDs", () => {
        const f = fixture();
        f.add(2, "DRON"); f.mission.addUnit(2);
        f.mission.removeUnit(1); f.mission.addUnit(1);
        f.add(10, "HARV", "enemy", 10); f.add(11, "CMIN", "enemy", 20);
        f.step(0);
        expect(f.orders).toEqual([[[1], OrderType.Attack, 10], [[2], OrderType.Attack, 11]]);
        f.drone.tile.rx = 30;
        f.step(30);
        expect(f.orders).toHaveLength(2);
    });

    test("no hidden enemy lookup, exact HP, weapons, passengers, economy or randomness is read", () => {
        const f = fixture();
        const miner = f.add(10, "HARV", "enemy", 20);
        for (const field of ["hitPoints", "maxHitPoints", "primaryWeapon", "secondaryWeapon", "purchaseValue",
            "isFiring", "isIdle", "isWarpedOut", "canMove", "passengerSlotCount", "passengerSlotMax", "mindControlledBy",
            "harvestedOre", "harvestedGems"]) Object.defineProperty(miner, field, { get: forbidden });
        const invisible = guard(f, 50, "GAPILL", 20, 0);
        f.hidden.add(50);
        for (const field of ["tile", "rules", "owner"]) Object.defineProperty(invisible, field, { get: forbidden });
        f.step(0);
        expect(f.orders).toEqual([[[1], OrderType.Attack, 10]]);
    });
});

describe("drone raid public ambush points", () => {
    test("uses the closest public other start, without reading its player assignment", () => {
        const f = fixture();
        f.starts.splice(0, f.starts.length, new Vector2(150, 0), new Vector2(100, 0), f.home.startLocation);
        expect(getDroneRaidAmbushPoint(f.context)).toEqual(new Vector2(80, 0));
        f.home.startLocation = new Vector2(100, 0);
        expect(getDroneRaidAmbushPoint(f.context)).toEqual(new Vector2(130, 0));
    });

    test("start ties use coordinates rather than start-slot order", () => {
        const f = fixture();
        f.starts.splice(0, f.starts.length, new Vector2(100, 0), f.home.startLocation, new Vector2(0, 100));
        expect(getDroneRaidAmbushPoint(f.context)).toEqual(new Vector2(0, 80));
        f.starts.reverse();
        expect(getDroneRaidAmbushPoint(f.context)).toEqual(new Vector2(0, 80));
    });

    test("chooses the patch closest by its nearest tile, then its tile nearest home", () => {
        const f = fixture();
        for (let rx = 20; rx <= 90; rx += 2) f.resources.push(resource(rx, 0));
        f.resources.push(resource(94, 10));
        expect(getDroneRaidAmbushPoint(f.context)).toEqual(new Vector2(20, 0));
        f.step(0);
        expect(f.orders).toEqual([[[1], OrderType.Move, 20, 0]]);
    });

    test("unseen resource amounts are never read or used as an ambush", () => {
        const f = fixture();
        const invisible = resource(90, 0);
        f.resources.push(invisible, resource(60, 0));
        f.unseenResources.add("90_0");
        for (const field of ["ore", "gems", "spawnsOre"]) Object.defineProperty(invisible, field, { get: forbidden });
        expect(getDroneRaidAmbushPoint(f.context)).toEqual(new Vector2(60, 0));
    });

    test("no opposing public start or an invalid public point produces no order", () => {
        const f = fixture();
        f.starts.splice(1);
        expect(getDroneRaidAmbushPoint(f.context)).toBeUndefined();
        f.step(0);
        expect(f.orders).toEqual([]);
        f.starts.push(new Vector2(100, 0)); f.invalidTiles.add("80_0");
        f.step(30);
        expect(f.orders).toEqual([]);
    });

    test("already at the ambush point means hold position, not repeated moves home", () => {
        const f = fixture(); f.drone.tile.rx = 80;
        f.step(0); f.step(60);
        expect(f.orders).toEqual([]);
    });
});

describe("drone raid cadence and ownership", () => {
    test("checks targets every thirty ticks and does not repeat an idle target before sixty", () => {
        const f = fixture(); f.add(10, "HARV", "enemy", 20);
        f.step(0); f.step(29);
        expect(f.enemyReads()).toBe(1);
        f.step(30); f.step(59);
        expect(f.orders).toHaveLength(1);
        f.step(60);
        expect(f.orders).toEqual([[[1], OrderType.Attack, 10], [[1], OrderType.Attack, 10]]);
    });

    test("a newly selected target is ordered at thirty ticks without waiting for sixty", () => {
        const f = fixture(); f.add(10, "HARV", "enemy", 20);
        f.step(0); f.add(11, "CMIN", "enemy", 10);
        f.step(29);
        expect(f.orders).toHaveLength(1);
        f.step(30);
        expect(f.orders.at(-1)).toEqual([[1], OrderType.Attack, 11]);
    });

    test("busy attacks and paths are not restarted merely because sixty ticks elapsed", () => {
        const f = fixture(); f.add(10, "HARV", "enemy", 20); f.drone.isIdle = false;
        f.step(0); f.step(60);
        expect(f.orders).toHaveLength(1);
        f.hidden.add(10);
        f.step(90); f.step(150);
        expect(f.orders).toEqual([[[1], OrderType.Attack, 10], [[1], OrderType.Move, 80, 0]]);
    });

    test("owns all existing DRON with specific requests above field priority, never requests production", () => {
        const f = fixture(); f.add(2, "DRON"); f.add(3, "HTNK");
        const controller = new MissionController(() => {});
        class OtherMission extends Mission {
            constructor() { super("other", () => {}); }
            _onAiUpdate() { return requestSpecificUnits([1, 2, 3], 50); }
            getPriority() { return 50; }
            getGlobalDebugText() { return undefined; }
        }
        const other = new OtherMission();
        f.mission.removeUnit(1);
        controller.addMission(other); controller.addMission(f.mission);
        controller.onAiUpdate(f.context);
        expect(f.mission.getUnitIds()).toEqual([1, 2]);
        expect(other.getUnitIds()).toEqual([3]);
        expect(f.mission.getPriority()).toBeGreaterThan(50);
        expect(f.mission.isUnitsLocked()).toBe(true);
        expect(controller.getRequestedUnitTypes().size).toBe(0);
    });

    test("a stale ID whose ownership changed is never queried or commanded as own", () => {
        const f = fixture(); f.add(10, "HARV", "enemy", 20);
        f.step(0);
        f.drone.owner = "enemy"; f.hidden.add(1);
        expect(() => f.step(30)).not.toThrow();
        expect(f.mission.getUnitIds()).toEqual([]);
        expect(f.orders).toHaveLength(1);
    });

    test.each([ApiEventType.ObjectDestroy, ApiEventType.ObjectOwnerChange])("unspawn preserves a target reservation; event %s releases it", type => {
        const f = fixture(); f.add(10, "HARV", "enemy", 20);
        f.step(0);
        f.offworld.add(1);
        f.mission.onGameEvent({ type: ApiEventType.ObjectUnspawn, target: 1 });
        f.add(2, "DRON"); f.mission.addUnit(2);
        f.step(30);
        expect(f.orders.at(-1)).toEqual([[2], OrderType.Move, 80, 0]);
        f.mission.onGameEvent({ type, target: 1, prevOwnerName: "bot", newOwnerName: "enemy" });
        f.step(60);
        expect(f.orders.at(-1)).toEqual([[2], OrderType.Attack, 10]);
    });

    test("the same own ID can be reclaimed after limbo without losing its attack cooldown", () => {
        const f = fixture(); f.add(10, "HARV", "enemy", 20);
        f.step(0); f.offworld.add(1); f.step(30);
        f.offworld.delete(1);
        expect(f.step(31)).toEqual({ type: "requestSpecific", unitIds: [1], priority: 80 });
        f.mission.addUnit(1); f.step(32);
        expect(f.orders).toHaveLength(1);
        f.step(62);
        expect(f.orders.at(-1)).toEqual([[1], OrderType.Attack, 10]);
    });

    test.each(["normal", undefined])("%s does not create or run a raid mission", difficulty => {
        const f = fixture(); f.context.difficulty = difficulty;
        const controller = new MissionController(() => {});
        f.context.game = new Proxy({}, { get: forbidden });
        new DroneRaidMissionFactory().maybeCreateMissions(f.context, controller, () => {});
        expect(controller.getMissions()).toEqual([]);
        expect(f.step(0)).toEqual({ type: "noop" });
        expect(f.orders).toEqual([]);
    });

    test("the brutal factory creates only one persistent, production-free mission", () => {
        const f = fixture(), controller = new MissionController(() => {}), factory = new DroneRaidMissionFactory();
        factory.maybeCreateMissions(f.context, controller, () => {});
        factory.maybeCreateMissions(f.context, controller, () => {});
        expect(controller.getMissions()).toHaveLength(1);
        expect(controller.getMissions()[0]).toBeInstanceOf(DroneRaidMission);
    });
});

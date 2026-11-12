import { describe, expect, test } from "bun:test";
import { BuildStatus } from "../../game/gameobject/Building";
import { ObjectType, OrderType, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { ParasiteRepair } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/parasiteRepair";

const forbidden = () => { throw new Error("Hidden or out-of-scope read"); };

function fixture() {
    let tick = 0, minerReads = 0;
    const objects = new Map<number, any>(), hidden = new Set<number>(), offworld = new Set<number>();
    const orders: any[][] = [];
    const add = (id: number, name: string, owner = "bot", rx = 0, ry = 0, type = ObjectType.Vehicle) => {
        const unit: any = { id, name, owner, type, tile: { rx, ry }, foundation: { width: 3, height: 3 },
            hitPoints: 1000, maxHitPoints: 1000, zone: ZoneType.Ground, canMove: true, isIdle: true, isWarpedOut: false,
            buildStatus: BuildStatus.Ready, isPoweredOn: true,
            rules: { name, type, naval: false, consideredAircraft: false, landable: false, dock: [],
                unitRepair: type === ObjectType.Building, helipad: false, numberOfDocks: type === ObjectType.Building ? 1 : 0 } };
        objects.set(id, unit);
        return unit;
    };
    const miner = add(1, "CMIN"), depot = add(2, "GADEPT", "bot", 10, 0, ObjectType.Building);
    const drone = add(50, "DRON", "enemy", 80);
    const game: any = {
        getCurrentTick: () => tick,
        getVisibleUnits: (name: string, relation: string, filter = (_rules: any) => true) => {
            expect(name).toBe("bot"); expect(["self", "enemy"]).toContain(relation);
            return [...objects.values()].filter(unit => !hidden.has(unit.id) && !offworld.has(unit.id) &&
                (relation === "self" ? unit.owner === "bot" : unit.owner === "enemy") && filter(unit.rules)).map(unit => unit.id);
        },
        getUnitData: (id: number) => {
            if (hidden.has(id) || offworld.has(id)) throw new Error(`Invisible/off-world lookup ${id}`);
            if (id === miner.id) minerReads++;
            return objects.get(id);
        },
        getGameObjectData: forbidden, getAllUnits: forbidden, getUnitsInArea: forbidden, getPlayers: forbidden,
        getPlayerData: forbidden, getGeneralRules: forbidden, getWorld: forbidden,
        getCurrentTime: forbidden, generateRandom: forbidden, generateRandomInt: forbidden,
        rulesApi: new Proxy({}, { get: forbidden }), mapApi: new Proxy({}, { get: forbidden }),
    };
    const repair = new ParasiteRepair();
    const context: any = { difficulty: "brutal", game,
        player: { name: "bot", production: new Proxy({}, { get: forbidden }), actions: {
            orderUnits: (...args: any[]) => {
                orders.push(args);
                // Local fixture acknowledgement, not a global mock or engine outcome.
                for (const id of args[0]) objects.get(id).isIdle = false;
            },
            queueForProduction: forbidden,
        } }, matchAwareness: new Proxy({}, { get: forbidden }) };
    return { context, objects, hidden, offworld, miner, depot, drone, orders, repair, add,
        reads: () => minerReads,
        step(at: number, hp?: number) { tick = at; if (hp !== undefined) miner.hitPoints = hp; repair.onAiUpdate(context); },
        wound() { tick = 0; repair.onAiUpdate(context); tick = 30; miner.hitPoints = 950; repair.onAiUpdate(context);
            tick = 60; miner.hitPoints = 900; repair.onAiUpdate(context); } };
}

describe("parasite repair observed HP window", () => {
    test("two real sixty-tick damage losses still trigger with intervening CMIN self-healing", () => {
        const f = fixture();
        f.step(0); f.hidden.add(f.drone.id);
        f.step(30, 951); f.step(60, 953);
        expect(f.orders).toEqual([]);
        f.step(90, 905);
        expect(f.orders).toEqual([[[1], OrderType.Dock, 2]]);
        expect(f.repair.isRepairing(1)).toBe(true);
    });

    test("one loss plus healing or flat samples is insufficient", () => {
        const f = fixture();
        f.step(0); f.step(30, 950); f.step(60, 951); f.step(90, 951); f.step(120, 951); f.step(150, 951);
        expect(f.orders).toEqual([]); expect(f.repair.isRepairing(1)).toBe(false);
    });

    test("the one-hundred-twenty-tick window includes its boundary", () => {
        const f = fixture();
        f.step(0); f.step(30, 950); f.step(60, 955); f.step(90); f.step(120); f.step(150, 905);
        expect(f.orders).toEqual([[[1], OrderType.Dock, 2]]);
    });

    test("losses more than one hundred twenty ticks apart do not trigger", () => {
        const f = fixture();
        f.step(0); f.step(30, 950); f.step(60, 955); f.step(90); f.step(120); f.step(150); f.step(180, 905);
        expect(f.orders).toEqual([]);
    });

    test("full health clears the earlier damage window", () => {
        const f = fixture();
        f.step(0); f.step(30, 950); f.step(60, 1000); f.step(90, 950);
        expect(f.orders).toEqual([]);
    });

    test("each own vehicle has an independent loss history", () => {
        const f = fixture(), tank = f.add(3, "HTNK", "bot", 1);
        f.step(0); f.step(30, 950);
        tank.hitPoints = 950; f.step(60);
        expect(f.orders).toEqual([]);
        tank.hitPoints = 900; f.step(90);
        expect(f.orders).toEqual([[[3], OrderType.Dock, 2]]);
        expect(f.repair.isRepairing(1)).toBe(false); expect(f.repair.isRepairing(3)).toBe(true);
    });

    test("observations use simulation ticks at thirty-tick cadence", () => {
        const f = fixture();
        f.step(0); f.step(29, 950);
        expect(f.reads()).toBe(1);
        f.step(30); f.step(31, 900);
        expect(f.orders).toEqual([]); expect(f.reads()).toBe(2);
        f.step(60);
        expect(f.reads()).toBe(3); expect(f.orders).toEqual([[[1], OrderType.Dock, 2]]);
    });

    test.each([undefined, NaN, Infinity])("unknown/nonfinite own HP %s is not fabricated as damage", hp => {
        const f = fixture(); f.miner.hitPoints = hp;
        f.step(0); f.step(30); f.step(60);
        expect(f.orders).toEqual([]); expect(f.repair.isRepairing(1)).toBe(false);
    });
});

describe("parasite repair visible evidence and Dock eligibility", () => {
    test("no observed enemy drone means no suspected-parasite order", () => {
        const f = fixture(); f.hidden.add(f.drone.id); f.wound();
        expect(f.orders).toEqual([]);
    });

    test("a brief visible drone between HP scans is remembered without extra HP reads", () => {
        const f = fixture(); f.hidden.add(f.drone.id); f.step(0);
        f.hidden.delete(f.drone.id); f.step(2);
        f.hidden.add(f.drone.id); f.step(4);
        expect(f.reads()).toBe(1);
        f.step(30, 951); f.step(60, 953); f.step(90, 905);
        expect(f.reads()).toBe(4);
        expect(f.orders).toEqual([[[1], OrderType.Dock, 2]]);
    });

    test.each([ObjectType.Vehicle, ObjectType.Infantry, ObjectType.Building, ObjectType.Aircraft])("any visible enemy type %s within eight tiles prevents a new order", type => {
        const f = fixture(), enemy = f.add(51, "threat", "enemy", 8, 0, type);
        f.wound(); expect(f.orders).toEqual([]);
        enemy.tile.rx = 9; f.step(90, 899);
        expect(f.orders).toEqual([[[1], OrderType.Dock, 2]]);
    });

    test.each(["missing", "build-up", "build-down", "warped", "stolen", "wrong-type", "not-repair", "no-dock", "helipad", "naval-mismatch", "unpowered"])("a %s depot is not a repair destination", reason => {
        const f = fixture();
        if (reason === "missing") f.objects.delete(f.depot.id);
        if (reason === "build-up") f.depot.buildStatus = BuildStatus.BuildUp;
        if (reason === "build-down") f.depot.buildStatus = BuildStatus.BuildDown;
        if (reason === "warped") f.depot.isWarpedOut = true;
        if (reason === "stolen") { f.depot.owner = "enemy"; f.hidden.add(f.depot.id); }
        if (reason === "wrong-type") f.depot.type = ObjectType.Vehicle;
        if (reason === "not-repair") f.depot.rules.unitRepair = false;
        if (reason === "no-dock") f.depot.rules.numberOfDocks = 0;
        if (reason === "helipad") f.depot.rules.helipad = true;
        if (reason === "naval-mismatch") f.depot.rules.naval = true;
        if (reason === "unpowered") f.depot.isPoweredOn = false;
        f.wound(); expect(f.orders).toEqual([]);
    });

    test("explicitly non-parasiteable vehicles such as DRON never get a false repair intent", () => {
        const f = fixture(); f.miner.name = f.miner.rules.name = "DRON"; f.miner.rules.parasiteable = false;
        f.wound();
        expect(f.orders).toEqual([]); expect(f.repair.isRepairing(f.miner.id)).toBe(false);
    });
    test("NADEPT is supported with the same actual Dock command", () => {
        const f = fixture(); f.depot.name = f.depot.rules.name = "NADEPT";
        f.wound(); expect(f.orders).toEqual([[[1], OrderType.Dock, 2]]);
    });

    test.each(["infantry", "aircraft", "water", "warped", "immobile", "nonlandable"])("an own %s object is not ordered into a ground repair depot", reason => {
        const f = fixture();
        if (reason === "infantry") f.miner.type = f.miner.rules.type = ObjectType.Infantry;
        if (reason === "aircraft") f.miner.type = f.miner.rules.type = ObjectType.Aircraft;
        if (reason === "water") f.miner.zone = ZoneType.Water;
        if (reason === "warped") f.miner.isWarpedOut = true;
        if (reason === "immobile") f.miner.canMove = false;
        if (reason === "nonlandable") { f.miner.rules.consideredAircraft = true; f.miner.rules.dock = ["GADEPT"]; }
        f.wound(); expect(f.orders).toEqual([]);
    });

    test("a closer eligible depot wins, with stable numeric ID ties", () => {
        const near = fixture(); near.add(3, "NADEPT", "bot", 5, 0, ObjectType.Building);
        near.wound(); expect(near.orders).toEqual([[[1], OrderType.Dock, 3]]);
        for (const reversed of [false, true]) {
            const f = fixture(); f.add(3, "NADEPT", "bot", 0, 10, ObjectType.Building);
            if (reversed) { f.objects.delete(2); f.objects.set(2, f.depot); }
            f.wound(); expect(f.orders).toEqual([[[1], OrderType.Dock, 2]]);
        }
    });

    test("the first repair order can interrupt a busy Gather or Combat task", () => {
        const f = fixture(); f.miner.isIdle = false;
        f.wound(); expect(f.orders).toEqual([[[1], OrderType.Dock, 2]]);
    });
});

describe("parasite repair intent ownership and cleanup", () => {
    test("busy travel and idle-at-depot healing do not restart Dock", () => {
        const f = fixture(); f.wound();
        f.step(90, 880); f.step(120, 860); f.step(150, 840); f.step(180, 820);
        expect(f.orders).toHaveLength(1); expect(f.repair.isRepairing(1)).toBe(true);
        f.miner.tile = { ...f.depot.tile }; f.miner.isIdle = true;
        f.step(210, 800); f.step(240, 805);
        expect(f.orders).toHaveLength(1); expect(f.repair.isRepairing(1)).toBe(true);
        f.step(270, 1000);
        expect(f.repair.isRepairing(1)).toBe(false); expect(f.orders).toHaveLength(1);
    });

    test("idle outside the depot releases a failed/cancelled intent without an immediate repeat", () => {
        const f = fixture(); f.wound(); f.miner.isIdle = true;
        f.step(90, 890);
        expect(f.repair.isRepairing(1)).toBe(false); expect(f.orders).toHaveLength(1);
        f.step(120, 880); f.step(150, 870);
        expect(f.orders).toHaveLength(2); expect(f.repair.isRepairing(1)).toBe(true);
    });

    test.each(["disappeared", "warped", "stolen"])("a %s depot clears its repair intent", reason => {
        const f = fixture(); f.wound();
        if (reason === "disappeared") f.objects.delete(2);
        if (reason === "warped") f.depot.isWarpedOut = true;
        if (reason === "stolen") { f.depot.owner = "enemy"; f.hidden.add(2); }
        f.step(90, 880);
        expect(f.repair.isRepairing(1)).toBe(false); expect(f.orders).toHaveLength(1);
    });

    test("an invalidated destination can be replaced by another currently eligible owned depot", () => {
        const f = fixture(); f.wound(); f.objects.delete(2);
        f.add(3, "NADEPT", "bot", 12, 0, ObjectType.Building);
        f.step(90, 880);
        expect(f.orders).toEqual([[[1], OrderType.Dock, 2], [[1], OrderType.Dock, 3]]);
        expect(f.repair.isRepairing(1)).toBe(true);
    });

    test.each(["ownership-loss", "off-world", "destroyed"])("%s clears own identity without looking up an old hidden ID", reason => {
        const f = fixture(); f.wound();
        if (reason === "ownership-loss") { f.miner.owner = "enemy"; f.hidden.add(1); }
        if (reason === "off-world") f.offworld.add(1);
        if (reason === "destroyed") f.objects.delete(1);
        for (const field of ["hitPoints", "maxHitPoints", "tile", "rules", "limboData"]) Object.defineProperty(f.miner, field, { get: forbidden });
        expect(() => f.step(90)).not.toThrow();
        expect(f.repair.isRepairing(1)).toBe(false); expect(f.orders).toHaveLength(1);
    });

    test("visible foreign vehicles' private HP never becomes an own repair history", () => {
        const f = fixture(); f.miner.owner = "enemy";
        for (const field of ["hitPoints", "maxHitPoints", "canMove", "isIdle", "isWarpedOut", "parasiteableTrait", "limboData"]) {
            Object.defineProperty(f.miner, field, { get: forbidden });
        }
        f.step(0); f.step(30); f.step(60);
        expect(f.orders).toEqual([]); expect(f.repair.isRepairing(1)).toBe(false);
    });

    test("invisible enemy getters, private parasite/limbo state, money and randomness are never read", () => {
        const f = fixture();
        for (const field of ["hitPoints", "maxHitPoints", "canMove", "isIdle", "isWarpedOut", "primaryWeapon", "passengerSlotCount", "limboData"]) {
            Object.defineProperty(f.drone, field, { get: forbidden });
        }
        const invisible = f.add(51, "HTNK", "enemy", 0); f.hidden.add(51);
        for (const field of ["tile", "rules", "owner", "hitPoints"]) Object.defineProperty(invisible, field, { get: forbidden });
        for (const field of ["parasiteableTrait", "parasite", "limboData", "cash", "purchaseValue", "primaryWeapon", "passengerSlotCount"]) {
            Object.defineProperty(f.miner, field, { get: forbidden });
        }
        f.wound(); expect(f.orders).toEqual([[[1], OrderType.Dock, 2]]);
    });

    test.each(["normal", undefined])("%s does not observe units or emit commands", difficulty => {
        const f = fixture(); f.context.difficulty = difficulty;
        f.context.game = new Proxy({}, { get: forbidden });
        f.step(0); f.step(30); f.step(60);
        expect(f.orders).toEqual([]); expect(f.repair.isRepairing(1)).toBe(false);
    });
});

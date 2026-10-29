import { describe, expect, test } from "bun:test";
import { GameApi } from "../../game/api/GameApi";
import { ObjectType } from "../../engine/type/ObjectType";

// Real API, world double. Actual MakesDisguise, movement and damage are covered
// separately by the engine fixture; these are information-contract checks.
function fixture() {
    const objects: any[] = [];
    const shared = new Set(["viewer:friend", "friend:viewer"]);
    const players = ["viewer", "enemy", "third", "friend", "civilian"].map(name => ({
        name, sharedDetectDisguiseTrait: new Set<any>(), isCombatant: () => name !== "civilian",
        getOwnedObjects: () => objects.filter(object => object.owner?.name === name),
    }));
    const [viewer, enemy, third, friend, civilian] = players;
    const hidden = new Map(players.map(player => [player, new Set<number>()]));
    let missingShroud = false;
    const game: any = {
        rules: {}, getPlayerByName: (name: string) => players.find(player => player.name === name),
        getCivilianPlayer: () => civilian, getObjectById: (id: number) => objects.find(object => object.id === id),
        getWorld: () => ({ getAllObjects: () => objects, hasObjectId: (id: number) => objects.some(object => object.id === id) }),
        alliances: { areAllied: (a: any, b: any) => shared.has(`${a.name}:${b.name}`),
            haveSharedIntel: (a: any, b: any) => a === b || shared.has(`${a.name}:${b.name}`) },
        map: { tileOccupation: { calculateTilesForGameObject: (_tile: any, object: any) => [object.tile] },
            technosByTile: { queryRange: () => objects.filter(object => object.isTechno()) } },
        mapShroudTrait: { getPlayerShroud: (player: any) => missingShroud ? undefined : {
            isShrouded: (tile: any) => hidden.get(player)!.has(tile.rx) } },
    };
    function unit(id: number, name = "E1", owner: any = enemy, type = ObjectType.Infantry) {
        const object: any = {
            id, name, owner, type, rules: { name, type, strength: name === "SPY" ? 100 : 125 },
            tile: { rx: id, ry: 2 }, tileElevation: 0, isDestroyed: false,
            position: { worldPosition: { clone: () => ({ x: id, y: 0, z: 2 }) } },
            getFoundation: () => ({ width: 1, height: 1 }),
            healthTrait: { getHitPoints: () => 50, maxHitPoints: 100, level: 1, health: 50 },
            direction: 3, onBridge: false, zone: "ground", veteranLevel: 0, stance: "standing", isFiring: false,
            sight: 5, purchaseValue: 200, guardMode: true,
            isTechno: () => type !== ObjectType.Terrain, isTerrain: () => type === ObjectType.Terrain,
            isInfantry: () => type === ObjectType.Infantry, isVehicle: () => type === ObjectType.Vehicle,
            isBuilding: () => type === ObjectType.Building, isAircraft: () => type === ObjectType.Aircraft,
            isUnit: () => type !== ObjectType.Building && type !== ObjectType.Terrain,
            unitOrderTrait: { hasTasks: () => false },
            moveTrait: { isDisabled: () => false, velocity: { clone: () => ({ x: 1, y: 0, z: 0 }) } },
            warpedOutTrait: { isActive: () => false }, autoRepairTrait: { isDisabled: () => true },
        };
        objects.push(object); return object;
    }
    function disguise(object: any, rules: any, owner: any) {
        let active = true;
        object.disguiseTrait = { getDisguise: () => active ? { rules, owner } : undefined };
        return (value: boolean) => { active = value; };
    }
    return { game, objects, viewer, enemy, third, friend, civilian, hidden, shared, unit, disguise,
        missingShroud: (value: boolean) => { missingShroud = value; }, api: GameApi.forPlayer(game, true, "viewer") };
}
const privateFields = ["sight", "purchaseValue", "guardMode", "primaryWeapon", "secondaryWeapon", "armedTrait", "attackTrait",
    "unitOrderTrait", "moveTrait", "factoryTrait", "rallyTrait", "poweredTrait", "transportTrait", "garrisonTrait", "harvesterTrait",
    "ammo", "warpedOutTrait", "mindControllableTrait", "tntChargeTrait", "turretNo", "isFiring", "stance"];
const absentFields = ["hitPoints", "maxHitPoints", "healthRatio", "sight", "purchaseValue", "guardMode", "primaryWeapon", "secondaryWeapon", "deathWeapon",
    "attackState", "isIdle", "canMove", "velocity", "factory", "rallyPoint", "isPoweredOn", "garrisonUnitCount", "garrisonUnitsMax",
    "passengerSlotCount", "passengerSlotMax", "harvestedOre", "harvestedGems", "ammo", "isWarpedOut", "mindControlledBy", "tntTimer", "turretNo", "isFiring", "stance"];
function poisonPrivateFields(object: any) {
    for (const field of privateFields) Object.defineProperty(object, field, { configurable: true, get: () => { throw new Error(`private ${field} read`); } });
    for (const field of ["maxHitPoints", "health"]) Object.defineProperty(object.healthTrait, field, {
        configurable: true, get: () => { throw new Error(`private ${field} read`); } });
    object.healthTrait.getHitPoints = () => { throw new Error("private HP read"); };
}
function observe(api: GameApi, id: number) {
    const filtered: string[] = [], filter = (rules: any) => { filtered.push(rules.name); return true; };
    return { all: api.getAllUnits(filter), enemy: api.getVisibleUnits("viewer", "enemy", filter),
        hostile: api.getVisibleUnits("viewer", "hostile", filter), neutral: api.getNeutralUnits(filter),
        area: api.getUnitsInArea({}), terrain: api.getAllTerrainObjects(), generic: api.getGameObjectData(id),
        unit: api.getUnitData(id), filtered };
}

describe("GameApi current apparent identity", () => {
    test("same public E1 appearance has identical values and keys for true E1 and foreign SPY", () => {
        const f = fixture(), real = f.unit(1, "E1", f.third), rules = real.rules;
        poisonPrivateFields(real);
        const before = observe(f.api, 1);
        expect(before.unit?.healthLevel).toBe(1);
        for (const key of absentFields) expect(Object.hasOwn(before.unit!, key)).toBe(false);
        f.objects.length = 0;
        const spy = f.unit(1, "SPY", f.enemy);
        f.disguise(spy, rules, f.third); poisonPrivateFields(spy);
        for (const key of ["rules", "name", "type"]) Object.defineProperty(spy, key, { get: () => { throw new Error(`true SPY ${key} read`); } });
        const after = observe(f.api, 1);
        expect(after).toEqual(before);
        expect(Object.keys(after.unit!).sort()).toEqual(Object.keys(before.unit!).sort());
        expect(after.filtered).toEqual(["E1", "E1", "E1"]);
    });
    test("hidden firing and stance cannot distinguish the same Ready appearance", () => {
        const f = fixture(), real = f.unit(1, "E1", f.third);
        real.isFiring = false; real.stance = 0;
        const rules = real.rules, before = observe(f.api, 1);
        f.objects.length = 0;
        const spy = f.unit(1, "SPY", f.enemy);
        f.disguise(spy, rules, f.third);
        // Infantry's disguise animation maps FireUp and FireProne to Ready;
        // querying raw firing or stance would expose an invisible action.
        spy.isFiring = true; spy.stance = 2;
        expect(observe(f.api, 1)).toEqual(before);
        spy.stance = 0;
        expect(observe(f.api, 1)).toEqual(before);
        expect(Object.hasOwn(f.api.getUnitData(1)!, "isFiring")).toBe(false);
        expect(Object.hasOwn(f.api.getUnitData(1)!, "stance")).toBe(false);
        // True owner/shared intel retain control state without projection.
        const ownerApi = GameApi.forPlayer(f.game, true, "enemy");
        expect(ownerApi.getUnitData(1)?.isFiring).toBe(true);
        expect(ownerApi.getUnitData(1)?.stance as any).toBe(0);
        f.shared.add("viewer:enemy");
        spy.stance = 2;
        expect(f.api.getUnitData(1)?.isFiring).toBe(true);
        expect(f.api.getUnitData(1)?.stance as any).toBe(2);
    });
    test("apparent friendly color remains observable but never grants self/allied inventory", () => {
        const f = fixture(), spy = f.unit(1, "SPY");
        f.disguise(spy, { name: "E1", type: ObjectType.Infantry }, f.viewer);
        expect(f.api.getAllUnits()).toEqual([1]);
        for (const kind of ["self", "allied", "enemy", "hostile"] as const) expect(f.api.getVisibleUnits("viewer", kind)).toEqual([]);
        expect(f.api.getUnitData(1)).toMatchObject({ owner: "viewer", name: "E1" });
    });
    test("neutral and hostile relations use apparent owner rather than hidden owner", () => {
        const f = fixture(), spy = f.unit(1, "SPY"), seen: string[] = [];
        f.disguise(spy, { name: "CIV1", type: ObjectType.Infantry }, f.civilian);
        expect(f.api.getNeutralUnits(rules => { seen.push(rules.name); return true; })).toEqual([1]);
        expect(seen).toEqual(["CIV1"]); expect(f.api.getVisibleUnits("viewer", "enemy")).toEqual([]);
        expect(f.api.getVisibleUnits("viewer", "hostile")).toEqual([1]); expect(f.api.getUnitData(1)?.owner).toBe("civilian");
    });
    test("missing apparent owner stays unknown instead of falling back to real enemy", () => {
        const f = fixture(), spy = f.unit(1, "SPY");
        f.disguise(spy, { name: "E1", type: ObjectType.Infantry }, undefined);
        expect(f.api.getAllUnits()).toEqual([1]); expect(f.api.getVisibleUnits("viewer", "enemy")).toEqual([]);
        expect(f.api.getUnitData(1)?.owner).toBeUndefined();
    });
    test("two immutable observers alternate without changing permissions", () => {
        const f = fixture(), spy = f.unit(1, "SPY");
        f.disguise(spy, { name: "E1", type: ObjectType.Infantry }, f.viewer);
        const ownerApi = GameApi.forPlayer(f.game, true, "enemy");
        for (let i = 0; i < 3; ++i) {
            expect(f.api.getUnitData(1)?.name).toBe("E1"); expect(ownerApi.getUnitData(1)?.name).toBe("SPY");
            expect(ownerApi.getUnitData(1)?.hitPoints).toBe(50); expect(f.api.getUnitData(1)?.hitPoints).toBeUndefined();
        }
        expect(() => f.api.getVisibleUnits("enemy", "self")).toThrow("cannot query");
    });
    test("only actual shared detection reveals identity; local dog capability does not", () => {
        const f = fixture(), spy = f.unit(1, "SPY");
        f.disguise(spy, { name: "E1", type: ObjectType.Infantry }, f.viewer);
        f.unit(2, "DOG", f.viewer).rules.detectDisguise = true;
        expect(f.api.getUnitData(1)?.name).toBe("E1"); f.viewer.sharedDetectDisguiseTrait.add(spy);
        expect(f.api.getVisibleUnits("viewer", "enemy")).toEqual([1]); expect(f.api.getUnitData(1)?.name).toBe("SPY");
        expect(f.api.getUnitData(1)?.hitPoints).toBeUndefined();
        f.viewer.sharedDetectDisguiseTrait.delete(spy); expect(f.api.getUnitData(1)?.name).toBe("E1");
    });
    test("shroud, cloak and missing shroud deny before appearance or filter getters", () => {
        const f = fixture(), spy = f.unit(1, "SPY"); let calls = 0, cloaked = false;
        spy.disguiseTrait = { getDisguise: () => { ++calls; return { rules: { name: "E1", type: ObjectType.Infantry }, owner: f.third }; } };
        spy.cloakableTrait = { isCloaked: () => cloaked }; f.hidden.get(f.viewer)!.add(1);
        const hidden = observe(f.api, 1);
        expect(hidden.all).toEqual([]); expect(hidden.unit).toBeUndefined(); expect(calls).toBe(0);
        f.hidden.get(f.viewer)!.clear(); cloaked = true; expect(observe(f.api, 1)).toEqual(hidden); expect(calls).toBe(0);
        cloaked = false; f.missingShroud(true); expect(observe(f.api, 1)).toEqual(hidden); expect(calls).toBe(0);
        f.missingShroud(false); expect(f.api.getUnitData(1)?.name).toBe("E1"); expect(calls).toBe(1);
    });
    test("tree appearance and real terrain have identical generic data and lookup semantics", () => {
        const f = fixture(), tree = f.unit(1, "TREE01", null, ObjectType.Terrain), rules = tree.rules;
        const before = observe(f.api, 1);
        expect(before.terrain).toEqual([1]); expect(before.all).toEqual([]); expect(before.unit).toBeUndefined();
        expect(before.filtered).toEqual([]); expect(Object.hasOwn(before.generic!, "healthLevel")).toBe(false);
        expect(Object.hasOwn(before.generic!, "maxHitPoints")).toBe(false);
        f.objects.length = 0;
        const mirage = f.unit(1, "MGTK", f.enemy, ObjectType.Vehicle); f.disguise(mirage, rules, undefined);
        poisonPrivateFields(mirage);
        Object.defineProperty(mirage, "getFoundation", { get: () => { throw new Error("true art inspected"); } });
        expect(observe(f.api, 1)).toEqual(before);
    });
    test("same-tick mirage reveal and re-disguise refresh every list without stale cache", () => {
        const f = fixture(), mirage = f.unit(1, "MGTK", f.enemy, ObjectType.Vehicle);
        const active = f.disguise(mirage, { name: "TREE01", type: ObjectType.Terrain }, undefined);
        const ownerApi = GameApi.forPlayer(f.game, true, "enemy");
        expect(f.api.getAllTerrainObjects()).toEqual([1]); expect(f.api.getAllUnits()).toEqual([]);
        expect(ownerApi.getAllTerrainObjects()).toEqual([]); expect(ownerApi.getAllUnits()).toEqual([1]);
        expect(ownerApi.getUnitData(1)?.name).toBe("MGTK"); active(false);
        expect(f.api.getAllTerrainObjects()).toEqual([]); expect(f.api.getAllUnits()).toEqual([1]);
        expect(f.api.getUnitsInArea({})).toEqual([1]); expect(f.api.getUnitData(1)?.name).toBe("MGTK"); active(true);
        expect(f.api.getUnitData(1)).toBeUndefined(); expect(f.api.getUnitsInArea({})).toEqual([]);
        f.viewer.sharedDetectDisguiseTrait.add(mirage);
        expect(f.api.getAllTerrainObjects()).toEqual([]); expect(f.api.getUnitData(1)?.name).toBe("MGTK");
        f.viewer.sharedDetectDisguiseTrait.delete(mirage);
        expect(f.api.getAllTerrainObjects()).toEqual([1]); expect(f.api.getUnitData(1)).toBeUndefined();
    });
    test("terrain visibility gates list and direct data including missing shroud", () => {
        const f = fixture(), tree = f.unit(1, "TREE01", null, ObjectType.Terrain); f.hidden.get(f.viewer)!.add(1);
        expect(f.api.getAllTerrainObjects()).toEqual([]); expect(f.api.getGameObjectData(tree.id)).toBeUndefined();
        f.hidden.get(f.viewer)!.clear(); expect(f.api.getAllTerrainObjects()).toEqual([1]);
        f.missingShroud(true); expect(f.api.getAllTerrainObjects()).toEqual([]);
    });
    test("own/shared retain actual weapons, repair, transport, ore and control state", () => {
        const f = fixture(), weapon = { type: "Gun", rules: {}, projectileRules: {}, warhead: { rules: {} }, minRange: 0, range: 5, speed: 30, getCooldownTicks: () => 7 };
        const transport = f.unit(1, "HTK", f.viewer, ObjectType.Vehicle);
        Object.assign(transport, { primaryWeapon: weapon, transportTrait: { getOccupiedCapacity: () => 3, getMaxCapacity: () => 5 }, harvesterTrait: { ore: 9, gems: 4 } });
        f.disguise(transport, { name: "TREE01", type: ObjectType.Terrain }, undefined);
        const building = f.unit(2, "GAWEAP", f.friend, ObjectType.Building);
        Object.assign(building, { autoRepairTrait: { isDisabled: () => false }, factoryTrait: { deliveringUnit: transport, status: "busy" }, rallyTrait: { getRallyPoint: () => ({ rx: 3, ry: 5 }) } });
        f.hidden.get(f.viewer)!.add(1); f.hidden.get(f.viewer)!.add(2);
        expect(f.api.getUnitData(1)).toMatchObject({ name: "HTK", owner: "viewer", hitPoints: 50, maxHitPoints: 100, sight: 5,
            guardMode: true, purchaseValue: 200, primaryWeapon: { cooldownTicks: 7 }, passengerSlotCount: 3, passengerSlotMax: 5,
            harvestedOre: 9, harvestedGems: 4, isIdle: true, canMove: true, isWarpedOut: false });
        expect(f.api.getUnitData(2)).toMatchObject({ name: "GAWEAP", hasWrenchRepair: true, factory: { deliveringUnit: 1, status: "busy" }, rallyPoint: { rx: 3, ry: 5 } });
        expect(f.api.getVisibleUnits("viewer", "allied")).toEqual([1, 2]);
        expect(GameApi.forDiagnostics(f.game, true).getUnitData(1)?.name).toBe("HTK");
    });
    test("public veteran, wrench and health level remain while enemy internals stay unknown", () => {
        const f = fixture(), soldier = f.unit(1); soldier.veteranLevel = 2;
        const building = f.unit(2, "GAWEAP", f.enemy, ObjectType.Building);
        building.autoRepairTrait.isDisabled = () => false; building.buildStatus = "ready";
        poisonPrivateFields(soldier); poisonPrivateFields(building);
        expect(f.api.getUnitData(1)).toMatchObject({ veteranLevel: 2, healthLevel: 1 });
        expect(f.api.getUnitData(2)).toMatchObject({ hasWrenchRepair: true, buildStatus: "ready", healthLevel: 1 });
        for (const key of absentFields) expect(Object.hasOwn(f.api.getUnitData(2)!, key)).toBe(false);
        delete soldier.healthTrait.level; expect(f.api.getUnitData(1)?.healthLevel).toBeUndefined();
    });
});

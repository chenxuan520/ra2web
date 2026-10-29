import { describe, expect, test } from "bun:test";
import { GameApi } from "../../game/api/GameApi";
import { BotManager } from "../../game/BotManager";
import { ActionQueue } from "../../game/action/ActionQueue";
import { EventType } from "../../game/event/EventType";

// Exercises the real API and BotManager with a minimal world double. Actual
// cloak/sensor/shroud simulation is covered separately by the engine fixture.
function fixture() {
    const objects: any[] = [];
    const players = ["alpha", "bravo", "ally", "civilian"].map(name => ({
        name, isAi: name === "alpha" || name === "bravo", isObserver: false,
        country: { name: "Americans" }, production: {},
        isCombatant: () => name !== "civilian",
        getOwnedObjects: () => objects.filter(obj => obj.owner.name === name),
    }));
    const [alpha, bravo, ally, civilian] = players;
    const hidden = new Map(players.map(player => [player.name, new Set<string>()]));
    const alliance = new Set(["alpha:ally", "ally:alpha"]);
    let callback: ((event: any) => void) | undefined;
    const game: any = {
        currentTick: 0, rules: {},
        getPlayerByName: (name: string) => players.find(player => player.name === name),
        getCivilianPlayer: () => civilian,
        getCombatants: () => players.filter(player => player.isCombatant()),
        getObjectById: (id: number) => objects.find(obj => obj.id === id),
        getWorld: () => ({ getAllObjects: () => objects, hasObjectId: (id: number) => objects.some(obj => obj.id === id) }),
        alliances: {
            areAllied: (a: any, b: any) => alliance.has(`${a.name}:${b.name}`),
            haveSharedIntel: (a: any, b: any) => a === b || alliance.has(`${a.name}:${b.name}`),
        },
        map: {
            tileOccupation: { calculateTilesForGameObject: (_tile: any, obj: any) => obj.footprint ?? [obj.tile] },
            technosByTile: { queryRange: (_area: any) => objects.filter(obj => obj.isTechno()) },
        },
        mapShroudTrait: { getPlayerShroud: (player: any) => ({
            isShrouded: (tile: any, elevation: number) => hidden.get(player.name)!.has(`${tile.rx}:${tile.ry}:${elevation}`),
        }) },
        events: { subscribe: (handler: (event: any) => void) => {
            callback = handler;
            return () => { callback = undefined; };
        } },
    };
    function unit(id: number, owner = bravo, overrides: any = {}) {
        const obj: any = {
            id, owner, name: `UNIT${id}`, rules: { name: `UNIT${id}` },
            tile: { rx: id, ry: 2 }, tileElevation: 0, isDestroyed: false,
            position: { worldPosition: { clone: () => ({ x: id, y: 0, z: 2 }) } },
            getFoundation: () => ({ width: 1, height: 1 }),
            healthTrait: { getHitPoints: () => 100, maxHitPoints: 100, level: 0 },
            isTechno: () => true, isVehicle: () => true, isInfantry: () => false,
            isUnit: () => true, isBuilding: () => false, isAircraft: () => false,
            unitOrderTrait: { hasTasks: () => false },
            moveTrait: { isDisabled: () => false, velocity: { clone: () => ({ x: 0, y: 0, z: 0 }) } },
            warpedOutTrait: { isActive: () => false },
            ...overrides,
        };
        objects.push(obj);
        return obj;
    }
    function hide(player: typeof alpha, obj: any) {
        hidden.get(player.name)!.add(`${obj.tile.rx}:${obj.tile.ry}:${obj.tileElevation}`);
    }
    return { game, players, alpha, bravo, ally, civilian, objects, hidden, unit, hide,
        emit: (event: any) => callback?.(event), hasEventSubscriber: () => !!callback };
}

describe("observer-bound GameApi", () => {
    test("checks actual cloak state before exposing IDs, data or filter inputs", () => {
        const f = fixture();
        let cloaked = false;
        const target = f.unit(1, f.bravo, { cloakableTrait: { isCloaked: () => cloaked } });
        const api = GameApi.forPlayer(f.game, true, "alpha");
        const filtered: string[] = [];
        const filter = (rules: any) => { filtered.push(rules.name); return true; };
        expect(api.getVisibleUnits("alpha", "enemy")).toEqual([1]);
        expect(api.getUnitData(1)?.id).toBe(1);
        cloaked = true;
        expect(api.getVisibleUnits("alpha", "enemy", filter)).toEqual([]);
        expect(api.getVisibleUnits("alpha", "hostile", filter)).toEqual([]);
        expect(api.getGameObjectData(target.id)).toBeUndefined();
        expect(api.getUnitData(target.id)).toBeUndefined();
        expect(filtered).toEqual([]);
        cloaked = false;
        expect(api.getVisibleUnits("alpha", "enemy", filter)).toEqual([1]);
        expect(api.getUnitData(1)?.name).toBe("UNIT1");
        expect(filtered).toEqual(["UNIT1"]);
        cloaked = true;
        expect(api.getUnitData(1)).toBeUndefined();
    });

    test("known IDs lose live access when shrouded; hidden mutations do not become observations", () => {
        const f = fixture(), target = f.unit(1);
        const api = GameApi.forPlayer(f.game, true, "alpha");
        expect(api.getGameObjectData(1)?.tile).toEqual({ rx: 1, ry: 2 });
        f.hide(f.alpha, target);
        const hiddenObservation = () => ({ ids: api.getVisibleUnits("alpha", "enemy"),
            object: api.getGameObjectData(1), unit: api.getUnitData(1) });
        const before = hiddenObservation();
        target.tile = { rx: 99, ry: 41 };
        target.healthTrait.getHitPoints = () => 7;
        target.healthTrait.level = 2;
        target.primaryWeapon = { get rules() { throw new Error("hidden weapon inspected"); } };
        f.hide(f.alpha, target);
        expect(hiddenObservation()).toEqual(before);
        expect(before).toEqual({ ids: [], object: undefined, unit: undefined });
        // No fabricated lastSeen record: reacquisition reads current engine state.
        target.primaryWeapon = undefined;
        f.hidden.get("alpha")!.clear();
        expect(api.getUnitData(1)?.tile).toEqual({ rx: 99, ry: 41 });
        expect(api.getUnitData(1)?.hitPoints).toBeUndefined();
        expect(api.getUnitData(1)?.healthLevel).toBe(2);
    });

    test("retains own and shared-intel data under shroud and cloak", () => {
        const f = fixture();
        for (const [id, owner] of [[1, f.alpha], [2, f.ally]] as const) {
            const obj = f.unit(id, owner, { cloakableTrait: { isCloaked: () => true } });
            f.hide(f.alpha, obj);
        }
        const api = GameApi.forPlayer(f.game, true, "alpha");
        expect(api.getVisibleUnits("alpha", "self")).toEqual([1]);
        expect(api.getVisibleUnits("alpha", "allied")).toEqual([1, 2]);
        expect(api.getUnitData(1)?.owner).toBe("alpha");
        expect(api.getUnitData(2)?.owner).toBe("ally");
        expect(api.getVisibleUnits("alpha", "enemy")).toEqual([]);
    });

    test("uses the whole footprint at its actual elevation", () => {
        const f = fixture();
        const target = f.unit(1, f.bravo, { tileElevation: 2, footprint: [{ rx: 1, ry: 2 }, { rx: 2, ry: 2 }] });
        f.hide(f.alpha, target);
        const api = GameApi.forPlayer(f.game, true, "alpha");
        expect(api.getVisibleUnits("alpha", "enemy")).toEqual([1]);
        f.hidden.get("alpha")!.add("2:2:2");
        expect(api.getVisibleUnits("alpha", "enemy")).toEqual([]);
        f.hidden.get("alpha")!.delete("2:2:2");
        f.hidden.get("alpha")!.add("2:2:0");
        expect(api.getVisibleUnits("alpha", "enemy")).toEqual([1]);
    });

    test("closes unit list and area query bypasses before rules callbacks", () => {
        const f = fixture();
        const hiddenEnemy = f.unit(1), hiddenNeutral = f.unit(2, f.civilian);
        f.hide(f.alpha, hiddenEnemy); f.hide(f.alpha, hiddenNeutral);
        f.unit(3); f.unit(4, f.civilian);
        for (const obj of [hiddenEnemy, hiddenNeutral]) {
            Object.defineProperty(obj, "rules", { get: () => { throw new Error("hidden rules inspected"); } });
        }
        const api = GameApi.forPlayer(f.game, true, "alpha");
        const seen: string[] = [];
        const filter = (rules: any) => { seen.push(rules.name); return true; };
        expect(api.getAllUnits(filter)).toEqual([3, 4]);
        expect(api.getNeutralUnits(filter)).toEqual([4]);
        expect(api.getVisibleUnits("alpha", "enemy", filter)).toEqual([3]);
        expect(api.getVisibleUnits("alpha", "hostile", filter)).toEqual([3, 4]);
        expect(api.getUnitsInArea({})).toEqual([3, 4]);
        expect(seen).toEqual(["UNIT3", "UNIT4", "UNIT4", "UNIT3", "UNIT3", "UNIT4"]);
    });

    test("missing shroud denies hostile live reads but retains own and shared intel", () => {
        const f = fixture();
        const enemy = f.unit(1), neutral = f.unit(2, f.civilian);
        f.unit(3, f.alpha, { cloakableTrait: { isCloaked: () => true } });
        f.unit(4, f.ally, { cloakableTrait: { isCloaked: () => true } });
        const api = GameApi.forPlayer(f.game, true, "alpha");
        expect(api.getVisibleUnits("alpha", "hostile")).toEqual([1, 2]);
        expect(api.getUnitData(1)?.id).toBe(1);
        expect(api.getGameObjectData(2)?.id).toBe(2);
        // Mirrors MapShroudTrait removing a defeated non-observer's shroud.
        f.game.mapShroudTrait.getPlayerShroud = () => undefined;
        for (const obj of [enemy, neutral]) {
            Object.defineProperty(obj, "rules", { get: () => { throw new Error("unobservable rules inspected"); } });
        }
        const seen: string[] = [];
        const filter = (rules: any) => { seen.push(rules.name); return true; };
        expect(api.getVisibleUnits("alpha", "enemy", filter)).toEqual([]);
        expect(api.getVisibleUnits("alpha", "hostile", filter)).toEqual([]);
        expect(api.getNeutralUnits(filter)).toEqual([]);
        expect(seen).toEqual([]);
        expect(api.getAllUnits(filter)).toEqual([3, 4]);
        expect(seen).toEqual(["UNIT3", "UNIT4"]);
        expect(api.getUnitsInArea({})).toEqual([3, 4]);
        for (const id of [1, 2]) {
            expect(api.getGameObjectData(id)).toBeUndefined();
            expect(api.getUnitData(id)).toBeUndefined();
        }
        expect(api.getVisibleUnits("alpha", "self")).toEqual([3]);
        expect(api.getVisibleUnits("alpha", "allied")).toEqual([3, 4]);
        expect(api.getUnitData(3)?.owner).toBe("alpha");
        expect(api.getUnitData(4)?.owner).toBe("ally");
    });

    test("alternating bots keep independent views, and cannot request the other player's view", () => {
        const f = fixture();
        const target = f.unit(1, f.civilian);
        f.hide(f.alpha, target);
        const alpha = GameApi.forPlayer(f.game, true, "alpha"), bravo = GameApi.forPlayer(f.game, true, "bravo");
        for (let i = 0; i < 3; ++i) {
            expect(bravo.getVisibleUnits("bravo", "hostile")).toEqual([1]);
            expect(alpha.getUnitData(1)).toBeUndefined();
            expect(alpha.getVisibleUnits("alpha", "hostile")).toEqual([]);
            expect(bravo.getUnitData(1)?.id).toBe(1);
        }
        expect(() => alpha.getVisibleUnits("bravo", "self")).toThrow("cannot query");
        expect(() => alpha.getVisibleUnits("bravo", "enemy")).toThrow("cannot query");
        expect(() => GameApi.forPlayer(f.game, true, "missing")).toThrow("doesn't exist");
    });

    test("the explicit diagnostic factory retains omniscient live reads", () => {
        const f = fixture();
        const target = f.unit(1, f.bravo, { cloakableTrait: { isCloaked: () => true } });
        f.hide(f.alpha, target);
        const diagnostics = GameApi.forDiagnostics(f.game, true);
        expect(diagnostics.getUnitData(1)?.id).toBe(1);
        expect(diagnostics.getAllUnits()).toEqual([1]);
        expect(diagnostics.getUnitsInArea({})).toEqual([1]);
        // A diagnostic observer query still answers what that player can see.
        expect(diagnostics.getVisibleUnits("alpha", "enemy")).toEqual([]);
        expect(diagnostics.getVisibleUnits("bravo", "self")).toEqual([1]);
    });

    test("does not return destroyed or nonexistent unit data to bots", () => {
        const f = fixture();
        f.unit(1, f.alpha, { isDestroyed: true }); f.unit(2, f.bravo, { isDestroyed: true });
        const api = GameApi.forPlayer(f.game, true, "alpha");
        expect(api.getVisibleUnits("alpha", "self")).toEqual([]);
        expect(api.getVisibleUnits("alpha", "enemy")).toEqual([]);
        expect(api.getAllUnits()).toEqual([]);
        expect(api.getUnitData(1)).toBeUndefined();
        expect(api.getUnitData(2)).toBeUndefined();
        expect(api.getUnitData(999)).toBeUndefined();
    });
});

test("BotManager supplies one stable per-bot view through setters, start, events, ticks and logger", () => {
    const f = fixture(), target = f.unit(1, f.civilian);
    f.hide(f.alpha, target);
    const bots = new Map<string, any>();
    const create = (player: any) => {
        const bot: any = {
            name: player.name, calls: [] as { phase: string; api: GameApi }[],
            setDebugMode() {}, setActionsApi() {}, setProductionApi() {},
            setGameApi(api: GameApi) { this.gameApi = api; this.calls.push({ phase: "set", api }); },
            setLogger(logger: any) { this.loggerApi = logger; },
            onGameStart(api: GameApi) { this.calls.push({ phase: "start", api }); },
            onGameTick(api: GameApi) { this.calls.push({ phase: "tick", api }); },
            onGameEvent(_event: any, api: GameApi) { this.calls.push({ phase: "event", api }); },
        };
        bots.set(player.name, bot); return bot;
    };
    const manager = new BotManager({}, new ActionQueue(), { create },
        { value: 0, onChange: { subscribe() {}, unsubscribe() {} } }, undefined);
    manager.init(f.game);
    f.emit({ type: EventType.ObjectSpawn, gameObject: target });
    manager.update(f.game);
    for (const [name, bot] of bots) {
        expect(bot.calls.map((call: any) => call.phase)).toEqual(["set", "start", "event", "tick"]);
        for (const call of bot.calls) {
            expect(call.api).toBe(bot.gameApi);
            expect(call.api.getUnitData(1)?.id).toBe(name === "alpha" ? undefined : 1);
        }
        expect(bot.loggerApi.gameTime).toBe(bot.gameApi);
    }
    expect(bots.get("alpha").gameApi).not.toBe(bots.get("bravo").gameApi);
    manager.dispose();
    expect(f.hasEventSubscriber()).toBe(false);
    manager.update(f.game);
    expect(bots.get("alpha").calls).toHaveLength(4);
});

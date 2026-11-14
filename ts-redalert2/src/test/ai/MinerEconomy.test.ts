import { describe, expect, mock, test } from "bun:test";
import { ObjectType, OrderType, SpeedType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { MinerDefence } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/minerDefence";
import { HarvesterStatus, HarvesterTrait } from "../../game/gameobject/trait/HarvesterTrait";
import { ReturnOreTask } from "../../game/gameobject/task/harvester/ReturnOreTask";
import { TiberiumType } from "../../engine/type/TiberiumType";

function fixture() {
    let tick = 60;
    const miner: any = {
        id: 7, name: "HARV", owner: "bot", type: ObjectType.Vehicle, tile: { rx: 0, ry: 0, z: 0 },
        rules: { name: "HARV", harvester: true, crusher: true, speedType: SpeedType.Track },
        hitPoints: 1000, maxHitPoints: 1000, canMove: true, isWarpedOut: false, isIdle: true,
        zone: ZoneType.Ground, onBridge: false,
    };
    const refineries: any[] = [{ id: 10, owner: "bot", tile: { rx: 0, ry: -12, z: 0 }, rules: { refinery: true } }];
    const enemies: any[] = [];
    const resources: any[] = [{ tile: { rx: 4, ry: 0, z: 0 }, ore: 0, gems: 200 }];
    const hidden = new Set<string>();
    const blocked = new Set<string>();
    const key = (tile: any) => `${tile.rx},${tile.ry}`;
    const actions = { orderUnits: mock((..._args: any[]) => {}) };
    const game: any = {
        getCurrentTick: () => tick,
        getPlayerData: () => ({ name: "bot", startLocation: new Vector2() }),
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "enemy" ? enemies : [miner, ...refineries]).filter(unit => predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => [miner, ...refineries, ...enemies].find(unit => unit.id === id),
        mapApi: {
            getAllTilesResourceData: () => resources,
            getResourceCreditValues: () => ({ ore: 25, gems: 50 }),
            isVisibleTile: (tile: any) => !hidden.has(key(tile)),
            getTileResourceData: (tile: any) => resources.find(resource => key(resource.tile) === key(tile)) ?? { ore: 0, gems: 0 },
            getTile: (rx: number, ry: number) => ({ rx, ry, z: 0 }),
            findPath: (_speed: number, start: any, end: any) => blocked.has(key(end.tile)) ? [] : [end, start],
        },
    };
    const context: any = { game, player: { name: "bot", actions }, difficulty: "brutal" };
    const controller = new MinerDefence();
    return { miner, refineries, enemies, resources, hidden, blocked, game, context, actions,
        run: () => controller.onAiUpdate(context), at(value: number) { tick = value; } };
}

function hostile(id: number, rx: number, ry = 0) {
    return {
        id, owner: "enemy", name: "HTNK", type: ObjectType.Vehicle, tile: { rx, ry, z: 0 },
        rules: { name: "HTNK", isSelectableCombatant: true, primary: "120mm" },
        primaryWeapon: { rules: { damage: 90 }, maxRange: 6 },
    };
}

describe("full cargo returns before miner defence", () => {
    function rushingMiner(ore: number, gems: number, capacity = 40) {
        const f = fixture(), harvester = new HarvesterTrait(capacity);
        Object.assign(harvester, { ore, gems });
        f.miner.rules.storage = capacity; f.miner.isIdle = false; f.resources.length = 0;
        f.game.mapApi.hasBridgeOnTile = () => false; f.game.mapApi.isPassableTile = () => true;
        Object.defineProperties(f.miner, {
            harvestedOre: { configurable: true, enumerable: true, get: () => harvester.debugGetState().ore },
            harvestedGems: { configurable: true, enumerable: true, get: () => harvester.debugGetState().gems },
        });
        for (let i = 0; i < 6; i++) f.enemies.push({ id: 20 + i, owner: "enemy", name: "E2", type: ObjectType.Infantry,
            tile: { rx: 8, ry: 0, z: 0 }, rules: { name: "E2", isSelectableCombatant: true, crushable: true, strength: 100 } });
        return { ...f, harvester };
    }
    test.each([[40, 0], [0, 40], [10, 30]])("a busy return with ore%i/gems%i is not reassigned to crushing at full native capacity", (ore, gems) => {
        const f = rushingMiner(ore, gems); expect(f.harvester.isFull()).toBe(true);
        f.run(); f.at(90); f.run();
        expect(f.actions.orderUnits).not.toHaveBeenCalled();
        expect(f.harvester.debugGetState()).toEqual({ ore, gems });
    });
    test("the preserved native return credits the full gem cargo, then its now-empty miner may defend", () => {
        const f = rushingMiner(0, 40), owner = { name: "bot", credits: 0, buildings: [] };
        const world: any = { map: { tileOccupation: {} }, areFriendly: () => true,
            rules: { ai: { tiberiumNearScan: 1, tiberiumFarScan: 1 }, general: { purifierBonus: 0 },
                getTiberium: (type: TiberiumType) => ({ value: type === TiberiumType.Gems ? 50 : 25 }) } };
        const returnTask = new ReturnOreTask(world), tasks: any[] = [returnTask];
        const native: any = { id: f.miner.id, owner, harvesterTrait: f.harvester,
            unitOrderTrait: { getTasks: () => tasks, addTask: (task: any) => tasks.push(task) } };
        (returnTask as any).target = { id: 10, owner, isSpawned: true, warpedOutTrait: { isActive: () => false } };
        f.actions.orderUnits.mockImplementation((ids, order) => { if (ids.includes(7) && order === OrderType.Move) tasks.length = 0; });
        f.run(); expect(tasks).toEqual([returnTask]); expect(owner.credits).toBe(0);
        // Arrival/unloading is a native task contract fixture, not a new league delivery.
        Object.assign(f.harvester, { status: HarvesterStatus.Unloading });
        expect(returnTask.onTick(native)).toBe(true);
        expect(owner.credits).toBe(2000); expect(f.harvester.isEmpty()).toBe(true);
        f.at(96); f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledWith([7], OrderType.Move, 10, 0);
    });
    test("a different empty miner can defend without borrowing the loaded return", () => {
        const f = rushingMiner(0, 40), empty = { ...f.miner, id: 8, harvestedOre: 0, harvestedGems: 0 };
        const visible = f.game.getVisibleUnits, data = f.game.getUnitData;
        f.game.getVisibleUnits = (name: string, relation: string, predicate = (_: any) => true) =>
            [...visible(name, relation, predicate), ...(relation === "self" && predicate(empty.rules) ? [empty.id] : [])];
        f.game.getUnitData = (id: number) => id === empty.id ? empty : data(id);
        f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledWith([8], OrderType.Move, 10, 0);
        expect(f.actions.orderUnits).not.toHaveBeenCalledWith([7], OrderType.Move, 10, 0);
    });
    test.each(["not-full", "larger-capacity", "idle-full", "missing-cargo", "missing-capacity"])("the original %s crushing eligibility is retained", condition => {
        const f = rushingMiner(0, condition === "not-full" ? 39 : 40, condition === "larger-capacity" ? 80 : 40);
        if (condition === "idle-full") f.miner.isIdle = true;
        if (condition === "missing-cargo") delete f.miner.harvestedGems;
        if (condition === "missing-capacity") delete f.miner.rules.storage;
        f.run(); expect(f.actions.orderUnits).toHaveBeenCalledWith([7], OrderType.Move, 10, 0);
    });
    test("normal miner handling does not inspect the new full-cargo eligibility", () => {
        const f = rushingMiner(0, 40); f.context.difficulty = "normal";
        Object.defineProperty(f.miner.rules, "storage", { get() { throw Error("normal must retain its original handling"); } });
        f.run(); expect(f.actions.orderUnits).not.toHaveBeenCalled();
    });
});

describe("independent miner economy", () => {
    test("an idle healthy miner gathers visible gems without an infantry rush", () => {
        const f = fixture();
        f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledWith([7], OrderType.Gather, 4, 0);
    });

    test("gem selection uses distance rather than a miner ID modulo the entire resource field", () => {
        const f = fixture();
        f.resources.push({ tile: { rx: 25, ry: 0, z: 0 }, ore: 0, gems: 10 });
        f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledWith([7], OrderType.Gather, 4, 0);
    });

    test("an unreachable nearest gem does not prevent using a reachable visible gem", () => {
        const f = fixture();
        f.blocked.add("4,0");
        f.resources.push({ tile: { rx: 6, ry: 0, z: 0 }, ore: 0, gems: 10 });
        f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledWith([7], OrderType.Gather, 6, 0);
        f.actions.orderUnits.mockClear();
        f.blocked.add("6,0");
        f.at(150);
        f.run();
        expect(f.actions.orderUnits).not.toHaveBeenCalled();
    });

    test("hidden or hostile-covered gems are never chosen", () => {
        const f = fixture();
        f.hidden.add("4,0");
        f.run();
        expect(f.actions.orderUnits).not.toHaveBeenCalled();
        f.hidden.clear();
        f.enemies.push(hostile(20, 4));
        f.at(90);
        f.run();
        expect(f.actions.orderUnits).not.toHaveBeenCalled();
    });

    test("visibility is checked before reading hidden gem amounts", () => {
        const f = fixture();
        f.hidden.add("4,0");
        Object.defineProperty(f.resources[0], "gems", { get() { throw new Error("Hidden resource read"); } });
        expect(() => f.run()).not.toThrow();
        expect(f.actions.orderUnits).not.toHaveBeenCalled();
    });

    test("gather orders preserve busy, injured and already gem-mining harvesters", () => {
        for (const update of [{ isIdle: false }, { hitPoints: 600 }, { tile: { rx: 4, ry: 0, z: 0 } }]) {
            const f = fixture();
            Object.assign(f.miner, update);
            f.run();
            expect(f.actions.orderUnits).not.toHaveBeenCalled();
        }
    });

    test("rich-field gem orders are bounded to one per miner per 300 ticks", () => {
        const f = fixture(); f.resources[0].gems = 300;
        f.run();
        f.at(90); f.run();
        f.at(120); f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        f.at(360); f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledTimes(2);
    });

    test("a threatened injured miner retreats without requiring six approaching infantry", () => {
        const f = fixture();
        f.miner.hitPoints = 400;
        f.enemies.push(hostile(20, 3));
        f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledWith([7], OrderType.Dock, 10);
    });

    test("a busy safety return keeps its first Dock instead of replacing the same native return every thirty ticks", () => {
        const f = fixture(); f.miner.hitPoints = 400; f.miner.isIdle = false; f.enemies.push(hostile(20, 3));
        f.run(); f.at(90); f.run(); f.at(120); f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        expect(f.actions.orderUnits).toHaveBeenCalledWith([7], OrderType.Dock, 10);
    });
    test("an actually idle failed safety return may retry without changing the existing cadence", () => {
        const f = fixture(); f.miner.hitPoints = 400; f.miner.isIdle = false; f.enemies.push(hostile(20, 3));
        f.run(); f.at(90); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        f.miner.isIdle = true; f.at(120); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(2);
    });
    test("a newly unsafe destination permits a busy miner to select the current other safe refinery", () => {
        const f = fixture(); f.miner.hitPoints = 400; f.miner.isIdle = false; f.enemies.push(hostile(20, 3)); f.run();
        f.refineries.push({ id: 11, owner: "bot", tile: { rx: 0, ry: -30 }, rules: { refinery: true } });
        f.enemies.push(hostile(21, 0, -11)); f.at(90); f.run();
        expect(f.actions.orderUnits).toHaveBeenLastCalledWith([7], OrderType.Dock, 11);
    });
    test("actual renewed cargo collection ends a safety-return episode so another attack can retreat again", () => {
        const f = fixture(); Object.assign(f.miner, { hitPoints: 400, isIdle: false, harvestedOre: 0, harvestedGems: 0 });
        f.enemies.push(hostile(20, 3)); f.run(); f.at(90); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        f.miner.harvestedOre = 1; f.at(120); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(2);
    });
    test("a temporarily ineligible own miner does not retain a stale safety-return suppression", () => {
        const f = fixture(); f.miner.hitPoints = 400; f.miner.isIdle = false; f.enemies.push(hostile(20, 3)); f.run();
        f.miner.isWarpedOut = true; f.at(90); f.run();
        f.miner.isWarpedOut = false; f.at(120); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(2);
    });
    test("the retreat refinery is the closest safe one to the miner, not the spawn point", () => {
        const f = fixture();
        f.miner.tile.rx = 15;
        f.miner.hitPoints = 400;
        f.refineries[0].tile.rx = -10;
        f.refineries.push({ id: 11, owner: "bot", tile: { rx: 20, ry: 10, z: 0 }, rules: { refinery: true } });
        f.enemies.push(hostile(20, 16));
        f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledWith([7], OrderType.Dock, 11);
    });

    test("a refinery covered by visible hostiles is not a retreat destination", () => {
        const f = fixture();
        f.miner.hitPoints = 400;
        f.refineries[0].tile.ry = 2;
        f.enemies.push(hostile(20, 3));
        f.run();
        expect(f.actions.orderUnits).not.toHaveBeenCalled();
    });

    test("a healthy miner and the normal profile retain their existing behavior", () => {
        const healthy = fixture();
        healthy.resources.length = 0;
        healthy.enemies.push(hostile(20, 3));
        healthy.run();
        expect(healthy.actions.orderUnits).not.toHaveBeenCalled();
        const normal = fixture();
        normal.context.difficulty = "normal";
        normal.run();
        expect(normal.actions.orderUnits).not.toHaveBeenCalled();
    });
});

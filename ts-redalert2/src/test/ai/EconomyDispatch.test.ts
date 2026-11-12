import { describe, expect, mock, test } from "bun:test";
import { ObjectType, OrderType, SpeedType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { MinerDefence } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/minerDefence";

function fixture() {
    let tick = 30, nextId = 1;
    const miners: any[] = [], refineries: any[] = [], enemies: any[] = [];
    const resources: any[] = [{ tile: { rx: -8, ry: 0 }, ore: 8000, gems: 0 }, { tile: { rx: 20, ry: 0 }, ore: 0, gems: 4000 }];
    const hidden = new Set<string>(), blocked = new Set<string>();
    const key = (tile: any) => `${tile.rx}_${tile.ry}`;
    function miner(rx = 4, idle = false) {
        const unit = { id: nextId++, name: "HARV", owner: "bot", type: ObjectType.Vehicle, tile: { rx, ry: 0 }, isIdle: idle,
            canMove: true, isWarpedOut: false, hitPoints: 1000, maxHitPoints: 1000, harvestedOre: 0, harvestedGems: 0,
            rules: { name: "HARV", type: ObjectType.Vehicle, harvester: true, crusher: true, speedType: SpeedType.Track } };
        miners.push(unit); return unit;
    }
    function refinery(rx = 0) {
        const unit = { id: 100 + refineries.length, tile: { rx, ry: 0 }, owner: "bot", rules: { name: "NAREFN", refinery: true, type: ObjectType.Building } };
        refineries.push(unit); return unit;
    }
    miner(); refinery();
    const actions = { orderUnits: mock(() => {}) };
    const game: any = { getCurrentTick: () => tick, getPlayerData: () => ({ name: "bot", startLocation: new Vector2() }),
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "self" ? [...miners, ...refineries] : enemies).filter(unit => predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => [...miners, ...refineries, ...enemies].find(unit => unit.id === id),
        getGameObjectData: (id: number) => game.getUnitData(id),
        mapApi: { getAllTilesResourceData: () => resources, getResourceCreditValues: () => ({ ore: 1, gems: 2 }),
            isVisibleTile: (tile: any) => !hidden.has(key(tile)),
            getTileResourceData: (tile: any) => resources.find(resource => key(resource.tile) === key(tile)) ?? { ore: 0, gems: 0 },
            findPath: (_speed: number, _start: any, end: any) => blocked.has(key(end.tile)) ? [] : [end],
            getTile: (rx: number, ry: number) => ({ rx, ry }),
        },
    };
    const context: any = { difficulty: "brutal", game, player: { name: "bot", actions } };
    const controller = new MinerDefence();
    return { game, context, controller, miners, refineries, enemies, resources, hidden, blocked, actions, miner, refinery,
        at(value: number) { tick = value; }, run: () => controller.onAiUpdate(context) };
}

function balanceFixture() {
    const f = fixture(); f.at(150); f.miners.length = 0; f.refineries.length = 0;
    f.resources.splice(0, f.resources.length, { tile: { rx: 8, ry: 0 }, ore: 8000, gems: 0 }, { tile: { rx: 30, ry: 0 }, ore: 8000, gems: 0 });
    f.refinery(5); f.refinery(25);
    f.miner(6); for (let i = 0; i < 3; i++) f.miner(8, true); f.miner(28);
    return f;
}

describe("unload-aware gem dispatch", () => {
    test.each([[4, false, false, true], [5, false, false, false], [5, true, false, true], [4, false, true, false], [4, true, true, false]])(
        "refinery distance=%i idle=%s underfoot-resource=%s dispatch=%s", (distance, idle, ore, dispatch) => {
            const f = fixture(); f.miners[0].tile.rx = distance; f.miners[0].isIdle = idle;
            if (ore) f.resources.push({ tile: { rx: distance, ry: 0 }, ore: 1, gems: 0 });
            f.run();
            if (dispatch) expect(f.actions.orderUnits).toHaveBeenCalledWith([f.miners[0].id], OrderType.Gather, 20, 0);
            else expect(f.actions.orderUnits).not.toHaveBeenCalled();
        });
    test("a busy returning miner is not treated as unloaded while its real cargo is positive or unknown", () => {
        for (const cargo of ["ore", "gems", "unknown"]) {
            const f = fixture();
            if (cargo === "ore") f.miners[0].harvestedOre = 1;
            if (cargo === "gems") f.miners[0].harvestedGems = 1;
            if (cargo === "unknown") { delete f.miners[0].harvestedOre; delete f.miners[0].harvestedGems; }
            f.run(); expect(f.actions.orderUnits).not.toHaveBeenCalled();
        }
    });
    test("a capacity-three gem field with three miners cannot receive another", () => {
        const f = fixture(); for (let i = 0; i < 3; i++) f.miner(20, true);
        f.run(); expect(f.actions.orderUnits).not.toHaveBeenCalled();
    });
    test("three transit reservations prevent a fourth miner being dispatched before arrivals", () => {
        const f = fixture(); f.miners[0].isIdle = true; for (let i = 0; i < 3; i++) f.miner(4, true);
        f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(3);
        f.at(60); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(3);
    });
    test("each miner's gem orders retain the full 300-tick cooldown", () => {
        const f = fixture(); f.miners[0].isIdle = true;
        f.run(); f.at(300); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        f.at(330); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(2);
    });
    test("unserved gems beyond forty, hidden gems, visible combat within fourteen and unreachable tiles are excluded", () => {
        for (const reason of ["far", "hidden", "enemy", "unreachable"]) {
            const f = fixture(); f.miners[0].isIdle = true;
            if (reason === "far") f.resources[1].tile.rx = 41;
            if (reason === "hidden") { f.hidden.add("20_0"); Object.defineProperty(f.resources[1], "gems", { get() { throw new Error("hidden resource read"); } }); }
            if (reason === "enemy") f.enemies.push({ id: 999, type: ObjectType.Infantry, tile: { rx: 34, ry: 0 }, rules: { isSelectableCombatant: true } });
            if (reason === "unreachable") f.blocked.add("20_0");
            f.run(); expect(f.actions.orderUnits).not.toHaveBeenCalled();
        }
        const served = fixture(); served.resources[1].tile.rx = 41; served.refinery(35);
        served.run(); expect(served.actions.orderUnits).toHaveBeenCalledWith([served.miners[0].id], OrderType.Gather, 41, 0);
    });
    test("already gem-mining, injured and normal-profile miners remain untouched", () => {
        for (const reason of ["gems", "injured", "normal"]) {
            const f = fixture();
            if (reason === "gems") f.miners[0].tile.rx = 20;
            if (reason === "injured") f.miners[0].hitPoints = 600;
            if (reason === "normal") f.context.difficulty = "normal";
            f.run(); expect(f.actions.orderUnits).not.toHaveBeenCalled();
        }
    });
});

describe("served-field one-miner balancing", () => {
    test("four miners on capacity three versus one on capacity three moves exactly one at tick 150", () => {
        const f = balanceFixture();
        f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        expect(f.actions.orderUnits).toHaveBeenCalledWith([f.miners[0].id], OrderType.Gather, 30, 0);
    });
    test("the same eligible miner cannot be balanced again within 600 ticks", () => {
        const f = balanceFixture(), miner = f.miners[0]; f.run();
        miner.tile.rx = 28; f.at(300); f.run();
        miner.tile.rx = 6; f.at(600); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        f.at(750); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(2);
        expect(f.actions.orderUnits.mock.calls.every(call => call[0][0] === miner.id)).toBe(true);
    });
    test("no overcapacity, no deficit and no reachable route do not move a miner", () => {
        for (const reason of ["not-overfull", "not-underfull", "unreachable"]) {
            const f = balanceFixture();
            if (reason === "not-overfull") f.miners.splice(1, 1);
            if (reason === "not-underfull") { f.miner(30, true); f.miner(30, true); }
            if (reason === "unreachable") f.blocked.add("30_0");
            f.run(); expect(f.actions.orderUnits).not.toHaveBeenCalled();
        }
    });
    test("equal deficits prefer gems, independently of the separate gem-order cooldown", () => {
        const f = balanceFixture(); f.resources.push({ tile: { rx: 50, ry: 0 }, ore: 0, gems: 4000 });
        f.refinery(45); f.miner(48);
        for (const m of f.miners) (f.controller as any).lastGemOrder.set(m.id, 150);
        f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        expect(f.actions.orderUnits).toHaveBeenCalledWith([f.miners[0].id], OrderType.Gather, 50, 0);
        expect((f.controller as any).lastBalanceOrder.get(f.miners[0].id)).toBe(150);
    });
});

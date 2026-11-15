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
    const actions = { orderUnits: mock((_ids: number[], _order: OrderType, _xOrTarget?: number, _y?: number) => {}) };
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
    f.miner(6); for (let i = 0; i < 4; i++) f.miner(8, true); f.miner(28);
    return f;
}

describe("unload-aware gem dispatch", () => {
    test.each([[4, false, false, true], [5, false, false, false], [5, true, false, true], [4, false, true, true], [4, true, true, true], [5, false, true, false]])(
        "refinery distance=%i idle=%s underfoot-resource=%s dispatch=%s", (distance, idle, ore, dispatch) => {
            const f = fixture(); f.miners[0].tile.rx = distance; f.miners[0].isIdle = idle;
            if (ore) f.resources.push({ tile: { rx: distance, ry: 0 }, ore: 1, gems: 0 });
            f.run();
            if (dispatch) expect(f.actions.orderUnits).toHaveBeenCalledWith([f.miners[0].id], OrderType.Gather, 20, 0);
            else expect(f.actions.orderUnits).not.toHaveBeenCalled();
        });
    test("a miner on gems at a nearby refinery is not interrupted by the empty-cargo exception", () => {
        const f = fixture(); f.miners[0].tile.rx = 20; f.refinery(18); f.run();
        expect(f.actions.orderUnits).not.toHaveBeenCalled();
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
    test("a serviced capacity-four gem field with four miners cannot receive another", () => {
        const f = fixture(); f.refinery(18); for (let i = 0; i < 4; i++) f.miner(20, true);
        f.run(); expect(f.actions.orderUnits).toHaveBeenCalledWith([f.miners[0].id], OrderType.Gather, -8, 0);
        expect(f.actions.orderUnits).not.toHaveBeenCalledWith([f.miners[0].id], OrderType.Gather, 20, 0);
    });
    test("four transit reservations prevent a fifth miner being dispatched before arrivals", () => {
        const f = fixture(); f.refinery(18); f.miners[0].isIdle = true; for (let i = 0; i < 4; i++) f.miner(4, true);
        f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(4);
        f.at(60); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(4);
    });
    test("an unserved gem field takes one paid scout miner, then fills normal capacity after a refinery serves it", () => {
        const f = fixture(); f.miners[0].isIdle = true; f.miner(4, true); f.miner(4, true);
        f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        f.at(60); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        f.refinery(18); f.at(90); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(3);
    });
    test("a miner already counted beside an unserved gem field reuses its own slot without admitting another", () => {
        const f = fixture(); f.miners[0].tile.rx = 19; f.miners[0].isIdle = true; f.miner(4, true);
        f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        expect(f.actions.orderUnits).toHaveBeenCalledWith([f.miners[0].id], OrderType.Gather, 20, 0);
    });
    test("a small unserved gem field gets one foray and the empty returning miner resumes safe ore until service", () => {
        const f = fixture(); f.resources[1].gems = 2000; f.miners[0].isIdle = true; f.miner(4, true);
        f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        f.at(330); f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledTimes(2);
        expect(f.actions.orderUnits.mock.calls[1]).toEqual([[f.miners[0].id], OrderType.Gather, -8, 0]);
        f.at(360); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(2);
        f.refinery(18); f.miners[0].tile.rx = -8; f.at(390); f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledWith([f.miners[1].id], OrderType.Gather, 20, 0);
    });
    test("a small-field forager with cargo is not redirected before its real unload", () => {
        const f = fixture(); f.resources[1].gems = 2000; f.miners[0].isIdle = true; f.run();
        f.miners[0].harvestedGems = 50; f.at(330); f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        f.miners[0].harvestedGems = 0; f.at(360); f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledWith([f.miners[0].id], OrderType.Gather, -8, 0);
    });
    test("a failed path does not consume the small-field foray, and distinct fields keep separate budgets", () => {
        const f = fixture(); f.resources[1].gems = 2000; f.miners[0].isIdle = true; f.blocked.add("20_0");
        f.run(); expect(f.actions.orderUnits).not.toHaveBeenCalled();
        f.blocked.clear(); f.at(60); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        const distinct = fixture(); distinct.resources[1].gems = 2000; distinct.miners[0].isIdle = true; distinct.miner(4, true);
        distinct.resources.push({ tile: { rx: 40, ry: 0 }, ore: 0, gems: 2000 });
        distinct.run();
        expect(distinct.actions.orderUnits).toHaveBeenCalledWith([distinct.miners[0].id], OrderType.Gather, 20, 0);
        expect(distinct.actions.orderUnits).toHaveBeenCalledWith([distinct.miners[1].id], OrderType.Gather, 40, 0);
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

describe("busy empty miners leave resource-less refinery neighborhoods", () => {
    function scenario(name = "CMIN") {
        const f = fixture(); f.at(9000); f.resources.splice(0, f.resources.length,
            { tile: { rx: 30, ry: 0 }, ore: 18000, gems: 0 });
        f.refinery(27); f.miners[0].tile.rx = 8;
        f.miners[0].name = f.miners[0].rules.name = name;
        return f;
    }
    test.each(["HARV", "CMIN"])("%s restores a known live haul instead of keeping an empty busy task by an unserved refinery", name => {
        const f = scenario(name); f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledWith([f.miners[0].id], OrderType.Gather, 30, 0);
        f.at(9030); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
    });
    test("six empty busy miners reserve at most five slots in the surviving large field", () => {
        const f = scenario(); for (let i = 0; i < 5; i++) { const m = f.miner(8); m.name = m.rules.name = "CMIN"; }
        f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(5);
        f.at(9030); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(5);
    });
    test.each([9, 9.01])("the existing nine-tile service distance%s bounds recovery near a resource-less depot", distance => {
        const f = scenario(); f.miners[0].tile.rx = distance; f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledTimes(distance <= 9 ? 1 : 0);
    });
    test.each(["ore", "gems", "unknown-cargo", "underfoot-ore", "underfoot-gems", "productive-depot", "idle", "unknown-idle", "injured", "normal"])(
        "%s preserves its original live collection or non-recovery flow", condition => {
            const f = scenario(), m = f.miners[0];
            if (condition === "ore") m.harvestedOre = 1;
            if (condition === "gems") m.harvestedGems = 7;
            if (condition === "unknown-cargo") delete m.harvestedGems;
            if (condition === "underfoot-ore") f.resources.push({ tile: { ...m.tile }, ore: 1, gems: 0 });
            if (condition === "underfoot-gems") f.resources.push({ tile: { ...m.tile }, ore: 0, gems: 1 });
            if (condition === "productive-depot") f.resources.push({ tile: { rx: 4, ry: 0 }, ore: 4000, gems: 0 });
            if (condition === "idle") m.isIdle = true;
            if (condition === "unknown-idle") delete m.isIdle;
            if (condition === "injured") m.hitPoints = 600;
            if (condition === "normal") f.context.difficulty = "normal";
            f.run(); expect(f.actions.orderUnits).not.toHaveBeenCalled();
        });
    test("a still-live watched gem route is not replaced even while passing an unserved refinery", () => {
        const f = fixture(); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        f.resources.splice(0, 1); f.resources.push({ tile: { rx: 60, ry: 0 }, ore: 8000, gems: 0 }); f.refinery(57);
        f.miners[0].tile.rx = 8; f.at(60); f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        expect(f.actions.orderUnits.mock.calls[0]).toEqual([[f.miners[0].id], OrderType.Gather, 20, 0]);
    });
    test.each(["hidden-current", "hidden-target", "blocked", "unsafe", "unknown-underfoot"])("%s cannot invent a valid recovery route", condition => {
        const f = scenario();
        if (condition === "hidden-current") {
            f.hidden.add("8_0"); f.game.mapApi.getTileResourceData = () => { throw Error("hidden current resource read"); };
        }
        if (condition === "hidden-target") {
            f.hidden.add("30_0"); Object.defineProperty(f.resources[0], "ore", { get() { throw Error("hidden target resource read"); } });
        }
        if (condition === "blocked") f.blocked.add("30_0");
        if (condition === "unsafe") f.enemies.push({ id: 999, type: ObjectType.Infantry, tile: { rx: 44, ry: 0 }, rules: { isSelectableCombatant: true } });
        if (condition === "unknown-underfoot") f.game.mapApi.getTileResourceData = () => ({ ore: undefined, gems: undefined });
        f.run(); expect(f.actions.orderUnits).not.toHaveBeenCalled();
    });
    test("the public API's absent resource object on a visible tile means no overlay, not unknown ore", () => {
        const f = scenario(); f.game.mapApi.getTileResourceData = () => undefined;
        f.run(); expect(f.actions.orderUnits).toHaveBeenCalledWith([f.miners[0].id], OrderType.Gather, 30, 0);
    });
    test("a full live-field allocation does not accept another empty miner", () => {
        const f = scenario(); for (let i = 0; i < 5; i++) { const m = f.miner(30); m.name = m.rules.name = "CMIN"; m.harvestedOre = 20; }
        f.run(); expect(f.actions.orderUnits).not.toHaveBeenCalled();
    });
    test("unserved known home ore uses one existing foray slot, not a whole free field budget", () => {
        const f = scenario(); f.refineries.splice(1, 1); const second = f.miner(8); second.name = second.rules.name = "CMIN";
        f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        expect(f.actions.orderUnits).toHaveBeenCalledWith([f.miners[0].id], OrderType.Gather, 30, 0);
    });
});

describe("empty refinery departures use a field with an available slot", () => {
    function scenario(gems = true) {
        const f = fixture(); f.miners[0].name = f.miners[0].rules.name = "CMIN";
        if (gems) f.refinery(18);
        else {
            f.resources.splice(0, f.resources.length, { tile: { rx: -8, ry: 0 }, ore: 18000, gems: 0 },
                { tile: { rx: 30, ry: 0 }, ore: 18000, gems: 0 }); f.refinery(27);
        }
        for (let i = 0; i < 5; i++) {
            const m = f.miner(gems ? 20 : -8); m.name = m.rules.name = "CMIN"; m.harvestedOre = 1;
        }
        return f;
    }
    test("a full gem allocation sends the empty departing miner to served ore, not the default crowded field", () => {
        const f = scenario(); f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledWith([f.miners[0].id], OrderType.Gather, -8, 0);
        f.at(60); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
    });
    test("a pure-ore map also sends a departure to a second field when its old field is full", () => {
        const f = scenario(false); f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledWith([f.miners[0].id], OrderType.Gather, 30, 0);
    });
    test.each([4, 4.01])("the original four-tile departure distance%s remains the eligibility boundary", distance => {
        const f = scenario(); f.miners[0].tile.rx = distance; f.run();
        expect(f.actions.orderUnits).toHaveBeenCalledTimes(distance <= 4 ? 1 : 0);
    });
    test("available gems still take the original priority without a second recovery order", () => {
        const f = scenario(); f.miners.pop(); f.run();
        expect(f.actions.orderUnits.mock.calls).toEqual([[[f.miners[0].id], OrderType.Gather, 20, 0]]);
    });
    test("a miner already assigned to a served field remains under the original balancing cadence", () => {
        const f = scenario(); f.miners[0].tile.rx = -4; f.run();
        expect(f.actions.orderUnits).not.toHaveBeenCalled();
    });
    test.each(["cargo", "unknown", "underfoot", "injured", "normal", "blocked", "hidden-ore"])("%s cannot be turned into a new departure order", condition => {
        const f = scenario(), m = f.miners[0];
        if (condition === "cargo") m.harvestedGems = 1;
        if (condition === "unknown") delete m.harvestedOre;
        if (condition === "underfoot") f.resources.push({ tile: { ...m.tile }, ore: 1, gems: 0 });
        if (condition === "injured") m.hitPoints = 600;
        if (condition === "normal") f.context.difficulty = "normal";
        if (condition === "blocked") f.blocked.add("-8_0");
        if (condition === "hidden-ore") {
            f.hidden.add("-8_0"); Object.defineProperty(f.resources[0], "ore", { get() { throw Error("hidden ore read"); } });
        }
        f.run(); expect(f.actions.orderUnits).not.toHaveBeenCalled();
    });
});

describe("served-field one-miner balancing", () => {
    test("five miners on capacity four versus one on capacity four moves exactly one at tick 150", () => {
        const f = balanceFixture();
        f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        expect(f.actions.orderUnits).toHaveBeenCalledWith([f.miners[0].id], OrderType.Gather, 30, 0);
    });
    test("the same eligible miner cannot be balanced again within 600 ticks", () => {
        const f = balanceFixture(), miner = f.miners[0];
        for (const other of f.miners.slice(1, -1)) other.harvestedOre = 1;
        f.run();
        miner.tile.rx = 28; f.at(300); f.run();
        miner.tile.rx = 6; f.at(600); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(1);
        f.at(750); f.run(); expect(f.actions.orderUnits).toHaveBeenCalledTimes(2);
        expect(f.actions.orderUnits.mock.calls.every(call => call[0][0] === miner.id)).toBe(true);
    });
    test("no overcapacity, no deficit and no reachable route do not move a miner", () => {
        for (const reason of ["not-overfull", "not-underfull", "unreachable"]) {
            const f = balanceFixture();
            if (reason === "not-overfull") f.miners.splice(1, 1);
            if (reason === "not-underfull") { f.miner(30, true); f.miner(30, true); f.miner(30, true); }
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

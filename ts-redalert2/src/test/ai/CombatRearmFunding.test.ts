import { describe, expect, mock, test } from "bun:test";
import { ArmorType } from "../../game/type/ArmorType";
import { BuildStatus } from "../../game/gameobject/Building";
import { MovementZone, ObjectType, QueueStatus, QueueType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { BuiltInBot } from "../../game/ai/thirdpartbot/builtIn/bot/bot";
import { QueueController, QUEUES } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";
import { Countries } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/utils";

// D1's8518/9704/9308/11728/13226 witnesses supply the counts, modes and queue state.
// Coordinates/resources are normalized public fixtures, not full native-game replays.
function fixture({ tick = 8518, miners = 2, core = 1, country = "Americans", refineries = 1, recentHomeContact = false } = {}) {
    let now = tick, id = 1;
    const soviet = country === "Russians", minerName = soviet ? "HARV" : "CMIN", tankName = soviet ? "HTNK" : "MTNK";
    const player: any = { name: "bot", country: { name: country }, startLocation: new Vector2(), credits: 5000,
        power: { total: 300, drain: 0 }, isAi: true, isCombatant: true };
    const owned: any[] = [], enemies: any[] = [];
    function own(name: string, rx = 0, extra = {}) {
        const vehicle = ["CMIN", "HARV", "MTNK", "HTNK"].includes(name);
        const rules = { name, type: vehicle ? ObjectType.Vehicle : ObjectType.Building,
            armor: vehicle ? ArmorType.Heavy : ArmorType.Concrete, movementZone: MovementZone.Normal,
            harvester: ["HARV", "CMIN"].includes(name), isSelectableCombatant: ["HTNK", "MTNK"].includes(name),
            refinery: ["GAREFN", "NAREFN"].includes(name), weaponsFactory: ["GAWEAP", "NAWEAP"].includes(name),
            constructionYard: ["GACNST", "NACNST"].includes(name), ...extra };
        const hp = name === "MTNK" ? 300 : name === "HTNK" ? 400 : 1000;
        const unit = { id: id++, name, owner: "bot", type: rules.type, rules, tile: { rx, ry: 0 },
            hitPoints: hp, maxHitPoints: hp, foundation: { width: 1, height: 1 }, buildStatus: BuildStatus.Ready, isIdle: true };
        owned.push(unit); return unit;
    }
    own(soviet ? "NACNST" : "GACNST"); own(soviet ? "NAWEAP" : "GAWEAP");
    for (let i = 0; i < refineries; i++) own(soviet ? "NAREFN" : "GAREFN", 5 + i * 20);
    for (let i = 0; i < miners; i++) own(minerName, 5);
    for (let i = 0; i < core; i++) own(tankName);
    const available = new Map(QUEUES.map(queue => [queue, [] as any[]]));
    available.set(QueueType.Vehicles, [
        { name: minerName, harvester: true, cost: 1400, type: ObjectType.Vehicle },
        { name: tankName, cost: soviet ? 900 : 700, type: ObjectType.Vehicle },
    ]);
    const queues = new Map(QUEUES.map(type => [type, { type, status: QueueStatus.Idle, items: [] as any[], size: 0 }]));
    const actions = { queueForProduction: mock((_queue: QueueType, _name: string, _type: ObjectType, _quantity: number) => {}),
        unqueueFromProduction: mock(() => {}), pauseProduction: mock(() => {}), resumeProduction: mock(() => {}),
        toggleRepairWrench: mock(() => {}), orderUnits: mock(() => {}), sellBuilding: mock(() => {}), quitGame: mock(() => {}) };
    const production: any = { getAvailableObjects: (queue?: QueueType) => queue === undefined ? [...available.values()].flat() : available.get(queue)!,
        getQueueData: (queue: QueueType) => queues.get(queue)! };
    const game: any = { getCurrentTick: () => now, getPlayerData: () => player,
        getGeneralRules: () => ({ baseUnit: ["AMCV", "SMCV"] }),
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "self" ? owned : enemies).filter(unit => predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (uid: number) => [...owned, ...enemies].find(unit => unit.id === uid),
        getGameObjectData: (uid: number) => game.getUnitData(uid),
        mapApi: { getAllTilesResourceData: () => [5, 25].map(rx => ({ tile: { rx, ry: 0 }, ore: 2000, gems: 0 })),
            getResourceCreditValues: () => ({ ore: 10, gems: 20 }), isVisibleTile: () => true,
            getStartingLocations: () => [player.startLocation, new Vector2(200, 0)],
            getTileResourceData: () => ({ ore: 0, gems: 0 }), findPath: (_speed: any, _start: any, end: any) => [end] } };
    const context: any = { game, difficulty: "brutal", player: { name: "bot", actions, production },
        matchAwareness: { getThreatCache: () => null, getNextExpansionCandidates: () => [] } };
    const controller = new QueueController(), requests = new Map<string, any>([[tankName, { priority: 75, specificLocation: null }]]);
    function enemy(name = "E1", rx = 100, type = ObjectType.Infantry, extra = {}) {
        const unit = { id: 500 + enemies.length, name, owner: "enemy", type, tile: { rx, ry: 0 },
            rules: { name, type, movementZone: MovementZone.Normal, isSelectableCombatant: true,
                primary: name === "E1" ? "M60" : "120mm", secondary: name === "E1" ? "Para" : undefined,
                harvester: false, ...extra } };
        enemies.push(unit); return unit;
    }
    if (recentHomeContact) enemy("DOG", 50, ObjectType.Infantry, { primary: "Teeth" });
    return { player, game, context, owned, enemies, own, enemy, available, queues, actions, controller, requests, production, tankName, minerName,
        at(value: number) { now = value; },
        queue(name: string, status: QueueStatus, progress = 334 / 700) {
            const rules = available.get(QueueType.Vehicles)!.find(option => option.name === name)!;
            Object.assign(queues.get(QueueType.Vehicles)!, { status, size: 1, items: [{ rules, quantity: 1, progress }] });
        },
        run(fieldArmyRegrouping?: boolean) {
            const args: any[] = [context, null, requests, () => {}];
            if (fieldArmyRegrouping !== undefined) args.push(fieldArmyRegrouping);
            // Exercise B2's planned optional state contract against today's unchanged four-argument method.
            Reflect.apply(controller.onAiUpdate, controller, args);
        },
        priority(name: string) { return Number(controller.getGlobalDebugText(game, production).match(new RegExp(`${name}\\(([^)]+)\\)`))?.[1] ?? 0); },
        outcome() { return { priorities: controller.getGlobalDebugText(game, production),
            queued: actions.queueForProduction.mock.calls, cancelled: actions.unqueueFromProduction.mock.calls,
            paused: actions.pauseProduction.mock.calls, resumed: actions.resumeProduction.mock.calls }; } };
}
function infantryWitness() {
    const f = fixture(); for (let i = 0; i < 7; i++) f.enemy(); return f;
}
function withEcoOnly(run: () => void) {
    const old = BRUTAL_PARAMS.economy.ecoOnly; BRUTAL_PARAMS.economy.ecoOnly = 1;
    try { run(); } finally { BRUTAL_PARAMS.economy.ecoOnly = old; }
}

describe("B2 actual regrouping state coordinates existing core funding", () => {
    test.each([QueueStatus.Active, QueueStatus.OnHold])("8518: visible infantry without enemy tanks cannot cancel the admitted core in status%i", status => {
        const f = infantryWitness(); f.queue(f.tankName, status); f.run(true);
        expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
        expect(f.priority(f.tankName)).toBe(100);
        expect(f.actions.queueForProduction).not.toHaveBeenCalledWith(QueueType.Vehicles, f.minerName, ObjectType.Vehicle, 1);
    });
    test("9704: empty type requests do not erase regrouping intent when a new core is being claimed", () => {
        const f = fixture({ tick: 9704, miners: 2, core: 4 }); f.requests.clear(); f.enemy("MTNK", 100, ObjectType.Vehicle); f.run(true);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.tankName, ObjectType.Vehicle, 1);
        expect(f.priority(f.tankName)).toBe(100);
    });
    test.each([[9308, 3, 1, 2], [11728, 4, 1, 3], [13226, 6, 2, 4]])("AR tick%i: next optional miner yields to unmet core readiness", (tick, miners, refineries, enemyCore) => {
        const f = fixture({ tick, miners, core: 4, refineries, recentHomeContact: true });
        for (let i = 0; i < enemyCore; i++) f.enemy("HTNK", 100 + i, ObjectType.Vehicle);
        f.run(true); expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.tankName, ObjectType.Vehicle, 1);
        expect(f.priority(f.tankName)).toBe(100);
    });
    test("the same regrouping contract funds Soviet HTNK rather than hardcoding Allied MTNK", () => {
        const f = fixture({ tick: 12000, country: "Russians", miners: 2, core: 4 }); f.enemy("MTNK", 100, ObjectType.Vehicle); f.run(true);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HTNK", ObjectType.Vehicle, 1);
        expect(f.priority("HTNK")).toBe(100);
    });
    test("current8518 baseline reproduces miner110 over core85 and the cancellation, without the new signal", () => {
        const f = infantryWitness(); f.queue(f.tankName, QueueStatus.Active); f.run(false);
        expect(f.priority(f.tankName)).toBe(85); expect(f.priority(f.minerName)).toBe(110);
        expect(f.actions.unqueueFromProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.tankName, ObjectType.Vehicle, 1);
    });
    test("the existing78/75 AR branch remains explicit when regrouping is absent", () => {
        const f = fixture({ tick: 11728, miners: 4, core: 4, recentHomeContact: true }); f.enemy("HTNK", 100, ObjectType.Vehicle); f.run(false);
        expect(f.priority(f.tankName)).toBe(75); expect(f.priority(f.minerName)).toBe(78);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.minerName, ObjectType.Vehicle, 1);
    });
    test.each([QueueStatus.Active, QueueStatus.OnHold, QueueStatus.Ready])("a paid miner remains outside rearm arbitration in status%i", status => {
        const f = infantryWitness(); f.queue(f.minerName, status, .74); f.run(true);
        expect(f.priority(f.tankName)).toBe(85); expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
        expect(f.actions.queueForProduction).not.toHaveBeenCalledWith(QueueType.Vehicles, f.tankName, ObjectType.Vehicle, 1);
    });
    test("a Ready core is not interpreted as an empty queue or as a delivered unit", () => {
        const f = infantryWitness(); f.queue(f.tankName, QueueStatus.Ready, 1); f.run(true);
        expect(f.priority(f.tankName)).toBe(85); expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
        expect(f.actions.queueForProduction).not.toHaveBeenCalled();
        expect(f.owned.filter(unit => unit.name === f.tankName)).toHaveLength(1);
    });
    test("a pending non-core115 counter remains outside rearm arbitration", () => {
        const f = infantryWitness(); f.available.get(QueueType.Vehicles)!.push({ name: "FV", type: ObjectType.Vehicle, cost: 600 });
        f.requests.set("FV", { priority: 115, specificLocation: null }); f.queue("FV", QueueStatus.Active); f.run(true);
        expect(f.priority(f.tankName)).toBe(85); expect(f.priority("FV")).toBe(115);
        expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
    });
    test.each([0, 1])("income restoration with%i miners remains ahead of optional rearm", miners => {
        const f = fixture({ miners }); f.enemy(); f.run(true);
        expect(f.priority(f.tankName)).toBeLessThan(100); expect(f.priority(f.minerName)).toBe(miners === 0 ? 120 : 110);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.minerName, ObjectType.Vehicle, 1);
    });
    test("no core option means no invented military prerequisite or request", () => {
        const f = infantryWitness(); f.available.set(QueueType.Vehicles, f.available.get(QueueType.Vehicles)!.filter(option => option.name !== f.tankName));
        f.run(true); expect(f.priority(f.tankName)).toBe(0);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.minerName, ObjectType.Vehicle, 1);
    });
    test("no owned refinery keeps the original military request rather than enabling rearm", () => {
        const f = infantryWitness(); f.owned.splice(f.owned.findIndex(unit => unit.rules.refinery), 1); f.run(true);
        expect(f.priority(f.tankName)).toBe(85);
    });
    test("ecoOnly does not acquire a military request from an own regrouping signal", () => withEcoOnly(() => {
        const f = infantryWitness(); f.run(true); expect(f.priority(f.tankName)).toBe(0);
        expect(f.actions.queueForProduction).not.toHaveBeenCalledWith(QueueType.Vehicles, f.tankName, ObjectType.Vehicle, 1);
    }));
    test.each(["hidden", "dog", "engineer", "miner", "air-only"])("%s is not a meaningful public armed ground threat", condition => {
        const f = fixture({ core: 4 });
        if (condition === "hidden") {
            const enemy = f.enemy(); f.enemies.length = 0;
            Object.defineProperty(enemy, "tile", { get() { throw Error("hidden enemy tile must not be queried"); } });
        } else if (condition === "dog") f.enemy("DOG", 100, ObjectType.Infantry, { primary: "Teeth" });
        else if (condition === "engineer") f.enemy("ENGINEER", 100, ObjectType.Infantry, { primary: undefined, engineer: true });
        else if (condition === "miner") f.enemy("HARV", 100, ObjectType.Vehicle, { harvester: true });
        else f.enemy("JUMPJET", 100, ObjectType.Infantry, { movementZone: MovementZone.Fly });
        f.run(true); expect(f.priority(f.tankName)).toBe(75);
    });
    test("visible opposing private HP/credits never become rearm inputs", () => {
        const f = infantryWitness(); for (const enemy of f.enemies) Object.defineProperty(enemy, "hitPoints", { get() { throw Error("enemy exact health is not public"); } });
        f.game.getPlayerData = (name: string) => {
            if (name !== "bot") throw Error("opposing private credit query"); return f.player;
        };
        f.run(true); expect(f.priority(f.tankName)).toBe(100);
    });
    test("Normal remains identical with or without a regrouping signal", () => {
        const outcomes = [false, true].map(signal => {
            const f = infantryWitness(); f.context.difficulty = "normal"; f.requests.set(f.minerName, { priority: 110, specificLocation: null });
            f.run(signal); return f.outcome();
        });
        expect(outcomes[1]).toEqual(outcomes[0]);
    });
    test("a higher existing core priority is not lowered to100", () => {
        const f = infantryWitness(); f.requests.set(f.tankName, { priority: 130, specificLocation: null }); f.run(true);
        expect(f.priority(f.tankName)).toBe(130);
    });
    test("AA115 stays ahead of rearm100", () => {
        const f = fixture({ tick: 12000, country: "Russians", miners: 3, core: 4 }); f.enemy();
        f.enemy("ORCA", 100, ObjectType.Aircraft); f.available.get(QueueType.Vehicles)!.push({ name: "HTK", type: ObjectType.Vehicle, cost: 500 });
        f.run(true); expect(f.priority("HTK")).toBe(115);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HTK", ObjectType.Vehicle, 1);
    });
    test("first drone112 is not lowered or deleted by rearm100", () => {
        const f = fixture({ country: "Russians", miners: 3, core: 4 }); f.enemy();
        f.available.get(QueueType.Vehicles)!.push({ name: "DRON", type: ObjectType.Vehicle, cost: 500 }); f.run(true);
        expect(f.priority("DRON")).toBe(112);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "DRON", ObjectType.Vehicle, 1);
    });
    test("clearing regrouping restores original income priorities and does not mutate caller requests", () => {
        const f = infantryWitness(), before = [...f.requests].map(([name, value]): [string, any] => [name, { ...value }]);
        f.run(true); f.actions.queueForProduction.mockClear(); f.at(8520); f.run(false);
        expect(f.priority(f.minerName)).toBe(110);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.minerName, ObjectType.Vehicle, 1);
        expect([...f.requests]).toEqual(before);
    });
});

describe("B2 bot-to-queue own-state transport", () => {
    function caller(difficulty: "normal" | "brutal" = "brutal", includeField = true, afterUpdate = false) {
        const f = fixture(), bot = new BuiltInBot("bot", Countries.USA); let attacking = true;
        const reads = mock(() => {
            if (difficulty === "normal") throw Error("Normal must not inspect the new own-field state"); return attacking;
        });
        const field = { getUniqueName: () => "fieldArmy", isAttacking: reads };
        const incoming = new Map(), sink = mock((..._args: any[]) => {});
        const missions = { onAiUpdate() { attacking = afterUpdate; }, getRequestedUnitTypes: () => incoming,
            getMissions: () => includeField ? [field] : [] };
        const strategy: any = { onAiUpdate: () => strategy };
        Object.assign(bot, { tickRatio: 2, difficulty, strategy, missionController: missions,
            matchAwareness: { getThreatCache: () => null, onAiUpdate() {} },
            parasiteRepair: { onAiUpdate() {} }, queueController: { onAiUpdate: sink } });
        bot.setGameApi(f.game); bot.setActionsApi(f.actions); bot.setProductionApi(f.production);
        bot.onGameTick(f.game);
        return { sink, incoming, reads, deliveredSignal: sink.mock.calls[0]?.[4] ?? false };
    }
    test("the8518/9704 signal follows actual post-update state even when requested types are empty", () => {
        const f = caller(); expect(f.sink).toHaveBeenCalledTimes(1); expect(f.sink.mock.calls[0][2]).toBe(f.incoming);
        expect(f.deliveredSignal).toBe(true); expect(f.reads).toHaveBeenCalledTimes(1);
    });
    test("an attacking field does not request regrouping funds", () => {
        const f = caller("brutal", true, true); expect(f.deliveredSignal).toBe(false);
    });
    test("a missing field does not invent a regrouping signal", () => {
        const f = caller("brutal", false); expect(f.deliveredSignal).toBe(false); expect(f.reads).not.toHaveBeenCalled();
    });
    test("Normal does not inspect the new field state", () => {
        const f = caller("normal"); expect(f.deliveredSignal).toBe(false); expect(f.reads).not.toHaveBeenCalled();
    });
});

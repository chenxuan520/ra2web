import { expect, mock, test } from "bun:test";
import { BuildStatus } from "../../game/gameobject/Building";
import { MovementZone, ObjectType, QueueStatus, QueueType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { QueueController, QUEUES } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";
import { readPressure, setPressureWatchPost } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/pressure";

// D4 C3/mp08 AR/false3718 has12 non-firing own GI and an ordinary prior
// MTNK100 decision, not an acknowledged infantry response. Normalized public
// fixtures verify that distinction without replaying a game or changing gates.
function fixture(country = "Americans", core = 1, firing = true) {
    let tick = 4080, id = 1;
    const soviet = country === "Russians", tank = soviet ? "HTNK" : "MTNK", miner = soviet ? "HARV" : "CMIN";
    const owned: any[] = [], enemies: any[] = [];
    function own(name: string, rx = 0) {
        const infantry = ["E1", "E2"].includes(name), vehicle = ["MTNK", "HTNK", "HARV", "CMIN"].includes(name);
        const type = infantry ? ObjectType.Infantry : vehicle ? ObjectType.Vehicle : ObjectType.Building;
        const rules = { name, type, movementZone: MovementZone.Normal, isSelectableCombatant: infantry || ["MTNK", "HTNK"].includes(name),
            harvester: ["HARV", "CMIN"].includes(name), refinery: ["NAREFN", "GAREFN"].includes(name),
            weaponsFactory: ["NAWEAP", "GAWEAP"].includes(name), constructionYard: ["NACNST", "GACNST"].includes(name) };
        const unit = { id: id++, name, owner: "bot", type, rules, tile: { rx, ry: 0 }, hitPoints: 1000, maxHitPoints: 1000,
            isFiring: false, isIdle: true, foundation: { width: 1, height: 1 }, buildStatus: BuildStatus.Ready };
        owned.push(unit); return unit;
    }
    own(soviet ? "NACNST" : "GACNST"); own(soviet ? "NAWEAP" : "GAWEAP"); own(soviet ? "NAREFN" : "GAREFN", 5);
    own(miner, 5); for (let i = 0; i < core; i++) own(tank, 30);
    const rifle = own(soviet ? "E2" : "E1", 45); rifle.isFiring = firing;
    for (let i = 0; i < 10; i++) enemies.push({ id: 500 + i, name: "E1", owner: "enemy", type: ObjectType.Infantry,
        tile: { rx: 70, ry: 0 }, rules: { name: "E1", type: ObjectType.Infantry, isSelectableCombatant: true, primary: "M60" } });
    const options = new Map(QUEUES.map(type => [type, [] as any[]]));
    options.set(QueueType.Vehicles, [{ name: tank, type: ObjectType.Vehicle, cost: soviet ? 900 : 700 },
        { name: miner, type: ObjectType.Vehicle, cost: 1400, harvester: true }]);
    const queues = new Map(QUEUES.map(type => [type, { type, status: QueueStatus.Idle, items: [] as any[], size: 0 }]));
    const actions = { queueForProduction: mock((_queue: QueueType, _name: string, _type: ObjectType, _quantity: number) => {}),
        unqueueFromProduction: mock(() => {}), pauseProduction: mock(() => {}), resumeProduction: mock(() => {}),
        toggleRepairWrench: mock(() => {}), sellBuilding: mock(() => {}) };
    const player: any = { name: "bot", country: { name: country }, startLocation: new Vector2(), credits: 5000,
        power: { total: 300, drain: 0, isLowPower: false }, isAi: true, isCombatant: true };
    const production: any = { getAvailableObjects: (type?: QueueType) => type === undefined ? [...options.values()].flat() : options.get(type)!,
        getQueueData: (type: QueueType) => queues.get(type)! };
    const game: any = { getCurrentTick: () => tick, getPlayerData: () => player,
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "self" ? owned : enemies).filter(unit => predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (uid: number) => [...owned, ...enemies].find(unit => unit.id === uid),
        getGameObjectData: (uid: number) => game.getUnitData(uid),
        mapApi: { getAllTilesResourceData: () => [5, 25].map(rx => ({ tile: { rx, ry: 0 }, ore: 8000, gems: 0 })),
            getResourceCreditValues: () => ({ ore: 1, gems: 2 }), isVisibleTile: () => true,
            getStartingLocations: () => [player.startLocation, new Vector2(200, 0)], getTileResourceData: () => undefined,
            findPath: (_speed: any, _start: any, end: any) => [end] } };
    setPressureWatchPost(game, "bot", { rx: 65, ry: 0 });
    const context: any = { game, difficulty: "brutal", player: { name: "bot", actions, production },
        matchAwareness: { getThreatCache: () => null, getNextExpansionCandidates: () => [] } };
    const controller = new QueueController(), requests = new Map<string, any>([[tank, { priority: 75, specificLocation: null }]]);
    return { tank, miner, rifle, own, owned, enemies, context, options, requests, actions, queues, game,
        next() { tick += 2; },
        idle() { Object.assign(queues.get(QueueType.Vehicles)!, { status: QueueStatus.Idle, items: [], size: 0 }); },
        run() { controller.onAiUpdate(context, null, requests, () => {}, false); },
        priority(name = tank) { return Number(controller.getGlobalDebugText(game, production).match(new RegExp(`${name}\\(([^)]+)\\)`))?.[1] ?? 0); } };
}

test.each(["Americans", "Russians"])("%s ordinary first-core100 is not an infantry-combat acknowledgement", country => {
    const f = fixture(country, 0, false); f.run(); expect(f.priority()).toBe(100);
    f.own(f.tank, 30); f.next(); f.idle(); f.run();
    expect(f.priority()).toBe(country === "Americans" ? 75 : 85);
});
test.each(["Americans", "Russians"])("%s a shot before any owned core cannot mark a later follow-up as already funded", country => {
    const f = fixture(country, 0, true); f.run(); expect(f.priority()).toBe(100);
    f.own(f.tank, 30); f.rifle.isFiring = false; f.next(); f.idle(); f.run();
    expect(f.priority()).toBe(country === "Americans" ? 75 : 85);
});
test("a real post-core infantry response survives an intervening higher-priority AA selection", () => {
    const f = fixture(); f.options.get(QueueType.Vehicles)!.push({ name: "FV", type: ObjectType.Vehicle, cost: 600 });
    f.requests.set("FV", { priority: 115, specificLocation: null }); f.run(); expect(f.priority()).toBe(100);
    expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "FV", ObjectType.Vehicle, 1);
    f.requests.delete("FV"); f.rifle.isFiring = false; f.next(); f.run(); expect(f.priority()).toBe(100);
});
test("meeting the original target clears the response before a later unengaged deficit", () => {
    const f = fixture(); f.run(); expect(f.priority()).toBe(100);
    const reinforcement = f.own(f.tank, 30); f.rifle.isFiring = false; f.next(); f.run(); expect(f.priority()).toBe(75);
    f.owned.splice(f.owned.indexOf(reinforcement), 1); f.next(); f.run(); expect(f.priority()).toBe(75);
});
test("losing every core clears the follow-up intent without changing ordinary first-core recovery", () => {
    const f = fixture(); f.run(); expect(f.priority()).toBe(100);
    for (let i = f.owned.length - 1; i >= 0; i--) if (f.owned[i].name === f.tank) f.owned.splice(i, 1);
    f.rifle.isFiring = false; f.next(); f.run(); expect(f.priority()).toBe(100);
    f.own(f.tank, 30); f.next(); f.run(); expect(f.priority()).toBe(75);
});
test("below-threshold contact clears the intent; a returning warning alone does not reactivate it", () => {
    const f = fixture(); f.run(); expect(f.priority()).toBe(100);
    const removed = f.enemies.splice(7); f.rifle.isFiring = false; f.next(); f.run();
    expect(readPressure(f.context).earlyPressure).toBe(true); expect(f.priority()).toBe(75);
    f.enemies.push(...removed); f.next(); f.run(); expect(f.priority()).toBe(75);
});
test("Normal does not inspect the new combat-intent input", () => {
    const f = fixture(); f.context.difficulty = "normal";
    Object.defineProperty(f.rifle, "isFiring", { get() { throw Error("Normal firing lookup"); } });
    f.requests.set(f.miner, { priority: 110, specificLocation: null }); f.run();
    expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.miner, ObjectType.Vehicle, 1);
});
test("ecoOnly never admits combat support", () => {
    const previous = BRUTAL_PARAMS.economy.ecoOnly; BRUTAL_PARAMS.economy.ecoOnly = 1;
    try { const f = fixture(); f.run(); expect(f.priority()).toBe(0); }
    finally { BRUTAL_PARAMS.economy.ecoOnly = previous; }
});

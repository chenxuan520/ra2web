import { expect, mock, test } from "bun:test";
import { BuildStatus } from "../../game/gameobject/Building";
import { MovementZone, ObjectType, QueueStatus, QueueType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { QueueController, QUEUES } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController";
import { setPressureWatchPost } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/pressure";

// The D4 RR/false5412 match is entirely standard-equal to B7: a firing
// cohort's95 replenishment is selected but its idle queue is deferred for
// support armor100. These normalized fixtures verify execution, not native wins.
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
    return { player, tank, miner, rifle, own, owned, enemies, context, options, requests, actions, queues, game,
        next() { tick += 2; },
        idle() { Object.assign(queues.get(QueueType.Vehicles)!, { status: QueueStatus.Idle, items: [], size: 0 }); },
        run() { controller.onAiUpdate(context, null, requests, () => {}, false); },
        priority(name = tank) { return Number(controller.getGlobalDebugText(game, production).match(new RegExp(`${name}\\(([^)]+)\\)`))?.[1] ?? 0); } };
}


function opening(country = "Russians", core = 1, firing = true, priority = 95) {
    const f = fixture(country, core, firing), name = country === "Russians" ? "E2" : "E1";
    f.player.credits = 625;
    f.options.set(QueueType.Infantry, [{ name, type: ObjectType.Infantry, cost: name === "E2" ? 100 : 200 }]);
    f.requests.set(name, { priority, specificLocation: null });
    return { ...f, name };
}
test.each(["Russians", "Americans"])("%s acknowledged support preserves its critical95 field replenishment", country => {
    const f = opening(country); f.run(); expect(f.priority()).toBe(100);
    expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Infantry, f.name, ObjectType.Infantry, 1);
    expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.tank, ObjectType.Vehicle, 1);
});
test("ordinary first-core100 still defers lower-priority recruits", () => {
    const f = opening("Russians", 0, true); f.run(); expect(f.priority()).toBe(100);
    expect(f.actions.queueForProduction).not.toHaveBeenCalledWith(QueueType.Infantry, f.name, ObjectType.Infantry, 1);
});
test("the old two-income counter remains outside the one-income support exception", () => {
    const f = opening(); f.own(f.miner, 5); f.run(); expect(f.priority()).toBe(100);
    expect(f.actions.queueForProduction).not.toHaveBeenCalledWith(QueueType.Infantry, f.name, ObjectType.Infantry, 1);
});
test("ordinary20 infantry does not acquire critical-opening precedence", () => {
    const f = opening("Russians", 1, true, 20); f.run(); expect(f.priority()).toBe(100);
    expect(f.actions.queueForProduction).not.toHaveBeenCalledWith(QueueType.Infantry, f.name, ObjectType.Infantry, 1);
});
test("an already paid infantry queue is neither cancelled nor paused by the support exception", () => {
    const f = opening();
    Object.assign(f.queues.get(QueueType.Infantry)!, { status: QueueStatus.Active, size: 1,
        items: [{ rules: f.options.get(QueueType.Infantry)![0], quantity: 1 }] });
    f.run(); expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
    expect(f.actions.pauseProduction).not.toHaveBeenCalledWith(QueueType.Infantry);
});

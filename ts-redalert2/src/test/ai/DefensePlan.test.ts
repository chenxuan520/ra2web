import { describe, expect, mock, test } from "bun:test";
import { BuildStatus } from "../../game/gameobject/Building";
import { ApiEventType, ObjectType, QueueStatus, QueueType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { canRequestDefense, getDefenseState, hasSeenEnemyDrone, observeDefense, observeDefenseEvent, planDefense, recordDefenseOrder }
    from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/defensePlan";
import { getBaseCrawlState } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/baseCrawl";
import { getEconomyBuildingPriority } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/economyPlan";
import { BaseBuildingMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseBuildingMission";
import { QueueController, QUEUES } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController";
import { MinerDefence } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/minerDefence";
import { CombatSquad } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/combatSquad";
import { Mission, noop } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/mission";
import { ActionBatcher } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";
import { BuiltInBot } from "../../game/ai/thirdpartbot/builtIn/bot/bot";
import { Countries } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/utils";

function fixture() {
    let tick = 0, nextId = 1;
    const player: any = { name: "bot", country: { name: "Russians" }, startLocation: new Vector2(), credits: 2000,
        power: { total: 300, drain: 0 }, isAi: true };
    const units: any[] = [], enemies: any[] = [], hidden = new Set<number>();
    const own = (name: string, rx = 0, ry = 0) => {
        const vehicle = ["HARV", "HTNK"].includes(name);
        const unit: any = { id: nextId++, name, owner: player.name, type: vehicle ? ObjectType.Vehicle : ObjectType.Building,
            tile: { rx, ry }, foundation: { width: 1, height: 1 }, buildStatus: BuildStatus.Ready,
            hitPoints: 1000, maxHitPoints: 1000, isIdle: true, canMove: true, isWarpedOut: false, zone: ZoneType.Ground,
            harvestedOre: 0, harvestedGems: 0,
            rules: { name, type: vehicle ? ObjectType.Vehicle : ObjectType.Building, baseNormal: !vehicle && !["NALASR", "NAFLAK"].includes(name),
                refinery: name === "NAREFN", harvester: name === "HARV", crusher: name === "HARV", weaponsFactory: name === "NAWEAP",
                constructionYard: name === "NACNST", isSelectableCombatant: name === "HTNK" } };
        units.push(unit); return unit;
    };
    own("NACNST"); own("NAWEAP"); const refinery = own("NAREFN", 5);
    const miners = [own("HARV", 10), own("HARV", 10), own("HARV", 10)];
    const resources = [10, 30].map(rx => ({ tile: { rx, ry: 0 }, ore: 8000, gems: 0 }));
    const candidates = Array.from({ length: 101 }, (_, i) => ({ id: `${i - 50}_0`, rx: i - 50, ry: 0 }));
    const basic: any = { name: "NALASR", type: ObjectType.Building, baseNormal: false, adjacent: 100, cost: 500 };
    const aa: any = { name: "NAFLAK", type: ObjectType.Building, baseNormal: false, adjacent: 100, cost: 1000 };
    const depot: any = { name: "NADEPT", type: ObjectType.Building, baseNormal: true, adjacent: 100, cost: 800 };
    const power: any = { name: "NAPOWR", type: ObjectType.Building, baseNormal: true, adjacent: 100, cost: 800, power: 150 };
    const queues = new Map(QUEUES.map(type => [type, { type, status: QueueStatus.Idle, items: [] as any[], size: 0 }]));
    const actions = { orderUnits: mock((_ids: number[], ..._args: any[]) => {}), queueForProduction: mock(() => {}), unqueueFromProduction: mock(() => {}),
        pauseProduction: mock(() => {}), resumeProduction: mock(() => {}), placeBuilding: mock(() => {}), sellBuilding: mock(() => {}),
        toggleRepairWrench: mock(() => {}), setUnitDebugText: mock(() => {}) };
    const game: any = { getCurrentTick: () => tick, getPlayerData: () => player,
        getGeneralRules: () => ({ baseUnit: ["SMCV", "AMCV"] }),
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "self" ? units : enemies).filter(unit => !hidden.has(unit.id) && predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => { if (hidden.has(id)) throw Error("hidden lookup"); return [...units, ...enemies].find(unit => unit.id === id); },
        getGameObjectData: (id: number) => game.getUnitData(id),
        getBuildingPlacementData: () => ({ foundation: { width: 1, height: 1 } }),
        canPlaceBuilding: (_name: string, _rule: string, tile: any) => !units.some(unit => unit.type === ObjectType.Building && unit.tile.rx === tile.rx && unit.tile.ry === tile.ry),
        mapApi: { getAllTilesResourceData: () => resources, isVisibleTile: () => true, getResourceCreditValues: () => ({ ore: 1, gems: 2 }),
            getStartingLocations: () => [player.startLocation, new Vector2(200, 0)],
            getTileResourceData: (tile: any) => resources.find(resource => resource.tile.rx === tile.rx && resource.tile.ry === tile.ry),
            getTile: (rx: number, ry: number) => ({ rx, ry }), findPath: (_speed: any, _start: any, end: any) => [end],
            getTilesInRect: (rect: any) => candidates.filter(tile => tile.rx >= rect.x && tile.rx < rect.x + rect.width && tile.ry >= rect.y && tile.ry < rect.y + rect.height) },
    };
    const context: any = { game, difficulty: "brutal", player: { name: player.name, actions, production: {
        getQueueData: (type: QueueType) => queues.get(type)!,
        getAvailableObjects: (type: QueueType) => type === QueueType.Armory ? [basic, aa] : type === QueueType.Structures ? [depot, power] : [],
    } }, matchAwareness: { getThreatCache: () => null, getNextExpansionCandidates: () => [], getHostilesNearPoint: () => [] } };
    const enemy = (name: string, rx = 100, type = ObjectType.Vehicle, ry = 0) => {
        const unit: any = { id: 500 + enemies.length, name, owner: "enemy", type, tile: { rx, ry },
            rules: { name, type, isSelectableCombatant: type !== ObjectType.Building } };
        enemies.push(unit); return unit;
    };
    const at = (value: number) => { tick = value; };
    const build = () => {
        const plan = planDefense(context)!; expect(plan).toBeDefined();
        recordDefenseOrder(game, player.name, plan.rules.name, new Vector2(plan.location.rx, plan.location.ry));
        const queue = queues.get(QueueType.Armory)!; queue.status = QueueStatus.Active; queue.items = [{ rules: plan.rules, quantity: 1 }];
        tick += 2; observeDefense(context);
        const unit = own(plan.rules.name, plan.location.rx, plan.location.ry); unit.buildStatus = BuildStatus.BuildUp;
        queue.status = QueueStatus.Idle; queue.items = []; tick += 2; observeDefense(context);
        unit.buildStatus = BuildStatus.Ready; tick += 2; observeDefense(context);
        return unit;
    };
    return { game, player, context, units, enemies, hidden, refinery, miners, resources, candidates, queues, actions, basic, aa, depot, power, own, enemy, at, build,
        plan: (emergency?: any) => planDefense(context, emergency), observe: () => observeDefense(context) };
}

describe("visible-signal defense plans", () => {
    test("no signal produces neither a plan nor generic anti-air production", () => {
        const f = fixture(); expect(f.plan()).toBeUndefined();
        expect(getEconomyBuildingPriority(f.game, f.player, f.aa, false, f.context)).toBe(0);
        new QueueController().onAiUpdate(f.context, null, new Map(), () => {});
        expect(f.actions.queueForProduction).not.toHaveBeenCalled();
    });
    test("the unchanged invading-unit D0 request is checked before D1", () => {
        const f = fixture(); f.enemy("DRON"); f.enemy("HTNK", 10); f.observe();
        expect(getEconomyBuildingPriority(f.game, f.player, f.basic, false, f.context)).toBe(70);
        expect(f.plan({ priority: 70, specificLocation: new Vector2(6, 0) })).toMatchObject({ signal: "D0", priority: 70, location: { rx: 6, ry: 0 } });
    });
    test("D1 remembers a short drone sighting and protects two real refineries, with a shared one-per-refinery slot", () => {
        const f = fixture(); f.own("NAREFN", 25); const drone = f.enemy("DRON"); f.observe(); f.hidden.add(drone.id);
        expect(f.plan()).toMatchObject({ signal: "D1", priority: 75, refineryId: f.refinery.id, location: { rx: 8, ry: 0 } });
        f.build(); f.at(452);
        expect(f.plan()).toMatchObject({ signal: "D1", location: { rx: 28, ry: 0 } });
        f.build(); f.at(904); expect(f.plan()).toBeUndefined();
        expect(getDefenseState(f.game, f.player.name).placed).toHaveLength(2);
    });
    test.each(["one", "149", "expired"])("D2 rejects %s damage history", reason => {
        const f = fixture(); f.observe(); f.at(30); f.miners[0].hitPoints = 950; f.observe();
        if (reason !== "one") { f.at(reason === "149" ? 179 : 180); f.miners[0].hitPoints = 900; f.observe(); }
        if (reason === "expired") f.at(1830);
        expect(f.plan()).toBeUndefined();
    });
    test("D2 accepts two own HP losses separated by 150 ticks and a real known miner loss", () => {
        const f = fixture(); f.observe(); f.at(30); f.miners[0].hitPoints = 950; f.observe();
        f.at(180); f.miners[0].hitPoints = 900; expect(f.plan()).toMatchObject({ signal: "D2", priority: 72 });
        const lost = fixture(); lost.observe();
        observeDefenseEvent(lost.game, lost.player.name, { type: ApiEventType.ObjectDestroy, target: lost.miners[0].id });
        lost.units.splice(lost.units.indexOf(lost.miners[0]), 1);
        expect(lost.plan()).toMatchObject({ signal: "D2" });
    });
    test("a paid own miner spawned and lost between HP scans is still a known D2 loss", () => {
        const f = fixture(), miner = f.own("HARV", 10);
        observeDefenseEvent(f.game, f.player.name, { type: ApiEventType.ObjectSpawn, target: miner.id });
        observeDefenseEvent(f.game, f.player.name, { type: ApiEventType.ObjectDestroy, target: miner.id });
        f.units.splice(f.units.indexOf(miner), 1);
        expect(f.plan()).toMatchObject({ signal: "D2" });
    });
    test("unspawn and an unknown enemy destroy do not fabricate D2 miner losses", () => {
        const f = fixture(); f.observe();
        observeDefenseEvent(f.game, f.player.name, { type: ApiEventType.ObjectUnspawn, target: f.miners[0].id });
        observeDefenseEvent(f.game, f.player.name, { type: ApiEventType.ObjectDestroy, target: 9999 });
        expect(f.plan()).toBeUndefined();
    });
    test("D3 uses the real mean threat direction and stops at two placed towers", () => {
        const f = fixture(); f.enemy("HTNK", 40); f.enemy("HTNK", 42);
        expect(f.plan()).toMatchObject({ signal: "D3", priority: 68, location: { rx: 6, ry: 0 } });
        f.build(); f.at(452); f.build(); f.at(904);
        expect(f.plan()).toBeUndefined();
        expect(getDefenseState(f.game, f.player.name).d3Ids.size).toBe(2);
    });
    test("D4 requires two visible aircraft or remembered airforce evidence and stops at two AA buildings", () => {
        const f = fixture(); f.enemy("ORCA", 100, ObjectType.Aircraft); expect(f.plan()).toBeUndefined();
        f.enemy("ORCA", 110, ObjectType.Aircraft); f.at(2);
        expect(f.plan()).toMatchObject({ signal: "D4", priority: 66, rules: { name: "NAFLAK" } });
        f.build(); f.at(454); f.build(); f.at(906); expect(f.plan()).toBeUndefined();
    });
    test.each(["GAAIRC", "AMRADR", "ZEP"])("D4 retains a visible %s sighting", name => {
        const f = fixture(), object = f.enemy(name, 100, name === "ZEP" ? ObjectType.Aircraft : ObjectType.Building);
        f.observe(); f.hidden.add(object.id); expect(f.plan()).toMatchObject({ signal: "D4" });
    });
    test.each([20, 21])("D5 uses the strict twenty-tile expansion boundary: %i", rx => {
        const f = fixture(); f.own("NAREFN", rx);
        expect(f.plan()?.signal).toBe(rx === 21 ? "D5" : undefined);
    });
    test("D5 rejects cash 1499 and pressure, accepts 1500, and shares D1's refinery slot", () => {
        const f = fixture(); f.own("NAREFN", 25); f.player.credits = 1499; expect(f.plan()).toBeUndefined();
        f.player.credits = 1500; f.at(2); expect(f.plan()).toMatchObject({ signal: "D5", priority: 42 });
        f.enemy("HTNK", 22); f.at(4); expect(f.plan()).toBeUndefined();
        f.enemies.length = 0; f.at(6); f.build(); f.at(458); f.enemy("DRON");
        expect(f.plan()?.refineryId).toBe(f.refinery.id); // Only the unprotected home refinery needs D1.
    });
    test("six basic towers cap all signals; classified crawl towers do not use this cap", () => {
        const f = fixture(); const towers = Array.from({ length: 6 }, (_, i) => f.own("NALASR", 60 + i * 2)); f.enemy("DRON");
        expect(f.plan()).toBeUndefined();
        getBaseCrawlState(f.game, f.player.name).defenseIds.add(towers[0].id); // Classified actual-ID fixture; production is tested in EconomyExpand.
        expect(f.plan()).toMatchObject({ signal: "D1" });
    });
    test("cash below 600 rejects every request and starts, not proposals, consume the 450-tick cooldown", () => {
        const f = fixture(); f.enemy("DRON"); f.player.credits = 599; expect(f.plan()).toBeUndefined();
        f.player.credits = 600; f.at(2); expect(f.plan()).toBeDefined();
        expect(getDefenseState(f.game, f.player.name).lastStartTick).toBe(-Infinity);
        f.build(); const started = getDefenseState(f.game, f.player.name).lastStartTick;
        f.at(started + 449); expect(canRequestDefense(f.game, f.player, "NAFLAK")).toBe(false);
        f.at(started + 450); expect(canRequestDefense(f.game, f.player, "NAFLAK")).toBe(true);
    });
    test("a nearest legal site nine tiles from the desired point is rejected", () => {
        const f = fixture(); f.enemy("DRON"); f.candidates.splice(0, f.candidates.length, { id: "17_0", rx: 17, ry: 0 });
        expect(f.plan()).toBeUndefined();
    });
    test("DRON funds one repair depot at 1500 without the historical 10000 floating-cash gate", () => {
        const f = fixture(); f.enemy("DRON"); f.observe(); f.player.credits = 1499;
        expect(getEconomyBuildingPriority(f.game, f.player, f.depot, false, f.context)).toBe(0);
        f.player.credits = 1500; f.at(2);
        expect(getEconomyBuildingPriority(f.game, f.player, f.depot, false, f.context)).toBe(65);
        expect(new BaseBuildingMission(QueueType.Structures, () => {})._onAiUpdate(f.context)).toMatchObject({ rulesName: "NADEPT", priority: 65 });
        f.own("NADEPT"); f.at(4); expect(getEconomyBuildingPriority(f.game, f.player, f.depot, false, f.context)).toBe(0);
        const quiet = fixture(); expect(getEconomyBuildingPriority(quiet.game, quiet.player, quiet.depot, false, quiet.context)).toBe(0);
        expect(hasSeenEnemyDrone(quiet.game, quiet.player.name)).toBe(false);
    });
    test("existing mission sampling reports triggers and real starts/placement separately, without mutating old samples", () => {
        const f = fixture(), mission = new BaseBuildingMission(QueueType.Armory, () => {}); mission._onAiUpdate(f.context);
        const before = mission.getState()!; f.enemy("DRON"); f.plan();
        expect(before.defenseTriggers).toEqual([]);
        expect(mission.getState()).toMatchObject({ defenseTriggers: ["D1"], defenseStarted: [], defensePlaced: [] });
        f.build(); expect(mission.getState()!.defenseStarted).toHaveLength(1); expect(mission.getState()!.defensePlaced).toHaveLength(1);
    });
    test("invisible enemy private HP and hidden resource values never enter defense decisions", () => {
        const f = fixture(), hidden = f.enemy("DRON"); f.hidden.add(hidden.id);
        Object.defineProperty(hidden, "rules", { get() { throw Error("hidden rules"); } });
        const aircraft = f.enemy("ORCA", 100, ObjectType.Aircraft);
        Object.defineProperty(aircraft, "hitPoints", { get() { throw Error("private enemy HP"); } });
        expect(f.plan()).toBeUndefined();
    });
    test.each(["normal", "eco-only"])("%s has no new defense requests", profile => {
        const f = fixture(); f.enemy("DRON"); const previous = BRUTAL_PARAMS.economy.ecoOnly;
        if (profile === "normal") f.context.difficulty = "normal"; else BRUTAL_PARAMS.economy.ecoOnly = 1;
        try { expect(f.plan()).toBeUndefined(); } finally { BRUTAL_PARAMS.economy.ecoOnly = previous; }
    });
});

describe("repair intent survives other command controllers", () => {
    test.each(["brutal", "normal", "eco-only"])("%s invokes repair before mission commands only when enabled", profile => {
        const f = fixture(), trace: string[] = [], previous = BRUTAL_PARAMS.economy.ecoOnly;
        const bot: any = new BuiltInBot("bot", Countries.RUSSIA, [], false, undefined, profile === "normal" ? "normal" : "brutal");
        bot.setGameApi(f.game); bot.setActionsApi(f.actions); bot.setProductionApi(f.context.player.production);
        bot.tickRatio = 2; bot.tryInitialMcvDeploy = () => {};
        bot.parasiteRepair = { onAiUpdate: () => trace.push("repair"), isRepairing: () => false };
        bot.matchAwareness = { onAiUpdate() {}, getThreatCache: () => null };
        bot.missionController = { onAiUpdate: () => trace.push("mission"), getRequestedUnitTypes: () => new Map() };
        bot.strategy = { onAiUpdate() { trace.push("strategy"); return bot.strategy; } };
        bot.queueController = { onAiUpdate: () => trace.push("queue") };
        if (profile === "eco-only") BRUTAL_PARAMS.economy.ecoOnly = 1;
        try { f.at(2); bot.onGameTick(f.game); } finally { BRUTAL_PARAMS.economy.ecoOnly = previous; }
        expect(trace).toEqual(profile === "brutal" ? ["repair", "mission", "strategy", "queue"] : ["mission", "strategy", "queue"]);
    });
    test("miner gather/safety/crush logic never overwrites a protected Dock intent", () => {
        const f = fixture(), miner = f.miners[0]; miner.tile.rx = 5; f.resources[1].gems = 4000;
        f.context.parasiteRepair = { isRepairing: (id: number) => id === miner.id };
        new MinerDefence().onAiUpdate(f.context);
        expect(f.actions.orderUnits.mock.calls.every(call => !(call[0] as any).includes(miner.id))).toBe(true);
    });
    test("combat keeps a repairing tank in its force count without issuing it any command", () => {
        const f = fixture(), tank = f.own("HTNK", 10), batcher = new ActionBatcher();
        f.game.rulesApi = { vehicleRules: new Map([[tank.name, tank.rules]]), aircraftRules: new Map(), buildingRules: new Map(), infantryRules: new Map() };
        class Army extends Mission { _onAiUpdate() { return noop(); } getPriority() { return 1; } getGlobalDebugText() { return undefined; } }
        const army = new Army("repair-force", () => {}); army.addUnit(tank.id);
        f.context.parasiteRepair = { isRepairing: (id: number) => id === tank.id };
        const squad = new CombatSquad(new Vector2(), new Vector2(100, 0), 12);
        squad.onAiUpdate({ ...f.context, actionBatcher: batcher }, army, () => {}); batcher.resolve(f.actions as any, f.game.mapApi);
        expect(army.getUnitIds()).toEqual([tank.id]); expect(f.actions.orderUnits).not.toHaveBeenCalled();
    });
});

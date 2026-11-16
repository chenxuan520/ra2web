import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { BuildStatus } from "../../game/gameobject/Building";
import { MovementZone, ObjectType, QueueStatus, QueueType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { DefaultStrategy } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/defaultStrategy";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";
import { QueueController, QUEUES } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController";
import { readPressure, setPressureWatchPost } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/pressure";
import { getDefenseState, observeDefense, planDefense, recordDefenseOrder } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/defensePlan";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { FieldArmyMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/fieldArmyMission";
import { BaseReserveMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseReserveMission";
import { InfantryHomeMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/infantryHomeMission";

// B2 mp08t2/3001/Russians:Americans/false is completely standard-match equal to D1.
// Its4210/4500 public rush and repeated E2=95 requests motivate these normalized
// fixtures. These test decisions/allocation, not native combat or whole-game wins.
function fixture(country = "Russians", initialTick = 4500, miners = 1, core = 1) {
    let tick = initialTick, nextId = 1;
    const soviet = country === "Russians", footName = soviet ? "E2" : "E1";
    const tankName = soviet ? "HTNK" : "MTNK", minerName = soviet ? "HARV" : "CMIN";
    const basicName = soviet ? "NALASR" : "GAPILL", aaName = soviet ? "HTK" : "FV";
    const owned: any[] = [], enemies: any[] = [], hidden = new Set<number>();
    const player: any = { name: "bot", country: { name: country, side: soviet ? 1 : 0 }, startLocation: new Vector2(),
        credits: 5000, power: { total: 300, drain: 0, isLowPower: false }, isAi: true, isCombatant: true };
    function own(name: string, rx = 0, ry = 0) {
        const infantry = ["E1", "E2"].includes(name), vehicle = ["HARV", "CMIN", "HTNK", "MTNK"].includes(name);
        const type = infantry ? ObjectType.Infantry : vehicle ? ObjectType.Vehicle : ObjectType.Building;
        const rules = { name, type, movementZone: MovementZone.Normal, strength: 100,
            harvester: ["HARV", "CMIN"].includes(name), refinery: ["NAREFN", "GAREFN"].includes(name),
            weaponsFactory: ["NAWEAP", "GAWEAP"].includes(name), constructionYard: ["NACNST", "GACNST"].includes(name),
            isSelectableCombatant: infantry || ["HTNK", "MTNK"].includes(name), baseNormal: type === ObjectType.Building };
        const hp = infantry ? 125 : 1000;
        const unit = { id: nextId++, name, owner: "bot", type, rules, tile: { rx, ry },
            hitPoints: hp, maxHitPoints: hp, foundation: { width: 1, height: 1 }, buildStatus: BuildStatus.Ready,
            isWarpedOut: false, zone: ZoneType.Ground, isIdle: true, canMove: true };
        owned.push(unit); return unit;
    }
    own(soviet ? "NACNST" : "GACNST"); own(soviet ? "NAWEAP" : "GAWEAP", 2); own(soviet ? "NAREFN" : "GAREFN", 5);
    for (let i = 0; i < miners; i++) own(minerName, 5);
    for (let i = 0; i < core; i++) own(tankName);
    const available = new Map(QUEUES.map(type => [type, [] as any[]]));
    available.set(QueueType.Vehicles, [{ name: tankName, type: ObjectType.Vehicle, cost: soviet ? 900 : 700 },
        { name: aaName, type: ObjectType.Vehicle, cost: 500 }, { name: minerName, type: ObjectType.Vehicle, cost: 1400, harvester: true }]);
    available.set(QueueType.Infantry, [{ name: footName, type: ObjectType.Infantry, cost: soviet ? 100 : 200 }]);
    const basic: any = { name: basicName, type: ObjectType.Building, baseNormal: false, adjacent: 100, cost: 500 };
    available.set(QueueType.Armory, [basic]);
    const queues = new Map(QUEUES.map(type => [type, { type, status: QueueStatus.Idle, items: [] as any[], size: 0 }]));
    const actions = { queueForProduction: mock((_queue: QueueType, _name: string, _type: ObjectType, _quantity: number) => {}),
        unqueueFromProduction: mock(() => {}), pauseProduction: mock(() => {}), resumeProduction: mock(() => {}),
        placeBuilding: mock(() => {}), toggleRepairWrench: mock(() => {}), sellBuilding: mock(() => {}),
        setUnitDebugText: mock(() => {}), orderUnits: mock(() => {}) };
    const production: any = { getAvailableObjects: (type?: QueueType) => type === undefined ? [...available.values()].flat() : available.get(type)!,
        getQueueData: (type: QueueType) => queues.get(type)! };
    const candidates = Array.from({ length: 101 }, (_, i) => ({ id: `${i - 50}_0`, rx: i - 50, ry: 0 }));
    const game: any = { getCurrentTick: () => tick, getPlayers: () => ["bot", "enemy"], areAlliedPlayers: () => false,
        getPlayerData: (name: string) => name === "bot" ? player : { name, isCombatant: true },
        generateRandomInt: mock(() => 0),
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "self" ? owned : enemies).filter(unit => !hidden.has(unit.id) && predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => {
            if (hidden.has(id)) throw Error("hidden unit lookup");
            return [...owned, ...enemies].find(unit => unit.id === id);
        },
        getGameObjectData: (id: number) => game.getUnitData(id),
        getBuildingPlacementData: () => ({ foundation: { width: 1, height: 1 } }),
        canPlaceBuilding: (_player: string, _name: string, tile: any) =>
            !owned.some(unit => unit.type === ObjectType.Building && unit.tile.rx === tile.rx && unit.tile.ry === tile.ry),
        getGeneralRules: () => ({ baseUnit: ["SMCV", "AMCV"] }),
        rulesApi: { vehicleRules: new Map(), infantryRules: new Map(), aircraftRules: new Map(), buildingRules: new Map() },
        mapApi: { getStartingLocations: () => [player.startLocation, new Vector2(200, 0)], getRealMapSize: () => ({ width: 80, height: 80 }),
            getTile: (rx: number, ry: number) => ({ rx, ry }), isVisibleTile: () => true,
            getAllTilesResourceData: () => [5, 25].map(rx => ({ tile: { rx, ry: 0 }, ore: 8000, gems: 0 })),
            getResourceCreditValues: () => ({ ore: 1, gems: 2 }), getTileResourceData: () => undefined,
            findPath: (_speed: any, _start: any, end: any) => [end],
            getTilesInRect: (rect: any) => candidates.filter(tile => tile.rx >= rect.x && tile.rx < rect.x + rect.width && tile.ry >= rect.y && tile.ry < rect.y + rect.height) } };
    const threat: any = { totalOffensiveAirThreat: 0, totalAvailableAntiAirFirepower: 0 };
    const context: any = { game, difficulty: "brutal", player: { name: "bot", actions, production },
        matchAwareness: { getThreatCache: () => threat, getNextExpansionCandidates: () => [],
            getMainRallyPoint: () => new Vector2(10, 0), getHostilesNearPoint: () => [] } };
    const missions = new MissionController(() => {}), strategy = new DefaultStrategy(), controller = new QueueController();
    const requests = new Map<string, any>([[tankName, { priority: 75, specificLocation: null }]]);
    function enemy(name = "E1", rx = 40, type = ObjectType.Infantry, extra = {}) {
        const unit = { id: 500 + enemies.length, name, owner: "enemy", type, tile: { rx, ry: 0 },
            rules: { name, type, movementZone: MovementZone.Normal, isSelectableCombatant: true,
                harvester: false, primary: type === ObjectType.Infantry ? "M60" : "105mm", ...extra } };
        enemies.push(unit); return unit;
    }
    return { game, context, player, owned, enemies, hidden, available, queues, actions, production, basic, basicName,
        tankName, minerName, footName, aaName, own, enemy, missions, requests, threat,
        at(value: number) { tick = value; },
        rush() { for (let i = 0; i < 3; i++) enemy(); },
        plan() { return (strategy as any).selectRandomAttackComposition(context, () => {}, missions); },
        run(regrouping = false) { controller.onAiUpdate(context, null, requests, () => {}, regrouping); },
        priority(name: string) { return Number(controller.getGlobalDebugText(game, production).match(new RegExp(`${name}\\(([^)]+)\\)`))?.[1] ?? 0); } };
}

function inertSquad() {
    return { setAirSafety() {}, setDefensiveRadius() {}, setAttackArea() {}, onAiUpdate() {}, getGlobalDebugText: () => "fixture" };
}

let previousEconomy: typeof BRUTAL_PARAMS.economy;
beforeEach(() => {
    previousEconomy = { ...BRUTAL_PARAMS.economy };
    Object.assign(BRUTAL_PARAMS.economy, { ecoOnly: 0, openingDefense: 0, openingMinerFirst: 1, openingRaid: 1 });
});
afterEach(() => { Object.assign(BRUTAL_PARAMS.economy, previousEconomy); });

describe("B3 visible rush temporarily overrides rigid opening choices", () => {
    test.each(["Russians", "Americans"])("%s responds to the existing public rush signal with its available armored screen", country => {
        const f = fixture(country); f.rush();
        expect(readPressure(f.context).earlyPressure).toBe(true);
        expect(f.plan()).toMatchObject({ composition: { [f.tankName]: 5, [f.aaName]: 1 }, minimumUnits: 4 });
        expect(f.plan().composition[f.footName]).toBeUndefined();
        expect(f.game.generateRandomInt).not.toHaveBeenCalled();
    });
    test.each(["Russians", "Americans"])("%s permits a paid D3 tower during rush without changing openingDefense=0", country => {
        const f = fixture(country); f.rush(); f.run();
        expect(f.priority(f.basicName)).toBe(68);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Armory, f.basicName, ObjectType.Building, 1);
        expect(BRUTAL_PARAMS.economy.openingDefense).toBe(0);
    });
    test("a public P1 warning outside the home radius also reaches the strategy, not just the pressure detector", () => {
        const f = fixture(); f.enemy("MTNK", 92, ObjectType.Vehicle);
        setPressureWatchPost(f.game, "bot", { rx: 80, ry: 0 });
        expect(readPressure(f.context)).toMatchObject({ earlyPressure: true, baseUnderSiege: false });
        expect(f.plan().composition.HTNK).toBe(5);
    });
    test("a one-tank Allied reserve no longer launches another paid pure-infantry strike into an approaching column", () => {
        const f = fixture("Americans"); f.rush(); f.enemy("HTNK", 40, ObjectType.Vehicle);
        const army = new FieldArmyMission(f.plan(), f.missions, () => {}); Object.assign(army, { squad: inertSquad() });
        f.missions.addMission(army);
        for (let i = 0; i < 8; i++) army.addUnit(f.own("E1").id);
        army.addUnit(f.owned.find(unit => unit.name === "MTNK").id);
        const result: any = army.onAiUpdate(f.context);
        expect(army.isAttacking()).toBe(false);
        expect(result.unitNameToPriority?.E1).toBeUndefined();
        expect(army.getAttackArea().distanceTo(new Vector2())).toBeLessThanOrEqual(4);
    });
    test("the Soviet mode switch returns paid conscripts to existing home control without borrowing locked reserves", () => {
        const f = fixture(), reserve = new BaseReserveMission(() => {}), home = new InfantryHomeMission(f.missions, () => {});
        const army = new FieldArmyMission(f.plan(), f.missions, () => {});
        for (const mission of [reserve, home, army]) { Object.assign(mission, { squad: inertSquad() }); f.missions.addMission(mission); }
        const reserveIds = [f.own("E2").id, f.own("E2").id], homeId = f.own("E2").id;
        reserveIds.forEach(id => reserve.addUnit(id)); home.addUnit(homeId);
        for (let i = 0; i < 8; i++) army.addUnit(f.own("E2").id);
        army.addUnit(f.owned.find(unit => unit.name === "HTNK").id);
        f.missions.onAiUpdate(f.context); expect(army.isAttacking()).toBe(true);
        f.rush(); f.at(4502); army.setPlan(f.plan()); f.missions.onAiUpdate(f.context);
        f.at(4504); f.missions.onAiUpdate(f.context);
        expect(army.getUnitsOfTypes(f.game, "E2")).toHaveLength(0);
        expect(army.isAttacking()).toBe(false);
        expect(reserve.getUnitIds()).toEqual(reserveIds); expect(home.getUnitIds()).toContain(homeId);
        expect(home.isUnitsLocked()).toBe(true);
        expect(f.missions.getRequestedUnitTypes().get("E2")?.priority ?? 0).toBeLessThan(95);
    });
    test("the rush override survives temporary fog rather than resuming the infantry opening on the next update", () => {
        const f = fixture(); f.rush(); expect(readPressure(f.context).earlyPressureUntil).toBe(7200);
        f.enemies.length = 0; f.at(5000);
        expect(readPressure(f.context).earlyPressure).toBe(true);
        expect(f.plan().composition.HTNK).toBe(5);
    });
    test("mixed visible air and ground pressure chooses the existing AA composition and still funds HTK115", () => {
        const f = fixture("Russians", 4500, 2, 4); f.rush(); f.enemy("ORCA", 100, ObjectType.Aircraft);
        f.threat.totalOffensiveAirThreat = 10;
        expect(f.plan()).toMatchObject({ composition: { HTNK: 3, HTK: 3 }, minimumUnits: 4 });
        f.run(true); expect(f.priority("HTK")).toBe(115);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HTK", ObjectType.Vehicle, 1);
    });
    test("rush cannot invent a core prerequisite when the factory has no available armored composition", () => {
        const f = fixture(); f.available.set(QueueType.Vehicles, []); f.rush();
        expect(f.plan()).toBeNull();
    });
});

describe("B3 exits defence through existing windows and preserves spending controls", () => {
    test("once rush and the real2700 quiet window end, original110 income takes over without a permanent defensive mode", () => {
        const f = fixture("Russians", 4500, 2, 4); f.rush(); f.run(true);
        expect(f.priority("HTNK")).toBe(100); expect(f.priority("HARV")).toBe(0);
        f.enemies.length = 0; f.at(7199); expect(readPressure(f.context)).toMatchObject({ earlyPressure: true, homeQuiet: false });
        f.actions.queueForProduction.mockClear(); f.at(7200); f.run(true);
        expect(readPressure(f.context)).toMatchObject({ earlyPressure: false, homeQuiet: true });
        expect(f.priority("HARV")).toBe(110);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HARV", ObjectType.Vehicle, 1);
        expect(f.plan().composition.E2).toBeUndefined();
    });
    test.each([QueueStatus.Active, QueueStatus.OnHold, QueueStatus.Ready])("a paid D3 keeps its original site/priority after the warning expires, status%i", status => {
        const f = fixture(); f.rush(); const plan = planDefense(f.context)!;
        expect(plan.signal).toBe("D3");
        recordDefenseOrder(f.game, "bot", plan.rules.name, new Vector2(plan.location.rx, plan.location.ry));
        const queue = f.queues.get(QueueType.Armory)!;
        Object.assign(queue, { status: QueueStatus.Active, size: 1, items: [{ rules: plan.rules, quantity: 1, progress: .7 }] });
        f.at(4502); observeDefense(f.context); queue.status = status;
        f.enemies.length = 0; f.at(7200); f.run();
        expect(f.priority(f.basicName)).toBe(68);
        expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
        expect(f.actions.queueForProduction).not.toHaveBeenCalledWith(QueueType.Armory, f.basicName, ObjectType.Building, 1);
        if (status === QueueStatus.Ready) expect(f.actions.placeBuilding).toHaveBeenCalledWith(plan.rules.name, plan.location.rx, plan.location.ry);
    });
    test.each(["quiet", "remote-infantry", "scout-dog", "engineers", "enemy-miner", "two-infantry", "hidden", "aircraft"])('%s does not activate the new rush override', condition => {
        const f = fixture();
        if (condition === "remote-infantry") for (let i = 0; i < 3; i++) f.enemy("E1", 100);
        if (condition === "scout-dog") f.enemy("ADOG", 10);
        if (condition === "engineers") for (let i = 0; i < 3; i++) f.enemy("ENGINEER", 40, ObjectType.Infantry, { engineer: true });
        if (condition === "enemy-miner") f.enemy("CMIN", 40, ObjectType.Vehicle, { harvester: true });
        if (condition === "two-infantry") for (let i = 0; i < 2; i++) f.enemy();
        if (condition === "aircraft") f.enemy("ORCA", 40, ObjectType.Aircraft);
        if (condition === "hidden") {
            const unit = f.enemy("MTNK", 40, ObjectType.Vehicle); f.hidden.add(unit.id);
            Object.defineProperty(unit, "tile", { get() { throw Error("hidden strategy input"); } });
        }
        expect(readPressure(f.context).earlyPressure).toBe(false);
        expect(f.plan()).toMatchObject({ composition: { E2: 1 }, minimumUnits: 8, maximumUnits: 16 });
        f.run(); expect(f.priority(f.basicName)).toBe(0);
    });
    test.each([[5399, true], [5400, false]] as const)("the original first-sighting boundary at%i is unchanged", (tick, eligible) => {
        const f = fixture("Russians", tick); f.rush();
        expect(readPressure(f.context).earlyPressure).toBe(eligible);
        expect(f.plan().minimumUnits).toBe(eligible ? 4 : 8);
    });
    test("cash599, four basic towers and the450 cooldown still block new defensive spending", () => {
        const cash = fixture(); cash.rush(); cash.player.credits = 599; cash.run(); expect(cash.priority(cash.basicName)).toBe(0);
        const capped = fixture(); capped.rush(); for (let i = 0; i < 4; i++) capped.own(capped.basicName, 60 + i); capped.run();
        expect(capped.priority(capped.basicName)).toBe(0);
        const cooling = fixture(); cooling.rush(); Object.assign(getDefenseState(cooling.game, "bot"), { lastStartTick: 4499 }); cooling.run();
        expect(cooling.priority(cooling.basicName)).toBe(0);
    });
    test("Normal keeps random composition selection and never queries a new enemy pressure input", () => {
        const f = fixture(); f.context.difficulty = "normal"; f.rush();
        const getVisible = f.game.getVisibleUnits;
        f.game.getVisibleUnits = (name: string, relation: string, predicate: any) => {
            if (relation === "enemy") throw Error("Normal must not add rush observation");
            return getVisible(name, relation, predicate);
        };
        expect(f.plan()).toMatchObject({ composition: { E2: 1 }, minimumUnits: 3, maximumUnits: 10 });
        expect(f.game.generateRandomInt).toHaveBeenCalledTimes(1);
    });
    test("ecoOnly and recovery of the last miner do not acquire the new military expense", () => {
        const eco = fixture(); eco.rush(); BRUTAL_PARAMS.economy.ecoOnly = 1; eco.run(true);
        expect(eco.priority(eco.basicName)).toBe(0); expect(eco.priority(eco.tankName)).toBe(0);
        BRUTAL_PARAMS.economy.ecoOnly = 0;
        const recovery = fixture("Russians", 4500, 0, 0); recovery.rush(); recovery.run();
        expect(recovery.priority("HARV")).toBe(120);
        expect(recovery.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HARV", ObjectType.Vehicle, 1);
    });
    test("visible opposing exact HP and credits never become strategy inputs", () => {
        const f = fixture(); f.rush();
        for (const unit of f.enemies) Object.defineProperty(unit, "hitPoints", { get() { throw Error("private enemy health"); } });
        const getPlayer = f.game.getPlayerData;
        f.game.getPlayerData = (name: string) => {
            const value = getPlayer(name);
            if (name !== "bot") Object.defineProperty(value, "credits", { get() { throw Error("private enemy economy"); } });
            return value;
        };
        expect(f.plan().composition.HTNK).toBe(5);
    });
});

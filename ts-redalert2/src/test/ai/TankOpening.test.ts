import { expect, mock, test } from "bun:test";
import { ObjectType, QueueStatus, QueueType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";
import { DEFAULT_COMPOSITIONS, DefaultStrategy } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/defaultStrategy";
import { FieldArmyMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/fieldArmyMission";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { BaseBuildingMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseBuildingMission";
import { getEconomyBuildingPriority } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/economyPlan";
import { QueueController, QUEUES } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController";

function withOpening(enabled: number, run: () => void) {
    const params = BRUTAL_PARAMS.assault as Record<string, number>;
    const previous = params.tankOpening;
    Object.assign(params, { tankOpening: enabled });
    try { run(); } finally {
        if (previous === undefined) delete params.tankOpening;
        else params.tankOpening = previous;
    }
}

function fixture(country = "Russians", factory = true) {
    let tick = 3000;
    const soviet = country === "Russians", footName = soviet ? "E2" : "E1";
    const foot: any = { name: footName, type: ObjectType.Infantry, isSelectableCombatant: true };
    const units = new Map<number, any>(Array.from({ length: 8 }, (_, index) => [index + 1, {
        id: index + 1, name: footName, owner: "bot", rules: foot, type: ObjectType.Infantry,
        tile: { rx: 0, ry: index % 2 }, hitPoints: 100, maxHitPoints: 100, zone: ZoneType.Ground,
    }]));
    const add = (id: number, name: string, rules: any) => units.set(id, { id, name, owner: "bot", rules: { name, ...rules }, tile: { rx: 0, ry: 0 } });
    add(100, soviet ? "HARV" : "CMIN", { harvester: true });
    if (factory) add(101, soviet ? "NAWEAP" : "GAWEAP", { weaponsFactory: true });
    add(102, soviet ? "NACNST" : "GACNST", { constructionYard: true });
    add(103, soviet ? "NAREFN" : "GAREFN", { refinery: true });
    const enemies: any[] = [], available: any[] = [foot];
    if (factory) available.push({ name: soviet ? "HTNK" : "MTNK" }, { name: soviet ? "HTK" : "FV" }, { name: "JUMPJET" });
    const player: any = { name: "bot", country: { name: country, side: soviet ? 1 : 0 }, credits: 5000, startLocation: new Vector2() };
    const game: any = { getCurrentTick: () => tick, generateRandomInt: mock(() => 0),
        getPlayerData: (name: string) => name === "bot" ? player : { name, isCombatant: true },
        getPlayers: () => ["bot", "enemy"], areAlliedPlayers: () => false,
        getVisibleUnits: (_name: string, relation: string, filter = (_: any) => true) =>
            (relation === "enemy" ? enemies : [...units.values()]).filter(unit => filter(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => units.get(id) ?? enemies.find(unit => unit.id === id), getGameObjectData: (id: number) => units.get(id),
        mapApi: { getStartingLocations: () => [new Vector2(), new Vector2(80, 0)], getRealMapSize: () => ({ width: 80, height: 80 }),
            getTile: (rx: number, ry: number) => ({ rx, ry, z: 0 }), isVisibleTile: () => false },
    };
    const controller = new MissionController(() => {}), strategy = new DefaultStrategy();
    const context: any = { difficulty: "brutal", game, player: { name: "bot", production: { getAvailableObjects: () => available } },
        matchAwareness: { getMainRallyPoint: () => new Vector2(4, 0), getThreatCache: () => null } };
    return { units, enemies, available, player, game, context, controller, at(value: number) { tick = value; },
        plan: () => (strategy as any).selectRandomAttackComposition(context, () => {}, controller) };
}

function production(name: string, difficulty = "brutal", status = QueueStatus.Idle) {
    const rule: any = { name, cost: name === "E1" ? 200 : name === "DOG" ? 200 : 100, type: ObjectType.Infantry };
    const owned = [{ name: "NAWEAP", weaponsFactory: true }, { name: "NAREFN", refinery: true }, { name: "HARV", harvester: true }];
    const queues = new Map(QUEUES.map(type => [type, { type, status: type === QueueType.Infantry ? status : QueueStatus.Idle,
        items: type === QueueType.Infantry && status !== QueueStatus.Idle ? [{ rules: rule, quantity: 1 }] : [], size: 0 }]));
    const requests = new Map([[name, { priority: 95, specificLocation: null }]]);
    const actions = { queueForProduction: mock(() => {}), unqueueFromProduction: mock(() => {}), pauseProduction: mock(() => {}), resumeProduction: mock(() => {}) };
    const context: any = { difficulty, player: { name: "bot", actions, production: {
        getAvailableObjects: (type: number) => type === QueueType.Infantry ? [rule] : [], getQueueData: (type: number) => queues.get(type) } },
        game: { getCurrentTick: () => 3000, getPlayerData: () => ({ name: "bot", country: { name: "Russians" }, credits: 5000, startLocation: new Vector2() }),
            getVisibleUnits: (_name: string, relation: string, filter = (_: any) => true) => (relation === "enemy" ? [] : owned).filter(filter).map((_, id) => id) } };
    return { actions, requests, context, run: () => new QueueController().onAiUpdate(context, null, requests, () => {}) };
}

test("F4 off keeps the legacy Soviet and allied infantry opening", () => withOpening(0, () => {
    expect(fixture().plan()).toMatchObject({ composition: { E2: 1 }, minimumUnits: 8, maximumUnits: 16 });
    expect(fixture("Americans").plan()).toMatchObject({ composition: { E1: 1 }, minimumUnits: 8, maximumUnits: 12 });
}));
test.each(["Russians", "Americans"])("F4 on selects an available ground tank core for %s, not infantry or air", country => withOpening(1, () => {
    expect(fixture(country).plan()).toEqual(country === "Russians" ? DEFAULT_COMPOSITIONS.sovietTanks : DEFAULT_COMPOSITIONS.alliedTanks);
}));
test("F4 on waits for a real factory instead of ordering an unavailable tank or infantry wave", () => withOpening(1, () => {
    expect(fixture("Russians", false).plan()).toBeNull();
    expect(fixture("Americans", false).plan()).toBeNull();
}));
test("F4 does not override the no-income policy, later composition or Normal RNG", () => {
    for (const kind of ["no-income", "late", "normal"]) {
        const f = fixture();
        if (kind === "no-income") f.units.delete(100);
        if (kind === "late") f.at(7000);
        if (kind === "normal") f.context.difficulty = "normal";
        let old: any;
        withOpening(0, () => { old = f.plan(); });
        withOpening(1, () => { expect(f.plan()).toEqual(old); });
        if (kind === "normal") expect(f.game.generateRandomInt.mock.calls).toHaveLength(2);
    }
});
test("F4 does not launch existing conscripts alone or destroy them", () => withOpening(1, () => {
    const f = fixture(), army = new FieldArmyMission(f.plan(), f.controller, () => {});
    Object.assign(army, { squad: { setAirSafety() {}, setAttackArea() {}, setDefensiveRadius() {}, onAiUpdate() {} } });
    for (let id = 1; id <= 8; id++) army.addUnit(id);
    expect(army.onAiUpdate(f.context)).toEqual({ type: "releaseUnits", unitIds: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(army.isAttacking()).toBe(false);
    expect([...f.units.values()].filter(unit => unit.name === "E2")).toHaveLength(8);
}));
test.each(["E1", "E2"])("F4 blocks new paid %s even at opening priority, but preserves off and Normal", name => {
    withOpening(0, () => { const f = production(name); f.run(); expect(f.actions.queueForProduction).toHaveBeenCalledTimes(1); });
    withOpening(1, () => {
        const f = production(name); f.run(); expect(f.actions.queueForProduction).not.toHaveBeenCalled();
        expect(f.requests.has(name)).toBe(true); // Do not mutate mission requests.
        f.context.game.getCurrentTick = () => 9000; f.run(); expect(f.actions.queueForProduction).not.toHaveBeenCalled();
        const normal = production(name, "normal"); normal.run(); expect(normal.actions.queueForProduction).toHaveBeenCalledTimes(1);
    });
});
test("F4 still admits dogs and engineers and does not cancel an active paid basic infantry item", () => withOpening(1, () => {
    for (const name of ["DOG", "ENGINEER"]) { const f = production(name); f.run(); expect(f.actions.queueForProduction).toHaveBeenCalledTimes(1); }
    const paid = production("E2", "brutal", QueueStatus.Active); paid.run();
    expect(paid.actions.queueForProduction).not.toHaveBeenCalled();
    expect(paid.actions.unqueueFromProduction).not.toHaveBeenCalled();
    expect(paid.actions.pauseProduction).not.toHaveBeenCalled();
}));
test("F4 prioritizes the first factory after income but not before income, after its deadline or in Normal", () => {
    const f = fixture("Americans", false), rules: any = { name: "GAWEAP", cost: 2000, type: ObjectType.Building };
    withOpening(0, () => expect(getEconomyBuildingPriority(f.game, f.player, rules, false)).toBe(30));
    withOpening(1, () => expect(getEconomyBuildingPriority(f.game, f.player, rules, false)).toBe(60));
    f.at(7000); withOpening(1, () => expect(getEconomyBuildingPriority(f.game, f.player, rules, false)).toBe(30));
    const noIncome = fixture("Americans", false); noIncome.units.delete(103);
    withOpening(1, () => expect(getEconomyBuildingPriority(noIncome.game, noIncome.player, rules, false)).toBe(0));
    f.at(3000);
    const normal = new BaseBuildingMission(QueueType.Structures, () => {});
    let prior: any;
    withOpening(0, () => { prior = (normal as any).getPriorityForBuildingOption(rules, f.game, f.player, null, "normal"); });
    withOpening(1, () => expect((normal as any).getPriorityForBuildingOption(rules, f.game, f.player, null, "normal")).toBe(prior));
});
test("F4 preserves bounded reactive machineguns: no spam, real intruders and real cash required", () => withOpening(1, () => {
    for (const name of ["GAPILL", "NALASR"]) {
        const f = fixture();
        const rules: any = { name, cost: 500, type: ObjectType.Building };
        const priority = () => getEconomyBuildingPriority(f.game, f.player, rules, false);
        expect(priority()).toBe(0);
        for (const id of [201, 202]) f.enemies.push({ id, owner: "enemy", tile: { rx: 10, ry: 0 }, rules: { name: "E2", type: ObjectType.Infantry, isSelectableCombatant: true } });
        f.at(3001); expect(priority()).toBe(70);
        const poor = fixture(); poor.enemies.push(...f.enemies); poor.player.credits = 999;
        expect(getEconomyBuildingPriority(poor.game, poor.player, rules, false)).toBe(0);
        const capped = fixture(); capped.enemies.push(...f.enemies); capped.units.set(300, { id: 300, rules, tile: { rx: 1, ry: 0 } });
        expect(getEconomyBuildingPriority(capped.game, capped.player, rules, false)).toBe(0);
    }
}));

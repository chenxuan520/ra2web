import { describe, expect, mock, test } from "bun:test";
import { BuildStatus } from "../../game/gameobject/Building";
import { MovementZone, ObjectType, QueueStatus, QueueType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { QueueController, QUEUES } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";
import { readPressure, setPressureWatchPost } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/pressure";

// D3 Normal AA/false4080 has ten public GI, one own tank/miner, four actually
// firing own GI and a paid CMIN at584/1400. These normalized public fixtures
// reproduce arbitration, not engine combat, actual refunds or guaranteed wins.
function fixture({ country = "Americans", tick = 4080, miners = 1, core = 1, enemies = 10, firing = true, refineries = 1 } = {}) {
    let now = tick, id = 1;
    const soviet = country === "Russians", tank = soviet ? "HTNK" : "MTNK", miner = soviet ? "HARV" : "CMIN", foot = soviet ? "E2" : "E1";
    const owned: any[] = [], hostile: any[] = [], hidden = new Set<number>();
    const player: any = { name: "bot", country: { name: country }, startLocation: new Vector2(), credits: 716,
        power: { total: 300, drain: 0, isLowPower: false }, isAi: true, isCombatant: true };
    function own(name: string, rx = 0, extra = {}) {
        const infantry = ["E1", "E2", "DOG", "ADOG"].includes(name), vehicle = ["HTNK", "MTNK", "CMIN", "HARV", "FV", "HTK"].includes(name);
        const type = infantry ? ObjectType.Infantry : vehicle ? ObjectType.Vehicle : ObjectType.Building;
        const rules = { name, type, movementZone: infantry ? MovementZone.Infantry : MovementZone.Normal,
            isSelectableCombatant: infantry || ["HTNK", "MTNK", "FV", "HTK"].includes(name),
            harvester: ["HARV", "CMIN"].includes(name), refinery: ["NAREFN", "GAREFN"].includes(name),
            weaponsFactory: ["NAWEAP", "GAWEAP"].includes(name), constructionYard: ["NACNST", "GACNST"].includes(name) };
        const hp = name === "MTNK" ? 300 : name === "HTNK" ? 400 : infantry ? 125 : 1000;
        const unit = { id: id++, name, owner: "bot", type, rules, tile: { rx, ry: 0 }, hitPoints: hp, maxHitPoints: hp,
            isFiring: false, isIdle: true, foundation: { width: 1, height: 1 }, buildStatus: BuildStatus.Ready, ...extra };
        owned.push(unit); return unit;
    }
    own(soviet ? "NACNST" : "GACNST"); own(soviet ? "NAWEAP" : "GAWEAP");
    for (let i = 0; i < refineries; i++) own(soviet ? "NAREFN" : "GAREFN", 5 + i * 20);
    for (let i = 0; i < miners; i++) own(miner, 5);
    for (let i = 0; i < core; i++) own(tank, 30);
    const rifle = own(foot, 45, { isFiring: firing });
    const available = new Map(QUEUES.map(type => [type, [] as any[]]));
    available.set(QueueType.Vehicles, [{ name: miner, type: ObjectType.Vehicle, harvester: true, cost: 1400 },
        { name: tank, type: ObjectType.Vehicle, cost: soviet ? 900 : 700 }]);
    const queues = new Map(QUEUES.map(type => [type, { type, status: QueueStatus.Idle, items: [] as any[], size: 0 }]));
    const actions = { queueForProduction: mock((_queue: QueueType, _name: string, _type: ObjectType, _quantity: number) => {}),
        unqueueFromProduction: mock(() => {}), pauseProduction: mock(() => {}), resumeProduction: mock(() => {}),
        toggleRepairWrench: mock(() => {}), sellBuilding: mock(() => {}) };
    const production: any = { getAvailableObjects: (type?: QueueType) => type === undefined ? [...available.values()].flat() : available.get(type)!,
        getQueueData: (type: QueueType) => queues.get(type)! };
    const game: any = { getCurrentTick: () => now, getPlayerData: (name: string) => {
            if (name !== "bot") throw Error("private opponent economy lookup"); return player;
        },
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "self" ? owned : hostile).filter(unit => !hidden.has(unit.id) && predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (uid: number) => { if (hidden.has(uid)) throw Error("hidden unit lookup"); return [...owned, ...hostile].find(unit => unit.id === uid); },
        getGameObjectData: (uid: number) => game.getUnitData(uid),
        mapApi: { getAllTilesResourceData: () => [5, 25].map(rx => ({ tile: { rx, ry: 0 }, ore: 8000, gems: 0 })),
            getResourceCreditValues: () => ({ ore: 1, gems: 2 }), isVisibleTile: () => true,
            getStartingLocations: () => [player.startLocation, new Vector2(200, 0)], getTileResourceData: () => undefined,
            findPath: (_speed: any, _start: any, end: any) => [end] } };
    const context: any = { game, difficulty: "brutal", player: { name: "bot", actions, production },
        matchAwareness: { getThreatCache: () => null, getNextExpansionCandidates: () => [] } };
    for (let i = 0; i < enemies; i++) hostile.push({ id: 500 + i, name: "E1", owner: "enemy", type: ObjectType.Infantry,
        tile: { rx: 70, ry: 0 }, rules: { name: "E1", type: ObjectType.Infantry, movementZone: MovementZone.Infantry,
            isSelectableCombatant: true, primary: "M60", secondary: "Para", harvester: false } });
    setPressureWatchPost(game, "bot", { rx: 65, ry: 0 });
    const controller = new QueueController(), requests = new Map<string, any>([[tank, { priority: 75, specificLocation: null }]]);
    return { owned, hostile, hidden, own, rifle, player, context, game, available, queues, actions, production, controller, requests, tank, miner,
        at(value: number) { now = value; },
        paid(name = miner, status = QueueStatus.Active) {
            const rules = available.get(QueueType.Vehicles)!.find(option => option.name === name)!;
            Object.assign(queues.get(QueueType.Vehicles)!, { status, size: 1, items: [{ rules, quantity: 1, progress: 584 / 1400 }] });
        },
        run(regrouping = false) { controller.onAiUpdate(context, null, requests, () => {}, regrouping); },
        priority(name: string) { return Number(controller.getGlobalDebugText(game, production).match(new RegExp(`${name}\\(([^)]+)\\)`))?.[1] ?? 0); } };
}

function withEcoOnly(run: () => void) {
    const previous = BRUTAL_PARAMS.economy.ecoOnly; BRUTAL_PARAMS.economy.ecoOnly = 1;
    try { run(); } finally { BRUTAL_PARAMS.economy.ecoOnly = previous; }
}

describe("B6 actual one-income infantry combat reaches the existing counter tier", () => {
    test.each(["Americans", "Russians"])("%s funds its existing core target despite an attacking rather than regrouping field", country => {
        const f = fixture({ country }); f.run(false);
        expect(f.priority(f.tank)).toBe(100); expect(f.priority(f.miner)).toBe(0);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.tank, ObjectType.Vehicle, 1);
    });
    test.each(["Americans", "Russians"])("%s active combat uses the original emergency cancellation, then admits its counter", country => {
        const f = fixture({ country }); f.paid(); f.run();
        expect(f.actions.unqueueFromProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.miner, ObjectType.Vehicle, 1);
        Object.assign(f.queues.get(QueueType.Vehicles)!, { status: QueueStatus.Idle, items: [], size: 0 }); f.at(4082); f.run();
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.tank, ObjectType.Vehicle, 1);
    });
    test.each(["Americans", "Russians"])("%s keeps its admitted counter decision through cancellation-to-idle and a firing gap", country => {
        const f = fixture({ country }); f.paid(); f.run();
        expect(f.actions.unqueueFromProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.miner, ObjectType.Vehicle, 1);
        f.rifle.isFiring = false; f.at(4084);
        Object.assign(f.queues.get(QueueType.Vehicles)!, { status: QueueStatus.Idle, items: [], size: 0 }); f.run();
        expect(f.priority(f.tank)).toBe(100);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.tank, ObjectType.Vehicle, 1);
    });
    test("a held paid miner follows its original resume path, not a new forced-refund implementation", () => {
        const f = fixture(); f.paid(f.miner, QueueStatus.OnHold); f.run();
        expect(f.priority(f.tank)).toBe(100); expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
        expect(f.actions.resumeProduction).toHaveBeenCalledWith(QueueType.Vehicles);
    });
    test("a Ready paid miner is not overwritten or counted as already delivered", () => {
        const f = fixture(); f.paid(f.miner, QueueStatus.Ready); f.run();
        expect(f.priority(f.tank)).toBe(100); expect(f.actions.queueForProduction).not.toHaveBeenCalled();
        expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
        expect(f.owned.filter(unit => unit.name === f.miner)).toHaveLength(1);
    });
    test.each([QueueStatus.Active, QueueStatus.OnHold])("an admitted counter in status%i survives a brief firing gap without a new timer", status => {
        const f = fixture(); f.paid(f.tank, status); f.run(); expect(f.priority(f.tank)).toBe(100);
        f.rifle.isFiring = false; f.at(4082); f.run();
        expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
    });
    test("the same actual firing rule accepts an owned conscript rather than hardcoding GI", () => {
        const f = fixture(); f.rifle.name = f.rifle.rules.name = "E2"; f.run(); expect(f.priority(f.tank)).toBe(100);
    });
    test.each([[8, 1, 100], [10, 2, 75], [13, 2, 100], [40, 6, 75]])(
        "visible infantry%i/core%i retains the exact existing bounded counter target", (enemies, core, priority) => {
            const f = fixture({ enemies, core }); f.run(); expect(f.priority(f.tank)).toBe(priority);
            expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, priority === 100 ? f.tank : f.miner, ObjectType.Vehicle, 1);
        });
    test("meeting the old target restores income even while another own infantry shot is active", () => {
        const f = fixture(); f.run(); expect(f.priority(f.tank)).toBe(100);
        f.own(f.tank); f.at(4082); f.actions.queueForProduction.mockClear(); f.run();
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.miner, ObjectType.Vehicle, 1);
    });
    test("the new admission does not mutate caller mission requests", () => {
        const f = fixture(), before = [...f.requests].map(([name, value]): [string, any] => [name, { ...value }]); f.run();
        expect([...f.requests]).toEqual(before);
    });
    test("an existing115 AA response still precedes the100 infantry counter", () => {
        const f = fixture(); f.available.get(QueueType.Vehicles)!.push({ name: "FV", type: ObjectType.Vehicle, cost: 600 });
        f.requests.set("FV", { priority: 115, specificLocation: null }); f.run();
        expect(f.priority(f.tank)).toBe(100); expect(f.priority("FV")).toBe(115);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "FV", ObjectType.Vehicle, 1);
    });
});

describe("B6 preserves income, warning and visibility controls", () => {
    test.each([false, undefined])("firing=%s is not an actual combat acknowledgement", firing => {
        const f = fixture(); f.rifle.isFiring = firing as any; f.paid(); f.run();
        expect(f.priority(f.tank)).toBe(75); expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
    });
    test("an injury or a submitted Attack intent alone cannot trigger this supplement", () => {
        const f = fixture({ firing: false }); f.rifle.hitPoints = 65; (f.rifle as any).attackState = 1; f.paid(); f.run();
        expect(f.priority(f.tank)).toBe(75); expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
    });
    test("a firing scout does not turn an unengaged basic infantry warning into a new counter", () => {
        const f = fixture({ firing: false }); f.own("ADOG", 45, { isFiring: true }); f.paid(); f.run();
        expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled(); expect(f.priority(f.tank)).toBe(75);
    });
    test("a foreign unit returned among self IDs cannot provide the owned firing signal", () => {
        const f = fixture(); f.rifle.owner = "ally"; f.paid(); f.run();
        expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled(); expect(f.priority(f.tank)).toBe(75);
    });
    test("seven public infantry retain the old threshold even when own infantry fire", () => {
        const f = fixture({ enemies: 7 }); f.paid(); f.run();
        expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled(); expect(f.priority(f.tank)).toBe(75);
    });
    test("zero income miners retain original120 recovery rather than a new combat expense", () => {
        const f = fixture({ miners: 0 }); f.run(); expect(f.priority(f.miner)).toBe(120);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.miner, ObjectType.Vehicle, 1);
    });
    test("no owned refinery cannot activate the supplement", () => {
        const f = fixture({ refineries: 0 }); f.run(); expect(f.priority(f.tank)).toBe(75);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.miner, ObjectType.Vehicle, 1);
    });
    test("no available tank does not invent a prerequisite or cancel paid income", () => {
        const f = fixture(); f.available.set(QueueType.Vehicles, f.available.get(QueueType.Vehicles)!.filter(option => option.name !== f.tank));
        f.paid(); f.run(); expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled(); expect(f.priority(f.tank)).toBe(0);
    });
    test("Normal never reads the new own firing input", () => {
        const f = fixture(); f.context.difficulty = "normal";
        Object.defineProperty(f.rifle, "isFiring", { get() { throw Error("Normal must not inspect new combat signal"); } });
        f.requests.set(f.miner, { priority: 110, specificLocation: null }); f.run();
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.miner, ObjectType.Vehicle, 1);
    });
    test("ecoOnly remains income-only despite real infantry firing", () => withEcoOnly(() => {
        const f = fixture(); f.run(); expect(f.priority(f.tank)).toBe(0);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.miner, ObjectType.Vehicle, 1);
    }));
    test("the old two-income counter needs no new firing signal", () => {
        const f = fixture({ miners: 2, firing: false });
        Object.defineProperty(f.rifle, "isFiring", { get() { throw Error("existing two-income branch must remain unchanged"); } });
        f.run(); expect(f.priority(f.tank)).toBe(100);
    });
    test("hidden opponents cannot activate the new admission or cause exact private-health reads", () => {
        const f = fixture(); for (const enemy of f.hostile) {
            f.hidden.add(enemy.id); Object.defineProperty(enemy, "tile", { get() { throw Error("hidden enemy position"); } });
        }
        f.paid(); f.run(); expect(f.actions.unqueueFromProduction).not.toHaveBeenCalled();
    });
    test("only own firing and public opposing types are read, never opposing HP or economy", () => {
        const f = fixture(); for (const enemy of f.hostile) Object.defineProperty(enemy, "hitPoints", { get() { throw Error("private enemy HP"); } });
        f.run(); expect(f.priority(f.tank)).toBe(100);
    });
    test.each([[8998, 100], [9000, 75]])("the single-income supplement retains the original9000 boundary at%i", (tick, priority) => {
        const f = fixture({ tick }); f.run(); expect(f.priority(f.tank)).toBe(priority);
    });
    test("ending the public battle restores the original quiet-window optional income", () => {
        const f = fixture(); f.run(); f.hostile.length = 0; f.rifle.isFiring = false; f.at(6780);
        f.actions.queueForProduction.mockClear(); f.run(); expect(readPressure(f.context).homeQuiet).toBe(true);
        expect(f.priority(f.miner)).toBe(110);
        expect(f.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, f.miner, ObjectType.Vehicle, 1);
    });
});

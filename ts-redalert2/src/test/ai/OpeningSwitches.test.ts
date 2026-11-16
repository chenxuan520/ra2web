import { describe, expect, mock, test } from "bun:test";
import { BuildStatus } from "../../game/gameobject/Building";
import { ArmorType } from "../../game/type/ArmorType";
import { MovementZone, ObjectType, QueueStatus, QueueType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { QueueController, QUEUES } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController";
import { getDronePriority } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/droneProduction";
import { HarassmentMission, HarassmentMissionFactory } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/harassmentMission";
import { Mission, noop } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/mission";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";

function withSwitches(values: Partial<typeof BRUTAL_PARAMS.economy>, run: () => void) {
    const previous = { ...BRUTAL_PARAMS.economy };
    Object.assign(BRUTAL_PARAMS.economy, { openingDefense: 1, openingMinerFirst: 1, openingRaid: 1 }, values);
    try { run(); } finally { Object.assign(BRUTAL_PARAMS.economy, previous); }
}
function fixture(miners = 1, core = 0, country = "Russians") {
    let tick = 4000, nextId = 1;
    const soviet = country === "Russians", minerName = soviet ? "HARV" : "CMIN", tankName = soviet ? "HTNK" : "MTNK";
    const player: any = { name: "bot", country: { name: country }, startLocation: new Vector2(), credits: 5000,
        power: { total: 300, drain: 0 }, isAi: true, isCombatant: true };
    const units: any[] = [], enemies: any[] = [];
    const weapon = { maxRange: 5, rules: { damage: 65, rof: 60 }, warheadRules: { verses: new Map([[ArmorType.None, 1], [ArmorType.Heavy, 1]]) },
        projectileRules: { isAntiGround: true, isAntiAir: false } };
    function own(name: string, rx = 0) {
        const vehicle = ["HARV", "CMIN", "HTNK", "MTNK"].includes(name);
        const rules = { name, type: vehicle ? ObjectType.Vehicle : ObjectType.Building,
            harvester: ["HARV", "CMIN"].includes(name), refinery: ["NAREFN", "GAREFN"].includes(name),
            weaponsFactory: ["NAWEAP", "GAWEAP"].includes(name), constructionYard: ["NACNST", "GACNST"].includes(name),
            isSelectableCombatant: ["HTNK", "MTNK"].includes(name), baseNormal: !vehicle, movementZone: MovementZone.Normal,
            armor: vehicle ? ArmorType.Heavy : ArmorType.None };
        const unit = { id: nextId++, name, owner: "bot", type: rules.type, rules, tile: { rx, ry: 0 },
            foundation: { width: 1, height: 1 }, hitPoints: 400, maxHitPoints: 400, isIdle: true, canMove: true,
            isWarpedOut: false, zone: ZoneType.Ground, buildStatus: BuildStatus.Ready, primaryWeapon: vehicle ? weapon : undefined };
        units.push(unit); return unit;
    }
    own(soviet ? "NACNST" : "GACNST"); own(soviet ? "NAWEAP" : "GAWEAP"); own(soviet ? "NAREFN" : "GAREFN", 5);
    for (let index = 0; index < miners; index++) own(minerName, 10);
    for (let index = 0; index < core; index++) own(tankName, 40);
    const basicName = soviet ? "NALASR" : "GAPILL", aaName = soviet ? "NAFLAK" : "NASAM";
    const options = new Map(QUEUES.map(queue => [queue, [] as any[]]));
    options.set(QueueType.Armory, [basicName, aaName].map(name => ({ name, type: ObjectType.Building, baseNormal: false, adjacent: 100, cost: 500 })));
    options.set(QueueType.Vehicles, [{ name: minerName, type: ObjectType.Vehicle, harvester: true, cost: 1400 },
        { name: tankName, type: ObjectType.Vehicle, cost: 900 }, { name: "DRON", type: ObjectType.Vehicle, cost: 500 }]);
    const queues = new Map(QUEUES.map(type => [type, { type, status: QueueStatus.Idle, items: [] as any[], size: 0 }]));
    const candidates = Array.from({ length: 101 }, (_, index) => ({ id: `${index - 50}_0`, rx: index - 50, ry: 0 }));
    const actions = { queueForProduction: mock((_queue: QueueType, _name: string, _type: ObjectType, _quantity: number) => {}),
        unqueueFromProduction: mock(() => {}), pauseProduction: mock(() => {}), resumeProduction: mock(() => {}),
        toggleRepairWrench: mock(() => {}), orderUnits: mock(() => {}), sellBuilding: mock(() => {}) };
    const production: any = { getAvailableObjects: (queue?: QueueType) => queue === undefined ? [...options.values()].flat() : options.get(queue)!,
        getQueueData: (queue: QueueType) => queues.get(queue)! };
    const resources = [{ tile: { rx: 10, ry: 0 }, ore: 8000, gems: 0 }];
    const game: any = {
        getCurrentTick: () => tick, getPlayerData: () => player, getGeneralRules: () => ({ baseUnit: ["AMCV", "SMCV"] }),
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "self" ? units : enemies).filter(unit => predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => [...units, ...enemies].find(unit => unit.id === id),
        getGameObjectData: (id: number) => game.getUnitData(id),
        getBuildingPlacementData: () => ({ foundation: { width: 1, height: 1 } }),
        canPlaceBuilding: (_name: string, _rule: string, tile: any) => !units.some(unit => unit.type === ObjectType.Building && unit.tile.rx === tile.rx && unit.tile.ry === tile.ry),
        mapApi: { getAllTilesResourceData: () => resources, getResourceCreditValues: () => ({ ore: 1, gems: 2 }),
            isVisibleTile: () => true, getStartingLocations: () => [player.startLocation, new Vector2(200, 0)],
            getTile: (rx: number, ry: number) => ({ id: `${rx}_${ry}`, rx, ry }), getTileResourceData: () => undefined,
            findPath: (_speed: any, _start: any, end: any) => [end],
            getTilesInRect: (rect: any) => candidates.filter(tile => tile.rx >= rect.x && tile.rx < rect.x + rect.width && tile.ry >= rect.y && tile.ry < rect.y + rect.height) },
    };
    const context: any = { game, difficulty: "brutal", player: { name: "bot", actions, production },
        matchAwareness: { getThreatCache: () => null, getNextExpansionCandidates: () => [], getMainRallyPoint: () => new Vector2(),
            getHostilesNearPoint: () => [], getHostilesNearPoint2d: () => [] } };
    const controller = new QueueController(), requests = new Map<string, any>();
    return { game, player, context, units, enemies, actions, requests, own, minerName, basicName, aaName,
        at(value: number) { tick = value; },
        enemy(name: string, rx = 100, ry = 0, type = ObjectType.Vehicle) {
            const unit = { id: 500 + enemies.length, owner: "enemy", name, type, tile: { rx, ry }, hitPoints: 400,
                rules: { name, type, harvester: name === "HARV", isSelectableCombatant: true,
                    armor: type === ObjectType.Vehicle ? ArmorType.Heavy : ArmorType.None } };
            enemies.push(unit); return unit;
        },
        run() { controller.onAiUpdate(context, null, requests, () => {}); },
        priority(name: string) { return Number(controller.getGlobalDebugText(game, production).match(new RegExp(`${name}\\(([^)]+)\\)`))?.[1] ?? 0); } };
}
class MainForce extends Mission {
    constructor() { super("opening-switch-main", () => {}); }
    _onAiUpdate() { return noop(); }
    getPriority() { return 1; }
    getGlobalDebugText() { return undefined; }
    getAttackArea() { return new Vector2(70, 0); }
}

describe("independent opening expense switches", () => {
    test.each([1, 0])("openingDefense=%i gates basic defensive production before tick 9000", value => withSwitches({ openingDefense: value }, () => {
        const f = fixture(); f.enemy("DRON"); f.run();
        expect(f.priority(f.basicName) > 0).toBe(value === 1);
        expect(f.actions.queueForProduction.mock.calls.some(call => call[0] === QueueType.Armory && call[1] === f.basicName)).toBe(value === 1);
    }));
    test("basic defense is restored at exactly tick 9000", () => withSwitches({ openingDefense: 0 }, () => {
        const f = fixture(); f.at(9000); f.enemy("DRON"); f.run(); expect(f.priority(f.basicName)).toBeGreaterThan(0);
    }));
    test("disabling basic defense does not disable anti-air defense", () => withSwitches({ openingDefense: 0 }, () => {
        const f = fixture(); f.enemy("ORCA", 100, 0, ObjectType.Aircraft); f.enemy("ORCA", 110, 0, ObjectType.Aircraft);
        f.run(); expect(f.priority(f.aaName)).toBe(66);
    }));
    test("disabling basic defense keeps anti-air selection available with mixed drone and aircraft evidence", () => withSwitches({ openingDefense: 0 }, () => {
        const f = fixture(); f.enemy("DRON"); f.enemy("ORCA", 100, 0, ObjectType.Aircraft); f.enemy("ORCA", 110, 0, ObjectType.Aircraft);
        f.run(); expect(f.priority(f.basicName)).toBe(0); expect(f.priority(f.aaName)).toBe(66);
    }));
    test.each([4500, 8998])("remembered drone evidence does not suppress anti-air while basic defense is disabled at %i", tick => withSwitches({ openingDefense: 0 }, () => {
        const f = fixture(), drone = f.enemy("DRON");
        f.enemy("ORCA", 100, 0, ObjectType.Aircraft); f.enemy("ORCA", 110, 0, ObjectType.Aircraft); f.run();
        f.enemies.splice(f.enemies.indexOf(drone), 1); f.at(tick); f.run();
        expect(f.priority(f.basicName)).toBe(0); expect(f.priority(f.aaName)).toBe(66);
    }));
    test("Normal retains an existing basic defense request", () => withSwitches({ openingDefense: 0 }, () => {
        const f = fixture(); f.context.difficulty = "normal"; f.requests.set(f.basicName, { priority: 70, specificLocation: new Vector2(6, 0) });
        f.run(); expect(f.priority(f.basicName)).toBe(70);
    }));
    test.each([1, 0])("openingMinerFirst=%i controls an unpressured second miner with no tanks", value => withSwitches({ openingMinerFirst: value }, () => {
        const f = fixture(); f.run(); expect(f.priority(f.minerName)).toBe(value === 1 ? 110 : 0);
    }));
    test("the disabled miner-first switch admits the second miner at priority 90 after two Soviet tanks", () => withSwitches({ openingMinerFirst: 0 }, () => {
        const f = fixture(1, 2); f.run(); expect(f.priority(f.minerName)).toBe(90);
    }));
    test("miner-first returns to the original rule at tick 9000", () => withSwitches({ openingMinerFirst: 0 }, () => {
        const f = fixture(); f.at(9000); f.run(); expect(f.priority(f.minerName)).toBe(110);
    }));
    test("ecoOnly keeps its original miner-first behavior", () => withSwitches({ openingMinerFirst: 0, ecoOnly: 1 }, () => {
        const f = fixture(); f.run(); expect(f.priority(f.minerName)).toBe(110);
    }));
    test.each([1, 0])("openingRaid=%i controls first drone without changing the current-start priority 112", value => withSwitches({ openingRaid: value }, () => {
        const f = fixture(); expect(getDronePriority(f.context)).toBe(value === 1 ? 112 : 0);
    }));
    test.each([1, 0])("openingRaid=%i controls the existing two-tank early detachment", value => withSwitches({ openingRaid: value }, () => {
        const f = fixture(1, 5, "Americans"), main = new MainForce(), missions = new MissionController(() => {});
        for (const unit of f.units.filter(unit => unit.name === "MTNK")) main.addUnit(unit.id);
        missions.addMission(main); f.enemy("HARV", 80, 30);
        new HarassmentMissionFactory().maybeCreateMissions(f.context, missions, () => {}, [main]);
        expect(missions.getMissions().filter(mission => mission instanceof HarassmentMission)).toHaveLength(value === 1 ? 1 : 0);
        expect(main.getUnitIds()).toHaveLength(value === 1 ? 3 : 5);
    }));
});

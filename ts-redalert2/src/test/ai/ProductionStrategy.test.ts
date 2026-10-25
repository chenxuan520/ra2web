import { describe, expect, mock, test } from "bun:test";
import { QueueController, QUEUES } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController";
import { QueueStatus, QueueType, ObjectType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { DEFAULT_COMPOSITIONS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/defaultStrategy";
import { selectAdaptiveComposition } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/adaptiveComposition";
import { GlobalThreat } from "../../game/ai/thirdpartbot/builtIn/bot/logic/threat/threat";
import type { UnitRequest } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { BasicBuilding } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/basicBuilding";
import { ResourceCollectionBuilding } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/resourceCollectionBuilding";

function productionScenario(credits = 100, difficulty?: "normal" | "brutal") {
    const available = new Map<number, any[]>();
    const queues = new Map(QUEUES.map(type => [type, { type, status: QueueStatus.Idle, items: [] as any[], size: 0 }]));
    const owned: any[] = [];
    const requests = new Map<string, UnitRequest>();
    const actions = {
        queueForProduction: mock(() => {}), unqueueFromProduction: mock(() => {}),
        pauseProduction: mock(() => {}), resumeProduction: mock(() => {}),
    };
    const context = {
        difficulty,
        player: {
            name: "bot", actions,
            production: { getAvailableObjects: (type: number) => available.get(type) ?? [], getQueueData: (type: number) => queues.get(type)! },
        },
        game: {
            getPlayerData: () => ({ name: "bot", credits }), getCurrentTick: () => 0,
            getVisibleUnits: (_name: string, _relation: string, predicate: (rules: any) => boolean) => owned.filter(predicate).map((_, i) => i),
        },
    };
    function request(type: number, name: string, priority: number, cost: number, status = QueueStatus.Idle) {
        const rules = { name, cost, type: type === QueueType.Structures ? ObjectType.Building : ObjectType.Vehicle };
        available.set(type, [...available.get(type) ?? [], rules]);
        requests.set(name, { priority, specificLocation: null });
        queues.set(type, { type, status, items: status === QueueStatus.Idle ? [] : [{ rules: { ...rules }, quantity: 1 }], size: status === QueueStatus.Idle ? 0 : 1 });
        return rules;
    }
    return { available, queues, owned, requests, actions, request, run: () => new QueueController().onAiUpdate(context as any, null, requests, () => {}) };
}

describe("AI production economy", () => {
    test.each(["normal", "brutal"] as const)("%s applies the experimental conscript budget only to brutal", difficulty => {
        const s = productionScenario(2000, difficulty);
        for (let i = 0; i < 12; i++) s.owned.push({ name: "E2" });
        s.request(QueueType.Infantry, "E2", 20, 100);
        s.run();
        if (difficulty === "brutal") expect(s.actions.queueForProduction).not.toHaveBeenCalled();
        else expect(s.actions.queueForProduction).toHaveBeenCalledTimes(1);
    });
    test.each(["normal", "brutal"] as const)("%s enforces specialist limits only for the brutal profile", difficulty => {
        const s = productionScenario(2000, difficulty);
        s.owned.push({ name: "DESO" }, { name: "DESO" });
        s.request(QueueType.Infantry, "DESO", 50, 600, QueueStatus.Active);
        s.run();
        if (difficulty === "brutal") expect(s.actions.unqueueFromProduction).toHaveBeenCalledWith(QueueType.Infantry, "DESO", ObjectType.Vehicle, 1);
        else expect(s.actions.unqueueFromProduction).not.toHaveBeenCalled();
    });
    test("a cash-starved opening reserves income before starting low priority infantry", () => {
        const s = productionScenario(100);
        s.request(QueueType.Structures, "GAPOWR", 100, 800);
        s.request(QueueType.Infantry, "E1", 5, 200);
        s.run();
        expect(s.actions.queueForProduction).toHaveBeenCalledTimes(1);
        expect(s.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Structures, "GAPOWR", ObjectType.Building, 1);
    });
    test("empty aircraft and ship queues do not prevent reserving cash for urgent power", () => {
        const s = productionScenario();
        s.request(QueueType.Structures, "GAPOWR", 100, 800);
        s.request(QueueType.Infantry, "E1", 5, 200, QueueStatus.Active);
        s.run();
        expect(s.actions.pauseProduction).toHaveBeenCalledWith(QueueType.Infantry);
        expect(s.actions.unqueueFromProduction).not.toHaveBeenCalled();
    });

    test("a high priority held queue resumes even when other queues have no requests", () => {
        const s = productionScenario();
        s.request(QueueType.Structures, "GAPOWR", 100, 800, QueueStatus.OnHold);
        s.request(QueueType.Infantry, "E1", 5, 200, QueueStatus.OnHold);
        s.run();
        expect(s.actions.resumeProduction).toHaveBeenCalledWith(QueueType.Structures);
        expect(s.actions.resumeProduction).not.toHaveBeenCalledWith(QueueType.Infantry);
    });

    test("equal priority requests across six queues cannot leave every queue on hold", () => {
        const s = productionScenario(0);
        for (const type of QUEUES) s.request(type, `unit-${type}`, 10, 1000, QueueStatus.OnHold);
        s.run();
        expect(s.actions.resumeProduction.mock.calls.length).toBeGreaterThan(0);
    });

    test("a refinery with lost miners rebuilds income before producing attack tanks", () => {
        const s = productionScenario(1500);
        s.owned.push({ refinery: true });
        s.request(QueueType.Vehicles, "MTNK", 40, 700);
        s.available.get(QueueType.Vehicles)!.push({ name: "CMIN", cost: 1400, type: ObjectType.Vehicle, harvester: true });
        s.run();
        expect(s.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "CMIN", ObjectType.Vehicle, 1);
        expect(s.requests.has("CMIN")).toBe(false);
    });

    test.each([0, 2])("with %i refineries, saturated income leaves the tank queue available", refineries => {
        const s = productionScenario(2000);
        for (let i = 0; i < refineries; i++) s.owned.push({ refinery: true }, { harvester: true }, { harvester: true });
        s.request(QueueType.Vehicles, "HTNK", 40, 900);
        s.available.get(QueueType.Vehicles)!.push({ name: "HARV", cost: 1400, type: ObjectType.Vehicle, harvester: true });
        s.run();
        expect(s.actions.queueForProduction).toHaveBeenCalledWith(QueueType.Vehicles, "HTNK", ObjectType.Vehicle, 1);
    });
});

describe("AI base investment", () => {
    test("cloned API rule data still counts existing factories toward the building cap", () => {
        const factory = { name: "GAWEAP", type: ObjectType.Building } as any;
        const game = { getVisibleUnits: (_name: string, _relation: string, predicate: (rules: any) => boolean) => predicate({ ...factory }) ? [1] : [] };
        const priority = new BasicBuilding(15, 1).getPriority(game as any, { name: "bot", credits: 5000 } as any, factory, null);
        expect(priority).toBeLessThanOrEqual(0);
    });

    test("an enemy refinery near an expansion does not satisfy our local refinery requirement", () => {
        let owner = "enemy";
        const units = [
            { id: 1, owner: "bot", tile: { rx: 0, ry: 0 }, rules: { constructionYard: true } },
            { id: 2, owner: "bot", rules: { harvester: true } },
            { id: 3, owner: "bot", rules: { harvester: true } },
        ];
        const game = {
            getVisibleUnits: (_name: string, _relation: string, predicate: (rules: any) => boolean) => units.filter(u => predicate(u.rules)).map(u => u.id),
            getGameObjectData: (id: number) => id === 4 ? { id, name: "GAREFN", owner, rules: { refinery: true } } : units.find(u => u.id === id),
            getUnitData: () => ({ owner, rules: { refinery: true } }),
            getUnitsInArea: () => [4],
            rulesApi: { aircraftRules: new Map(), buildingRules: new Map([["GAREFN", { refinery: true }]]) },
        };
        const rules = new ResourceCollectionBuilding(10, 3);
        const player = { name: "bot" } as any;
        expect(rules.getMaxCount(game as any, player, {} as any, null)).toBe(3);
        owner = "bot";
        expect(rules.getMaxCount(game as any, player, {} as any, null)).toBe(2);
    });

    test("refineries approach visible ore even on maps without ore-spawning terrain", () => {
        const conyard = {
            tile: { rx: 0, ry: 0 }, foundation: { width: 1, height: 1 },
            rules: { constructionYard: true, baseNormal: true, type: ObjectType.Building },
        };
        const hidden = { id: "hidden", rx: -8, ry: 0 };
        const visible = { id: "visible", rx: 8, ry: 0 };
        const game = {
            getVisibleUnits: (_name: string, _relation: string, predicate: (rules: any) => boolean) => predicate(conyard.rules) ? [1] : [],
            getGameObjectData: () => conyard, getUnitData: () => conyard,
            getBuildingPlacementData: () => ({ foundation: { width: 2, height: 2 } }),
            canPlaceBuilding: () => true,
            mapApi: {
                getAllTilesResourceData: () => [{ tile: hidden, ore: 0, gems: 50, spawnsOre: false }, { tile: visible, ore: 20, gems: 0, spawnsOre: false }],
                isVisibleTile: (tile: any) => tile.id === "visible",
                getTilesInRect: () => [hidden, visible],
            },
        };
        expect(new ResourceCollectionBuilding(10, 3).getPlacementLocation(
            game as any, { name: "bot" } as any, { name: "GAREFN", adjacent: 8 } as any,
        )?.rx).toBe(8);
    });
});

function threat(land: number, air: number, defence: number, ourAA = 0) {
    return new GlobalThreat(0.5, land, air, 0, defence, 0, 0, ourAA, 0);
}

describe("brutal adaptive compositions", () => {
    test("an unscouted opponent gets an early mixed tank wave instead of a random late tech squad", () => {
        const result = selectAdaptiveComposition(DEFAULT_COMPOSITIONS, Object.keys(DEFAULT_COMPOSITIONS), null, 2)!;
        expect(result.composition.MTNK).toBeGreaterThan(result.composition.FV);
        expect(result.maximumUnits).toBe(6);
    });

    test("observed air superiority changes the next wave to substantial mobile anti-air", () => {
        const result = selectAdaptiveComposition(DEFAULT_COMPOSITIONS, ["sovietTanks", "sovietArtillery"], threat(5, 30, 50, 2), 4)!;
        expect(result.composition.HTK).toBeGreaterThanOrEqual(result.composition.HTNK);
        expect(result.composition.V3).toBeUndefined();
    });

    test("fortified opponents get escorted artillery when the technology is available", () => {
        const result = selectAdaptiveComposition(DEFAULT_COMPOSITIONS, ["alliedTanks", "alliedArtillery"], threat(5, 0, 20), 4)!;
        expect(result.composition.SREF).toBeGreaterThan(0);
        expect(result.composition.MTNK).toBeGreaterThanOrEqual(result.composition.SREF);
        expect(result.composition.FV).toBeGreaterThan(0);
        expect(result.maximumUnits).toBe(12);
        expect(DEFAULT_COMPOSITIONS.alliedArtillery.composition).toEqual({ SREF: 2, MTNK: 1 });
    });

    test("unavailable siege units never enter the requested composition", () => {
        const result = selectAdaptiveComposition(DEFAULT_COMPOSITIONS, ["alliedTanks"], threat(0, 0, 50), 4)!;
        expect(result.composition.SREF).toBeUndefined();
        expect(result.composition.MTNK).toBeGreaterThan(0);
    });

    test("barracks-only openings still produce an available force", () => {
        expect(selectAdaptiveComposition(DEFAULT_COMPOSITIONS, ["conscripts"], null, 1)?.composition).toEqual({ E2: 1 });
        expect(selectAdaptiveComposition(DEFAULT_COMPOSITIONS, [], null, 1)).toBeNull();
    });
});

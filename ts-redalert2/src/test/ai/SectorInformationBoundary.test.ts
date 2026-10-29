import { describe, expect, test } from "bun:test";
import { ObjectType, OrderType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { calculateMoney, calculateSectorThreat } from "../../game/ai/thirdpartbot/builtIn/bot/logic/threat/sectorThreat";
import { ExpansionMission, ExpansionMissionFactory } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/expansionMission";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { ActionBatcher } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";

describe("sector information boundary", () => {
    test("hidden, neutral and allied objects never enter enemy threat or get inspected", () => {
        let visible = false;
        const inspected: number[] = [];
        const units = new Map([
            [1, { owner: "bot", maxHitPoints: 100 }],
            [2, { owner: "enemy", maxHitPoints: 500 }],
        ]);
        const game: any = {
            getUnitsInArea: () => [1, 2, 3, 4],
            getVisibleUnits: (_: string, relation: string) => relation === "self" ? [1] : visible ? [2] : [],
            getGameObjectData(id: number) {
                inspected.push(id);
                if (!units.has(id)) throw new Error("Inspected unknown object");
                return units.get(id);
            },
            getPlayerData() { throw new Error("Enemy player internals are not needed"); },
        };
        const threat = () => calculateSectorThreat(0, 0, 10, game, { name: "bot" } as any);
        expect(threat()).toBe(-100);
        units.get(2)!.maxHitPoints = 10000;
        expect(threat()).toBe(-100);
        expect(inspected).toEqual([1, 1]);
        visible = true;
        expect(threat()).toBe(9900);
    });

    test("hidden ore depletion cannot change known money, revealing it can", () => {
        const revealed = new Set([1]);
        const amounts = new Map([[1, 500], [2, 9000]]);
        const reads: number[] = [];
        const map: any = {
            getTilesInRect: () => [{ id: 1 }, { id: 2 }],
            getResourceCreditValues: () => ({ ore: 13, gems: 17 }),
            isVisibleTile: (tile: any, player: string) => player === "bot" && revealed.has(tile.id),
            getTileResourceData(tile: any) {
                reads.push(tile.id);
                return { ore: amounts.get(tile.id), gems: 0 };
            },
        };
        const money = () => calculateMoney(0, 0, 10, map, "bot");
        expect(money()).toBe(6500);
        amounts.set(2, 1000);
        expect(money()).toBe(6500);
        expect(reads).toEqual([1, 1]);
        revealed.add(2);
        expect(money()).toBe(19500);
        revealed.clear();
        expect(money()).toBeNull();
    });

    test("known resource valuation uses rule prices, distinguishing gems and an empty sector", () => {
        let rich = true;
        const map: any = {
            getTilesInRect: () => Array.from({ length: 64 }, (_, id) => ({ id })),
            isVisibleTile: () => true,
            getResourceCreditValues: () => ({ ore: 7, gems: 19 }),
            getTileResourceData: (tile: any) => rich ? { ore: tile.id < 32 ? 11 : 0, gems: tile.id >= 32 ? 11 : 0 } : undefined,
        };
        expect(calculateMoney(0, 0, 8, map, "bot")).toBe(32 * 11 * (7 + 19));
        expect(calculateMoney(0, 0, 8, map, "bot")).toBeGreaterThanOrEqual(4000);
        rich = false;
        expect(calculateMoney(0, 0, 8, map, "bot")).toBe(0);
    });
});

describe("expansion ownership boundary", () => {
    test("another player's yard does not make our expansion report completion", () => {
        const conyardRules = { type: ObjectType.Building, constructionYard: true };
        let ownYard = false;
        let yardReads = 0;
        const game: any = {
            getCurrentTick: () => 600,
            getUnitsInArea: () => [2],
            getVisibleUnits: (_: string, relation: string) => relation === "self" && ownYard ? [2] : [],
            getGameObjectData: () => { yardReads++; return { name: "GACNST" }; },
            rulesApi: { aircraftRules: new Map(), vehicleRules: new Map(), infantryRules: new Map(),
                buildingRules: new Map([["GACNST", conyardRules]]) },
        };
        const run = () => {
            const orders: any[][] = [];
            const mission = new ExpansionMission("expand", 1, 1, [new Vector2(50, 50)], () => {});
            const result = mission.moveMcvToDestination(game,
                { orderUnits: (...args: any[]) => orders.push(args) } as any,
                { name: "bot" } as any, {} as any, new ActionBatcher(),
                { id: 1, tile: { rx: 10, ry: 10 }, rules: {} } as any);
            return { result, orders };
        };
        const unknown = run();
        expect(unknown.orders).toEqual([[[1], OrderType.Move, 50, 50]]);
        expect(yardReads).toBe(0);
        ownYard = true;
        const completed = run();
        expect(completed.orders).toEqual([]);
        expect(completed.result).not.toEqual(unknown.result);
    });

    test("an enemy refinery near the yard cannot justify packing our base", () => {
        const own = new Map([
            [1, { name: "GACNST", type: ObjectType.Building, constructionYard: true }],
            [2, { name: "GAWEAP", type: ObjectType.Building, weaponsFactory: true }],
            [3, { name: "GAREFN", type: ObjectType.Building, refinery: true }],
        ]);
        let nearbyOwn = false;
        const game: any = {
            getCurrentTick: () => 6000,
            getGeneralRules: () => ({ baseUnit: ["AMCV", "SMCV"] }),
            getPlayerData: () => ({ name: "bot", startLocation: new Vector2() }),
            getVisibleUnits: (_: string, relation: string, filter: (r: any) => boolean) => relation === "self"
                ? [...own].filter(([, r]) => filter(r)).map(([id]) => id) : [],
            getUnitsInArea: () => nearbyOwn ? [3, 4] : [4],
            getGameObjectData: (id: number) => {
                if (!own.has(id)) throw new Error("Read another player's hidden refinery");
                return { id, owner: "bot", tile: { rx: 10, ry: 10 }, rules: own.get(id) };
            },
        };
        const context: any = { game, difficulty: "normal", player: { name: "bot" }, matchAwareness: {
            getNextExpansionCandidates: () => [new Vector2(50, 50)],
            getThreatCache: () => ({ totalAvailableAntiGroundFirepower: 100, totalOffensiveLandThreat: 0 }),
        } };
        const run = () => {
            const controller = new MissionController(() => {});
            new ExpansionMissionFactory().maybeCreateMissions(context, controller, () => {});
            return controller.getMissions().length;
        };
        expect(run()).toBe(0);
        nearbyOwn = true;
        expect(run()).toBe(1);
    });
});

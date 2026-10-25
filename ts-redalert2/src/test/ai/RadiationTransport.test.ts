import { describe, expect, test } from "bun:test";
import { ObjectType, OrderType, SpeedType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { ActionBatcher } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";
import { RadiationTransportFactory, RadiationTransportMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/radiationTransportMission";

function fixture() {
    let tick = 0;
    const objects = new Map<number, any>();
    const add = (id: number, name: string, owner = "bot", x = 0, extra = {}) => {
        const unit: any = { id, name, owner, hitPoints: 150, maxHitPoints: 150, isIdle: true, zone: ZoneType.Ground,
            type: name === "DESO" || name === "ENGINEER" ? ObjectType.Infantry : ObjectType.Vehicle,
            tile: { rx: x, ry: 0 }, rules: { name, armor: 0, size: 1, speedType: SpeedType.Foot, ...extra } };
        objects.set(id, unit); return unit;
    };
    const deso = add(1, "DESO"), truck = add(2, "HTK", "bot", 1, { sizeLimit: 2 });
    truck.passengerSlotMax = 5; truck.passengerSlotCount = 0;
    const orders: any[][] = [];
    const context: any = { difficulty: "brutal", player: { name: "bot", production: { getAvailableObjects: () => [] } },
        matchAwareness: { getHostilesNearPoint2d: () => [] }, game: {
            getCurrentTick: () => tick,
            getUnitData: (id: number) => objects.get(id), getGameObjectData: (id: number) => objects.get(id),
            getPlayerData: () => ({ name: "bot", country: { name: "Arabs" }, credits: 5000, startLocation: new Vector2() }),
            getVisibleUnits: (_: string, side: string, filter = (_: any) => true) => [...objects.values()]
                .filter(unit => (side === "enemy" ? unit.owner !== "bot" : unit.owner === "bot") && filter(unit.rules)).map(unit => unit.id),
        } };
    const mission = new RadiationTransportMission(new Vector2(20, 0), new Vector2(), 0, () => {});
    mission.addUnit(1); mission.addUnit(2);
    return { context, objects, add, deso, truck, mission, orders, step(at: number) {
        tick = at; const batcher = new ActionBatcher();
        const result = mission.onAiUpdate({ ...context, actionBatcher: batcher });
        batcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any);
        return result;
    } };
}

describe("radiation transport lifecycle", () => {
    test("uses a real boarding order, preserves a limbo passenger's identity, then reclaims it", () => {
        const f = fixture();
        expect(f.step(0).type).toBe("noop");
        expect(f.orders).toEqual([[[1], OrderType.EnterTransport, 2]]);
        f.objects.delete(1); f.mission.removeUnit(1); f.truck.passengerSlotCount = 1;
        expect(f.step(6).type).toBe("noop");
        // The same own passenger reappears after the engine unloads it.
        f.objects.set(1, f.deso); f.truck.passengerSlotCount = 0;
        expect(f.step(12)).toEqual({ type: "requestSpecific", unitIds: [1], priority: 80 });
    });

    test.each(["occupied", "too-small", "no-capacity"])("does not board an %s transport", reason => {
        const f = fixture();
        if (reason === "occupied") f.truck.passengerSlotCount = 1;
        if (reason === "too-small") f.truck.rules.sizeLimit = 0;
        if (reason === "no-capacity") f.truck.passengerSlotMax = 0;
        expect(f.step(0)).toEqual({ type: "disband", reason: "unavailable-capacity" });
        expect(f.orders).toEqual([]);
    });

    test("never commands a passenger whose ownership changed", () => {
        const f = fixture(); f.deso.owner = "enemy";
        expect(f.step(0)).toEqual({ type: "disband", reason: "payload-owner-changed" });
        expect(f.orders).toEqual([]);
    });

    test("an unfulfilled production request has a bounded lifetime", () => {
        const f = fixture(); f.objects.clear();
        expect(f.step(0)).toEqual({ type: "request", unitNameToPriority: { DESO: 60, HTK: 60 } });
        expect(f.step(1200)).toEqual({ type: "disband", reason: "production-timeout" });
    });

    test.each(["normal", "poor", "small-army", "immune-targets"])("does not admit a raid when %s", reason => {
        const f = fixture();
        const admitted: any[] = [];
        f.context.difficulty = reason === "normal" ? "normal" : "brutal";
        f.context.game.getPlayerData = () => ({ country: { name: "Arabs" }, credits: reason === "poor" ? 0 : 5000, startLocation: new Vector2() });
        f.context.player.production.getAvailableObjects = () => [{ name: "DESO", cost: 600 }, { name: "HTK", cost: 500 }];
        for (let id = 10; id < 14; id++) f.add(id, "HARV", "bot", 0, { harvester: true });
        for (let id = 20; id < (reason === "small-army" ? 22 : 28); id++) f.add(id, "HTNK");
        f.add(100, "HARV", "enemy", 60, { harvester: true, immuneToRadiation: true });
        f.add(101, "HARV", "enemy", 61, { harvester: true, immuneToRadiation: true });
        const factory = new RadiationTransportFactory();
        factory.maybeCreateMissions(f.context, { getMissions: () => [], addMission: (mission: any) => admitted.push(mission) } as any, () => {});
        expect(admitted).toEqual([]);
    });

    test("an affordable isolated flank admits at most two attempts without borrowing the main army", () => {
        const f = fixture();
        let tick = 0;
        f.context.game.getCurrentTick = () => tick;
        for (let id = 10; id < 14; id++) f.add(id, "HARV", "bot", 0, { harvester: true });
        for (let id = 20; id < 28; id++) f.add(id, "HTNK");
        f.add(100, "ENGINEER", "enemy", 60); f.add(101, "ENGINEER", "enemy", 61);
        f.context.player.production.getAvailableObjects = () => [{ name: "DESO", cost: 600 },
            { name: "HTK", cost: 500, speedType: SpeedType.Track, strength: 180 }];
        f.context.game.mapApi = { getTile: (rx: number, ry: number) => ({ rx, ry }),
            isVisibleTile: () => true, hasBridgeOnTile: () => false, isPassableTile: () => true,
            findPath: (_: any, start: any, end: any, options: any) => {
                const path = [start]; let x = start.tile.rx, y = start.tile.ry;
                while (x !== end.tile.rx || y !== end.tile.ry) {
                    x += Math.sign(end.tile.rx - x); y += Math.sign(end.tile.ry - y);
                    const node = { tile: { rx: x, ry: y }, onBridge: false };
                    if (options.excludeNodes?.(node)) return [];
                    path.push(node);
                }
                return path.reverse();
            } };
        const admitted: any[] = [], factory = new RadiationTransportFactory();
        // Empty active missions here simulates each previous attempt finishing.
        const controller: any = { getMissions: () => [], addMission: (mission: any) => { admitted.push(mission); return true; } };
        for (tick of [0, 3600, 7200]) factory.maybeCreateMissions(f.context, controller, () => {});
        expect(admitted).toHaveLength(2);
        expect(admitted.every(mission => mission.getUnitIds().length === 0)).toBe(true);
    });
});

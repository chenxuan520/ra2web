import { describe, expect, mock, test } from "bun:test";
import { ObjectType, OrderType, SideType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { EngineerMission, EngineerMissionFactory } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/engineerMission";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";

function fixture(miners = 1, core = 0, difficulty = "brutal") {
    let tick = 301, ownReads = 0;
    const objects: any[] = [], visible = new Set<number>();
    const player = { name: "bot", startLocation: new Vector2(), country: { name: "Russians", side: SideType.Nod } };
    const add = (id: number, name: string, owner = "bot", extra = {}) => {
        const unit = { id, name, owner, tile: { rx: id, ry: 0 }, rules: { name,
            type: ["HARV", "HTNK"].includes(name) ? ObjectType.Vehicle : ObjectType.Building,
            harvester: name === "HARV", ...extra } };
        objects.push(unit); visible.add(id); return unit;
    };
    for (let i = 0; i < miners; i++) add(i + 1, "HARV");
    for (let i = 0; i < core; i++) add(i + 100, "HTNK");
    for (let i = 0; i < 3; i++) add(i + 1000, "CAOILD", "neutral", { capturable: true, produceCashAmount: 20 });
    const game: any = { getCurrentTick: () => tick,
        getPlayerData(name: string) { if (name !== player.name) throw Error("private player read"); return player; },
        getVisibleUnits(name: string, relation: string, predicate = (_rules: any) => true) {
            if (name !== player.name) throw Error("foreign shroud read");
            if (relation === "self") ownReads++;
            return objects.filter(unit => visible.has(unit.id) && (relation === "self" ? unit.owner === name : relation === "hostile" ? unit.owner === "neutral" : unit.owner === "enemy") && predicate(unit.rules)).map(unit => unit.id);
        },
        getGameObjectData(id: number) { if (!visible.has(id)) throw Error("hidden object read"); return objects.find(unit => unit.id === id); },
    };
    game.getUnitData = (id: number) => game.getGameObjectData(id);
    const context: any = { difficulty, game, player: { name: player.name } };
    const controller = new MissionController(() => {}), factory = new EngineerMissionFactory();
    return { game, context, controller, objects, visible, add,
        at(value: number) { tick = value; }, run() { factory.maybeCreateMissions(context, controller, () => {}); }, ownReads: () => ownReads };
}

function captureFixture(difficulty = "brutal") {
    const f = fixture(2, 1, difficulty);
    const engineer: any = f.add(500, "SENGINEER", "bot", { type: ObjectType.Infantry, engineer: true });
    engineer.isIdle = true;
    const target = f.objects.find(unit => unit.id === 1000); target.foundation = { width: 2, height: 2 };
    const orders = mock((_ids: number[], _type: OrderType, _target: number) => { engineer.isIdle = false; });
    f.context.player.actions = { orderUnits: orders };
    f.game.map = f.game.mapApi = { getReachabilityMap: () => ({ isReachable: () => true }),
        getTilesInRect: () => [{ rx: 1000, ry: 1 }] };
    const mission = new EngineerMission("capture-existing", 100, target.id, 1, () => {}); mission.addUnit(engineer.id);
    return { ...f, engineer, target, orders, step(tick: number) { f.at(tick); return mission._onAiUpdate(f.context); } };
}

describe("capture orders preserve existing movement", () => {
    test("a busy brutal engineer receives one Capture order, not a fresh task every thirty ticks", () => {
        const f = captureFixture();
        f.step(100); f.step(132); f.step(164);
        expect(f.orders).toHaveBeenCalledTimes(1);
        expect(f.orders).toHaveBeenCalledWith([500], OrderType.Capture, 1000);
    });
    test("an actually idle stalled engineer may retry after the existing cooldown", () => {
        const f = captureFixture(); f.step(100); f.engineer.isIdle = true;
        f.step(120); expect(f.orders).toHaveBeenCalledTimes(1);
        f.step(132); expect(f.orders).toHaveBeenCalledTimes(2);
    });
    test("a completed target still disbands the mission instead of issuing another Capture", () => {
        const f = captureFixture(); f.step(100); f.target.owner = "bot";
        expect(f.step(132).type).toBe("disband"); expect(f.orders).toHaveBeenCalledTimes(1);
    });
    test("normal retains its existing periodic Capture behavior", () => {
        const f = captureFixture("normal"); f.step(100); f.step(132);
        expect(f.orders).toHaveBeenCalledTimes(2);
    });
});

describe("historical visible cash-outpost admission", () => {
    test.each([[0, 0], [1, 0], [2, 0], [1, 1]])("miners%i/core%i retains one priority100 mission per seen cash outpost without a new inventory gate", (miners, core) => {
        const f = fixture(miners, core); f.run();
        const missions = f.controller.getMissions() as EngineerMission[];
        expect(missions).toHaveLength(3); expect(missions.map(mission => mission.targetId)).toEqual([1000, 1001, 1002]);
        expect(missions.every(mission => mission.getPriority() === 100)).toBe(true); expect(f.ownReads()).toBe(0);
        f.at(602); f.run(); expect(f.controller.getMissions()).toHaveLength(3);
    });
    test("an already owned cash outpost is excluded without blocking the other seen neutral outposts", () => {
        const f = fixture(); f.objects.find(unit => unit.id === 1000).owner = "bot";
        f.run(); expect(f.controller.getMissions().map(mission => (mission as EngineerMission).targetId)).toEqual([1001, 1002]);
    });
    test("a normal bot retains all original capture missions without new own-inventory checks", () => {
        const f = fixture(1, 0, "normal"); f.run();
        expect(f.controller.getMissions()).toHaveLength(3); expect(f.ownReads()).toBe(0);
    });
    test("a hidden tech building cannot create a capture commitment", () => {
        const f = fixture(); f.visible.delete(1000);
        Object.defineProperty(f.objects.find(unit => unit.id === 1000), "rules", { get() { throw Error("hidden tech rules"); } });
        f.run(); expect((f.controller.getMissions()[0] as EngineerMission).targetId).toBe(1001);
    });
});

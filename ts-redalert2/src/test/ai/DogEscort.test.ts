import { describe, expect, test } from "bun:test";
import { MovementZone, ObjectType, OrderType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { DogEscortMission, dogEscortPoint } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/dogEscortMission";
import { FieldArmyMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/fieldArmyMission";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { ActionBatcher } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";

function unit(id: number, name: string, x: number, y = 0, owner = "bot"): any {
    const infantry = name === "DOG" || name === "E2";
    return { id, name, owner, type: infantry ? ObjectType.Infantry : ObjectType.Vehicle,
        zone: ZoneType.Ground, tile: { rx: x, ry: y, z: 0 }, hitPoints: 100, maxHitPoints: 100,
        isIdle: true, canMove: true, rules: { name, type: infantry ? ObjectType.Infantry : ObjectType.Vehicle,
            movementZone: infantry ? MovementZone.Infantry : MovementZone.Normal, armor: 0, cost: name === "DOG" ? 200 : 900,
            harvester: name === "HARV", crusher: name === "HTNK", speedType: 0 },
        primaryWeapon: { maxRange: infantry ? name === "DOG" ? 1.5 : 4 : 5.75,
            rules: { damage: 30, rof: 30 }, projectileRules: { isAntiGround: true },
            warheadRules: { verses: new Map([[0, 1]]) } } };
}

function fixture(enabled = true) {
    const objects = [unit(1, "HTNK", 10), unit(2, "HTNK", 10, 2), unit(3, "DOG", 3),
        unit(4, "HARV", 0), unit(5, "HARV", 0, 1)];
    const controller = new MissionController(() => {});
    const army = new FieldArmyMission(null, controller, () => {});
    army.addUnit(1); army.addUnit(2);
    const mission = new DogEscortMission(army, () => {}, enabled);
    const orders: any[][] = [];
    let tick = 0, credits = 1000;
    const context: any = { difficulty: "brutal", game: {
        getCurrentTick: () => tick,
        getPlayerData: () => ({ name: "bot", credits }),
        getUnitData: (id: number) => objects.find(u => u.id === id),
        getGameObjectData: (id: number) => objects.find(u => u.id === id),
        getVisibleUnits: (_name: string, relation: string, filter = (_: any) => true) => objects
            .filter(u => (relation === "enemy" ? u.owner === "enemy" : u.owner === "bot") && filter(u.rules)).map(u => u.id),
        mapApi: { getTile: (rx: number, ry: number) => ({ rx, ry }), isVisibleTile: () => true, isPassableTile: () => true },
    }, player: { name: "bot", production: { getAvailableObjects: () => [{ name: "DOG", cost: 200 }] } },
    matchAwareness: { getMainRallyPoint: () => new Vector2() },
    };
    return { mission, army, objects, orders, context,
        cash(value: number) { credits = value; },
        step(at = 0) { tick = at; const batcher = new ActionBatcher();
            const result = mission.onAiUpdate({ ...context, actionBatcher: batcher });
            batcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any); return result; },
    };
}

describe("rhino dog escort", () => {
    test("funds a bounded screen after income and armor, not before the first tank", () => {
        const f = fixture();
        expect(f.step()).toMatchObject({ type: "request", unitNameToPriority: { DOG: 25 } });
        f.cash(699);
        expect(f.step(12).type).toBe("noop");
        f.cash(1000); f.army.removeUnit(2);
        expect(f.step(24).type).toBe("noop");
    });
    test("normal profile never requests or commands an escort", () => {
        const f = fixture(); f.context.difficulty = "normal"; f.mission.addUnit(3);
        expect(f.step().type).toBe("noop"); expect(f.orders).toHaveLength(0);
    });
    test("only owns dogs and does not interrupt the tank's fire", () => {
        const f = fixture(); f.mission.addUnit(3); f.step();
        expect(f.orders.length).toBeGreaterThan(0);
        expect(f.orders.flatMap(order => order[0])).toEqual([3]);
        const first = f.orders.length; f.objects.find(u => u.id === 3)!.isIdle = false; f.step(12);
        expect(f.orders).toHaveLength(first);
    });
    test("ablation keeps admission identical but uses ordinary attack-move", () => {
        const a = fixture(), b = fixture(false);
        expect(a.step()).toEqual(b.step());
        a.mission.addUnit(3); b.mission.addUnit(3); a.step(12); b.step(12);
        expect(a.orders.at(-1)![1]).toBe(OrderType.Move);
        expect(b.orders.at(-1)![1]).toBe(OrderType.AttackMove);
    });
    test("will not pursue distant infantry past the screen", () => {
        const f = fixture(); f.mission.addUnit(3); f.objects[2].tile.rx = 10;
        f.objects.push(unit(100, "E2", 18, 0, "enemy")); f.step();
        expect(f.orders.every(order => order[1] !== OrderType.Attack)).toBe(true);
    });
    test("screen retreats from a nearby crusher and refuses unsafe locations", () => {
        const dog = unit(1, "DOG", 10), tank = unit(2, "HTNK", 10);
        const enemy = unit(3, "HTNK", 12, 0, "enemy");
        expect(dogEscortPoint(dog, tank, [enemy], new Vector2(30, 0), 0, () => true)!.x).toBeLessThan(10);
        expect(dogEscortPoint(dog, tank, [], new Vector2(30, 0), 0, () => false)).toBeNull();
    });
});

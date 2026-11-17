import { expect, test } from "bun:test";
import { AttackState, MovementZone, ObjectType, OrderType, SpeedType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";
import { ActionBatcher } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";
import { CombatSquad } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/combatSquad";

function withCohesion(enabled: number, run: () => void) {
    const params = BRUTAL_PARAMS.assault as typeof BRUTAL_PARAMS.assault & Record<string, number>;
    const values = { marchCohesion: enabled, marchLead: 6, marchResume: 3, marchArrive: 10 };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, params[key]]));
    Object.assign(params, values);
    try { run(); } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete params[key];
            else params[key] = value;
        }
    }
}

function fixture() {
    let tick = 0;
    const target = new Vector2(100, 0);
    const units = [60, 50, 50, 50, 40].map((distance, index) => ({
        id: index + 1, name: "HTNK", owner: "bot", type: ObjectType.Vehicle,
        tile: { rx: target.x - distance, ry: 0, z: 0 }, zone: ZoneType.Ground,
        rules: { name: "HTNK", isSelectableCombatant: true, speedType: SpeedType.Track, movementZone: MovementZone.Normal },
        hitPoints: 400, maxHitPoints: 400, canMove: true, isIdle: false, isFiring: false, attackState: AttackState.Idle,
        primaryWeapon: { maxRange: 6, minRange: 0, cooldownTicks: 0, rules: { damage: 90, rof: 60, burst: 1 },
            projectileRules: { isAntiGround: true }, warheadRules: { verses: new Map([[0, 1]]) } },
    }));
    const commands: any[][] = [];
    const game: any = { getCurrentTick: () => tick, getPlayerData: () => ({ startLocation: new Vector2() }),
        getUnitData: (id: number) => units.find(unit => unit.id === id),
        getVisibleUnits: (_player: string, relation: string, filter = (_rules: any) => true) =>
            relation === "enemy" ? [] : units.filter(unit => filter(unit.rules)).map(unit => unit.id),
        mapApi: { getTile: (rx: number, ry: number) => ({ rx, ry, z: 0 }), isPassableTile: () => true } };
    const mission: any = { getUnitIds: () => units.map(unit => unit.id),
        getUnitsMatchingByRule: (_game: any, predicate: (rules: any) => boolean) => units.filter(unit => predicate(unit.rules)).map(unit => unit.id),
        getCenterOfMass: () => new Vector2(50, 0), getMaxDistanceToCenterOfMass: () => 10, getUniqueName: () => "march-fixture" };
    const squad = new CombatSquad(new Vector2(), target, 15);
    return { units, commands, squad,
        step(nextTick = 0) {
            tick = nextTick; commands.length = 0;
            const actionBatcher = new ActionBatcher();
            squad.onAiUpdate({ game, actionBatcher, difficulty: "brutal", player: { name: "bot" },
                matchAwareness: { getHostilesNearPoint: () => [] } } as any, mission, () => {});
            actionBatcher.resolve({ orderUnits: (...args: any[]) => { commands.push(args); } } as any, game.mapApi);
        },
        ids(order: OrderType) { return commands.filter(command => command[1] === order).flatMap(command => command[0]).sort((a, b) => a - b); } };
}

test("F1 off: all five tanks advance to the objective", () => withCohesion(0, () => {
    const f = fixture(); f.step();
    expect(f.ids(OrderType.AttackMove)).toEqual([1, 2, 3, 4, 5]);
    expect(f.ids(OrderType.Stop)).toEqual([]);
}));
test("F1 on: only the tank ten tiles ahead of the median waits", () => withCohesion(1, () => {
    const f = fixture(); f.step();
    expect(f.ids(OrderType.Stop)).toEqual([5]);
    expect(f.ids(OrderType.AttackMove)).toEqual([1, 2, 3, 4]);
}));
test("F1 on: a waiting leader resumes when its lead shrinks to two tiles", () => withCohesion(1, () => {
    const f = fixture(); f.step(); expect(f.ids(OrderType.Stop)).toEqual([5]);
    f.units[4].tile.rx = 52; f.step(6);
    expect(f.ids(OrderType.AttackMove)).toEqual([5]);
    expect(f.ids(OrderType.Stop)).toEqual([]);
}));
test("F1 on: defensive radius disables march waiting", () => withCohesion(1, () => {
    const f = fixture(); f.squad.setDefensiveRadius(7); f.step();
    expect(f.ids(OrderType.Stop)).toEqual([]);
    expect(f.ids(OrderType.AttackMove)).toEqual([1, 2, 3, 4, 5]);
}));

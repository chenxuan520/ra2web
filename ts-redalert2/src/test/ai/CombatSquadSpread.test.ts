import { expect, test } from "bun:test";
import { AttackState, MovementZone, ObjectType, OrderType, SpeedType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { BRUTAL_PARAMS } from "../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams";
import { ActionBatcher } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";
import { CombatSquad } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/combatSquad";

function withSpread(enabled: number, run: () => void) {
    const params = BRUTAL_PARAMS.assault as typeof BRUTAL_PARAMS.assault & Record<string, number>;
    const values = { engageSpread: enabled, spreadSpacing: 2, spreadMaxOffset: 8 };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, params[key]]));
    Object.assign(params, values);
    try { run(); } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete params[key];
            else params[key] = value;
        }
    }
}

function tank(id: number, x: number, y: number) {
    return { id, name: "HTNK", owner: "bot", type: ObjectType.Vehicle, tile: { rx: x, ry: y, z: 0 },
        zone: ZoneType.Ground, hitPoints: 400, maxHitPoints: 400, canMove: true, isIdle: false,
        isFiring: false, attackState: AttackState.Idle,
        rules: { name: "HTNK", armor: 1, isSelectableCombatant: true, speedType: SpeedType.Track, movementZone: MovementZone.Normal },
        primaryWeapon: { maxRange: 6, minRange: 0, cooldownTicks: 0, rules: { damage: 90, rof: 60, burst: 1 },
            projectileRules: { isAntiGround: true }, warheadRules: { verses: new Map([[1, 1]]) } } };
}
function geometry() {
    const units = [10, 11, 12, 13, 14].map((y, index) => tank(index + 1, 10, y));
    const game: any = { mapApi: { getTile: (rx: number, ry: number) => ({ rx, ry, z: 0 }), isPassableTile: () => true } };
    const squad = new CombatSquad(new Vector2(), new Vector2(30, 12), 15);
    return { game, units, squad,
        slot(unit = units[0], target = new Vector2(30, 12)) {
            expect(typeof (squad as any).spreadSlot).toBe("function");
            return (squad as any).spreadSlot(game, unit, units, new Vector2(10, 12), target, 6) as Vector2 | null;
        } };
}

test("F2 firing positions preserve lateral rank at the documented spacing", () => withSpread(1, () => {
    const f = geometry();
    expect(f.units.map(unit => f.slot(unit))).toEqual([8, 10, 12, 14, 16].map(y => new Vector2(25, y)));
}));
test("F2 blocked firing position falls back to the original attack", () => withSpread(1, () => {
    const f = geometry(); f.game.mapApi.isPassableTile = (tile: any) => tile.rx !== 25 || tile.ry !== 8;
    expect(f.slot()).toBeNull();
}));
test("F2 target at the center has no approach direction", () => withSpread(1, () => {
    const f = geometry(); expect(f.slot(f.units[0], new Vector2(10, 12))).toBeNull();
}));
test("F2 switch changes the central tank from direct attack to attack-move firing position", () => {
    for (const enabled of [0, 1]) withSpread(enabled, () => {
        const units = [10, 11, 12, 13, 14].map((y, index) => tank(index + 1, 15, y));
        const enemy = { ...tank(90, 30, 12), owner: "enemy" };
        const game: any = { getCurrentTick: () => 0, getPlayerData: () => ({ startLocation: new Vector2() }),
            getUnitData: (id: number) => [...units, enemy].find(unit => unit.id === id),
            getVisibleUnits: (_player: string, relation: string, filter = (_rules: any) => true) =>
                (relation === "enemy" ? [enemy] : units).filter(unit => filter(unit.rules)).map(unit => unit.id),
            mapApi: { getTile: (rx: number, ry: number) => ({ rx, ry, z: 0 }), isPassableTile: () => true } };
        const mission: any = { getUnitIds: () => units.map(unit => unit.id),
            getUnitsMatchingByRule: (_game: any, filter: (rules: any) => boolean) => units.filter(unit => filter(unit.rules)).map(unit => unit.id),
            getCenterOfMass: () => new Vector2(15, 12), getMaxDistanceToCenterOfMass: () => 2, getUniqueName: () => "spread-fixture" };
        const actionBatcher = new ActionBatcher(), commands: any[][] = [];
        const squad = new CombatSquad(new Vector2(), new Vector2(30, 12), 15);
        squad.onAiUpdate({ game, actionBatcher, difficulty: "brutal", player: { name: "bot" },
            matchAwareness: { getHostilesNearPoint: () => [{ unitId: enemy.id }] } } as any, mission, () => {});
        actionBatcher.resolve({ orderUnits: (...args: any[]) => { commands.push(args); } } as any, game.mapApi);
        const central = commands.filter(command => command[0].includes(3));
        expect(central).toEqual(enabled ? [[[3], OrderType.AttackMove, 25, 12]] : [[[1, 2, 3, 4, 5], OrderType.Attack, 90]]);
    });
});

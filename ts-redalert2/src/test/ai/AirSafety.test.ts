import { expect, test } from "bun:test";
import { ObjectType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { antiAirThreats, getAirEvasionPoint, isAirAttackApproachSafe } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/airSafety";

const weapon = (range = 8, isAntiAir = true) => ({ maxRange: range, rules: { damage: 35, rof: 40 },
    projectileRules: { isAntiAir, isAntiGround: true }, warheadRules: { verses: new Map([[0, 1]]) } });
const unit = (id: number, x: number, y = 0, extra: any = {}): any => ({ id, name: "HTK", type: ObjectType.Vehicle,
    owner: "enemy", zone: ZoneType.Ground, tile: { rx: x, ry: y }, hitPoints: 180, maxHitPoints: 180,
    rules: { armor: 0 }, primaryWeapon: weapon(), ...extra });
const flyer = () => unit(1, 10, 0, { name: "JUMPJET", type: ObjectType.Infantry, zone: ZoneType.Air,
    owner: "bot", primaryWeapon: weapon(5, false) });
const map: any = { getTile: (rx: number, ry: number) => ({ rx, ry }) };

test("rocketeers evade real flak before entering its weapon range", () => {
    const plane = flyer(), flak = unit(2, 1);
    const destination = getAirEvasionPoint(plane, [flak], new Vector2(0, 0), map)!;
    expect(destination.distanceTo(new Vector2(1, 0))).toBeGreaterThan(10);
    expect(antiAirThreats(plane, [flak])).toHaveLength(1);
    expect(getAirEvasionPoint(plane, [flak], new Vector2(), { getTile: () => undefined } as any)).toBeNull();
});

test("ground units, Kirovs and never-use scanners do not trigger rocketeer evasion", () => {
    expect(getAirEvasionPoint(unit(1, 10), [unit(2, 1)], new Vector2(), map)).toBeNull();
    expect(getAirEvasionPoint({ ...flyer(), name: "ZEP" }, [unit(2, 1)], new Vector2(), map)).toBeNull();
    const scanner = unit(2, 1, 0, { primaryWeapon: { ...weapon(), rules: { damage: 1, neverUse: true } } });
    expect(getAirEvasionPoint(flyer(), [scanner], new Vector2(), map)).toBeNull();
    expect(getAirEvasionPoint(flyer(), [unit(2, 1, 0, { primaryWeapon: weapon(8, false) })], new Vector2(), map)).toBeNull();
});

test("a retreat does not turn toward a second known anti-air gun", () => {
    const plane = flyer(), left = unit(2, 1), right = unit(3, 20);
    const destination = getAirEvasionPoint(plane, [left, right], new Vector2(30, 0), map)!;
    expect(destination.distanceTo(new Vector2(1, 0))).toBeGreaterThanOrEqual(9);
    expect(destination.distanceTo(new Vector2(20, 0))).toBeGreaterThanOrEqual(10);
});

test("a safe hover position does not authorize flying into flak to attack a protected target", () => {
    const plane = flyer(); plane.tile.rx = 15;
    const flak = unit(2, 0), protectedTarget = unit(3, 1, 0, { primaryWeapon: undefined });
    expect(isAirAttackApproachSafe(plane, flak, [flak])).toBe(false);
    expect(isAirAttackApproachSafe(plane, protectedTarget, [flak])).toBe(false);
    const exposedTarget = unit(4, 8, 0, { primaryWeapon: undefined });
    expect(isAirAttackApproachSafe(plane, exposedTarget, [flak])).toBe(true);
    expect(isAirAttackApproachSafe(plane, protectedTarget, [])).toBe(true);
});

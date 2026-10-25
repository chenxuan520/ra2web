import { MapApi, UnitData, Vector2, ZoneType } from "../../../../../game-api";
import { distanceToSegment } from "./desolatorTactics";
import { getCombatWeapon } from "./tacticalTargeting";

const point = (unit: UnitData) => new Vector2(unit.tile.rx, unit.tile.ry);

/** Fragile rocketeers must not trade into longer-range flak. Kirovs use a separate doctrine. */
export function antiAirThreats(unit: UnitData, enemies: UnitData[]) {
    return unit.name === "JUMPJET" && unit.zone === ZoneType.Air
        ? enemies.map(enemy => ({ enemy, weapon: getCombatWeapon(enemy, unit, true) })).filter(entry => !!entry.weapon)
        : [];
}

export function getAirEvasionPoint(unit: UnitData, enemies: UnitData[], destination: Vector2, map: MapApi): Vector2 | null {
    const threats = antiAirThreats(unit, enemies);
    const from = point(unit);
    if (!threats.some(({ enemy, weapon }) => from.distanceTo(point(enemy)) < weapon!.range + 2)) return null;
    const risk = (at: Vector2) => threats.reduce((sum, { enemy, weapon }) => sum +
        Math.max(0, weapon!.range + 3 - at.distanceTo(point(enemy))) * weapon!.damage / Math.max(1, weapon!.weapon.rules?.rof ?? 1), 0);
    const current = risk(from);
    const options: { point: Vector2; risk: number }[] = [];
    for (const [dx, dy] of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]) {
        const scale = 4 / Math.hypot(dx, dy);
        const at = new Vector2(Math.round(from.x + dx * scale), Math.round(from.y + dy * scale));
        if (!map.getTile(at.x, at.y) || threats.some(({ enemy }) =>
            distanceToSegment(point(enemy), from, at) < from.distanceTo(point(enemy)) - 0.1)) continue;
        const nextRisk = risk(at);
        if (nextRisk < current) options.push({ point: at, risk: nextRisk });
    }
    return options.sort((a, b) => a.risk - b.risk || a.point.distanceTo(destination) - b.point.distanceTo(destination) ||
        a.point.x - b.point.x || a.point.y - b.point.y)[0]?.point ?? null;
}

/** A safe current position is no reason to accept an AttackTask that flies back into flak. */
export function isAirAttackApproachSafe(unit: UnitData, target: UnitData, enemies: UnitData[]): boolean {
    const threats = antiAirThreats(unit, enemies);
    if (!threats.length) return true;
    const weapon = getCombatWeapon(unit, target, true);
    if (!weapon) return false;
    const from = point(unit), to = point(target), direction = to.clone().sub(from);
    const distance = direction.length();
    if (distance > weapon.range - 0.5) direction.multiplyScalar(Math.max(0, distance - weapon.range + 0.5) / distance);
    else direction.multiplyScalar(0);
    const firingPosition = from.clone().add(direction);
    return threats.every(({ enemy, weapon }) => distanceToSegment(point(enemy), from, firingPosition) >= weapon!.range + 2);
}

/** Nearby flak must not pin a safe flyer in place when its objective is away from the guns. */
export function getAirTransitWaypoint(unit: UnitData, destination: Vector2, enemies: UnitData[], map: MapApi): Vector2 | null {
    const threats = antiAirThreats(unit, enemies), from = point(unit);
    const options: Vector2[] = [];
    const direct = destination.clone().sub(from);
    if (direct.length() <= 1) return null;
    direct.multiplyScalar(Math.min(4, direct.length()) / direct.length());
    for (const direction of [direct, ...[[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
        .map(([x, y]) => new Vector2(x, y).multiplyScalar(4 / Math.hypot(x, y)))]) {
        const to = from.clone().add(direction);
        to.set(Math.round(to.x), Math.round(to.y));
        if (!map.getTile(to.x, to.y) || to.distanceTo(destination) >= from.distanceTo(destination) - 0.25) continue;
        if (threats.every(({ enemy, weapon }) => distanceToSegment(point(enemy), from, to) >= weapon!.range + 2)) options.push(to);
    }
    return options.sort((a, b) => a.distanceTo(destination) - b.distanceTo(destination) || a.x - b.x || a.y - b.y)[0] ?? null;
}

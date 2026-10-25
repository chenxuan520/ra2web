import { MapApi, ObjectType, UnitData, Vector2, ZoneType } from "../../../../../game-api";
import { getCombatWeapon } from "./tacticalTargeting";

/** Use tracked armor against a local infantry mass instead of trading cannon shells with rifles. */
export function getInfantryCrushPoint(unit: UnitData, enemies: UnitData[], map: MapApi): Vector2 | null {
    if (!unit.rules.crusher || !unit.canMove || unit.zone === ZoneType.Air || unit.onBridge ||
        (unit.passengerSlotCount ?? 0) > 0 || unit.hitPoints < unit.maxHitPoints * 0.55) return null;
    const origin = new Vector2(unit.tile.rx, unit.tile.ry);
    const infantry = enemies.filter(enemy => (enemy.type as any) === ObjectType.Infantry && enemy.rules.crushable &&
        enemy.zone !== ZoneType.Air && !enemy.onBridge && origin.distanceTo(new Vector2(enemy.tile.rx, enemy.tile.ry)) <= 8);
    if (infantry.length < 2) return null;
    if (enemies.some(enemy => (enemy.type as any) !== ObjectType.Infantry && !enemy.rules.harvester && getCombatWeapon(enemy, unit, true) &&
        origin.distanceTo(new Vector2(enemy.tile.rx, enemy.tile.ry)) <= 9)) return null;
    const target = [...infantry].sort((a, b) => origin.distanceTo(new Vector2(a.tile.rx, a.tile.ry)) -
        origin.distanceTo(new Vector2(b.tile.rx, b.tile.ry)) || a.id - b.id)[0];
    const direction = new Vector2(target.tile.rx, target.tile.ry).sub(origin);
    if (!direction.length()) direction.set(1, 0);
    direction.multiplyScalar(2 / direction.length());
    const destination = new Vector2(Math.round(target.tile.rx + direction.x), Math.round(target.tile.ry + direction.y));
    const steps = Math.max(Math.abs(destination.x - origin.x), Math.abs(destination.y - origin.y));
    for (let step = 1; step <= steps; step++) {
        const tile = map.getTile(Math.round(origin.x + (destination.x - origin.x) * step / steps),
            Math.round(origin.y + (destination.y - origin.y) * step / steps));
        if (!tile || tile.z !== unit.tile.z || map.hasBridgeOnTile(tile) ||
            !map.isPassableTile(tile, unit.rules.speedType, false, false)) return null;
    }
    return destination;
}

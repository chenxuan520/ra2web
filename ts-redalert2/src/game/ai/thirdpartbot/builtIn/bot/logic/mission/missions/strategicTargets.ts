import { estimatedCombatWeapons, isObservedLivingUnit, estimatedHealthRatio } from "../../common/observedUnit";
import { GameApi, ObjectType, UnitData, Vector2, ZoneType } from "../../../../game-api";
import { SupabotContext } from "../../common/context";
import { isOwnedByNeutral } from "../../common/utils";
import { getCombatWeapon } from "./squads/tacticalTargeting";

export const RAID_TARGET_SEPARATION = 12;
export const RAID_SIZE = 3;

export function isLivingUnit(unit: UnitData | undefined | null): unit is UnitData {
    return isObservedLivingUnit(unit);
}

export function isRaidTank(unit: UnitData): boolean {
    return (unit.name === "MTNK" || unit.name === "HTNK") && isLivingUnit(unit) &&
        unit.hitPoints >= unit.maxHitPoints * 0.7 && unit.zone !== ZoneType.Air;
}

export function visibleEnemies(context: SupabotContext): UnitData[] {
    return context.game.getVisibleUnits(context.player.name, "enemy")
        .map(id => context.game.getUnitData(id))
        .filter((unit): unit is UnitData => isLivingUnit(unit) && !isOwnedByNeutral(unit))
        .sort((a, b) => a.id - b.id);
}

export function findBaseThreat(context: SupabotContext): Vector2 | undefined {
    const { game, player, matchAwareness } = context;
    const bases = game.getVisibleUnits(player.name, "self", rules =>
        rules.constructionYard || rules.refinery || rules.weaponsFactory || rules.name === "AMCV" || rules.name === "SMCV")
        .map(id => game.getGameObjectData(id)).filter(unit => !!unit).sort((a, b) => a!.id - b!.id);
    for (const base of bases) {
        const point = new Vector2(base!.tile.rx, base!.tile.ry);
        const threatened = matchAwareness.getHostilesNearPoint2d(point, 12)
            .map(({ unitId }) => game.getUnitData(unitId))
            .some(unit => isLivingUnit(unit) && !isOwnedByNeutral(unit) && estimatedCombatWeapons(unit, game).some(Boolean));
        if (threatened) return point;
    }
    return undefined;
}

export function raidTargetIsSafe(target: UnitData, raiders: UnitData[], enemies: UnitData[], game?: GameApi): boolean {
    if (!raiders.length || !isLivingUnit(target) || target.zone === ZoneType.Air ||
        !(target.rules.harvester || ((target.type as any) === ObjectType.Building && (target.rules.refinery || target.rules.power > 0)))) return false;
    if (!raiders.some(raider => getCombatWeapon(raider, target, false, game))) return false;
    const targetPoint = new Vector2(target.tile.rx, target.tile.ry);
    let guards = 0;
    for (const enemy of enemies) {
        if (enemy.id === target.id) continue;
        const weapon = getCombatWeapon(enemy, raiders[0], false, game);
        if (!weapon) continue;
        const distance = targetPoint.distanceTo(new Vector2(enemy.tile.rx, enemy.tile.ry));
        if ((enemy.type as any) === ObjectType.Building) {
            if (distance <= weapon.range + 3) return false;
        } else if (distance <= Math.max(10, weapon.range + 2)) {
            const isHeavyGuard = (enemy.type as any) !== ObjectType.Infantry ||
                !enemy.rules.crushable || (weapon.damage >= 40);
            guards += isHeavyGuard ? 1 : 0.3;
        }
    }
    return guards <= Math.floor(raiders.length / 2);
}

export function raidUnderPressure(raiders: UnitData[], enemies: UnitData[], game?: GameApi): boolean {
    if (!raiders.length) return true;
    let nearbyFighters = 0;
    for (const enemy of enemies) {
        if (enemy.rules.harvester) continue;
        const weapon = getCombatWeapon(enemy, raiders[0], false, game);
        if (!weapon) continue;
        const distance = Math.min(...raiders.map(raider =>
            new Vector2(raider.tile.rx, raider.tile.ry).distanceTo(new Vector2(enemy.tile.rx, enemy.tile.ry))));
        if ((enemy.type as any) === ObjectType.Building && distance <= weapon.range + 2) return true;
        if (distance <= 10) nearbyFighters++;
    }
    return nearbyFighters > raiders.length;
}

export function selectRaidTarget(context: SupabotContext, raiders: UnitData[], mainTargets: Vector2[]): UnitData | undefined {
    if (!raiders.length) return undefined;
    const enemies = visibleEnemies(context);
    const center = new Vector2(raiders.reduce((sum, unit) => sum + unit.tile.rx, 0) / raiders.length,
        raiders.reduce((sum, unit) => sum + unit.tile.ry, 0) / raiders.length);
    return enemies.filter(target => {
        const point = new Vector2(target.tile.rx, target.tile.ry);
        return mainTargets.every(main => main.distanceTo(point) >= RAID_TARGET_SEPARATION) &&
            raidTargetIsSafe(target, raiders, enemies, context.game);
    }).map(target => ({ target, score: (target.rules.harvester ? 2000 : 500) +
        (1 - (estimatedHealthRatio(target, context.game) ?? 1)) * 100 - center.distanceTo(new Vector2(target.tile.rx, target.tile.ry)) }))
        .sort((a, b) => b.score - a.score || a.target.id - b.target.id)[0]?.target;
}

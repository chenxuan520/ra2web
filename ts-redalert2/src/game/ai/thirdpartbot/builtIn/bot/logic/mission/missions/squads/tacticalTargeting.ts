import { AttackState, GameMath, MapApi, ObjectType, StanceType, UnitData, Vector2, ZoneType } from "../../../../../game-api";
import { getDistanceBetweenUnits } from "../../../map/map";

/** Uses the same visible weapon/armor information supplied by the game API. */
export function getCombatWeapon(attacker: UnitData, target: UnitData) {
    if (target.isWarpedOut || (target.hitPoints !== undefined && target.hitPoints <= 0)) return null;
    let best: { weapon: any; damage: number; range: number } | null = null;
    for (const weapon of [attacker.primaryWeapon, attacker.secondaryWeapon]) {
        if (!weapon || weapon.rules?.neverUse) continue;
        const projectile = weapon.projectileRules;
        if (target.zone === ZoneType.Air ? !projectile?.isAntiAir : !projectile?.isAntiGround) continue;
        // Buildings have no zone; waterborne units also require an anti-ground weapon.
        const multiplier = weapon.warheadRules?.verses?.get(target.rules.armor) ?? 1;
        if (multiplier <= 0) continue;
        const special = weapon.warheadRules?.temporal || weapon.warheadRules?.mindControl || weapon.warheadRules?.parasite;
        const damage = Math.max(0, weapon.rules?.damage ?? 0) * Math.max(1, weapon.rules?.burst ?? 1) * multiplier;
        if (damage <= 0 && !special) continue;
        const effectiveDamage = damage || Math.max(1, target.hitPoints ?? 100);
        const candidate = { weapon, damage: effectiveDamage, range: weapon.maxRange ?? 0 };
        if (!best || candidate.damage / Math.max(1, weapon.rules?.rof ?? 1) >
            best.damage / Math.max(1, best.weapon.rules?.rof ?? 1)) best = candidate;
    }
    return best;
}

export function isFiringBurst(unit: UnitData): boolean {
    return [AttackState.PrepareToFire, AttackState.FireUp, AttackState.Firing].includes(unit.attackState as any);
}

/** Deterministic, armor-aware focus fire with a per-update volley reservation. */
export function chooseTacticalTarget(
    attacker: UnitData,
    targets: UnitData[],
    committedDamage: Map<number, number>,
    currentTargetId?: number,
): UnitData | null {
    const currentTarget = targets.find(target => target.id === currentTargetId);
    if (currentTarget && isFiringBurst(attacker) && getCombatWeapon(attacker, currentTarget)) return currentTarget;

    let best: UnitData | null = null;
    let bestScore = -Infinity;
    for (const target of targets) {
        const attack = getCombatWeapon(attacker, target);
        if (!attack) continue;
        const distance = getDistanceBetweenUnits(attacker, target);
        const committed = committedDamage.get(target.id) ?? 0;
        const remainingHealth = Math.max(1, (target.hitPoints ?? target.maxHitPoints ?? 100) - committed);
        const threat = getCombatWeapon(target, attacker);
        const damageEfficiency = attack.damage / Math.max(1,
            Math.abs(attack.weapon.rules?.damage ?? attack.damage) * Math.max(1, attack.weapon.rules?.burst ?? 1));
        let score = 40 * Math.min(2, damageEfficiency) + 60 * Math.min(1, attack.damage / remainingHealth);
        score += threat ? 40 + Math.min(40, threat.damage / Math.max(1, threat.weapon.rules?.rof ?? 1) * 4) : 0;
        if (target.rules.harvester) score += 30;
        else if (target.rules.constructionYard || target.rules.weaponsFactory) score += 20;
        else if (target.rules.power > 0) score += 10;
        // Never march past something we can shoot to chase a slightly higher value target.
        score += distance <= attack.range ? 35 : -12 * (distance - attack.range);
        score -= distance * 1.5;
        if (committed > 0) score += 25;
        if (target.id === currentTargetId) score += 15;
        if (committed >= (target.hitPoints ?? target.maxHitPoints ?? 100)) score -= 160;
        if (score > bestScore || (score === bestScore && target.id < (best?.id ?? Infinity))) {
            best = target;
            bestScore = score;
        }
    }
    return best;
}

/** Pull injured units out of enemy range and kite only during a known weapon cooldown. */
export function getTacticalRetreatPoint(attacker: UnitData, targets: UnitData[], mapApi: MapApi): Vector2 | null {
    if (!attacker.canMove || attacker.zone === ZoneType.Air || attacker.rules.speedType === undefined ||
        (attacker.stance as any) === StanceType.Deployed || isFiringBurst(attacker)) return null;
    let nearestThreat: UnitData | undefined;
    let nearestDistance = Infinity;
    let threatRange = 0;
    for (const target of targets) {
        const weapon = getCombatWeapon(target, attacker);
        if (!weapon) continue;
        const distance = getDistanceBetweenUnits(attacker, target);
        if (distance <= weapon.range + 1 && distance < nearestDistance) {
            nearestThreat = target;
            nearestDistance = distance;
            threatRange = weapon.range;
        }
    }
    if (!nearestThreat) return null;
    const ownWeapon = getCombatWeapon(attacker, nearestThreat);
    const injured = (attacker.hitPoints ?? Infinity) < (attacker.maxHitPoints ?? 0) * 0.3;
    const canKite = ownWeapon && ownWeapon.range >= threatRange + 1.5 &&
        ownWeapon.weapon.cooldownTicks > 6 && nearestDistance < ownWeapon.range - 0.5;
    if (!injured && !canKite) return null;

    // Integer tile destinations are stable across clients; the game still validates pathfinding.
    const dx = attacker.tile.rx - nearestThreat.tile.rx;
    const dy = attacker.tile.ry - nearestThreat.tile.ry;
    const length = Math.max(1, GameMath.sqrt(dx * dx + dy * dy));
    const distance = injured ? 3 : 2;
    const point = new Vector2(Math.round(attacker.tile.rx + dx / length * distance),
        Math.round(attacker.tile.ry + dy / length * distance));
    if (point.x === attacker.tile.rx && point.y === attacker.tile.ry) return null;
    const tile = mapApi.getTile(point.x, point.y);
    if (!tile || !mapApi.isPassableTile(tile, attacker.rules.speedType, !!attacker.onBridge,
        (attacker.type as any) === ObjectType.Infantry)) return null;
    return point;
}

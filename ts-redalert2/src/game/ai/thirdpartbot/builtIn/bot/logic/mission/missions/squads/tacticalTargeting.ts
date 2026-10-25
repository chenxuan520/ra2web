import { AttackState, GameMath, MapApi, ObjectType, StanceType, UnitData, Vector2, ZoneType } from "../../../../../game-api";
import { getDistanceBetweenUnits } from "../../../map/map";

/** Uses the same visible weapon/armor information supplied by the game API. */
export function getCombatWeapon(attacker: UnitData, target: UnitData, currentStanceOnly = false) {
    if (target.isWarpedOut || (target.hitPoints !== undefined && target.hitPoints <= 0)) return null;
    let best: { weapon: any; damage: number; range: number; damageKnown: boolean } | null = null;
    let weapons = [attacker.primaryWeapon, attacker.secondaryWeapon];
    // AttackTrait allows only the current stance's weapon for deploy-fire units.
    // An area deploy weapon fires at its own tile, never at a selected enemy.
    if (currentStanceOnly && attacker.rules.deployFire) {
        const deployedWeapon = attacker.rules.deployFireWeapon === 0 ? attacker.primaryWeapon : attacker.secondaryWeapon;
        weapons = (attacker.stance as any) === StanceType.Deployed
            ? [deployedWeapon?.rules.areaFire ? undefined : deployedWeapon]
            : weapons.filter(weapon => weapon !== deployedWeapon);
    }
    for (const weapon of weapons) {
        if (!weapon || weapon.rules?.neverUse) continue;
        if (currentStanceOnly && (weapon.rules?.areaFire ||
            (weapon.warheadRules?.radiation && (target.rules.immuneToRadiation || (target.type as any) === ObjectType.Building)))) continue;
        const projectile = weapon.projectileRules;
        if (target.zone === ZoneType.Air ? !projectile?.isAntiAir : !projectile?.isAntiGround) continue;
        // Buildings have no zone; waterborne units also require an anti-ground weapon.
        const multiplier = weapon.warheadRules?.verses?.get(target.rules.armor) ?? 1;
        if (multiplier <= 0) continue;
        const special = weapon.warheadRules?.temporal || weapon.warheadRules?.mindControl || weapon.warheadRules?.parasite;
        const damageKnown = !weapon.rules?.spawner;
        const damage = Math.max(0, weapon.rules?.damage ?? 0) * Math.max(1, weapon.rules?.burst ?? 1) * multiplier;
        if (damage <= 0 && !special && damageKnown) continue;
        // Spawner Damage=1 controls launching a separate unit; it is not a
        // missile impact estimate and must not reserve a fictitious volley.
        const effectiveDamage = currentStanceOnly && !damageKnown ? 0 : damage || Math.max(1, target.hitPoints ?? 100);
        const candidate = { weapon, damage: effectiveDamage, range: weapon.maxRange ?? 0, damageKnown };
        if (!best || candidate.damage / Math.max(1, weapon.rules?.rof ?? 1) >
            best.damage / Math.max(1, best.weapon.rules?.rof ?? 1)) best = candidate;
    }
    return best;
}

export function isMissileArtillery(unit: UnitData): boolean {
    return unit.name === "V3" && !!unit.primaryWeapon?.rules.spawner;
}

export function isFiringBurst(unit: UnitData): boolean {
    if (unit.isFiring || [AttackState.FireUp, AttackState.Firing].includes(unit.attackState as any)) return true;
    if ((unit.attackState as any) !== AttackState.PrepareToFire) return false;
    // AttackTask stays in PrepareToFire for the entire ROF cooldown. A real
    // positive cooldown proves the first shot has fired; zero/unknown cooldown
    // still protects initial aiming. Keep multishot bursts and missile launches
    // protected because the API does not expose their remaining sub-shots.
    const weapons = [unit.primaryWeapon, unit.secondaryWeapon].filter(weapon => weapon && !weapon.rules?.areaFire);
    const knownRecovery = unit.isFiring === false && weapons.length > 0 &&
        weapons.every(weapon => !weapon.rules?.spawner && (weapon.rules?.burst ?? 1) <= 1) &&
        weapons.some(weapon => Number.isFinite(weapon.cooldownTicks) && weapon.cooldownTicks > 6);
    return !knownRecovery;
}

/** Deterministic, armor-aware focus fire with a per-update volley reservation. */
export function chooseTacticalTarget(
    attacker: UnitData,
    targets: UnitData[],
    committedDamage: Map<number, number>,
    currentTargetId?: number,
): UnitData | null {
    if (isMissileArtillery(attacker)) targets = targets.filter(target => (target.type as any) === ObjectType.Building);
    if (attacker.name === "ZEP") targets = targets.filter(target => (target.type as any) === ObjectType.Building ||
        getDistanceBetweenUnits(attacker, target) <= (attacker.primaryWeapon?.maxRange ?? 0) + 0.5 ||
        !!getCombatWeapon(target, attacker, true));
    const currentTarget = targets.find(target => target.id === currentTargetId);
    if (currentTarget && isFiringBurst(attacker) && getCombatWeapon(attacker, currentTarget)) return currentTarget;

    let best: UnitData | null = null;
    let bestScore = -Infinity;
    for (const target of targets) {
        // Rank an engagement, including a GI's available deployment. Do not
        // discard every alternative merely because one target is within a
        // nominal range: terrain and stance can still prevent that shot.
        // Command execution and volley reservation validate the current stance.
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
export function getTacticalRetreatPoint(attacker: UnitData, targets: UnitData[], mapApi: MapApi,
    isSafeMove: (point: Vector2) => boolean = () => true): Vector2 | null {
    if (!attacker.canMove || attacker.zone === ZoneType.Air || attacker.rules.speedType === undefined ||
        (attacker.stance as any) === StanceType.Deployed || isFiringBurst(attacker)) return null;
    let nearestThreat: UnitData | undefined;
    let nearestDistance = Infinity;
    let threatRange = 0;
    for (const target of targets) {
        const weapon = getCombatWeapon(target, attacker, true);
        const distance = getDistanceBetweenUnits(attacker, target);
        const attack = getCombatWeapon(attacker, target, true);
        const needsMinimumRange = attack && distance < (attack.weapon.minRange ?? 0);
        if ((needsMinimumRange || (weapon && distance >= (weapon.weapon.minRange ?? 0) && distance <= weapon.range + 1)) &&
            distance < nearestDistance) {
            nearestThreat = target;
            nearestDistance = distance;
            threatRange = weapon?.range ?? 0;
        }
    }
    if (!nearestThreat) return null;
    const ownWeapon = getCombatWeapon(attacker, nearestThreat, true);
    const injured = (attacker.hitPoints ?? Infinity) < (attacker.maxHitPoints ?? 0) * 0.3;
    const canKite = ownWeapon && ownWeapon.range >= threatRange + 1.5 &&
        ownWeapon.weapon.cooldownTicks > 6 && nearestDistance < ownWeapon.range - 0.5;
    const insideMinimumRange = ownWeapon && nearestDistance < (ownWeapon.weapon.minRange ?? 0);
    if (!injured && !canKite && !insideMinimumRange) return null;

    // Integer tile destinations are stable across clients; the game still validates pathfinding.
    const dx = attacker.tile.rx - nearestThreat.tile.rx;
    const dy = attacker.tile.ry - nearestThreat.tile.ry;
    const distance = injured ? 3 : 2;
    const threats = targets.map(target => ({ target, weapon: getCombatWeapon(target, attacker, true) }))
        .filter(entry => !!entry.weapon);
    const minimumRangePenalty = (point: Vector2) => Math.max(0, (ownWeapon?.weapon.minRange ?? 0) -
        point.distanceTo(new Vector2(nearestThreat!.tile.rx, nearestThreat!.tile.ry)));
    const riskAt = (point: Vector2) => threats.reduce((total, { target, weapon }) => {
        const distance = point.distanceTo(new Vector2(target.tile.rx, target.tile.ry));
        return total + (distance < (weapon!.weapon.minRange ?? 0) ? 0 : Math.max(0, weapon!.range + 1 - distance) *
            weapon!.damage / Math.max(1, weapon!.weapon.rules?.rof ?? 1));
    }, minimumRangePenalty(point));
    const origin = new Vector2(attacker.tile.rx, attacker.tile.ry);
    const currentRisk = riskAt(origin);
    let best: Vector2 | null = null;
    let bestRisk = currentRisk;
    // Look to either side when a straight retreat is blocked. Never move into a
    // second gun line merely because it is farther from the closest opponent.
    for (const [vx, vy] of [[dx, dy], [dx - dy, dy + dx], [dx + dy, dy - dx]]) {
        const norm = Math.max(1, GameMath.sqrt(vx * vx + vy * vy));
        const point = new Vector2(Math.round(origin.x + vx / norm * distance), Math.round(origin.y + vy / norm * distance));
        if (point.equals(origin) || !isSafeMove(point)) continue;
        if (!injured && ownWeapon && point.distanceTo(new Vector2(nearestThreat.tile.rx, nearestThreat.tile.ry)) > ownWeapon.range) continue;
        const steps = Math.max(Math.abs(point.x - origin.x), Math.abs(point.y - origin.y));
        let passable = true;
        for (let step = 1; step <= steps; step++) {
            const tile = mapApi.getTile(Math.round(origin.x + (point.x - origin.x) * step / steps),
                Math.round(origin.y + (point.y - origin.y) * step / steps));
            if (!tile || !mapApi.isPassableTile(tile, attacker.rules.speedType, !!attacker.onBridge,
                (attacker.type as any) === ObjectType.Infantry)) {
                passable = false; break;
            }
        }
        if (!passable) continue;
        if (mapApi.findPath) {
            const start = mapApi.getTile(origin.x, origin.y), end = mapApi.getTile(point.x, point.y);
            if (!start || !end) continue;
            const path = mapApi.findPath(attacker.rules.speedType,
                { tile: start, onBridge: !!attacker.onBridge }, { tile: end, onBridge: !!attacker.onBridge },
                { bestEffort: false, maxExpandedNodes: 64 }).slice().reverse();
            const last = path.at(-1)?.tile;
            if (!last || last.rx !== point.x || last.ry !== point.y ||
                path.some(node => node.onBridge !== !!attacker.onBridge || !isSafeMove(new Vector2(node.tile.rx, node.tile.ry)))) continue;
        }
        const risk = riskAt(point);
        if (risk < bestRisk) { bestRisk = risk; best = point; }
    }
    return best;
}

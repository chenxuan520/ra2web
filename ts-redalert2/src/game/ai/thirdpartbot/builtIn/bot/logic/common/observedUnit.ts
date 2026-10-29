import { HealthLevel } from "@/game/gameobject/unit/HealthLevel";
import { GameApi, GameObjectData, UnitData } from "../../../game-api";

type HealthObservation = Pick<GameObjectData, "hitPoints" | "maxHitPoints" | "rules"> & { healthLevel?: HealthLevel };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Exact own/shared-intel ratio; otherwise the upper endpoint of the visible
 * health-color interval. This conservative estimate is not a measured ratio.
 * Public display thresholds come from this game's rules, never hidden HP.
 */
export function estimatedHealthRatio(unit: HealthObservation, game?: GameApi): number | undefined {
    if (finite(unit.hitPoints) && finite(unit.maxHitPoints) && unit.maxHitPoints > 0) {
        return Math.max(0, Math.min(1, unit.hitPoints / unit.maxHitPoints));
    }
    if (unit.healthLevel === HealthLevel.Green) return 1;
    const conditions = game?.rulesApi?.healthDisplayConditions;
    const red = conditions?.conditionRed, yellow = conditions?.conditionYellow;
    if (!finite(red) || !finite(yellow) || red < 0 || yellow < red || yellow > 1) return undefined;
    if (unit.healthLevel === HealthLevel.Yellow) return yellow;
    if (unit.healthLevel === HealthLevel.Red) return red;
    return undefined;
}

/** Missing private HP is unknown, not evidence that a visible unit is dead. */
export function isObservedLivingUnit(unit: UnitData | null | undefined): unit is UnitData {
    return !!unit && !unit.isWarpedOut && !(finite(unit.hitPoints) && unit.hitPoints <= 0);
}

/** An apparent type's public strength is an estimate, never the real object's maximum HP. */
export function estimatedMaxHitPoints(unit: HealthObservation): number | undefined {
    if (finite(unit.maxHitPoints) && unit.maxHitPoints > 0) return unit.maxHitPoints;
    const nominal = unit.rules?.strength;
    return finite(nominal) && nominal > 0 ? nominal : undefined;
}

export function estimatedHitPoints(unit: HealthObservation, game?: GameApi): number | undefined {
    if (finite(unit.hitPoints)) return Math.max(0, unit.hitPoints);
    const maximum = estimatedMaxHitPoints(unit), ratio = estimatedHealthRatio(unit, game);
    return maximum !== undefined && ratio !== undefined ? maximum * ratio : undefined;
}

export function estimatedPurchaseValue(unit: UnitData): number | undefined {
    if (finite(unit.purchaseValue)) return unit.purchaseValue;
    return finite(unit.rules?.cost) ? unit.rules.cost : undefined;
}

/**
 * Own/shared-intel weapon instances remain exact, including stance/IFV loadout
 * and cooldown. For external observations use only the apparent type's public
 * base weapon specifications. These are nominal threat estimates: no veteran,
 * hidden passenger, runtime range bonus, current target or cooldown is inferred.
 * Never write these estimates back into UnitData's actual weapon fields.
 */
export function estimatedCombatWeapons(unit: UnitData, game?: GameApi): [any | undefined, any | undefined] {
    const completeInventory = finite(unit.hitPoints) || finite(unit.purchaseValue);
    const estimate = (actual: any, name: string | undefined) => {
        if (actual || completeInventory || !name || !game?.rulesApi?.getWeapon) return actual;
        const rules = game.rulesApi.getWeapon(name);
        if (!rules) return undefined;
        return {
            estimateSource: "apparent-base-rules",
            rules,
            projectileRules: game.rulesApi.getProjectile(rules.projectile),
            warheadRules: game.rulesApi.getWarhead(rules.warhead),
            minRange: rules.minimumRange,
            maxRange: rules.range,
        };
    };
    return [estimate(unit.primaryWeapon, unit.rules?.primary), estimate(unit.secondaryWeapon, unit.rules?.secondary)];
}

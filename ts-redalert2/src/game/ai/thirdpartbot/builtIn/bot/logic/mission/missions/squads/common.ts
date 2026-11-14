import { AttackState, GameApi, ObjectType, OrderType, StanceType, UnitData, Vector2, ZoneType } from "../../../../../game-api";
import { getDistanceBetweenPoints, getDistanceBetweenUnits } from "../../../map/map";
import { BatchableAction } from "../../actionBatcher";
import { getCombatWeapon, isFiringBurst } from "./tacticalTargeting";

const NONCE_GI_DEPLOY = 0;
const NONCE_GI_UNDEPLOY = 1;

// Micro methods
export function manageMoveMicro(attacker: UnitData, attackPoint: Vector2, difficulty?: "normal" | "brutal"): BatchableAction {
    if (attacker.name === "E1") {
        const isDeployed = (attacker.stance as any) === StanceType.Deployed;
        if (isDeployed) {
            if (difficulty === "brutal") return BatchableAction.toTargetId(attacker.id, OrderType.Deploy, attacker.id, NONCE_GI_UNDEPLOY);
            return BatchableAction.noTarget(attacker.id, OrderType.DeploySelected, NONCE_GI_UNDEPLOY);
        }
    }

    return BatchableAction.toPoint(attacker.id, OrderType.AttackMove, attackPoint);
}

export function manageAttackMicro(attacker: UnitData, target: UnitData, difficulty?: "normal" | "brutal", game?: GameApi): BatchableAction {
    const distance = getDistanceBetweenUnits(attacker, target);
    if (attacker.name === "E1") {
        // Para (deployed weapon) range is 5.
        const deployedWeaponRange = attacker.secondaryWeapon?.maxRange || 5;
        const isDeployed = (attacker.stance as any) === StanceType.Deployed;
        if (difficulty === "brutal" && game && (target.type as any) === ObjectType.Building && target.rules.deathWeapon && !isFiringBurst(attacker)) {
            const deathWeapon = game.rulesApi?.getWeapon?.(target.rules.deathWeapon);
            const blastRadius = deathWeapon?.damage > 0 ? game.rulesApi.getWarhead(deathWeapon.warhead)?.cellSpread ?? 0 : 0;
            const safeGap = blastRadius + 0.5;
            if (blastRadius > 0 && deployedWeaponRange >= safeGap) {
                const min = new Vector2(target.tile.rx, target.tile.ry);
                const max = min.clone().add(new Vector2((target.foundation?.width ?? 1) - 1, (target.foundation?.height ?? 1) - 1));
                const distanceToFoundation = (point: Vector2) => Math.hypot(Math.max(min.x - point.x, 0, point.x - max.x),
                    Math.max(min.y - point.y, 0, point.y - max.y));
                const origin = new Vector2(attacker.tile.rx, attacker.tile.ry), gap = distanceToFoundation(origin);
                if (gap < safeGap) {
                    if (isDeployed) return BatchableAction.toTargetId(attacker.id, OrderType.Deploy, attacker.id, NONCE_GI_UNDEPLOY);
                    const away = origin.clone().sub(min.clone().add(max).multiplyScalar(0.5));
                    const proposed = origin.clone().add(away.multiplyScalar((blastRadius + 1 - gap) / Math.max(1, away.length())));
                    proposed.set(Math.round(proposed.x), Math.round(proposed.y));
                    const safePositions: Vector2[] = [];
                    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
                        const point = proposed.clone().add(new Vector2(dx, dy)), distance = distanceToFoundation(point);
                        const tile = game.mapApi.getTile(point.x, point.y);
                        if (distance < safeGap || distance > deployedWeaponRange || !tile ||
                            !game.mapApi.isVisibleTile(tile, attacker.owner) ||
                            !game.mapApi.isPassableTile(tile, attacker.rules.speedType, !!attacker.onBridge, true)) continue;
                        safePositions.push(point);
                    }
                    safePositions.sort((a, b) => origin.distanceToSquared(a) - origin.distanceToSquared(b) || a.x - b.x || a.y - b.y);
                    if (safePositions[0]) return BatchableAction.toPoint(attacker.id, OrderType.Move, safePositions[0]);
                } else if (gap <= deployedWeaponRange) {
                    // Use the visible foundation edge, not the top-left tile, from this safe firing position.
                    return isDeployed ? BatchableAction.toTargetId(attacker.id, OrderType.Attack, target.id)
                        : BatchableAction.noTarget(attacker.id, OrderType.DeploySelected, NONCE_GI_DEPLOY);
                }
            }
        }
        if (!isDeployed && (distance <= deployedWeaponRange || (attacker.attackState as any) === AttackState.JustFired)) {
            return BatchableAction.noTarget(attacker.id, OrderType.DeploySelected, NONCE_GI_DEPLOY);
        } else if (isDeployed && distance > deployedWeaponRange + 1.5) {
            if (difficulty === "brutal") return BatchableAction.toTargetId(attacker.id, OrderType.Deploy, attacker.id, NONCE_GI_UNDEPLOY);
            return BatchableAction.noTarget(attacker.id, OrderType.DeploySelected, NONCE_GI_UNDEPLOY);
        }
    }
    let targetData = target;
    let orderType: OrderType = OrderType.Attack;
    const primaryWeaponRange = attacker.primaryWeapon?.maxRange || 5;
    if ((targetData?.type as any) == ObjectType.Building && distance < primaryWeaponRange * 0.8) {
        orderType = OrderType.Attack;
    } else if (targetData?.rules.canDisguise) {
        // Special case for mirage tank/spy as otherwise they just sit next to it.
        orderType = OrderType.Attack;
    }
    return BatchableAction.toTargetId(attacker.id, orderType, target.id);
}

/**
 *
 * @param attacker
 * @param target
 * @returns A number describing the weight of the given target for the attacker, or null if it should not attack it.
 */
export function getAttackWeight(attacker: UnitData, target: UnitData): number | null {
    const { rx: x, ry: y } = attacker.tile;
    const { rx: hX, ry: hY } = target.tile;

    if (!getCombatWeapon(attacker, target)) return null;

    return 1000000 - getDistanceBetweenPoints(new Vector2(x, y), new Vector2(hX, hY));
}

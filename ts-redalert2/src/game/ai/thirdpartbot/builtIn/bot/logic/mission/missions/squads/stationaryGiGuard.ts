import { OrderType, StanceType, UnitData } from "../../../../../game-api";
import { MissionContext } from "../../../common/context";
import { isOwnedByNeutral } from "../../../common/utils";
import { getDistanceBetweenUnits } from "../../../map/map";
import { BatchableAction } from "../../actionBatcher";
import { getCombatWeapon, isFiringBurst } from "./tacticalTargeting";

/** Deploy waiting GIs in place; do not issue movement or pursuit orders. */
export class StationaryGiGuard {
    private lastScanTick = -Infinity;
    private lastDeployTick = new Map<number, number>();

    onAiUpdate(context: MissionContext, units: UnitData[]): void {
        if (context.difficulty !== "brutal") return;
        const tick = context.game.getCurrentTick();
        if (tick < this.lastScanTick + 6) return;
        this.lastScanTick = tick;
        const currentIds = new Set(units.map(unit => unit.id));
        for (const id of this.lastDeployTick.keys()) if (!currentIds.has(id)) this.lastDeployTick.delete(id);

        for (const unit of units) {
            const weapon = unit.secondaryWeapon;
            const range = weapon?.maxRange;
            if (unit.name !== "E1" || !unit.isIdle || unit.isWarpedOut || isFiringBurst(unit) ||
                (unit.stance as any) === StanceType.Deployed || !Number.isFinite(range) || range <= 0 ||
                tick < (this.lastDeployTick.get(unit.id) ?? -Infinity) + 30) continue;

            const deployed = { ...unit, primaryWeapon: weapon, secondaryWeapon: undefined };
            const threatened = context.matchAwareness.getHostilesNearPoint(unit.tile.rx, unit.tile.ry, range)
                .some(({ unitId }) => {
                    const target = context.game.getUnitData(unitId);
                    if (!target || isOwnedByNeutral(target) || !getCombatWeapon(deployed, target)) return false;
                    const distance = getDistanceBetweenUnits(unit, target);
                    return distance <= range && distance >= (weapon.minRange ?? 0);
                });
            if (threatened) {
                context.actionBatcher.push(BatchableAction.noTarget(unit.id, OrderType.DeploySelected));
                this.lastDeployTick.set(unit.id, tick);
            }
        }
    }
}

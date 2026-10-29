import { estimatedCombatWeapons, isObservedLivingUnit } from "../../common/observedUnit";
import { SpeedType, SuperWeaponStatus, SuperWeaponType, UnitData, Vector2 } from "../../../../game-api";
import { SupabotContext } from "../../common/context";
import { isOwnedByNeutral } from "../../common/utils";

/** Use earned paradrops to reinforce a safe, explored rally point. */
export class ParaDropSupport {
    private lastCheck = -Infinity;

    onAiUpdate(context: SupabotContext): void {
        if (context.difficulty !== "brutal") return;
        const { game, player, matchAwareness } = context;
        const tick = game.getCurrentTick();
        if (tick < this.lastCheck + 30) return;
        this.lastCheck = tick;
        const ready = game.getAllSuperWeaponData().filter(weapon =>
            weapon.playerName === player.name && Number(weapon.status) === SuperWeaponStatus.Ready &&
            [SuperWeaponType.AmerParaDrop, SuperWeaponType.ParaDrop].includes(Number(weapon.type)));
        if (!ready.length) return;

        const enemies = game.getVisibleUnits(player.name, "enemy")
            .map(id => game.getUnitData(id))
            .filter((unit): unit is UnitData => isObservedLivingUnit(unit) && !isOwnedByNeutral(unit));
        const rally = matchAwareness.getMainRallyPoint();
        const base = game.getPlayerData(player.name).startLocation;
        const centers = [rally, new Vector2(base.x, base.y)];
        for (const center of centers) {
            // Stable near-to-far search; do not spend a ready drop on an unseen
            // enemy location or inside observed ground/anti-air weapon coverage.
            for (const radius of [0, 2, 4, 6]) {
                for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
                    const tile = game.mapApi.getTile(Math.round(center.x + dx * radius), Math.round(center.y + dy * radius));
                    if (!tile || !game.mapApi.isVisibleTile(tile, player.name) ||
                        !game.mapApi.isPassableTile(tile, SpeedType.Foot, false)) continue;
                    const exposed = enemies.some(enemy => {
                        const range = Math.max(0, ...estimatedCombatWeapons(enemy, game)
                            .filter(weapon => weapon?.projectileRules?.isAntiGround || weapon?.projectileRules?.isAntiAir)
                            .map(weapon => weapon.maxRange ?? 0));
                        return range > 0 && new Vector2(enemy.tile.rx, enemy.tile.ry)
                            .distanceTo(new Vector2(tile.rx, tile.ry)) <= range + 3;
                    });
                    if (exposed) continue;
                    // Activate only one power at a time. The engine validates the
                    // charge and pays no additional units outside its own rules.
                    player.actions.activateSuperWeapon(Number(ready[0].type), tile);
                    return;
                }
            }
        }
    }
}

import { UnitData, Vector2 } from "../../../../game-api";
import { MissionContext, SupabotContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import { getBasicInfantryBudget, isSovietCountry } from "../../../strategy/basicInfantryBudget";
import { Mission, noop, releaseUnits, requestSpecificUnits, requestUnits } from "../mission";
import { MissionController } from "../missionController";
import { CombatSquad } from "./squads/combatSquad";

/** The former field conscripts hold home while tracked armor remains mobile. */
export class InfantryHomeMission extends Mission {
    private squad?: CombatSquad;

    constructor(private controller: MissionController, logger: DebugLogger) { super("infantryHome", logger); }
    isUnitsLocked() { return true; }
    getPriority() { return 20; }
    getGlobalDebugText() { return "infantry holds the income approach"; }

    _onAiUpdate(context: MissionContext) {
        const { game, player, matchAwareness } = context;
        const data = game.getPlayerData(player.name);
        if (context.difficulty !== "brutal" || !isSovietCountry(data.country?.name)) return noop();
        const budget = getBasicInfantryBudget("E2", context.difficulty);
        const reserve = this.controller.getMissions().find(m => m.getUniqueName() === "baseReserve");
        const reserved = reserve?.getUnitsOfTypes(game, "E2").filter(u => u.owner === player.name && u.hitPoints > 0).length ?? 0;
        if (reserve && reserved < budget.reserve) {
            // Specific-ID claims run before type requests. Leave recruits to the
            // original reserve, and replenish it from this existing contingent
            // after casualties rather than starving its low-priority request.
            const replacements = this.getUnitsOfTypes(game, "E2").filter(u => u.owner === player.name && u.hitPoints > 0)
                .sort((a, b) => a.id - b.id).slice(0, budget.reserve - reserved).map(u => u.id);
            return replacements.length ? releaseUnits(replacements) : noop();
        }
        // Stay near the same public home approach as the assembling field army.
        // Defend against intruders near base anchors; otherwise hold the entrance approach.
        const forward = matchAwareness.getMainRallyPoint().clone().sub(data.startLocation);
        if (forward.length() > 4) forward.multiplyScalar(4 / forward.length());
        const rally = data.startLocation.clone().add(forward);
        rally.set(Math.round(rally.x), Math.round(rally.y));

        const anchors = game.getVisibleUnits(player.name, "self", rules => rules.constructionYard || rules.refinery || rules.weaponsFactory)
            .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
        const homeThreats = game.getVisibleUnits(player.name, "enemy")
            .map(id => game.getUnitData(id))
            .filter((unit): unit is UnitData => !!unit && unit.rules.isSelectableCombatant && !unit.rules.harvester &&
                (anchors.some(anchor => new Vector2(unit.tile.rx, unit.tile.ry).distanceTo(new Vector2(anchor.tile.rx, anchor.tile.ry)) <= 22) ||
                 new Vector2(unit.tile.rx, unit.tile.ry).distanceTo(data.startLocation) <= 22));
        const nearestThreat = homeThreats.length ? [...homeThreats].sort((a, b) =>
            new Vector2(a.tile.rx, a.tile.ry).distanceTo(rally) - new Vector2(b.tile.rx, b.tile.ry).distanceTo(rally) || a.id - b.id)[0] : undefined;

        this.squad ??= new CombatSquad(rally, rally, 12, true);
        if (nearestThreat) {
            this.squad.setAttackArea(new Vector2(nearestThreat.tile.rx, nearestThreat.tile.ry));
            this.squad.setDefensiveRadius(22);
        } else {
            this.squad.setAttackArea(rally);
            this.squad.setDefensiveRadius(12);
        }
        this.squad.onAiUpdate(context, this, this.logger);

        const assigned = new Set(this.controller.getMissions().flatMap(m => m.getUnitIds()));
        const conscripts = game.getVisibleUnits(player.name, "self", r => r.name === "E2");
        const free = conscripts.filter(id => !assigned.has(id));
        if (free.length) return requestSpecificUnits(free, 20);
        const hasIncome = game.getVisibleUnits(player.name, "self", r => r.harvester).length > 0;
        // Preserve the former field-army request and global cap. The original
        // twelve-man reserve still requests at priority 50 before this priority 20.
        return hasIncome && conscripts.length < budget.total &&
            player.production.getAvailableObjects().some(r => r.name === "E2")
            ? requestUnits({ E2: 20 }) : noop();
    }
}

export function ensureInfantryHome(context: SupabotContext, missions: MissionController, logger: DebugLogger) {
    if (context.difficulty === "brutal" && isSovietCountry(context.game.getPlayerData(context.player.name).country?.name)) {
        missions.addMission(new InfantryHomeMission(missions, logger));
    }
}

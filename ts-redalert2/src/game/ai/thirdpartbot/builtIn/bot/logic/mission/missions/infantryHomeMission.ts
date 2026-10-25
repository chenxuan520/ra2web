import { MissionContext, SupabotContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import { getBasicInfantryBudget, isSovietCountry } from "../../../strategy/basicInfantryBudget";
import { Mission, noop, requestSpecificUnits, requestUnits } from "../mission";
import { MissionController } from "../missionController";
import { CombatSquad } from "./squads/combatSquad";

/** The former field conscripts hold home while tracked armor remains mobile. */
export class InfantryHomeMission extends Mission {
    private squad?: CombatSquad;

    constructor(private controller: MissionController, logger: DebugLogger) { super("infantryHome", logger); }
    getPriority() { return 20; }
    getGlobalDebugText() { return "infantry holds the income approach"; }

    _onAiUpdate(context: MissionContext) {
        const { game, player, matchAwareness } = context;
        const data = game.getPlayerData(player.name);
        if (context.difficulty !== "brutal" || !isSovietCountry(data.country?.name)) return noop();
        // Stay near the same public home approach as the assembling field army.
        // Do not chase visible enemies beyond this defensive radius.
        const forward = matchAwareness.getMainRallyPoint().clone().sub(data.startLocation);
        if (forward.length() > 4) forward.multiplyScalar(4 / forward.length());
        const rally = data.startLocation.clone().add(forward);
        rally.set(Math.round(rally.x), Math.round(rally.y));
        this.squad ??= new CombatSquad(rally, rally, 12, true);
        this.squad.setAttackArea(rally);
        this.squad.onAiUpdate(context, this, this.logger);

        const assigned = new Set(this.controller.getMissions().flatMap(m => m.getUnitIds()));
        const conscripts = game.getVisibleUnits(player.name, "self", r => r.name === "E2");
        const free = conscripts.filter(id => !assigned.has(id));
        if (free.length) return requestSpecificUnits(free, 20);
        const hasIncome = game.getVisibleUnits(player.name, "self", r => r.harvester).length > 0;
        // Preserve the former field-army request and global cap. The original
        // twelve-man reserve still requests at priority 50 before this priority 20.
        return hasIncome && conscripts.length < getBasicInfantryBudget("E2", context.difficulty).total &&
            player.production.getAvailableObjects().some(r => r.name === "E2")
            ? requestUnits({ E2: 20 }) : noop();
    }
}

export function ensureInfantryHome(context: SupabotContext, missions: MissionController, logger: DebugLogger) {
    if (context.difficulty === "brutal" && isSovietCountry(context.game.getPlayerData(context.player.name).country?.name)) {
        missions.addMission(new InfantryHomeMission(missions, logger));
    }
}

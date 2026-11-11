import { UnitData, Vector2 } from "../../../../game-api";
import { MissionContext, SupabotContext } from "../../common/context";
import { getKnownEnemyDirections } from "../../common/knownEnemyDirections";
import { DebugLogger } from "../../common/utils";
import { Mission, disbandMission, noop, requestUnits } from "../mission";
import { MissionController } from "../missionController";
import { visibleEnemies } from "./strategicTargets";
import { CombatSquad } from "./squads/combatSquad";

/** Paid infantry and dogs attack during the opening instead of joining the home reserve. */
export class InfantryPressureMission extends Mission {
    private squad?: CombatSquad;
    private launched = false;
    private target = new Vector2();

    constructor(logger: DebugLogger) { super("infantryPressure", logger); }
    getPriority() { return 110; }
    getAttackArea() { return this.target; }
    getGlobalDebugText() { return this.launched ? "early infantry/dog pressure" : "forming early infantry/dog pressure"; }

    claimReadyUnits(context: SupabotContext, controller: MissionController) {
        const names = new Set(["E1", "E2", "DOG", "ADOG"]);
        const own = context.game.getVisibleUnits(context.player.name, "self", rules => names.has(rules.name));
        for (const id of own) {
            const unit = context.game.getUnitData(id);
            if (!unit || unit.isWarpedOut || unit.owner !== context.player.name || this.getUnitIds().includes(id)) continue;
            const donor = controller.getMissions().find(mission => mission.getUnitIds().includes(id));
            if (donor && !["baseReserve", "infantryHome", "fieldArmy", "dogEscort"].includes(donor.getUniqueName())) continue;
            donor?.removeUnit(id);
            this.addUnit(id);
        }
    }

    _onAiUpdate(context: MissionContext) {
        const { game, player } = context, tick = game.getCurrentTick();
        if (context.difficulty !== "brutal" || tick >= 6000) return disbandMission("opening-finished");
        const units = this.getUnits(game).filter(unit => unit.owner === player.name && unit.hitPoints > 0);
        const foot = units.filter(unit => unit.name === "E1" || unit.name === "E2");
        if (foot.length >= 4 && units.some(unit => unit.name === "DOG" || unit.name === "ADOG")) this.launched = true;
        const data = game.getPlayerData(player.name), center = this.getCenterOfMass() ?? data.startLocation;
        const targets = visibleEnemies(context).sort((a, b) => {
            const value = (unit: UnitData) => (unit.rules.refinery ? 60 : unit.rules.weaponsFactory ? 50 : unit.rules.constructionYard ? 40 : 0) -
                center.distanceTo(new Vector2(unit.tile.rx, unit.tile.ry));
            return value(b) - value(a) || a.id - b.id;
        });
        const objective = targets[0];
        this.target = !this.launched ? context.matchAwareness.getMainRallyPoint() : objective
            ? new Vector2(objective.tile.rx, objective.tile.ry) : getKnownEnemyDirections(game, data)[0] ?? data.startLocation;
        this.squad ??= new CombatSquad(this.target, this.target, 15);
        this.squad.setAttackArea(this.target);
        this.squad.onAiUpdate(context, this, this.logger);
        if (tick >= 4000) return noop();
        const available = new Set(player.production.getAvailableObjects().map(rules => rules.name));
        const infantry = available.has("E2") ? "E2" : "E1", dog = available.has("DOG") ? "DOG" : "ADOG";
        const infantryCount = game.getVisibleUnits(player.name, "self", rules => rules.name === infantry).length;
        const dogCount = game.getVisibleUnits(player.name, "self", rules => rules.name === dog).length;
        const requests: Record<string, number> = {};
        if (available.has(infantry) && infantryCount < (infantry === "E2" ? 32 : 24)) requests[infantry] = 110;
        if (available.has(dog) && dogCount < Math.min(6, Math.max(2, Math.ceil(infantryCount / 6)))) requests[dog] = 115;
        return requestUnits(requests);
    }
}

export function ensureInfantryPressure(context: SupabotContext, controller: MissionController, logger: DebugLogger) {
    if (context.difficulty !== "brutal" || context.game.getCurrentTick() >= 6000) return;
    let mission = controller.getMissions().find((mission): mission is InfantryPressureMission => mission instanceof InfantryPressureMission);
    if (!mission && context.game.getCurrentTick() < 4000) {
        mission = new InfantryPressureMission(logger);
        controller.addMission(mission);
    }
    mission?.claimReadyUnits(context, controller);
}

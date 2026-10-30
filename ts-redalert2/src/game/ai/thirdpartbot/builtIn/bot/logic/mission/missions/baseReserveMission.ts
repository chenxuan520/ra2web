import { UnitData, Vector2 } from "../../../../game-api";
import { MissionContext, SupabotContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import { getBasicInfantryBudget } from "../../../strategy/basicInfantryBudget";
import { Mission, noop, requestUnits } from "../mission";
import { MissionController } from "../missionController";
import { CombatSquad } from "./squads/combatSquad";

/** A small standing infantry reserve buys time for the first miners and tanks. */
export class BaseReserveMission extends Mission {
    private squad?: CombatSquad;

    constructor(logger: DebugLogger) { super("baseReserve", logger); }

    _onAiUpdate(context: MissionContext) {
        const { game, player, matchAwareness } = context;
        const start = game.getPlayerData(player.name).startLocation;
        const forward = matchAwareness.getMainRallyPoint().clone().sub(start);
        if (forward.length() > 4) forward.multiplyScalar(4 / forward.length());
        const rally = start.clone().add(forward);
        rally.set(Math.round(rally.x), Math.round(rally.y));

        const anchors = game.getVisibleUnits(player.name, "self", rules => rules.constructionYard || rules.refinery || rules.weaponsFactory)
            .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
        const homeThreats = game.getVisibleUnits(player.name, "enemy")
            .map(id => game.getUnitData(id))
            .filter((unit): unit is UnitData => !!unit && unit.rules.isSelectableCombatant && !unit.rules.harvester &&
                (anchors.some(anchor => new Vector2(unit.tile.rx, unit.tile.ry).distanceTo(new Vector2(anchor.tile.rx, anchor.tile.ry)) <= 22) ||
                 new Vector2(unit.tile.rx, unit.tile.ry).distanceTo(start) <= 22));
        const nearestThreat = homeThreats.length ? [...homeThreats].sort((a, b) =>
            new Vector2(a.tile.rx, a.tile.ry).distanceTo(rally) - new Vector2(b.tile.rx, b.tile.ry).distanceTo(rally) || a.id - b.id)[0] : undefined;

        this.squad ??= new CombatSquad(rally, rally, 8, true);
        if (nearestThreat) {
            this.squad.setAttackArea(new Vector2(nearestThreat.tile.rx, nearestThreat.tile.ry));
            this.squad.setDefensiveRadius(22);
        } else {
            this.squad.setAttackArea(rally);
            this.squad.setDefensiveRadius(8);
        }
        this.squad.onAiUpdate(context, this, this.logger);
        const available = context.player.production.getAvailableObjects();
        const infantry = available.find(rules => rules.name === "E1" || rules.name === "E2");
        if (!infantry) return noop();
        const desired = getBasicInfantryBudget(infantry.name, context.difficulty).reserve;
        if (this.getUnitIds().length >= desired) return noop();
        const owned = game.getVisibleUnits(player.name, "self", rules => rules.name === infantry.name).length;
        // Other defensive missions may temporarily borrow this reserve. Do not
        // replace borrowed soldiers with an unbounded stream of reinforcements.
        if (this.getMissingUnits(game, { [infantry.name]: desired }).length && owned < desired) {
            return requestUnits({ [infantry.name]: infantry.name === "E2" ? 50 : 12 });
        }
        return requestUnits({ [infantry.name]: 1 });
    }

    isUnitsLocked() { return true; }
    getPriority() { return 12; }
    getGlobalDebugText() { return this.squad?.getGlobalDebugText() ?? "base reserve"; }
}

export function ensureBaseReserve(context: SupabotContext, missions: MissionController, logger: DebugLogger) {
    if (context.difficulty === "brutal") missions.addMission(new BaseReserveMission(logger));
}

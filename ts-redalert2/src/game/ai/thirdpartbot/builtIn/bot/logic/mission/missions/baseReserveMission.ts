import { MissionContext, SupabotContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
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
        this.squad ??= new CombatSquad(rally, rally, 6, true);
        this.squad.setAttackArea(rally);
        this.squad.onAiUpdate(context, this, this.logger);
        const available = context.player.production.getAvailableObjects();
        const infantry = available.find(rules => rules.name === "E1" || rules.name === "E2");
        if (!infantry) return noop();
        const desired = infantry.name === "E1" ? 9 : 12;
        const owned = game.getVisibleUnits(player.name, "self", rules => rules.name === infantry.name).length;
        // Other defensive missions may temporarily borrow this reserve. Do not
        // replace borrowed soldiers with an unbounded stream of reinforcements.
        if (this.getMissingUnits(game, { [infantry.name]: desired }).length && owned < desired) {
            return requestUnits({ [infantry.name]: 12 });
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

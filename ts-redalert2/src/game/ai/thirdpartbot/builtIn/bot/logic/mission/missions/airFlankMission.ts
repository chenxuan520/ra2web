import { UnitData, Vector2, ZoneType } from "../../../../game-api";
import { MissionContext, SupabotContext } from "../../common/context";
import { getKnownEnemyDirections } from "../../common/knownEnemyDirections";
import { DebugLogger } from "../../common/utils";
import { Mission, noop, requestUnits } from "../mission";
import { MissionController } from "../missionController";
import { FieldArmyMission } from "./fieldArmyMission";
import { CombatSquad } from "./squads/combatSquad";
import { visibleEnemies } from "./strategicTargets";

const point = (unit: UnitData) => new Vector2(unit.tile.rx, unit.tile.ry);

/** A small paid air wing approaches from the flank while the main army remains ground-based. */
export class AirFlankMission extends Mission {
    private squad?: CombatSquad;
    private approach?: Vector2;
    private attackArea = new Vector2();

    constructor(private airName: string, private cap: number, private army: FieldArmyMission, logger: DebugLogger) { super("airFlank", logger); }
    getPriority() { return 80; }
    getAttackArea() { return this.attackArea; }
    getGlobalDebugText() { return "air flank coordinated with the ground army"; }

    override onAiUpdate(context: MissionContext) {
        if (context.difficulty !== "brutal") return noop();
        const own = new Set(context.game.getVisibleUnits(context.player.name, "self"));
        for (const id of [...this.getUnitIds()]) if (!own.has(id)) this.removeUnit(id);
        return super.onAiUpdate(context);
    }

    claimReadyUnits(context: SupabotContext, controller: MissionController) {
        for (const id of context.game.getVisibleUnits(context.player.name, "self", rules => rules.name === this.airName).sort((a, b) => a - b)) {
            if (this.getUnitIds().length >= this.cap) break;
            if (this.getUnitIds().includes(id)) continue;
            const unit = context.game.getUnitData(id);
            if (!unit || unit.owner !== context.player.name || unit.zone !== ZoneType.Air || unit.isWarpedOut) continue;
            const donor = controller.getMissions().find(mission => mission !== this && mission.getUnitIds().includes(id));
            if (donor && donor !== this.army) continue;
            donor?.removeUnit(id); this.addUnit(id);
        }
    }

    _onAiUpdate(context: MissionContext) {
        const { game, player } = context;
        const units = this.getUnits(game), data = game.getPlayerData(player.name);
        const goal = getKnownEnemyDirections(game, data)[0];
        if (units.length && goal) {
            if (!this.approach) {
                const direction = goal.clone().sub(data.startLocation), length = direction.length();
                const side = length ? new Vector2(-direction.y, direction.x).multiplyScalar(14 / length) : new Vector2(14, 0);
                this.approach = [goal.clone().add(side), goal.clone().sub(side)].map(point => new Vector2(Math.round(point.x), Math.round(point.y)))
                    .find(point => !!game.mapApi.getTile(point.x, point.y));
            }
            const center = this.getCenterOfMass() ?? data.startLocation;
            const objective = visibleEnemies(context).filter(unit => unit.rules.refinery || unit.rules.weaponsFactory || unit.rules.constructionYard)
                .sort((a, b) => Number(!!b.rules.refinery) - Number(!!a.rules.refinery) || point(a).distanceTo(center) - point(b).distanceTo(center) || a.id - b.id)[0];
            this.attackArea = this.approach && center.distanceTo(this.approach) > 4 ? this.approach : objective ? point(objective) : goal;
            this.squad ??= new CombatSquad(data.startLocation, this.attackArea, 15);
            this.squad.setAttackArea(this.attackArea);
            this.squad.onAiUpdate(context, this, this.logger);
        }
        return units.length < this.cap && player.production.getAvailableObjects().some(rules => rules.name === this.airName)
            ? requestUnits({ [this.airName]: 120 }) : noop();
    }
}

export class AirFlankFactory {
    maybeCreateMissions(context: SupabotContext, controller: MissionController, logger: DebugLogger, army: FieldArmyMission) {
        if (context.difficulty !== "brutal") return;
        const existing = controller.getMissions().find((mission): mission is AirFlankMission => mission instanceof AirFlankMission);
        if (existing) { existing.claimReadyUnits(context, controller); return; }
        if (context.game.getVisibleUnits(context.player.name, "self", rules => ["MTNK", "HTNK", "MGTK", "APOC", "SREF"].includes(rules.name))
            .filter(id => army.getUnitIds().includes(id)).length < 3 ||
            context.game.getVisibleUnits(context.player.name, "self", rules => rules.harvester).length < 2) return;
        const available = new Set(context.player.production.getAvailableObjects().map(rules => rules.name));
        const airName = available.has("JUMPJET") ? "JUMPJET" : available.has("ZEP") ? "ZEP" : undefined;
        if (!airName) return;
        const mission = new AirFlankMission(airName, airName === "JUMPJET" ? 2 : 1, army, logger);
        if (controller.addMission(mission)) mission.claimReadyUnits(context, controller);
    }
}

import { ObjectType, TechnoRules, UnitData, Vector2 } from "../../../../game-api";
import { MissionContext, SupabotContext } from "../../common/context";
import { getKnownEnemyDirections } from "../../common/knownEnemyDirections";
import { DebugLogger } from "../../common/utils";
import { getAdjacencyTiles } from "../../building/buildingRules";
import { Mission, buildStructureAtLocation, noop } from "../mission";
import { MissionController } from "../missionController";

const point = (unit: UnitData) => new Vector2(unit.tile.rx, unit.tile.ry);

/** Paid base-normal power anchors extend real building adjacency; guns follow the advancing edge. */
export class CrawlMission extends Mission {
    private plan?: { name: string; point: Vector2; previousCount: number };
    private lastGoal?: Vector2;

    constructor(logger: DebugLogger) { super("defenseCrawl", logger); }
    getPriority() { return 90; }
    getGlobalDebugText() { return "paid power-anchor and defensive-building crawl"; }

    _onAiUpdate(context: MissionContext) {
        const { game, player } = context;
        if (context.difficulty !== "brutal") return noop();
        const own = game.getVisibleUnits(player.name, "self", rules => rules.type === ObjectType.Building)
            .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit && unit.owner === player.name && !unit.isWarpedOut);
        const count = (name: string) => own.filter(unit => unit.name === name).length;
        const planned = this.plan;
        if (planned && (count(planned.name) > planned.previousCount || own.some(unit =>
            unit.name === planned.name && point(unit).equals(planned.point)))) this.plan = undefined;
        // Keep the same request while the stock queue builds and places it.
        // A placement command is not success: only observed own buildings advance the next plan.
        if (this.plan) return buildStructureAtLocation(this.plan.name, 85, this.plan.point.x, this.plan.point.y);
        if (!own.some(unit => unit.rules.weaponsFactory) || game.getVisibleUnits(player.name, "self", rules => rules.harvester).length < 2) return noop();
        const available = player.production.getAvailableObjects();
        const power = available.find(rules => rules.name === "NAPOWR" || rules.name === "GAPOWR");
        const gun = available.find(rules => rules.name === "NALASR" || rules.name === "GAPILL");
        if (!power || !gun) return noop();
        const data = game.getPlayerData(player.name), goal = getKnownEnemyDirections(game, data)[0] ?? this.lastGoal;
        if (!goal) return noop();
        this.lastGoal = goal;
        const front = own.filter(unit => unit.rules.baseNormal && unit.foundation)
            .sort((a, b) => point(a).distanceTo(goal) - point(b).distanceTo(goal) || a.id - b.id)[0];
        if (!front) return noop();
        const origin = point(front), gunNearFront = own.some(unit => unit.name === gun.name && point(unit).distanceTo(origin) <= 7);
        if (!gunNearFront && count(gun.name) < 12) {
            const tile = this.placement(context, gun, goal, candidate => candidate.distanceTo(origin) <= 6);
            if (tile) { this.plan = { name: gun.name, point: tile, previousCount: count(gun.name) }; }
        }
        if (!this.plan && origin.distanceTo(goal) > 10 && count(power.name) < 14) {
            const tile = this.placement(context, power, goal, candidate => candidate.distanceTo(goal) < origin.distanceTo(goal) - 2);
            if (tile) { this.plan = { name: power.name, point: tile, previousCount: count(power.name) }; }
        }
        return this.plan ? buildStructureAtLocation(this.plan.name, 85, this.plan.point.x, this.plan.point.y) : noop();
    }

    private placement(context: MissionContext, rules: TechnoRules, goal: Vector2, accept: (point: Vector2) => boolean): Vector2 | undefined {
        const { game, player } = context;
        return getAdjacencyTiles(game, game.getPlayerData(player.name), rules, false, 1)
            .filter(tile => game.mapApi.isVisibleTile(tile, player.name) && accept(new Vector2(tile.rx, tile.ry)) &&
                game.canPlaceBuilding(player.name, rules.name, tile))
            .sort((a, b) => new Vector2(a.rx, a.ry).distanceTo(goal) - new Vector2(b.rx, b.ry).distanceTo(goal) || a.rx - b.rx || a.ry - b.ry)
            .map(tile => new Vector2(tile.rx, tile.ry))[0];
    }
}

export function ensureCrawl(context: SupabotContext, controller: MissionController, logger: DebugLogger) {
    if (context.difficulty === "brutal") controller.addMission(new CrawlMission(logger));
}

import { isObservedLivingUnit } from "../../common/observedUnit";
import { ObjectType, OrderType, SpeedType, TechnoRules, UnitData, Vector2 } from "../../../../game-api";
import { MissionContext, SupabotContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import { Mission, MissionAction, disbandMission, noop, requestUnits } from "../mission";
import { MissionController } from "../missionController";
import { findBaseThreat, visibleEnemies } from "./strategicTargets";
import { getCombatWeapon } from "./squads/tacticalTargeting";

const CHECK_TICKS = 30;
const MAX_MISSION_TICKS = 4 * 60 * 15;

/** Reach an explored entry while staying outside observed hostile gun coverage. */
export function safeCaptureEntry(context: SupabotContext, start: UnitData, target: UnitData): boolean {
    const game = context.game;
    if (!target.rules.capturable || !target.foundation || target.garrisonUnitCount ||
        (target.rules.canBeOccupied && target.garrisonUnitCount === undefined)) return false;
    const enemies = visibleEnemies(context);
    const guns = enemies.map(enemy => ({ enemy, weapon: getCombatWeapon(enemy, start, false, game) })).filter(entry => !!entry.weapon);
    const unsafe = (tile: { rx: number; ry: number }) => guns.some(({ enemy, weapon }) =>
        new Vector2(tile.rx, tile.ry).distanceTo(new Vector2(enemy.tile.rx, enemy.tile.ry)) <= weapon!.range + 2);
    const entries: any[] = [];
    const { width, height } = target.foundation;
    for (let dx = -1; dx <= width; dx++) for (let dy = -1; dy <= height; dy++) {
        if (dx !== -1 && dx !== width && dy !== -1 && dy !== height) continue;
        const tile = game.mapApi.getTile(target.tile.rx + dx, target.tile.ry + dy);
        if (tile && game.mapApi.isVisibleTile(tile, context.player.name) &&
            !game.mapApi.hasBridgeOnTile(tile) && game.mapApi.isPassableTile(tile, SpeedType.Foot, false) && !unsafe(tile)) entries.push(tile);
    }
    entries.sort((a, b) => Math.abs(a.rx - start.tile.rx) + Math.abs(a.ry - start.tile.ry) -
        Math.abs(b.rx - start.tile.rx) - Math.abs(b.ry - start.tile.ry) || a.rx - b.rx || a.ry - b.ry);
    return entries.slice(0, 6).some(tile => {
        const path = game.mapApi.findPath(SpeedType.Foot, { tile: start.tile, onBridge: !!start.onBridge },
            { tile, onBridge: false }, { maxExpandedNodes: 2000, bestEffort: false,
                excludeNodes: (node: any) => !game.mapApi.isVisibleTile(node.tile, context.player.name) || unsafe(node.tile) });
        return path.length > 0 && path.every(node => game.mapApi.isVisibleTile(node.tile, context.player.name) && !unsafe(node.tile));
    });
}

export class SneakCaptureMission extends Mission<string> {
    private stage: "preparing" | "capturing" | "returning" = "preparing";
    private lastCheck = -Infinity;
    private lastOrder = -Infinity;
    private returningAt = 0;
    private returnReason = "aborted";
    private orderedReturn = false;

    constructor(name: string, readonly targetId: number, private engineerRule: TechnoRules, private home: Vector2,
        private createdAt: number, logger: DebugLogger) { super(name, logger); }

    _onAiUpdate(context: MissionContext): MissionAction {
        const { game, player } = context;
        const tick = game.getCurrentTick();
        const engineer = this.getUnitsOfTypes(game, this.engineerRule.name)[0];
        const target = game.getUnitData(this.targetId);
        if (target?.owner === player.name) return disbandMission("captured");
        if (this.stage === "capturing" && !engineer) return disbandMission("engineer-lost");
        if (tick >= this.lastCheck + CHECK_TICKS && this.stage !== "returning") {
            this.lastCheck = tick;
            const visible = game.getVisibleUnits(player.name, "enemy").includes(this.targetId);
            const approach = engineer ?? plannedEngineer(context, this.engineerRule, this.home);
            if (!isObservedLivingUnit(target) || !visible || findBaseThreat(context) ||
                !approach.tile || !safeCaptureEntry(context, approach, target) || tick - this.createdAt >= MAX_MISSION_TICKS) {
                if (!engineer) return disbandMission("unsafe-target");
                this.stage = "returning";
                this.returningAt = tick;
                this.returnReason = "unsafe-target";
            }
        }
        if (this.stage === "returning") {
            if (!engineer || new Vector2(engineer.tile.rx, engineer.tile.ry).distanceTo(this.home) <= 4 || tick - this.returningAt >= 900) {
                return disbandMission(this.returnReason);
            }
            if (!this.orderedReturn || (engineer.isIdle && tick >= this.lastOrder + 90)) {
                player.actions.orderUnits([engineer.id], OrderType.Move, this.home.x, this.home.y);
                this.orderedReturn = true;
                this.lastOrder = tick;
            }
            return noop();
        }
        if (!engineer) {
            if (tick - this.createdAt >= 900) return disbandMission("production-timeout");
            return requestUnits({ [this.engineerRule.name]: 20 });
        }
        this.stage = "capturing";
        if (this.lastOrder === -Infinity || (engineer.isIdle && tick >= this.lastOrder + 90)) {
            player.actions.orderUnits([engineer.id], OrderType.Capture, this.targetId);
            this.lastOrder = tick;
        }
        return noop();
    }

    getPriority() { return 20; }
    getState() { return this.stage; }
    getGlobalDebugText() { return `${this.stage} target=${this.targetId}`; }
}

export class SneakCaptureMissionFactory {
    private lastCheck = -Infinity;
    private lastAttempt = -Infinity;
    private failures = new Map<number, number>();

    maybeCreateMissions(context: SupabotContext, controller: MissionController, logger: DebugLogger): void {
        const { game, player } = context;
        const tick = game.getCurrentTick();
        if (context.difficulty !== "brutal" || tick < this.lastCheck + 150) return;
        this.lastCheck = tick;
        if (tick < this.lastAttempt + 1800 || controller.getMissions().some(mission => mission.isActive() && mission instanceof SneakCaptureMission) || findBaseThreat(context)) return;
        const available = context.player.production.getAvailableObjects();
        const rule = available.find(option => option.name === "ENGINEER" || option.name === "SENGINEER");
        if (!rule) return;
        const own = game.getVisibleUnits(player.name, "self").map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
        const assigned = new Set(controller.getMissions().filter(mission => mission.isActive()).flatMap(mission => mission.getUnitIds()));
        const idle = own.find(unit => unit.name === rule.name && !assigned.has(unit.id));
        const miners = own.filter(unit => unit.rules.harvester).length;
        const army = own.filter(unit => unit.rules.isSelectableCombatant && !unit.rules.harvester).length;
        if (army < 4 || miners < (idle ? 1 : 2) || (!idle && game.getPlayerData(player.name).credits < rule.cost + 800)) return;
        const home = context.matchAwareness.getMainRallyPoint();
        const start = idle ?? plannedEngineer(context, rule, home);
        if (!start.tile) return;
        const targets = visibleEnemies(context).filter(target => (target.type as any) === ObjectType.Building &&
            target.rules.capturable && !target.garrisonUnitCount && (this.failures.get(target.id) ?? 0) < 2 &&
            (target.rules.constructionYard || target.rules.weaponsFactory || target.rules.refinery || target.rules.power > 0))
            .sort((a, b) => captureValue(b.rules) - captureValue(a.rules) || a.id - b.id);
        const target = targets.slice(0, 4).find(target => safeCaptureEntry(context, start, target));
        if (!target) return;
        const mission = new SneakCaptureMission(`sneak-capture-${tick}`, target.id, rule, home, tick, logger)
            .withOnFinish((_ids, reason) => {
                if (reason !== "captured") this.failures.set(target.id, (this.failures.get(target.id) ?? 0) + 1);
                logger(`Sneak capture target=${target.id} finished=${reason}`);
            });
        if (controller.addMission(mission)) {
            this.lastAttempt = tick;
            logger(`Sneak capture target=${target.id} admitted`);
        }
    }
}

function captureValue(rules: TechnoRules): number {
    return rules.constructionYard ? 4000 : rules.weaponsFactory ? 3000 : rules.refinery ? 2000 : 1000;
}

function plannedEngineer(context: SupabotContext, rules: TechnoRules, home: Vector2): UnitData {
    // Evaluate the prospective recruit's armor and route using real rules. This
    // planning proxy is never inserted into the world or given a unit command.
    return { name: rules.name, rules, tile: context.game.mapApi.getTile(Math.round(home.x), Math.round(home.y)),
        type: ObjectType.Infantry, hitPoints: rules.strength, maxHitPoints: rules.strength,
        isWarpedOut: false } as unknown as UnitData;
}

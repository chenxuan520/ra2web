import { ObjectType, OrderType, SpeedType, UnitData, Vector2, ZoneType } from "../../../../game-api";
import { MissionContext, SupabotContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import { BatchableAction } from "../actionBatcher";
import { Mission, noop, requestUnits } from "../mission";
import { MissionController } from "../missionController";
import { DesolatorTactics, distanceToSegment, getRadiationDeployment } from "./squads/desolatorTactics";
import { chooseTacticalTarget, getCombatWeapon, isFiringBurst } from "./squads/tacticalTargeting";

const point = (unit: UnitData) => new Vector2(unit.tile.rx, unit.tile.ry);

/** An explored forward position covers the approach without poisoning the base or its exits. */
export function selectRadiationGuardPoint(context: SupabotContext, radius: number): Vector2 | undefined {
    const { game, player } = context;
    const friends = game.getVisibleUnits(player.name, "allied").map(id => game.getUnitData(id))
        .filter((unit): unit is UnitData => !!unit);
    const ownBases = friends.filter(unit => unit.owner === player.name && (unit.rules.constructionYard || unit.rules.refinery));
    const enemies = game.getVisibleUnits(player.name, "enemy").map(id => game.getUnitData(id))
        .filter((unit): unit is UnitData => !!unit && unit.zone !== ZoneType.Air && !!unit.primaryWeapon);
    const base = ownBases.find(unit => unit.rules.constructionYard) ?? ownBases[0];
    if (!base) return;
    const anchor = point(base);
    const enemy = [...enemies].sort((a, b) => anchor.distanceTo(point(a)) - anchor.distanceTo(point(b)) || a.id - b.id)[0];
    const approach = enemy ? point(enemy) : game.getPlayers().filter(name => name !== player.name && !game.areAlliedPlayers(player.name, name))
        .map(name => game.getPlayerData(name)).find(other => other.isCombatant)?.startLocation;
    if (!approach || approach.equals(anchor)) return;
    const forward = approach.clone().sub(anchor);
    forward.multiplyScalar(1 / forward.length());
    const candidates: { location: Vector2; score: number }[] = [];
    for (let dx = -28; dx <= 28; dx += 2) for (let dy = -28; dy <= 28; dy += 2) {
        const separation = Math.hypot(dx, dy);
        if (separation < radius + 2 || separation > radius + 13 || (dx * forward.x + dy * forward.y) < radius * 0.6) continue;
        const tile = game.mapApi.getTile(anchor.x + dx, anchor.y + dy);
        if (!tile || !game.mapApi.isVisibleTile(tile, player.name) || game.mapApi.hasBridgeOnTile(tile) ||
            !game.mapApi.isPassableTile(tile, SpeedType.Foot, false, true)) continue;
        const location = new Vector2(tile.rx, tile.ry);
        if (friends.some(ally => {
            const production = ally.rules.weaponsFactory || ally.rules.barracks || ally.rules.refinery;
            const vulnerable = (ally.type as any) !== ObjectType.Building && ally.zone !== ZoneType.Air && !ally.rules.immuneToRadiation;
            return (production || vulnerable) && location.distanceTo(point(ally)) < radius + 3;
        })) continue;
        if (enemies.some(hostile => location.distanceTo(point(hostile)) < (hostile.primaryWeapon?.maxRange ?? 0) + 2)) continue;
        const score = distanceToSegment(location, anchor, approach) * 2 + Math.abs(separation - (radius + 5)) +
            Math.abs(location.distanceTo(approach) - (radius * 0.7)) * 0.5;
        candidates.push({ location, score });
    }
    return candidates.sort((a, b) => a.score - b.score || a.location.x - b.location.x || a.location.y - b.location.y)[0]?.location;
}

export class RadiationGuardMission extends Mission {
    private tactics = new DesolatorTactics();
    private guard?: Vector2;
    private nextPlan = 0;
    private admitted = false;
    private survey?: Vector2;
    private surveyAt = 0;
    private orders = new Map<number, { action: BatchableAction; tick: number }>();

    constructor(logger: DebugLogger) { super("radiationGuard", logger); }

    _onAiUpdate(context: MissionContext) {
        const { game, player, actionBatcher } = context;
        const tick = game.getCurrentTick();
        const units = this.getUnits(game).filter(unit => unit.name === "DESO");
        const option = player.production.getAvailableObjects().find(rules => rules.name === "DESO");
        if (!option && !units.length) return noop();
        const deployment = units[0] && getRadiationDeployment(units[0], game);
        const weaponName = option && (option.deployFireWeapon === 0 ? option.primary : option.secondary);
        const weapon = weaponName && game.rulesApi.getWeapon(weaponName);
        const radius = deployment?.radius ?? (weapon ? game.rulesApi.getWarhead(weapon.warhead).cellSpread + 1 : 0);
        if (!(radius > 0)) return noop();
        if (!this.guard && tick >= this.nextPlan) {
            this.guard = selectRadiationGuardPoint(context, radius);
            this.nextPlan = tick + 60;
        }
        if (!units.length) {
            const miners = game.getVisibleUnits(player.name, "self", rules => rules.harvester).length;
            const credits = game.getPlayerData(player.name).credits;
            if (option && miners && (this.admitted || credits >= option.cost)) {
                this.admitted = true;
                return requestUnits({ DESO: 30 });
            }
            return noop();
        }
        this.admitted = false;
        this.tactics.observe(context, units);
        if (!this.guard) {
            const start = game.getPlayerData(player.name).startLocation;
            const approach = game.getPlayers().filter(name => name !== player.name && !game.areAlliedPlayers(player.name, name))
                .map(name => game.getPlayerData(name)).find(other => other.isCombatant)?.startLocation;
            if (!approach) return noop();
            if (!this.survey || (units[0].isIdle && tick >= this.surveyAt + 180)) {
                const forward = approach.clone().sub(start);
                if (!forward.length()) return noop();
                forward.multiplyScalar(1 / forward.length());
                const sign = this.survey ? -1 : 1;
                this.survey = start.clone().add(forward.clone().multiplyScalar(radius + 11))
                    .add(new Vector2(-forward.y, forward.x).multiplyScalar(sign * 10));
                this.survey.set(Math.round(this.survey.x), Math.round(this.survey.y));
                this.surveyAt = tick;
                // This is an exploration order toward a public map direction,
                // not a query of hidden units or terrain. Replan after revealing it.
                actionBatcher.push(BatchableAction.toPoint(units[0].id, OrderType.Move, this.survey));
            }
            return noop();
        }
        for (const unit of units) {
            if (tick % 6 || isFiringBurst(unit)) continue;
            const targets = game.getVisibleUnits(player.name, "enemy").map(id => game.getUnitData(id))
                .filter((target): target is UnitData => !!target && point(target).distanceTo(point(unit)) <= radius + 2);
            const decision = this.tactics.decide(context, unit, targets, units, this.guard);
            let action = decision.action;
            if (!decision.handled) {
                const target = chooseTacticalTarget(unit, targets.filter(target => {
                    const weapon = getCombatWeapon(unit, target, true);
                    return weapon && point(unit).distanceTo(point(target)) <= weapon.range && point(target).distanceTo(this.guard!) <= radius;
                }), new Map());
                action = point(unit).distanceTo(this.guard) > 1.5
                    ? BatchableAction.toPoint(unit.id, OrderType.Move, this.guard)
                    : target ? BatchableAction.toTargetId(unit.id, OrderType.Attack, target.id)
                    : !unit.isIdle ? BatchableAction.noTarget(unit.id, OrderType.Stop) : undefined;
            }
            if (action) {
                const previous = this.orders.get(unit.id);
                if (!previous || !previous.action.isSameAs(action) || (unit.isIdle && tick >= previous.tick + 60)) {
                    actionBatcher.push(action);
                    this.orders.set(unit.id, { action, tick });
                }
            }
        }
        return noop();
    }

    getPriority() { return 30; }
    getGlobalDebugText() { return this.guard ? `radiation guard ${this.guard.x},${this.guard.y}` : "finding radiation guard position"; }
}

export function ensureRadiationGuard(context: SupabotContext, missions: MissionController, logger: DebugLogger) {
    if (context.difficulty === "brutal" && context.game.getPlayerData(context.player.name).country?.name === "Arabs") {
        missions.addMission(new RadiationGuardMission(logger));
    }
}

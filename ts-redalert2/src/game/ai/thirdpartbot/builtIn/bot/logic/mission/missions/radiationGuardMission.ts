import { ObjectType, OrderType, SpeedType, StanceType, UnitData, Vector2, ZoneType } from "../../../../game-api";
import { MissionContext, SupabotContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import { BatchableAction } from "../actionBatcher";
import { Mission, noop, requestUnits } from "../mission";
import { MissionController } from "../missionController";
import { DesolatorTactics, distanceToSegment, getRadiationDeployment } from "./squads/desolatorTactics";
import { chooseTacticalTarget, getCombatWeapon, isFiringBurst } from "./squads/tacticalTargeting";

const point = (unit: UnitData) => new Vector2(unit.tile.rx, unit.tile.ry);

function visibleFriends(context: SupabotContext) {
    return context.game.getVisibleUnits(context.player.name, "allied").map(id => context.game.getUnitData(id))
        .filter((unit): unit is UnitData => !!unit);
}

export function isRadiationGuardPointSafe(context: SupabotContext, location: Vector2, radius: number,
    friends = visibleFriends(context)): boolean {
    const { game, player } = context;
    const tile = game.mapApi.getTile(location.x, location.y);
    if (!tile || !game.mapApi.isVisibleTile(tile, player.name) || game.mapApi.hasBridgeOnTile(tile) ||
        !game.mapApi.isPassableTile(tile, SpeedType.Foot, false, true)) return false;
    return !friends.some(ally => {
        const production = ally.rules.weaponsFactory || ally.rules.barracks || ally.rules.refinery;
        const vulnerable = (ally.type as any) !== ObjectType.Building && ally.zone !== ZoneType.Air && !ally.rules.immuneToRadiation;
        return (production || vulnerable) && location.distanceTo(point(ally)) < radius + 3;
    });
}

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
        const location = new Vector2(anchor.x + dx, anchor.y + dy);
        if (!isRadiationGuardPointSafe(context, location, radius, friends)) continue;
        if (enemies.some(hostile => location.distanceTo(point(hostile)) < (hostile.primaryWeapon?.maxRange ?? 0) + 2)) continue;
        const score = distanceToSegment(location, anchor, approach) * 2 + Math.abs(separation - (radius + 5)) +
            Math.abs(location.distanceTo(approach) - (radius * 0.7)) * 0.5;
        candidates.push({ location, score });
    }
    return candidates.sort((a, b) => a.score - b.score || a.location.x - b.location.x || a.location.y - b.location.y)[0]?.location;
}

/** Follow short explored paths that do not walk the defender through known gunfire. */
export function getRadiationGuardWaypoint(context: SupabotContext, unit: UnitData, destination: Vector2): Vector2 | undefined {
    const { game, player } = context;
    const from = point(unit);
    const speed = unit.rules.speedType;
    if (speed === undefined) return;
    const start = game.mapApi.getTile(from.x, from.y), end = game.mapApi.getTile(destination.x, destination.y);
    if (!start || !end || !game.mapApi.findPath) return;
    const threats = game.getVisibleUnits(player.name, "enemy").map(id => game.getUnitData(id))
        .filter((enemy): enemy is UnitData => !!enemy && !!getCombatWeapon(enemy, unit, true));
    const unsafe = (tile: { rx: number; ry: number }) => {
        if (!game.mapApi.isVisibleTile(tile as any, player.name) || game.mapApi.hasBridgeOnTile(tile as any)) return true;
        const at = new Vector2(tile.rx, tile.ry);
        return threats.some(enemy => {
            const reach = getCombatWeapon(enemy, unit, true)!.range + 2;
            const current = from.distanceTo(point(enemy)), next = at.distanceTo(point(enemy));
            // A surrounded defender may retreat out of range, never move deeper.
            return next < reach && (current >= reach || next < current - 0.1);
        });
    };
    const path = game.mapApi.findPath(speed, { tile: start, onBridge: false }, { tile: end, onBridge: false },
        { bestEffort: false, maxExpandedNodes: 512, excludeNodes: ({ tile }: any) => unsafe(tile) }).slice().reverse();
    const last = path.at(-1)?.tile;
    if (!last || last.rx !== end.rx || last.ry !== end.ry) return;
    let waypoint: Vector2 | undefined;
    for (const node of path) {
        const at = new Vector2(node.tile.rx, node.tile.ry);
        if (at.equals(from)) continue;
        if (node.onBridge || from.distanceTo(at) > 4 || unsafe(node.tile)) break;
        const short = game.mapApi.findPath(speed, { tile: start, onBridge: false }, { tile: node.tile, onBridge: false },
            { bestEffort: false, maxExpandedNodes: 64 });
        if (!short.length || short.some(step => step.onBridge || unsafe(step.tile))) break;
        waypoint = at;
    }
    return waypoint;
}

export class RadiationGuardMission extends Mission {
    private tactics = new DesolatorTactics();
    private guard?: Vector2;
    private nextPlan = 0;
    private admitted = false;
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
        // New construction and friendly reinforcements can invalidate a once-safe position.
        if (this.guard && tick >= this.nextPlan && !isRadiationGuardPointSafe(context, this.guard, radius)) this.guard = undefined;
        if (!this.guard && tick >= this.nextPlan) {
            this.guard = selectRadiationGuardPoint(context, radius);
        }
        if (tick >= this.nextPlan) this.nextPlan = tick + 60;
        if (!units.length) {
            const miners = game.getVisibleUnits(player.name, "self", rules => rules.harvester).length;
            const armor = game.getVisibleUnits(player.name, "self", rules => rules.name === "HTNK" || rules.name === "APOC").length;
            const credits = game.getPlayerData(player.name).credits;
            // A specialist cannot replace the opening army or go scouting alone.
            if (option && this.guard && miners >= 3 && armor >= 2 && (this.admitted || credits >= option.cost + 1000)) {
                this.admitted = true;
                return requestUnits({ DESO: 30 });
            }
            return noop();
        }
        this.admitted = false;
        this.tactics.observe(context, units);
        for (const unit of units) {
            if (tick % 6 || isFiringBurst(unit)) continue;
            const targets = game.getVisibleUnits(player.name, "enemy").map(id => game.getUnitData(id))
                .filter((target): target is UnitData => !!target && point(target).distanceTo(point(unit)) <= radius + 2);
            const atGuard = !!this.guard && point(unit).distanceTo(this.guard) <= 2;
            const deployed = (unit.stance as any) === StanceType.Deployed;
            const decision = atGuard || deployed
                ? this.tactics.decide(context, unit, targets, units, this.guard ?? point(unit)) : { handled: false };
            let action = decision.action;
            if (!decision.handled) {
                const target = chooseTacticalTarget(unit, targets.filter(target => {
                    const weapon = getCombatWeapon(unit, target, true);
                    return atGuard && weapon && point(unit).distanceTo(point(target)) <= weapon.range && point(target).distanceTo(this.guard!) <= radius;
                }), new Map());
                const waypoint = this.guard && !atGuard ? getRadiationGuardWaypoint(context, unit, this.guard) : undefined;
                action = waypoint ? BatchableAction.toPoint(unit.id, OrderType.Move, waypoint)
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

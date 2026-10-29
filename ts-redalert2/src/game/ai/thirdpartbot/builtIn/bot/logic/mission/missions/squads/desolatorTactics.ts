import { estimatedCombatWeapons, estimatedHitPoints, estimatedMaxHitPoints, estimatedPurchaseValue, isObservedLivingUnit } from "../../../common/observedUnit";
import { GameApi, GameMath, ObjectType, OrderType, StanceType, UnitData, Vector2, ZoneType } from "../../../../../game-api";
import { MissionContext } from "../../../common/context";
import { BatchableAction } from "../../actionBatcher";
import { isFiringBurst } from "./tacticalTargeting";

type RadiationSite = { point: Vector2; radius: number; expires: number };
type Observation = { tick: number; allies: UnitData[]; sites: Map<string, RadiationSite> };
// Share observations between this player's squads, including units belonging to
// other missions. Enemy sites are learned only from currently visible deployers.
const observations = new WeakMap<GameApi, Map<string, Observation>>();
const pointOf = (unit: UnitData) => new Vector2(unit.tile.rx, unit.tile.ry);

export function getRadiationDeployment(unit: UnitData, game: GameApi) {
    if (unit.name !== "DESO" || !unit.rules.deployFire) return null;
    const weapons = estimatedCombatWeapons(unit, game);
    const weapon = unit.rules.deployFireWeapon === 0 ? weapons[0] : weapons[1];
    const radiation = game.rulesApi?.radiation;
    if (!weapon?.rules.areaFire || !(weapon.rules.radLevel > 0) || !(weapon.warheadRules?.cellSpread > 0) ||
        !(radiation?.radDurationMultiple > 0) || !(radiation.radLevelDelay > 0)) return null;
    const decay = Math.ceil(radiation.radLevelDelay / radiation.radDurationMultiple);
    // MapRadiationTrait decrements its delay through zero before applying decay.
    const lifetime = Math.ceil(weapon.rules.radLevel / decay) * (radiation.radLevelDelay + 1);
    return { weapon, radius: weapon.warheadRules.cellSpread + 1, lifetime, radiation,
        warhead: game.rulesApi.getWarhead(radiation.radSiteWarhead) };
}

function affected(unit: UnitData): boolean {
    return (unit.type as any) !== ObjectType.Building && unit.zone !== ZoneType.Air &&
        !unit.rules.immuneToRadiation && isObservedLivingUnit(unit);
}

export function distanceToSegment(point: Vector2, from: Vector2, to: Vector2): number {
    const dx = to.x - from.x, dy = to.y - from.y;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared ? Math.max(0, Math.min(1,
        ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared)) : 0;
    return point.distanceTo(new Vector2(from.x + dx * fraction, from.y + dy * fraction));
}

/** Conservative memory of observed contamination; undeploying does not remove it. */
export class DesolatorTactics {
    private observation: Observation = { tick: -1, allies: [], sites: new Map() };
    private toggles = new Map<number, { tick: number; deployed: boolean }>();
    private deployedSince = new Map<number, number>();
    private lastUsefulTick = new Map<number, number>();

    observe(context: MissionContext, squadUnits: UnitData[]) {
        const { game } = context;
        const tick = game.getCurrentTick();
        let playerObservations = observations.get(game);
        if (!playerObservations) {
            playerObservations = new Map();
            observations.set(game, playerObservations);
        }
        let observation = playerObservations.get(context.player.name);
        if (!observation) {
            observation = { tick: -1, allies: [], sites: new Map() };
            playerObservations.set(context.player.name, observation);
        }
        if (observation.tick !== tick) {
            observation.tick = tick;
            const visible = game.getVisibleUnits?.bind(game);
            observation.allies = visible
                ? visible(context.player.name, "allied").map(id => game.getUnitData(id)).filter((u): u is UnitData => !!u)
                : squadUnits;
            const enemies = visible ? visible(context.player.name, "enemy", rules => rules.name === "DESO")
                .map(id => game.getUnitData(id)).filter((u): u is UnitData => !!u) : [];
            for (const [key, site] of observation.sites) if (site.expires <= tick) observation.sites.delete(key);
            for (const unit of [...observation.allies, ...enemies]) {
                // Foreign stance is currently withheld by the appearance API.
                // Unknown does not prove either deployment or absence of a
                // plume: do not create/refresh a past-event memory from nominal
                // DESO capability. Previously observed sites keep their expiry.
                if (unit.stance === undefined) continue;
                if ((unit.stance as any) !== StanceType.Deployed) continue;
                const deployment = getRadiationDeployment(unit, game);
                if (!deployment) continue;
                const point = pointOf(unit);
                observation.sites.set(`${unit.id}:${point.x}:${point.y}`, {
                    point, radius: deployment.radius, expires: tick + deployment.lifetime,
                });
            }
        }
        this.observation = observation;
        const liveIds = new Set(squadUnits.map(unit => unit.id));
        for (const id of this.toggles.keys()) if (!liveIds.has(id)) {
            this.toggles.delete(id); this.deployedSince.delete(id); this.lastUsefulTick.delete(id);
        }
    }

    private exposure(unit: UnitData, distance: number, deployment: NonNullable<ReturnType<typeof getRadiationDeployment>>) {
        if (!affected(unit)) return 0;
        const multiplier = deployment.warhead.verses.get(unit.rules.armor) ?? 0;
        const peak = Math.min(deployment.weapon.rules.radLevel, deployment.radiation.radLevelMax) *
            deployment.radiation.radLevelFactor * multiplier;
        // Upper estimate for one full plume, including a full-strength first hit.
        const hits = Math.ceil(deployment.lifetime / (deployment.radiation.radApplicationDelay + 1));
        return peak * Math.max(0, 1 - distance / deployment.radius) * (hits / 2 + 1);
    }

    private deploymentValue(unit: UnitData, targets: UnitData[], squadUnits: UnitData[], targetPoint: Vector2,
        deployment: NonNullable<ReturnType<typeof getRadiationDeployment>>, game: GameApi) {
        const center = pointOf(unit);
        let enemyValue = 0, enemyCount = 0, friendlyValue = 0;
        for (const target of targets) {
            // Prefer a nearby group that can be exposed before walking away.
            const distance = center.distanceTo(pointOf(target));
            if (distance > deployment.radius * 0.7) continue;
            const damage = Math.min(estimatedHitPoints(target, game) ?? estimatedMaxHitPoints(target) ?? 0, this.exposure(target, distance, deployment) * 0.35);
            if (damage <= 0) continue;
            enemyCount++;
            enemyValue += damage / Math.max(1, estimatedMaxHitPoints(target) ?? 1) * (estimatedPurchaseValue(target) ?? 200);
        }
        const squadIds = new Set(squadUnits.map(unit => unit.id));
        for (const ally of this.observation.allies) {
            if (ally.id === unit.id) continue;
            const from = pointOf(ally);
            // Do not contaminate factory/refinery exits, even when no unit is
            // currently standing there. Buildings themselves take no rad damage.
            if ((ally.rules.weaponsFactory || ally.rules.barracks || ally.rules.refinery) &&
                center.distanceTo(from) < deployment.radius + 2) return { safe: false, useful: false };
            if (!affected(ally)) continue;
            let distance = center.distanceTo(from);
            if (squadIds.has(ally.id)) {
                const travel = targetPoint.clone().sub(from);
                if (travel.length() > 8) travel.multiplyScalar(8 / travel.length());
                distance = Math.min(distance, distanceToSegment(center, from, from.clone().add(travel)));
            }
            // Include the visible movement direction of other allied missions.
            if (ally.velocity) {
                const velocity = new Vector2(ally.velocity.x, ally.velocity.z);
                if (velocity.length() > 0) {
                    velocity.multiplyScalar(4 / velocity.length());
                    distance = Math.min(distance, distanceToSegment(center, from, from.clone().add(velocity)));
                }
            }
            const damage = this.exposure(ally, Math.max(0, distance - 1), deployment);
            // Infantry cannot safely share a plume. Outer-edge exposure of a
            // healthy heavy tank is tolerated only if the enemy trade justifies it.
            const budget = (ally.type as any) === ObjectType.Infantry ? 0 : Math.min(
                (ally.maxHitPoints ?? 0) * 0.08, Math.max(0, (ally.hitPoints ?? 0) - (ally.maxHitPoints ?? 0) * 0.7));
            if (damage > budget) return { safe: false, useful: false };
            friendlyValue += damage / Math.max(1, ally.maxHitPoints ?? 1) * (ally.purchaseValue ?? 500);
        }
        return { safe: true, useful: enemyCount >= 2 && enemyValue >= Math.max(200, friendlyValue * 4) };
    }

    decide(context: MissionContext, unit: UnitData, targets: UnitData[], squadUnits: UnitData[], targetPoint: Vector2):
        { handled: boolean; action?: BatchableAction } {
        const deployment = getRadiationDeployment(unit, context.game);
        if (!deployment) return { handled: false };
        const tick = context.game.getCurrentTick();
        const deployed = (unit.stance as any) === StanceType.Deployed;
        const lastToggle = this.toggles.get(unit.id);
        if (lastToggle && lastToggle.deployed !== deployed && tick < lastToggle.tick + 30) return { handled: true };
        if (isFiringBurst(unit)) return { handled: true };
        const value = this.deploymentValue(unit, targets, squadUnits, targetPoint, deployment, context.game);
        const useful = value.useful && !unit.onBridge && (unit.hitPoints ?? 0) >= (unit.maxHitPoints ?? 0) * 0.4;
        if (useful) this.lastUsefulTick.set(unit.id, tick);
        if (deployed) {
            if (!this.deployedSince.has(unit.id)) this.deployedSince.set(unit.id, tick);
            const shouldUndeploy = !value.safe || !!unit.onBridge ||
                tick >= (this.lastUsefulTick.get(unit.id) ?? -Infinity) + 30 ||
                tick >= this.deployedSince.get(unit.id)! + 180;
            if (shouldUndeploy && tick >= (lastToggle?.tick ?? -Infinity) + 30) {
                this.toggles.set(unit.id, { tick, deployed: false });
                this.deployedSince.delete(unit.id);
                return { handled: true, action: BatchableAction.toTargetId(unit.id, OrderType.Deploy, unit.id, 3) };
            }
            return { handled: true };
        }
        this.deployedSince.delete(unit.id);
        if (useful && value.safe && tick >= (lastToggle?.tick ?? -Infinity) + 120) {
            this.toggles.set(unit.id, { tick, deployed: true });
            return { handled: true, action: BatchableAction.toTargetId(unit.id, OrderType.Deploy, unit.id, 2) };
        }
        return { handled: false };
    }

    /** Checks remembered sites only; true does not certify all ground free of radiation. */
    isSafeMove(unit: UnitData, to: Vector2): boolean {
        if (!affected(unit)) return true;
        const from = pointOf(unit);
        for (const site of this.observation.sites.values()) {
            const current = from.distanceTo(site.point), next = to.distanceTo(site.point);
            if (current < site.radius + 1) {
                if (next <= current || distanceToSegment(site.point, from, to) < current - 0.1) return false;
            } else if (distanceToSegment(site.point, from, to) < site.radius + 1) return false;
        }
        return true;
    }

    /** Pick a short safe detour, or escape outward if already in a remembered plume. */
    getSafeWaypoint(unit: UnitData, destination: Vector2, game: GameApi): Vector2 | null {
        if (!affected(unit) || this.isSafeMove(unit, destination)) return destination;
        if (!unit.canMove || unit.rules.speedType === undefined) return null;
        const from = pointOf(unit);
        const inside = [...this.observation.sites.values()].some(site => from.distanceTo(site.point) < site.radius + 1);
        if (!inside) {
            // Do not orbit a target that is itself inside the plume. Hold range
            // until it can be reached safely, or let ranged units fire from here.
            if ([...this.observation.sites.values()].some(site => destination.distanceTo(site.point) < site.radius + 1)) return null;
            if (game.mapApi.findPath) {
                const start = game.mapApi.getTile(from.x, from.y), end = game.mapApi.getTile(destination.x, destination.y);
                if (!start || !end) return null;
                const path = game.mapApi.findPath(unit.rules.speedType,
                    { tile: start, onBridge: !!unit.onBridge }, { tile: end, onBridge: !!unit.onBridge }, {
                        bestEffort: false, maxExpandedNodes: 512,
                        excludeNodes: ({ tile }: any) => [...this.observation.sites.values()]
                            .some(site => new Vector2(tile.rx, tile.ry).distanceTo(site.point) < site.radius + 1),
                    }).slice().reverse();
                const last = path.at(-1)?.tile;
                if (!last || last.rx !== end.rx || last.ry !== end.ry) return null;
                // Follow the actual safe path only as far as a short straight
                // command can go without cutting across the excluded circle.
                let waypoint: Vector2 | null = null;
                let firstStep: Vector2 | null = null;
                for (const node of path) {
                    const point = new Vector2(node.tile.rx, node.tile.ry);
                    if (point.equals(from)) continue;
                    if (node.onBridge !== !!unit.onBridge || from.distanceTo(point) > 4 || !this.isSafeMove(unit, point)) break;
                    firstStep ??= point;
                    waypoint = point;
                }
                if (!waypoint) return null;
                // Move orders do not carry our exclusion filter. Verify the
                // ordinary short path too, or fall back to its safe adjacent step.
                const shortPath = game.mapApi.findPath(unit.rules.speedType,
                    { tile: start, onBridge: !!unit.onBridge },
                    { tile: game.mapApi.getTile(waypoint.x, waypoint.y), onBridge: !!unit.onBridge },
                    { bestEffort: false, maxExpandedNodes: 64 });
                return shortPath.length > 0 && shortPath.every(node => node.onBridge === !!unit.onBridge &&
                    this.isSafeMove(unit, new Vector2(node.tile.rx, node.tile.ry))) ? waypoint : firstStep;
            }
        }
        const options: Vector2[] = [];
        for (const [dx, dy] of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]) {
            const scale = 3 / GameMath.sqrt(dx * dx + dy * dy);
            const point = new Vector2(Math.round(from.x + dx * scale), Math.round(from.y + dy * scale));
            if (!this.isSafeMove(unit, point)) continue;
            const steps = Math.max(Math.abs(point.x - from.x), Math.abs(point.y - from.y));
            let passable = true;
            for (let step = 1; step <= steps; step++) {
                const tile = game.mapApi.getTile(Math.round(from.x + (point.x - from.x) * step / steps),
                    Math.round(from.y + (point.y - from.y) * step / steps));
                if (!tile || !game.mapApi.isPassableTile(tile, unit.rules.speedType, !!unit.onBridge,
                    (unit.type as any) === ObjectType.Infantry)) {
                    passable = false; break;
                }
            }
            if (passable) options.push(point);
        }
        return options.sort((a, b) => a.distanceTo(destination) - b.distanceTo(destination) || a.x - b.x || a.y - b.y)[0] ?? null;
    }
}

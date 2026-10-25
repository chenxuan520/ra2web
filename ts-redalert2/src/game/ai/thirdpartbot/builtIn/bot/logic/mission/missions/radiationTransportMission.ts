import { ObjectType, OrderType, StanceType, UnitData, Vector2, ZoneType } from "../../../../game-api";
import { MissionContext, SupabotContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import { BatchableAction } from "../actionBatcher";
import { Mission, disbandMission, noop, requestSpecificUnits, requestUnits } from "../mission";
import { MissionController } from "../missionController";
import { getRadiationGuardWaypoint, isRadiationGuardPointSafe } from "./radiationGuardMission";
import { findBaseThreat, visibleEnemies } from "./strategicTargets";
import { DesolatorTactics } from "./squads/desolatorTactics";
import { chooseTacticalTarget, getCombatWeapon, isFiringBurst } from "./squads/tacticalTargeting";

const point = (unit: UnitData) => new Vector2(unit.tile.rx, unit.tile.ry);

/** Deliver one specialist to an isolated economy/flank, then return the transport. */
export class RadiationTransportMission extends Mission<string> {
    private stage: "preparing" | "boarding" | "travelling" | "unloading" | "holding" | "returning" = "preparing";
    private payloadId?: number;
    private transportId?: number;
    private landedAt = 0;
    private returningAt = 0;
    private deliveryAborted = false;
    private tactics = new DesolatorTactics();
    private orders = new Map<number, { action: BatchableAction; tick: number }>();

    constructor(private destination: Vector2, private home: Vector2, private createdAt: number, logger: DebugLogger) {
        super("radiationTransport", logger);
    }

    _onAiUpdate(context: MissionContext) {
        const { game, player } = context;
        const tick = game.getCurrentTick();
        if (tick % 6) return noop();
        const members = this.getUnits(game);
        const recruit = members.find(unit => unit.name === "DESO");
        const truck = members.find(unit => unit.name === "HTK");
        this.payloadId ??= recruit?.id;
        this.transportId ??= truck?.id;
        // Boarding removes a passenger from the world and from controller membership.
        // Keep its own ID, then reclaim that same passenger after a real unload.
        const payload = this.payloadId === undefined ? undefined : game.getUnitData(this.payloadId);
        const transport = this.transportId === undefined ? undefined : game.getUnitData(this.transportId);
        if (tick >= this.createdAt + 7200) {
            if (transport && (transport.passengerSlotCount ?? 0) > 0) {
                this.submit(context, transport, BatchableAction.noTarget(transport.id, OrderType.DeploySelected));
            }
            return disbandMission("route-timeout");
        }
        if (payload && payload.owner !== player.name) return disbandMission("payload-owner-changed");
        if (transport && transport.owner !== player.name) return disbandMission("transport-owner-changed");
        if (payload && !this.getUnitIds().includes(payload.id)) return requestSpecificUnits([payload.id], 80);
        this.tactics.observe(context, payload ? [payload] : []);

        if (this.stage === "preparing") {
            if (tick >= this.createdAt + 1200) return disbandMission("production-timeout");
            if (!payload || !transport) return requestUnits({ ...(!payload ? { DESO: 60 } : {}), ...(!transport ? { HTK: 60 } : {}) });
            if ((transport.passengerSlotCount ?? 0) > 0 || (transport.passengerSlotMax ?? 0) < payload.rules.size ||
                transport.rules.sizeLimit < payload.rules.size) return disbandMission("unavailable-capacity");
            this.stage = "boarding";
        }
        if (this.stage === "boarding") {
            if (!transport) return disbandMission("transport-lost");
            if ((transport.passengerSlotCount ?? 0) > 0 && !payload) this.stage = "travelling";
            else if (payload && transport.isIdle && (transport.velocity?.length?.() ?? 0) === 0) {
                this.submit(context, payload, BatchableAction.toTargetId(payload.id, OrderType.EnterTransport, transport.id));
            }
            if (tick >= this.createdAt + 1800) return disbandMission("boarding-timeout");
            return noop();
        }
        if (this.stage === "travelling" || this.stage === "unloading") {
            if (!transport) return disbandMission("transport-lost");
            if (tick >= this.createdAt + 3000 && !this.deliveryAborted) {
                this.deliveryAborted = true;
                this.destination = this.home;
            }
            if (payload && !(transport.passengerSlotCount ?? 0)) {
                if (this.deliveryAborted) return disbandMission("delivery-aborted");
                this.stage = "holding";
                this.landedAt = tick;
            } else if (point(transport).distanceTo(this.destination) <= 1.5) {
                this.stage = "unloading";
                this.submit(context, transport, BatchableAction.noTarget(transport.id, OrderType.DeploySelected));
                return noop();
            } else {
                const waypoint = getRadiationGuardWaypoint(context, transport, this.destination);
                if (waypoint) this.submit(context, transport, BatchableAction.toPoint(transport.id, OrderType.Move, waypoint));
                return noop();
            }
        }
        // The unloaded truck vacates the radiation radius; the shared tactics
        // controller will refuse a plume until that and every other ally are safe.
        if (transport && !(transport.passengerSlotCount ?? 0) && point(transport).distanceTo(this.home) > 3) {
            const waypoint = getRadiationGuardWaypoint(context, transport, this.home);
            if (waypoint && this.tactics.isSafeMove(transport, waypoint)) {
                this.submit(context, transport, BatchableAction.toPoint(transport.id, OrderType.Move, waypoint));
            }
        }
        if (!payload) return disbandMission("payload-lost");
        if (this.stage === "holding" && tick >= this.landedAt + 900) {
            this.stage = "returning";
            this.returningAt = tick;
        }
        if (isFiringBurst(payload)) return noop();
        if (this.stage === "holding" && (payload.stance as any) !== StanceType.Deployed && point(payload).distanceTo(this.destination) > 1.5) {
            const waypoint = getRadiationGuardWaypoint(context, payload, this.destination);
            if (waypoint) this.submit(context, payload, BatchableAction.toPoint(payload.id, OrderType.Move, waypoint));
            return noop();
        }
        const targets = visibleEnemies(context).filter(enemy => point(enemy).distanceTo(point(payload)) <= 13);
        if (this.stage === "returning") {
            if ((payload.stance as any) === StanceType.Deployed) {
                const decision = this.tactics.decide(context, payload, [], [payload], this.home);
                if (decision.action) this.submit(context, payload, decision.action);
            } else {
                if (point(payload).distanceTo(this.home) <= 4 || tick >= this.returningAt + 900) return disbandMission("completed");
                const waypoint = getRadiationGuardWaypoint(context, payload, this.home);
                if (waypoint) this.submit(context, payload, BatchableAction.toPoint(payload.id, OrderType.Move, waypoint));
            }
            return noop();
        }
        const decision = this.tactics.decide(context, payload, targets, [payload], this.destination);
        if (decision.handled) {
            if (decision.action) this.submit(context, payload, decision.action);
        } else {
            const target = chooseTacticalTarget(payload, targets.filter(enemy => {
                const weapon = getCombatWeapon(payload, enemy, true);
                return weapon && point(payload).distanceTo(point(enemy)) <= weapon.range;
            }), new Map());
            if (target) this.submit(context, payload, BatchableAction.toTargetId(payload.id, OrderType.Attack, target.id));
            else if (!payload.isIdle) this.submit(context, payload, BatchableAction.noTarget(payload.id, OrderType.Stop));
        }
        return noop();
    }

    private submit(context: MissionContext, unit: UnitData, action: BatchableAction) {
        const tick = context.game.getCurrentTick(), previous = this.orders.get(unit.id);
        if (!previous || !previous.action.isSameAs(action) || (unit.isIdle && tick >= previous.tick + 90)) {
            context.actionBatcher.push(action);
            this.orders.set(unit.id, { action, tick });
        }
    }
    getPriority() { return 60; }
    getGlobalDebugText() { return `radiation transport ${this.stage}`; }
}

export class RadiationTransportFactory {
    private nextCheck = 0;
    private attempts = 0;

    maybeCreateMissions(context: SupabotContext, controller: MissionController, logger: DebugLogger) {
        const { game, player } = context;
        const tick = game.getCurrentTick();
        if (context.difficulty !== "brutal" || game.getPlayerData(player.name).country?.name !== "Arabs" ||
            tick < this.nextCheck || this.attempts >= 2) return;
        this.nextCheck = tick + 300;
        if (controller.getMissions().some(mission => mission instanceof RadiationTransportMission) || findBaseThreat(context)) return;
        const own = game.getVisibleUnits(player.name, "self").map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
        if (own.filter(unit => unit.rules.harvester).length < 4 || own.filter(unit => ["HTNK", "APOC"].includes(unit.name)).length < 8) return;
        const available = player.production.getAvailableObjects();
        const deso = available.find(rules => rules.name === "DESO"), truck = available.find(rules => rules.name === "HTK");
        if (!deso || !truck || game.getPlayerData(player.name).credits < 2 * (deso.cost + truck.cost)) return;
        const home = game.getPlayerData(player.name).startLocation;
        const targets = visibleEnemies(context).filter(unit => (unit.type as any) !== ObjectType.Building &&
            unit.zone !== ZoneType.Air && !unit.rules.immuneToRadiation && point(unit).distanceTo(home) > 40);
        const candidates: Vector2[] = [];
        for (const target of targets) {
            if (targets.filter(other => point(other).distanceTo(point(target)) <= 4).length < 2) continue;
            for (const [dx, dy] of [[-6, 0], [6, 0], [0, -6], [0, 6], [-5, -5], [5, 5], [-5, 5], [5, -5]]) {
                const location = point(target).add(new Vector2(dx, dy));
                const tile = game.mapApi.getTile(location.x, location.y);
                if (!isRadiationGuardPointSafe(context, location, 11) || !tile ||
                    !game.mapApi.isPassableTile(tile, truck.speedType, false, false)) continue;
                const proxy = { id: -1, name: "HTK", rules: truck, type: ObjectType.Vehicle, zone: ZoneType.Ground,
                    tile: game.mapApi.getTile(Math.round(home.x), Math.round(home.y)), hitPoints: truck.strength,
                    maxHitPoints: truck.strength } as unknown as UnitData;
                if (!proxy.tile || !getRadiationGuardWaypoint(context, proxy, location)) continue;
                candidates.push(location);
            }
        }
        const destination = candidates.sort((a, b) => a.distanceTo(home) - b.distanceTo(home) || a.x - b.x || a.y - b.y)[0];
        if (destination && controller.addMission(new RadiationTransportMission(destination, home, tick, logger))) {
            this.attempts++;
            this.nextCheck = tick + 3600;
            logger(`Radiation transport admitted at ${destination.x},${destination.y}`);
        }
    }
}

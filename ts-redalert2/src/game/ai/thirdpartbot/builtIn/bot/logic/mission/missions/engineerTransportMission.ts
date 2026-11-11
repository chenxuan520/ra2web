import { ObjectType, OrderType, UnitData, Vector2 } from "../../../../game-api";
import { MissionContext, SupabotContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import { BatchableAction } from "../actionBatcher";
import { Mission, disbandMission, noop, requestSpecificUnits, requestUnits } from "../mission";
import { MissionController } from "../missionController";
import { visibleEnemies } from "./strategicTargets";

const point = (unit: UnitData) => new Vector2(unit.tile.rx, unit.tile.ry);

/** An actual engineer passenger must board, ride and unload before attempting capture. */
export class EngineerTransportMission extends Mission<string> {
    private stage: "preparing" | "boarding" | "travelling" | "capturing" = "preparing";
    private engineerId?: number;
    private transportId?: number;
    private landing?: Vector2;
    private orders = new Map<number, { action: BatchableAction; tick: number }>();

    constructor(private targetId: number, private targetPoint: Vector2, private foundation: { width: number; height: number },
        private engineerName: string, private transportName: string, private createdAt: number, logger: DebugLogger) {
        super(`engineerTransport-${createdAt}`, logger);
    }

    _onAiUpdate(context: MissionContext) {
        const { game, player } = context, tick = game.getCurrentTick(), members = this.getUnits(game);
        this.engineerId ??= members.find(unit => unit.name === this.engineerName)?.id;
        this.transportId ??= members.find(unit => unit.name === this.transportName)?.id;
        const engineer = this.engineerId === undefined ? undefined : game.getUnitData(this.engineerId);
        const transport = this.transportId === undefined ? undefined : game.getUnitData(this.transportId);
        if (engineer && engineer.owner !== player.name) return disbandMission("engineer-owner-changed");
        if (transport && transport.owner !== player.name) return disbandMission("transport-owner-changed");
        // Reclaim the same passenger as soon as unloading puts it back in the world.
        if (engineer && !this.getUnitIds().includes(engineer.id)) return requestSpecificUnits([engineer.id], 200);
        if (game.getVisibleUnits(player.name, "self").includes(this.targetId)) return disbandMission("captured");
        if (tick >= this.createdAt + 7200) {
            if (transport && (transport.passengerSlotCount ?? 0) > 0) this.submit(context, transport, BatchableAction.noTarget(transport.id, OrderType.DeploySelected));
            return disbandMission("capture-timeout");
        }
        if (tick % 6) return noop();
        const visible = game.getVisibleUnits(player.name, "enemy").includes(this.targetId);
        const target = visible ? game.getUnitData(this.targetId) : undefined;
        if (target) this.targetPoint = point(target);
        if (this.stage === "preparing") {
            if (tick >= this.createdAt + 1800) return disbandMission("production-timeout");
            if (!engineer || !transport) return requestUnits({ ...(!engineer ? { [this.engineerName]: 120 } : {}), ...(!transport ? { [this.transportName]: 120 } : {}) });
            const size = engineer.rules.size;
            if ((transport.passengerSlotCount ?? 0) > 0 || (transport.passengerSlotMax ?? 0) < size || transport.rules.sizeLimit < size)
                return disbandMission("unavailable-capacity");
            this.stage = "boarding";
        }
        if (this.stage === "boarding") {
            if (!transport) return disbandMission("transport-lost");
            if (tick >= this.createdAt + 2400) return disbandMission("boarding-timeout");
            if ((transport.passengerSlotCount ?? 0) > 0 && !engineer) this.stage = "travelling";
            else if (engineer && transport.isIdle && (transport.velocity?.length?.() ?? 0) === 0)
                this.submit(context, engineer, BatchableAction.toTargetId(engineer.id, OrderType.EnterTransport, transport.id));
            return noop();
        }
        if (this.stage === "travelling") {
            if (!transport) return disbandMission("transport-lost");
            if (engineer && !(transport.passengerSlotCount ?? 0)) this.stage = "capturing";
            else {
                this.landing ??= this.getLandingPoint(context, transport);
                if (!this.landing) {
                    this.submit(context, transport, BatchableAction.noTarget(transport.id, OrderType.DeploySelected));
                    return disbandMission("no-visible-landing");
                }
                if (point(transport).distanceTo(this.landing) <= 1.5)
                    this.submit(context, transport, BatchableAction.noTarget(transport.id, OrderType.DeploySelected));
                else this.submit(context, transport, BatchableAction.toPoint(transport.id, OrderType.Move, this.landing));
                return noop();
            }
        }
        if (!engineer) return disbandMission("engineer-lost");
        if (target?.rules.capturable) this.submit(context, engineer, BatchableAction.toTargetId(engineer.id, OrderType.Capture, this.targetId));
        return noop();
    }

    claimReadyUnits(context: SupabotContext, controller: MissionController) {
        if (this.stage !== "preparing") return;
        for (const name of [this.engineerName, this.transportName]) {
            if (name === this.engineerName ? this.engineerId !== undefined : this.transportId !== undefined) continue;
            const unit = context.game.getVisibleUnits(context.player.name, "self", rules => rules.name === name)
                .map(id => context.game.getUnitData(id)).filter((unit): unit is UnitData => !!unit && !unit.isWarpedOut &&
                    !(unit.passengerSlotCount ?? 0)).sort((a, b) => a.id - b.id).find(unit => {
                    const donor = controller.getMissions().find(mission => mission !== this && mission.getUnitIds().includes(unit.id));
                    return !donor || donor.getUniqueName() === "fieldArmy";
                });
            if (!unit) continue;
            const donor = controller.getMissions().find(mission => mission !== this && mission.getUnitIds().includes(unit.id));
            donor?.removeUnit(unit.id);
            if (!this.getUnitIds().includes(unit.id)) this.addUnit(unit.id);
            if (name === this.engineerName) this.engineerId = unit.id;
            else this.transportId = unit.id;
        }
    }

    private getLandingPoint(context: MissionContext, transport: UnitData): Vector2 | undefined {
        const candidates: Vector2[] = [], { width, height } = this.foundation;
        for (let dx = -1; dx <= width; dx++) for (let dy = -1; dy <= height; dy++) {
            if (dx !== -1 && dx !== width && dy !== -1 && dy !== height) continue;
            const tile = context.game.mapApi.getTile(this.targetPoint.x + dx, this.targetPoint.y + dy);
            if (tile && context.game.mapApi.isVisibleTile(tile, context.player.name) &&
                context.game.mapApi.isPassableTile(tile, transport.rules.speedType, false, false)) candidates.push(new Vector2(tile.rx, tile.ry));
        }
        return candidates.sort((a, b) => a.distanceTo(point(transport)) - b.distanceTo(point(transport)) || a.x - b.x || a.y - b.y)[0];
    }
    private submit(context: MissionContext, unit: UnitData, action: BatchableAction) {
        const tick = context.game.getCurrentTick(), previous = this.orders.get(unit.id);
        if (!previous || !previous.action.isSameAs(action) || (unit.isIdle && tick >= previous.tick + 90)) {
            context.actionBatcher.push(action); this.orders.set(unit.id, { action, tick });
        }
    }
    getPriority() { return 120; }
    getAttackArea() { return this.targetPoint; }
    getGlobalDebugText() { return `engineer transport ${this.stage}`; }
}

export class EngineerTransportFactory {
    private lastCheck = -150;
    private attempts = 0;

    maybeCreateMissions(context: SupabotContext, controller: MissionController, logger: DebugLogger) {
        const { game, player } = context, tick = game.getCurrentTick();
        if (context.difficulty !== "brutal") return;
        const active = controller.getMissions().find((mission): mission is EngineerTransportMission =>
            mission.isActive() && mission instanceof EngineerTransportMission);
        if (active) { active.claimReadyUnits(context, controller); return; }
        if (tick < this.lastCheck + 150 || this.attempts >= 3) return;
        this.lastCheck = tick;
        const available = player.production.getAvailableObjects();
        const engineer = available.find(rules => rules.name === "ENGINEER" || rules.name === "SENGINEER");
        const transport = available.find(rules => rules.name === (engineer?.name === "SENGINEER" ? "HTK" : "FV"));
        if (!engineer || !transport) return;
        const own = game.getVisibleUnits(player.name, "self", rules => rules.harvester).length, data = game.getPlayerData(player.name);
        if (!own && data.credits < engineer.cost + transport.cost) return;
        const target = visibleEnemies(context).filter(unit => (unit.type as any) === ObjectType.Building && unit.foundation &&
            unit.rules.capturable && (unit.rules.weaponsFactory || unit.rules.refinery))
            .sort((a, b) => Number(!!b.rules.weaponsFactory) - Number(!!a.rules.weaponsFactory) || point(a).distanceTo(data.startLocation) -
                point(b).distanceTo(data.startLocation) || a.id - b.id)[0];
        if (target) {
            const mission = new EngineerTransportMission(target.id, point(target), target.foundation, engineer.name, transport.name, tick, logger);
            if (controller.addMission(mission)) { mission.claimReadyUnits(context, controller); this.attempts++; }
        }
    }
}

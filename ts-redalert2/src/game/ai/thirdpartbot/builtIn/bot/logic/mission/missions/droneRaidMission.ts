import { ApiEvent, ApiEventType, ObjectType, OrderType, UnitData, Vector2, ZoneType } from "../../../../game-api";
import { MissionContext, SupabotContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import { findVisiblePatches, patchDistance } from "../../common/orePatches";
import { BatchableAction } from "../actionBatcher";
import { Mission, MissionAction, noop, requestSpecificUnits } from "../mission";
import { MissionController } from "../missionController";
import { getDroneProductionState } from "../../building/droneProduction";

const CHECK_INTERVAL = 30;
const ORDER_COOLDOWN = 60;
const CLAIM_PRIORITY = 80;
const DEFENCES = new Set(["GAPILL", "NALASR", "TESLA", "ATESLA"]);
const point = (unit: UnitData) => new Vector2(unit.tile.rx, unit.tile.ry);

/** Inputs are current visible appearances only; no host infestation or private enemy data is inspected. */
export function selectDroneRaidTarget(drone: UnitData, enemies: readonly UnitData[], reserved: ReadonlySet<number>): UnitData | undefined {
    const defences = enemies.filter(enemy => (enemy.type as any) === ObjectType.Building && DEFENCES.has(enemy.name));
    return enemies.filter(enemy => (enemy.type as any) === ObjectType.Vehicle && enemy.zone === ZoneType.Ground &&
        enemy.name !== "DRON" && (enemy.rules.harvester || point(drone).distanceToSquared(point(enemy)) <= 8 ** 2) &&
        !reserved.has(enemy.id) && !defences.some(defence =>
            point(defence).distanceToSquared(point(enemy)) <= 6 ** 2))
        .sort((a, b) => (a.rules.harvester ? 0 : 1) - (b.rules.harvester ? 0 : 1) ||
            point(drone).distanceToSquared(point(a)) - point(drone).distanceToSquared(point(b)) || a.id - b.id)[0];
}

/** Public start points give a scouting direction, never an opponent's actual starting-slot assignment. */
export function getDroneRaidAmbushPoint(context: SupabotContext): Vector2 | undefined {
    const { game, player } = context;
    const home = game.getPlayerData(player.name).startLocation;
    const enemyStart = game.mapApi.getStartingLocations().filter(start => !start.equals(home))
        .sort((a, b) => home.distanceToSquared(a) - home.distanceToSquared(b) || a.x - b.x || a.y - b.y)[0];
    if (!enemyStart) return;
    const enemyPoint = { rx: enemyStart.x, ry: enemyStart.y };
    const patch = findVisiblePatches(game, player.name).slice().sort((a, b) =>
        patchDistance(enemyPoint, a) - patchDistance(enemyPoint, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    let destination: Vector2;
    if (patch) {
        const tile = patch.tiles.slice().sort((a, b) =>
            (a.rx - home.x) ** 2 + (a.ry - home.y) ** 2 - ((b.rx - home.x) ** 2 + (b.ry - home.y) ** 2) ||
            a.rx - b.rx || a.ry - b.ry)[0];
        destination = new Vector2(tile.rx, tile.ry);
    } else {
        const towardHome = home.clone().sub(enemyStart);
        destination = enemyStart.clone().add(towardHome.multiplyScalar(Math.min(1, 20 / towardHome.length())));
        destination.set(Math.round(destination.x), Math.round(destination.y));
    }
    // Bounds are public. Do not inspect hidden terrain, resources or occupants to adjust this point.
    return game.mapApi.getTile(destination.x, destination.y) ? destination : undefined;
}

/** Claims existing drones by ID; the separate opening production rule owns all purchase decisions. */
export class DroneRaidMission extends Mission {
    private nextCheck = 0;
    private productionState?: ReturnType<typeof getDroneProductionState>;
    private orders = new Map<number, { action: BatchableAction; tick: number }>();

    constructor(logger: DebugLogger) { super("droneRaid", logger); }

    // Independent raiders need no center-of-mass lookup of stale/off-world mission IDs.
    override onAiUpdate(context: MissionContext): MissionAction { return this._onAiUpdate(context); }

    _onAiUpdate(context: MissionContext): MissionAction {
        if (context.difficulty !== "brutal") return noop();
        const { game, player, actionBatcher } = context;
        this.productionState = getDroneProductionState(game, player.name);
        const tick = game.getCurrentTick();
        const ownedIds = game.getVisibleUnits(player.name, "self", rules => rules.name === "DRON").sort((a, b) => a - b);
        for (const id of ownedIds) { this.productionState.seenIds.add(id); this.productionState.aliveIds.add(id); }
        const owned = new Set<number>(ownedIds);
        for (const id of this.getUnitIds()) if (!owned.has(id)) this.removeUnit(id);
        const assigned = new Set(this.getUnitIds());
        const missing = ownedIds.filter(id => !assigned.has(id));
        if (tick >= this.nextCheck) {
            const drones = ownedIds.filter(id => assigned.has(id)).map(id => game.getUnitData(id))
                .filter((unit): unit is UnitData => !!unit && unit.owner === player.name && unit.canMove && !unit.isWarpedOut);
            if (drones.length) {
                this.nextCheck = tick + CHECK_INTERVAL;
                const enemies = game.getVisibleUnits(player.name, "enemy").map(id => game.getUnitData(id))
                    .filter((unit): unit is UnitData => !!unit);
                let ambush: Vector2 | undefined;
                let plannedAmbush = false;
                for (const drone of drones) {
                    const reserved = new Set<number>();
                    for (const [id, order] of this.orders) {
                        if (id !== drone.id && order.action.targetId !== undefined) reserved.add(order.action.targetId);
                    }
                    const target = selectDroneRaidTarget(drone, enemies, reserved);
                    let action: BatchableAction;
                    if (target) action = BatchableAction.toTargetId(drone.id, OrderType.Attack, target.id);
                    else {
                        if (!plannedAmbush) {
                            ambush = getDroneRaidAmbushPoint(context);
                            plannedAmbush = true;
                        }
                        if (!ambush || point(drone).equals(ambush)) continue;
                        action = BatchableAction.toPoint(drone.id, OrderType.Move, ambush);
                    }
                    const previous = this.orders.get(drone.id);
                    if (!previous || !previous.action.isSameAs(action) || (drone.isIdle && tick >= previous.tick + ORDER_COOLDOWN)) {
                        actionBatcher.push(action);
                        this.orders.set(drone.id, { action, tick });
                    }
                }
            }
        }
        return missing.length ? requestSpecificUnits(missing, CLAIM_PRIORITY) : noop();
    }

    /** Forward public lifecycle events on integration. Limbo/transport unspawn is not a death. */
    onGameEvent(event: ApiEvent) {
        if (event.type !== ApiEventType.ObjectDestroy && event.type !== ApiEventType.ObjectOwnerChange) return;
        const id = Number(event.target);
        this.orders.delete(id);
        this.removeUnit(id);
    }

    getState() { return this.productionState && { dronesBuilt: this.productionState.built, dronesAlive: this.productionState.aliveIds.size }; }
    isUnitsLocked() { return true; }
    getPriority() { return CLAIM_PRIORITY; }
    getGlobalDebugText() { return "raiding visible miners"; }
}

export class DroneRaidMissionFactory {
    maybeCreateMissions(context: SupabotContext, controller: MissionController, logger: DebugLogger) {
        if (context.difficulty !== "brutal" || controller.getMissions().some(mission =>
            mission.isActive() && mission instanceof DroneRaidMission)) return;
        controller.addMission(new DroneRaidMission(logger));
    }
}

import { BuildStatus } from "@/game/gameobject/Building";
import { ObjectType, OrderType, UnitData, ZoneType } from "../../../../game-api";
import { SupabotContext } from "../../common/context";

const CHECK_INTERVAL = 30;
const DAMAGE_WINDOW = 120;

interface VehicleObservation {
    hitPoints: number;
    lossTicks: number[];
    depotId?: number;
    incomeHandoffSent?: boolean;
}

const distanceSquared = (a: UnitData, b: UnitData) => (a.tile.rx - b.tile.rx) ** 2 + (a.tile.ry - b.tile.ry) ** 2;
const matchesDockRules = (vehicle: UnitData, depot: UnitData) => vehicle.rules.naval === depot.rules.naval &&
    (!vehicle.rules.consideredAircraft || vehicle.rules.landable);
const insideDepot = (vehicle: UnitData, depot: UnitData) => vehicle.tile.rx >= depot.tile.rx && vehicle.tile.ry >= depot.tile.ry &&
    vehicle.tile.rx < depot.tile.rx + depot.foundation.width && vehicle.tile.ry < depot.tile.ry + depot.foundation.height;

/** Public own HP observations only. The caller also excludes this controller in ecoOnly mode. */
export class ParasiteRepair {
    private nextCheck = 0;
    private seenEnemyDrone = false;
    private vehicles = new Map<number, VehicleObservation>();

    /** Repair intent through egress and income handoff; not private engine dock or parasite state. */
    isRepairing(id: number): boolean { return this.vehicles.get(id)?.depotId !== undefined; }

    onAiUpdate(context: SupabotContext): void {
        if (context.difficulty !== "brutal") return;
        const { game, player } = context;
        const tick = game.getCurrentTick();
        // A drone can be seen and enter limbo between HP scans; retain that public sighting immediately.
        this.seenEnemyDrone ||= game.getVisibleUnits(player.name, "enemy", rules => rules.name === "DRON").length > 0;
        if (tick < this.nextCheck) return;
        this.nextCheck = tick + CHECK_INTERVAL;
        const enemies = game.getVisibleUnits(player.name, "enemy").map(id => game.getUnitData(id))
            .filter((unit): unit is UnitData => !!unit);
        const vehicles = game.getVisibleUnits(player.name, "self", rules => rules.type === ObjectType.Vehicle && rules.parasiteable !== false)
            .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit && unit.owner === player.name &&
                (unit.type as any) === ObjectType.Vehicle && unit.zone === ZoneType.Ground && !unit.isWarpedOut &&
                Number.isFinite(unit.hitPoints) && Number.isFinite(unit.maxHitPoints) && unit.hitPoints > 0 && unit.maxHitPoints > 0)
            .sort((a, b) => a.id - b.id);
        const depots = game.getVisibleUnits(player.name, "self", rules => rules.type === ObjectType.Building &&
            (rules.name === "GADEPT" || rules.name === "NADEPT"))
            .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit && unit.owner === player.name &&
                (unit.type as any) === ObjectType.Building && (unit.buildStatus as any) === BuildStatus.Ready &&
                !unit.isWarpedOut && unit.isPoweredOn !== false && unit.rules.unitRepair && !unit.rules.helipad && unit.rules.numberOfDocks > 0);
        const owned = new Set(vehicles.map(unit => unit.id));
        // Do not query disappeared, captured or off-world IDs to discover their private state.
        for (const id of this.vehicles.keys()) if (!owned.has(id)) this.vehicles.delete(id);
        for (const vehicle of vehicles) {
            const history: VehicleObservation = this.vehicles.get(vehicle.id) ?? { hitPoints: vehicle.hitPoints, lossTicks: [] };
            if (vehicle.hitPoints < history.hitPoints) history.lossTicks.push(tick);
            // Healing or flat samples do not erase a recent observed loss.
            history.lossTicks = history.lossTicks.filter(loss => tick - loss <= DAMAGE_WINDOW);
            history.hitPoints = vehicle.hitPoints;
            this.vehicles.set(vehicle.id, history);
            if (history.incomeHandoffSent && vehicle.isIdle === false) {
                history.depotId = undefined;
                history.incomeHandoffSent = undefined;
            }
            if (vehicle.hitPoints >= vehicle.maxHitPoints) {
                history.lossTicks = [];
                if (history.depotId !== undefined && vehicle.rules.harvester) {
                    if (history.incomeHandoffSent || !vehicle.isIdle || !vehicle.canMove) continue;
                    const refinery = game.getVisibleUnits(player.name, "self", rules => rules.type === ObjectType.Building && rules.refinery)
                        .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit && unit.owner === player.name &&
                            (unit.buildStatus as any) === BuildStatus.Ready && !unit.isWarpedOut && matchesDockRules(vehicle, unit))
                        .sort((a, b) => distanceSquared(vehicle, a) - distanceSquared(vehicle, b) || a.id - b.id)[0];
                    if (refinery) {
                        player.actions.orderUnits([vehicle.id], OrderType.Dock, refinery.id);
                        history.incomeHandoffSent = true;
                    }
                    continue;
                }
                history.depotId = undefined;
                continue;
            }
            if (history.depotId !== undefined) {
                const depot = depots.find(unit => unit.id === history.depotId && matchesDockRules(vehicle, unit));
                if (depot) {
                    if (vehicle.isIdle && !insideDepot(vehicle, depot)) {
                        history.depotId = undefined;
                        history.lossTicks = [];
                    }
                    // A busy Dock task or idle vehicle at its depot must not be restarted every check.
                    continue;
                }
                history.depotId = undefined;
            }
            if (!this.seenEnemyDrone || history.lossTicks.length < 2 || !vehicle.canMove ||
                enemies.some(enemy => distanceSquared(vehicle, enemy) <= 8 ** 2)) continue;
            const depot = depots.filter(unit => matchesDockRules(vehicle, unit))
                .sort((a, b) => distanceSquared(vehicle, a) - distanceSquared(vehicle, b) || a.id - b.id)[0];
            if (!depot) continue;
            player.actions.orderUnits([vehicle.id], OrderType.Dock, depot.id);
            history.depotId = depot.id;
        }
    }
}

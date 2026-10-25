import {
    ActionsApi,
    AttackState,
    BotContext,
    GameApi,
    GameMath,
    MovementZone,
    ObjectType,
    OrderType,
    PlayerData,
    UnitData,
    Vector2,
    ZoneType,
} from "../../../../../game-api";
import { MatchAwareness } from "../../../awareness";
import { getAttackWeight, manageAttackMicro, manageMoveMicro } from "./common";
import { DebugLogger, isOwnedByNeutral, maxBy, minBy } from "../../../common/utils";
import { ActionBatcher, BatchableAction } from "../../actionBatcher";
import { Squad } from "./squad";
import { Mission, MissionAction, grabCombatants, noop } from "../../mission";
import { MissionContext } from "../../../common/context";
import { chooseTacticalTarget, getCombatWeapon, getTacticalRetreatPoint, isFiringBurst, isMissileArtillery } from "./tacticalTargeting";
import { DesolatorTactics } from "./desolatorTactics";
import { getInfantryCrushPoint } from "./infantryCrushing";

const TARGET_UPDATE_INTERVAL_TICKS = 10;

// Units must be in a certain radius of the center of mass before attacking.
// This scales for number of units in the squad though.
const MIN_GATHER_RADIUS = 5;

// If the radius expands beyond this amount then we should switch back to gathering mode.
const MAX_GATHER_RADIUS = 15;

const GATHER_RATIO = 10;

const ATTACK_SCAN_AREA = 15;

enum SquadState {
    Gathering,
    Attacking,
}

export class CombatSquad implements Squad {
    private lastCommand: number | null = null;
    private state = SquadState.Gathering;

    private debugLastTarget: string | undefined;

    private lastOrderGiven: { [unitId: number]: BatchableAction } = {};
    private lastOrderTick = new Map<number, number>();
    private maneuverUntil = new Map<number, number>();
    private injuredReserveUntil = new Map<number, number>();
    private desolatorTactics = new DesolatorTactics();

    /**
     *
     * @param rallyArea the initial location to grab combatants
     * @param targetArea
     * @param radius
     */
    constructor(
        private rallyArea: Vector2,
        private targetArea: Vector2,
        private radius: number,
    ) {}

    public getGlobalDebugText(): string | undefined {
        return this.debugLastTarget ?? "<none>";
    }

    public setAttackArea(targetArea: Vector2) {
        this.targetArea = targetArea;
    }

    public onAiUpdate(context: MissionContext, mission: Mission<any>, logger: DebugLogger): MissionAction {
        const { game, actionBatcher, matchAwareness } = context;
        const brutal = context.difficulty === "brutal";
        const tick = game.getCurrentTick();
        const playerData = game.getPlayerData(context.player.name);
        if (
            mission.getUnitIds().length > 0 &&
            (this.lastCommand === null || tick >= this.lastCommand + (brutal ? 6 : TARGET_UPDATE_INTERVAL_TICKS))
        ) {
            this.lastCommand = game.getCurrentTick();
            const centerOfMass = mission.getCenterOfMass();
            const maxDistance = mission.getMaxDistanceToCenterOfMass();
            const unitIds = mission.getUnitsMatchingByRule(game, (r) => r.isSelectableCombatant);
            const units = unitIds.map((unitId) => game.getUnitData(unitId)).filter((unit): unit is UnitData => !!unit);
            if (brutal) this.desolatorTactics.observe(context, units);
            const livingIds = new Set(unitIds);
            for (const id of this.lastOrderTick.keys()) {
                if (!livingIds.has(id)) {
                    delete this.lastOrderGiven[id];
                    this.lastOrderTick.delete(id);
                    this.maneuverUntil.delete(id);
                    this.injuredReserveUntil.delete(id);
                }
            }

            // Only use ground units for center of mass.
            const groundUnitIds = mission.getUnitsMatchingByRule(
                game,
                (r) =>
                    r.isSelectableCombatant &&
                    (r.movementZone === MovementZone.Infantry ||
                        r.movementZone === MovementZone.Normal ||
                        r.movementZone === MovementZone.InfantryDestroyer),
            );

            if (this.state === SquadState.Gathering) {
                const requiredGatherRadius = GameMath.sqrt(groundUnitIds.length) * GATHER_RATIO + MIN_GATHER_RADIUS;
                if (
                    centerOfMass &&
                    maxDistance &&
                    game.mapApi.getTile(centerOfMass.x, centerOfMass.y) !== undefined &&
                    maxDistance > requiredGatherRadius
                ) {
                    units.forEach((unit) => {
                        if (brutal && isFiringBurst(unit)) return;
                        if (brutal) {
                            const deployment = this.desolatorTactics.decide(context, unit, [], units, centerOfMass);
                            if (deployment.handled) {
                                if (deployment.action) this.submitActionIfNew(actionBatcher, deployment.action, unit, tick);
                                return;
                            }
                        }
                        this.submitMovement(context, unit, centerOfMass, tick);
                    });
                } else {
                    logger(`CombatSquad ${mission.getUniqueName()} switching back to attack mode (${maxDistance})`);
                    this.state = SquadState.Attacking;
                }
            } else {
                const targetPoint = this.targetArea || playerData.startLocation;
                const requiredGatherRadius = GameMath.sqrt(groundUnitIds.length) * GATHER_RATIO + MAX_GATHER_RADIUS;
                if (
                    centerOfMass &&
                    maxDistance &&
                    game.mapApi.getTile(centerOfMass.x, centerOfMass.y) !== undefined &&
                    maxDistance > requiredGatherRadius
                ) {
                    // Switch back to gather mode
                    logger(`CombatSquad ${mission.getUniqueName()} switching back to gather (${maxDistance})`);
                    this.state = SquadState.Gathering;
                    return noop();
                }
                // The unit with the shortest range chooses the target. Otherwise, a base range of 5 is chosen.
                const getRangeForUnit = (unit: UnitData) =>
                    unit.primaryWeapon?.maxRange ?? unit.secondaryWeapon?.maxRange ?? 5;
                const attackLeader = minBy(units, getRangeForUnit);
                if (!attackLeader) {
                    return noop();
                }
                // Find units within double the range of the leader.
                const nearbyHostiles = matchAwareness
                    .getHostilesNearPoint(attackLeader.tile.rx, attackLeader.tile.ry, ATTACK_SCAN_AREA)
                    .map(({ unitId }) => game.getUnitData(unitId))
                    .filter((unit): unit is UnitData => !!unit && !isOwnedByNeutral(unit));

                const committedDamage = new Map<number, number>();
                const unitDataCache = new Map<number, UnitData | undefined>(nearbyHostiles.map(unit => [unit.id, unit]));
                for (const unit of brutal ? [...units].sort((a, b) => a.id - b.id) : units) {
                    // AttackMove may have acquired a target autonomously. The API does
                    // not expose it, so preserve the live firing sequence before retargeting.
                    if (brutal && isFiringBurst(unit)) continue;
                    // Each unit scans its own flank; a distant short-range leader must not blind artillery or AA.
                    const hostiles = brutal ? matchAwareness.getHostilesNearPoint(unit.tile.rx, unit.tile.ry,
                        Math.max(ATTACK_SCAN_AREA, unit.primaryWeapon?.maxRange ?? 0, unit.secondaryWeapon?.maxRange ?? 0))
                        .map(({ unitId }) => {
                            if (!unitDataCache.has(unitId)) unitDataCache.set(unitId, game.getUnitData(unitId));
                            return unitDataCache.get(unitId);
                        }).filter((target): target is UnitData => !!target && !isOwnedByNeutral(target)) : nearbyHostiles;
                    if (brutal) {
                        const deployment = this.desolatorTactics.decide(context, unit, hostiles, units, targetPoint);
                        if (deployment.handled) {
                            if (deployment.action) this.submitActionIfNew(actionBatcher, deployment.action, unit, tick);
                            continue;
                        }
                    }
                    if (brutal && tick < (this.maneuverUntil.get(unit.id) ?? 0)) continue;
                    const crush = brutal ? getInfantryCrushPoint(unit, hostiles, game.mapApi) : null;
                    if (crush && this.desolatorTactics.isSafeMove(unit, crush)) {
                        this.submitActionIfNew(actionBatcher, BatchableAction.toPoint(unit.id, OrderType.Move, crush), unit, tick);
                        this.maneuverUntil.set(unit.id, tick + 18);
                        continue;
                    }
                    const ownPoint = new Vector2(unit.tile.rx, unit.tile.ry);
                    if (brutal && !this.desolatorTactics.isSafeMove(unit, ownPoint)) {
                        const escape = this.desolatorTactics.getSafeWaypoint(unit, ownPoint, game);
                        if (escape && unit.canMove) {
                            this.submitActionIfNew(actionBatcher, BatchableAction.toPoint(unit.id, OrderType.Move, escape), unit, tick);
                            this.maneuverUntil.set(unit.id, tick + 12);
                            continue;
                        }
                    }
                    const retreat = brutal ? getTacticalRetreatPoint(unit, hostiles, game.mapApi,
                        point => this.desolatorTactics.isSafeMove(unit, point)) : null;
                    if (retreat) {
                        this.submitActionIfNew(actionBatcher, BatchableAction.toPoint(unit.id, OrderType.Move, retreat), unit, tick);
                        this.maneuverUntil.set(unit.id, tick + 12);
                        if ((unit.hitPoints ?? Infinity) < (unit.maxHitPoints ?? 0) * 0.3) {
                            this.injuredReserveUntil.set(unit.id, tick + 90);
                        }
                        continue;
                    }
                    const holdingReserve = brutal && (unit.hitPoints ?? Infinity) < (unit.maxHitPoints ?? 0) * 0.3 &&
                        tick < (this.injuredReserveUntil.get(unit.id) ?? 0);
                    const availableTargets = holdingReserve ? hostiles.filter(target => {
                        const weapon = getCombatWeapon(unit, target, true);
                        const distance = ownPoint.distanceTo(new Vector2(target.tile.rx, target.tile.ry));
                        return weapon && distance <= weapon.range && distance >= (weapon.weapon.minRange ?? 0);
                    }) : hostiles;
                    // Filter null weights before maxBy: it returns an element even when all weights are null.
                    const bestUnit = brutal
                        ? chooseTacticalTarget(unit, availableTargets, committedDamage, this.lastOrderGiven[unit.id]?.targetId)
                        : maxBy(hostiles.filter(target => getAttackWeight(unit, target) !== null), target => getAttackWeight(unit, target));
                    if (bestUnit) {
                        const weapon = getCombatWeapon(unit, bestUnit, brutal);
                        const targetLocation = new Vector2(bestUnit.tile.rx, bestUnit.tile.ry);
                        if (brutal && weapon && ownPoint.distanceTo(targetLocation) > weapon.range &&
                            !this.desolatorTactics.isSafeMove(unit, targetLocation)) {
                            this.submitMovement(context, unit, targetLocation, tick);
                            continue;
                        }
                        const action = manageAttackMicro(unit, bestUnit);
                        this.submitActionIfNew(actionBatcher, action, unit, tick);
                        if (brutal && action.orderType === OrderType.Attack && weapon?.damageKnown &&
                            new Vector2(unit.tile.rx, unit.tile.ry).distanceTo(new Vector2(bestUnit.tile.rx, bestUnit.tile.ry)) <= weapon.range) {
                            committedDamage.set(bestUnit.id, (committedDamage.get(bestUnit.id) ?? 0) + weapon.damage);
                        }
                        this.debugLastTarget = `Unit ${bestUnit.id.toString()}`;
                    } else {
                        if (brutal && isMissileArtillery(unit)) {
                            this.followTankEscort(context, unit, units, targetPoint, tick);
                        } else if (holdingReserve) {
                            if (!unit.isIdle) this.submitActionIfNew(actionBatcher, BatchableAction.noTarget(unit.id, OrderType.Stop), unit, tick);
                        } else this.submitMovement(context, unit, targetPoint, tick);
                        this.debugLastTarget = `@${targetPoint.x},${targetPoint.y}`;
                    }
                }
            }
        }
        return noop();
    }

    private followTankEscort(context: MissionContext, unit: UnitData, units: UnitData[], target: Vector2, tick: number) {
        const origin = new Vector2(unit.tile.rx, unit.tile.ry);
        const escort = units.filter(other => other.id !== unit.id && (other.type as any) === ObjectType.Vehicle &&
            !isMissileArtillery(other) && other.zone !== ZoneType.Air && other.primaryWeapon && !other.rules.harvester)
            .sort((a, b) => origin.distanceTo(new Vector2(a.tile.rx, a.tile.ry)) -
                origin.distanceTo(new Vector2(b.tile.rx, b.tile.ry)) || a.id - b.id)[0];
        if (escort) {
            const escortPoint = new Vector2(escort.tile.rx, escort.tile.ry);
            const away = escortPoint.clone().sub(target);
            if (away.length() > 0) away.multiplyScalar(3 / away.length());
            const rear = escortPoint.clone().add(away);
            rear.set(Math.round(rear.x), Math.round(rear.y));
            if (origin.distanceTo(rear) > 2) {
                this.submitMovement(context, unit, rear, tick, false);
                return;
            }
        }
        if (!unit.isIdle) this.submitActionIfNew(context.actionBatcher, BatchableAction.noTarget(unit.id, OrderType.Stop), unit, tick);
    }

    private submitMovement(context: MissionContext, unit: UnitData, destination: Vector2, tick: number, attackMove = true) {
        if (context.difficulty === "brutal") {
            const safePoint = this.desolatorTactics.getSafeWaypoint(unit, destination, context.game);
            if (!safePoint) {
                if (!unit.isIdle) this.submitActionIfNew(context.actionBatcher, BatchableAction.noTarget(unit.id, OrderType.Stop), unit, tick);
                return;
            }
            if (!safePoint.equals(destination)) {
                this.submitActionIfNew(context.actionBatcher, BatchableAction.toPoint(unit.id, OrderType.Move, safePoint), unit, tick);
                this.maneuverUntil.set(unit.id, tick + 12);
                return;
            }
        }
        this.submitActionIfNew(context.actionBatcher, attackMove ? manageMoveMicro(unit, destination) :
            BatchableAction.toPoint(unit.id, OrderType.Move, destination), unit, tick);
    }

    /**
     * Sends an action to the actionBatcher if and only if the action is different from the last action we submitted to it.
     * Prevents spamming redundant orders, which affects performance and can also cause the unit to sit around doing nothing.
     */
    private submitActionIfNew(actionBatcher: ActionBatcher, action: BatchableAction, unit: UnitData, tick: number) {
        const lastAction = this.lastOrderGiven[action.unitId];
        // An idle unit may have lost an order to a blocked path; retry slowly, without resetting active attacks.
        if (!lastAction || !lastAction.isSameAs(action) ||
            (unit.isIdle && tick >= (this.lastOrderTick.get(unit.id) ?? 0) + 30)) {
            actionBatcher.push(action);
            this.lastOrderGiven[action.unitId] = action;
            this.lastOrderTick.set(action.unitId, tick);
        }
    }
}

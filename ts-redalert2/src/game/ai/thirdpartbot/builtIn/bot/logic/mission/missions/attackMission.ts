import { sp } from "../../../strategy/params";
import { estimatedMaxHitPoints } from "../../common/observedUnit";
import { GameApi, ObjectType, PlayerData, QueueStatus, UnitData, Vector2 } from "../../../../game-api";
import { CombatSquad } from "./squads/combatSquad";
import { Mission, MissionAction, disbandMission, noop, requestUnits } from "../mission";
import { MatchAwareness } from "../../awareness";
import { MissionController } from "../missionController";
import { RetreatMission } from "./retreatMission";
import { DebugLogger, isOwnedByNeutral, maxBy } from "../../common/utils";
import { manageMoveMicro } from "./squads/common";
import { MissionContext, SupabotContext } from "../../common/context";
import { UnitComposition } from "../../../strategy/strategy";
import { SideComposition } from "../../../strategy/compositionUtils";
import { allocateAttackComposition } from "./attackComposition";
import { HarassmentMissionFactory } from "./harassmentMission";
import { getKnownEnemyDirections } from "../../common/knownEnemyDirections";

export enum AttackFailReason {
    NoTargets = "NoTargets",
    DefenceTooStrong = "DefenceTooStrong",
    UnableToAcquireUnits = "UnableToAcquireUnits",
    OutOfUnits = "OutOfUnits",
}

enum AttackMissionState {
    Preparing = 0,
    Attacking = 1,
    Retreating = 2,
}

const NO_TARGET_RETARGET_TICKS = 300;
const NO_TARGET_IDLE_TIMEOUT_TICKS = 600;

const ATTACK_MISSION_PRIORITY_RAMP = 1.01;
const ATTACK_MISSION_MAX_PRIORITY = 50;
// While preparing the squad, how many ticks to wait before dropping one unit from the desired squad size. If the squad size drops below the minimum, the attack mission is aborted.
const REQUESTED_UNIT_COUNT_DECAY_TICKS = 120;
// A tank needs longer than the old 24-second six-to-four-unit mission lifetime.
// Preserve its production request while it is being built instead of restarting the wave.

/**
 * A mission that tries to attack a certain area.
 */
export class AttackMission extends Mission<AttackFailReason> {
    private squad: CombatSquad;
    private preparingSquad: CombatSquad;

    private lastTargetSeenAt = 0;
    private hasPickedNewTarget: boolean = false;

    private state: AttackMissionState = AttackMissionState.Preparing;
    private requestedUnitCount: number;
    private lastRequestedUnitCountDecayAt: number | null = null;
    private preparationStartedAt: number | null = null;
    private lastReinforcementAt: number | null = null;
    private previousPreparingUnitCount = 0;
    private closestApproach = Infinity;
    private lastApproachProgressAt = 0;

    constructor(
        uniqueName: string,
        private priority: number,
        rallyArea: Vector2,
        private attackArea: Vector2,
        private radius: number,
        private composition: SideComposition,
        logger: DebugLogger,
        context?: SupabotContext,
    ) {
        super(uniqueName, logger);
        this.squad = new CombatSquad(rallyArea, attackArea, radius);
        this.preparingSquad = new CombatSquad(rallyArea, rallyArea, (context?.difficulty === "brutal" ? sp(context!.game, context!.player.name, 'assault.preparingWaveRadius') : 18), true);
        this.requestedUnitCount = composition.maximumUnits;
    }

    _onAiUpdate(context: MissionContext): MissionAction {
        switch (this.state) {
            case AttackMissionState.Preparing:
                return this.handlePreparingState(context);
            case AttackMissionState.Attacking:
                return this.handleAttackingState(context);
            case AttackMissionState.Retreating:
                return this.handleRetreatingState(context);
        }
    }

    private handlePreparingState(context: MissionContext) {
        const { game } = context;
        const tick = game.getCurrentTick();
        const brutal = context.difficulty === "brutal";
        if (brutal && this.getUnitIds().length) {
            this.preparingSquad.setAttackArea(context.matchAwareness.getMainRallyPoint());
            this.preparingSquad.onAiUpdate(context, this, this.logger);
        }
        if (!brutal) this.decayDesiredCompositionIfNeeded(game);
        if (this.requestedUnitCount < this.composition.minimumUnits) {
            return disbandMission(AttackFailReason.UnableToAcquireUnits);
        }

        const desiredComposition = this.getDesiredComposition();
        const missingUnits = this.getMissingUnits(game, desiredComposition);
        if (brutal && missingUnits.length > 0) {
            this.preparationStartedAt ??= tick;
            this.lastReinforcementAt ??= tick;
            const receivedUnits = this.getUnitIds().length;
            if (receivedUnits > this.previousPreparingUnitCount) this.lastReinforcementAt = tick;
            this.previousPreparingUnitCount = receivedUnits;

            // Start with the intended minimum mixed force once it is available;
            // do not erase the request just because producing it takes time.
            const armor = this.getUnits(game).filter(unit => ["MTNK", "HTNK", "MGTK", "APOC"].includes(unit.name)).length;
            const needsAirCover = (context.matchAwareness.getThreatCache?.()?.totalOffensiveAirThreat ?? 0) > 0;
            if (tick - this.preparationStartedAt >= sp(context.game, context.player.name, 'assault.minimumWaveWaitTicks') &&
                (this.getMissingUnits(game, this.getDesiredComposition(this.composition.minimumUnits, false)).length === 0 ||
                    (!needsAirCover && armor >= Math.max(sp(context.game, context.player.name, 'assault.noAirCoverWaveArmorCount'), this.composition.minimumUnits)))) {
                this.requestedUnitCount = this.composition.minimumUnits;
                return this.startAttack(tick, context);
            }
            const missingNames = new Set(missingUnits.map(([name]) => name));
            const pendingReinforcements = context.player.production.getAvailableObjects()
                .filter(option => missingNames.has(option.name))
                .some(option => {
                    const queue = context.player.production.getQueueData(context.player.production.getQueueTypeForObject(option));
                    return queue.status !== QueueStatus.Idle && queue.items.some(item => missingNames.has(item.rules.name));
                });
            if (tick - this.preparationStartedAt >= sp(context.game, context.player.name, 'assault.maxPreparationTicks') ||
                (tick - this.lastReinforcementAt >= sp(context.game, context.player.name, 'assault.reinforcementTimeoutTicks') && !pendingReinforcements)) {
                return disbandMission(AttackFailReason.UnableToAcquireUnits);
            }
        }
        if (missingUnits.length > 0) {
            this.priority = Math.min(this.priority * (context.difficulty === "brutal" ? sp(context.game, context.player.name, 'assault.wavePriorityRampFactor') : ATTACK_MISSION_PRIORITY_RAMP), (context.difficulty === "brutal" ? sp(context.game, context.player.name, 'assault.waveMaximumPriority') : ATTACK_MISSION_MAX_PRIORITY));
            // distribute the priority among the amount of missing units of each type
            const totalMissingUnits = missingUnits.reduce((sum, [, numMissing]) => sum + numMissing, 0);
            const unitPriorities = Object.fromEntries(
                missingUnits.map(([unitName, numMissing]) => [
                    unitName,
                    (this.priority * numMissing) / totalMissingUnits,
                ]),
            );
            return requestUnits(unitPriorities);
        } else {
            return this.startAttack(tick, context);
        }
    }

    private startAttack(tick: number, context: MissionContext): MissionAction {
        this.priority = (context.difficulty === "brutal" ? sp(context.game, context.player.name, 'assault.attackMissionInitialPriority') : ATTACK_MISSION_INITIAL_PRIORITY);
        this.state = AttackMissionState.Attacking;
        this.lastTargetSeenAt = tick;
        this.hasPickedNewTarget = false;
        this.closestApproach = Infinity;
        this.lastApproachProgressAt = tick;
        return noop();
    }

    private handleAttackingState(context: MissionContext) {
        const { game, matchAwareness, actionBatcher } = context;
        const playerData = game.getPlayerData(context.player.name);
        if (this.getUnitIds().length === 0) {
            // TODO: disband directly (we no longer retreat when losing)
            this.state = AttackMissionState.Retreating;
            return noop();
        }

        const foundTargets = matchAwareness
            .getHostilesNearPoint2d(this.attackArea, this.radius)
            .map((unit) => game.getUnitData(unit.unitId))
            .filter((unit): unit is UnitData => !!unit && !isOwnedByNeutral(unit));

        const update = this.squad.onAiUpdate(context, this, this.logger);

        if (update.type !== "noop") {
            return update;
        }

        const approaching = context.difficulty === "brutal" && this.isApproachingTarget(game.getCurrentTick(), context);
        if (foundTargets.length > 0) {
            this.lastTargetSeenAt = game.getCurrentTick();
            this.hasPickedNewTarget = false;
        } else if (game.getCurrentTick() > this.lastTargetSeenAt + (context.difficulty === "brutal" ? sp(context.game, context.player.name, 'assault.noTargetIdleTimeoutTicks') : NO_TARGET_IDLE_TIMEOUT_TICKS) &&
            !approaching) {
            return disbandMission(AttackFailReason.NoTargets);
        } else if (
            !this.hasPickedNewTarget &&
            game.getCurrentTick() > this.lastTargetSeenAt + (context.difficulty === "brutal" ? sp(context.game, context.player.name, 'assault.noTargetRetargetTicks') : NO_TARGET_RETARGET_TICKS)
        ) {
            const newTarget = generateTarget(game, playerData, matchAwareness, false, context.difficulty);
            if (newTarget) {
                this.attackArea = newTarget;
                this.squad.setAttackArea(newTarget);
                this.lastTargetSeenAt = game.getCurrentTick();
                this.hasPickedNewTarget = true;
                this.closestApproach = Infinity;
                this.lastApproachProgressAt = game.getCurrentTick();
            }
        }

        return noop();
    }

    private isApproachingTarget(tick: number, context: MissionContext) {
        const center = this.getCenterOfMass();
        if (!center) return false;
        const distance = center.distanceTo(this.attackArea);
        if (distance < this.closestApproach - 1) {
            this.closestApproach = distance;
            this.lastApproachProgressAt = tick;
        }
        return distance > this.radius && tick - this.lastApproachProgressAt < sp(context.game, context.player.name, 'assault.approachProgressTimeoutTicks');
    }

    private handleRetreatingState(context: MissionContext) {
        const { game, actionBatcher, matchAwareness } = context;
        this.getUnits(game).forEach((unitId) => {
            actionBatcher.push(manageMoveMicro(unitId, matchAwareness.getMainRallyPoint()));
        });
        // Note: probably should just disband rather than have a retreating state
        return disbandMission(AttackFailReason.OutOfUnits);
    }

    public getGlobalDebugText(): string | undefined {
        return this.squad.getGlobalDebugText() ?? "<none>";
    }

    public getState() {
        return this.state;
    }

    // This mission can give up its units while preparing.
    public isUnitsLocked(): boolean {
        return this.state !== AttackMissionState.Preparing;
    }

    public getPriority() {
        return this.priority;
    }

    public getAttackArea(): Vector2 {
        return this.attackArea;
    }

    /** Undelivered slots reserved by this fixed plan; used only when choosing a new wave. */
    public getPendingSupportUnits(game: GameApi): UnitComposition {
        if (!this.isActive() || this.state !== AttackMissionState.Preparing || !this.composition.supportUnits) return {};
        const desired = this.getDesiredComposition();
        const support = Object.fromEntries(Object.keys(this.composition.supportUnits)
            .filter(name => desired[name] > 0)
            .map(name => [name, desired[name]]));
        return Object.fromEntries(this.getMissingUnits(game, support));
    }

    private decayDesiredCompositionIfNeeded(game: GameApi): void {
        const currentTick = game.getCurrentTick();
        if (this.lastRequestedUnitCountDecayAt === null) {
            this.lastRequestedUnitCountDecayAt = currentTick;
            return;
        }

        if (currentTick <= this.lastRequestedUnitCountDecayAt + REQUESTED_UNIT_COUNT_DECAY_TICKS) {
            return;
        }

        this.lastRequestedUnitCountDecayAt = currentTick;
        this.requestedUnitCount--;
    }

    private getDesiredComposition(unitCount = this.requestedUnitCount, includeSupport = true): UnitComposition {
        return allocateAttackComposition(this.composition, unitCount, includeSupport);
    }
}

// Calculates the weight for initiating an attack on the position of a unit or building.
// This is separate from unit micro; the squad will be ordered to attack in the vicinity of the point.
const getTargetWeight: (unitData: UnitData, tryFocusHarvester: boolean, game: GameApi, playerName: string, difficulty?: "normal" | "brutal") => number = (unitData, tryFocusHarvester, game, playerName, difficulty) => {
    if (tryFocusHarvester && unitData.rules.harvester) {
        return (difficulty === "brutal" ? sp(game, playerName, 'assault.harvesterFocusWeight') : 100000);
    } else if (unitData.type as any === ObjectType.Building) {
        return (estimatedMaxHitPoints(unitData) ?? 1) * (difficulty === "brutal" ? sp(game, playerName, 'assault.buildingTargetHpFactor') : 10);
    } else {
        return estimatedMaxHitPoints(unitData) ?? 1;
    }
};

function generateTarget(
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
    includeBaseLocations: boolean = false,
    difficulty?: "normal" | "brutal",
): Vector2 | null {
    // Randomly decide between harvester and base.
    try {
        const tryFocusHarvester = gameApi.generateRandomInt(0, 1) === 0;
        const enemyUnits = gameApi
            .getVisibleUnits(playerData.name, "enemy")
            .map((unitId) => gameApi.getUnitData(unitId))
            .filter((u) => !!u && gameApi.getPlayerData(u.owner).isCombatant) as UnitData[];

        const maxUnit = maxBy(enemyUnits, (u) => getTargetWeight(u, tryFocusHarvester, gameApi, playerData.name, difficulty));
        if (maxUnit) {
            return new Vector2(maxUnit.tile.rx, maxUnit.tile.ry);
        }
        if (includeBaseLocations) {
            const searchLocations = getKnownEnemyDirections(gameApi, playerData);
            if (searchLocations.length > 0) {
                const idx = gameApi.generateRandomInt(0, searchLocations.length - 1);
                return searchLocations[idx];
            }
        }
    } catch (err) {
        // There's a crash here when accessing a building that got destroyed. Will catch and ignore or now.
        return null;
    }
    return null;
}

// Number of ticks between attacking visible targets.
const VISIBLE_TARGET_ATTACK_COOLDOWN_TICKS = 60;

// Number of ticks between attacking "bases" (enemy starting locations).
const BASE_ATTACK_COOLDOWN_TICKS = 600;

const ATTACK_MISSION_INITIAL_PRIORITY = 1;

export class AttackMissionFactory {
    private harassmentFactory = new HarassmentMissionFactory();
    constructor(private lastAttackAt: number = -VISIBLE_TARGET_ATTACK_COOLDOWN_TICKS) {}

    getName(): string {
        return "AttackMissionFactory";
    }

    maybeCreateMissions(
        context: SupabotContext,
        missionController: MissionController,
        logger: DebugLogger,
        composition: SideComposition,
    ): void {
        const { game, matchAwareness } = context;
        const playerData = game.getPlayerData(context.player.name);
        if (!composition) {
            return;
        }

        if (context.difficulty === "brutal") {
            this.harassmentFactory.maybeCreateMissions(context, missionController, logger,
                missionController.getMissions().filter((mission): mission is AttackMission =>
                    mission instanceof AttackMission && mission.isActive() && mission.getState() === AttackMissionState.Attacking));
        }

        if (game.getCurrentTick() < this.lastAttackAt + VISIBLE_TARGET_ATTACK_COOLDOWN_TICKS) {
            return;
        }

        // Limit concurrent preparing attacks to 2.
        const preparingCount = missionController
            .getMissions()
            .filter(
                (mission): mission is AttackMission =>
                    mission instanceof AttackMission && mission.getState() === AttackMissionState.Preparing,
            ).length;
        if (preparingCount >= 2) {
            return;
        }

        const attackRadius = (context.difficulty === "brutal" ? sp(context.game, context.player.name, 'assault.attackTargetRadius') : 10);

        const includeEnemyBases = game.getCurrentTick() > this.lastAttackAt + (context.difficulty === "brutal" ? sp(context.game, context.player.name, 'assault.baseAttackCooldownTicks') : BASE_ATTACK_COOLDOWN_TICKS);

        const attackArea = generateTarget(game, playerData, matchAwareness, includeEnemyBases, context.difficulty);

        if (!attackArea) {
            return;
        }

        const squadName = "attack_" + game.getCurrentTick();

        const tryAttack = missionController.addMission(
            new AttackMission(
                squadName,
                (context.difficulty === "brutal" ? sp(context.game, context.player.name, 'assault.attackMissionInitialPriority') : ATTACK_MISSION_INITIAL_PRIORITY),
                matchAwareness.getMainRallyPoint(),
                attackArea,
                attackRadius,
                composition,
                logger,
                context,
            ).withOnFinish((unitIds, reason) => {
                logger(
                    `Attack ${squadName} (${JSON.stringify(composition)}) with ${
                        unitIds.length
                    } units finished with reason: ${reason}`,
                );
                missionController.addMission(
                    new RetreatMission(
                        "retreat-from-" + squadName + game.getCurrentTick(),
                        matchAwareness.getMainRallyPoint(),
                        unitIds,
                        logger,
                    ),
                );
            }),
        );
        if (tryAttack) {
            this.lastAttackAt = game.getCurrentTick();
        }
    }
}

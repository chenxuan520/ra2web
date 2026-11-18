import { sp } from "../../../strategy/params";
import { OrderType, UnitData, Vector2 } from "../../../../game-api";
import { MissionContext, SupabotContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import { BatchableAction } from "../actionBatcher";
import { Mission, MissionAction, disbandMission, noop, requestSpecificUnits } from "../mission";
import { MissionController } from "../missionController";
import { CombatSquad } from "./squads/combatSquad";
import { isFiringBurst } from "./squads/tacticalTargeting";
import { findBaseThreat, isLivingUnit, isRaidTank, RAID_SIZE, RAID_TARGET_SEPARATION, raidTargetIsSafe, raidUnderPressure, selectRaidTarget, visibleEnemies } from "./strategicTargets";

type MainForce = Mission<any> & { getAttackArea(): Vector2 };
const CHECK_INTERVAL = 30;

/** An existing surplus detachment. Never requests a unit type for production. */
export class HarassmentMission extends Mission<string> {
    private stage: "claiming" | "raiding" | "returning" = "claiming";
    private squad: CombatSquad;
    private lastCheck = -Infinity;
    private lastReturnOrder = new Map<number, number>();
    private returnReason = "complete";
    private returnStartedAt: number | null = null;

    constructor(name: string, private claimedIds: number[], private targetId: number,
        private home: Vector2, target: Vector2, private createdAt: number, logger: DebugLogger,
        private getMainTargets: () => Vector2[] = () => [], context?: SupabotContext) {
        super(name, logger);
        this.squad = new CombatSquad(home, target, (context?.difficulty === "brutal" ? sp(context!.game, context!.player.name, 'harass.raidTargetRadius') : 8));
    }

    _onAiUpdate(context: MissionContext): MissionAction {
        const tick = context.game.getCurrentTick();
        const units = this.getUnits(context.game).filter(isLivingUnit);
        if (this.stage === "claiming") {
            if (units.length >= RAID_SIZE) this.stage = "raiding";
            else if (tick - this.createdAt >= sp(context.game, context.player.name, 'harass.claimTimeoutTicks')) this.beginReturn("claim-timeout");
            else return requestSpecificUnits(this.claimedIds, sp(context.game, context.player.name, 'harass.claimPriority'));
        }
        if (!units.length) return disbandMission("out-of-units");

        if (this.stage === "raiding" && tick >= this.lastCheck + CHECK_INTERVAL) {
            this.lastCheck = tick;
            const enemies = visibleEnemies(context);
            const target = enemies.find(enemy => enemy.id === this.targetId);
            if (findBaseThreat(context)) this.beginReturn("base-under-attack");
            else if (tick - this.createdAt >= sp(context.game, context.player.name, 'harass.raidLifetimeTicks')) this.beginReturn("raid-timeout");
            else if (units.filter(isRaidTank).length < sp(context.game, context.player.name, 'harass.raidContinueTankCount')) this.beginReturn("insufficient-force");
            else if (raidUnderPressure(units, enemies, context.game)) this.beginReturn("local-force-disadvantage");
            else if (!target) this.beginReturn("target-no-longer-visible");
            else if (this.getMainTargets().some(point => point.distanceTo(new Vector2(target.tile.rx, target.tile.ry)) < RAID_TARGET_SEPARATION)) {
                this.beginReturn("main-force-converged");
            }
            else if (!raidTargetIsSafe(target, units, enemies, context.game)) this.beginReturn("target-defended");
            else this.squad.setAttackArea(new Vector2(target.tile.rx, target.tile.ry));
        }
        if (this.stage === "returning") {
            this.returnStartedAt ??= tick;
            if (tick - this.returnStartedAt >= sp(context.game, context.player.name, 'harass.returnTimeoutTicks') || units.every(unit => this.home.distanceTo(new Vector2(unit.tile.rx, unit.tile.ry)) <= sp(context.game, context.player.name, 'harass.returnArrivalRadius'))) {
                // No final movement order: the controller may allocate released units this frame.
                return disbandMission(this.returnReason);
            }
            for (const unit of units) {
                const lastOrder = this.lastReturnOrder.get(unit.id);
                if (!isFiringBurst(unit) && (lastOrder === undefined || (unit.isIdle && tick >= lastOrder + 90))) {
                    context.actionBatcher.push(BatchableAction.toPoint(unit.id, OrderType.Move, this.home));
                    this.lastReturnOrder.set(unit.id, tick);
                }
            }
            return noop();
        }
        return this.squad.onAiUpdate(context, this, this.logger);
    }

    private beginReturn(reason: string) {
        this.stage = "returning";
        this.returnReason = reason;
    }

    getState() { return this.stage; }
    getPriority(context: MissionContext) { return sp(context.game, context.player.name, 'harass.raidMissionPriority'); }
    getGlobalDebugText() { return `${this.stage} target=${this.targetId}`; }
}

export class HarassmentMissionFactory {
    private lastCheck = -Infinity;
    private lastLaunch = -Infinity;

    maybeCreateMissions(context: SupabotContext, controller: MissionController, logger: DebugLogger, mainForces: MainForce[]) {
        const tick = context.game.getCurrentTick();
        if (context.difficulty !== "brutal" || tick < this.lastCheck + CHECK_INTERVAL) return;
        this.lastCheck = tick;
        if (tick < this.lastLaunch + sp(context.game, context.player.name, 'harass.raidLaunchCooldownTicks') || controller.getMissions().some(mission => mission.isActive() && mission instanceof HarassmentMission) ||
            findBaseThreat(context)) return;
        const main = mainForces.filter(force => force.isActive()).map(force => {
            const units = force.getUnits(context.game).filter(isLivingUnit);
            return { force, combatants: units.filter(unit => unit.rules.isSelectableCombatant && !unit.rules.harvester),
                tanks: units.filter(isRaidTank).sort((a, b) => a.id - b.id) };
        });
        let mainCombatants = main.reduce((sum, entry) => sum + entry.combatants.length, 0);
        let mainTanks = main.reduce((sum, entry) => sum + entry.tanks.length, 0);
        if (mainCombatants < sp(context.game, context.player.name, 'harass.mainCombatantFloor') || mainTanks < sp(context.game, context.player.name, 'harass.mainTankFloor')) return;
        const assigned = new Set(controller.getMissions().flatMap(mission => mission.getUnitIds()));
        const owned = context.game.getVisibleUnits(context.player.name, "self")
            .map(id => context.game.getUnitData(id)).filter((unit): unit is UnitData => isLivingUnit(unit));
        const donations = new Map<MainForce, UnitData[]>();
        let raiders = owned.filter(unit => !assigned.has(unit.id) && isRaidTank(unit)).sort((a, b) => a.id - b.id).slice(0, RAID_SIZE);
        if (raiders.length < RAID_SIZE) {
            // Pool only surplus from already attacking waves. Preparing waves
            // retain every reservation, so a raid cannot create replacement demand.
            for (const donor of main) {
                const count = Math.min(RAID_SIZE - raiders.length, donor.combatants.length - sp(context.game, context.player.name, 'harass.donorCombatantFloor'),
                    donor.tanks.length - sp(context.game, context.player.name, 'harass.donorTankFloor'), mainCombatants - sp(context.game, context.player.name, 'harass.mainCombatantFloor'), mainTanks - sp(context.game, context.player.name, 'harass.mainTankFloor'));
                if (count <= 0) continue;
                const tanks = donor.tanks.slice(-count);
                donations.set(donor.force, tanks);
                raiders = [...raiders, ...tanks];
                mainCombatants -= count;
                mainTanks -= count;
                if (raiders.length === RAID_SIZE) break;
            }
            if (raiders.length < RAID_SIZE) return;
        }
        const target = selectRaidTarget(context, raiders, main.map(({ force }) => force.getAttackArea()));
        if (!target) return;
        const mission = new HarassmentMission(`harassment_${tick}`, raiders.map(unit => unit.id), target.id,
            context.matchAwareness.getMainRallyPoint(), new Vector2(target.tile.rx, target.tile.ry), tick, logger,
            () => mainForces.filter(force => force.isActive()).map(force => force.getAttackArea()), context);
        if (!controller.addMission(mission)) return;
        // The controller rebuilds ownership before polling missions; these IDs can then
        // be claimed once, before generic production requests allocate free units.
        for (const [donor, units] of donations) for (const unit of units) donor.removeUnit(unit.id);
        this.lastLaunch = tick;
        logger(`Harassment ${mission.getUniqueName()} detached ${raiders.length} existing tanks toward ${target.id}`);
    }
}

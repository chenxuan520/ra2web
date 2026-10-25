import { ObjectType, OrderType, UnitData, Vector2, ZoneType } from "../../../../game-api";
import { MissionContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import { Mission, noop, requestUnits } from "../mission";
import { BatchableAction } from "../actionBatcher";
import type { FieldArmyMission } from "./fieldArmyMission";
import { DesolatorTactics } from "./squads/desolatorTactics";
import { getCombatWeapon, isFiringBurst } from "./squads/tacticalTargeting";

const pointOf = (unit: UnitData) => new Vector2(unit.tile.rx, unit.tile.ry);

/** Keep a small dog screen with the real field army, without commanding its tanks. */
export class DogEscortMission extends Mission {
    private safety = new DesolatorTactics();
    private lastCheck = -Infinity;
    private orders = new Map<number, { action: BatchableAction; tick: number }>();

    constructor(private army: Pick<FieldArmyMission, "getUnitsOfTypes" | "getAttackArea">,
        logger: DebugLogger, private escortEnabled = true) {
        super("dogEscort", logger);
    }

    getPriority() { return 25; }
    getGlobalDebugText() { return this.escortEnabled ? "rhino dog screen" : "dog screen control disabled"; }

    _onAiUpdate(context: MissionContext) {
        const { game, player, matchAwareness } = context;
        if (context.difficulty !== "brutal") return noop();
        const tick = game.getCurrentTick();
        const dogs = this.getUnitsOfTypes(game, "DOG").filter(unit => unit.hitPoints > 0 && !unit.isWarpedOut);
        const tanks = this.army.getUnitsOfTypes(game, "HTNK").filter(unit => unit.hitPoints > 0 &&
            !unit.isWarpedOut && unit.zone !== ZoneType.Air).sort((a, b) => a.id - b.id);
        if (tick >= this.lastCheck + 12) {
            this.lastCheck = tick;
            this.safety.observe(context, dogs);
            const live = new Set(dogs.map(unit => unit.id));
            for (const id of this.orders.keys()) if (!live.has(id)) this.orders.delete(id);
            for (const [index, dog] of [...dogs].sort((a, b) => a.id - b.id).entries()) {
                if (isFiringBurst(dog)) continue;
                const anchor = tanks.length ? tanks[index % tanks.length] : undefined;
                const goal = this.army.getAttackArea();
                // The ablation uses identical production and assignment with
                // ordinary attack-move instead of dog escort micro.
                if (!this.escortEnabled) {
                    this.submit(context, dog, BatchableAction.toPoint(dog.id, OrderType.AttackMove,
                        anchor ? goal : matchAwareness.getMainRallyPoint()));
                    continue;
                }
                const near = anchor ? game.getVisibleUnits(player.name, "enemy")
                    .map(id => game.getUnitData(id)).filter((enemy): enemy is UnitData => !!enemy && enemy.hitPoints > 0 &&
                        pointOf(enemy).distanceTo(pointOf(anchor)) <= 12) : [];
                const bite = anchor && near.filter(enemy => (enemy.type as any) === ObjectType.Infantry &&
                    pointOf(enemy).distanceTo(pointOf(dog)) <= 1.75 && pointOf(enemy).distanceTo(pointOf(anchor)) <= 4 &&
                    getCombatWeapon(dog, enemy, true) && this.safety.isSafeMove(dog, pointOf(enemy)))
                    .sort((a, b) => pointOf(a).distanceTo(pointOf(dog)) - pointOf(b).distanceTo(pointOf(dog)) || a.id - b.id)[0];
                if (bite) {
                    this.submit(context, dog, BatchableAction.toTargetId(dog.id, OrderType.Attack, bite.id));
                    continue;
                }
                const destination = anchor ? dogEscortPoint(dog, anchor, near, goal, index,
                    point => {
                        const tile = game.mapApi.getTile(point.x, point.y);
                        return !!tile && game.mapApi.isVisibleTile(tile, player.name) &&
                            game.mapApi.isPassableTile(tile, dog.rules.speedType, !!dog.onBridge, true) &&
                            this.safety.isSafeMove(dog, point);
                    }) : matchAwareness.getMainRallyPoint();
                const safe = destination && this.safety.getSafeWaypoint(dog, destination, game);
                if (safe && pointOf(dog).distanceTo(safe) > 1) {
                    this.submit(context, dog, BatchableAction.toPoint(dog.id, OrderType.Move, safe));
                } else if (!dog.isIdle) this.submit(context, dog, BatchableAction.noTarget(dog.id, OrderType.Stop));
            }
        }
        // A dedicated small budget; leave the locked scout and all old infantry,
        // tank, miner and tech policies unchanged for this first experiment.
        const playerData = game.getPlayerData(player.name);
        const available = player.production.getAvailableObjects().find(rule => rule.name === "DOG");
        const miners = game.getVisibleUnits(player.name, "self", rule => rule.harvester).length;
        const totalDogs = game.getVisibleUnits(player.name, "self", rule => rule.name === "DOG").length;
        const desired = Math.min(6, Math.floor(tanks.length / 2));
        return available && miners >= 2 && tanks.length >= 2 && dogs.length < desired && totalDogs < 8 &&
            playerData.credits >= available.cost + 500 ? requestUnits({ DOG: 25 }) : noop();
    }

    private submit(context: MissionContext, unit: UnitData, action: BatchableAction) {
        const previous = this.orders.get(unit.id);
        const tick = context.game.getCurrentTick();
        if (!previous || !previous.action.isSameAs(action) || (unit.isIdle && tick >= previous.tick + 45)) {
            context.actionBatcher.push(action);
            this.orders.set(unit.id, { action, tick });
        }
    }
}

/** Short, legal screen positions, with a rear fallback against crush/anti-infantry. */
export function dogEscortPoint(dog: UnitData, tank: UnitData, enemies: UnitData[], goal: Vector2,
    index: number, safe: (point: Vector2) => boolean): Vector2 | null {
    const origin = pointOf(tank);
    const threat = enemies.filter(enemy => enemy.zone !== ZoneType.Air &&
        ((enemy.type as any) === ObjectType.Vehicle || (enemy.type as any) === ObjectType.Building) &&
        getCombatWeapon(enemy, tank, true))
        .sort((a, b) => pointOf(a).distanceTo(origin) - pointOf(b).distanceTo(origin) || a.id - b.id)[0];
    const forward = (threat ? pointOf(threat) : goal.clone()).sub(origin);
    if (forward.length() < 0.1) forward.set(1, 0);
    forward.multiplyScalar(1 / forward.length());
    const exposed = enemies.some(enemy => {
        const weapon = getCombatWeapon(enemy, dog, true);
        return (enemy.rules.crusher && pointOf(enemy).distanceTo(origin) < 3) ||
            (!!weapon && ((enemy.type as any) === ObjectType.Infantry || enemy.rules.harvester) &&
                pointOf(enemy).distanceTo(origin) <= weapon.range + 2);
    });
    const side = index % 2 ? 1 : -1;
    for (const [ahead, lateral] of exposed ? [[-2, side], [-3, side * 2], [-1, -side]] :
        [[1, side], [1, -side], [0, side * 2], [-1, side]]) {
        const point = new Vector2(Math.round(origin.x + forward.x * ahead - forward.y * lateral),
            Math.round(origin.y + forward.y * ahead + forward.x * lateral));
        if (safe(point)) return point;
    }
    return null;
}

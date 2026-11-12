import { GameApi, ObjectType, OrderType, PlayerData, SpeedType, UnitData, Vector2 } from "../../../../game-api";
import { BuildStatus } from "@/game/gameobject/Building";
import { MissionContext, SupabotContext } from "../../common/context";
import { findVisiblePatches, PatchPoint, ScoredPatch, scorePatch } from "../../common/orePatches";
import { isPressured, setPressureWatchPost } from "../../common/pressure";
import { DebugLogger } from "../../common/utils";
import { BatchableAction } from "../actionBatcher";
import { Mission, noop, releaseUnits, requestSpecificUnits, requestUnits } from "../mission";
import { MissionController } from "../missionController";

const dogRule = (rules: { name: string }) => rules.name === "DOG" || rules.name === "ADOG";
const distance = (a: PatchPoint, b: PatchPoint) => Math.hypot(a.rx - b.rx, a.ry - b.ry);
const pointOf = (point: Vector2): PatchPoint => ({ rx: point.x, ry: point.y });

/** Public map starts only: no enemy player assignment or private metadata. */
export function getPublicEnemyStart(game: GameApi, player: PlayerData): Vector2 | undefined {
    const home = player.startLocation as Vector2;
    return game.mapApi.getStartingLocations().filter(start => (start.x !== home.x || start.y !== home.y) &&
        Number.isFinite(start.x) && Number.isFinite(start.y) && game.mapApi.getTile(start.x, start.y))
        .sort((a, b) => a.distanceTo(home) - b.distanceTo(home) || a.x - b.x || a.y - b.y)[0];
}

export function preferredDog(context: SupabotContext): string | undefined {
    const available = context.player.production.getAvailableObjects();
    return available.some(rule => rule.name === "DOG") ? "DOG" : available.some(rule => rule.name === "ADOG") ? "ADOG" : undefined;
}

export function livingMissionDogs(context: SupabotContext, mission: Mission): UnitData[] {
    const own = new Set(context.game.getVisibleUnits(context.player.name, "self", dogRule));
    return mission.getUnitIds().filter(id => own.has(id)).map(id => context.game.getUnitData(id))
        .filter((dog): dog is UnitData => !!dog && dog.owner === context.player.name && dog.hitPoints > 0 && !dog.isWarpedOut);
}

/** An unexplored, publicly derived goal is opaque; inspect passability only on explored tiles. */
export function legalDogPoint(context: SupabotContext, desired: PatchPoint): PatchPoint | undefined {
    const { game, player } = context;
    const origin = { rx: Math.round(desired.rx), ry: Math.round(desired.ry) };
    const target = game.mapApi.getTile(origin.rx, origin.ry);
    const passable = (tile: ReturnType<GameApi["mapApi"]["getTile"]>) => game.mapApi.isVisibleTile(tile, player.name) &&
        game.mapApi.isPassableTile(tile, SpeedType.Foot, game.mapApi.hasBridgeOnTile(tile), true);
    if (target && (!game.mapApi.isVisibleTile(target, player.name) || passable(target))) return origin;
    const candidates: PatchPoint[] = [];
    for (let dx = -6; dx <= 6; dx++) for (let dy = -6; dy <= 6; dy++) {
        if (distance({ rx: origin.rx + dx, ry: origin.ry + dy }, desired) > 6) continue;
        const tile = game.mapApi.getTile(origin.rx + dx, origin.ry + dy);
        if (tile && passable(tile)) candidates.push({ rx: tile.rx, ry: tile.ry });
    }
    return candidates.sort((a, b) => distance(a, desired) - distance(b, desired) || a.rx - b.rx || a.ry - b.ry)[0];
}

export function selectWatchPost(context: SupabotContext, index: 1 | 2): PatchPoint | undefined {
    const { game, player } = context, data = game.getPlayerData(player.name);
    if (index === 2) {
        // Sort all E3 candidates, not only planRefinery's first reachable field:
        // a higher-scored unreachable field must still supply scouting vision.
        const scored = findVisiblePatches(game, player.name).map(patch => scorePatch(game, data, patch))
            .filter((entry): entry is ScoredPatch => !!entry)
            .sort((a, b) => b.score - a.score || a.g - b.g || (a.patch.id < b.patch.id ? -1 : a.patch.id > b.patch.id ? 1 : 0));
        if (scored[0]) return legalDogPoint(context, scored[0].patch.center);
    }
    const enemy = getPublicEnemyStart(game, data);
    if (!enemy) return undefined;
    const home = data.startLocation as Vector2, forward = enemy.clone().sub(home);
    forward.multiplyScalar(index === 1 ? 0.5 : 25 / forward.length());
    return legalDogPoint(context, pointOf(home.clone().add(forward)));
}

/** Shared by the three dog roles; identical busy orders never restart movement or attacks. */
export class DogOrders {
    private orders = new Map<number, { action: BatchableAction; tick: number }>();
    constructor(private cooldown = 30) {}

    private submit(context: MissionContext, dog: UnitData, action: BatchableAction) {
        const previous = this.orders.get(dog.id), tick = context.game.getCurrentTick();
        if (!previous || !previous.action.isSameAs(action) || dog.isIdle && tick >= previous.tick + this.cooldown) {
            context.actionBatcher.push(action);
            this.orders.set(dog.id, { action, tick });
        }
    }

    move(context: MissionContext, dog: UnitData, target: PatchPoint, type = OrderType.Move) {
        if (distance(dog.tile, target) > 1) this.submit(context, dog,
            BatchableAction.toPoint(dog.id, type, new Vector2(target.rx, target.ry)));
        else this.stop(context, dog);
    }

    stop(context: MissionContext, dog: UnitData) {
        if (!dog.isIdle) this.submit(context, dog, BatchableAction.noTarget(dog.id, OrderType.Stop));
    }

    attack(context: MissionContext, dog: UnitData, targetId: number) {
        this.submit(context, dog, BatchableAction.toTargetId(dog.id, OrderType.Attack, targetId));
    }
}

interface WatchDogBudget { refills: number }

/** One locked dog per post; both posts spend the same four-replacement budget. */
export class WatchPostMission extends Mission {
    private enabled = false;
    private receivedIds = new Set<number>();
    private position?: PatchPoint;
    private positionInitialized = false;
    private lastPositionCheck = -Infinity;
    private retreatUntil = -Infinity;
    private retreatPoint?: PatchPoint;
    private orders = new DogOrders();

    constructor(private index: 1 | 2, private budget: WatchDogBudget, logger: DebugLogger) {
        super(`watchPostP${index}`, logger);
    }

    getPriority() { return 40; }
    getGlobalDebugText() { return this.enabled ? "dog vision post" : "awaiting scout handoff"; }
    isUnitsLocked() { return true; }
    getPosition(): PatchPoint | undefined { return this.position && { ...this.position }; }
    activate() { this.enabled = true; }

    override addUnit(id: number) {
        if (this.getUnitIds().includes(id)) return;
        super.addUnit(id);
        if (!this.receivedIds.has(id) && this.budget.refills < 4) {
            this.receivedIds.add(id);
            this.budget.refills++;
        }
        this.retreatPoint = undefined;
    }

    acceptScout(id: number) {
        this.receivedIds.add(id);
        super.addUnit(id);
        this.retreatPoint = undefined;
    }

    private setPosition(context: SupabotContext, next: PatchPoint | undefined) {
        if (this.positionInitialized && this.position?.rx === next?.rx && this.position?.ry === next?.ry) return;
        this.positionInitialized = true;
        this.position = next;
        if (this.index === 1) setPressureWatchPost(context.game, context.player.name, next);
    }

    refreshPosition(context: SupabotContext) {
        const tick = context.game.getCurrentTick();
        // The 900-tick field-choice interval must not preserve a newly blocked tile.
        if (this.index === 2 && this.position) this.setPosition(context, legalDogPoint(context, this.position));
        if (this.index === 2 && this.positionInitialized && tick - this.lastPositionCheck < 900) return;
        this.lastPositionCheck = tick;
        const next = selectWatchPost(context, this.index);
        if (this.index === 2 && this.position && next && distance(this.position, next) <= 10) return;
        this.setPosition(context, next);
    }

    _onAiUpdate(context: MissionContext) {
        if (context.difficulty !== "brutal") return noop();
        this.refreshPosition(context);
        const dogs = livingMissionDogs(context, this);
        const excess = dogs.filter((dog, index) => index > 0 || !this.receivedIds.has(dog.id)).map(dog => dog.id);
        if (excess.length) return releaseUnits(excess);
        if (!this.enabled) return noop();
        const dog = dogs[0], tick = context.game.getCurrentTick();
        if (!dog) {
            const name = preferredDog(context);
            return this.position && name && this.budget.refills < 4 && tick < 13500 &&
                context.game.getPlayerData(context.player.name).credits >= 300 && !isPressured(context)
                ? requestUnits({ [name]: 40 }) : noop();
        }
        if (!this.position) { this.orders.stop(context, dog); return noop(); }
        const returning = !!this.retreatPoint && tick >= this.retreatUntil;
        if (returning) this.retreatPoint = undefined;
        if (!this.retreatPoint && !returning) {
            const danger = context.game.getVisibleUnits(context.player.name, "enemy", rules => rules.type === ObjectType.Vehicle ||
                rules.type === ObjectType.Building && !!(rules.primary || rules.secondary))
                .map(id => context.game.getGameObjectData(id)?.tile)
                .some(tile => tile && distance(tile, this.position!) <= 5);
            if (danger) {
                const home = context.game.getPlayerData(context.player.name).startLocation as Vector2;
                const back = home.clone().sub(new Vector2(this.position.rx, this.position.ry));
                if (back.length()) back.multiplyScalar(8 / back.length());
                this.retreatPoint = legalDogPoint(context, { rx: this.position.rx + back.x, ry: this.position.ry + back.y });
                this.retreatUntil = tick + 300;
            }
        }
        if (this.retreatPoint) this.retreatPoint = legalDogPoint(context, this.retreatPoint);
        const destination = this.retreatPoint ?? this.position;
        this.orders.move(context, dog, destination);
        return noop();
    }
}

/** One home dog: an initial receipt plus at most three replacements. */
export class HomeDogMission extends Mission {
    private receivedIds = new Set<number>();
    private orders = new DogOrders();

    constructor(private controller: MissionController, private openingReady: () => boolean, logger: DebugLogger) {
        super("homeDog", logger);
    }

    getPriority() { return 60; }
    getGlobalDebugText() { return "dog guards the refinery approach"; }
    isUnitsLocked() { return true; }

    override addUnit(id: number) {
        if (this.getUnitIds().includes(id)) return;
        super.addUnit(id);
        if (this.receivedIds.size < 4) this.receivedIds.add(id);
    }

    _onAiUpdate(context: MissionContext) {
        if (context.difficulty !== "brutal") return noop();
        const { game, player } = context, data = game.getPlayerData(player.name), home = pointOf(data.startLocation);
        const dogs = livingMissionDogs(context, this);
        const excess = dogs.filter((dog, index) => index > 0 || !this.receivedIds.has(dog.id)).map(dog => dog.id);
        if (excess.length) return releaseUnits(excess);
        const dog = dogs[0];
        if (dog) {
            const target = game.getVisibleUnits(player.name, "enemy", rules => rules.type === ObjectType.Infantry)
                .map(id => game.getGameObjectData(id)).filter(unit => unit && distance(unit.tile, home) <= 12)
                .sort((a, b) => Number(["ENGINEER", "SENGINEER"].includes(b.name)) - Number(["ENGINEER", "SENGINEER"].includes(a.name)) ||
                    distance(a.tile, dog.tile) - distance(b.tile, dog.tile) || a.id - b.id)[0];
            if (target) this.orders.attack(context, dog, target.id);
            else {
                const refinery = game.getVisibleUnits(player.name, "self", rules => rules.refinery)
                    .map(id => game.getGameObjectData(id)).filter(unit => !!unit)
                    .sort((a, b) => distance(a.tile, home) - distance(b.tile, home) || a.id - b.id)[0];
                const point = legalDogPoint(context, refinery ? { rx: (home.rx + refinery.tile.rx) / 2,
                    ry: (home.ry + refinery.tile.ry) / 2 } : home);
                if (point) this.orders.move(context, dog, point); else this.orders.stop(context, dog);
            }
            return noop();
        }
        if (!this.openingReady() || this.receivedIds.size >= 4) return noop();
        const barracksReady = game.getVisibleUnits(player.name, "self", rules => rules.name === "GAPILE" || rules.name === "NAHAND")
            .some(id => { const unit = game.getUnitData(id); return unit && Number(unit.buildStatus) === BuildStatus.Ready && !unit.isWarpedOut; });
        if (!barracksReady) return noop();
        const baseDogs = game.getVisibleUnits(player.name, "self", dogRule).map(id => game.getUnitData(id))
            .filter((unit): unit is UnitData => !!unit && !unit.isWarpedOut && distance(unit.tile, home) <= 6);
        const assigned = new Set(this.controller.getMissions().flatMap(mission => mission.getUnitIds()));
        const free = baseDogs.filter(unit => !assigned.has(unit.id)).sort((a, b) => distance(a.tile, home) - distance(b.tile, home) || a.id - b.id)[0];
        if (free) return requestSpecificUnits([free.id], 60);
        if (baseDogs.length) return noop();
        const name = preferredDog(context);
        return name ? requestUnits({ [name]: 60 }) : noop();
    }
}

/** Called before the scouting factory's one-shot guard, without touching the shared strategy. */
export class WatchPostMissions {
    private posts: WatchPostMission[];
    private home: HomeDogMission;
    private openingReady: () => boolean = () => false;
    private scoutingFinished = false;

    constructor(private controller: MissionController, logger: DebugLogger) {
        const budget: WatchDogBudget = { refills: 0 };
        this.posts = [new WatchPostMission(1, budget, logger), new WatchPostMission(2, budget, logger)];
        this.home = new HomeDogMission(controller, () => this.scoutingFinished || this.openingReady(), logger);
    }

    setOpeningReady(ready: () => boolean) { this.openingReady = ready; }

    ensure(context: SupabotContext) {
        if (context.difficulty !== "brutal") return;
        for (const post of this.posts) {
            post.refreshPosition(context);
            this.controller.addMission(post);
        }
        this.controller.addMission(this.home);
    }

    handoff(context: SupabotContext, scout: Mission) {
        const elsewhere = new Set(this.controller.getMissions().filter(mission => mission !== scout).flatMap(mission => mission.getUnitIds()));
        const survivors = livingMissionDogs(context, scout).filter(dog => !elsewhere.has(dog.id)).slice(0, 2);
        this.posts.forEach(post => post.activate());
        survivors.forEach((dog, index) => {
            const post = this.posts[index];
            scout.removeUnit(dog.id);
            post.acceptScout(dog.id);
            context.player.actions.setUnitDebugText(dog.id, `${post.getUniqueName()}_${dog.id}`);
        });
        // Transfer before returning disband: the controller's current locked scout
        // map keeps these IDs unavailable until it rebuilds ownership next tick.
        this.scoutingFinished = true;
    }
}

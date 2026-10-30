import { isObservedLivingUnit } from "../../common/observedUnit";
import { GameApi, ObjectType, UnitData, Vector2, ZoneType } from "../../../../game-api";
import { SideComposition } from "../../../strategy/compositionUtils";
import { readStrategicSituation } from "../../../strategy/nationalComposition";
import { getOpeningAirBudget } from "../../../strategy/openingAirBudget";
import { getBasicInfantryBudget, isSovietCountry } from "../../../strategy/basicInfantryBudget";
import { getKnownEnemyDirections } from "../../common/knownEnemyDirections";
import { MissionContext } from "../../common/context";
import { DebugLogger } from "../../common/utils";
import { Mission, releaseUnits, requestSpecificUnits, requestUnits } from "../mission";
import { MissionController } from "../missionController";
import { CombatSquad } from "./squads/combatSquad";

const location = (unit: UnitData) => new Vector2(unit.tile.rx, unit.tile.ry);

/** Reinforce a persistent army instead of reserving every tank in a new incomplete wave. */
export class FieldArmyMission extends Mission {
    private squad?: CombatSquad;
    private attacking = false;
    private attackArea = new Vector2();
    private nextTargetCheck = 0;
    private targetId?: number;
    private searchArea?: Vector2;
    private searchProgressAt = 0;
    private searchDistance = Infinity;
    private failedSearches = new Map<string, number>();
    private lastEnemyLocation?: Vector2;

    constructor(private plan: SideComposition | null, private controller: MissionController, logger: DebugLogger) { super("fieldArmy", logger); }

    setPlan(plan: SideComposition | null) { this.plan = plan; }
    getAttackArea() { return this.attackArea; }
    getPriority() { return 50; }
    getGlobalDebugText() { return this.attacking ? "combined assault" : "building a mobile reserve"; }

    _onAiUpdate(context: MissionContext) {
        const { game, player, matchAwareness } = context;
        const tick = game.getCurrentTick();
        const playerData = game.getPlayerData(player.name);
        const s = readStrategicSituation(game, playerData);
        const units = this.getUnits(game);
        const mobileRoles = context.difficulty === "brutal" && isSovietCountry(playerData.country?.name);
        const misplaced = mobileRoles ? units.filter(unit => unit.name === "E2").map(unit => unit.id) : [];
        if (misplaced.length) return releaseUnits(misplaced);
        const armor = units.filter(unit => ["MTNK", "HTNK", "MGTK", "APOC"].includes(unit.name));
        const air = units.filter(unit => unit.zone === ZoneType.Air);
        const infantry = units.filter(unit => (unit.type as any) === ObjectType.Infantry);
        const enemies = game.getVisibleUnits(player.name, "enemy").map(id => game.getUnitData(id))
            .filter((unit): unit is UnitData => isObservedLivingUnit(unit));
        const anchors = game.getVisibleUnits(player.name, "self", rules => rules.constructionYard || rules.refinery || rules.weaponsFactory)
            .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
        const homeThreats = enemies.filter(enemy => enemy.rules.isSelectableCombatant && !enemy.rules.harvester &&
            anchors.some(base => location(base).distanceTo(location(enemy)) <= 22));
        const rally = matchAwareness.getMainRallyPoint();
        this.squad ??= new CombatSquad(rally, rally, 15);
        this.squad.setAirSafety(getOpeningAirBudget(game, playerData) === 2);
        const mapSize = game.mapApi.getRealMapSize?.();
        const maxDim = mapSize ? Math.max(mapSize.width, mapSize.height) : 60;
        const enemyDir = getKnownEnemyDirections(game, playerData)[0];
        const targetDist = enemyDir ? playerData.startLocation.distanceTo(enemyDir) : 0;
        const isLongMap = maxDim > 100 && targetDist > 80;
        const enemyArmor = (s.enemy.vehicles ?? 0);
        const factories = (s.own.GAWEAP ?? 0) + (s.own.NAWEAP ?? 0);
        const minArmor = isLongMap ? (enemyArmor > 3 ? 6 : 4) : 4;
        const isLateGame = tick >= 10000;
        const canAssault = armor.length >= minArmor || (factories > 0 && (
            (!isLongMap && armor.length >= 3 && enemyArmor <= 2) ||
            (isLateGame && armor.length >= 2 && armor.length > enemyArmor && enemyArmor <= 1) ||
            (!isLongMap && armor.length >= 2 && enemyArmor === 0 && targetDist <= 45)
        ));
        if (canAssault ||
            air.length >= 2 || units.some(unit => unit.name === "ZEP") || infantry.length >= 20) {
            this.attacking = true;
        }
        if (units.length < 1 && !air.length) this.attacking = false;
        const center = this.getCenterOfMass() ?? rally;
        if (tick >= this.nextTargetCheck) {
            this.nextTargetCheck = tick + 30;
            if (!this.attacking) {
                const forward = rally.clone().sub(playerData.startLocation);
                if (forward.length() > 4) forward.multiplyScalar(4 / forward.length());
                this.attackArea = playerData.startLocation.clone().add(forward);
            } else if (homeThreats.length && (center.distanceTo(rally) < 40 || homeThreats.length >= 6)) {
                const enemy = [...homeThreats].sort((a, b) => location(a).distanceTo(rally) - location(b).distanceTo(rally) || a.id - b.id)[0];
                this.attackArea = location(enemy);
                this.targetId = undefined;
            } else {
                const previous = enemies.find(enemy => enemy.id === this.targetId);
                const objective = previous ?? enemies.map(enemy => {
                    const isArmedDefense = (enemy.type as any) === ObjectType.Building &&
                        (enemy.rules.primary || enemy.rules.secondary);
                    let value = isArmedDefense ? 135
                        : enemy.rules.refinery ? 110
                        : enemy.rules.constructionYard ? 100
                        : enemy.rules.weaponsFactory ? 90
                        : enemy.rules.harvester ? 80
                        : (enemy.type as any) === ObjectType.Building ? 60
                        : 20;
                    value -= center.distanceTo(location(enemy)) * 0.5;
                    return { enemy, value };
                }).sort((a, b) => b.value - a.value || a.enemy.id - b.enemy.id)[0]?.enemy;
                if (objective) {
                    this.targetId = objective.id;
                    this.attackArea = location(objective);
                    if ((objective.type as any) === ObjectType.Building || objective.rules.constructionYard || objective.rules.refinery || objective.rules.weaponsFactory) {
                        this.lastEnemyLocation = location(objective);
                    } else {
                        this.lastEnemyLocation ??= location(objective);
                    }
                } else if (this.lastEnemyLocation && center.distanceTo(this.lastEnemyLocation) > 8) {
                    this.attackArea = this.lastEnemyLocation;
                } else {
                    this.lastEnemyLocation = undefined;
                    const fallbackDir = rally;
                    const searchDirection = getKnownEnemyDirections(game, playerData)[0] ?? fallbackDir;
                    const startTile = game.mapApi.getTile(searchDirection.x, searchDirection.y);
                    this.attackArea = startTile && game.mapApi.isVisibleTile(startTile, player.name)
                        ? this.searchUnexplored(game, player.name, center, searchDirection) : searchDirection;
                }
            }
        }
        this.squad.setDefensiveRadius(this.attacking ? undefined : 7);
        this.squad.setAttackArea(this.attackArea);
        this.squad.onAiUpdate(context, this, this.logger);

        const available = new Set(player.production.getAvailableObjects().map(option => option.name));
        const requests: Record<string, number> = {};
        const want = (name: string, count: number, priority: number) => {
            if (available.has(name) && (s.own[name] ?? 0) < count) requests[name] = priority;
        };
        const allied = available.has("MTNK");
        const conscripts = getBasicInfantryBudget("E2", context.difficulty);
        if (s.harvesters && !allied && !mobileRoles) want("E2", conscripts.total, 20);
        const tank = allied ? "MTNK" : "HTNK", aa = allied ? "FV" : "HTK";
        const heavyTank = allied ? (available.has("MGTK") ? "MGTK" : "PRIS") : "APOC";
        const core = (s.own.MTNK ?? 0) + (s.own.HTNK ?? 0) + (s.own.MGTK ?? 0) + (s.own.APOC ?? 0);
        const airPlan = this.plan?.composition.JUMPJET || this.plan?.composition.ZEP;
        if (available.has(heavyTank)) want(heavyTank, 4, 60);
        want(tank, airPlan ? 4 : 50, core < 2 ? 60 : core < 6 ? 55 : 45);
        const airThreat = matchAwareness.getThreatCache()?.totalOffensiveAirThreat ?? 0;
        if (core >= 4 || airThreat > 0) want(aa, airThreat > 0 ? Math.max(2, Math.ceil(core / 3)) : Math.max(1, Math.ceil(core / 8)), 45);
        for (const name of Object.keys(this.plan?.composition ?? {})) {
            if (name === tank || name === aa || name === "E1" || name === "E2" || name === "DESO") continue;
            const openingAir = name === "JUMPJET" ? getOpeningAirBudget(game, playerData) : 0;
            const cap = name === "JUMPJET" ? s.harvesters < 2 ? openingAir : s.harvesters < 4 ? Math.max(openingAir, 4) : 8
                : name === "ZEP" ? 2 : name === "V3" || name === "SREF" ? 3 : 2;
            want(name, cap, name === "ZEP" && !(s.own.ZEP > 0) && s.harvesters >= 2 ? 100 : 40);
        }
        // Take command of free paradrops and returning units. The queue controller
        // caps ordinary infantry; this low request cannot borrow the locked reserve.
        const assigned = new Set(this.controller.getMissions().flatMap(mission => mission.getUnitIds()));
        const free = game.getVisibleUnits(player.name, "self", rules => rules.isSelectableCombatant && !rules.harvester &&
            !["DESO", "DOG", "ADOG"].includes(rules.name) &&
            (rules.name !== "E1" || (s.own.E1 ?? 0) > 5) &&
            (rules.name !== "E2" || (!mobileRoles && (s.own.E2 ?? 0) > conscripts.reserve)))
            .filter(id => !assigned.has(id));
        if (free.length) return requestSpecificUnits(free, 50);
        return requestUnits(requests);
    }

    private searchUnexplored(game: GameApi, player: string, center: Vector2, fallback: Vector2): Vector2 {
        const tick = game.getCurrentTick();
        if (this.searchArea) {
            const tile = game.mapApi.getTile(this.searchArea.x, this.searchArea.y);
            const distance = center.distanceTo(this.searchArea);
            if (distance < this.searchDistance - 1) {
                this.searchDistance = distance;
                this.searchProgressAt = tick;
            }
            const visible = tile && game.mapApi.isVisibleTile(tile, player);
            if (!visible && tick < this.searchProgressAt + 900) return this.searchArea;
            if (!visible) this.failedSearches.set(`${this.searchArea.x},${this.searchArea.y}`, tick);
        }
        const size = game.mapApi.getRealMapSize();
        const options: { point: Vector2; distance: number }[] = [];
        for (let x = 4; x < size.width; x += 8) for (let y = 4; y < size.height; y += 8) {
            if (tick < (this.failedSearches.get(`${x},${y}`) ?? -Infinity) + 3600) continue;
            const tile = game.mapApi.getTile(x, y);
            // Selecting a public coordinate to explore is legal. No hidden unit,
            // resource or terrain property is read to choose this destination.
            if (!tile || game.mapApi.isVisibleTile(tile, player)) continue;
            const point = new Vector2(x, y);
            options.push({ point, distance: center.distanceTo(point) + fallback.distanceTo(point) * 0.15 });
        }
        this.searchArea = options.sort((a, b) => a.distance - b.distance || a.point.x - b.point.x || a.point.y - b.point.y)[0]?.point;
        this.searchDistance = Infinity;
        this.searchProgressAt = tick;
        return this.searchArea ?? fallback;
    }
}

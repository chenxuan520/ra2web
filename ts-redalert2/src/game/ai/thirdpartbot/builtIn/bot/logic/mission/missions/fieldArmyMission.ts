import { sp } from "../../../strategy/params";
import { isObservedLivingUnit } from "../../common/observedUnit";
import { GameApi, ObjectType, UnitData, Vector2, ZoneType } from "../../../../game-api";
import { SideComposition } from "../../../strategy/compositionUtils";
import { countCoreTanks, readStrategicSituation } from "../../../strategy/nationalComposition";
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
    isAttacking() { return this.attacking; }
    getPriority(context: MissionContext) { return sp(context.game, context.player.name, 'assault.fieldArmyPriority'); }
    getGlobalDebugText() { return this.attacking ? "combined assault" : "building a mobile reserve"; }

    _onAiUpdate(context: MissionContext) {
        const { game, player, matchAwareness } = context;
        const tick = game.getCurrentTick();
        const playerData = game.getPlayerData(player.name);
        const s = readStrategicSituation(game, playerData);
        const units = this.getUnits(game);
        const mobileRoles = context.difficulty === "brutal" && isSovietCountry(playerData.country?.name);
        const openingInfantry = context.difficulty === "brutal" && tick < sp(game, player.name, 'production.infantryOpeningEndTick') && s.harvesters > 0 && this.plan?.minimumUnits === sp(game, player.name, 'production.infantryOpeningMinCount') &&
            !!(this.plan.composition.E1 || this.plan.composition.E2);
        const misplaced = mobileRoles && !openingInfantry ? units.filter(unit => unit.name === "E2").map(unit => unit.id) : [];
        if (misplaced.length) return releaseUnits(misplaced);
        const armor = units.filter(unit => ["MTNK", "HTNK", "MGTK", "APOC", "SREF"].includes(unit.name));
        const air = units.filter(unit => unit.zone === ZoneType.Air);
        const infantry = units.filter(unit => (unit.type as any) === ObjectType.Infantry);
        const enemies = game.getVisibleUnits(player.name, "enemy").map(id => game.getUnitData(id))
            .filter((unit): unit is UnitData => isObservedLivingUnit(unit));
        const anchors = game.getVisibleUnits(player.name, "self", rules => rules.constructionYard || rules.refinery || rules.weaponsFactory)
            .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
        const homeThreats = enemies.filter(enemy => enemy.rules.isSelectableCombatant && !enemy.rules.harvester &&
            anchors.some(base => location(base).distanceTo(location(enemy)) <= sp(game, player.name, 'pressure.armyHomeThreatRadius')));
        const approachThreats = enemies.filter(enemy => enemy.rules.isSelectableCombatant && !enemy.rules.harvester &&
            anchors.some(base => {
                const d = location(base).distanceTo(location(enemy));
                return d > sp(game, player.name, 'pressure.armyHomeThreatRadius') && d <= sp(game, player.name, 'pressure.armyApproachRadius');
            }));
        const incomingStrikeForce = approachThreats.length >= sp(game, player.name, 'pressure.incomingStrikeForceCount') || approachThreats.some(e => (e.type as any) === ObjectType.Vehicle);
        const rally = matchAwareness.getMainRallyPoint();
        this.squad ??= new CombatSquad(rally, rally, sp(game, player.name, 'assault.fieldTargetRadius'));
        this.squad.setAirSafety(getOpeningAirBudget(game, playerData) === 2);
        const mapSize = game.mapApi.getRealMapSize?.();
        const maxDim = mapSize ? Math.max(mapSize.width, mapSize.height) : 60;
        const enemyDir = getKnownEnemyDirections(game, playerData)[0];
        const targetDist = enemyDir ? playerData.startLocation.distanceTo(enemyDir) : 0;
        const isLongMap = maxDim > sp(game, player.name, 'assault.longMapDimension') && targetDist > sp(game, player.name, 'assault.longStartSeparationRadius');

        // Dynamic combat strength evaluation across both armies and defensive structures
        let ourPower = 0;
        for (const unit of units) {
            if (["HTNK", "MTNK"].includes(unit.name)) ourPower += sp(game, player.name, 'assault.coreArmorPower');
            else if (["APOC", "SREF", "MGTK"].includes(unit.name)) ourPower += sp(game, player.name, 'assault.heavyArmorPower');
            else if (["HTK", "FV"].includes(unit.name)) ourPower += sp(game, player.name, 'assault.counterArmorPower');
            else if (unit.name === "JUMPJET") ourPower += sp(game, player.name, 'assault.airUnitPower');
            else if (unit.name === "ZEP") ourPower += sp(game, player.name, 'assault.kirovPower');
            else if ((unit.type as any) === ObjectType.Infantry) ourPower += sp(game, player.name, 'assault.infantryPower');
        }
        const enemyArmor = (s.enemy.vehicles ?? 0);
        const enemyDefences = (s.enemy.defences ?? 0);
        const enemyInfantry = (s.enemy.infantry ?? 0);
        const enemyAircraft = (s.enemy.aircraft ?? 0);
        const lightDefences = tick >= sp(game, player.name, 'assault.lateGameTick') && armor.length >= sp(game, player.name, 'assault.lateAdvantageMinArmor') ? enemies.filter(enemy =>
            (enemy.type as any) === ObjectType.Building && (enemy.rules.primary || enemy.rules.secondary) &&
            ["GAPILL", "NALASR"].includes(enemy.name)).length : 0;
        const enemyPower = enemyArmor * sp(game, player.name, 'assault.coreArmorPower') + (enemyDefences - lightDefences) * sp(game, player.name, 'assault.heavyDefensePower') + lightDefences * sp(game, player.name, 'assault.lightDefensePower') + enemyInfantry * sp(game, player.name, 'assault.infantryPower') + enemyAircraft * sp(game, player.name, 'assault.airUnitPower');
        const forceRatio = enemyPower > 0 ? ourPower / enemyPower : sp(game, player.name, 'assault.noEnemyForceRatio');
        const hasHeavyDefences = enemyDefences >= sp(game, player.name, 'assault.heavyDefenceCount');
        const hasSiege = units.some(u => ["SREF", "ZEP", "V3"].includes(u.name));

        const factories = (s.own.GAWEAP ?? 0) + (s.own.NAWEAP ?? 0);
        const minArmor = isLongMap ? (enemyArmor > sp(game, player.name, 'assault.longMapEnemyArmorCount') ? sp(game, player.name, 'assault.minArmorLongMapVsArmor') : sp(game, player.name, 'assault.minArmorShortMap')) : sp(game, player.name, 'assault.minArmorShortMap');
        const isLateGame = tick >= sp(game, player.name, 'assault.lateGameTick');
        // Against heavy static defenses (2+ towers), require either siege weapons or decisive armor mass
        const defenseReady = !hasHeavyDefences || hasSiege || (armor.length >= Math.max(sp(game, player.name, 'assault.defenceArmorFloor'), enemyArmor + enemyDefences * sp(game, player.name, 'assault.defenseArmorFactor')) && forceRatio >= sp(game, player.name, 'assault.defenceForceRatio'));
        const lateArmorAdvantage = defenseReady && isLateGame && armor.length >= sp(game, player.name, 'assault.lateAdvantageMinArmor') && armor.length > enemyArmor &&
            enemyAircraft === 0 && enemyDefences === lightDefences && forceRatio >= sp(game, player.name, 'assault.lateAdvantageForceRatio') &&
            armor.every(unit => unit.hitPoints >= unit.maxHitPoints * sp(game, player.name, 'assault.lateAdvantageMinHpFraction'));
        const canAssault = defenseReady && (
            lateArmorAdvantage || (enemyArmor === 0
                ? armor.length >= minArmor && forceRatio >= sp(game, player.name, 'assault.emptyFieldForceRatio')
                : armor.length >= sp(game, player.name, 'assault.assaultMinArmor') && (armor.length >= enemyArmor + sp(game, player.name, 'assault.assaultArmorLead') || armor.length >= sp(game, player.name, 'assault.assaultArmorCap')) && forceRatio >= sp(game, player.name, 'assault.assaultForceRatio')
            ) ||
            (factories > 0 && (
                (!isLongMap && armor.length >= sp(game, player.name, 'assault.minArmorShortMap') && enemyArmor <= sp(game, player.name, 'assault.opportunisticEnemyArmorCap') && enemyDefences === 0 && targetDist <= sp(game, player.name, 'assault.earlyAssaultRadius')) ||
                (isLateGame && armor.length >= sp(game, player.name, 'assault.opportunisticArmorCount') && armor.length > enemyArmor && enemyArmor <= sp(game, player.name, 'assault.opportunisticEnemyArmorCap')) ||
                (!isLongMap && armor.length >= sp(game, player.name, 'assault.opportunisticArmorCount') && enemyArmor === 0 && targetDist <= sp(game, player.name, 'assault.earlyAssaultRadius'))
            ))
        );
        const infantryPush = openingInfantry && infantry.length >= this.plan!.minimumUnits && enemyArmor <= sp(game, player.name, 'assault.infantryPushEnemyArmorCap') && enemyAircraft === 0 && enemyDefences < sp(game, player.name, 'assault.infantryPushEnemyDefenseCount');
        if (canAssault || infantryPush ||
            air.length >= sp(game, player.name, 'assault.airAssaultCount') || units.some(unit => unit.name === "ZEP") || infantry.length >= sp(game, player.name, 'assault.infantryAssaultCount')) {
            this.attacking = true;
        }
        const outnumbered = enemyArmor > 0 && armor.length < Math.min(enemyArmor, sp(game, player.name, 'assault.retreatArmorCap'));
        const powerDeficit = enemyPower > sp(game, player.name, 'assault.retreatPowerFloor') && forceRatio < sp(game, player.name, 'assault.retreatForceRatio');
        const decimated = armor.length < (isLateGame ? sp(game, player.name, 'assault.decimatedLate') : (hasHeavyDefences ? sp(game, player.name, 'assault.decimatedVsHeavyDefence') : sp(game, player.name, 'assault.decimatedEarly')));
        if (!infantryPush && (decimated || outnumbered || powerDeficit || (units.length < sp(game, player.name, 'assault.exhaustedArmyCount') && !air.length))) {
            if (!air.length && !units.some(unit => unit.name === "ZEP")) {
                this.attacking = false;
            }
        }
        const center = this.getCenterOfMass() ?? rally;
        const nearestHomeThreat = homeThreats.length
            ? [...homeThreats].sort((a, b) => location(a).distanceTo(center) - location(b).distanceTo(center) || a.id - b.id)[0]
            : undefined;

        const isArmorFormed = armor.length >= sp(game, player.name, 'assault.formedArmor');
        const isDirectBaseAssault = !!nearestHomeThreat && (
            (nearestHomeThreat.type as any) === ObjectType.Vehicle ||
            nearestHomeThreat.rules.crushable === false ||
            anchors.some(base => location(base).distanceTo(location(nearestHomeThreat!)) <= sp(game, player.name, 'defense.directBaseAssaultRadius'))
        );
        const shouldDefendHomeThreat = !!nearestHomeThreat && (isArmorFormed || isDirectBaseAssault);

        if (tick >= this.nextTargetCheck) {
            this.nextTargetCheck = tick + 30;
            if (!this.attacking) {
                if (shouldDefendHomeThreat && nearestHomeThreat) {
                    this.attackArea = location(nearestHomeThreat);
                    this.targetId = undefined;
                } else if (isArmorFormed && incomingStrikeForce && center.distanceTo(rally) < sp(game, player.name, 'defense.interceptRallyRadius')) {
                    const intercept = [...approachThreats].sort((a, b) => location(a).distanceTo(center) - location(b).distanceTo(center) || a.id - b.id)[0];
                    this.attackArea = location(intercept);
                    this.targetId = undefined;
                } else {
                    const forward = rally.clone().sub(playerData.startLocation);
                    if (forward.length() > 4) forward.multiplyScalar(4 / forward.length());
                    this.attackArea = playerData.startLocation.clone().add(forward);
                    this.targetId = undefined;
                }
            } else if ((homeThreats.length && (center.distanceTo(rally) < sp(game, player.name, 'defense.attackingHomeResponseRadius') || homeThreats.length >= sp(game, player.name, 'defense.attackingHomeResponseCount') || isDirectBaseAssault ||
                homeThreats.some(enemy => enemy.rules.primary && ((enemy.type as any) === ObjectType.Vehicle ||
                    anchors.some(base => location(base).distanceTo(location(enemy)) <= sp(game, player.name, 'defense.armedBaseIntruderRadius')))))) && nearestHomeThreat) {
                // Respond immediately to defend base against intruders
                this.attackArea = location(nearestHomeThreat);
                this.targetId = undefined;
            } else if (incomingStrikeForce && center.distanceTo(rally) < sp(game, player.name, 'defense.interceptRallyRadius')) {
                const intercept = [...approachThreats].sort((a, b) => location(a).distanceTo(center) - location(b).distanceTo(center) || a.id - b.id)[0];
                this.attackArea = location(intercept);
                this.targetId = intercept.id;
            } else {
                const previous = enemies.find(enemy => enemy.id === this.targetId);
                const prevDist = previous ? center.distanceTo(location(previous)) : Infinity;
                const prevIsArmedDefense = previous && (previous.type as any) === ObjectType.Building &&
                    (previous.rules.primary || previous.rules.secondary);
                const nearbyArmedDefense = enemies.find(enemy =>
                    (enemy.type as any) === ObjectType.Building &&
                    (enemy.rules.primary || enemy.rules.secondary) &&
                    center.distanceTo(location(enemy)) <= sp(game, player.name, 'assault.nearbyDefenseRadius')
                );
                const shouldRetarget = !previous ||
                    (!prevIsArmedDefense && !!nearbyArmedDefense) ||
                    (prevDist > sp(game, player.name, 'assault.retargetFarRadius') && enemies.some(e => center.distanceTo(location(e)) <= sp(game, player.name, 'assault.retargetNearRadius'))) ||
                    ((previous.rules.type === ObjectType.Vehicle || (previous.type as any) === ObjectType.Vehicle) && !previous.rules.harvester && prevDist > sp(game, player.name, 'assault.chasingVehicleRadius') &&
                        enemies.some(e => (e.type as any) === ObjectType.Building && center.distanceTo(location(e)) <= sp(game, player.name, 'assault.nearbyDefenseRadius')));

                const hasEnemyCombatants = enemies.some(e => (e.type as any) === ObjectType.Vehicle && e.rules.isSelectableCombatant && !e.rules.harvester);
                const objective = (!shouldRetarget && previous) ? previous : enemies.map(enemy => {
                    const isArmedDefense = (enemy.type as any) === ObjectType.Building &&
                        (enemy.rules.primary || enemy.rules.secondary);
                    const isCombatVehicle = (enemy.type as any) === ObjectType.Vehicle && enemy.rules.isSelectableCombatant && !enemy.rules.harvester;
                    let value = isArmedDefense ? sp(game, player.name, 'assault.defenseTargetWeight')
                        : enemy.rules.weaponsFactory ? sp(game, player.name, 'assault.factoryTargetWeight')
                        : isCombatVehicle ? sp(game, player.name, 'assault.vehicleTargetWeight')
                        : enemy.rules.constructionYard ? sp(game, player.name, 'assault.conyardTargetWeight')
                        : enemy.rules.refinery ? sp(game, player.name, 'assault.refineryTargetWeight')
                        : (!hasEnemyCombatants && (enemy.type as any) === ObjectType.Building) ? sp(game, player.name, 'assault.emptyFieldBuildingWeight')
                        : enemy.rules.harvester ? sp(game, player.name, 'assault.harvesterTargetWeight')
                        : (enemy.type as any) === ObjectType.Building ? sp(game, player.name, 'assault.buildingTargetWeight')
                        : sp(game, player.name, 'assault.otherTargetWeight');
                    value -= center.distanceTo(location(enemy)) * sp(game, player.name, 'assault.targetDistancePenaltyFactor');
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
                } else if (this.lastEnemyLocation && center.distanceTo(this.lastEnemyLocation) > sp(game, player.name, 'assault.lastEnemyArrivalRadius')) {
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
        const isIntercepting = !this.attacking && isArmorFormed && incomingStrikeForce && center.distanceTo(rally) < sp(game, player.name, 'defense.interceptRallyRadius');
        this.squad.setDefensiveRadius(this.attacking ? undefined : (shouldDefendHomeThreat || isIntercepting ? sp(game, player.name, 'defense.activeArmyRadius') : sp(game, player.name, 'defense.reserveArmyRadius')));
        this.squad.setAttackArea(this.attackArea);
        this.squad.onAiUpdate(context, this, this.logger);

        const available = new Set(player.production.getAvailableObjects().map(option => option.name));
        const requests: Record<string, number> = {};
        const want = (name: string, count: number, priority: number) => {
            if (available.has(name) && (s.own[name] ?? 0) < count) requests[name] = priority;
        };
        const allied = available.has("MTNK");
        const conscripts = getBasicInfantryBudget("E2", context.difficulty);
        if (openingInfantry) want(this.plan!.composition.E2 ? "E2" : "E1", this.plan!.maximumUnits, sp(game, player.name, 'production.infantryOpeningPriority'));
        if (s.harvesters && !allied && !mobileRoles) want("E2", conscripts.total, 20);
        const tank = allied ? "MTNK" : "HTNK", aa = allied ? "FV" : "HTK";
        const heavyTank = allied ? (available.has("SREF") ? "SREF" : (available.has("MGTK") ? "MGTK" : "MTNK")) : null;
        const core = countCoreTanks(s);
        const airPlan = this.plan?.composition.JUMPJET || this.plan?.composition.ZEP;
        if (heavyTank && available.has(heavyTank) && heavyTank !== tank) want(heavyTank, sp(game, player.name, 'production.heavyTankCap'), sp(game, player.name, 'production.heavyTankPriority'));
        want(tank, airPlan ? sp(game, player.name, 'production.airPlanTankCap') : sp(game, player.name, 'production.fieldTankCap'), core < sp(game, player.name, 'production.initialCoreTankCount') ? sp(game, player.name, 'production.fieldInitialTankPriority') : core < sp(game, player.name, 'production.mediumCoreTankCount') ? sp(game, player.name, 'production.fieldMediumTankPriority') : sp(game, player.name, 'production.fieldLargeTankPriority'));
        const airThreat = matchAwareness.getThreatCache()?.totalOffensiveAirThreat ?? 0;
        const enemyInf = s.enemy.infantry ?? 0;
        const aaTarget = airThreat > 0 ? Math.max(2, Math.ceil(core / sp(game, player.name, 'production.corePerAirCounterFactor'))) : enemyInf >= sp(game, player.name, 'production.fieldInfantryResponseCount') ? Math.min(sp(game, player.name, 'production.fieldInfantryCounterCap'), Math.max(1, Math.ceil(enemyInf / sp(game, player.name, 'production.infantryPerArmorFactor')))) : Math.max(1, Math.ceil(core / sp(game, player.name, 'production.corePerIdleCounterFactor')));
        if (core >= sp(game, player.name, 'production.fieldCounterCoreCount') || airThreat > 0 || enemyInf >= sp(game, player.name, 'production.fieldInfantryResponseCount')) want(aa, aaTarget, enemyInf >= sp(game, player.name, 'production.fieldUrgentInfantryCount') ? sp(game, player.name, 'production.fieldUrgentCounterPriority') : sp(game, player.name, 'production.fieldCounterPriority'));
        for (const name of Object.keys(this.plan?.composition ?? {})) {
            if (name === tank || name === aa || name === "E1" || name === "E2" || name === "DESO") continue;
            const openingAir = name === "JUMPJET" ? getOpeningAirBudget(game, playerData) : 0;
            const cap = name === "JUMPJET" ? s.harvesters < 2 ? openingAir : s.harvesters < sp(game, player.name, 'production.largeAirMinHarvesters') ? Math.max(openingAir, sp(game, player.name, 'production.mediumAirCap')) : sp(game, player.name, 'production.largeAirCap')
                : name === "ZEP" ? sp(game, player.name, 'production.kirovCap') : name === "V3" || name === "SREF" ? sp(game, player.name, 'production.artilleryCap') : sp(game, player.name, 'production.otherSupportCap');
            want(name, cap, name === "ZEP" && !(s.own.ZEP > 0) && s.harvesters >= 2 ? sp(game, player.name, 'production.firstKirovPriority') : sp(game, player.name, 'production.supportUnitPriority'));
        }
        // Take command of free paradrops and returning units. The queue controller
        // caps ordinary infantry; this low request cannot borrow the locked reserve.
        const assigned = new Set(this.controller.getMissions().flatMap(mission => mission.getUnitIds()));
        const free = game.getVisibleUnits(player.name, "self", rules => rules.isSelectableCombatant && !rules.harvester &&
            !["DESO", "DOG", "ADOG"].includes(rules.name) &&
            (rules.name !== "E1" || (s.own.E1 ?? 0) > sp(game, player.name, 'defense.freeGiReserveCount')) &&
            (rules.name !== "E2" || (!mobileRoles && (s.own.E2 ?? 0) > conscripts.reserve)))
            .filter(id => !assigned.has(id));
        if (free.length) return requestSpecificUnits(free, sp(game, player.name, 'assault.freeUnitPriority'));
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
            if (!visible && tick < this.searchProgressAt + sp(game, player, 'assault.searchProgressTimeoutTicks')) return this.searchArea;
            if (!visible) this.failedSearches.set(`${this.searchArea.x},${this.searchArea.y}`, tick);
        }
        const size = game.mapApi.getRealMapSize();
        const options: { point: Vector2; distance: number }[] = [];
        for (let x = 4; x < size.width; x += 8) for (let y = 4; y < size.height; y += 8) {
            if (tick < (this.failedSearches.get(`${x},${y}`) ?? -Infinity) + sp(game, player, 'assault.failedSearchCooldownTicks')) continue;
            const tile = game.mapApi.getTile(x, y);
            // Selecting a public coordinate to explore is legal. No hidden unit,
            // resource or terrain property is read to choose this destination.
            if (!tile || game.mapApi.isVisibleTile(tile, player)) continue;
            const point = new Vector2(x, y);
            options.push({ point, distance: center.distanceTo(point) + fallback.distanceTo(point) * sp(game, player, 'assault.searchFallbackDistanceFactor') });
        }
        this.searchArea = options.sort((a, b) => a.distance - b.distance || a.point.x - b.point.x || a.point.y - b.point.y)[0]?.point;
        this.searchDistance = Infinity;
        this.searchProgressAt = tick;
        if (this.searchArea) return this.searchArea;

        // When all map shroud has been scouted or candidates are exhausted, patrol between candidate enemy starting sectors if enemies exist
        const hasHostiles = game.getPlayers().some(name => name !== player &&
            !game.areAlliedPlayers(player, name) && game.getPlayerData(name).isCombatant);
        if (hasHostiles) {
            const myStart = game.getPlayerData(player).startLocation;
            const otherStarts = game.mapApi.getStartingLocations()
                .filter(point => !point.equals(myStart))
                .sort((a, b) => a.x - b.x || a.y - b.y);
            if (otherStarts.length > 0) {
                const patrolIndex = Math.floor(tick / sp(game, player, 'assault.startPatrolPeriodTicks')) % otherStarts.length;
                return otherStarts[patrolIndex];
            }
        }
        return fallback;
    }
}

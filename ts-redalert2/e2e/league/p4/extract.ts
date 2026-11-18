import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_COMPOSITIONS } from '../../../src/game/ai/thirdpartbot/builtIn/bot/strategy/defaultStrategy';
import { GROUPS, parseParams, type BaseParams } from './paramSpace';
import { DECISION_FILES, countStrategyLiterals } from './literalCounts';

/** One-shot, reviewed P3 extraction. Values come from matched source expressions, never tuning. */
const root = resolve(import.meta.dir, '../../..');
const bot = resolve(root, 'src/game/ai/thirdpartbot/builtIn/bot');
const extra = ['logic/mission/missions/dogEscortMission.ts', 'logic/mission/missions/squads/combatSquad.ts'];
const original = new Map<string, string>(), changed = new Map<string, string>();
const params: BaseParams = parseParams(await readFile(resolve(bot, 'strategy/brutalParams.ts'), 'utf8'));
const proof: { file: string; expression: string; path: string; value: number }[] = [];
for (const file of [...DECISION_FILES, ...extra]) {
    const text = await readFile(resolve(bot, file), 'utf8'); original.set(file, text); changed.set(file, text);
}
if (changed.get('logic/building/economyPlan.ts')!.includes('sp(')) throw new Error('P3 extraction has already been applied');
function replace(file: string, before: string, after: string, all = false) {
    const source = changed.get(file)!;
    const escaped = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped + (/\d$/.test(before) ? '(?![\\w.])' : ''), 'g');
    const occurrences = [...source.matchAll(pattern)].length;
    if (!occurrences || (!all && occurrences !== 1)) throw new Error(`${file}: expected unique source: ${before} (${occurrences})`);
    changed.set(file, source.replace(pattern, () => after));
}
function value(file: string, expression: string): number {
    if (/^-?\d+(?:\.\d+)?$/.test(expression)) return Number(expression);
    if (/^\d+(?:\.\d+)?(?:\s*\*\s*\d+(?:\.\d+)?)+$/.test(expression)) return expression.split('*').map(Number).reduce((a, b) => a * b, 1);
    const name = expression.split('.').at(-1)!;
    const declaration = new RegExp(`(?:const |readonly )${name}\\s*=\\s*([^;]+);`).exec(original.get(file)!);
    if (!declaration || !/^\d+(?:\.\d+)?(?:\s*\*\s*\d+(?:\.\d+)?)*$/.test(declaration[1].trim())) throw new Error(`Cannot evaluate original ${expression}`);
    return declaration[1].split('*').map(Number).reduce((a, b) => a * b, 1);
}
function read(file: string, expression: string, path: string, game: string, player: string, cold?: string): string {
    const v = value(file, expression);
    if (Object.hasOwn(params, path) && params[path] !== v) throw new Error(`Different original meanings/values for ${path}`);
    params[path] = v; proof.push({ file, expression, path, value: v });
    const call = `sp(${game}, ${player}, '${path}')`;
    return cold ? `(${cold} ? ${call} : ${expression})` : call;
}
function rule(file: string, before: string, expression: string, path: string, game = 'game', player = 'player.name', cold?: string, all = false) {
    if (!before.includes(expression)) throw new Error('Expression must occur in reviewed source');
    const escaped = expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const token = /^-?\d+(?:\.\d+)?$/.test(expression) ? new RegExp(`(?<![\\w.])${escaped}(?![\\w.])`) : new RegExp(escaped);
    const after = before.replace(token, read(file, expression, path, game, player, cold));
    if (after === before) throw new Error(`Missing numeric token in ${before}`);
    replace(file, before, after, all);
}
function direct(file: string, game: string, player: string, split?: string) {
    const source = changed.get(file)!;
    const convert = (text: string, owner: string) => text.replace(/BRUTAL_PARAMS\.(\w+)\.(\w+)/g, (_match, group, name) => `sp(${game}, ${owner}, '${group}.${name}')`);
    if (split) {
        const index = source.indexOf(split); if (index < 0) throw new Error('Missing reviewed scope');
        changed.set(file, convert(source.slice(0, index), player) + convert(source.slice(index), 'unit.owner'));
    } else changed.set(file, convert(source, player));
}
const q = 'logic/building/queueController.ts';
direct(q, 'game', 'player.name');
rule(q, 'game.getCurrentTick() < 7000', '7000', 'production.infantryOpeningEndTick', 'game', 'player.name', undefined, true);
rule(q, '(requests.get(name)?.priority ?? 0) >= 95', '95', 'production.infantryOpeningPriority', 'game', 'player.name', undefined, true);
rule(q, 'name === "E2" ? 16 : 12', '16', 'production.sovietOpeningInfantryCap');
rule(q, 'name === "E2" ? sp(game, player.name, \'production.sovietOpeningInfantryCap\') : 12', '12', 'production.alliedOpeningInfantryCap');
rule(q, '<= 25 ** 2', '25', 'pressure.preFactoryGuardRadius');
rule(q, '<= 22 ** 2', '22', 'pressure.minerSiegeRadius');
rule(q, 'isSovietCountry(playerData.country?.name) ? 2 : 1', '2', 'production.secondMinerSovietCoreCount');
rule(q, 'isSovietCountry(playerData.country?.name) ? sp(game, player.name, \'production.secondMinerSovietCoreCount\') : 1', '1', 'production.secondMinerAlliedCoreCount');
for (const [before, literal, path] of [
    ['minerPriority = 120', '120', 'economy.recoveryMinerPriority'], ['miners < 2', '2', 'economy.secondMinerCount'],
    ['minerPriority = 90', '90', 'economy.secondMinerPriority'], ['miners === 2', '2', 'economy.thirdMinerPreviousCount'],
    ['core >= 6 ||', '6', 'economy.thirdMinerCoreCount'], ['refineries >= 2 && core >= 4', '4', 'economy.thirdMinerDualRefineryCoreCount'],
    ['minerPriority = 78', '78', 'economy.thirdMinerPriority'], ['miners === 3', '3', 'economy.fourthMinerPreviousCount'],
    ['core >= 8 ||', '8', 'economy.fourthMinerCoreCount'], ['refineries >= 2 && core >= 6', '6', 'economy.fourthMinerDualRefineryCoreCount'],
    ['minerPriority = 70', '70', 'economy.fourthMinerPriority'], ['Math.min(6, Math.max(2, Math.ceil(situation.enemy.aircraft / 2)))', '6', 'production.airResponseCap'],
    ['Math.max(2, Math.ceil(situation.enemy.aircraft / 2))', '2', 'production.airResponseMinCount'],
    ['situation.enemy.aircraft / 2', '2', 'production.aircraftPerCounterFactor'], ['tick + 600', '600', 'production.airResponseMemoryTicks'],
    ['(requests.get(aa.name)?.priority ?? 0) < 100', '100', 'production.airResponsePriority'],
    ['priority: 100, specificLocation: null', '100', 'production.emergencyArmorPriority'],
    ['situation.enemy.infantry >= 8', '8', 'production.infantryResponseCount'],
    ['Math.min(6, Math.max(2, Math.ceil(situation.enemy.infantry / 6)))', '6', 'production.infantryResponseArmorCap'],
    ['Math.max(2, Math.ceil(situation.enemy.infantry / 6))', '2', 'production.infantryResponseArmorMinCount'],
    ['situation.enemy.infantry / 6', '6', 'production.infantryPerArmorFactor'],
    ['core < 4 &&', '4', 'production.initialCoreTankCount'], ['priority: 85', '85', 'production.initialCorePriority'],
    ['core < 8 &&', '8', 'production.mediumCoreTankCount'], ['?.priority ?? 0) < 75', '75', 'production.mediumCorePriority'],
    ['priority: 75', '75', 'production.mediumCorePriority'], ['core < 16 &&', '16', 'production.largeCoreTankCount'],
    ['?.priority ?? 0) < 60', '60', 'production.largeCorePriority'], ['priority: 60', '60', 'production.largeCorePriority'],
    ['?.priority ?? 0) < 50', '50', 'production.overflowCorePriority'], ['priority: 50', '50', 'production.overflowCorePriority'],
    ['playerData.credits < 800', '800', 'economy.emergencySaleCredits'], ['this.lastEmergencySaleAt + 450', '450', 'economy.emergencySaleCooldownTicks'],
] as const) rule(q, before, literal, path, 'game', 'player.name', undefined, true);
for (const [before, expression, path] of [
    ['highestPriority >= 85', '85', 'production.emergencyQueuePriorityThreshold'],
    ['? 60 : Math.min', '60', 'production.emergencyQueueMinimumPriority'],
    ['totalWeightAcrossQueues * 0.25', '0.25', 'production.queueWeightRatio'],
    ['decision.priority >= 18', '18', 'production.affordableBuildingMinimumPriority'],
    ['decision.unit.cost + 400', '400', 'production.buildingCostMargin'],
    ['failures >= PLACEMENT_FAILURE_CANCEL_THRESHOLD', 'PLACEMENT_FAILURE_CANCEL_THRESHOLD', 'production.maxPlacementFailuresCap'],
    ['failures >= PLACEMENT_FAILURE_RETRY_THRESHOLD', 'PLACEMENT_FAILURE_RETRY_THRESHOLD', 'production.placementRetryCount'],
    ['newItemPriority >= 80', '80', 'production.obsoleteUnitReplacementPriority'],
    ['currentItemPriority * 2', '2', 'production.unitReplacementPriorityFactor'],
    ['isBuildingQueue(queueType) ? 200', '200', 'production.buildingLiquidityCredits'],
    ['myCredits >= 200', '200', 'production.buildingLiquidityCredits'],
    ['decision.priority >= 15', '15', 'production.minimumResumePriority'],
] as const) rule(q, before, expression, path, 'game', 'playerData.name', 'difficulty === "brutal"');
const e = 'logic/building/economyPlan.ts'; direct(e, 'game', 'player.name');
rule(e, 's.harvesters >= 2 &&', '2', 'economy.secondRefineryMinHarvesters');
rule(e, '? 45 : 0', '45', 'economy.openingAlliedRadarPriority');
rule(e, 's.harvesters < 2 ||', '2', 'economy.radarIncomeFloor');
rule(e, 's.harvesters >= 4 +', '4', 'production.extraFactoryHarvesterFloor');
rule(e, '(factories - 1) * 2', '2', 'production.extraFactoryHarvesterFactor');
const h = 'logic/building/harvester.ts';
rule(h, 'Math.min(MAX_HARVESTERS_TOTAL,', 'MAX_HARVESTERS_TOTAL', 'economy.maxHarvestersCap', 'game', 'playerData.name', 'difficulty === "brutal"');
rule(h, 'refineries * IDEAL_HARVESTERS_PER_REFINERY', 'IDEAL_HARVESTERS_PER_REFINERY', 'economy.harvestersPerRefinery', 'game', 'playerData.name', 'difficulty === "brutal"');
rule(h, 'this.basePriority * 6', '6', 'economy.emptyHarvesterPriorityFactor', 'game', 'playerData.name', 'difficulty === "brutal"');
rule(h, 'this.basePriority * 4', '4', 'economy.lowHarvesterPriorityFactor', 'game', 'playerData.name', 'difficulty === "brutal"');
const r = 'logic/building/resourceCollectionBuilding.ts';
rule(r, '<= 8)', '8', 'economy.refineryServiceRadius', 'game', 'playerData.name', 'difficulty === "brutal"');
const s = 'logic/building/strategicBuildings.ts';
for (const [before, literal, path] of [
    ['radius = 30', '30', 'defense.threatenedAnchorRadius'], ['(own.E1 ?? 0) >= 4', '4', 'defense.frenchOpeningInfantryCount'],
    ['enemy.infantry >= 6', '6', 'defense.frenchOpeningEnemyInfantryCount'], ['|| enemy.vehicles >= 3)', '3', 'defense.frenchOpeningEnemyVehicleCount'],
    ['country === "Germans" ? enemy.vehicles >= 3', '3', 'production.germanSpecialistEnemyVehicleCount'],
    ['return enemy.vehicles >= 3 ||', '3', 'production.labEnemyVehicleCount'],
    ['findThreatenedAnchor(game, player, 45)', '45', 'defense.frenchOpeningWarningRadius'],
    ['return 18', '18', 'production.committedInvestmentPriority'],
    ['option.cost + 600 &&', '600', 'production.frenchRadarCostMargin'],
    ['option.cost + 600))', '600', 'production.specialistCostMargin'],
    ['credits < option.cost + 600', '600', 'defense.extraCannonCostMargin'],
    ['return 32', '32', 'production.frenchRadarPriority'], ['core >= 3', '3', 'production.radarCoreCount'],
    ['credits >= 300', '300', 'production.radarCreditsFloor'], ['option.cost + 500', '500', 'production.lowCoreRadarCostMargin'],
    ['enemy.infantry >= 3', '3', 'production.specialistEnemyInfantryCount'], ['|| enemy.vehicles >= 4', '4', 'production.desolatorEnemyVehicleCount'],
    ['enemy.infantry + enemy.vehicles >= 4', '4', 'production.frenchSpecialistEnemyCount'], ['core >= 8 && credits', '8', 'production.russianSpecialistCoreCount'],
    ['harvesters >= 4 && core >= 8', '8', 'defense.secondCannonCoreCount'],
    ['option.cost + 1000', '1000', 'production.russianSpecialistCostMargin'], ['core >= 4 && credits', '4', 'production.specialistCoreCount'],
    ['harvesters === 2 && core >= 4', '4', 'economy.safeExpansionCoreCount'],
    ['6 * 60 * 15', '6 * 60 * 15', 'economy.safeRefineryExpansionTick'], ['* 1.25', '1.25', 'economy.safeExpansionThreatRatio'],
    ['option.cost + 700', '700', 'production.labCostMargin'], ['option.cost + 1200', '1200', 'production.labSurplusCostMargin'],
    ['return 16', '16', 'production.superweaponPriority'], ['option.cost + 1500', '1500', 'production.superweaponCostMargin'],
    ['countCoreTanks(situation) >= 6', '6', 'production.superweaponCoreCount'], ['harvesters >= 4', '4', 'defense.secondCannonMinHarvesters'],
    ['enemy.infantry + enemy.vehicles >= 8', '8', 'defense.secondCannonEnemyCount'], ['? 24 : 16', '24', 'defense.firstCannonPriority'],
    ['? sp(game, player.name, \'defense.firstCannonPriority\') : 16', '16', 'defense.extraCannonPriority'],
    ['credits >= 600', '600', 'defense.openingCannonCredits'], ['return 30', '30', 'defense.openingCannonPriority'],
    ['core < 4', '4', 'defense.extraCannonCoreCount'], ['enemy.infantry + enemy.vehicles < 4', '4', 'defense.extraCannonEnemyCount'],
    ['? 18 : 0', '18', 'production.labPriority'], ['targetDistance - range) * 3', '3', 'defense.cannonRangePenaltyFactor'],
] as const) rule(s, before, literal, path, 'game', 'player.name', undefined, true);
const a = 'logic/mission/missions/fieldArmyMission.ts'; direct(a, 'game', 'player.name');
replace(a, 'getPriority() { return 50; }', "getPriority(context: MissionContext) { return sp(context.game, context.player.name, 'assault.fieldArmyPriority'); }");
params['assault.fieldArmyPriority'] = 50;
for (const [before, literal, path] of [
    ['tick < 7000', '7000', 'production.infantryOpeningEndTick'], ['this.plan?.minimumUnits === 8', '8', 'production.infantryOpeningMinCount'],
    ['<= 22', '22', 'pressure.armyHomeThreatRadius'], ['d > 22', '22', 'pressure.armyHomeThreatRadius'], ['d <= 48', '48', 'pressure.armyApproachRadius'],
    ['approachThreats.length >= 2', '2', 'pressure.incomingStrikeForceCount'], ['rally, rally, 15', '15', 'assault.fieldTargetRadius'],
    ['maxDim > 100', '100', 'assault.longMapDimension'], ['targetDist > 80', '80', 'assault.longStartSeparationRadius'],
    ['ourPower += 100', '100', 'assault.coreArmorPower'], ['ourPower += 150', '150', 'assault.heavyArmorPower'],
    ['ourPower += 50', '50', 'assault.counterArmorPower'], ['ourPower += 70', '70', 'assault.airUnitPower'],
    ['ourPower += 220', '220', 'assault.kirovPower'], ['ourPower += 15', '15', 'assault.infantryPower'],
    ['enemyArmor * 100', '100', 'assault.coreArmorPower'], ['lightDefences) * 140', '140', 'assault.heavyDefensePower'],
    ['lightDefences * 40', '40', 'assault.lightDefensePower'], ['enemyInfantry * 15', '15', 'assault.infantryPower'],
    ['enemyAircraft * 70', '70', 'assault.airUnitPower'], [': 2.0', '2.0', 'assault.noEnemyForceRatio'],
    ['enemyArmor > 3', '3', 'assault.longMapEnemyArmorCount'], ['enemyDefences * 2', '2', 'assault.defenseArmorFactor'],
    ['targetDist <= 45', '45', 'assault.earlyAssaultRadius'], ['armor.length >= 2', '2', 'assault.opportunisticArmorCount'],
    ['air.length >= 2', '2', 'assault.airAssaultCount'], ['infantry.length >= 20', '20', 'assault.infantryAssaultCount'],
    ['enemyArmor <= 1', '1', 'assault.opportunisticEnemyArmorCap'],
    ['enemyArmor <= 2', '2', 'assault.infantryPushEnemyArmorCap'], ['enemyDefences < 2', '2', 'assault.infantryPushEnemyDefenseCount'],
    ['units.length < 2', '2', 'assault.exhaustedArmyCount'],
    ['<= 10)', '10', 'defense.directBaseAssaultRadius'], ['center.distanceTo(rally) < 45', '45', 'defense.interceptRallyRadius'],
    ['center.distanceTo(rally) < 40', '40', 'defense.attackingHomeResponseRadius'], ['homeThreats.length >= 3', '3', 'defense.attackingHomeResponseCount'],
    ['<= 14)', '14', 'defense.armedBaseIntruderRadius'], ['<= 18', '18', 'assault.nearbyDefenseRadius'],
    ['prevDist > 25', '25', 'assault.retargetFarRadius'], ['<= 15)', '15', 'assault.retargetNearRadius'],
    ['prevDist > 20', '20', 'assault.chasingVehicleRadius'], ['? 135', '135', 'assault.defenseTargetWeight'],
    ['? 130', '130', 'assault.factoryTargetWeight'], ['? 120', '120', 'assault.vehicleTargetWeight'],
    ['? 115', '115', 'assault.conyardTargetWeight'], ['? 110', '110', 'assault.refineryTargetWeight'],
    ['? 150', '150', 'assault.emptyFieldBuildingWeight'], ['enemy.rules.harvester ? 25', '25', 'assault.harvesterTargetWeight'],
    ['? 60', '60', 'assault.buildingTargetWeight'], [': 20;', '20', 'assault.otherTargetWeight'],
    ['* 0.5', '0.5', 'assault.targetDistancePenaltyFactor'], ['this.lastEnemyLocation) > 8', '8', 'assault.lastEnemyArrivalRadius'],
    ['? 25 : 7', '25', 'defense.activeArmyRadius'], ['? sp(game, player.name, \'defense.activeArmyRadius\') : 7', '7', 'defense.reserveArmyRadius'],
    ['maximumUnits, 95', '95', 'production.infantryOpeningPriority'], ['want(heavyTank, 4, 60)', '4', 'production.heavyTankCap'],
    ['sp(game, player.name, \'production.heavyTankCap\'), 60', '60', 'production.heavyTankPriority'],
    ['airPlan ? 4 : 50', '4', 'production.airPlanTankCap'], ['airPlan ? sp(game, player.name, \'production.airPlanTankCap\') : 50', '50', 'production.fieldTankCap'],
    ['core < 4 ? 75', '4', 'production.initialCoreTankCount'], ['? 75 :', '75', 'production.fieldInitialTankPriority'],
    ['core < 8 ? 65', '8', 'production.mediumCoreTankCount'], ['? 65 : 55', '65', 'production.fieldMediumTankPriority'],
    ['? sp(game, player.name, \'production.fieldMediumTankPriority\') : 55', '55', 'production.fieldLargeTankPriority'],
    ['Math.ceil(core / 3)', '3', 'production.corePerAirCounterFactor'], ['enemyInf >= 6', '6', 'production.fieldInfantryResponseCount'],
    ['Math.min(3,', '3', 'production.fieldInfantryCounterCap'], ['Math.ceil(enemyInf / 6)', '6', 'production.infantryPerArmorFactor'],
    ['Math.ceil(core / 8)', '8', 'production.corePerIdleCounterFactor'], ['core >= 4', '4', 'production.fieldCounterCoreCount'],
    ['enemyInf >= 8 ? 65 : 45', '8', 'production.fieldUrgentInfantryCount'], ['? 65 : 45', '65', 'production.fieldUrgentCounterPriority'],
    ['? sp(game, player.name, \'production.fieldUrgentCounterPriority\') : 45', '45', 'production.fieldCounterPriority'],
    ['s.harvesters < 4 ?', '4', 'production.largeAirMinHarvesters'], ['Math.max(openingAir, 4)', '4', 'production.mediumAirCap'],
    [': 8\n', '8', 'production.largeAirCap'], ['name === "ZEP" ? 2', '2', 'production.kirovCap'],
    ['name === "V3" || name === "SREF" ? 3', '3', 'production.artilleryCap'],
    [": name === \"V3\" || name === \"SREF\" ? sp(game, player.name, 'production.artilleryCap') : 2", '2', 'production.otherSupportCap'],
    ['? 100 : 40', '100', 'production.firstKirovPriority'], ['? sp(game, player.name, \'production.firstKirovPriority\') : 40', '40', 'production.supportUnitPriority'],
    ['(s.own.E1 ?? 0) > 5', '5', 'defense.freeGiReserveCount'], ['requestSpecificUnits(free, 50)', '50', 'assault.freeUnitPriority'],
] as const) rule(a, before, literal, path, 'game', 'player.name', undefined, true);
rule(a, 'this.searchProgressAt + 900', '900', 'assault.searchProgressTimeoutTicks', 'game', 'player');
rule(a, ') + 3600', '3600', 'assault.failedSearchCooldownTicks', 'game', 'player');
rule(a, '* 0.15', '0.15', 'assault.searchFallbackDistanceFactor', 'game', 'player');
rule(a, 'tick / 900', '900', 'assault.startPatrolPeriodTicks', 'game', 'player');
const m = 'logic/mission/missions/minerDefence.ts';
for (const [before, literal, path] of [
    ['home.distanceTo(new Vector2(unit.tile.rx, unit.tile.ry)) <= 32', '32', 'defense.minerInfantryWarningRadius'],
    ['home.distanceTo(new Vector2(res.tile.rx, res.tile.ry)) <= 32', '32', 'economy.gemHomeRadius'],
    ['<= 24', '24', 'defense.minerArmorWarningRadius'],
    ['this.nextDefenceAt = tick + 300', '300', 'defense.minerDefenseCooldownTicks'],
    ['until: tick + 300', '300', 'defense.minerDefenseDurationTicks'],
    ['approaching.length >= 6', '6', 'defense.minerDefenseInfantryCount'], ['approaching.length >= 2', '2', 'defense.minerDefenseContinueCount'],
    ['* 0.8', '0.8', 'defense.minerDefenseStartHpRatio'], ['<= 28', '28', 'defense.minerDefenseLeashRadius'],
    ['* 0.55', '0.55', 'defense.minerDefenseContinueHpRatio'], ['* 0.5', '0.5', 'defense.minerRetreatHpRatio'],
    ['<= 10)', '10', 'defense.minerRetreatThreatRadius'], ['<= 10 ** 2', '10', 'defense.safeRefineryThreatRadius'],
    ['<= 25', '25', 'economy.gemRefineryRadius'], ['<= 14 ** 2', '14', 'economy.gemThreatRadius'],
    ['* 0.7', '0.7', 'economy.gemMinerHpRatio'],
] as const) rule(m, before, literal, path, 'game', 'player.name', undefined, true);
const sc = 'logic/mission/missions/scoutingMission.ts';
replace(sc, 'this.priority = factories === 0 ? 85 : 50;', `this.priority = factories === 0 ? ${read(sc, '85', 'scout.beforeFactoryPriority', 'context.game', 'context.player.name', 'context.difficulty === "brutal"')} : ${read(sc, '50', 'scout.afterFactoryPriority', 'context.game', 'context.player.name', 'context.difficulty === "brutal"')};`);
for (const [before, literal, path] of [
    ['> 0.9', '0.9', 'scout.revealedStopRatio'], ['game.getCurrentTick() > 3600', '3600', 'scout.initialScoutEndTick'],
    ['this.totalUnitsReceived >= 1', '1', 'scout.maxReceivedScoutsCap'],
    ['scouts.length > 1', '1', 'scout.maxConcurrentScoutsCap'], ['scouts.slice(1)', '1', 'scout.maxConcurrentScoutsCap'],
    ['> MAX_ATTEMPTS_PER_TARGET', 'MAX_ATTEMPTS_PER_TARGET', 'scout.maxTargetAttemptsCap'],
    ['+ MAX_TICKS_PER_TARGET', 'MAX_TICKS_PER_TARGET', 'scout.targetTimeoutTicks'],
    ['+ SCOUT_COOLDOWN_TICKS', 'SCOUT_COOLDOWN_TICKS', 'scout.initialCooldownTicks'],
] as const) rule(sc, before, literal, path, 'context.game', 'context.player.name', 'context.difficulty === "brutal"', true);
rule(sc, 'context.difficulty === "brutal" ? 85 : 50', '85', 'scout.beforeFactoryPriority', 'context.game', 'context.player.name');
// The remaining shared mission timers/priorities are handled below with explicit normal fallbacks.
const at = 'logic/mission/missions/attackMission.ts';
replace(at, '        logger: DebugLogger,\n    )', '        logger: DebugLogger,\n        context?: SupabotContext,\n    )');
replace(at, '                composition,\n                logger,\n', '                composition,\n                logger,\n                context,\n');
rule(at, 'rallyArea, rallyArea, 18, true', '18', 'assault.preparingWaveRadius', 'context!.game', 'context!.player.name', 'context?.difficulty === "brutal"');
replace(at, 'this.startAttack(tick)', 'this.startAttack(tick, context)', true);
replace(at, 'private startAttack(tick: number)', 'private startAttack(tick: number, context: MissionContext)');
rule(at, 'this.priority = ATTACK_MISSION_INITIAL_PRIORITY', 'ATTACK_MISSION_INITIAL_PRIORITY', 'assault.attackMissionInitialPriority', 'context.game', 'context.player.name', 'context.difficulty === "brutal"');
rule(at, '                ATTACK_MISSION_INITIAL_PRIORITY,', 'ATTACK_MISSION_INITIAL_PRIORITY', 'assault.attackMissionInitialPriority', 'context.game', 'context.player.name', 'context.difficulty === "brutal"');
rule(at, 'this.priority * ATTACK_MISSION_PRIORITY_RAMP', 'ATTACK_MISSION_PRIORITY_RAMP', 'assault.wavePriorityRampFactor', 'context.game', 'context.player.name', 'context.difficulty === "brutal"');
rule(at, ', ATTACK_MISSION_MAX_PRIORITY)', 'ATTACK_MISSION_MAX_PRIORITY', 'assault.waveMaximumPriority', 'context.game', 'context.player.name', 'context.difficulty === "brutal"');
rule(at, '+ NO_TARGET_IDLE_TIMEOUT_TICKS', 'NO_TARGET_IDLE_TIMEOUT_TICKS', 'assault.noTargetIdleTimeoutTicks', 'context.game', 'context.player.name', 'context.difficulty === "brutal"');
rule(at, '+ NO_TARGET_RETARGET_TICKS', 'NO_TARGET_RETARGET_TICKS', 'assault.noTargetRetargetTicks', 'context.game', 'context.player.name', 'context.difficulty === "brutal"');
rule(at, '+ BASE_ATTACK_COOLDOWN_TICKS', 'BASE_ATTACK_COOLDOWN_TICKS', 'assault.baseAttackCooldownTicks', 'context.game', 'context.player.name', 'context.difficulty === "brutal"');
rule(at, 'const attackRadius = 10', '10', 'assault.attackTargetRadius', 'context.game', 'context.player.name', 'context.difficulty === "brutal"');
replace(at, '(unitData: UnitData, tryFocusHarvester: boolean) => number = (unitData, tryFocusHarvester)', '(unitData: UnitData, tryFocusHarvester: boolean, game: GameApi, playerName: string, difficulty?: "normal" | "brutal") => number = (unitData, tryFocusHarvester, game, playerName, difficulty)');
replace(at, 'getTargetWeight(u, tryFocusHarvester)', 'getTargetWeight(u, tryFocusHarvester, gameApi, playerData.name, difficulty)');
replace(at, '    includeBaseLocations: boolean = false,\n', '    includeBaseLocations: boolean = false,\n    difficulty?: "normal" | "brutal",\n');
replace(at, 'generateTarget(game, playerData, matchAwareness);', 'generateTarget(game, playerData, matchAwareness, false, context.difficulty);');
replace(at, 'generateTarget(game, playerData, matchAwareness, includeEnemyBases)', 'generateTarget(game, playerData, matchAwareness, includeEnemyBases, context.difficulty)');
rule(at, 'return 100000', '100000', 'assault.harvesterFocusWeight', 'game', 'playerName', 'difficulty === "brutal"');
rule(at, '?? 1) * 10', '10', 'assault.buildingTargetHpFactor', 'game', 'playerName', 'difficulty === "brutal"');
for (const [before, expression, path] of [
    ['>= MINIMUM_WAVE_WAIT_TICKS', 'MINIMUM_WAVE_WAIT_TICKS', 'assault.minimumWaveWaitTicks'],
    ['Math.max(4, this.composition.minimumUnits)', '4', 'assault.noAirCoverWaveArmorCount'],
    ['>= MAX_PREPARATION_TICKS', 'MAX_PREPARATION_TICKS', 'assault.maxPreparationTicks'],
    ['>= REINFORCEMENT_TIMEOUT_TICKS', 'REINFORCEMENT_TIMEOUT_TICKS', 'assault.reinforcementTimeoutTicks'],
    ['tick - this.lastApproachProgressAt < 1800', '1800', 'assault.approachProgressTimeoutTicks'],
] as const) rule(at, before, expression, path, 'context.game', 'context.player.name');
replace(at, 'this.isApproachingTarget(game.getCurrentTick())', 'this.isApproachingTarget(game.getCurrentTick(), context)');
replace(at, 'private isApproachingTarget(tick: number)', 'private isApproachingTarget(tick: number, context: MissionContext)');
for (const name of ['MINIMUM_WAVE_WAIT_TICKS', 'MAX_PREPARATION_TICKS', 'REINFORCEMENT_TIMEOUT_TICKS']) {
    const source = changed.get(at)!;
    if ((source.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length === 1) changed.set(at, source.replace(new RegExp(`^const ${name} =[^\\n]*\\n`, 'm'), ''));
}
const ha = 'logic/mission/missions/harassmentMission.ts';
replace(ha, 'private getMainTargets: () => Vector2[] = () => []) {', 'private getMainTargets: () => Vector2[] = () => [], context?: SupabotContext) {');
replace(ha, '() => mainForces.filter(force => force.isActive()).map(force => force.getAttackArea()));', '() => mainForces.filter(force => force.isActive()).map(force => force.getAttackArea()), context);');
rule(ha, 'new CombatSquad(home, target, 8)', '8', 'harass.raidTargetRadius', 'context!.game', 'context!.player.name', 'context?.difficulty === "brutal"');
rule(ha, 'tick - this.createdAt >= 120', '120', 'harass.claimTimeoutTicks', 'context.game', 'context.player.name');
rule(ha, 'requestSpecificUnits(this.claimedIds, 80)', '80', 'harass.claimPriority', 'context.game', 'context.player.name');
replace(ha, 'getPriority() { return 20; }', "getPriority(context: MissionContext) { return sp(context.game, context.player.name, 'harass.raidMissionPriority'); }");
params['harass.raidMissionPriority'] = 20;
for (const [before, literal, path] of [
    ['tick - this.createdAt >= RAID_LIFETIME', 'RAID_LIFETIME', 'harass.raidLifetimeTicks'], ['units.filter(isRaidTank).length < 2', '2', 'harass.raidContinueTankCount'],
    ['this.returnStartedAt >= 900', '900', 'harass.returnTimeoutTicks'], ['<= 5)', '5', 'harass.returnArrivalRadius'],
    ['this.lastLaunch + 450', '450', 'harass.raidLaunchCooldownTicks'], ['mainCombatants < 6', '6', 'harass.mainCombatantFloor'],
    ['mainTanks < 3', '3', 'harass.mainTankFloor'], ['donor.combatants.length - 3', '3', 'harass.donorCombatantFloor'],
    ['donor.tanks.length - 2', '2', 'harass.donorTankFloor'], ['mainCombatants - 6', '6', 'harass.mainCombatantFloor'],
    ['mainTanks - 3', '3', 'harass.mainTankFloor'],
] as const) rule(ha, before, literal, path, 'context.game', 'context.player.name', undefined, true);
changed.set(ha, changed.get(ha)!.replace(/^const RAID_LIFETIME =[^\n]*\n/m, ''));
const ex = 'logic/mission/missions/expansionMission.ts';
replace(ex, '                selectedMcvUnit,\n', '                selectedMcvUnit,\n                context.difficulty,\n');
replace(ex, '        mcv: UnitData,\n    )', '        mcv: UnitData,\n        difficulty?: "normal" | "brutal",\n    )');
for (const [before, expression, path] of [
    ['subScalar(CONYARD_SCAN_DISTANCE)', 'CONYARD_SCAN_DISTANCE', 'expand.existingYardRadius'],
    ['addScalar(CONYARD_SCAN_DISTANCE)', 'CONYARD_SCAN_DISTANCE', 'expand.existingYardRadius'],
    ['<= CONYARD_DEPLOY_DISTANCE', 'CONYARD_DEPLOY_DISTANCE', 'expand.deployArrivalRadius'],
    ['> ExpansionMission.MAX_DEPLOY_ATTEMPTS', 'ExpansionMission.MAX_DEPLOY_ATTEMPTS', 'expand.maxDeployAttemptsCap'],
] as const) rule(ex, before, expression, path, 'gameApi', 'playerData.name', 'difficulty === "brutal"');
for (const [before, expression, path] of [
    ['< DO_NOT_EXPAND_BEFORE_TICKS', 'DO_NOT_EXPAND_BEFORE_TICKS', 'expand.expandStartTick'],
    ['+ CONYARD_PACK_COOLDOWN', 'CONYARD_PACK_COOLDOWN', 'expand.packCooldownTicks'],
    ['Math.hypot(resource.tile.rx - yard.tile.rx, resource.tile.ry - yard.tile.ry) <= 25', '25', 'expand.homeResourceRadius'],
    ['toVector2(selectedConyard.tile).subScalar(10)', '10', 'expand.refineryLowerRadius'],
    ['toVector2(selectedConyard.tile).addScalar(14)', '14', 'expand.refineryUpperRadius'],
] as const) rule(ex, before, expression, path, 'game', 'player.name', 'context.difficulty === "brutal"', true);
rule(ex, 'new ExpansionMission("initial-deploy-mcv-" + mcv, 100', '100', 'expand.mcvMissionPriority', 'game', 'player.name', 'context.difficulty === "brutal"');
rule(ex, 'new ExpansionMission("expansion-mcv-" + mcv, 100', '100', 'expand.mcvMissionPriority', 'game', 'player.name', 'context.difficulty === "brutal"');
replace(ex, '    public getPriority() {\n        return 10000;', `    public getPriority(context: MissionContext) {\n        return ${read(ex, '10000', 'expand.packMissionPriority', 'context.game', 'context.player.name', 'context.difficulty === "brutal"')};`.replace(';;', ';'));
const ds = 'strategy/defaultStrategy.ts'; direct(ds, 'context.game', 'playerData.name');
for (const [before, literal, path] of [
    ['context.game.getCurrentTick() < 7000', '7000', 'production.infantryOpeningEndTick'], ['minimumUnits: 8', '8', 'production.infantryOpeningMinCount'],
    ['infantryOpening.composition.E2 ? 16 : 12', '16', 'production.sovietOpeningInfantryCap'],
    ['infantryOpening.composition.E2 ? sp(context.game, playerData.name, \'production.sovietOpeningInfantryCap\') : 12', '12', 'production.alliedOpeningInfantryCap'],
    ['(situation.own.JUMPJET ?? 0) < 8', '8', 'production.openingRocketeerCap'], ['aggressiveAir ? 3 : 0.1', '3', 'production.aggressiveAirThreatFloor'],
    ['aggressiveAir ? sp(context.game, playerData.name, \'production.aggressiveAirThreatFloor\') : 0.1', '0.1', 'production.airThreatFloor'],
    ['aggressiveAir ? 0.6 : 0.25', '0.6', 'production.aggressiveAirThreatRatio'],
    ['aggressiveAir ? sp(context.game, playerData.name, \'production.aggressiveAirThreatRatio\') : 0.25', '0.25', 'production.airThreatRatio'],
    ['Math.max(6,', '6', 'production.kirovThreatFloor'], ['* 0.8', '0.8', 'production.kirovThreatRatio'],
    ['maximumUnits: 4', '4', 'production.openingAirWaveCap'],
    ['(situation.own.ZEP ?? 0) < 2', '2', 'production.kirovCap'], ['maximumUnits: 2', '2', 'production.kirovCap'],
] as const) rule(ds, before, literal, path, 'context.game', 'playerData.name');
// Shared archetypes remain unchanged for normal. Zero-weight unit choices are disabled, not divided by zero.
const clone = `        const compositions: Compositions = context.difficulty === "brutal"\n            ? Object.fromEntries(Object.entries(DEFAULT_COMPOSITIONS).map(([name, plan]): [string, SideComposition] => [name, {\n                ...plan, composition: Object.fromEntries(Object.keys(plan.composition).map((unit): [string, number] =>\n                    [unit, sp(context.game, playerData.name, \`production.\${name}\${unit}Factor\`)]).filter(([, weight]) => weight > 0)),\n                minimumUnits: sp(context.game, playerData.name, \`production.\${name}MinCount\`),\n                maximumUnits: sp(context.game, playerData.name, \`production.\${name}Cap\`),\n            }]).filter(([, plan]) => Object.keys(plan.composition).length > 0))\n            : DEFAULT_COMPOSITIONS;\n`;
replace(ds, '        const validCompositions = getValidCompositions(context, DEFAULT_COMPOSITIONS);', clone + '        const validCompositions = getValidCompositions(context, compositions);');
let text = changed.get(ds)!, index = text.indexOf('        if (context.difficulty === "brutal") {\n            const situation'), end = text.indexOf('\n        const randomIndex', index);
text = text.slice(0, index) + text.slice(index, end).replaceAll('DEFAULT_COMPOSITIONS[tankCore]', 'compositions[tankCore]').replaceAll('DEFAULT_COMPOSITIONS.conscripts', 'compositions.conscripts').replaceAll('DEFAULT_COMPOSITIONS.gis', 'compositions.gis').replaceAll('DEFAULT_COMPOSITIONS.rocketeers', 'compositions.rocketeers').replaceAll('DEFAULT_COMPOSITIONS.kirovs', 'compositions.kirovs').replace('DEFAULT_COMPOSITIONS, validCompositions', 'compositions, validCompositions') + text.slice(end);
changed.set(ds, text);
for (const [name, plan] of Object.entries(DEFAULT_COMPOSITIONS)) {
    params[`production.${name}MinCount`] = plan.minimumUnits; params[`production.${name}Cap`] = plan.maximumUnits;
    for (const [unit, weight] of Object.entries(plan.composition)) params[`production.${name}${unit}Factor`] = weight;
}
direct(extra[0], 'context.game', 'context.player.name');
direct(extra[1], 'game', 'context.player.name', '    private spreadSlot(');
// Add precisely one sp import and remove only imports rendered unused by this extraction.
for (const [file, source] of changed) {
    const relative = file.startsWith('strategy/') ? './params' : file.includes('/squads/') ? '../../../../strategy/params'
        : file.startsWith('logic/building/') ? '../../strategy/params' : '../../../strategy/params';
    const imported = source.replace(/^import \{ BRUTAL_PARAMS \} from [^\n]+\n/m, '');
    changed.set(file, `import { sp } from "${relative}";\n` + imported);
}
const parameterSource = 'export const BRUTAL_PARAMS = {\n' + GROUPS.map(group => `    ${group}: {\n` + Object.entries(params).filter(([path]) => path.startsWith(group + '.')).map(([path, v]) => `        ${path.slice(group.length + 1)}: ${v},\n`).join('') + '    },\n').join('') + '};\nexport type BrutalParams = typeof BRUTAL_PARAMS;\n';
const { values } = parseArgs({ options: { apply: { type: 'boolean' } } });
const counts = Object.fromEntries(DECISION_FILES.map(file => [file, { before: countStrategyLiterals(original.get(file)!), after: countStrategyLiterals(changed.get(file)!) }]));
const report = { parameters: Object.keys(params).length, groups: Object.fromEntries(GROUPS.map(group => [group, Object.keys(params).filter(path => path.startsWith(group + '.')).length])), counts, proof };
await mkdir(resolve(root, '.artifacts/p4/P3'), { recursive: true });
await writeFile(resolve(root, '.artifacts/p4/P3/extraction.json'), JSON.stringify(report, null, 2) + '\n');
if (values.apply) {
    for (const [file, content] of changed) await writeFile(resolve(bot, file), content);
    await writeFile(resolve(bot, 'strategy/brutalParams.ts'), parameterSource);
    await writeFile(resolve(import.meta.dir, 'literal-budget.json'), JSON.stringify(Object.fromEntries(Object.entries(counts).map(([file, count]) => [file, count.after])), null, 2) + '\n');
}
console.log(JSON.stringify({ ...report, proof: `${proof.length} source-derived values; details in .artifacts/p4/P3/extraction.json`, applied: !!values.apply }, null, 2));

import { sp } from "../../strategy/params";
import { GameApi, GameMath, MovementZone, ObjectType, PlayerData, TechnoRules, UnitData } from "../../../game-api";
import { countCoreTanks, hasMatureEconomy, readStrategicSituation } from "../../strategy/nationalComposition";
import type { GlobalThreat } from "../threat/threat";
import { getAdjacencyTiles, getDefaultPlacementLocation } from "./buildingRules";

const RADARS = new Set(["GAAIRC", "AMRADR", "NARADR"]);
const LABS = new Set(["GATECH", "NATECH"]);
const REFINERIES = new Set(["GAREFN", "NAREFN"]);
const SUPERWEAPONS = new Set(["NAMISL", "NAIRON", "GAWEAT", "GACHRO"]);
const distance = (x1: number, y1: number, x2: number, y2: number) => GameMath.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);

function findThreatenedAnchor(game: GameApi, player: PlayerData, radius = sp(game, player.name, 'defense.threatenedAnchorRadius')) {
    const anchors = game.getVisibleUnits(player.name, "self", rules => rules.refinery || rules.constructionYard || rules.weaponsFactory)
        .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
    const enemies = game.getVisibleUnits(player.name, "enemy", rules => rules.isSelectableCombatant &&
        rules.type !== ObjectType.Building && rules.type !== ObjectType.Aircraft && rules.movementZone !== MovementZone.Fly)
        .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
    let best: { anchor: UnitData; enemy: UnitData; distance: number } | undefined;
    for (const anchor of anchors) for (const enemy of enemies) {
        const separation = distance(anchor.tile.rx, anchor.tile.ry, enemy.tile.rx, enemy.tile.ry);
        if (separation <= radius && (!best || separation < best.distance)) best = { anchor, enemy, distance: separation };
    }
    return best;
}

/** undefined retains the existing priority; zero explicitly defers an investment. */
export function getStrategicBuildingPriority(
    game: GameApi, player: PlayerData, option: TechnoRules, threat: GlobalThreat | null,
    committed = false,
): number | undefined {
    if (!RADARS.has(option.name) && !LABS.has(option.name) && !REFINERIES.has(option.name) && !SUPERWEAPONS.has(option.name) && option.name !== "GTGCAN") return undefined;
    const situation = readStrategicSituation(game, player);
    const { own, enemy, credits, harvesters, country } = situation;
    const core = countCoreTanks(situation);
    const owned = own[option.name] ?? 0;
    // A French defensive opening must be admitted before the four-tank late
    // investment gate. Require actual scouted pressure, income and close guards.
    const frenchPressure = country === "French" && !(own.GTGCAN > 0) && harvesters >= 1 &&
        ((own.E1 ?? 0) >= sp(game, player.name, 'defense.frenchOpeningInfantryCount') || core >= 1) && (enemy.infantry >= sp(game, player.name, 'defense.frenchOpeningEnemyInfantryCount') || enemy.vehicles >= sp(game, player.name, 'defense.frenchOpeningEnemyVehicleCount')) &&
        !!findThreatenedAnchor(game, player, sp(game, player.name, 'defense.frenchOpeningWarningRadius'));
    // Admission checks reserve funds for starting an investment. Once production
    // spends those funds, retain its request instead of repeatedly cancelling it.
    if (committed && !owned && (RADARS.has(option.name) || LABS.has(option.name))) return sp(game, player.name, 'production.committedInvestmentPriority');
    if (committed && REFINERIES.has(option.name) && owned === 1) return sp(game, player.name, 'production.committedInvestmentPriority');
    if (RADARS.has(option.name) && owned === 0 && frenchPressure &&
        credits >= option.cost + sp(game, player.name, 'production.frenchRadarCostMargin') && !player.power.isLowPower) return sp(game, player.name, 'production.frenchRadarPriority');
    if (RADARS.has(option.name) && owned === 0 && harvesters >= 2 &&
        ((core >= sp(game, player.name, 'production.radarCoreCount') && credits >= sp(game, player.name, 'production.radarCreditsFloor')) || (core >= 1 && credits >= option.cost + sp(game, player.name, 'production.lowCoreRadarCostMargin')))) {
        const needsSpecialist = country === "Arabs" ? enemy.infantry >= sp(game, player.name, 'production.specialistEnemyInfantryCount') || enemy.vehicles >= sp(game, player.name, 'production.desolatorEnemyVehicleCount')
            : country === "British" ? enemy.infantry >= sp(game, player.name, 'production.specialistEnemyInfantryCount')
            : country === "Germans" ? enemy.vehicles >= sp(game, player.name, 'production.germanSpecialistEnemyVehicleCount') && enemy.vehicles >= enemy.infantry
            : country === "French" ? enemy.infantry + enemy.vehicles >= sp(game, player.name, 'production.frenchSpecialistEnemyCount')
            : country === "Russians" ? (hasMatureEconomy(situation) || (core >= sp(game, player.name, 'production.russianSpecialistCoreCount') && credits >= option.cost + sp(game, player.name, 'production.russianSpecialistCostMargin')))
            : (hasMatureEconomy(situation) || enemy.defences >= 2 || (core >= sp(game, player.name, 'production.specialistCoreCount') && credits >= option.cost + sp(game, player.name, 'production.specialistCostMargin')));
        if (needsSpecialist && !player.power.isLowPower) return sp(game, player.name, 'production.committedInvestmentPriority');
    }
    if (REFINERIES.has(option.name) && owned === 1 && harvesters === 2 && core >= sp(game, player.name, 'economy.safeExpansionCoreCount') &&
        situation.tick >= sp(game, player.name, 'economy.safeRefineryExpansionTick') && credits >= option.cost / 2 &&
        (!threat || threat.totalOffensiveLandThreat <=
            (threat.totalAvailableAntiGroundFirepower + threat.totalDefensivePower) * sp(game, player.name, 'economy.safeExpansionThreatRatio'))) {
        // One funded expansion provides the income for later tech and larger waves.
        return sp(game, player.name, 'production.committedInvestmentPriority');
    }
    if (LABS.has(option.name)) {
        if (owned || !hasMatureEconomy(situation) || credits < option.cost + sp(game, player.name, 'production.labCostMargin') || player.power.isLowPower) return 0;
        return enemy.vehicles >= sp(game, player.name, 'production.labEnemyVehicleCount') || enemy.defences >= 2 || credits >= option.cost + sp(game, player.name, 'production.labSurplusCostMargin') ? sp(game, player.name, 'production.labPriority') : 0;
    }
    if (SUPERWEAPONS.has(option.name)) {
        if (owned > 0 || !hasMatureEconomy(situation) || player.power.isLowPower) return 0;
        if (committed) return sp(game, player.name, 'production.superweaponPriority');
        if (credits >= option.cost + sp(game, player.name, 'production.superweaponCostMargin') && countCoreTanks(situation) >= sp(game, player.name, 'production.superweaponCoreCount')) return sp(game, player.name, 'production.superweaponPriority');
        return 0;
    }
    if (option.name === "GTGCAN") {
        const cap = harvesters >= sp(game, player.name, 'defense.secondCannonMinHarvesters') && core >= sp(game, player.name, 'defense.secondCannonCoreCount') && enemy.infantry + enemy.vehicles >= sp(game, player.name, 'defense.secondCannonEnemyCount') ? 2 : 1;
        const powerNeeded = Math.max(0, -option.power);
        if (committed && country === "French") return owned === 0 ? sp(game, player.name, 'defense.firstCannonPriority') : sp(game, player.name, 'defense.extraCannonPriority');
        if (owned === 0 && frenchPressure && credits >= sp(game, player.name, 'defense.openingCannonCredits') &&
            player.power.total - player.power.drain >= powerNeeded) return sp(game, player.name, 'defense.openingCannonPriority');
        if (country !== "French" || owned >= cap || harvesters < 2 || core < sp(game, player.name, 'defense.extraCannonCoreCount') ||
            credits < option.cost + sp(game, player.name, 'defense.extraCannonCostMargin') || player.power.total - player.power.drain < powerNeeded ||
            enemy.infantry + enemy.vehicles < sp(game, player.name, 'defense.extraCannonEnemyCount') || !findThreatenedAnchor(game, player)) return 0;
        return owned === 0 ? sp(game, player.name, 'defense.firstCannonPriority') : sp(game, player.name, 'defense.extraCannonPriority');
    }
    return undefined;
}

/** Cover a threatened refinery/factory approach, keeping enemies outside the cannon's blind zone. */
export function getGrandCannonPlacement(game: GameApi, player: PlayerData, rules: TechnoRules) {
    const threatened = findThreatenedAnchor(game, player);
    // The spotted attack may disappear while an admitted cannon is being built.
    // Keep a valid placement path for that investment without requiring enemy vision.
    if (!threatened) return getDefaultPlacementLocation(game, player, player.startLocation, rules, false, 2);
    const weapon = rules.primary ? game.rulesApi.getWeapon(rules.primary) : undefined;
    const minimumRange = weapon?.minimumRange ?? 3;
    const range = weapon?.range ?? 15;
    const { anchor, enemy } = threatened;
    const candidates = getAdjacencyTiles(game, player, rules, false, 2)
        .map(tile => {
            const targetDistance = distance(tile.rx, tile.ry, enemy.tile.rx, enemy.tile.ry);
            const anchorDistance = distance(tile.rx, tile.ry, anchor.tile.rx, anchor.tile.ry);
            return { tile, targetDistance, score: anchorDistance + Math.max(0, targetDistance - range) * sp(game, player.name, 'defense.cannonRangePenaltyFactor') };
        })
        .filter(candidate => candidate.targetDistance >= minimumRange + 1)
        .sort((a, b) => a.score - b.score || a.tile.rx - b.tile.rx || a.tile.ry - b.tile.ry);
    return candidates.find(candidate => game.canPlaceBuilding(player.name, rules.name, candidate.tile))?.tile;
}

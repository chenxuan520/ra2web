import { GameApi, GameMath, MovementZone, ObjectType, PlayerData, TechnoRules, UnitData } from "../../../game-api";
import { countCoreTanks, hasMatureEconomy, readStrategicSituation } from "../../strategy/nationalComposition";
import type { GlobalThreat } from "../threat/threat";
import { getAdjacencyTiles, getDefaultPlacementLocation } from "./buildingRules";

const RADARS = new Set(["GAAIRC", "AMRADR", "NARADR"]);
const LABS = new Set(["GATECH", "NATECH"]);
const REFINERIES = new Set(["GAREFN", "NAREFN"]);
const SUPERWEAPONS = new Set(["NAMISL", "NAIRON", "GAWEAT", "GACHRO"]);
const distance = (x1: number, y1: number, x2: number, y2: number) => GameMath.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);

function findThreatenedAnchor(game: GameApi, player: PlayerData, radius = 30) {
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
        ((own.E1 ?? 0) >= 4 || core >= 1) && (enemy.infantry >= 6 || enemy.vehicles >= 3) &&
        !!findThreatenedAnchor(game, player, 45);
    // Admission checks reserve funds for starting an investment. Once production
    // spends those funds, retain its request instead of repeatedly cancelling it.
    if (committed && !owned && (RADARS.has(option.name) || LABS.has(option.name))) return 18;
    if (committed && REFINERIES.has(option.name) && owned === 1) return 18;
    if (RADARS.has(option.name) && owned === 0 && frenchPressure &&
        credits >= option.cost + 600 && !player.power.isLowPower) return 32;
    if (RADARS.has(option.name) && owned === 0 && harvesters >= 2 &&
        ((core >= 3 && credits >= 300) || (core >= 1 && credits >= option.cost + 500))) {
        const needsSpecialist = country === "Arabs" ? enemy.infantry >= 3 || enemy.vehicles >= 4
            : country === "British" ? enemy.infantry >= 3
            : country === "Germans" ? enemy.vehicles >= 3 && enemy.vehicles >= enemy.infantry
            : country === "Russians" || country === "French" ? enemy.infantry + enemy.vehicles >= 4
            : enemy.defences >= 2 && hasMatureEconomy(situation);
        if (needsSpecialist && !player.power.isLowPower) return 18;
    }
    if (REFINERIES.has(option.name) && owned === 1 && harvesters === 2 && core >= 4 &&
        situation.tick >= 6 * 60 * 15 && credits >= option.cost / 2 &&
        (!threat || threat.totalOffensiveLandThreat <=
            (threat.totalAvailableAntiGroundFirepower + threat.totalDefensivePower) * 1.25)) {
        // One funded expansion provides the income for later tech and larger waves.
        return 18;
    }
    if (LABS.has(option.name)) {
        if (owned || !hasMatureEconomy(situation) || credits < option.cost + 700 || player.power.isLowPower) return 0;
        return enemy.vehicles >= 3 || enemy.defences >= 2 || credits >= option.cost + 1200 ? 18 : 0;
    }
    if (SUPERWEAPONS.has(option.name)) {
        if (owned > 0 || !hasMatureEconomy(situation) || player.power.isLowPower) return 0;
        if (committed) return 16;
        if (credits >= option.cost + 1500 && countCoreTanks(situation) >= 6) return 16;
        return 0;
    }
    if (option.name === "GTGCAN") {
        const cap = harvesters >= 4 && core >= 8 && enemy.infantry + enemy.vehicles >= 8 ? 2 : 1;
        const powerNeeded = Math.max(0, -option.power);
        if (committed && country === "French") return owned === 0 ? 24 : 16;
        if (owned === 0 && frenchPressure && credits >= 600 &&
            player.power.total - player.power.drain >= powerNeeded) return 30;
        if (country !== "French" || owned >= cap || harvesters < 2 || core < 4 ||
            credits < option.cost + 600 || player.power.total - player.power.drain < powerNeeded ||
            enemy.infantry + enemy.vehicles < 4 || !findThreatenedAnchor(game, player)) return 0;
        return owned === 0 ? 24 : 16;
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
            return { tile, targetDistance, score: anchorDistance + Math.max(0, targetDistance - range) * 3 };
        })
        .filter(candidate => candidate.targetDistance >= minimumRange + 1)
        .sort((a, b) => a.score - b.score || a.tile.rx - b.tile.rx || a.tile.ry - b.tile.ry);
    return candidates.find(candidate => game.canPlaceBuilding(player.name, rules.name, candidate.tile))?.tile;
}

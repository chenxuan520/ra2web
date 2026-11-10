import { GameApi, ObjectType, PlayerData, TechnoRules, UnitData } from "../../../game-api";
import { readStrategicSituation } from "../../strategy/nationalComposition";
import { getOpeningAirBudget } from "../../strategy/openingAirBudget";
import { BRUTAL_PARAMS } from "../../strategy/brutalParams";

const lastDefenseBuiltTick = new WeakMap<GameApi, Map<string, number>>();

/** Fund income before duplicating production capacity that the miners cannot supply. */
export function getEconomyBuildingPriority(game: GameApi, player: PlayerData, rules: TechnoRules, committed: boolean): number | undefined {
    const s = readStrategicSituation(game, player);
    const refineries = (s.own.GAREFN ?? 0) + (s.own.NAREFN ?? 0);
    const factories = (s.own.GAWEAP ?? 0) + (s.own.NAWEAP ?? 0);
    const count = s.own[rules.name] ?? 0;
    if (rules.refinery && refineries > 0) return 0;
    if (["GAAIRC", "AMRADR", "NARADR", "GATECH", "NATECH"].includes(rules.name)) return 0;
    if (["GAWEAP", "NAWEAP"].includes(rules.name) && factories >= BRUTAL_PARAMS.economy.maxFactories) return 0;
    if (rules.refinery) {
        if (!refineries) return BRUTAL_PARAMS.economy.firstRefineryPriority;
        if (refineries === 1) {
            if (!committed) {
                const intruders = game.getVisibleUnits(player.name, "enemy", option => option.isSelectableCombatant)
                    .map(id => game.getUnitData(id)).filter(unit => unit &&
                        (unit.tile.rx - player.startLocation.x) ** 2 + (unit.tile.ry - player.startLocation.y) ** 2 <= BRUTAL_PARAMS.economy.secondRefineryIntruderRadius ** 2);
                if (intruders.length >= BRUTAL_PARAMS.economy.secondRefineryIntruderCount && s.credits < BRUTAL_PARAMS.economy.secondRefineryIntruderCreditsBelow) return 0;
            }
            const core = (s.own.MTNK ?? 0) + (s.own.HTNK ?? 0);
            const canExpand = (s.harvesters >= 2 && (s.credits >= BRUTAL_PARAMS.economy.secondRefineryCredits || core >= BRUTAL_PARAMS.economy.secondRefineryCoreArmor)) ||
                (s.harvesters === 1 && factories > 0 && core >= 1 && s.credits >= rules.cost + BRUTAL_PARAMS.economy.secondRefineryCostMargin &&
                    (rules.freeUnit === "HARV" || rules.freeUnit === "CMIN"));
            return (committed || (factories > 0 && canExpand) ||
                (!factories && (s.own.JUMPJET ?? 0) >= 2 && getOpeningAirBudget(game, player) === 2)) ? BRUTAL_PARAMS.economy.firstRefineryPriority : 0;
        }
        return refineries < BRUTAL_PARAMS.economy.maxRefineries && s.harvesters >= refineries * BRUTAL_PARAMS.economy.harvestersPerRefinery ? BRUTAL_PARAMS.economy.extraRefineryPriority : 0;
    }
    if (rules.name === "GAPILE" || rules.name === "NAHAND") return count ? 0 : BRUTAL_PARAMS.economy.barracksPriority;
    if ((rules.name === "GAAIRC" || rules.name === "AMRADR") && refineries && !count && !factories) {
        const allied = ["Americans", "Alliance", "French", "Germans", "British"].includes(s.country);
        // Nearby public starts need a funded ground production chain first.
        // Keep an already started radar, including after losing a factory.
        const groundFirst = allied && getOpeningAirBudget(game, player) > 2;
        return committed || !groundFirst ? 45 : 0;
    }
    const armor = (s.own.MTNK ?? 0) + (s.own.HTNK ?? 0) + (s.own.MGTK ?? 0) + (s.own.APOC ?? 0) + (s.own.SREF ?? 0);
    if (rules.name === "NARADR") {
        if (s.country === "Russians" && (refineries < BRUTAL_PARAMS.economy.russianRadarMinRefineries || armor < BRUTAL_PARAMS.economy.russianRadarMinArmor || s.credits < BRUTAL_PARAMS.economy.russianRadarMinCredits)) return 0;
        if (!count && s.harvesters >= BRUTAL_PARAMS.economy.radarMinHarvesters && armor >= BRUTAL_PARAMS.economy.radarMinArmor) return BRUTAL_PARAMS.economy.radarPriority;
    }
    if (rules.name === "NATECH" && !count && s.harvesters >= BRUTAL_PARAMS.economy.techMinHarvesters && armor >= BRUTAL_PARAMS.economy.techMinArmor) return BRUTAL_PARAMS.economy.techPriority;
    if (rules.name === "GATECH" && !count && s.harvesters >= BRUTAL_PARAMS.economy.techMinHarvesters && armor >= BRUTAL_PARAMS.economy.techMinArmor) return BRUTAL_PARAMS.economy.techPriority;
    if (rules.name === "GADEPT" || rules.name === "NADEPT") return s.credits >= BRUTAL_PARAMS.economy.depotMinCredits && armor >= BRUTAL_PARAMS.economy.depotMinArmor ? 1 : 0;
    if (["GAAIRC", "AMRADR", "NARADR"].includes(rules.name) &&
        (!factories || s.harvesters < 2 || (s.harvesters < BRUTAL_PARAMS.economy.radarMinHarvesters && armor < BRUTAL_PARAMS.economy.radarMinArmor))) return 0;
    if (rules.name === "GAPILL" || rules.name === "NALASR") {
        if (count >= BRUTAL_PARAMS.economy.defenseMaxCount || s.credits < BRUTAL_PARAMS.economy.defenseMinCredits) return 0;
        const currentTick = game.getCurrentTick();
        let playerCooldowns = lastDefenseBuiltTick.get(game);
        if (!playerCooldowns) {
            playerCooldowns = new Map();
            lastDefenseBuiltTick.set(game, playerCooldowns);
        }
        const lastTick = playerCooldowns.get(player.name) ?? -Infinity;
        if (currentTick < lastTick) playerCooldowns.set(player.name, -Infinity); // game reset
        if (currentTick - (playerCooldowns.get(player.name) ?? -Infinity) < BRUTAL_PARAMS.economy.defenseCooldownTicks) return 0;

        const anchors = game.getVisibleUnits(player.name, "self", r =>
            r.constructionYard || r.refinery || r.weaponsFactory)
            .map(id => (game.getUnitData?.(id) ?? game.getGameObjectData?.(id)) as UnitData).filter((u): u is UnitData => !!u);
        const start = player.startLocation;
        const intruders = game.getVisibleUnits(player.name, "enemy", option => option.isSelectableCombatant && !option.harvester)
            .map(id => (game.getUnitData?.(id) ?? game.getGameObjectData?.(id)) as UnitData).filter(unit => unit && (
                (unit.tile.rx - start.x) ** 2 + (unit.tile.ry - start.y) ** 2 <= BRUTAL_PARAMS.economy.defenseStartRadius ** 2 ||
                anchors.some(a => (unit.tile.rx - a.tile.rx) ** 2 + (unit.tile.ry - a.tile.ry) ** 2 <= BRUTAL_PARAMS.economy.defenseAnchorRadius ** 2)
            ));
        // Only build defensively when enemy combatants are actively invading the base!
        const hasVehicleIntruder = intruders.some(u => (u.type as any) === ObjectType.Vehicle);
        if (intruders.length >= BRUTAL_PARAMS.economy.defenseInfantryIntruders || (intruders.length >= 1 && hasVehicleIntruder)) {
            if (committed) playerCooldowns.set(player.name, currentTick);
            return BRUTAL_PARAMS.economy.defensePriority;
        }
        return 0;
    }
    if (rules.name === "TESLA" || rules.name === "ATESLA") {
        // High-tech static defenses cost $1500 and drain huge power.
        // Never build unless base has massive surplus economy and active vehicle assault.
        const powerMargin = (player.power?.total ?? 0) - (player.power?.drain ?? 0);
        if (powerMargin < BRUTAL_PARAMS.economy.teslaMinPowerMargin || player.power?.isLowPower || count >= BRUTAL_PARAMS.economy.teslaMaxCount) return 0;
        const start = player.startLocation;
        const intruders = game.getVisibleUnits(player.name, "enemy", option => option.isSelectableCombatant && !option.harvester)
            .map(id => (game.getUnitData?.(id) ?? game.getGameObjectData?.(id)) as UnitData).filter(unit => unit &&
                (unit.tile.rx - start.x) ** 2 + (unit.tile.ry - start.y) ** 2 <= BRUTAL_PARAMS.economy.teslaRadius ** 2);
        const hasVehicleIntruder = intruders.some(u => (u.type as any) === ObjectType.Vehicle);
        if (hasVehicleIntruder && s.credits >= BRUTAL_PARAMS.economy.teslaMinCredits && armor >= BRUTAL_PARAMS.economy.teslaMinArmor) {
            return BRUTAL_PARAMS.economy.teslaPriority;
        }
        return 0;
    }
    if (rules.name === "GAWEAP" || rules.name === "NAWEAP") {
        if (!factories) {
            if (!refineries) return committed ? (rules.name === "NAWEAP" ? BRUTAL_PARAMS.economy.firstFactoryPrioritySoviet : BRUTAL_PARAMS.economy.firstFactoryPriorityAllied) : 0;
            return rules.name === "NAWEAP" ? BRUTAL_PARAMS.economy.firstFactoryPrioritySoviet : BRUTAL_PARAMS.economy.firstFactoryPriorityAllied;
        }
        if (factories === 1) {
            const hasIncomeForDual = (refineries >= BRUTAL_PARAMS.economy.secondFactoryMinRefineries && s.harvesters >= BRUTAL_PARAMS.economy.secondFactoryMinHarvesters && (s.credits >= BRUTAL_PARAMS.economy.secondFactoryMinCredits || armor >= BRUTAL_PARAMS.economy.secondFactoryMinArmor)) || s.harvesters >= BRUTAL_PARAMS.economy.secondFactoryHarvesterOverride;
            return (committed || hasIncomeForDual) ? BRUTAL_PARAMS.economy.extraFactoryPriority : 0;
        }
        return factories < BRUTAL_PARAMS.economy.maxFactories && s.harvesters >= 4 + (factories - 1) * 2 ? BRUTAL_PARAMS.economy.extraFactoryPriority : 0;
    }
    return undefined;
}

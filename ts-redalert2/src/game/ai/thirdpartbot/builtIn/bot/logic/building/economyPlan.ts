import { sp } from "../../strategy/params";
import { GameApi, ObjectType, PlayerData, TechnoRules, UnitData } from "../../../game-api";
import { readStrategicSituation } from "../../strategy/nationalComposition";
import { getOpeningAirBudget } from "../../strategy/openingAirBudget";

const lastDefenseBuiltTick = new WeakMap<GameApi, Map<string, number>>();

/** Fund income before duplicating production capacity that the miners cannot supply. */
export function getEconomyBuildingPriority(game: GameApi, player: PlayerData, rules: TechnoRules, committed: boolean): number | undefined {
    const s = readStrategicSituation(game, player);
    const refineries = (s.own.GAREFN ?? 0) + (s.own.NAREFN ?? 0);
    const factories = (s.own.GAWEAP ?? 0) + (s.own.NAWEAP ?? 0);
    const count = s.own[rules.name] ?? 0;
    if (rules.refinery) {
        if (!refineries) return sp(game, player.name, 'economy.firstRefineryPriority');
        if (refineries === 1) {
            if (!committed) {
                const intruders = game.getVisibleUnits(player.name, "enemy", option => option.isSelectableCombatant)
                    .map(id => game.getUnitData(id)).filter(unit => unit &&
                        (unit.tile.rx - player.startLocation.x) ** 2 + (unit.tile.ry - player.startLocation.y) ** 2 <= sp(game, player.name, 'economy.secondRefineryIntruderRadius') ** 2);
                if (intruders.length >= sp(game, player.name, 'economy.secondRefineryIntruderCount') && s.credits < sp(game, player.name, 'economy.secondRefineryIntruderCreditsBelow')) return 0;
            }
            const core = (s.own.MTNK ?? 0) + (s.own.HTNK ?? 0);
            const canExpand = (s.harvesters >= sp(game, player.name, 'economy.secondRefineryMinHarvesters') && (s.credits >= sp(game, player.name, 'economy.secondRefineryCredits') || core >= sp(game, player.name, 'economy.secondRefineryCoreArmor'))) ||
                (s.harvesters === 1 && factories > 0 && core >= 1 && s.credits >= rules.cost + sp(game, player.name, 'economy.secondRefineryCostMargin') &&
                    (rules.freeUnit === "HARV" || rules.freeUnit === "CMIN"));
            return (committed || (factories > 0 && canExpand) ||
                (!factories && (s.own.JUMPJET ?? 0) >= 2 && getOpeningAirBudget(game, player) === 2)) ? sp(game, player.name, 'economy.firstRefineryPriority') : 0;
        }
        return refineries < sp(game, player.name, 'economy.maxRefineries') && s.harvesters >= refineries * sp(game, player.name, 'economy.harvestersPerRefinery') ? sp(game, player.name, 'economy.extraRefineryPriority') : 0;
    }
    if (rules.name === "GAPILE" || rules.name === "NAHAND") return count ? 0 : sp(game, player.name, 'economy.barracksPriority');
    if ((rules.name === "GAAIRC" || rules.name === "AMRADR") && refineries && !count && !factories) {
        const allied = ["Americans", "Alliance", "French", "Germans", "British"].includes(s.country);
        // Nearby public starts need a funded ground production chain first.
        // Keep an already started radar, including after losing a factory.
        const groundFirst = allied && getOpeningAirBudget(game, player) > 2;
        return committed || !groundFirst ? sp(game, player.name, 'economy.openingAlliedRadarPriority') : 0;
    }
    const armor = (s.own.MTNK ?? 0) + (s.own.HTNK ?? 0) + (s.own.MGTK ?? 0) + (s.own.APOC ?? 0) + (s.own.SREF ?? 0);
    if (rules.name === "NARADR") {
        if (s.country === "Russians" && (refineries < sp(game, player.name, 'economy.russianRadarMinRefineries') || armor < sp(game, player.name, 'economy.russianRadarMinArmor') || s.credits < sp(game, player.name, 'economy.russianRadarMinCredits'))) return 0;
        if (!count && s.harvesters >= sp(game, player.name, 'economy.radarMinHarvesters') && armor >= sp(game, player.name, 'economy.radarMinArmor')) return sp(game, player.name, 'economy.radarPriority');
    }
    if (rules.name === "NATECH" && !count && s.harvesters >= sp(game, player.name, 'economy.techMinHarvesters') && armor >= sp(game, player.name, 'economy.techMinArmor')) return sp(game, player.name, 'economy.techPriority');
    if (rules.name === "GATECH" && !count && s.harvesters >= sp(game, player.name, 'economy.techMinHarvesters') && armor >= sp(game, player.name, 'economy.techMinArmor')) return sp(game, player.name, 'economy.techPriority');
    if (rules.name === "GADEPT" || rules.name === "NADEPT") return s.credits >= sp(game, player.name, 'economy.depotMinCredits') && armor >= sp(game, player.name, 'economy.depotMinArmor') ? 1 : 0;
    if (["GAAIRC", "AMRADR", "NARADR"].includes(rules.name) &&
        (!factories || s.harvesters < sp(game, player.name, 'economy.radarIncomeFloor') || (s.harvesters < sp(game, player.name, 'economy.radarMinHarvesters') && armor < sp(game, player.name, 'economy.radarMinArmor')))) return 0;
    if (rules.name === "GAPILL" || rules.name === "NALASR") {
        if (count >= sp(game, player.name, 'economy.defenseMaxCount') || s.credits < sp(game, player.name, 'economy.defenseMinCredits')) return 0;
        const currentTick = game.getCurrentTick();
        let playerCooldowns = lastDefenseBuiltTick.get(game);
        if (!playerCooldowns) {
            playerCooldowns = new Map();
            lastDefenseBuiltTick.set(game, playerCooldowns);
        }
        const lastTick = playerCooldowns.get(player.name) ?? -Infinity;
        if (currentTick < lastTick) playerCooldowns.set(player.name, -Infinity); // game reset
        if (currentTick - (playerCooldowns.get(player.name) ?? -Infinity) < sp(game, player.name, 'economy.defenseCooldownTicks')) return 0;

        const anchors = game.getVisibleUnits(player.name, "self", r =>
            r.constructionYard || r.refinery || r.weaponsFactory)
            .map(id => (game.getUnitData?.(id) ?? game.getGameObjectData?.(id)) as UnitData).filter((u): u is UnitData => !!u);
        const start = player.startLocation;
        const intruders = game.getVisibleUnits(player.name, "enemy", option => option.isSelectableCombatant && !option.harvester)
            .map(id => (game.getUnitData?.(id) ?? game.getGameObjectData?.(id)) as UnitData).filter(unit => unit && (
                (unit.tile.rx - start.x) ** 2 + (unit.tile.ry - start.y) ** 2 <= sp(game, player.name, 'economy.defenseStartRadius') ** 2 ||
                anchors.some(a => (unit.tile.rx - a.tile.rx) ** 2 + (unit.tile.ry - a.tile.ry) ** 2 <= sp(game, player.name, 'economy.defenseAnchorRadius') ** 2)
            ));
        // Only build defensively when enemy combatants are actively invading the base!
        const hasVehicleIntruder = intruders.some(u => (u.type as any) === ObjectType.Vehicle);
        if (intruders.length >= sp(game, player.name, 'economy.defenseInfantryIntruders') || (intruders.length >= 1 && hasVehicleIntruder)) {
            if (committed) playerCooldowns.set(player.name, currentTick);
            return sp(game, player.name, 'economy.defensePriority');
        }
        return 0;
    }
    if (rules.name === "TESLA" || rules.name === "ATESLA") {
        // High-tech static defenses cost $1500 and drain huge power.
        // Never build unless base has massive surplus economy and active vehicle assault.
        const powerMargin = (player.power?.total ?? 0) - (player.power?.drain ?? 0);
        if (powerMargin < sp(game, player.name, 'economy.teslaMinPowerMargin') || player.power?.isLowPower || count >= sp(game, player.name, 'economy.teslaMaxCount')) return 0;
        const start = player.startLocation;
        const intruders = game.getVisibleUnits(player.name, "enemy", option => option.isSelectableCombatant && !option.harvester)
            .map(id => (game.getUnitData?.(id) ?? game.getGameObjectData?.(id)) as UnitData).filter(unit => unit &&
                (unit.tile.rx - start.x) ** 2 + (unit.tile.ry - start.y) ** 2 <= sp(game, player.name, 'economy.teslaRadius') ** 2);
        const hasVehicleIntruder = intruders.some(u => (u.type as any) === ObjectType.Vehicle);
        if (hasVehicleIntruder && s.credits >= sp(game, player.name, 'economy.teslaMinCredits') && armor >= sp(game, player.name, 'economy.teslaMinArmor')) {
            return sp(game, player.name, 'economy.teslaPriority');
        }
        return 0;
    }
    if (rules.name === "GAWEAP" || rules.name === "NAWEAP") {
        if (!factories) {
            if (!refineries) return committed ? (rules.name === "NAWEAP" ? sp(game, player.name, 'economy.firstFactoryPrioritySoviet') : sp(game, player.name, 'economy.firstFactoryPriorityAllied')) : 0;
            if (sp(game, player.name, 'assault.tankOpening') === 1 && s.harvesters > 0 && game.getCurrentTick() < sp(game, player.name, 'assault.tankOpeningUntil'))
                return sp(game, player.name, 'assault.tankOpeningFactoryPriority');
            return rules.name === "NAWEAP" ? sp(game, player.name, 'economy.firstFactoryPrioritySoviet') : sp(game, player.name, 'economy.firstFactoryPriorityAllied');
        }
        if (factories === 1) {
            const hasIncomeForDual = (refineries >= sp(game, player.name, 'economy.secondFactoryMinRefineries') && s.harvesters >= sp(game, player.name, 'economy.secondFactoryMinHarvesters') && (s.credits >= sp(game, player.name, 'economy.secondFactoryMinCredits') || armor >= sp(game, player.name, 'economy.secondFactoryMinArmor'))) || s.harvesters >= sp(game, player.name, 'economy.secondFactoryHarvesterOverride');
            return (committed || hasIncomeForDual) ? sp(game, player.name, 'economy.extraFactoryPriority') : 0;
        }
        return factories < sp(game, player.name, 'economy.maxFactories') && s.harvesters >= sp(game, player.name, 'production.extraFactoryHarvesterFloor') + (factories - 1) * sp(game, player.name, 'production.extraFactoryHarvesterFactor') ? sp(game, player.name, 'economy.extraFactoryPriority') : 0;
    }
    return undefined;
}

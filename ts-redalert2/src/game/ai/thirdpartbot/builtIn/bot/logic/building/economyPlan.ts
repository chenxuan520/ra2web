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
        if (!refineries) return 50;
        if (refineries === 1) {
            if (!committed) {
                const intruders = game.getVisibleUnits(player.name, "enemy", option => option.isSelectableCombatant)
                    .map(id => game.getUnitData(id)).filter(unit => unit &&
                        (unit.tile.rx - player.startLocation.x) ** 2 + (unit.tile.ry - player.startLocation.y) ** 2 <= 25 ** 2);
                if (intruders.length >= 3 && s.credits < 3000) return 0;
            }
            const core = (s.own.MTNK ?? 0) + (s.own.HTNK ?? 0);
            const canExpand = (s.harvesters >= 2 && (s.credits >= 2000 || core >= 4)) ||
                (s.harvesters === 1 && factories > 0 && core >= 1 && s.credits >= rules.cost + 400 &&
                    (rules.freeUnit === "HARV" || rules.freeUnit === "CMIN"));
            return (committed || (factories > 0 && canExpand) ||
                (!factories && (s.own.JUMPJET ?? 0) >= 2 && getOpeningAirBudget(game, player) === 2)) ? 50 : 0;
        }
        if (refineries >= 2 && !committed) {
            const enemyVehicles = s.enemy.vehicles ?? 0;
            const coreArmor = (s.own.MTNK ?? 0) + (s.own.HTNK ?? 0);
            if (enemyVehicles >= 4 && coreArmor < enemyVehicles + 4 && s.credits < 4500) return 0;
        }
        return refineries < 4 && s.harvesters >= refineries * 2 ? 18 : 0;
    }
    if (rules.name === "GAPILE" || rules.name === "NAHAND") return count ? 0 : 55;
    if ((rules.name === "GAAIRC" || rules.name === "AMRADR") && refineries && !count && !factories) {
        const allied = ["Americans", "Alliance", "French", "Germans", "British"].includes(s.country);
        // Nearby public starts need a funded ground production chain first.
        // Keep an already started radar, including after losing a factory.
        const groundFirst = allied && getOpeningAirBudget(game, player) > 2;
        return committed || !groundFirst ? 45 : 0;
    }
    const armor = (s.own.MTNK ?? 0) + (s.own.HTNK ?? 0) + (s.own.MGTK ?? 0) + (s.own.APOC ?? 0) + (s.own.SREF ?? 0);
    if (rules.name === "NARADR") {
        if (s.country === "Russians" && (refineries < 2 || armor < 6 || s.credits < 2500)) return 0;
        if (!count && s.harvesters >= 3 && armor >= 2) return 24;
    }
    if (rules.name === "NATECH" && !count && s.harvesters >= 3 && armor >= 2) return 30;
    if (rules.name === "GATECH" && !count && s.harvesters >= 3 && armor >= 2) return 30;
    if (rules.name === "GADEPT" || rules.name === "NADEPT") return s.credits >= 6000 && armor >= 8 ? 1 : 0;
    if (["GAAIRC", "AMRADR", "NARADR"].includes(rules.name) &&
        (!factories || s.harvesters < 2 || (s.harvesters < 3 && armor < 2))) return 0;
    if (rules.name === "GAPILL" || rules.name === "NALASR") {
        if (count >= 1 || s.credits < 1000) return 0;
        const currentTick = game.getCurrentTick();
        let playerCooldowns = lastDefenseBuiltTick.get(game);
        if (!playerCooldowns) {
            playerCooldowns = new Map();
            lastDefenseBuiltTick.set(game, playerCooldowns);
        }
        const lastTick = playerCooldowns.get(player.name) ?? -Infinity;
        if (currentTick < lastTick) playerCooldowns.set(player.name, -Infinity); // game reset
        if (currentTick - (playerCooldowns.get(player.name) ?? -Infinity) < 1800) return 0;

        const anchors = game.getVisibleUnits(player.name, "self", r =>
            r.constructionYard || r.refinery || r.weaponsFactory)
            .map(id => (game.getUnitData?.(id) ?? game.getGameObjectData?.(id)) as UnitData).filter((u): u is UnitData => !!u);
        const start = player.startLocation;
        const intruders = game.getVisibleUnits(player.name, "enemy", option => option.isSelectableCombatant && !option.harvester)
            .map(id => (game.getUnitData?.(id) ?? game.getGameObjectData?.(id)) as UnitData).filter(unit => unit && (
                (unit.tile.rx - start.x) ** 2 + (unit.tile.ry - start.y) ** 2 <= 20 ** 2 ||
                anchors.some(a => (unit.tile.rx - a.tile.rx) ** 2 + (unit.tile.ry - a.tile.ry) ** 2 <= 18 ** 2)
            ));
        // Only build defensively when enemy combatants are actively invading the base!
        const hasVehicleIntruder = intruders.some(u => (u.type as any) === ObjectType.Vehicle);
        if (intruders.length >= 2 || (intruders.length >= 1 && hasVehicleIntruder)) {
            if (committed) playerCooldowns.set(player.name, currentTick);
            return 70;
        }
        return 0;
    }
    if (rules.name === "TESLA" || rules.name === "ATESLA") {
        // High-tech static defenses cost $1500 and drain huge power.
        // Never build unless base has massive surplus economy and active vehicle assault.
        const powerMargin = (player.power?.total ?? 0) - (player.power?.drain ?? 0);
        if (powerMargin < 75 || player.power?.isLowPower || count >= 1) return 0;
        const start = player.startLocation;
        const intruders = game.getVisibleUnits(player.name, "enemy", option => option.isSelectableCombatant && !option.harvester)
            .map(id => (game.getUnitData?.(id) ?? game.getGameObjectData?.(id)) as UnitData).filter(unit => unit &&
                (unit.tile.rx - start.x) ** 2 + (unit.tile.ry - start.y) ** 2 <= 18 ** 2);
        const hasVehicleIntruder = intruders.some(u => (u.type as any) === ObjectType.Vehicle);
        if (hasVehicleIntruder && s.credits >= 3500 && armor >= 8) {
            return 60;
        }
        return 0;
    }
    if (rules.name === "GAWEAP" || rules.name === "NAWEAP") {
        if (!factories) {
            if (!refineries) return committed ? (rules.name === "NAWEAP" ? 60 : 30) : 0;
            return rules.name === "NAWEAP" ? 60 : 30;
        }
        if (factories === 1) {
            const hasIncomeForDual = (refineries >= 2 && s.harvesters >= 3 && (s.credits >= 800 || armor >= 5)) || s.harvesters >= 4;
            return (committed || hasIncomeForDual) ? 35 : 0;
        }
        return factories < 3 && s.harvesters >= 4 + (factories - 1) * 2 ? 35 : 0;
    }
    return undefined;
}

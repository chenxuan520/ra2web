import { GameApi, PlayerData, TechnoRules } from "../../../game-api";
import { readStrategicSituation } from "../../strategy/nationalComposition";

/** Fund income before duplicating production capacity that the miners cannot supply. */
export function getEconomyBuildingPriority(game: GameApi, player: PlayerData, rules: TechnoRules, committed: boolean): number | undefined {
    const s = readStrategicSituation(game, player);
    const refineries = (s.own.GAREFN ?? 0) + (s.own.NAREFN ?? 0);
    const factories = (s.own.GAWEAP ?? 0) + (s.own.NAWEAP ?? 0);
    const count = s.own[rules.name] ?? 0;
    if (rules.refinery) {
        if (!refineries) return 50;
        if (refineries === 1) return factories > 0 && s.harvesters >= 2 ? 50 : 0;
        return refineries < 4 && s.harvesters >= refineries * 2 && (committed || s.credits >= 1200) ? 18 : 0;
    }
    if (rules.name === "GAPILE" || rules.name === "NAHAND") return count ? 0 : 55;
    if (["GAAIRC", "AMRADR", "NARADR"].includes(rules.name) &&
        (!factories || (s.harvesters < 3 && (s.own.MTNK ?? 0) + (s.own.HTNK ?? 0) < 2))) return 0;
    if (rules.name === "GAPILL" || rules.name === "NALASR") {
        const intruders = game.getVisibleUnits(player.name, "enemy", option => option.isSelectableCombatant)
            .map(id => game.getUnitData(id)).filter(unit => unit &&
                (unit.tile.rx - player.startLocation.x) ** 2 + (unit.tile.ry - player.startLocation.y) ** 2 <= 25 ** 2);
        return intruders.length >= 5 && count < Math.min(3, Math.ceil(intruders.length / 10)) ? 24 : 0;
    }
    if (rules.name === "GAWEAP" || rules.name === "NAWEAP") {
        if (!factories) return refineries ? 30 : 0;
        return factories < 3 && s.harvesters >= 4 + (factories - 1) * 2 && (committed || s.credits >= rules.cost + 1000) ? 12 : 0;
    }
    return undefined;
}

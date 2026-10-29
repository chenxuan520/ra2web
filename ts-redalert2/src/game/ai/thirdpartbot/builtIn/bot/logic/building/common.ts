import { GameApi, PlayerData, TechnoRules } from "../../../game-api";
import { getPointTowardsOtherPoint } from "../map/map";
import { getDefaultPlacementLocation } from "./buildingRules";
import { getKnownEnemyDirections } from "../common/knownEnemyDirections";

export const getStaticDefencePlacement = (game: GameApi, playerData: PlayerData, technoRules: TechnoRules) => {
    const candidates = getKnownEnemyDirections(game, playerData).map(direction =>
        getPointTowardsOtherPoint(game, playerData.startLocation, direction, 4, 16, 1.5));
    const selectedLocation = candidates.length
        ? candidates[Math.floor(game.generateRandom() * candidates.length)] : playerData.startLocation;
    return getDefaultPlacementLocation(game, playerData, selectedLocation, technoRules, false, 2);
};

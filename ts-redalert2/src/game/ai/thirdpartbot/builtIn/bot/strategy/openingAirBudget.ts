import { GameApi, PlayerData } from "../../game-api";

/** Use public map starts, not the actual position of an unscouted opponent. */
export function getOpeningAirBudget(game: GameApi, player: PlayerData): number {
    const possibleOpponents = (game.mapApi.getStartingLocations?.() ?? []).filter(point => point.distanceTo(player.startLocation) > 1);
    const nearestPossibleStart = Math.min(...possibleOpponents.map(point => point.distanceTo(player.startLocation)));
    return possibleOpponents.length && nearestPossibleStart > 90 ? 2 : 8;
}

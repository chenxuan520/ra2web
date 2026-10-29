import { isObservedLivingUnit } from "./observedUnit";
import { GameApi, ObjectType, PlayerData, Vector2 } from "../../../game-api";

/**
 * Observed hostile buildings, or unexplored public start points when no base is
 * known. An enemy player's actual start assignment is never scouting evidence.
 * The ordered result is stable across player/unit/start-point enumeration order.
 */
export function getKnownEnemyDirections(game: GameApi, player: PlayerData): Vector2[] {
    const hostilePlayers = new Set(game.getPlayers().filter(name => name !== player.name &&
        !game.areAlliedPlayers(player.name, name) && game.getPlayerData(name).isCombatant));
    if (!hostilePlayers.size) return [];

    const knownBuildings = game.getVisibleUnits(player.name, "enemy", rules => rules.type === ObjectType.Building)
        .map(id => game.getUnitData(id))
        .filter(unit => isObservedLivingUnit(unit) && hostilePlayers.has(unit.owner))
        .map(unit => new Vector2(unit!.tile.rx, unit!.tile.ry));
    const candidates = knownBuildings.length ? knownBuildings : game.mapApi.getStartingLocations()
        .filter(point => !point.equals(player.startLocation))
        .filter(point => {
            const tile = game.mapApi.getTile(point.x, point.y);
            return !!tile && !game.mapApi.isVisibleTile(tile, player.name);
        });
    const unique = new Map<string, Vector2>();
    for (const point of candidates) unique.set(`${point.x},${point.y}`, point);
    return [...unique.values()].sort((a, b) => a.distanceToSquared(player.startLocation) - b.distanceToSquared(player.startLocation) ||
        a.x - b.x || a.y - b.y);
}

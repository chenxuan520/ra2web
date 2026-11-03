import { GameApi, PlayerData, TechnoRules, UnitData, Vector2 } from "../../../game-api";
import { getPointTowardsOtherPoint } from "../map/map";
import { getDefaultPlacementLocation } from "./buildingRules";
import { getKnownEnemyDirections } from "../common/knownEnemyDirections";

export const getStaticDefencePlacement = (game: GameApi, playerData: PlayerData, technoRules: TechnoRules) => {
    // If our base is actively threatened by intruders, place reactive defense facing the threat!
    const anchors = game.getVisibleUnits(playerData.name, "self", r =>
        r.constructionYard || r.refinery || r.weaponsFactory || (r.power ?? 0) > 0)
        .map(id => (game.getUnitData?.(id) ?? game.getGameObjectData?.(id)) as UnitData).filter((u): u is UnitData => !!u);
    const start = playerData.startLocation;
    const intruders = game.getVisibleUnits(playerData.name, "enemy", option => option.isSelectableCombatant)
        .map(id => (game.getUnitData?.(id) ?? game.getGameObjectData?.(id)) as UnitData).filter((unit): unit is UnitData => !!unit && (
            (unit.tile.rx - start.x) ** 2 + (unit.tile.ry - start.y) ** 2 <= 28 ** 2 ||
            anchors.some(a => (unit.tile.rx - a.tile.rx) ** 2 + (unit.tile.ry - a.tile.ry) ** 2 <= 24 ** 2)
        ));

    if (intruders.length > 0 && anchors.length > 0) {
        // Find closest pair of anchor and intruder
        let bestPair: { anchor: UnitData; intruder: UnitData; dist: number } | undefined;
        for (const anchor of anchors) {
            for (const intruder of intruders) {
                const dist = (anchor.tile.rx - intruder.tile.rx) ** 2 + (anchor.tile.ry - intruder.tile.ry) ** 2;
                if (!bestPair || dist < bestPair.dist) {
                    bestPair = { anchor, intruder, dist };
                }
            }
        }
        if (bestPair) {
            const reactivePoint = getPointTowardsOtherPoint(game,
                new Vector2(bestPair.anchor.tile.rx, bestPair.anchor.tile.ry),
                new Vector2(bestPair.intruder.tile.rx, bestPair.intruder.tile.ry), 2, 8, 1.0);
            const placement = getDefaultPlacementLocation(game, playerData, reactivePoint, technoRules, false, 2);
            if (placement) return placement;
        }
    }

    const candidates = getKnownEnemyDirections(game, playerData).map(direction =>
        getPointTowardsOtherPoint(game, playerData.startLocation, direction, 4, 16, 1.5));
    const selectedLocation = candidates.length
        ? candidates[Math.floor(game.generateRandom() * candidates.length)] : playerData.startLocation;
    return getDefaultPlacementLocation(game, playerData, selectedLocation, technoRules, false, 2);
};

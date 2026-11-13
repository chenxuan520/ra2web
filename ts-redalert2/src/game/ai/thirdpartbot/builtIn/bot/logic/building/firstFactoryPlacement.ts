import { GameApi, ObjectType, PlayerData, SpeedType, TechnoRules, Tile, ZoneType } from "../../../game-api";
import { getAdjacencyTiles } from "./buildingRules";
import { findVisiblePatches, patchDistance, ScoredPatch, scorePatch } from "../common/orePatches";

/** FactoryTrait drives vehicles along the foundation's middle row toward +rx. */
export function hasClearWarFactoryExit(game: GameApi, player: PlayerData, origin: Tile, width: number, height: number): boolean {
    const middleY = origin.ry + Math.floor(height / 2);
    const clearTile = (rx: number, ry: number) => {
        const tile = game.mapApi.getTile(rx, ry);
        if (!tile || tile.z !== origin.z || !game.mapApi.isVisibleTile(tile, player.name) || game.mapApi.hasBridgeOnTile(tile)) return false;
        // Track covers tanks/miners; Wheel also protects the supporting IFV/Flak Track exit.
        if (![SpeedType.Track, SpeedType.Wheel].every(speed => game.mapApi.isPassableTile(tile, speed, false, false))) return false;
        return !game.mapApi.getObjectsOnTile(tile).some(id => {
            const object = game.getGameObjectData(id);
            if (!object) return false;
            if (object.rules.type === ObjectType.Building) return true;
            return (object.rules.type === ObjectType.Vehicle || object.rules.type === ObjectType.Infantry) &&
                game.getUnitData(id)?.zone !== ZoneType.Air;
        });
    };
    // Include the spawn/internal ramp, the fixed external rally tile, and a clear tile beyond it.
    for (let x = origin.rx + Math.floor(width / 2); x <= origin.rx + width + 1; x++) {
        if (!clearTile(x, middleY)) return false;
    }
    const outsideX = origin.rx + width + 1;
    return clearTile(outsideX + 1, middleY) || clearTile(outsideX, middleY - 1) || clearTile(outsideX, middleY + 1);
}

/** Last resort for the first land factory only; all engine legality checks still apply. */
export function getCompactFirstFactoryPlacement(game: GameApi, player: PlayerData, rules: TechnoRules): Tile | undefined {
    if (rules.name !== "GAWEAP" && rules.name !== "NAWEAP") return undefined;
    if (game.getVisibleUnits(player.name, "self", owned => owned.name === "GAWEAP" || owned.name === "NAWEAP").length > 0) return undefined;
    const conyard = game.getVisibleUnits(player.name, "self", owned => owned.constructionYard)
        .map(id => game.getGameObjectData(id)?.tile).find((tile): tile is Tile => !!tile);
    const foundation = (game.getBuildingPlacementData(rules.name) as any)?.foundation;
    if (!conyard || !foundation?.width || !foundation?.height) return undefined;
    const candidates = getAdjacencyTiles(game, player, rules, false, 1)
        .sort((a, b) => (a.rx - conyard.rx) ** 2 + (a.ry - conyard.ry) ** 2 -
            ((b.rx - conyard.rx) ** 2 + (b.ry - conyard.ry) ** 2) || a.rx - b.rx || a.ry - b.ry);
    return candidates.find(tile => game.canPlaceBuilding(player.name, rules.name, tile) &&
        hasClearWarFactoryExit(game, player, tile, foundation.width, foundation.height));
}

/** Place the required first factory as an adjacency step toward a known unserved field. */
export function getEconomicFirstFactoryPlacement(game: GameApi, player: PlayerData, rules: TechnoRules): Tile | undefined {
    if (!["GAWEAP", "NAWEAP"].includes(rules.name) || game.getVisibleUnits(player.name, "self",
        owned => owned.name === "GAWEAP" || owned.name === "NAWEAP").length > 0) return undefined;
    const anchors = game.getVisibleUnits(player.name, "self", owned => owned.type === ObjectType.Building && owned.baseNormal && !owned.wall)
        .map(id => game.getGameObjectData(id)?.tile).filter((tile): tile is Tile => !!tile);
    const foundation = (game.getBuildingPlacementData(rules.name) as any)?.foundation;
    if (!anchors.length || !foundation?.width || !foundation?.height) return undefined;
    const fields = findVisiblePatches(game, player.name).map(patch => scorePatch(game, player, patch))
        .filter((entry): entry is ScoredPatch => !!entry)
        .sort((a, b) => b.score - a.score || a.g - b.g || (a.patch.id < b.patch.id ? -1 : a.patch.id > b.patch.id ? 1 : 0));
    for (const entry of fields) {
        const g = Math.min(...anchors.map(tile => patchDistance(tile, entry.patch)));
        if (g > 40) continue;
        for (const spacing of [2, 1, 0]) {
            const candidates = getAdjacencyTiles(game, player, rules, false, spacing)
                .sort((a, b) => patchDistance(a, entry.patch) - patchDistance(b, entry.patch) || a.rx - b.rx || a.ry - b.ry);
            const location = candidates.find(tile => patchDistance(tile, entry.patch) < g &&
                game.canPlaceBuilding(player.name, rules.name, tile) && hasClearWarFactoryExit(game, player, tile, foundation.width, foundation.height));
            if (location) return location;
        }
    }
    return undefined;
}

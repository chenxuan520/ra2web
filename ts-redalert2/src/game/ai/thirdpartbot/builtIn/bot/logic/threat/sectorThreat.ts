import { Box2, GameApi, MapApi, PlayerData, Vector2 } from "../../../game-api";
import { Sector, SectorAndDist } from "../map/sectorUtils";

export function observeSectorUnits(gameApi: GameApi, playerName: string) {
    return {
        ownIds: new Set(gameApi.getVisibleUnits(playerName, "self")),
        enemyIds: new Set(gameApi.getVisibleUnits(playerName, "enemy")),
    };
}

export function calculateSectorThreat(startX: number, startY: number, sectorSize: number, gameApi: GameApi,
    playerData: PlayerData, observed = observeSectorUnits(gameApi, playerData.name)) {
    const unitsInArea = gameApi.getUnitsInArea(new Box2(new Vector2(startX, startY), new Vector2(startX + sectorSize, startY + sectorSize)));
    // The spatial API includes hidden objects. Intersect before reading their
    // data so unseen enemies cannot enter the sector or diffuse threat caches.
    const { ownIds, enemyIds } = observed;

    let threat = 0;
    for (const unitId of unitsInArea) {
        if (!ownIds.has(unitId) && !enemyIds.has(unitId)) {
            continue;
        }
        const unit = gameApi.getGameObjectData(unitId);
        if (!unit || !unit.owner) {
            continue;
        }
        if (ownIds.has(unitId)) {
            threat -= unit.maxHitPoints ?? 1;
            continue;
        }
        threat += unit.maxHitPoints ?? 1;
    }
    return threat;
}

export function calculateDiffuseSectorThreat(sector: Sector, neighbours: SectorAndDist[]) {
    // the objective is for a cell's threat to slowly spread (diffuse) into its neighbouring cells.
    const connectedSectorIds = new Set(sector.connectedSectorIds);
    const totalNeighbourThreat = (sector.threatLevel ?? 0) + neighbours.reduce((acc, cV) => acc + (cV.sector.threatLevel ?? 0), 0);
    // Based on the max of the closest _connected_ sectors
    const maxOfNeighboursThreat = neighbours
        .filter((n) => connectedSectorIds.has(n.sector.id))
        .reduce((pV, cV) => Math.max(pV, (cV.sector.diffuseThreatLevel ?? 0) * cV.dist), 0);
    return Math.max(totalNeighbourThreat, maxOfNeighboursThreat * 0.95);
}

export function calculateMoney(startX: number, startY: number, size: number, mapApi: MapApi, playerName: string): number | null {
    const visibleTiles = mapApi
        .getTilesInRect({ x: startX, y: startY, width: size, height: size})
        .filter((tile) => mapApi.isVisibleTile(tile, playerName));
    // No observation is unknown, not an observed depleted sector. For partly
    // explored sectors this is the known resource amount, not a hidden total.
    if (visibleTiles.length === 0) return null;
    const values = mapApi.getResourceCreditValues();
    return visibleTiles
        .map((t) => mapApi.getTileResourceData(t)).map((t) => t ? t.gems * values.gems + t.ore * values.ore : 0)
        .reduce((pV, cV) => pV + cV, 0);
}

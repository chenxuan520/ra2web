import { Box2, GameApi, GameMath, ObjectType, PlayerData, TechnoRules, Tile, Vector2 } from "../../../game-api";
import { GlobalThreat } from "../threat/threat";
import { BasicBuilding } from "./basicBuilding";
import { getDefaultPlacementLocation } from "./buildingRules";
import { getCachedTechnoRules } from "../common/rulesCache";
import { findVisiblePatches, OrePatch, PatchPoint, ScoredPatch, patchDistance, scorePatch } from "../common/orePatches";
import { minBy } from "../common/utils";

const NO_REFINERY_DISTANCE = 10;
const REFINERY_HARD_LIMIT = 6;

export interface RefineryPlan {
    patch: OrePatch | undefined;
    location: PatchPoint | undefined;
    reachable: boolean;
    unreachable: (ScoredPatch & { location: PatchPoint | undefined; distance: number | undefined })[];
}

/** Scored visible fields only; the first-refinery legacy fallback remains in getPlacementLocation. */
export function planRefinery(game: GameApi, playerData: PlayerData, technoRules: TechnoRules): RefineryPlan {
    const scored = findVisiblePatches(game, playerData.name)
        .map(patch => scorePatch(game, playerData, patch)).filter((patch): patch is ScoredPatch => !!patch)
        .sort((a, b) => b.score - a.score || a.g - b.g || (a.patch.id < b.patch.id ? -1 : a.patch.id > b.patch.id ? 1 : 0));
    const buildings = game.getVisibleUnits(playerData.name, "self", rules => rules.type === ObjectType.Building && !rules.wall)
        .map(id => game.getGameObjectData(id)?.tile).filter((tile): tile is Tile => !!tile);
    const unreachable: RefineryPlan["unreachable"] = [];
    for (const entry of scored) {
        const building = minBy(buildings, tile => patchDistance(tile, entry.patch));
        const target = building && minBy(entry.patch.tiles, tile => Math.hypot(tile.rx - building.rx, tile.ry - building.ry));
        const location = target ? getDefaultPlacementLocation(game, playerData, new Vector2(target.rx, target.ry), technoRules, false, 2)
            ?? getDefaultPlacementLocation(game, playerData, new Vector2(target.rx, target.ry), technoRules, false, 1)
            ?? getDefaultPlacementLocation(game, playerData, new Vector2(target.rx, target.ry), technoRules, false, 0) : undefined;
        const distance = location ? patchDistance(location, entry.patch) : undefined;
        if (distance !== undefined && distance <= 9) return { patch: entry.patch, location, reachable: true, unreachable };
        unreachable.push({ ...entry, location, distance });
    }
    return { patch: scored[0]?.patch, location: undefined, reachable: false, unreachable };
}

export class ResourceCollectionBuilding extends BasicBuilding {
    constructor(basePriority: number, maxNeeded: number, onlyBuildWhenFloatingCreditsAmount?: number) {
        super(basePriority, maxNeeded, onlyBuildWhenFloatingCreditsAmount);
    }

    getPlacementLocation(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        difficulty?: "normal" | "brutal",
    ): { rx: number; ry: number } | undefined {
        if (difficulty === "brutal") {
            const plan = planRefinery(game, playerData, technoRules);
            if (plan.reachable) return plan.location;
            if (game.getVisibleUnits(playerData.name, "self", rules => rules.refinery).length > 0) return undefined;
        }
        // Prefer spawning close to ore.
        const conyardVectors = game
            .getVisibleUnits(playerData.name, "self", (r) => r.constructionYard)
            .map((r) => game.getGameObjectData(r)?.tile)
            .filter((t): t is Tile => !!t)
            .map((t) => new Vector2(t.rx, t.ry));

        if (conyardVectors.length === 0) {
            return undefined;
        }

        var closeOre: Tile | undefined;
        var closeOreDist: number | undefined;
        let selectedLocation: Vector2 = conyardVectors[0];

        const existingRefineries = game
            .getVisibleUnits(playerData.name, "self", (r) => r.refinery)
            .map((r) => game.getGameObjectData(r)?.tile)
            .filter((t): t is Tile => !!t)
            .map((t) => new Vector2(t.rx, t.ry));

        const allTileResourceData = game.mapApi.getAllTilesResourceData()
            .filter(resource => game.mapApi.isVisibleTile(resource.tile, playerData.name));

        const unservicedActive = allTileResourceData.filter(res =>
            (res.ore > 0 || res.gems > 0) &&
            !existingRefineries.some(ref => ref.distanceTo(new Vector2(res.tile.rx, res.tile.ry)) <= 8)
        );

        const candidates = unservicedActive.length > 0
            ? unservicedActive
            : allTileResourceData.filter(res => res.spawnsOre || res.ore > 0 || res.gems > 0);

        for (const conyard of conyardVectors) {
            for (let i = 0; i < candidates.length; ++i) {
                let tileResourceData = candidates[i];
                let dist = GameMath.sqrt(
                    (conyard.x - tileResourceData.tile.rx) ** 2 + (conyard.y - tileResourceData.tile.ry) ** 2,
                );
                if (closeOreDist == undefined || dist < closeOreDist) {
                    closeOreDist = dist;
                    closeOre = tileResourceData.tile;
                }
            }
        }
        if (closeOre) {
            selectedLocation = new Vector2(closeOre.rx, closeOre.ry);
        }
        return getDefaultPlacementLocation(game, playerData, selectedLocation, technoRules, false, 2)
            ?? getDefaultPlacementLocation(game, playerData, selectedLocation, technoRules, false, 1)
            ?? getDefaultPlacementLocation(game, playerData, selectedLocation, technoRules, false, 0);
    }

    // Don't build/start selling these if we don't have any harvesters
    getMaxCount(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
    ): number | null {
        const harvesters = game.getVisibleUnits(playerData.name, "self", (r) => r.harvester).length;
        // if there is no refinery within distance of a conyard, that conyard wants an expansion
        const conyardBoxes = game
            .getVisibleUnits(playerData.name, "self", (r) => r.constructionYard)
            .map((r) => game.getGameObjectData(r)?.tile)
            .filter((t): t is Tile => !!t)
            .map((t) => new Vector2(t.rx, t.ry))
            .map((v) => new Box2(v.clone().subScalar(NO_REFINERY_DISTANCE), v.clone().addScalar(NO_REFINERY_DISTANCE)));
        const conyardsWithRefineries = conyardBoxes
            .map((b) => game.getUnitsInArea(b))
            .filter((unitIds) => unitIds.some((unitId) =>
                game.getUnitData(unitId)?.owner === playerData.name && getCachedTechnoRules(game, unitId)?.refinery));
        const conyardsWithoutRefineries = conyardBoxes.length - conyardsWithRefineries.length;

        return Math.max(1, Math.min(REFINERY_HARD_LIMIT, Math.ceil(harvesters / 2) + 1 + conyardsWithoutRefineries));
    }
}

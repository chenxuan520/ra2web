import { Box2, GameApi, GameMath, ObjectType, PlayerData, TechnoRules, Tile, Vector2 } from "../../../game-api";
import { GlobalThreat } from "../threat/threat";
import { BasicBuilding } from "./basicBuilding";
import { getDefaultPlacementLocation } from "./buildingRules";
import { getCachedTechnoRules } from "../common/rulesCache";
import { findVisiblePatches, OrePatch, PatchPoint, ScoredPatch, patchDistance, scorePatch } from "../common/orePatches";
import { minBy } from "../common/utils";

const NO_REFINERY_DISTANCE = 10;
const REFINERY_HARD_LIMIT = 6;
interface RefineryFieldHistory { tick: number; patches?: OrePatch[]; fields: Map<number, Set<string>> }
const refineryFieldHistory = new WeakMap<GameApi, Map<string, RefineryFieldHistory>>();

export interface RefineryPlan {
    patch: OrePatch | undefined;
    location: PatchPoint | undefined;
    reachable: boolean;
    unreachable: (ScoredPatch & { location: PatchPoint | undefined; distance: number | undefined })[];
}

/** Current apparent enemy buildings and public death-weapon rules only. */
export function getRefineryBlastSafety(game: GameApi, playerName: string, technoRules: TechnoRules): (tile: PatchPoint) => boolean {
    const hazards = game.getVisibleUnits(playerName, "enemy", rules => rules.type === ObjectType.Building && !!rules.deathWeapon)
        .flatMap(id => {
            const unit = game.getUnitData(id);
            if (!unit?.foundation || !unit.rules.deathWeapon) return [];
            const weapon = game.rulesApi.getWeapon(unit.rules.deathWeapon);
            const radius = weapon?.damage > 0 ? game.rulesApi.getWarhead(weapon.warhead).cellSpread : 0;
            return radius > 0 ? [{ tile: unit.tile, foundation: unit.foundation, radius }] : [];
        });
    const size = hazards.length ? game.getBuildingPlacementData(technoRules.name).foundation : undefined;
    return tile => hazards.every(hazard => Math.hypot(
        Math.max(tile.rx - (hazard.tile.rx + hazard.foundation.width - 1),
            hazard.tile.rx - (tile.rx + size!.width - 1), 0),
        Math.max(tile.ry - (hazard.tile.ry + hazard.foundation.height - 1),
            hazard.tile.ry - (tile.ry + size!.height - 1), 0)) > hazard.radius);
}

/** Scored visible fields only; the first-refinery legacy fallback remains in getPlacementLocation. */
export function planRefinery(game: GameApi, playerData: PlayerData, technoRules: TechnoRules): RefineryPlan {
    const patches = findVisiblePatches(game, playerData.name), tick = game.getCurrentTick();
    const refineries = game.getVisibleUnits(playerData.name, "self", rules => rules.refinery).flatMap(id => {
        const refinery = game.getGameObjectData(id);
        return refinery ? [refinery] : [];
    });
    let players = refineryFieldHistory.get(game);
    if (!players) { players = new Map(); refineryFieldHistory.set(game, players); }
    let history = players.get(playerData.name);
    if (!history || tick < history.tick) {
        history = { tick, fields: new Map() };
        players.set(playerData.name, history);
    }
    const fieldHistory = history, tileKey = (tile: PatchPoint) => `${tile.rx}_${tile.ry}`;
    if (fieldHistory.patches !== patches || fieldHistory.fields.size !== refineries.length || refineries.some(refinery => !fieldHistory.fields.has(refinery.id))) {
        fieldHistory.fields = new Map(refineries.map(refinery => {
            const tiles = fieldHistory.fields.get(refinery.id) ?? new Set<string>();
            for (const patch of patches) if (patchDistance(refinery.tile, patch) <= 9) {
                for (const tile of patch.tiles) tiles.add(tileKey(tile));
            }
            return [refinery.id, tiles];
        }));
        fieldHistory.patches = patches;
    }
    fieldHistory.tick = tick;
    // Prioritize a new field when mining erases the edge of an already served known field; keep the original fallback.
    const previouslyServiced = (patch: OrePatch) => [...fieldHistory.fields.values()].some(tiles => patch.tiles.some(tile => tiles.has(tileKey(tile))));
    const scored = patches.map(patch => scorePatch(game, playerData, patch)).filter((patch): patch is ScoredPatch => !!patch)
        .sort((a, b) => Number(previouslyServiced(a.patch)) - Number(previouslyServiced(b.patch)) ||
            b.score - a.score || a.g - b.g || (a.patch.id < b.patch.id ? -1 : a.patch.id > b.patch.id ? 1 : 0));
    const buildings = game.getVisibleUnits(playerData.name, "self", rules => rules.type === ObjectType.Building && !rules.wall)
        .map(id => game.getGameObjectData(id)?.tile).filter((tile): tile is Tile => !!tile);
    const canUseTile = getRefineryBlastSafety(game, playerData.name, technoRules);
    const unreachable: RefineryPlan["unreachable"] = [];
    for (const entry of scored) {
        const building = minBy(buildings, tile => patchDistance(tile, entry.patch));
        const target = building && minBy(entry.patch.tiles, tile => Math.hypot(tile.rx - building.rx, tile.ry - building.ry));
        let location: PatchPoint | undefined, distance: number | undefined;
        if (target) {
            for (const spacing of [2, 1, 0]) {
                const candidate = getDefaultPlacementLocation(game, playerData, new Vector2(target.rx, target.ry), technoRules, false, spacing, canUseTile);
                const candidateDistance = candidate ? patchDistance(candidate, entry.patch) : undefined;
                if (candidateDistance !== undefined && candidateDistance <= 9) return { patch: entry.patch, location: candidate, reachable: true, unreachable };
                location ??= candidate;
                distance ??= candidateDistance;
            }
        }
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

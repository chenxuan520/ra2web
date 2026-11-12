import { GameApi, ObjectType, PlayerData, Tile } from "../../../game-api";

export type PatchPoint = { rx: number; ry: number };
export interface OrePatch {
    id: string;
    tiles: PatchPoint[];
    center: PatchPoint;
    value: number;
    gemValue: number;
    isGem: boolean;
    regrows: boolean;
}
export interface ScoredPatch { patch: OrePatch; g: number; score: number }

const patchCache = new WeakMap<GameApi, Map<string, { tick: number; patches: OrePatch[] }>>();
const comparePoints = (a: PatchPoint, b: PatchPoint) => a.rx - b.rx || a.ry - b.ry;
const keyOf = (point: PatchPoint) => `${point.rx}_${point.ry}`;

/** E1's connected-component algorithm, using only explored resource tiles and public rule prices. */
export function findVisiblePatches(game: GameApi, playerName: string): OrePatch[] {
    const tick = game.getCurrentTick();
    let players = patchCache.get(game);
    if (!players) {
        players = new Map();
        patchCache.set(game, players);
    }
    const cached = players.get(playerName);
    if (cached && tick >= cached.tick && tick - cached.tick < 90) return cached.patches;

    const visible = game.mapApi.getAllTilesResourceData()
        .filter(resource => game.mapApi.isVisibleTile(resource.tile, playerName));
    const values = game.mapApi.getResourceCreditValues();
    const resources = new Map<string, PatchPoint & { ore: number; gems: number }>(), spawns: PatchPoint[] = [];
    for (const resource of visible) {
        const point = { rx: resource.tile.rx, ry: resource.tile.ry };
        if (resource.spawnsOre) spawns.push(point);
        if (resource.ore <= 0 && resource.gems <= 0) continue;
        const previous = resources.get(keyOf(point));
        resources.set(keyOf(point), { ...point, ore: resource.ore + (previous?.ore ?? 0), gems: resource.gems + (previous?.gems ?? 0) });
    }
    const points = [...resources.values()].sort(comparePoints), visited = new Set<string>(), patches: OrePatch[] = [];
    for (const first of points) {
        if (visited.has(keyOf(first))) continue;
        const component = [first];
        visited.add(keyOf(first));
        for (let index = 0; index < component.length; index++) {
            const point = component[index];
            for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
                const key = `${point.rx + dx}_${point.ry + dy}`, neighbor = resources.get(key);
                if (neighbor && !visited.has(key)) { visited.add(key); component.push(neighbor); }
            }
        }
        component.sort(comparePoints);
        const value = component.reduce((sum, point) => sum + point.ore * values.ore + point.gems * values.gems, 0);
        const gemValue = component.reduce((sum, point) => sum + point.gems * values.gems, 0);
        const regrows = component.some(point => spawns.some(spawn => Math.hypot(point.rx - spawn.rx, point.ry - spawn.ry) <= 4));
        if (value < 2000 && !regrows) continue;
        patches.push({ id: keyOf(component[0]), tiles: component.map(({ rx, ry }) => ({ rx, ry })),
            center: { rx: Math.round(component.reduce((sum, point) => sum + point.rx, 0) / component.length),
                ry: Math.round(component.reduce((sum, point) => sum + point.ry, 0) / component.length) },
            value, gemValue, isGem: gemValue >= value * 0.5, regrows });
    }
    players.set(playerName, { tick, patches });
    return patches;
}

export function patchDistance(point: PatchPoint, patch: Pick<OrePatch, "tiles">): number {
    return patch.tiles.reduce((nearest, tile) => Math.min(nearest, Math.hypot(point.rx - tile.rx, point.ry - tile.ry)), Infinity);
}

export function isServed(patch: OrePatch, refineries: readonly PatchPoint[]): boolean {
    return refineries.some(refinery => patchDistance(refinery, patch) <= 9);
}

/** Pass all visible patches when counting several fields, so overlapping six-tile ranges do not double-count miners. */
export function minersOn(patch: OrePatch, miners: readonly PatchPoint[], patches: readonly OrePatch[] = [patch]): number {
    return miners.filter(miner => {
        let nearest = patch, distance = patchDistance(miner, patch);
        if (distance > 6) return false;
        for (const other of patches) {
            const candidate = patchDistance(miner, other);
            if (candidate < distance || candidate === distance && other.id < nearest.id) {
                nearest = other;
                distance = candidate;
            }
        }
        return nearest.id === patch.id;
    }).length;
}

export function scorePatch(game: GameApi, player: PlayerData, patch: OrePatch): ScoredPatch | undefined {
    const refineries = game.getVisibleUnits(player.name, "self", rules => rules.refinery)
        .map(id => game.getGameObjectData(id)?.tile).filter((tile): tile is Tile => !!tile);
    if (isServed(patch, refineries)) return undefined;
    const danger = game.getVisibleUnits(player.name, "enemy", rules => rules.type === ObjectType.Building
        ? !!(rules.primary || rules.secondary) : rules.isSelectableCombatant && !rules.harvester)
        .map(id => game.getGameObjectData(id)?.tile)
        .some(tile => tile && Math.hypot(tile.rx - patch.center.rx, tile.ry - patch.center.ry) <= 14);
    if (danger) return undefined;
    if (game.getCurrentTick() < 9000) {
        const ownStart = player.startLocation;
        const enemyDistance = Math.min(...game.mapApi.getStartingLocations()
            .filter(start => start.x !== ownStart.x || start.y !== ownStart.y)
            .map(start => patchDistance({ rx: start.x, ry: start.y }, patch)));
        if (patchDistance({ rx: ownStart.x, ry: ownStart.y }, patch) > enemyDistance) return undefined;
    }
    const buildings = game.getVisibleUnits(player.name, "self", rules => rules.type === ObjectType.Building && !rules.wall)
        .map(id => game.getGameObjectData(id)?.tile).filter((tile): tile is Tile => !!tile);
    const g = Math.min(...buildings.map(building => patchDistance(building, patch)));
    return { patch, g, score: Math.min(patch.value + patch.gemValue, 40000) / (1 + g / 10) };
}

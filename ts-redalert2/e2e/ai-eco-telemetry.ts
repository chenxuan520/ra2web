import { MapApi } from '../src/game/api/MapApi';
import { findPatches, nearestPatch, patchDistance, type ResourceTile, type EcoMap, type EcoSample, type PlayerEcoSample } from './league/ecoCore';

/** Observer-only reads of MapApi and real owned objects. No bot queries, commands, callbacks, or RNG are involved. */
export function createEcoTelemetry(game: any, players: readonly any[], starts: readonly { x: number; y: number }[]) {
    if (game.currentTick !== 0) throw new Error('Economic patches must be captured at tick 0');
    if (players.length !== 2 || starts.length !== 2 || starts.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y)))
        throw new Error('Economic observer requires two ordered players and physical starts');
    const mapApi = new MapApi(game), values = mapApi.getResourceCreditValues();
    const readTiles = (): ResourceTile[] => mapApi.getAllTilesResourceData().map(resource => ({
        rx: resource.tile.rx, ry: resource.tile.ry, ore: resource.ore, gems: resource.gems, spawnsOre: resource.spawnsOre,
    }));
    const patches = findPatches(readTiles(), values);
    const ecoMap: EcoMap = { values: { ...values }, patches: patches.map(patch => {
        const distToStart: [number, number] = [patchDistance({ rx: starts[0].x, ry: starts[0].y }, patch),
            patchDistance({ rx: starts[1].x, ry: starts[1].y }, patch)];
        return { id: patch.id, cx: patch.center.rx, cy: patch.center.ry, tiles: patch.tiles.length,
            value: patch.value, gemValue: patch.gemValue, isGem: patch.isGem, regrows: patch.regrows,
            nearestStart: distToStart[0] <= distToStart[1] ? 0 : 1, distToStart };
    }) };
    return { ecoMap, sample(): { eco: EcoSample; players: PlayerEcoSample[] } {
        const remaining = new Map<string, [number, number]>();
        let oreValue = 0, gemValue = 0;
        for (const tile of readTiles()) {
            if (!Number.isSafeInteger(tile.rx) || !Number.isSafeInteger(tile.ry) || !Number.isFinite(tile.ore) || tile.ore < 0 ||
                !Number.isFinite(tile.gems) || tile.gems < 0) throw new Error('Missing or invalid observed resource data');
            const ore = tile.ore * values.ore, gems = tile.gems * values.gems, key = `${tile.rx}_${tile.ry}`;
            const previous = remaining.get(key);
            remaining.set(key, [ore + gems + (previous?.[0] ?? 0), gems + (previous?.[1] ?? 0)]);
            oreValue += ore; gemValue += gems;
        }
        // A missing overlay in this complete world scan is a genuinely depleted coordinate, not missing telemetry.
        const patchValues = Object.fromEntries(patches.map(patch => [patch.id, patch.tiles.reduce<[number, number]>((sum, tile) => {
            const value = remaining.get(`${tile.rx}_${tile.ry}`);
            return [sum[0] + (value?.[0] ?? 0), sum[1] + (value?.[1] ?? 0)];
        }, [0, 0])]));
        const playerSamples = players.map((player): PlayerEcoSample => {
            const objects = player.getOwnedObjects();
            if (!Array.isArray(objects)) throw new Error('Missing observed owned objects');
            const minersByPatch: Record<string, number> = Object.fromEntries(patches.map(patch => [patch.id, 0]));
            const miners = objects.filter((object: any) => object.rules.harvester);
            for (const miner of miners) {
                if (!Number.isFinite(miner.tile?.rx) || !Number.isFinite(miner.tile?.ry)) throw new Error('Missing observed miner position');
                const patch = nearestPatch(miner.tile, patches, 6);
                if (patch) minersByPatch[patch.id]++;
            }
            const refineries = objects.filter((object: any) => object.isBuilding() && object.rules.refinery).map((object: any) => {
                if (!Number.isFinite(object.tile?.rx) || !Number.isFinite(object.tile?.ry)) throw new Error('Missing observed refinery position');
                return { x: object.tile.rx, y: object.tile.ry, patch: nearestPatch(object.tile, patches, 9)?.id ?? null };
            }).sort((a: { x: number; y: number }, b: { x: number; y: number }) => a.x - b.x || a.y - b.y);
            // A refinery can serve two nearby patches even though its own label is only the nearest one.
            const servedPatches = patches.filter(patch => refineries.some((refinery: { x: number; y: number }) =>
                patchDistance({ rx: refinery.x, ry: refinery.y }, patch) <= 9)).length;
            return { miners: miners.length, minersByPatch, refineries, servedPatches };
        });
        return { eco: { oreValue, gemValue, patchValues }, players: playerSamples };
    } };
}

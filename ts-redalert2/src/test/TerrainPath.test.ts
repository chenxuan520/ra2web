import { expect, spyOn, test } from 'bun:test';
import { IniFile } from '../data/IniFile';
import { TheaterType } from '../engine/TheaterType';
import { TerrainType } from '../engine/type/TerrainType';
import { MapBounds } from '../game/map/MapBounds';
import { Terrain } from '../game/map/Terrain';
import { TileCollection } from '../game/map/TileCollection';
import { TileOccupation } from '../game/map/TileOccupation';
import { LandRules } from '../game/rules/LandRules';
import { LandType } from '../game/type/LandType';
import { SpeedType } from '../game/type/SpeedType';

function terrainFixture(water = false) {
    const tileData = Array.from({ length: 121 }, (_, index) => {
        const rx = 20 + index % 11;
        const ry = 45 + Math.floor(index / 11);
        return { rx, ry, dx: rx - ry + 39, dy: rx + ry - 41, z: 0, tileNum: 0, subTile: 0 };
    });
    const tiles = new TileCollection(tileData, {
        getTileImage: () => ({ terrainType: water ? TerrainType.Water : TerrainType.Clear, rampType: 0, height: 0 }),
        isCliffTile: () => false,
        isHighBridgeBoundaryTile: () => false,
    } as any, { cliffBackImpassability: 0 }, () => 0);
    const bounds = new MapBounds().fromMapFile({
        fullSize: { width: 40, height: 80 },
        localSize: { x: 2, y: 0, width: 36, height: 80 },
    }, tiles);
    const occupation = new TileOccupation(tiles);
    const landRules = new LandRules();
    const waterRules = new LandRules().readIni(new IniFile('[Water]\nFoot=0\nTrack=0\n').getSection('Water'));
    const terrain = new Terrain(tiles, TheaterType.Temperate, bounds, occupation, {
        getLandRules: (type: LandType) => type === LandType.Water ? waterRules : landRules,
    } as any);
    const object = (name: string, rx: number, ry: number, kind: 'building' | 'vehicle' | 'bridge', foundation = { width: 1, height: 1 }, rules = {}) => ({
        name, tile: tiles.getByMapCoords(rx, ry)!, art: { foundation }, rules,
        isDestroyed: false, tileElevation: 0,
        position: {}, moveTrait: { reservedPathNodes: [] },
        getFoundation: () => foundation,
        isBuilding: () => kind === 'building',
        isVehicle: () => kind === 'vehicle',
        isUnit: () => kind === 'vehicle',
        isTechno: () => kind !== 'bridge',
        isOverlay: () => kind === 'bridge',
        isBridge: () => kind === 'bridge',
        isHighBridge: () => kind === 'bridge',
        isTerrain: () => false,
        isAircraft: () => false,
        isInfantry: () => false,
        isSmudge: () => false,
        isTiberium: () => false,
        isBridgePlaceholder: () => false,
    });
    return { tiles, terrain, occupation, object };
}

function refineryFixture() {
    const fixture = terrainFixture();
    const refinery = fixture.object('GAREFN', 22, 48, 'building', { width: 4, height: 3 }, { numberImpassableRows: 3 });
    const barracks = fixture.object('GAPILE', 26, 49, 'building', { width: 2, height: 2 });
    const harvester = fixture.object('CMIN', 25, 49, 'vehicle');
    for (const object of [refinery, barracks, harvester]) fixture.occupation.occupyTileRange(object.tile, object);
    fixture.terrain.computeAllPassabilityGraphs();
    return { ...fixture, harvester, start: fixture.tiles.getByMapCoords(28, 52)!, edge: fixture.tiles.getByMapCoords(25, 50)! };
}

test('infantry fallback skips refinery cells absent from its graph when the harvester is ignored', () => {
    const { terrain, tiles, start, edge, harvester } = refineryFixture();
    try {
        const graph = (terrain as any).passabilityGraphs.get(`${SpeedType.Foot}_1`);
        const nodeCount = graph.getNodeCount();
        expect(terrain.getPassableSpeed(edge, SpeedType.Foot, true, false)).toBe(0);
        expect(terrain.getPassableSpeed(edge, SpeedType.Foot, false, false)).toBe(1);
        expect(graph.hasNode(edge.id)).toBe(false);
        let path: ReturnType<Terrain['computePath']>;
        expect(() => { path = terrain.computePath(SpeedType.Foot, true, start, false, harvester.tile, false, { ignoredBlockers: [harvester] }); }).not.toThrow();
        expect(path![0].tile).toBe(tiles.getByMapCoords(26, 48));
        expect(path!.at(-1)!.tile).toBe(start);
        expect(path!.every(node => terrain.getPassableSpeed(node.tile, SpeedType.Foot, true, Boolean(node.onBridge)) > 0)).toBe(true);
        expect(graph.getNodeCount()).toBe(nodeCount);
        expect(graph.hasNode(edge.id)).toBe(false);
    }
    finally { terrain.dispose(); }
});

test('vehicles still reach the refinery edge with the harvester ignored', () => {
    const { terrain, start, harvester } = refineryFixture();
    try {
        const path = terrain.computePath(SpeedType.Track, false, start, false, harvester.tile, false, { ignoredBlockers: [harvester] });
        expect(path[0].tile).toBe(harvester.tile);
        expect(path.at(-1)!.tile).toBe(start);
        expect(path.every(node => node.onBridge === undefined)).toBe(true);
    }
    finally { terrain.dispose(); }
});

for (const [speedType, isInfantry] of [[SpeedType.Foot, true], [SpeedType.Track, false]] as const) {
    test(`${SpeedType[speedType]} paths preserve bridge level independently of infantry status`, () => {
        const { tiles, terrain, occupation, object } = terrainFixture(true);
        const bridge = object('bridge', 24, 52, 'bridge', { width: 4, height: 1 }, { land: LandType.Road });
        const target = object('target', 27, 52, 'vehicle');
        occupation.occupyTileRange(bridge.tile, bridge);
        occupation.occupyTileRange(target.tile, target);
        const start = tiles.getByMapCoords(24, 52)!;
        const ignoredBlockers = [target];
        const passable = spyOn(terrain, 'getPassableSpeed');
        try {
            expect(terrain.getPassableSpeed(target.tile, speedType, isInfantry, false)).toBe(0);
            expect(terrain.getPassableSpeed(target.tile, speedType, isInfantry, true)).toBe(1);
            const path = terrain.computePath(speedType, isInfantry, start, true, target.tile, true, { ignoredBlockers });
            expect(path[0].tile).toBe(target.tile);
            expect(path.at(-1)!.tile).toBe(start);
            expect(path.every(node => node.onBridge === bridge)).toBe(true);
            const checks = passable.mock.calls.filter(args => args[0] === target.tile && args[4] === ignoredBlockers && args[3] === true);
            expect(checks.at(-1)!.slice(2, 4)).toEqual([isInfantry, true]);
        }
        finally { passable.mockRestore(); terrain.dispose(); }
    });
}

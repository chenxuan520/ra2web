import { loadSpecialtyResources, createSpecialtyGame, spawnSpecialtyObject } from '../../ts-redalert2/e2e/ai-specialty-scenarios';
import { ObjectType } from '../../ts-redalert2/src/engine/type/ObjectType';
import { SpeedType } from '../../ts-redalert2/src/game/type/SpeedType';
import { OrderType } from '../../ts-redalert2/src/game/order/OrderType';
import { AppLogger } from '../../ts-redalert2/src/util/logger';

AppLogger.setLevel(AppLogger.ERROR);
console.log = () => {};
const resources = await loadSpecialtyResources(process.env.RA2_BENCHMARK_CDN, 'mp11t2.map');
let route: { x: number; y: number } | undefined;
const results = [];
for (const name of ['E2', 'DOG', 'HTNK']) {
    const { game, players, bots } = createSpecialtyGame(resources, 610101, ['Russians', 'Russians']);
    try {
        if (!route) {
            const tiles: any[] = [];
            game.map.tiles.forEach((tile: any) => tiles.push(tile));
            tiles.sort((a, b) => a.rx - b.rx || a.ry - b.ry);
            const start = tiles.find(o => Array.from({ length: 13 }, (_, i) => i).every(i => {
                const t = game.map.tiles.getByMapCoords(o.rx + i, o.ry);
                return t && t.z === o.z && t.onBridgeLandType === undefined &&
                    game.map.terrain.getPassableSpeed(t, SpeedType.Foot, true, false) === 1 &&
                    game.map.terrain.getPassableSpeed(t, SpeedType.Track, false, false) === 1 &&
                    !game.map.getObjectsOnTile(t).some((object: any) => object.isTechno() || object.isTerrain()) &&
                    game.getCombatants().every((p: any) => p.getOwnedObjects().every((obj: any) =>
                        Math.hypot(obj.tile.rx - t.rx, obj.tile.ry - t.ry) >= 18));
            }));
            if (!start) throw new Error('No equal-cost clear straight route');
            route = { x: start.rx, y: start.ry };
        }
        const object = spawnSpecialtyObject(game, { label: name, name, type: name === 'HTNK' ? ObjectType.Vehicle : ObjectType.Infantry,
            player: 0, x: 0, y: 0 }, { rx: route.x, ry: route.y }, players);
        game.start();
        for (const bot of bots.values()) bot.onGameTick = () => {};
        bots.get(players[0].name)!.actionsApi.orderUnits([object.id], OrderType.Move, route.x + 12, route.y);
        const position = object.position.getMapPosition().clone();
        const samples = [];
        let reached: number | null = null;
        for (let t = 1; t <= 1200; t++) {
            game.update();
            if (t % 60 === 0) samples.push({ tick: t, distanceInTiles: object.position.getMapPosition().distanceTo(position) / 256,
                tile: [object.tile.rx, object.tile.ry] });
            if (object.tile.rx === route.x + 12 && object.tile.ry === route.y) { reached = t; break; }
        }
        results.push({ name, iniSpeed: object.rules.ini.getNumber('Speed'), parsedSpeed: object.rules.speed,
            baseSpeed: object.moveTrait.baseSpeed, ticksToDestinationTile: reached, samples });
    } finally { game.dispose(); }
}
await Bun.write(process.argv[2] ?? '.artifacts/ai-benchmark/mobility-check.json', JSON.stringify({ kind: 'single-unit-equal-path-mechanics-only',
    route, lengthTiles: 12, seed: 610101, resources: resources.hashes, results,
    notes: ['Independent games, identical clear flat path, terrain speed multiplier 1 for foot and track.',
        'This measures travel to a tile, not tactical cohesion or combat effectiveness. No engine or unit rules changed.'] }, null, 2) + '\n');
process.stdout.write(JSON.stringify(results) + '\n');

/** Real engine capture fixture: preplaced forces, never a production/win-rate claim. */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadSpecialtyResources, createSpecialtyGame, spawnSpecialtyObject } from './ai-specialty-scenarios';
import { ObjectType } from '../src/engine/type/ObjectType';
import { SpeedType } from '../src/game/type/SpeedType';
import { OrderType } from '../src/game/order/OrderType';
import { Vector2 } from '../src/game/math/Vector2';
import { AppLogger } from '../src/util/logger';
import { MissionController } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController';
import { SneakCaptureMissionFactory } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/sneakCaptureMission';

export async function runCaptureFixture(cdn: string, guarded = false) {
    const resources = await loadSpecialtyResources(cdn);
    const { game, players, bots } = createSpecialtyGame(resources, 515, ['Americans', 'Russians']);
    const result: any = { kind: 'real-engine-engineer-capture', guarded, resources: resources.hashes,
        notes: ['Units and buildings are preplaced to test the controller and real Capture action.',
            'No ownership is reassigned by this fixture; a successful capture must be performed by the engine.'],
        commands: [], lifecycle: [], snapshots: [], initialOwner: players[1].name };
    try {
        const candidates: any[] = [];
        const foundations = [['GAPILE', -3, 4], ['GAREFN', 2, 4], ['NACNST', 10, 0]].map(([name, x, y]) => ({
            x: Number(x), y: Number(y), shape: game.createObject(ObjectType.Building, String(name)).getFoundation(),
        }));
        game.map.tiles.forEach((tile: any) => candidates.push(tile));
        candidates.sort((a, b) => a.rx - b.rx || a.ry - b.ry);
        const origin = candidates.find(tile => {
            const points = [[0, 0], [6, -2], [-2, 2], [0, 2], [-4, 0], [-4, -2], [-2, -3], [0, -3], [9, 0]];
            for (const building of foundations) {
                const corner = game.map.tiles.getByMapCoords(tile.rx + building.x, tile.ry + building.y);
                if (!corner) return false;
                for (let x = 0; x < building.shape.width; x++) for (let y = 0; y < building.shape.height; y++) {
                    const next = game.map.tiles.getByMapCoords(tile.rx + building.x + x, tile.ry + building.y + y);
                    if (!next || next.z !== corner.z) return false;
                    points.push([building.x + x, building.y + y]);
                }
            }
            for (const [x, y] of points) {
                const next = game.map.tiles.getByMapCoords(tile.rx + x, tile.ry + y);
                if (!next || next.onBridgeLandType !== undefined ||
                    game.map.terrain.getPassableSpeed(next, SpeedType.Track, false, false) <= 0 ||
                    game.map.getObjectsOnTile(next).some((object: any) => object.isTechno() || object.isTerrain())) return false;
            }
            const end = game.map.tiles.getByMapCoords(tile.rx + 9, tile.ry);
            return game.map.terrain.computePath(SpeedType.Foot, true, tile, false, end, false,
                { bestEffort: false, maxExpandedNodes: 2000 }).length > 0;
        });
        if (!origin) throw new Error('No clear engineer fixture location');
        const spawn = (label: string, name: string, type: ObjectType, side: number, x: number, y: number) =>
            spawnSpecialtyObject(game, { label, name, type, player: side, x, y }, origin, players);
        const engineer = spawn('engineer', 'ENGINEER', ObjectType.Infantry, 0, 0, 0);
        const target = spawn('enemy-conyard', 'NACNST', ObjectType.Building, 1, 10, 0);
        spawn('vision', 'ADOG', ObjectType.Infantry, 0, 6, -2);
        spawn('barracks', 'GAPILE', ObjectType.Building, 0, -3, 4);
        spawn('refinery', 'GAREFN', ObjectType.Building, 0, 2, 4);
        spawn('miner1', 'CMIN', ObjectType.Vehicle, 0, -2, 2);
        spawn('miner2', 'CMIN', ObjectType.Vehicle, 0, 0, 2);
        for (const [index, [x, y]] of [[-4, 0], [-4, -2], [-2, -3], [0, -3]].entries()) {
            spawn(`tank${index}`, 'MTNK', ObjectType.Vehicle, 0, x, y);
        }
        if (guarded) spawn('guard', 'E2', ObjectType.Infantry, 1, 9, 0);
        game.start();
        const bot = bots.get(players[0].name)!;
        const api = bot.gameApi;
        const home = new Vector2(origin.rx, origin.ry);
        const controller = new MissionController(message => result.lifecycle.push({ tick: game.currentTick, message }));
        const factory = new SneakCaptureMissionFactory();
        const original = bot.actionsApi.orderUnits.bind(bot.actionsApi);
        bot.actionsApi.orderUnits = (...args: any[]) => {
            result.commands.push({ tick: game.currentTick, ids: args[0], order: args[1], target: args[2] });
            return original(...args);
        };
        const context: any = { game: api, difficulty: 'brutal', player: { name: bot.name,
            actions: bot.actionsApi, production: bot.productionApi }, matchAwareness: {
            getMainRallyPoint: () => home,
            getHostilesNearPoint2d: (point: Vector2, radius: number) => api.getVisibleUnits(bot.name, 'enemy')
                .map((id: number) => api.getUnitData(id)).filter((unit: any) => unit &&
                    new Vector2(unit.tile.rx, unit.tile.ry).distanceTo(point) <= radius).map((unit: any) => ({ unitId: unit.id })),
        } };
        result.initiallyVisible = api.getVisibleUnits(bot.name, 'enemy').includes(target.id);
        result.engineerAvailable = bot.productionApi.getAvailableObjects().some((rule: any) => rule.name === 'ENGINEER');
        bot.onGameTick = () => {
            if (game.currentTick % 2) return;
            factory.maybeCreateMissions(context, controller, message => result.lifecycle.push({ tick: game.currentTick, message }));
            controller.onAiUpdate(context);
        };
        while (game.currentTick < (guarded ? 100 : 1200) && target.owner !== players[0]) {
            game.update();
            if (game.currentTick % 30 === 0) result.snapshots.push({ tick: game.currentTick, owner: target.owner.name,
                engineerAlive: game.getWorld().hasObjectId(engineer.id), engineerTile: { x: engineer.tile.rx, y: engineer.tile.ry } });
        }
        result.ticks = game.currentTick;
        result.finalOwner = target.owner.name;
        result.captureOrders = result.commands.filter((command: any) => command.order === OrderType.Capture).length;
        result.checks = { visibleTarget: result.initiallyVisible, actualEngineerAvailable: result.engineerAvailable,
            controllerOutcome: guarded ? result.captureOrders === 0 && target.owner === players[1] : result.captureOrders > 0 && target.owner === players[0] };
        result.passed = Object.values(result.checks).every(Boolean);
        return result;
    } finally { game.dispose(); }
}

if (import.meta.main) {
    console.log = console.debug = console.info = () => {};
    const { values } = parseArgs({ options: { cdn: { type: 'string', default: process.env.RA2_BENCHMARK_CDN },
        out: { type: 'string', default: '.artifacts/ai-benchmark/sneak-capture.json' } } });
    const issues: string[] = [];
    AppLogger.setLevel(AppLogger.ERROR);
    AppLogger.setHandler((messages: any) => issues.push(messages.map(String).join(' ')));
    const cdn = values.cdn ?? resolve(import.meta.dir, '../../.cache/ai-resources/cdn');
    const scenarios = [await runCaptureFixture(cdn), await runCaptureFixture(cdn, true)];
    const report = { scenarios, issues, passed: !issues.length && scenarios.every(s => s.passed) };
    await Bun.write(values.out!, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ passed: report.passed, scenarios: scenarios.map(s => s.checks), issues }) + '\n');
    if (!report.passed) process.exitCode = 1;
}

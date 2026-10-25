/** Real-engine split/recall fixture. Preplaced forces test mechanics, not build-order strength. */
import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSpecialtyGame, loadSpecialtyResources, spawnSpecialtyObject } from './ai-specialty-scenarios';
import { ObjectType } from '../src/engine/type/ObjectType';
import { EventType } from '../src/game/event/EventType';
import { OrderType } from '../src/game/order/OrderType';
import { SpeedType } from '../src/game/type/SpeedType';
import { Vector2 } from '../src/game/math/Vector2';
import { AppLogger } from '../src/util/logger';
import { MissionController } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController';
import { AttackMission } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/attackMission';
import { DefenceMissionFactory } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/defenceMission';
import { HarassmentMission, HarassmentMissionFactory } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/harassmentMission';

const positions = [
    [-2, -2], [0, -2], [2, -2], [-1, 0], [1, 0],
    [-2, 4], [0, 4], [2, 4], [0, 6],
];
const extraPositions = [[-8, 4], [22, 4], [18, 6], [-1, -12], [-12, 16], [-5, 8]];

function findSite(game: any) {
    const rejected = { tile: 0, anchor: 0, path: 0, example: null as any };
    const candidates: any[] = [];
    game.map.tiles.forEach((tile: any) => candidates.push(tile));
    candidates.sort((a, b) => a.rx - b.rx || a.ry - b.ry);
    const result = candidates.find(origin => {
        const tiles = [...positions, ...extraPositions].map(([x, y]) => game.map.tiles.getByMapCoords(origin.rx + x, origin.ry + y));
        if (tiles.some(tile => !tile || tile.onBridgeLandType !== undefined ||
            game.map.terrain.getPassableSpeed(tile, SpeedType.Track, false, false) <= 0 ||
            game.map.getObjectsOnTile(tile).some((object: any) => object.isTechno() || object.isTerrain()))) { rejected.tile++; return false; }
        const anchors = game.getCombatants().flatMap((player: any) => player.getOwnedObjects());
        if (tiles.some(tile => anchors.some((anchor: any) => Math.hypot(tile.rx - anchor.tile.rx, tile.ry - anchor.tile.ry) < 8))) { rejected.anchor++; return false; }
        // Verify genuine terrain paths for the raid and both main lanes before setup.
        for (const [startIndex, endIndex] of [[3, 10], [8, 10], [10, 9], [0, 12], [5, 13]]) {
            const start = tiles[startIndex], end = tiles[endIndex];
            const path = game.map.terrain.computePath(SpeedType.Track, false, start, false, end, false,
                { maxExpandedNodes: 2000, bestEffort: false });
            if (!path.length || path[0].tile !== end || path.at(-1).tile !== start) {
                rejected.path++;
                rejected.example ??= { origin: [origin.rx, origin.ry], start: [start.rx, start.ry], end: [end.rx, end.ry], path: path.map((p: any) => [p.tile.rx, p.tile.ry]) };
                return false;
            }
        }
        return true;
    });
    if (!result) throw new Error(`No legal split/recall site: ${JSON.stringify(rejected)}`);
    return result;
}

export async function runHarassmentScenario(options: { cdn?: string; map?: string; seed?: number; maxTicks?: number } = {}) {
    const map = (options.map ?? 'mp08t2').replace(/(?:\.map)?$/, '.map');
    const seed = options.seed ?? 303;
    const maxTicks = options.maxTicks ?? 1800;
    const resources = await loadSpecialtyResources(options.cdn, map);
    const { game, players, bots } = createSpecialtyGame(resources, seed);
    const report: any = { kind: 'real-engine-harassment-fixture', map, seed, maxTicks, resources: resources.hashes,
        notes: ['Nine healthy tanks are preplaced in two real AttackMissions (5 + 4). No economic victory is claimed.',
            'Actual MissionController, HarassmentMissionFactory, CombatSquad and Game.update execute every AI order and movement.',
            'An owned scout reveals the outside miner through normal vision; a scripted enemy arrival tests base recall.'],
        setup: [], commands: [], snapshots: [], lifecycle: [], productionEvents: [], damageEvents: [],
        controllerUpdates: 0, duplicateOwnershipTicks: [], productionRequestTicks: [] };
    const controller = new MissionController((message: string) => {
        if (message.includes('harassment_') || message.includes('Harassment ')) report.lifecycle.push({ tick: game.currentTick, message });
    });
    const factory = new HarassmentMissionFactory();
    const defense = new DefenceMissionFactory();
    const raidIds = new Set<number>();
    let launched = false;
    let returned = false;
    let recallSeen = false;
    let outsideTargetVisibleAtLaunch = false;
    let mainPreservedAtSplit = false;
    let threatSpawnTick: number | undefined;
    try {
        const origin = findSite(game);
        if (!origin) throw new Error(`No legal split/recall fixture site on ${map}`);
        report.origin = { x: origin.rx, y: origin.ry };
        const point = (offset: number[]) => new Vector2(origin.rx + offset[0], origin.ry + offset[1]);
        const home = point(extraPositions[0]);
        const firstTarget = point(extraPositions[3]);
        const secondTarget = point(extraPositions[4]);
        const spawn = (label: string, name: string, type: ObjectType, player: number, offset: number[]) => {
            const spec = { label, name, type, player, x: offset[0], y: offset[1] };
            const object = spawnSpecialtyObject(game, spec, origin, players);
            report.setup.push({ ...spec, id: object.id, tile: { x: object.tile.rx, y: object.tile.ry } });
            return object;
        };
        const tanks = positions.map((offset, index) => spawn(`tank-${index}`, 'HTNK', ObjectType.Vehicle, 0, offset));
        spawn('home-mcv', 'SMCV', ObjectType.Vehicle, 0, extraPositions[0]);
        const miner = spawn('outside-miner', 'CMIN', ObjectType.Vehicle, 1, extraPositions[1]);
        spawn('vision-scout', 'ADOG', ObjectType.Infantry, 0, extraPositions[2]);
        const makeMain = (name: string, target: Vector2, members: any[]) => {
            const mission = new AttackMission(name, 1, home, target, 10,
                { composition: { HTNK: 1 }, minimumUnits: members.length, maximumUnits: members.length }, () => {});
            members.forEach(unit => mission.addUnit(unit.id));
            controller.addMission(mission);
            return mission;
        };
        const first = makeMain('fixture-main-a', firstTarget, tanks.slice(0, 5));
        const second = makeMain('fixture-main-b', secondTarget, tanks.slice(5));
        const originalByMission = [first.getUnitIds().slice(), second.getUnitIds().slice()];
        game.events.subscribe((event: any) => {
            if (event.type === EventType.FactoryProduceUnit) report.productionEvents.push({ tick: game.currentTick, id: event.target.id, name: event.target.name });
            if (event.type === EventType.InflictDamage && (raidIds.has(event.target.id) || event.target.id === miner.id)) {
                report.damageEvents.push({ tick: game.currentTick, id: event.target.id, damage: event.damageHitPoints,
                    attackerId: event.attacker?.obj?.id ?? null });
            }
        });
        game.start();
        const bot = bots.get(players[0].name)!;
        const api = bot.gameApi;
        const originalOrder = bot.actionsApi.orderUnits;
        bot.actionsApi.orderUnits = function (ids: number[], order: OrderType, x?: number, y?: number, bridge?: boolean) {
            report.commands.push({ tick: game.currentTick, ids: ids.slice(), order: OrderType[order],
                target: y === undefined ? x ?? null : { x, y } });
            return originalOrder.call(this, ids, order, x, y, bridge);
        };
        const hostiles = (x: number, y: number, radius: number) => api.getVisibleUnits(bot.name, 'enemy')
            .map((id: number) => api.getUnitData(id))
            .filter((unit: any) => unit && Math.hypot(unit.tile.rx - x, unit.tile.ry - y) <= radius)
            .map((unit: any) => ({ unitId: unit.id }));
        const context: any = { game: api, difficulty: 'brutal',
            player: { name: bot.name, actions: bot.actionsApi, production: bot.productionApi },
            matchAwareness: { getMainRallyPoint: () => home, getHostilesNearPoint: hostiles,
                getHostilesNearPoint2d: (p: Vector2, r: number) => hostiles(p.x, p.y, r) } };
        bot.onGameTick = () => {
            if (game.currentTick % 2) return;
            report.controllerUpdates++;
            const activeMain = [first, second].filter(mission => mission.isActive() && mission.getState() === 1);
            factory.maybeCreateMissions(context, controller, (message: string) => report.lifecycle.push({ tick: game.currentTick, message }), activeMain);
            defense.maybeCreateMissions(context, controller, () => {});
            controller.onAiUpdate(context);
            const raids = controller.getMissions().filter(mission => mission instanceof HarassmentMission) as HarassmentMission[];
            if (!launched && raids[0]?.getUnitIds().length === 3) {
                launched = true;
                raids[0].getUnitIds().forEach(id => raidIds.add(id));
                outsideTargetVisibleAtLaunch = api.getVisibleUnits(bot.name, 'enemy').includes(miner.id);
                mainPreservedAtSplit = first.getUnitIds().length >= 3 && second.getUnitIds().length >= 3;
                report.split = { tick: game.currentTick, raidIds: [...raidIds], first: first.getUnitIds().slice(), second: second.getUnitIds().slice(),
                    originalByMission, minerId: miner.id, mainTargets: [firstTarget, secondTarget], target: point(extraPositions[1]) };
            }
            if (raids.some(mission => mission.getState() === 'returning')) recallSeen = true;
            if (recallSeen && !raids.length) returned = true;
            const ids = controller.getMissions().flatMap(mission => mission.getUnitIds());
            if (new Set(ids).size !== ids.length) report.duplicateOwnershipTicks.push(game.currentTick);
            if (controller.getRequestedUnitTypes().size) report.productionRequestTicks.push(game.currentTick);
            if (game.currentTick % 30 === 0) report.snapshots.push({ tick: game.currentTick,
                missions: controller.getMissions().map(mission => ({ name: mission.getUniqueName(), ids: mission.getUnitIds().slice(),
                    state: (mission as any).getState?.() })), raidPositions: [...raidIds].map(id => {
                        const unit = api.getUnitData(id);
                        return unit ? { id, x: unit.tile.rx, y: unit.tile.ry, health: unit.hitPoints } : { id, destroyed: true };
                    }) });
        };
        while (game.currentTick < maxTicks) {
            game.update();
            if (launched && threatSpawnTick === undefined && game.currentTick >= 120) {
                const threat = spawn('base-attacker', 'HTNK', ObjectType.Vehicle, 1, extraPositions[5]);
                threatSpawnTick = game.currentTick;
                report.threat = { tick: threatSpawnTick, id: threat.id, tile: { x: threat.tile.rx, y: threat.tile.ry } };
            }
            if (returned) break;
        }
        report.ticks = game.currentTick;
        report.checks = {
            actualControllersRan: report.controllerUpdates > 0,
            splitThreeFromTwoExistingWaves: launched && report.split.originalByMission.every((ids: number[]) => ids.some(id => raidIds.has(id))),
            mainForcesPreserved: mainPreservedAtSplit,
            minerVisibleAtLaunch: outsideTargetVisibleAtLaunch,
            distinctMainAndRaidTargets: launched && report.split.mainTargets.every((p: Vector2) => p.distanceTo(report.split.target) >= 12),
            independentRaidOrders: launched && report.commands.some((command: any) => command.tick >= report.split.tick &&
                command.ids.length === 3 && command.ids.every((id: number) => raidIds.has(id)) && command.order === 'AttackMove' &&
                command.target?.x === report.split.target.x && command.target?.y === report.split.target.y),
            noDoubleOwnership: report.duplicateOwnershipTicks.length === 0,
            noAdditionalProduction: report.productionRequestTicks.length === 0 && report.productionEvents.length === 0,
            baseThreatCausedRecall: recallSeen && report.lifecycle.some((entry: any) => entry.message.includes('base-under-attack')),
            raidReturnedAndReleased: returned && [...raidIds].every(id => {
                const unit = api.getUnitData(id);
                return !!unit && home.distanceTo(new Vector2(unit.tile.rx, unit.tile.ry)) <= 5;
            }),
        };
        report.passed = Object.values(report.checks).every(Boolean);
        return report;
    } finally {
        game.dispose();
    }
}

if (import.meta.main) {
    const { values: args } = parseArgs({ options: { cdn: { type: 'string' }, map: { type: 'string', default: 'mp08t2' },
        seed: { type: 'string', default: '303' }, 'max-ticks': { type: 'string', default: '1800' },
        repeat: { type: 'string', default: '2' },
        out: { type: 'string', default: '.artifacts/ai-benchmark/harassment-scenario.json' } } });
    const issues: any[] = [];
    for (const level of ['log', 'debug', 'info', 'warn', 'error'] as const) console[level] = (...args) => {
        if (level === 'error' || level === 'warn') issues.push({ level, message: args.map(String).join(' ') });
    };
    AppLogger.setLevel(AppLogger.ERROR);
    AppLogger.setHandler((messages: any, context: any) => issues.push({ level: String(context.level.name).toLowerCase(), message: [...messages].map(String).join(' ') }));
    const repeat = Number(args.repeat);
    if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat must be a positive integer');
    const git = async (...parameters: string[]) => {
        const process = Bun.spawn(['git', ...parameters], { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
        const [output, errors, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
        if (code) throw new Error(errors);
        return output.trim();
    };
    const sourceRoot = resolve(import.meta.dir, '../src/game/ai/thirdpartbot/builtIn');
    const digest = createHash('sha256');
    for (const name of (await readdir(sourceRoot, { recursive: true })).filter(name => name.endsWith('.ts')).sort()) {
        digest.update(name).update('\0').update(await Bun.file(resolve(sourceRoot, name)).text()).update('\0');
    }
    const version = { commit: await git('rev-parse', 'HEAD'), builtInSourceSha256: digest.digest('hex'),
        workingTreeStatus: await git('status', '--porcelain', '--untracked-files=all', '--', 'ts-redalert2/src/game') };
    const results: any[] = [];
    for (let index = 0; index < repeat; index++) results.push(await runHarassmentScenario({ cdn: args.cdn, map: args.map,
        seed: Number(args.seed), maxTicks: Number(args['max-ticks']) }));
    const deterministic = results.every(result => JSON.stringify(result) === JSON.stringify(results[0]));
    const output: any = { ...results[0], version, repeat, deterministic };
    output.issues = issues;
    output.runnerSha256 = createHash('sha256').update(await Bun.file(import.meta.path).text()).digest('hex');
    output.passed &&= deterministic && results.every(result => result.passed) && !issues.some(issue => issue.level === 'error');
    await mkdir(dirname(resolve(args.out!)), { recursive: true });
    await Bun.write(resolve(args.out!), JSON.stringify(output, null, 2) + '\n');
    process.stderr.write(JSON.stringify({ passed: output.passed, ticks: output.ticks, checks: output.checks, issues, out: resolve(args.out!) }) + '\n');
    if (!output.passed) process.exitCode = 1;
}

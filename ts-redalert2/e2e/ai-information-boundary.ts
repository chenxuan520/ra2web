/**
 * Real-map information-boundary fixtures, not matches or strength evidence.
 * Preplaced objects exercise existing policies through the real API and shroud.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSpecialtyGame, loadSpecialtyResources, spawnSpecialtyObject } from './ai-specialty-scenarios';
import { ObjectType } from '../src/engine/type/ObjectType';
import { GameApi } from '../src/game/api/GameApi';
import { Vector2 } from '../src/game/math/Vector2';
import { SpeedType } from '../src/game/type/SpeedType';
import { TiberiumTrait } from '../src/game/gameobject/trait/TiberiumTrait';
import { AppLogger } from '../src/util/logger';
import { MatchAwarenessImpl } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/awareness';
import { getKnownEnemyDirections } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/common/knownEnemyDirections';
import { calculateMoney, calculateSectorThreat } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/threat/sectorThreat';
import { SECTOR_SIZE } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/map/sectorUtils';
import { getStaticDefencePlacement } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/building/common';
import { AntiAirStaticDefence } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/building/antiAirStaticDefence';
import { MissionController } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController';
import { AttackMissionFactory } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/attackMission';
import { FieldArmyMission } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/fieldArmyMission';
import { selectRadiationGuardPoint } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/radiationGuardMission';

const root = resolve(import.meta.dir, '..');
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const encoded = (value: unknown) => JSON.stringify(value);
const point = (value: { x: number; y: number } | undefined) => value ? { x: value.x, y: value.y } : null;
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

async function sourceVersion() {
    const base = resolve(root, 'src/game/ai/thirdpartbot/builtIn');
    const digest = createHash('sha256');
    for (const path of (await readdir(base, { recursive: true })).filter(path => path.endsWith('.ts')).sort()) {
        digest.update(path).update('\0').update(await Bun.file(resolve(base, path)).text()).update('\0');
    }
    const git = async (...args: string[]) => {
        const child = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
        const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        if (code) throw new Error(error);
        return out.trim();
    };
    const status = await git('status', '--porcelain', '--untracked-files=all', '--', 'src/game');
    return { commit: await git('rev-parse', 'HEAD'), source: 'working-tree', dirty: !!status,
        builtInSourceSha256: digest.digest('hex'),
        engineApiSha256: hash(await Bun.file(resolve(root, 'src/game/api/GameApi.ts')).text()),
        mapApiSha256: hash(await Bun.file(resolve(root, 'src/game/api/MapApi.ts')).text()),
        runnerSha256: hash(await Bun.file(import.meta.path).text()),
        fixtureHelperSha256: hash(await Bun.file(resolve(import.meta.dir, 'ai-specialty-scenarios.ts')).text()) };
}

function emptyTile(game: any, center: { x: number; y: number }, distance: number) {
    const tiles: any[] = [];
    game.map.tiles.forEach((tile: any) => {
        const d = Math.hypot(tile.rx - center.x, tile.ry - center.y);
        if (d <= distance && game.map.terrain.getPassableSpeed(tile, SpeedType.Track, false, false) > 0 &&
            !game.map.getObjectsOnTile(tile).some((object: any) => object.isTechno() || object.isTerrain())) tiles.push(tile);
    });
    return tiles.sort((a, b) => Math.hypot(a.rx - center.x, a.ry - center.y) - Math.hypot(b.rx - center.x, b.ry - center.y) ||
        a.rx - b.rx || a.ry - b.ry)[0];
}

function guardedApi(api: GameApi, ownName: string, reads: string[]) {
    const original = api.getPlayerData.bind(api);
    api.getPlayerData = name => {
        const value = original(name);
        if (name === ownName) return value;
        for (const key of ['startLocation', 'credits', 'power'] as const) {
            Object.defineProperty(value, key, { get() { reads.push(`${name}.${key}`); throw new Error(`Hidden player field read: ${name}.${key}`); } });
        }
        return value;
    };
    return api;
}

async function pairedCase(resources: Awaited<ReturnType<typeof loadSpecialtyResources>>, difficulty: 'normal' | 'brutal', enemyStart: number) {
    const { game, players, bots, options } = createSpecialtyGame(resources, 910031, ['Arabs', 'Russians'], [0, enemyStart]);
    const sensitiveReads: string[] = [];
    const commands: unknown[] = [];
    const snapshots: any[] = [];
    try {
        check(game.map.startingLocations.length >= 4, 'Fixture requires four public starts');
        const ownStart = game.map.startingLocations[0];
        const tankIds: number[] = [];
        const placed: any[] = [];
        for (const spec of [
            { name: 'NACNST', type: ObjectType.Building, x: 4, y: 4 },
            { name: 'NAPOWR', type: ObjectType.Building, x: -5, y: 4 },
            ...[-4, -2, 0, 2].map(x => ({ name: 'HTNK', type: ObjectType.Vehicle, x, y: -4 })),
        ]) {
            const tile = emptyTile(game, { x: ownStart.x + spec.x, y: ownStart.y + spec.y }, 5);
            check(tile, `No clear fixture placement for ${spec.name}`);
            const object = spawnSpecialtyObject(game, { ...spec, label: spec.name, player: 0, x: 0, y: 0 }, tile, players);
            placed.push({ id: object.id, name: object.name, tile: { x: tile.rx, y: tile.ry } });
            if (object.name === 'HTNK') tankIds.push(object.id);
        }
        game.start();
        const originalApi = bots.get(players[0].name)!.gameApi as GameApi;
        const api = guardedApi(originalApi, players[0].name, sensitiveReads);
        const player = api.getPlayerData(players[0].name);
        const bot = bots.get(players[0].name)!;
        const originalOrder = bot.actionsApi.orderUnits.bind(bot.actionsApi);
        bot.actionsApi.orderUnits = (...args: any[]) => {
            commands.push({ tick: game.currentTick, args });
            return originalOrder(...args);
        };
        const awareness = new MatchAwarenessImpl(api as any, player as any, null, player.startLocation.clone(), () => {}, difficulty === 'brutal');
        const controller = new MissionController(() => {});
        const factory = new AttackMissionFactory(-1000);
        const army = difficulty === 'brutal' ? new FieldArmyMission(null, controller, () => {}) : undefined;
        if (army) { controller.addMission(army); tankIds.forEach(id => army.addUnit(id)); }
        const context: any = { difficulty, game: api, player: { name: player.name,
            actions: bot.actionsApi, production: bot.productionApi }, matchAwareness: awareness };
        awareness.onGameStart(api as any, player as any);
        const sample = () => {
            const enemyIds = api.getVisibleUnits(player.name, 'enemy');
            check(enemyIds.length === 0, 'Unexpected contact makes hidden-world comparison invalid');
            const knownTiles: string[] = [];
            game.map.tiles.forEach((tile: any) => { if (api.mapApi.isVisibleTile(tile, player.name)) knownTiles.push(`${tile.rx},${tile.ry}`); });
            const ownObjects = api.getVisibleUnits(player.name, 'self').map(id => api.getUnitData(id))
                .filter(Boolean).map(unit => ({ id: unit!.id, name: unit!.name, tile: { x: unit!.tile.rx, y: unit!.tile.ry }, hp: unit!.hitPoints }));
            const ownData = api.getPlayerData(player.name);
            const observable = { ownStart: point(player.startLocation), ownObjects, enemyIds,
                ownCredits: ownData.credits, ownPower: ownData.power,
                shroudSha256: hash(knownTiles.sort().join('|')) };
            const ground = getStaticDefencePlacement(api as any, player as any, api.rulesApi.buildingRules.get('NALASR')! as any);
            const air = new AntiAirStaticDefence(1, 1, 1).getPlacementLocation(api as any, player as any, api.rulesApi.buildingRules.get('NAFLAK')! as any);
            const guard = selectRadiationGuardPoint(context, 3);
            check(ground && air && guard && controller.getMissions().length > 0, 'Expected policy branch was not exercised');
            snapshots.push({ tick: game.currentTick, observable, observationSha256: hash(encoded(observable)),
                directions: getKnownEnemyDirections(api as any, player as any).map(point), rally: point(awareness.getMainRallyPoint()),
                attackTargets: controller.getMissions().map(mission => ({ name: mission.getUniqueName(),
                    at: point('getAttackArea' in mission ? (mission as FieldArmyMission).getAttackArea() : undefined) })),
                radiationGuard: point(guard), groundPlacement: ground ?? null, airPlacement: air ?? null,
                requests: [...controller.getRequestedUnitTypes()].map(([name, value]) => ({ name, priority: value.priority })),
                expansionCandidates: awareness.getNextExpansionCandidates().map(point),
            });
        };
        while (game.currentTick < 180) {
            game.update();
            if (game.currentTick % 6 === 0) {
                awareness.onAiUpdate(context);
                if (!army && controller.getMissions().length === 0) {
                    factory.maybeCreateMissions(context, controller, () => {}, { composition: { HTNK: 1 }, minimumUnits: 4, maximumUnits: 4 });
                    const mission = controller.getMissions()[0];
                    if (mission) tankIds.forEach(id => mission.addUnit(id));
                }
                controller.onAiUpdate(context);
            }
            if (game.currentTick % 30 === 0) sample();
        }
        return { difficulty, enemyStart, ownStartIndex: 0, playerSlots: players.map((p: any) => p.name),
            physicalStarts: players.map((p: any) => point(game.map.startingLocations[p.startLocation])),
            settings: { credits: options.credits, unitCount: options.unitCount, engineDifficulty: options.aiPlayers?.[0].difficulty },
            fixtureObjects: placed, sensitiveReads, snapshots, commands, ticks: game.currentTick };
    } finally { game.dispose(); }
}

function observationTransitions(resources: Awaited<ReturnType<typeof loadSpecialtyResources>>) {
    const { game, players, bots } = createSpecialtyGame(resources, 910031, ['Arabs', 'Russians'], [0, 2]);
    const reads: string[] = [];
    try {
        const farStart = game.map.startingLocations[2];
        const factoryTile = emptyTile(game, { x: farStart.x + 7, y: farStart.y + 7 }, 6);
        check(factoryTile, 'Missing hidden factory tile');
        const factory = spawnSpecialtyObject(game, { label: 'hidden-factory', name: 'NAWEAP', type: ObjectType.Building,
            player: 1, x: 0, y: 0 }, factoryTile, players);
        const tankTile = emptyTile(game, { x: farStart.x - 7, y: farStart.y - 7 }, 6);
        const tank = spawnSpecialtyObject(game, { label: 'hidden-tank', name: 'HTNK', type: ObjectType.Vehicle,
            player: 1, x: 0, y: 0 }, tankTile, players);
        game.start();
        const api = guardedApi(bots.get(players[0].name)!.gameApi as GameApi, players[0].name, reads);
        const own = api.getPlayerData(players[0].name);
        const shroud = game.mapShroudTrait.getPlayerShroud(players[0]);
        const directions = () => getKnownEnemyDirections(api as any, own as any).map(point);
        const before = directions();
        check(!api.getVisibleUnits(own.name, 'enemy').includes(factory.id), 'Factory is initially visible');
        const threat = () => calculateSectorThreat(tank.tile.rx - 1, tank.tile.ry - 1, 2, api as any, own as any);
        const hiddenThreatBefore = threat();
        tank.healthTrait.setHitPoints(25);
        const hiddenThreatAfter = threat();
        check(hiddenThreatBefore === hiddenThreatAfter && hiddenThreatAfter === 0, 'Hidden HP changed known threat');
        shroud.revealAround(factory.tile, 7); shroud.update();
        const revealed = directions();
        check(api.getVisibleUnits(own.name, 'enemy').includes(factory.id), 'Real shroud reveal failed');
        check(revealed.some(p => p?.x === factory.tile.rx && p.y === factory.tile.ry), 'Revealed factory did not become a known direction');
        shroud.reset();
        for (const object of players[0].getOwnedObjects()) shroud.revealFrom(object);
        shroud.update();
        const reshrouded = directions();
        check(encoded(before) === encoded(reshrouded), 'Reshrouded factory remains a live known target');

        const resource = api.mapApi.getAllTilesResourceData().find((r: any) => r.ore + r.gems > 1 &&
            !api.mapApi.isVisibleTile(r.tile, own.name));
        check(resource, 'No hidden ore available for counterfactual');
        const tile = resource!.tile;
        const overlay = game.map.getObjectsOnTile(tile).find((o: any) => o.isOverlay() && o.isTiberium());
        const tib = overlay.traits.get(TiberiumTrait);
        const money = () => calculateMoney(tile.rx, tile.ry, 1, api.mapApi as any, own.name);
        const unknownBefore = money(), rawBefore = tib.getBailCount();
        tib.removeBails(1);
        const unknownAfter = money(), rawAfter = tib.getBailCount();
        check(rawBefore !== rawAfter && unknownBefore === null && unknownAfter === null, 'Hidden resource mutation leaked or unknown was fabricated as zero');
        shroud.revealAround(tile, 1); shroud.update();
        const knownMoney = money();
        const resourceValues = api.mapApi.getResourceCreditValues();
        const currentResource = api.mapApi.getTileResourceData(tile)!;
        const expectedCredits = currentResource.ore * resourceValues.ore + currentResource.gems * resourceValues.gems;
        check(knownMoney !== null && knownMoney === expectedCredits && knownMoney > 0, 'Visible resource credits do not use actual rule values');

        // Positive budget control: the real 8x8 sector scale must be able to
        // meet the existing 4000-credit expansion threshold after exploration.
        // This reveals the fixture map solely for the calculation; no bot runs.
        shroud.revealAll(); shroud.update();
        const sectorKeys = new Set<string>();
        for (const r of api.mapApi.getAllTilesResourceData()) {
            sectorKeys.add(`${Math.floor(r.tile.rx / SECTOR_SIZE) * SECTOR_SIZE},${Math.floor(r.tile.ry / SECTOR_SIZE) * SECTOR_SIZE}`);
        }
        const sectors = [...sectorKeys].map(key => {
            const [x, y] = key.split(',').map(Number);
            return { x, y, credits: calculateMoney(x, y, SECTOR_SIZE, api.mapApi as any, own.name) };
        }).sort((a, b) => (b.credits ?? -1) - (a.credits ?? -1) || a.x - b.x || a.y - b.y);
        const richestSector = sectors[0];
        check(richestSector && (richestSector.credits ?? 0) >= 4000, 'A genuinely rich revealed sector cannot meet the expansion credit threshold');
        let emptyKnownTile: { x: number; y: number } | undefined;
        game.map.tiles.forEach((candidate: any) => {
            if (!emptyKnownTile && calculateMoney(candidate.rx, candidate.ry, 1, api.mapApi as any, own.name) === 0) {
                emptyKnownTile = { x: candidate.rx, y: candidate.ry };
            }
        });
        check(emptyKnownTile, 'Missing observed empty control tile');
        return { sensitiveReads: reads, before, revealed, reshrouded,
            hiddenThreat: { before: hiddenThreatBefore, after: hiddenThreatAfter },
            resources: { tile: { x: tile.rx, y: tile.ry }, rawBefore, rawAfter, unknownBefore, unknownAfter,
                resourceValues, expectedCredits, knownMoney, richestSector, sectorSize: SECTOR_SIZE, emptyKnownTile,
                expansionBudgetThreshold: 4000, budgetGateOnly: true },
            coverage: 'Real shroud reveal/reset and ordinary TiberiumTrait depletion; not a powered gap-generator interaction or production test.' };
    } finally { game.dispose(); }
}

export async function runInformationBoundaryFixtures(cdn?: string) {
    const sourceBefore = await sourceVersion();
    const resources = await loadSpecialtyResources(cdn, 'mp01t4.map');
    const cases: any[] = [];
    for (const difficulty of ['normal', 'brutal'] as const) for (const start of [1, 2]) cases.push(await pairedCase(resources, difficulty, start));
    const pairs = ['normal', 'brutal'].map(difficulty => {
        const [a, b] = cases.filter(c => c.difficulty === difficulty);
        return { difficulty, observationMatch: a.snapshots.every((s: any, i: number) => s.observationSha256 === b.snapshots[i].observationSha256),
            intentsMatch: encoded(a.snapshots) === encoded(b.snapshots), commandsMatch: encoded(a.commands) === encoded(b.commands),
            commandsPerWorld: [a.commands.length, b.commands.length], snapshotsPerWorld: [a.snapshots.length, b.snapshots.length] };
    });
    const transitions = observationTransitions(resources);
    const sourceAfter = await sourceVersion();
    for (const key of ['builtInSourceSha256', 'engineApiSha256', 'mapApiSha256', 'runnerSha256', 'fixtureHelperSha256'] as const) {
        check(sourceBefore[key] === sourceAfter[key], `${key} source changed during fixture run`);
    }
    return { kind: 'preplaced-real-engine-information-boundary', seed: 910031, map: resources.mapName,
        source: sourceAfter, resources: resources.hashes, cases, pairs, transitions,
        passed: pairs.every(p => p.observationMatch && p.intentsMatch && p.commandsMatch && p.commandsPerWorld.every(n => n > 0)) &&
            cases.every(c => c.sensitiveReads.length === 0) && transitions.sensitiveReads.length === 0,
        limitations: ['Preplaced objects and no-op opposing bots; no economic or strength claim.',
            'Actual awareness and selected mission/building policies, not the full DefaultStrategy or production scheduler.',
            'Only pre-contact windows are compared; physical collision differences are not hidden or removed.',
            'Does not certify disguised/stealth identities, all path-planning information, or powered gap-generator behavior.'] };
}

if (import.meta.main) {
    const { values } = parseArgs({ options: { cdn: { type: 'string', default: process.env.RA2_BENCHMARK_CDN },
        out: { type: 'string', default: '.artifacts/ai-benchmark/information-boundary.json' } } });
    AppLogger.setLevel(AppLogger.ERROR);
    const engineErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { engineErrors.push(args.map(String).join(' ')); originalError(...args); };
    let result: any;
    try {
        const fixtures = await runInformationBoundaryFixtures(values.cdn);
        result = { ...fixtures, passed: fixtures.passed && engineErrors.length === 0, errorCount: engineErrors.length, engineErrors };
    } catch (error) { result = { passed: false, errorCount: engineErrors.length + 1, engineErrors, error: error instanceof Error ? error.stack : String(error) }; }
    finally { console.error = originalError; }
    await mkdir(dirname(resolve(values.out!)), { recursive: true });
    await Bun.write(values.out!, JSON.stringify(result, null, 2) + '\n');
    process.stderr.write(JSON.stringify({ passed: result.passed, errorCount: result.errorCount, pairs: result.pairs, error: result.error }) + '\n');
    if (!result.passed) process.exitCode = 1;
}

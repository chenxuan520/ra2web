/**
 * F3a real-engine visibility mechanics, not AI matches or production evidence.
 * SUB/DLPH and a DEST are preplaced on real navigable water. Cloaking, sensor
 * detection and movement use unchanged rules and the normal simulation/actions.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSpecialtyGame, loadSpecialtyResources, spawnSpecialtyObject } from './ai-specialty-scenarios';
import { ObjectType } from '../src/engine/type/ObjectType';
import { GameApi } from '../src/game/api/GameApi';
import { GameSpeed } from '../src/game/GameSpeed';
import { EventType } from '../src/game/event/EventType';
import { Box2 } from '../src/game/math/Box2';
import { Vector2 } from '../src/game/math/Vector2';
import { OrderType } from '../src/game/order/OrderType';
import { LandType } from '../src/game/type/LandType';
import { SpeedType } from '../src/game/type/SpeedType';
import { AppLogger } from '../src/util/logger';

const root = resolve(import.meta.dir, '..');
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const location = (object: any) => ({ x: object.tile.rx, y: object.tile.ry });

async function sourceVersion() {
    const base = resolve(root, 'src/game');
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
    const files = ['src/game/api/GameApi.ts', 'src/game/BotManager.ts', 'src/game/gameobject/trait/CloakableTrait.ts',
        'src/game/gameobject/trait/SubmergibleTrait.ts', 'src/game/trait/SharedDetectCloakTrait.ts',
        'e2e/ai-specialty-scenarios.ts', 'e2e/tsconfig.ai-observed-visibility.json'];
    return { commit: await git('rev-parse', 'HEAD'), source: 'working-tree',
        workingTreeStatus: await git('status', '--porcelain', '--untracked-files=all', '--', 'src/game',
            'e2e/ai-observed-visibility.ts', 'e2e/tsconfig.ai-observed-visibility.json'),
        gameSourceSha256: digest.digest('hex'), runnerSha256: hash(await Bun.file(import.meta.path).text()),
        files: Object.fromEntries(await Promise.all(files.map(async path => [path, hash(await Bun.file(resolve(root, path)).text())]))) };
}

/** Require a clear three-tile-wide water lane, including the complete approach/retreat path. */
function findWaterLane(game: any) {
    const candidates: any[] = [];
    game.map.tiles.forEach((tile: any) => candidates.push(tile));
    const legal = (x: number, y: number) => {
        const tile = game.map.tiles.getByMapCoords(x, y);
        return tile && game.map.mapBounds.isWithinBounds(tile) && tile.landType === LandType.Water &&
            tile.onBridgeLandType === undefined && game.map.terrain.getPassableSpeed(tile, SpeedType.Float, false, false) > 0 &&
            !game.map.getObjectsOnTile(tile).some((object: any) => object.isTechno() || object.isTerrain());
    };
    return candidates.sort((a, b) => a.rx - b.rx || a.ry - b.ry).find(origin => {
        for (let x = 0; x <= 23; x++) for (let y = -1; y <= 1; y++) if (!legal(origin.rx + x, origin.ry + y)) return false;
        return true;
    });
}

function visibilityCase(resources: Awaited<ReturnType<typeof loadSpecialtyResources>>, name: 'SUB' | 'DLPH') {
    const { game, players, bots, options } = createSpecialtyGame(resources, 930031,
        ['Americans', name === 'SUB' ? 'Arabs' : 'French']);
    const result: any = { targetType: name, fixtureOnly: true, passed: false, snapshots: [], tickTrace: [], events: [], commands: [],
        shroudOperations: [], coverage: {}, gameOptions: { credits: options.credits, unitCount: options.unitCount,
            difficulty: options.aiPlayers.map(p => p.difficulty), countries: players.map(p => p.country.name) } };
    try {
        const origin = findWaterLane(game);
        check(origin, 'No legal clear water lane for the real sensor approach');
        result.origin = { x: origin.rx, y: origin.ry };
        const target = spawnSpecialtyObject(game, { label: 'enemy-submersible', name, type: ObjectType.Vehicle,
            player: 1, x: 2, y: 0 }, origin, players);
        const detector = spawnSpecialtyObject(game, { label: 'moving-sensor', name: 'DEST', type: ObjectType.Vehicle,
            player: 0, x: 22, y: 0 }, origin, players);
        check(target.cloakableTrait && target.submergibleTrait && detector.sensorsTrait, 'Required real traits are absent');
        const initialHp = [target, detector].map(unit => unit.healthTrait.getHitPoints());
        result.setup = [target, detector].map(unit => ({ id: unit.id, name: unit.name, owner: unit.owner.name,
            tile: location(unit), cost: unit.rules.cost, hp: unit.healthTrait.getHitPoints(), speedType: unit.rules.speedType,
            sensorsSight: unit.rules.sensorsSight, sight: unit.rules.sight, primary: unit.rules.primary, secondary: unit.rules.secondary }));
        const cloakTicks = Math.floor(60 * game.rules.general.cloakDelay * GameSpeed.BASE_TICKS_PER_SECOND);
        result.actualRules = { cloakDelayMinutes: game.rules.general.cloakDelay, baseTicksPerSecond: GameSpeed.BASE_TICKS_PER_SECOND,
            cloakCooldownTicks: cloakTicks, sensorRadius: detector.rules.sensorsSight,
            targetPrimaryRange: game.rules.getWeapon(target.rules.primary).range };
        const ids = new Set([target.id, detector.id]);
        game.events.subscribe((event: any) => {
            const unit = event.target ?? event.gameObject;
            if (!unit || !ids.has(unit.id)) return;
            if ([EventType.ObjectCloakChange, EventType.ShipSubmergeChange, EventType.WeaponFire,
                EventType.InflictDamage, EventType.ObjectDestroy].includes(event.type)) {
                result.events.push({ tick: game.currentTick, type: EventType[event.type], id: unit.id,
                    cloaked: unit.cloakableTrait?.isCloaked() ?? false, submerged: unit.submergibleTrait?.isSubmerged() ?? false,
                    weapon: event.weapon?.rules?.name ?? null, damage: event.damageHitPoints ?? null });
            }
        });
        game.start();
        const observerBot = bots.get(players[0].name)!;
        const apis = players.map(player => bots.get(player.name)!.gameApi as GameApi);
        check(apis[0] !== apis[1], 'BotManager supplied the same API object to different bots');
        const diagnostic = GameApi.forDiagnostics(game, true);
        const shrouds = players.map(player => game.mapShroudTrait.getPlayerShroud(player));
        const reveal = () => {
            for (const shroud of shrouds) { shroud.revealAll(); shroud.update(); }
            result.shroudOperations.push({ tick: game.currentTick, operation: 'actual-shroud-revealAll', players: players.map(p => p.name) });
        };
        reveal();
        const area = new Box2(new Vector2(origin.rx, origin.ry - 1), new Vector2(origin.rx + 24, origin.ry + 2));
        const observe = (index: number) => {
            const api = apis[index];
            const filterNames: string[] = [];
            const allFilterNames: string[] = [];
            const unit = api.getUnitData(target.id);
            const object = api.getGameObjectData(target.id);
            return { player: players[index].name,
                target: unit ? { id: unit.id, name: unit.name, tile: { x: unit.tile.rx, y: unit.tile.ry }, hp: unit.hitPoints } : null,
                directObject: object ? { id: object.id, name: object.name, hp: object.hitPoints } : null,
                ownIds: api.getVisibleUnits(players[index].name, 'self'),
                enemyIds: api.getVisibleUnits(players[index].name, 'enemy', rules => { filterNames.push(rules.name); return true; }),
                allIds: api.getAllUnits(rules => { allFilterNames.push(rules.name); return true; }),
                areaIds: api.getUnitsInArea(area), filterNames, allFilterNames };
        };
        const sample = (phase: string, targetVisible: boolean) => {
            // Interleave both views, then repeat the first; no current-player global may leak across calls.
            const enemyBefore = observe(0);
            const owner = observe(1);
            const enemyAfter = observe(0);
            check(JSON.stringify(enemyBefore) === JSON.stringify(enemyAfter), `${phase}: interleaving changed observer state`);
            check(owner.target?.id === target.id && owner.directObject?.id === target.id && owner.ownIds.includes(target.id) &&
                owner.allIds.includes(target.id) && owner.areaIds.includes(target.id), `${phase}: own unit disappeared`);
            check(apis[0].getUnitData(detector.id)?.id === detector.id, `${phase}: observer lost its own detector`);
            check(!!enemyBefore.target === targetVisible && !!enemyBefore.directObject === targetVisible &&
                enemyBefore.enemyIds.includes(target.id) === targetVisible && enemyBefore.allIds.includes(target.id) === targetVisible &&
                enemyBefore.areaIds.includes(target.id) === targetVisible, `${phase}: stale ID or list visibility mismatch`);
            check(enemyBefore.filterNames.includes(name) === targetVisible && enemyBefore.allFilterNames.includes(name) === targetVisible,
                `${phase}: filter received hidden rules, or visible rules never reached filter`);
            check(diagnostic.getUnitData(target.id)?.id === target.id, `${phase}: target is missing from the real world`);
            result.snapshots.push({ phase, tick: game.currentTick, expectedTargetVisible: targetVisible,
                actualCloaked: target.cloakableTrait.isCloaked(), actualSubmerged: target.submergibleTrait.isSubmerged(),
                targetTileShrouded: shrouds[0].isShrouded(target.tile, target.tileElevation),
                targetTile: location(target), detectorTile: location(detector), observer: enemyBefore, owner,
                repeatedObserverMatches: true, diagnosticHasTarget: true });
        };
        const step = () => {
            game.update();
            check(!target.isDestroyed && !detector.isDestroyed, 'Fixture unit destroyed before visibility checks completed');
            result.tickTrace.push({ tick: game.currentTick, target: location(target), detector: location(detector),
                cloaked: target.cloakableTrait.isCloaked(), submerged: target.submergibleTrait.isSubmerged(),
                observerHasTarget: !!apis[0].getUnitData(target.id), ownerHasTarget: !!apis[1].getUnitData(target.id),
                targetHp: target.healthTrait.getHitPoints(), detectorHp: detector.healthTrait.getHitPoints() });
        };
        const until = (predicate: () => boolean, limit: number, message: string) => {
            const end = game.currentTick + limit;
            while (!predicate() && game.currentTick < end) step();
            check(predicate(), `${message} at tick ${game.currentTick}`);
        };
        const moveDetector = (x: number) => {
            result.commands.push({ tick: game.currentTick, player: players[0].name, unitId: detector.id,
                order: 'Move', destination: { x, y: origin.ry } });
            observerBot.actionsApi.orderUnits([detector.id], OrderType.Move, x, origin.ry);
        };
        sample('spawn-uncloaked-visible', true);
        until(() => target.cloakableTrait.isCloaked(), cloakTicks * 3 + 10, 'Natural initial cloak did not occur');
        sample('natural-cloak-old-id-hidden', false);
        check(target.submergibleTrait.isSubmerged(), 'Target cloaked without natural submerge');
        // DEST sensor range (8 in shipped rules) exceeds SUB/DLPH weapon range.
        // Issue Move, not AttackMove; check detection before any weapon event.
        // The DEST's real ASW launcher may fire later during retreat; retain that event.
        check(detector.rules.sensorsSight > result.actualRules.targetPrimaryRange, 'Cannot isolate sensor detection from target weapon range');
        moveDetector(origin.rx + 2 + detector.rules.sensorsSight - 1);
        until(() => !target.cloakableTrait.isCloaked(), 800, 'Moving real detector never uncloaked the target');
        check(result.events.every((event: any) => !['WeaponFire', 'InflictDamage'].includes(event.type)),
            'A shot or damage before detection prevents isolating the sensor-triggered decloak');
        result.sensorDetectedTick = game.currentTick;
        sample('sensor-approach-reveals-old-id', true);
        for (const shroud of shrouds) { shroud.reset(); shroud.update(); }
        result.shroudOperations.push({ tick: game.currentTick, operation: 'actual-shroud-reset', players: players.map(p => p.name) });
        check(shrouds[0].isShrouded(target.tile, target.tileElevation), 'Shroud reset did not cover target');
        sample('reset-shroud-old-id-hidden', false);
        reveal();
        sample('revealed-shroud-old-id-restored', true);
        moveDetector(origin.rx + 22);
        until(() => detector.tile.rx >= origin.rx + 2 + detector.rules.sensorsSight + 2, 800, 'Detector did not leave actual sensor radius');
        result.sensorExitedTick = game.currentTick;
        until(() => target.cloakableTrait.isCloaked(), cloakTicks * 3 + 10, 'Natural recloak after detector exit did not occur');
        sample('sensor-exit-natural-recloak-old-id-hidden', false);
        let foreignViewRejected = false;
        try { apis[0].getVisibleUnits(players[1].name, 'self'); } catch { foreignViewRejected = true; }
        check(foreignViewRejected, 'Observer could request another player view');
        check(result.events.every((event: any) => !['InflictDamage', 'ObjectDestroy'].includes(event.type)),
            'Damage or destruction interfered with the observed cloak sequence');
        check([target, detector].every((unit, index) => unit.healthTrait.getHitPoints() === initialHp[index]), 'Fixture hit points changed');
        result.coverage = { interleavedApiPairs: result.snapshots.length, sampledTicks: result.tickTrace.length,
            naturalInitialCloak: true, sensorMovementUncloak: true, naturalRecloak: true, actualShroudResetReveal: true,
            directIdAndLists: true, hiddenFilterNeverCalled: true, ownerVisibleThroughout: true,
            foreignObserverQueryRejected: foreignViewRejected, weaponFireEventsBeforeDetection: 0,
            laterWeaponFireEvents: result.events.filter((event: any) => event.type === 'WeaponFire').length, damageEvents: 0 };
        result.finalTick = game.currentTick;
        result.passed = true;
    } catch (error) { result.error = error instanceof Error ? error.stack : String(error); }
    finally { game.dispose(); }
    return result;
}

export async function runObservedVisibilityFixtures(cdn?: string) {
    const sourceBefore = await sourceVersion();
    const resources = await loadSpecialtyResources(cdn, 'mp10s4.map');
    const cases = (['SUB', 'DLPH'] as const).map(name => visibilityCase(resources, name));
    const sourceAfter = await sourceVersion();
    const sourceStable = sourceBefore.gameSourceSha256 === sourceAfter.gameSourceSha256 &&
        sourceBefore.runnerSha256 === sourceAfter.runnerSha256 && JSON.stringify(sourceBefore.files) === JSON.stringify(sourceAfter.files);
    return { format: 1, kind: 'preplaced-real-engine-observed-visibility', map: resources.mapName, seed: 930031,
        sourceBefore, sourceAfter, sourceStable, resources: resources.hashes, cases,
        passed: sourceStable && cases.every(result => result.passed),
        tickConvention: 'Events record currentTick inside game.update; snapshots/trace record currentTick after update, normally one greater.',
        limitations: ['Preplaced naval units and no-op bots; not production, economic, full strategy or win-rate evidence.',
            'Revealing/resetting the real shroud is explicit fixture setup; no powered gap generator is exercised.',
            'Only SUB/DLPH hostile cloak and real DEST sensors, two observers and direct/list/filter APIs are covered.',
            'Automatic ASW shots after detection are retained. The window ends at natural recloak; subsequent outcomes are not covered.',
            'Shared allied intel, neutral units, destruction, events, terrain/resource APIs, disguises and remembered-object policies are not certified here.',
            'No rule, cloak cooldown, hit point, weapon, movement speed or sensor-radius mutation is used.'] };
}

if (import.meta.main) {
    const { values } = parseArgs({ options: { cdn: { type: 'string', default: process.env.RA2_BENCHMARK_CDN },
        out: { type: 'string', default: '.artifacts/ai-benchmark/observed-visibility.json' } } });
    AppLogger.setLevel(AppLogger.ERROR);
    const engineErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { engineErrors.push(args.map(String).join(' ')); originalError(...args); };
    let result: any;
    try {
        const fixtures = await runObservedVisibilityFixtures(values.cdn);
        const failures = fixtures.cases.filter(item => !item.passed).length + (fixtures.sourceStable ? 0 : 1);
        result = { ...fixtures, passed: fixtures.passed && engineErrors.length === 0,
            errorCount: engineErrors.length + failures, engineErrors };
    } catch (error) { result = { passed: false, errorCount: engineErrors.length + 1, engineErrors, error: error instanceof Error ? error.stack : String(error) }; }
    finally { console.error = originalError; }
    await mkdir(dirname(resolve(values.out!)), { recursive: true });
    await Bun.write(values.out!, JSON.stringify(result, null, 2) + '\n');
    process.stderr.write(JSON.stringify({ passed: result.passed, errorCount: result.errorCount, sourceStable: result.sourceStable,
        cases: result.cases?.map((item: any) => ({ target: item.targetType, passed: item.passed, tick: item.finalTick, error: item.error })),
        error: result.error }) + '\n');
    if (!result.passed) process.exitCode = 1;
}

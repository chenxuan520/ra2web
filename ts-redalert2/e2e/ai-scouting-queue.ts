/** Real-map scout queue lifecycle only; target assignment is not a completed scouting trip. */
import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSpecialtyGame, loadSpecialtyResources } from './ai-specialty-scenarios';
import { GameApi } from '../src/game/api/GameApi';
import { EventType } from '../src/game/event/EventType';
import { MatchAwarenessImpl } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/awareness';
import { getUnseenStartingLocations, ScoutingManager } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/common/scout';
import { SectorCache } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/map/sector';
import { AppLogger } from '../src/util/logger';

const root = resolve(import.meta.dir, '..');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const point = (value: { x: number; y: number }) => ({ x: value.x, y: value.y });
const key = (value: { x: number; y: number }) => `${value.x},${value.y}`;

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
    const files = ['src/game/api/GameApi.ts', 'src/game/api/MapApi.ts',
        'src/game/ai/thirdpartbot/builtIn/bot/logic/common/scout.ts',
        'src/game/ai/thirdpartbot/builtIn/bot/logic/awareness.ts',
        'src/game/ai/thirdpartbot/builtIn/bot/logic/map/sector.ts',
        'src/game/ai/thirdpartbot/builtIn/bot/logic/map/incrementalGridCache.ts',
        'e2e/ai-specialty-scenarios.ts', 'e2e/tsconfig.ai-scouting-queue.json'];
    return { commit: await git('rev-parse', 'HEAD'), source: 'working-tree',
        workingTreeStatus: await git('status', '--porcelain', '--untracked-files=all', '--', 'src/game',
            'e2e/ai-scouting-queue.ts', 'e2e/tsconfig.ai-scouting-queue.json'),
        gameSourceSha256: digest.digest('hex'), runnerSha256: hash(await Bun.file(import.meta.path).text()),
        files: Object.fromEntries(await Promise.all(files.map(async path => [path, hash(await Bun.file(resolve(root, path)).text())]))) };
}

function drain(manager: ScoutingManager, cache: SectorCache, api: GameApi, playerName: string) {
    const assigned: any[] = [];
    while (manager.hasScoutTargets()) {
        const next = manager.getNewScoutTarget();
        check(next, 'A nonempty real queue returned no target');
        const tile = api.mapApi.getTile(next!.target.x, next!.target.y);
        assigned.push({ target: point(next!.target), priority: next!.priority, permanent: next!.permanent,
            visibleAtAssignment: tile ? api.mapApi.isVisibleTile(tile, playerName) : null,
            sectorVisibilityRatio: cache.getCell(next!.target.x, next!.target.y)?.value.sectorVisibilityRatio ?? null });
        check(assigned.length < 10000, 'Queue did not terminate');
    }
    return assigned;
}

function runCase(resources: Awaited<ReturnType<typeof loadSpecialtyResources>>,
    mode: 'hidden-own-clone' | 'assigned-empty-queue' | 'all-explored') {
    const { game, players, bots, options } = createSpecialtyGame(resources, 940031, ['Arabs', 'Russians'], [0, 1]);
    const result: any = { mode, fixtureOnly: true, passed: false, shroudSetup: [], logs: [], events: [], checkpoints: [],
        assignedTargetCount: 0, revealedTargetCount: null, settings: { credits: options.credits, unitCount: options.unitCount,
            engineDifficulty: options.aiPlayers.map(player => player.difficulty) } };
    try {
        game.events.subscribe((event: any) => {
            if ([EventType.FactoryProduceUnit, EventType.WeaponFire, EventType.InflictDamage, EventType.PlayerDefeated].includes(event.type)) {
                result.events.push({ tick: game.currentTick, type: EventType[event.type] });
            }
        });
        game.start();
        const api = bots.get(players[0].name)!.gameApi as GameApi;
        const player = api.getPlayerData(players[0].name);
        const publicStarts = api.mapApi.getStartingLocations();
        const ownPoint = publicStarts.find(start => key(start) === key(player.startLocation));
        check(ownPoint && ownPoint !== player.startLocation, 'Real MapApi did not return a separate own-start vector');
        result.publicStarts = publicStarts.map(point);
        result.ownStart = point(player.startLocation);
        result.ownStartIsDistinctObject = ownPoint !== player.startLocation;
        const shroud = game.mapShroudTrait.getPlayerShroud(players[0]);
        if (mode === 'hidden-own-clone') {
            shroud.reset(); shroud.update();
            result.shroudSetup.push({ tick: game.currentTick, operation: 'real-shroud-reset',
                note: 'Counterfactual mechanism setup hiding even our own starting tile; no units, rules or enemy positions changed.' });
        } else if (mode === 'all-explored') {
            shroud.revealAll(); shroud.update();
            result.shroudSetup.push({ tick: game.currentTick, operation: 'real-shroud-revealAll',
                note: 'All-explored negative control only; this is not a completed scouting trip or competitive-game visibility.' });
        }
        const ownTile = api.mapApi.getTile(player.startLocation.x, player.startLocation.y)!;
        result.ownStartVisible = api.mapApi.isVisibleTile(ownTile, player.name);
        if (mode === 'hidden-own-clone') check(!result.ownStartVisible, 'Own-start negative control was not actually shrouded');
        const unseen = getUnseenStartingLocations(api as any, player as any);
        result.unseenPublicStarts = unseen.map(point);
        check(!unseen.some(start => key(start) === key(player.startLocation)), 'Unseen-start helper included a cloned own start');
        // Use the production awareness-created SectorCache and its real visibility updater.
        // Prime the cache fully to isolate the queue from incremental scan scheduling.
        const awareness = new MatchAwarenessImpl(api as any, player as any, null, player.startLocation.clone(),
            message => result.logs.push({ tick: game.currentTick, message }), false);
        const cache = awareness.getSectorCache();
        const size = cache.getSize();
        const prime = () => cache.updateSectors(game.currentTick, size.width * size.height * 2);
        prime();
        result.cacheSetup = { type: 'actual MatchAwarenessImpl.getSectorCache()', size,
            primeUpdates: size.width * size.height * 2, visibilitySource: 'actual observer MapApi/shroud; no mock ratios' };
        const manager = awareness.getScoutingManager();
        const expectedPublicStarts = publicStarts.filter(start => {
            const tile = api.mapApi.getTile(start.x, start.y);
            return key(start) !== key(player.startLocation) && tile && !api.mapApi.isVisibleTile(tile, player.name);
        }).map(key).sort();
        awareness.onGameStart(api as any, player as any);
        result.initialAssignedTargets = drain(manager, cache, api, player.name);
        result.assignedTargetCount += result.initialAssignedTargets.length;
        const actualPermanent = result.initialAssignedTargets.filter((target: any) => target.permanent).map((target: any) => key(target.target)).sort();
        check(JSON.stringify(actualPermanent) === JSON.stringify(expectedPublicStarts), 'Initial permanent targets do not match legally unseen public starts');
        check(!actualPermanent.includes(key(player.startLocation)), 'Initial manager queued the cloned own start');
        check(!manager.hasScoutTargets(), 'Public target assignment did not consume the initial queue');
        if (mode === 'hidden-own-clone') {
            check(actualPermanent.length === publicStarts.length - 1, 'Counterfactual did not retain every other shrouded public start');
            result.finalTick = game.currentTick;
            result.passed = true;
            return result;
        }
        if (mode === 'assigned-empty-queue') check(result.initialAssignedTargets.length > 0, 'Positive case lacks actual initial assignments');
        if (mode === 'all-explored') check(result.initialAssignedTargets.length === 0, 'Fully explored map manufactured initial targets');
        const initialRadiusKeys = new Set<string>();
        cache.forEachInRadius(player.startLocation.x, player.startLocation.y, 16, (x, y) => initialRadiusKeys.add(`${x},${y}`));
        for (const checkpoint of [3840, 3959, 3960]) {
            while (game.currentTick < checkpoint) {
                const previous = game.currentTick;
                game.update();
                check(game.currentTick === previous + 1, 'Real simulation stopped before the requested checkpoint');
            }
            prime();
            manager.onAiUpdate(api as any, player as any, cache);
            const assigned = drain(manager, cache, api, player.name);
            result.assignedTargetCount += assigned.length;
            result.checkpoints.push({ tick: game.currentTick, assignedTargets: assigned, assignedTargetCount: assigned.length,
                revealedTargetCount: null, hasTargetsAfterAssignment: manager.hasScoutTargets() });
            if (checkpoint < 3960 || mode === 'all-explored') check(assigned.length === 0, 'Queue expanded early or generated explored targets');
            else {
                check(assigned.length > 0, 'An empty assigned queue prevented the due radius expansion');
                check(assigned.every((target: any) => !target.permanent && target.sectorVisibilityRatio !== null && target.sectorVisibilityRatio < 0.8),
                    'Expanded queue contains a non-sector or sufficiently explored sector');
                check(assigned.some((target: any) => !initialRadiusKeys.has(key(target.target))), 'Due expansion did not reach any sector beyond the original radius');
                const expected: any[] = [];
                cache.forEachInRadius(player.startLocation.x, player.startLocation.y, 33, (x, y, cell, distance) => {
                    if (api.mapApi.getTile(x, y) && cell.value.sectorVisibilityRatio !== null && cell.value.sectorVisibilityRatio < 0.8) {
                        const priority = (900 - distance) * (1 - cell.value.sectorVisibilityRatio);
                        if (priority > 0) expected.push({ target: { x, y }, priority });
                    }
                });
                const normalize = (targets: any[]) => targets.map(target => ({ target: target.target, priority: target.priority }))
                    .sort((a, b) => a.target.x - b.target.x || a.target.y - b.target.y);
                check(JSON.stringify(normalize(expected)) === JSON.stringify(normalize(assigned)), 'Expanded targets/priorities differ from the real radius33 sector cache');
                result.expansionTargetDigest = hash(JSON.stringify(normalize(assigned)));
            }
        }
        manager.onAiUpdate(api as any, player as any, cache);
        check(!manager.hasScoutTargets(), 'Same-tick repeated update requeued an already scanned radius');
        const expansionLogs = result.logs.filter((entry: any) => entry.message.startsWith('expanding scouting radius'));
        check(expansionLogs.length === 1 && expansionLogs[0].tick === 3960 && expansionLogs[0].message === 'expanding scouting radius from 16 to 33',
            'Expansion timing or unchanged radius threshold is incorrect');
        check(result.events.length === 0, 'Unexpected production/combat/defeat in the isolated queue fixture');
        result.finalCredits = players.map(p => p.credits);
        check(result.finalCredits.every((credits: number) => credits === 10000), 'Fixture changed player funds');
        result.finalTick = game.currentTick;
        result.sameTickDoesNotRefill = true;
        result.passed = true;
    } catch (error) { result.error = error instanceof Error ? error.stack : String(error); }
    finally { game.dispose(); }
    return result;
}

export async function runScoutingQueueFixtures(cdn?: string) {
    const sourceBefore = await sourceVersion();
    const resources = await loadSpecialtyResources(cdn, 'mp01t4.map');
    const cases = (['hidden-own-clone', 'assigned-empty-queue', 'all-explored'] as const).map(mode => runCase(resources, mode));
    const sourceAfter = await sourceVersion();
    const sourceStable = sourceBefore.gameSourceSha256 === sourceAfter.gameSourceSha256 &&
        sourceBefore.runnerSha256 === sourceAfter.runnerSha256 && JSON.stringify(sourceBefore.files) === JSON.stringify(sourceAfter.files);
    return { kind: 'real-engine-scouting-queue-mechanism', map: resources.mapName, seed: 940031,
        sourceBefore, sourceAfter, sourceStable, resources: resources.hashes, cases,
        passed: sourceStable && cases.every(item => item.passed), limitations: [
            'Target assignment uses the real getNewScoutTarget API; it does not prove a dog moved or any assigned target was revealed.',
            'revealedTargetCount is not measured and is null, never inferred from the count of assigned targets.',
            'The real awareness-created sector cache is fully primed at checkpoints; normal incremental scheduling and full DefaultStrategy are not exercised.',
            'Hidden-own and fully explored controls explicitly reset/reveal the real shroud; the positive expansion case uses ordinary initial vision.',
            'No extra units, production, combat, funding, altered game rules or hidden enemy data are supplied to the queue.',
            'The preserved radius argument33 is sector-rounded by SectorCache; this does not promise an exact33-tile Euclidean boundary.',
            'These checks establish queue lifecycle, not scouting route quality, paid production or strength.' ] };
}

if (import.meta.main) {
    const { values } = parseArgs({ options: { cdn: { type: 'string', default: process.env.RA2_BENCHMARK_CDN },
        out: { type: 'string', default: '.artifacts/ai-benchmark/scouting-queue.json' } } });
    AppLogger.setLevel(AppLogger.ERROR);
    const engineErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { engineErrors.push(args.map(String).join(' ')); originalError(...args); };
    let result: any;
    try {
        const fixtures = await runScoutingQueueFixtures(values.cdn);
        const failures = fixtures.cases.filter(item => !item.passed).length + (fixtures.sourceStable ? 0 : 1);
        result = { ...fixtures, passed: fixtures.passed && engineErrors.length === 0, errorCount: engineErrors.length + failures, engineErrors };
    } catch (error) { result = { passed: false, errorCount: engineErrors.length + 1, engineErrors, error: error instanceof Error ? error.stack : String(error) }; }
    finally { console.error = originalError; }
    await mkdir(dirname(resolve(values.out!)), { recursive: true });
    await Bun.write(values.out!, JSON.stringify(result, null, 2) + '\n');
    process.stderr.write(JSON.stringify({ passed: result.passed, errorCount: result.errorCount, sourceStable: result.sourceStable,
        cases: result.cases?.map((item: any) => ({ mode: item.mode, passed: item.passed, ticks: item.finalTick,
            assignedTargetCount: item.assignedTargetCount, error: item.error })), error: result.error }) + '\n');
    if (!result.passed) process.exitCode = 1;
}

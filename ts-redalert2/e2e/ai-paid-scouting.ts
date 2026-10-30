/** ARCHIVED DRAFT: setup failed with an impassable factory exit. No completed route experiment; not enabled in CI. */
/** Paid scouting route laboratory. No DefaultStrategy or competitive Bot behavior is changed. */
import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSpecialtyGame, loadSpecialtyResources, spawnSpecialtyObject } from './ai-specialty-scenarios';
import { ObjectType } from '../src/engine/type/ObjectType';
import { EventType } from '../src/game/event/EventType';
import { OrderType } from '../src/game/order/OrderType';
import { SpeedType } from '../src/game/type/SpeedType';
import { QueueType } from '../src/game/player/production/ProductionQueue';
import { Player } from '../src/game/Player';
import { AppLogger } from '../src/util/logger';

type Point = { x: number; y: number };
type Arm = 'S1' | 'S2' | 'R2';
type Scene = 'open' | 'defended';
type Boundary = 'one-unknown' | 'all-explored' | 'unavailable' | 'in-progress' | 'cancel-refund' | 'hidden-permutation';
const root = resolve(import.meta.dir, '..');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const point = (tile: any): Point => ({ x: tile.rx ?? tile.x, y: tile.ry ?? tile.y });
const key = (p: Point) => `${p.x},${p.y}`;
const check = (test: unknown, message: string) => { if (!test) throw new Error(message); };
const ARMS: Arm[] = ['S1', 'S2', 'R2'];
const SCENES: Scene[] = ['open', 'defended'];
const BOUNDARIES: Boundary[] = ['one-unknown', 'all-explored', 'unavailable', 'in-progress', 'cancel-refund', 'hidden-permutation'];
const PUBLIC_OFFSETS: Point[] = [{ x: 4, y: -22 }, { x: 22, y: 12 }, { x: -4, y: 24 }];

/** The only intervention is shared versus exclusive target ownership. No threat/production truth is an input. */
export class PaidScoutRoutes {
    readonly leases = new Map<number, number>();
    readonly events: any[] = [];
    private lastOrders = new Map<number, { tick: number; target: number }>();
    constructor(readonly points: readonly Point[], readonly distinct: boolean) {}
    update(tick: number, dogs: { id: number; tile: { rx: number; ry: number } }[],
        revealed: (point: Point) => boolean, order: (id: number, point: Point, reason: string) => void) {
        const alive = new Set(dogs.map(dog => dog.id));
        for (const [id, target] of this.leases) {
            if (!alive.has(id) || revealed(this.points[target])) {
                this.events.push({ tick, id, target, reason: alive.has(id) ? 'target-revealed' : 'unit-no-longer-owned' });
                this.leases.delete(id);
            }
        }
        const pending = this.points.map((p, index) => ({ p, index })).filter(({ p }) => !revealed(p));
        for (const dog of dogs.slice().sort((a, b) => a.id - b.id)) {
            if (!this.leases.has(dog.id)) {
                const occupied = new Set(this.leases.values());
                const next = pending.find(({ index }) => !this.distinct || !occupied.has(index));
                if (next) {
                    this.leases.set(dog.id, next.index);
                    this.events.push({ tick, id: dog.id, target: next.index, point: next.p, reason: 'assigned-public-target' });
                }
            }
            const target = this.leases.get(dog.id);
            if (target === undefined) continue;
            const last = this.lastOrders.get(dog.id);
            // One common cadence, including the inherited >30-tick refresh, for all arms.
            if (!last || last.target !== target || tick - last.tick > 30) {
                order(dog.id, this.points[target], last?.target === target ? 'same-target-refresh' : 'new-target');
                this.lastOrders.set(dog.id, { tick, target });
            }
        }
    }
}

async function sourceVersion() {
    const git = async (...args: string[]) => {
        const child = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        if (code) throw new Error(err);
        return out.trim();
    };
    const tree = async (directory: string) => {
        const digest = createHash('sha256'); let files = 0;
        for (const file of (await readdir(resolve(root, directory), { recursive: true })).filter(p => p.endsWith('.ts')).sort()) {
            digest.update(file).update('\0').update(await Bun.file(resolve(root, directory, file)).text()).update('\0'); files++;
        }
        return { files, sha256: digest.digest('hex') };
    };
    return { commit: await git('rev-parse', 'HEAD'), source: 'working-tree',
        workingTreeStatus: await git('status', '--porcelain', '--untracked-files=all', '--', 'src/game', 'e2e/ai-paid-scouting.ts', 'e2e/tsconfig.ai-paid-scouting.json'),
        game: await tree('src/game'), engine: await tree('src'),
        runnerSha256: hash(await Bun.file(import.meta.path).text()),
        supportSha256: hash(await Bun.file(resolve(root, 'e2e/ai-specialty-scenarios.ts')).text()),
        tsconfigSha256: hash(await Bun.file(resolve(root, 'e2e/tsconfig.ai-paid-scouting.json')).text()) };
}

type Resources = Awaited<ReturnType<typeof loadSpecialtyResources>>;
type RunConfig = { map: string; side: 0 | 1; scene: Scene; arm: Arm; seed: number; maxTicks: number; boundary?: Boundary; permutation?: 0 | 1 };
function setup(resources: Resources, cfg: RunConfig) {
    const env = createSpecialtyGame(resources, cfg.seed, cfg.side ? ['Americans', 'Arabs'] : ['Arabs', 'Americans'], [0, 1]);
    const { game, players, bots } = env;
    const own = players[cfg.side], enemy = players[1 - cfg.side];
    const sign = cfg.side ? -1 : 1;
    const powerOffset = { x: -7 * sign, y: -3 * sign };
    const barracksOffset = { x: -2 * sign, y: -3 * sign };
    const targetOffsets = PUBLIC_OFFSETS.map(p => ({ x: p.x * sign, y: p.y * sign }));
    // Fixed public fixture geometry; hidden target names/permutation do not participate in site selection.
    const footprints = [
        { point: powerOffset, width: 3, height: 2 },
        { point: barracksOffset, width: 2, height: 2 },
        ...targetOffsets.slice(1).map(p => ({ point: { x: p.x + 2, y: p.y + 2 }, width: 5, height: 3 })),
    ];
    const offsets: Point[] = [...targetOffsets, { x: 2 * sign, y: -12 * sign }];
    for (const f of footprints) for (let x = 0; x < f.width; x++) for (let y = 0; y < f.height; y++) offsets.push({ x: f.point.x + x, y: f.point.y + y });
    // A clear one-cell perimeter around the actual infantry factory includes exit/rally access.
    for (let x = -1; x <= 2; x++) for (let y = -1; y <= 2; y++) offsets.push({ x: barracksOffset.x + x, y: barracksOffset.y + y });
    const ownStart = game.map.startingLocations[own.startLocation];
    check(Number.isFinite(ownStart?.x) && Number.isFinite(ownStart?.y), 'Expected the real numeric player-start index');
    const anchors = players.flatMap(p => p.getOwnedObjects());
    const tiles = game.map.tiles.getAll().slice().sort((a: any, b: any) =>
        Math.hypot(a.rx - ownStart.x, a.ry - ownStart.y) - Math.hypot(b.rx - ownStart.x, b.ry - ownStart.y)
        || a.rx - b.rx || a.ry - b.ry);
    const legal = (tile: any) => tile && game.map.mapBounds.isWithinBounds(tile) && tile.onBridgeLandType === undefined
        && game.map.terrain.getPassableSpeed(tile, SpeedType.Foot, true, false) > 0
        && !game.map.getObjectsOnTile(tile).some((o: any) => o.isTechno() || o.isTerrain());
    const origin = tiles.find((candidate: any) => offsets.every(p => {
        const tile = game.map.tiles.getByMapCoords(candidate.rx + p.x, candidate.ry + p.y);
        return legal(tile) && anchors.every((a: any) => Math.hypot(tile.rx - a.tile.rx, tile.ry - a.tile.ry) >= 12);
    }));
    if (!origin) { const best = tiles.map((t: any) => ({ p: point(t), legal: offsets.filter(p => legal(game.map.tiles.getByMapCoords(t.rx+p.x,t.ry+p.y))).length, bad: offsets.filter(p => !legal(game.map.tiles.getByMapCoords(t.rx+p.x,t.ry+p.y))) })).sort((a: any,b: any)=>b.legal-a.legal).slice(0,3); game.dispose(); throw new Error(`No legal immutable public fixture footprint: ${cfg.map}/side${cfg.side}; offsets=${offsets.length}, best=${JSON.stringify(best)}`); }
    const publicPoints = targetOffsets.map(p => ({ x: origin.rx + p.x, y: origin.ry + p.y }));
    const objects: any[] = [];
    const add = (label: string, name: string, player: number, at: Point) => {
        const object = spawnSpecialtyObject(game, { label, name, type: ObjectType.Building, player, x: at.x, y: at.y }, origin, players);
        objects.push({ label, name, id: object.id, playerSlot: player, owner: object.owner.name, type: object.type, point: point(object.tile) });
        return object;
    };
    add('preplaced-power', 'NAPOWR', cfg.side, powerOffset);
    const barracks = cfg.boundary === 'unavailable' ? undefined : add('preplaced-barracks', 'NAHAND', cfg.side, barracksOffset);
    const names = cfg.permutation ? ['GAAIRC', 'GAWEAP'] : ['GAWEAP', 'GAAIRC'];
    targetOffsets.slice(1).forEach((at, index) => add(`hidden-information-target-${index}`, names[index], 1 - cfg.side, { x: at.x + 2, y: at.y + 2 }));
    // GAPILL requires no power; enemy structures are information targets, not economic or production opponents.
    let guard: any;
    if (cfg.scene === 'defended') {
        const p = { x: 2 * sign, y: -12 * sign };
        check(legal(game.map.tiles.getByMapCoords(origin.rx + p.x, origin.ry + p.y)), 'Guard tile is not legal');
        guard = add('preplaced-route0-pillbox', 'GAPILL', 1 - cfg.side, p);
    }
    game.start();
    const bot = bots.get(own.name)!;
    const api = bot.gameApi;
    const enemyApi = bots.get(enemy.name)!.gameApi;
    // Flush ordinary reveal invalidations caused by all preplaced fixtures before measuring scout coverage.
    for (const p of players) game.mapShroudTrait.getPlayerShroud(p).update();
    const shroud = game.mapShroudTrait.getPlayerShroud(own);
    const sourcePoints = publicPoints.map(p => ({ ...p }));
    if (cfg.boundary === 'one-unknown') publicPoints.splice(1); // Explicit public-input boundary, not hidden target selection.
    if (cfg.boundary === 'all-explored') { shroud.revealAll(); shroud.update(); }
    const visible = (p: Point) => api.mapApi.isVisibleTile(api.mapApi.getTile(p.x, p.y), own.name);
    let exit: Point | null = null;
    const paths: any[] = [];
    if (barracks) {
        const coords = barracks.factoryTrait.computeExitCoords(barracks, barracks.factoryTrait.type);
        const start = game.map.tiles.getByMapCoords(Math.floor(coords.rx), Math.floor(coords.ry));
        check(start && game.map.terrain.getPassableSpeed(start, SpeedType.Foot, true, false) > 0, 'Actual factory exit is impassable');
        exit = point(start);
        for (const endPoint of sourcePoints) {
            const end = game.map.tiles.getByMapCoords(endPoint.x, endPoint.y);
            const path = game.map.terrain.computePath(SpeedType.Foot, true, start, false, end, false, { maxExpandedNodes: 20000, bestEffort: false });
            check(path.length && path[0].tile === end && path.at(-1).tile === start, `No complete actual exit path to ${key(endPoint)}`);
            paths.push({ from: exit, to: endPoint, nodes: path.length, sha256: hash(JSON.stringify(path.map((node: any) => point(node.tile)))) });
        }
    }
    const layout = { map: cfg.map, seed: cfg.seed, side: cfg.side, scene: cfg.scene,
        scoutSlot: cfg.side, scoutPhysicalStart: cfg.side, scoutPlayer: own.name, opponentSlot: 1 - cfg.side,
        playerStarts: players.map((p, slot) => ({ slot, name: p.name, country: p.country.name, startIndex: p.startLocation, point: point(game.map.startingLocations[p.startLocation]) })),
        origin: point(origin), publicPoints: sourcePoints, emptyPublicCandidateIndex: 0, objects, actualBarracksExit: exit,
        postPlacementPaths: paths, initialTargetVisible: sourcePoints.map(visible),
        initialGuardVisible: guard ? api.getGameObjectData(guard.id) !== undefined : null,
        resources: resources.hashes,
        settings: { credits: env.options.credits, extraUnits: env.options.unitCount, engineDifficulty: env.options.aiPlayers.map(p => p.difficulty) },
        productionAvailable: bot.productionApi.getAvailableObjects().some((r: any) => r.name === 'DOG'),
        source: 'Pre-registered public laboratory directions, not hidden enemy locations or autonomous start inference.' };
    if (!cfg.boundary) {
        check(layout.initialTargetVisible.every(v => !v), 'A public target is already explored at setup');
        check(guard === undefined || !layout.initialGuardVisible, 'Pillbox was initially visible');
        check(layout.productionAvailable, 'DOG is unavailable with the actual preplaced prerequisites');
    }
    return { ...env, own, enemy, bot, api, enemyApi, shroud, publicPoints, visible, layout, barracks };
}

function queueView(queue: any) {
    return { size: queue.currentSize, status: queue.status, items: queue.getAll().map((item: any) => ({ name: item.rules.name,
        quantity: item.quantity, creditsEach: item.creditsEach, creditsSpent: item.creditsSpent,
        creditsSpentLeftover: item.creditsSpentLeftover, progress: item.progress })) };
}

export function runPaidScoutCase(resources: Resources, cfg: RunConfig, expectedLayout?: any) {
    const env = setup(resources, cfg);
    const { game, own, enemy, bot, api, enemyApi, shroud, publicPoints, visible, layout } = env;
    const result: any = { identity: { map: cfg.map, seed: cfg.seed, side: cfg.side, scene: cfg.scene, arm: cfg.arm,
        boundary: cfg.boundary ?? null, permutation: cfg.permutation ?? 0 }, maxTicks: cfg.maxTicks, layout,
        fixtureOnly: true, qualificationEligible: false, passed: false, requests: [], queueEvents: [], creditsLedger: [], production: [],
        commands: [], events: [], trajectories: [], revealEvents: [], firstKnownObjects: [], waypointSeen: publicPoints.map(() => null),
        entranceFirstSeenByOpponent: null, perDogRevealAttribution: null, runtimeErrors: [] };
    try {
        if (expectedLayout) check(JSON.stringify(layout) === JSON.stringify(expectedLayout), 'Actual layout differs from registered immutable layout');
        const queue = own.production.getQueue(QueueType.Infantry);
        const creditDescriptor = Object.getOwnPropertyDescriptor(Player.prototype, 'credits')!;
        let mutationContext = 'engine-update';
        Object.defineProperty(own, 'credits', { configurable: true,
            get() { return creditDescriptor.get!.call(own); },
            set(value: number) {
                const before = creditDescriptor.get!.call(own);
                creditDescriptor.set!.call(own, value);
                const after = creditDescriptor.get!.call(own);
                if (before !== after) result.creditsLedger.push({ tick: game.currentTick, before, after, delta: after - before,
                    context: mutationContext, queue: queueView(queue) });
            } });
        queue.onUpdate.subscribe(() => result.queueEvents.push({ tick: game.currentTick, ...queueView(queue) }));
        const initialCredits = own.credits;
        const rules = game.rules.getObject('DOG', ObjectType.Infantry);
        let requested = false, cancelRequested = false;
        const requestedQuantity = cfg.arm === 'S1' ? 1 : 2;
        const routes = new PaidScoutRoutes(publicPoints, cfg.arm === 'R2');
        const allTiles: any[] = game.map.tiles.getAll().filter((tile: any) => game.map.mapBounds.isWithinBounds(tile));
        const initialVisible = new Set(allTiles.filter(tile => !shroud.isShrouded(tile)).map(tile => key(point(tile))));
        const explored = new Set(initialVisible);
        let shroudDirty = false, unionAuc = 0, overlapLeaseTicks = 0;
        const thresholds = Object.fromEntries([100, 250, 500, 1000, 2000].map(n => [String(n), null]));
        const seenObjectIds = new Set<number>();
        let firstHiddenTargetSeen: number | null = null;
        shroud.onChange.subscribe(() => { shroudDirty = true; });
        game.events.subscribe((event: any) => {
            if (event.type === EventType.FactoryProduceUnit && event.target.owner === own) {
                const item = queue.getFirst();
                result.production.push({ tick: game.currentTick, id: event.target.id, name: event.target.name,
                    point: point(event.target.tile), paidCredits: item?.creditsSpent ?? null, nominalCost: item?.creditsEach ?? null,
                    credits: own.credits, factoryExitTaskStillPending: true });
            }
            if ([EventType.WeaponFire, EventType.InflictDamage, EventType.ObjectDestroy, EventType.ObjectOwnerChange, EventType.PlayerDefeated].includes(event.type)) {
                const target = event.target, attacker = event.attacker ?? event.gameObject;
                result.events.push({ tick: game.currentTick, type: EventType[event.type], targetId: target?.id ?? null,
                    targetName: target?.name ?? null, targetOwner: target?.owner?.name ?? null,
                    attackerId: attacker?.id ?? event.attackerInfo?.id ?? null, attackerName: attacker?.name ?? null,
                    attackerOwner: attacker?.owner?.name ?? event.attackerInfo?.player?.name ?? null,
                    weapon: event.weapon?.rules?.name ?? null, damageHitPoints: event.damageHitPoints ?? null,
                    attackerInfo: event.type === EventType.ObjectDestroy ? { playerName: event.attackerInfo?.playerName ?? null,
                        name: event.attackerInfo?.name ?? null } : undefined });
            }
        });
        const legalSnapshot = () => api.getVisibleUnits(own.name, 'enemy').map((id: number) => {
            const data = api.getGameObjectData(id); return data ? { id, name: data.name, point: point(data.tile) } : null;
        }).filter(Boolean);
        const observe = () => {
            const tick = game.currentTick;
            if (shroudDirty) {
                const newTiles: string[] = [];
                for (const tile of allTiles) {
                    const tileKey = key(point(tile));
                    if (!explored.has(tileKey) && !shroud.isShrouded(tile)) { explored.add(tileKey); newTiles.push(tileKey); }
                }
                if (newTiles.length) result.revealEvents.push({ tick, newTiles, totalNew: explored.size - initialVisible.size });
                shroudDirty = false;
            }
            const total = explored.size - initialVisible.size;
            unionAuc += total;
            for (const n of Object.keys(thresholds)) if (thresholds[n] === null && total >= Number(n)) thresholds[n] = tick;
            for (const object of legalSnapshot()) if (!seenObjectIds.has(object.id)) {
                seenObjectIds.add(object.id); result.firstKnownObjects.push({ tick, ...object });
                if (layout.objects.some((o: any) => o.label.startsWith('hidden-information-target-') && o.id === object.id)) firstHiddenTargetSeen ??= tick;
            }
            publicPoints.forEach((p, index) => { if (result.waypointSeen[index] === null && visible(p)) result.waypointSeen[index] = tick; });
            if (result.entranceFirstSeenByOpponent === null && layout.actualBarracksExit
                && enemyApi.mapApi.isVisibleTile(enemyApi.mapApi.getTile(layout.actualBarracksExit.x, layout.actualBarracksExit.y), enemy.name)) {
                result.entranceFirstSeenByOpponent = tick;
            }
            const leases = [...routes.leases.values()];
            if (leases.length > new Set(leases).size) overlapLeaseTicks++;
            if (tick % 30 === 0 || tick === cfg.maxTicks) result.trajectories.push({ tick,
                dogs: api.getVisibleUnits(own.name, 'self', (r: any) => r.name === 'DOG').map((id: number) => {
                    const data = api.getUnitData(id); return { id, point: point(data.tile), health: data.hitPoints, idle: data.isIdle,
                        lease: routes.leases.get(id) ?? null };
                }), newRevealedUnion: total, leaseAssignments: [...routes.leases].map(([id, target]) => ({ id, target })) });
        };
        bot.onGameTick = () => {
            const tick = game.currentTick;
            if (tick % 2) return;
            const dogs = api.getVisibleUnits(own.name, 'self', (r: any) => r.name === 'DOG')
                .map((id: number) => api.getUnitData(id)).filter(Boolean);
            routes.update(tick, dogs, visible, (id, target, reason) => {
                result.commands.push({ tick, id, target: { ...target }, order: 'AttackMove', reason,
                    knownEnemies: legalSnapshot() });
                bot.actionsApi.orderUnits([id], OrderType.AttackMove, target.x, target.y);
            });
            if (!requested && publicPoints.some(p => !visible(p))) {
                const available = bot.productionApi.getAvailableObjects().find((r: any) => r.name === 'DOG');
                if (available && bot.productionApi.getQueueData(QueueType.Infantry).size === 0) {
                    requested = true;
                    result.requests.push({ tick, operation: 'add', name: 'DOG', quantity: requestedQuantity,
                        available: true, queueBefore: bot.productionApi.getQueueData(QueueType.Infantry).size });
                    mutationContext = 'requested-add';
                    bot.actionsApi.queueForProduction(QueueType.Infantry, ObjectType.Infantry, 'DOG', requestedQuantity);
                    mutationContext = 'engine-update';
                }
            }
            if (cfg.boundary === 'cancel-refund' && requested && !cancelRequested && tick >= 30
                && bot.productionApi.getQueueData(QueueType.Infantry).size > 0) {
                cancelRequested = true;
                const quantity = bot.productionApi.getQueueData(QueueType.Infantry).size;
                result.requests.push({ tick, operation: 'cancel', name: 'DOG', quantity, queueBefore: quantity });
                bot.actionsApi.unqueueFromProduction(QueueType.Infantry, ObjectType.Infantry, 'DOG', quantity);
            }
        };
        observe();
        while (game.currentTick < cfg.maxTicks) {
            const previousTick = game.currentTick;
            game.update();
            check(game.currentTick === previousTick + 1, 'Simulation stopped before the registered mechanism cutoff');
            observe();
        }
        const finalQueue = queueView(queue);
        const positive = result.creditsLedger.filter((e: any) => e.delta > 0).reduce((sum: number, e: any) => sum + e.delta, 0);
        const negative = -result.creditsLedger.filter((e: any) => e.delta < 0).reduce((sum: number, e: any) => sum + e.delta, 0);
        const pendingPaid = finalQueue.items.reduce((sum: number, item: any) => sum + item.creditsSpent, 0);
        const completedPaid = result.production.reduce((sum: number, item: any) => sum + item.paidCredits, 0);
        const ownDogs = api.getVisibleUnits(own.name, 'self', (r: any) => r.name === 'DOG');
        const acceptedQuantity = result.queueEvents.reduce((max: number, e: any) => Math.max(max, e.size), 0);
        result.routeEvents = routes.events;
        result.metrics = { initialCredits, finalCredits: own.credits, grossCreditsDecreased: negative, grossCreditsIncreased: positive,
            completedDogCredits: completedPaid, inProgressCredits: pendingPaid,
            creditsReturnedByCancel: cancelRequested ? positive : 0, unexplainedCreditsIncreased: cancelRequested ? 0 : positive,
            availableDogRuleCost: rules.cost, requestCalls: result.requests.filter((r: any) => r.operation === 'add').length,
            requestedQuantity: requested ? requestedQuantity : 0, acceptedQuantity, completedDogs: result.production.length,
            liveDogIds: ownDogs, producedDogsNoLongerOwned: result.production.filter((p: any) => !ownDogs.includes(p.id)).length,
            firstDogTick: result.production[0]?.tick ?? null, firstHiddenTargetSeen, newRevealedUnion: explored.size - initialVisible.size,
            initialExploredTileCount: initialVisible.size, coverageThresholdTicks: thresholds, unionTileTicks: unionAuc,
            overlapLeaseTicks, commands: result.commands.length, repeatedTargetCommands: result.commands.filter((c: any) => c.reason === 'same-target-refresh').length,
            targetCount: publicPoints.length, revealedTargetCount: result.waypointSeen.filter((tick: any) => tick !== null).length,
            finalQueue, finalTick: game.currentTick };
        result.checks = { noPreplacedScouts: !layout.objects.some((o: any) => o.type === ObjectType.Infantry),
            onlyDogsProduced: result.production.every((p: any) => p.name === 'DOG'),
            withinRegisteredBudget: acceptedQuantity <= requestedQuantity && result.production.length <= requestedQuantity,
            productionCostsAccounted: negative === completedPaid + pendingPaid + positive,
            balanceAccounted: initialCredits - negative + positive === own.credits,
            noUnexplainedCredit: cfg.boundary === 'cancel-refund' || positive === 0,
            uniqueLeasesInR2: cfg.arm !== 'R2' || overlapLeaseTicks === 0,
            onlyPublicTargets: result.commands.every((c: any) => publicPoints.some(p => key(p) === key(c.target))),
            cutoffReached: game.currentTick === cfg.maxTicks,
            unavailableDoesNotProduce: cfg.boundary !== 'unavailable' || (!requested && result.production.length === 0 && negative === 0),
            exploredDoesNotProduce: cfg.boundary !== 'all-explored' || (!requested && result.production.length === 0 && negative === 0),
            incompletePaymentRetained: cfg.boundary !== 'in-progress' || (result.production.length === 0 && pendingPaid > 0 && pendingPaid < rules.cost),
            actualCancelRefund: cfg.boundary !== 'cancel-refund' || (cancelRequested && positive > 0 && positive === negative && finalQueue.size === 0) };
        check(Object.values(result.checks).every(Boolean), `Mechanism assertions failed: ${JSON.stringify(result.checks)}`);
        result.passed = true;
    } catch (error) { result.error = error instanceof Error ? error.stack : String(error); }
    finally { game.dispose(); }
    return result;
}

export async function runPaidScouting(options: { cdn?: string; maps?: string[]; sides?: (0 | 1)[]; scenes?: Scene[]; arms?: Arm[];
    maxTicks?: number; seed?: number; repeat?: number; setupOnly?: boolean; plan?: string; noBoundaries?: boolean; boundaryOnly?: boolean } = {}) {
    const sourceBefore = await sourceVersion();
    const maps = options.maps ?? ['mp08t2', 'tn01t2'], sides = options.sides ?? [0, 1], scenes = options.scenes ?? SCENES;
    const arms = options.arms ?? ARMS, seed = options.seed ?? 840101, maxTicks = options.maxTicks ?? 4800, repeat = options.repeat ?? 2;
    check(maps.every(m => ['mp08t2', 'tn01t2'].includes(m)), 'Unknown registered mechanism map');
    check(sides.every(s => s === 0 || s === 1) && scenes.every(s => SCENES.includes(s)) && arms.every(a => ARMS.includes(a)), 'Unknown arm/side/scene');
    check(Number.isSafeInteger(seed) && Number.isSafeInteger(maxTicks) && maxTicks > 0 && Number.isSafeInteger(repeat) && repeat > 0, 'Invalid run limit');
    const resourcesByMap = new Map<string, Resources>();
    for (const map of maps) resourcesByMap.set(map, await loadSpecialtyResources(options.cdn, `${map}.map`));
    const layouts: any[] = [];
    for (const map of maps) for (const side of sides) for (const scene of scenes) {
        const env = setup(resourcesByMap.get(map)!, { map, side, scene, arm: 'S2', seed, maxTicks });
        layouts.push(env.layout); env.game.dispose();
    }
    const layoutDigest = hash(JSON.stringify(layouts));
    if (options.plan) {
        const plan = await Bun.file(options.plan).json();
        check(plan.layoutDigest === layoutDigest && JSON.stringify(plan.layouts) === JSON.stringify(layouts), 'Immutable setup plan mismatch');
    }
    const report: any = { format: 1, kind: options.setupOnly ? 'paid-scouting-layout-registration' : 'real-engine-paid-scouting-route-mechanism',
        seed, maxTicks, requestedRepeat: repeat, setupOnly: !!options.setupOnly, sourceBefore, layouts, layoutDigest,
        runs: [], boundaries: [], deterministicPairs: [], routePairs: [], qualificationEligible: false,
        limitations: ['Preplaced facilities and targets isolate a mechanism; this is not a normal MCV economic opening or a full Bot match.',
            'S1 changes dog quantity/cost. Only S2 versus R2 is the route-only comparison; both make one Add request quantity2 to the same real sequential queue.',
            'The controller receives only its own units, legal explored tiles, and registered public laboratory directions. The observer alone records hidden setup, damage and paths.',
            'All dogs use actual prerequisites, credits, build time and factory exits. No replacement dogs, retreat, threat avoidance or reactive production is added.',
            'Per-dog reveal attribution is not measured. Same-tick reveal is a team union, never assigned to an arbitrary dog.',
            '30-tick positions measure paths at that cadence; stationary samples do not establish waiting, while commands and shroud changes are recorded separately.',
            'Tick cutoffs are mechanism censoring, not 27000-tick match draws or win-rate samples. Repeats establish determinism, not independent evidence.'] };
    if (!options.setupOnly && !options.boundaryOnly) {
        for (const map of maps) for (const side of sides) for (const scene of scenes) for (const arm of arms) {
            const expected = layouts.find((l: any) => l.map === map && l.side === side && l.scene === scene);
            const copies: any[] = [];
            for (let iteration = 0; iteration < repeat; iteration++) {
                const run = runPaidScoutCase(resourcesByMap.get(map)!, { map, side, scene, arm, seed, maxTicks }, expected);
                const digest = hash(JSON.stringify(run));
                report.runs.push({ ...run, repeat: iteration, contentSha256: digest }); copies.push({ iteration, digest });
                process.stderr.write(JSON.stringify({ map, side, scene, arm, iteration, passed: run.passed, metrics: run.metrics, error: run.error }) + '\n');
            }
            report.deterministicPairs.push({ map, side, scene, arm, copies, identical: new Set(copies.map(x => x.digest)).size === 1 });
        }
        for (const map of maps) for (const side of sides) for (const scene of scenes) {
            const s2 = report.runs.find((r: any) => r.identity.map === map && r.identity.side === side && r.identity.scene === scene && r.identity.arm === 'S2' && r.repeat === 0);
            const r2 = report.runs.find((r: any) => r.identity.map === map && r.identity.side === side && r.identity.scene === scene && r.identity.arm === 'R2' && r.repeat === 0);
            if (s2 && r2) report.routePairs.push({ map, side, scene,
                sameRequests: JSON.stringify(s2.requests) === JSON.stringify(r2.requests),
                sameProduction: JSON.stringify(s2.production) === JSON.stringify(r2.production),
                sameCreditLedger: JSON.stringify(s2.creditsLedger) === JSON.stringify(r2.creditsLedger),
                s2: s2.metrics, r2: r2.metrics });
        }
    }
    if (!options.setupOnly && !options.noBoundaries) {
        const map = maps[0], resources = resourcesByMap.get(map)!;
        for (const boundary of BOUNDARIES) {
            const limit = boundary === 'in-progress' ? 20 : boundary === 'cancel-refund' ? 60 : boundary === 'hidden-permutation' ? maxTicks : 600;
            const permutations: (0 | 1)[] = boundary === 'hidden-permutation' ? [0, 1] : [0];
            for (const permutation of permutations) report.boundaries.push(runPaidScoutCase(resources,
                { map, side: 0, scene: 'open', arm: 'R2', seed, maxTicks: limit, boundary, permutation }));
        }
        const hidden = report.boundaries.filter((r: any) => r.identity.boundary === 'hidden-permutation');
        if (hidden.length === 2) {
            const cutoff = Math.min(...hidden.map((r: any) => r.metrics?.firstHiddenTargetSeen ?? maxTicks));
            const prefixes = hidden.map((r: any) => r.commands.filter((c: any) => c.tick < cutoff));
            report.hiddenPermutationCheck = { cutoffExclusive: cutoff, prefixesEqual: JSON.stringify(prefixes[0]) === JSON.stringify(prefixes[1]),
                prefixCommands: prefixes.map((p: any) => p.length), prefixSha256: prefixes.map((p: any) => hash(JSON.stringify(p))),
                note: 'Compare commands before either world legally observes a permuted target. Later reactions are not constrained by this check.' };
        }
    }
    report.sourceAfter = await sourceVersion();
    report.sourceStable = JSON.stringify(sourceBefore) === JSON.stringify(report.sourceAfter);
    report.passed = report.sourceStable && report.runs.every((r: any) => r.passed) && report.boundaries.every((r: any) => r.passed)
        && report.deterministicPairs.every((r: any) => r.identical) && (!report.hiddenPermutationCheck || report.hiddenPermutationCheck.prefixesEqual);
    return report;
}

if (import.meta.main) {
    const { values } = parseArgs({ options: { cdn: { type: 'string', default: process.env.RA2_BENCHMARK_CDN },
        maps: { type: 'string', default: 'mp08t2,tn01t2' }, sides: { type: 'string', default: '0,1' },
        scenes: { type: 'string', default: 'open,defended' }, arms: { type: 'string', default: 'S1,S2,R2' },
        seed: { type: 'string', default: '840101' }, 'max-ticks': { type: 'string', default: '4800' }, repeat: { type: 'string', default: '2' },
        'setup-only': { type: 'boolean', default: false }, 'boundary-only': { type: 'boolean', default: false },
        'no-boundaries': { type: 'boolean', default: false }, plan: { type: 'string' },
        out: { type: 'string', default: '.artifacts/ai-benchmark/paid-scouting.json' } } });
    AppLogger.setLevel(AppLogger.ERROR);
    const errors: string[] = [], warnings: string[] = [];
    const oldError = console.error, oldWarn = console.warn;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); oldError(...args); };
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); oldWarn(...args); };
    let report: any;
    try {
        report = await runPaidScouting({ cdn: values.cdn, maps: values.maps!.split(','), sides: values.sides!.split(',').map(Number) as (0 | 1)[],
            scenes: values.scenes!.split(',') as Scene[], arms: values.arms!.split(',') as Arm[], seed: Number(values.seed), maxTicks: Number(values['max-ticks']),
            repeat: Number(values.repeat), setupOnly: values['setup-only'], noBoundaries: values['no-boundaries'], boundaryOnly: values['boundary-only'], plan: values.plan });
        report.engineErrors = errors; report.engineWarnings = warnings;
        report.errorCount = errors.length + report.runs.filter((r: any) => !r.passed).length + report.boundaries.filter((r: any) => !r.passed).length;
        report.passed &&= errors.length === 0;
    } catch (error) { report = { passed: false, errorCount: errors.length + 1, engineErrors: errors, engineWarnings: warnings,
        error: error instanceof Error ? error.stack : String(error) }; }
    finally { console.error = oldError; console.warn = oldWarn; }
    await mkdir(dirname(resolve(values.out!)), { recursive: true });
    await Bun.write(values.out!, JSON.stringify(report, null, 2) + '\n');
    process.stderr.write(JSON.stringify({ passed: report.passed, setupOnly: report.setupOnly, layouts: report.layouts?.length,
        runs: report.runs?.length, boundaries: report.boundaries?.length, errorCount: report.errorCount, error: report.error }) + '\n');
    if (!report.passed) process.exitCode = 1;
}

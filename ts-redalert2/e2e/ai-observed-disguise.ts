/**
 * F3b preplaced real-engine mechanics, not AI matches or paid-production evidence.
 * Disguise, movement, auto-acquisition, firing and damage use unchanged shipped
 * rules and real ActionsApi orders. Only the explicitly recorded setup uses the
 * referee's real object handles and reveal/reset shroud operations.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSpecialtyGame, loadSpecialtyResources, spawnSpecialtyObject } from './ai-specialty-scenarios';
import { ObjectType } from '../src/engine/type/ObjectType';
import { GameApi } from '../src/game/api/GameApi';
import { EventType } from '../src/game/event/EventType';
import { Box2 } from '../src/game/math/Box2';
import { Vector2 } from '../src/game/math/Vector2';
import { OrderType } from '../src/game/order/OrderType';
import { MoveState } from '../src/game/gameobject/trait/MoveTrait';
import { SpeedType } from '../src/game/type/SpeedType';
import { AppLogger } from '../src/util/logger';

const root = resolve(import.meta.dir, '..');
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const location = (object: any) => ({ x: object.tile.rx, y: object.tile.ry });
const forbiddenExternalFields = ['hitPoints', 'maxHitPoints', 'healthRatio', 'primaryWeapon', 'secondaryWeapon', 'deathWeapon',
    'sight', 'purchaseValue', 'guardMode', 'isIdle', 'factory', 'rallyPoint', 'harvestedOre', 'harvestedGems', 'ammo',
    'isFiring', 'stance', 'passengerSlotCount', 'passengerSlotMax', 'garrisonUnitCount', 'garrisonUnitsMax', 'attackState', 'isDisguised', 'trueOwner'];

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
    const files = ['src/game/api/GameApi.ts', 'src/game/api/ActionsApi.ts', 'src/game/api/interface/GameObjectData.ts',
        'src/game/api/interface/UnitData.ts', 'src/game/BotManager.ts', 'src/game/gameobject/Projectile.ts',
        'src/game/gameobject/trait/DisguiseTrait.ts', 'src/game/gameobject/trait/AttackTrait.ts',
        'src/game/trait/SharedDetectDisguiseTrait.ts', 'src/game/order/AttackOrder.ts',
        'e2e/ai-specialty-scenarios.ts', 'e2e/tsconfig.ai-observed-disguise.json'];
    return { commit: await git('rev-parse', 'HEAD'), source: 'working-tree',
        workingTreeStatus: await git('status', '--porcelain', '--untracked-files=all', '--', 'src/game',
            'e2e/ai-observed-disguise.ts', 'e2e/tsconfig.ai-observed-disguise.json'),
        gameSourceSha256: digest.digest('hex'), runnerSha256: sha(await Bun.file(import.meta.path).text()),
        files: Object.fromEntries(await Promise.all(files.map(async path => [path, sha(await Bun.file(resolve(root, path)).text())]))) };
}

/** A real unobstructed lane, away from both starting MCVs; no terrain is deleted. */
function findLandLane(game: any) {
    const candidates: any[] = [];
    game.map.tiles.forEach((tile: any) => candidates.push(tile));
    return candidates.sort((a, b) => a.rx - b.rx || a.ry - b.ry).find(origin => {
        if (game.getCombatants().some((player: any) => player.getOwnedObjects().some((unit: any) =>
            Math.hypot(Math.max(origin.rx - 1 - unit.tile.rx, 0, unit.tile.rx - (origin.rx + 20)),
                Math.max(origin.ry - 1 - unit.tile.ry, 0, unit.tile.ry - (origin.ry + 1))) < 18))) return false;
        for (let x = -1; x < 20; x++) for (let y = -1; y < 2; y++) {
            const tile = game.map.tiles.getByMapCoords(origin.rx + x, origin.ry + y);
            if (!tile || tile.z !== origin.z || !game.map.mapBounds.isWithinBounds(tile) || tile.onBridgeLandType !== undefined ||
                game.map.terrain.getPassableSpeed(tile, SpeedType.Track, false, false) <= 0 ||
                game.map.terrain.getPassableSpeed(tile, SpeedType.Foot, false, false) <= 0 ||
                game.map.getObjectsOnTile(tile).some((object: any) => object.isTechno() || object.isTerrain())) return false;
        }
        return true;
    });
}

function compactData(data: any) {
    if (!data) return null;
    return { id: data.id, name: data.name, type: data.type, owner: data.owner ?? null,
        keys: Object.keys(data).sort(), definedKeys: Object.keys(data).filter(key => data[key] !== undefined).sort(),
        tile: { x: data.tile.rx, y: data.tile.ry }, direction: data.direction ?? null,
        healthLevel: data.healthLevel ?? null, actualHp: data.hitPoints ?? null,
        actualMaxHp: data.maxHitPoints ?? null, primaryWeapon: data.primaryWeapon?.rules?.name ?? null,
        rules: { name: data.rules.name, type: data.rules.type, cost: data.rules.cost, strength: data.rules.strength,
            primary: data.rules.primary, secondary: data.rules.secondary, armor: data.rules.armor, sight: data.rules.sight },
        foundation: data.foundation, onBridge: data.onBridge ?? null, zone: data.zone ?? null,
        passengerSlotCount: data.passengerSlotCount ?? null, passengerSlotMax: data.passengerSlotMax ?? null };
}

function makeHarness(resources: Awaited<ReturnType<typeof loadSpecialtyResources>>, name: string, seed: number) {
    const { game, players, bots, options } = createSpecialtyGame(resources, seed, ['Americans', 'French']);
    const result: any = { name, seed, fixtureOnly: true, passed: false, setup: [], snapshots: [], tickTrace: [], events: [], commands: [],
        shroudOperations: [], assertions: 0, gameOptions: { credits: options.credits, unitCount: options.unitCount,
            difficulty: options.aiPlayers.map(player => player.difficulty), countries: players.map(player => player.country.name) } };
    const assert = (condition: unknown, message: string) => { result.assertions++; check(condition, `${name}: ${message}`); };
    const origin = findLandLane(game);
    assert(origin, 'No real clear lane available');
    result.origin = { x: origin.rx, y: origin.ry };
    result.effectiveRulesIniSha256 = sha(game.rules.getIni().toString());
    result.originalSharedDetectorRules = [...game.rules.buildingRules.values(), ...game.rules.infantryRules.values(),
        ...game.rules.vehicleRules.values(), ...game.rules.aircraftRules.values()]
        .filter((rules: any) => rules.detectDisguiseRange > 0)
        .map((rules: any) => ({ name: rules.name, type: rules.type, detectDisguiseRange: rules.detectDisguiseRange }));
    const objects: any[] = [];
    const ids = new Set<number>();
    const spawn = (name: string, owner: 0 | 1, x: number, y = 0) => {
        const type = ['SPY', 'ENGINEER', 'E1', 'DOG', 'ADOG'].includes(name) ? ObjectType.Infantry
            : ['NAPOWR', 'NAPSIS'].includes(name) ? ObjectType.Building : ObjectType.Vehicle;
        const object = spawnSpecialtyObject(game, { label: name, name, type, player: owner, x, y }, origin, players);
        objects.push(object); ids.add(object.id);
        result.setup.push({ id: object.id, name: object.name, type: object.type, owner: object.owner.name, tile: location(object),
            cost: object.rules.cost, actualHp: object.healthTrait.getHitPoints(), primary: object.rules.primary,
            secondary: object.rules.secondary, detectDisguise: object.rules.detectDisguise,
            detectDisguiseRange: object.rules.detectDisguiseRange, permaDisguise: object.rules.permaDisguise,
            disguiseWhenStill: object.rules.disguiseWhenStill });
        return object;
    };
    game.events.subscribe((event: any) => {
        const object = event.target ?? event.gameObject ?? event.transport;
        if ([EventType.PowerLow, EventType.PowerRestore].includes(event.type)) {
            result.events.push({ tick: game.currentTick, type: EventType[event.type], player: object?.name ?? null,
                power: object?.powerTrait?.power ?? null, drain: object?.powerTrait?.drain ?? null });
            return;
        }
        if (!object || !ids.has(object.id)) return;
        if (![EventType.ObjectDisguiseChange, EventType.WeaponFire, EventType.InflictDamage, EventType.ObjectDestroy,
            EventType.EnterTransport, EventType.LeaveTransport, EventType.HealthChange, EventType.ObjectSell].includes(event.type)) return;
        const attacker = event.attacker ?? event.attackerInfo;
        const disguise = object.disguiseTrait?.getDisguise();
        result.events.push({ tick: game.currentTick, type: EventType[event.type], id: object.id, name: object.name,
            owner: object.owner?.name ?? null, tile: location(object), disguise: disguise?.rules.name ?? null,
            apparentOwner: disguise?.owner?.name ?? null, weapon: event.weapon?.rules?.name ?? null,
            damage: event.damageHitPoints ?? null, previousHealth: event.prevHealth ?? null, health: event.currentHealth ?? null, actualHp: object.healthTrait?.getHitPoints() ?? null,
            attackerId: attacker?.obj?.id ?? attacker?.id ?? null, attackerName: attacker?.obj?.name ?? null,
            attackerPlayer: attacker?.player?.name ?? null, attackerWeapon: attacker?.weapon?.rules?.name ?? null });
    });
    let apis: GameApi[] = [];
    let shrouds: any[] = [];
    const area = new Box2(new Vector2(origin.rx - 1, origin.ry - 1), new Vector2(origin.rx + 20, origin.ry + 2));
    const reveal = () => {
        for (const shroud of shrouds) { shroud.revealAll(); shroud.update(); }
        result.shroudOperations.push({ tick: game.currentTick, operation: 'actual-shroud-revealAll', players: players.map(player => player.name) });
    };
    const start = () => {
        game.start();
        apis = players.map(player => bots.get(player.name)!.gameApi as GameApi);
        assert(apis[0] !== apis[1], 'The two bots share the same GameApi');
        let foreignViewRejected = false;
        try { apis[0].getVisibleUnits(players[1].name, 'self'); } catch { foreignViewRejected = true; }
        assert(foreignViewRejected, 'Observer can request another player inventory');
        result.foreignViewRejected = foreignViewRejected;
        shrouds = players.map(player => game.mapShroudTrait.getPlayerShroud(player));
        reveal();
    };
    const observe = (index: number, object: any) => {
        const api = apis[index];
        const filterNames: string[] = [];
        const allIds = api.getAllUnits(rules => { filterNames.push(rules.name); return true; });
        return { player: players[index].name, unit: compactData(api.getUnitData(object.id)),
            generic: compactData(api.getGameObjectData(object.id)), all: allIds.includes(object.id),
            self: api.getVisibleUnits(players[index].name, 'self').includes(object.id),
            allied: api.getVisibleUnits(players[index].name, 'allied').includes(object.id),
            enemy: api.getVisibleUnits(players[index].name, 'enemy').includes(object.id),
            hostile: api.getVisibleUnits(players[index].name, 'hostile').includes(object.id),
            neutral: api.getNeutralUnits().includes(object.id), area: api.getUnitsInArea(area).includes(object.id),
            terrain: api.getAllTerrainObjects().includes(object.id), filterNames };
    };
    const snapshot = (phase: string, object: any, appearance: 'unit' | 'tree' | 'hidden' | 'gone') => {
        const before = observe(0, object);
        const owner = observe(1, object);
        const after = observe(0, object);
        assert(JSON.stringify(before) === JSON.stringify(after), `${phase}: dual-observer interleaving changed output`);
        if (appearance === 'gone') {
            assert(!before.unit && !before.generic && !owner.unit && !owner.generic && !before.all && !before.terrain,
                `${phase}: destroyed identity remained observable`);
        } else {
            assert(owner.unit?.name === object.name && owner.unit.actualHp === object.healthTrait.getHitPoints() && owner.self,
                `${phase}: real owner lost actual identity or HP`);
            if (appearance === 'hidden') {
                assert(!before.unit && !before.generic && !before.all && !before.area && !before.enemy && !before.hostile && !before.terrain,
                    `${phase}: hidden ID survived a lookup or list`);
            } else {
                const actualDisguise = players[0].sharedDetectDisguiseTrait.has(object) ? undefined : object.disguiseTrait?.getDisguise();
                const expectedName = actualDisguise?.rules.name ?? object.name;
                assert(before.generic?.name === expectedName, `${phase}: generic appearance mismatch`);
                for (const key of forbiddenExternalFields) assert(!(key in apis[0].getGameObjectData(object.id)!), `${phase}: external generic leaks ${key}`);
                if (appearance === 'tree') {
                    assert(!before.unit && !before.all && !before.area && !before.enemy && !before.hostile && before.terrain &&
                        before.generic?.type === ObjectType.Terrain && before.generic.owner === null,
                        `${phase}: tree appearance leaks a unit or real owner`);
                    assert(!before.filterNames.includes(object.name), `${phase}: unit filter received the hidden tank rules`);
                } else {
                    const apparentOwner = actualDisguise?.owner ?? object.owner;
                    assert(before.unit?.name === expectedName && before.unit.owner === apparentOwner?.name && before.all && before.area,
                        `${phase}: unit appearance/owner/list mismatch`);
                    assert(!before.self && !before.allied, `${phase}: false colors grant controlled inventory`);
                    assert(before.enemy === (apparentOwner !== players[0]) && before.hostile === (apparentOwner !== players[0]),
                        `${phase}: enemy relation ignores apparent ownership`);
                    assert(before.filterNames.includes(expectedName), `${phase}: unit filter did not receive apparent rules`);
                    if (expectedName !== object.name) assert(!before.filterNames.includes(object.name), `${phase}: filter received hidden real rules`);
                    const raw = apis[0].getUnitData(object.id)!;
                    for (const key of forbiddenExternalFields) assert(!(key in raw), `${phase}: external unit leaks ${key}`);
                    assert([0, 1, 2].includes(raw.healthLevel!), `${phase}: absent or non-discrete visible health level`);
                }
            }
        }
        result.snapshots.push({ phase, tick: game.currentTick, expectedAppearance: appearance,
            trueName: object.name, trueOwner: object.owner.name, tile: location(object),
            observerShrouded: shrouds[0].isShrouded(object.tile, object.tileElevation),
            sharedDetection: players[0].sharedDetectDisguiseTrait.has(object), observer: before, owner,
            repeatedObserverMatches: true });
        return before;
    };
    const reset = () => {
        for (const shroud of shrouds) { shroud.reset(); shroud.update(); }
        result.shroudOperations.push({ tick: game.currentTick, operation: 'actual-shroud-reset', players: players.map(player => player.name) });
    };
    const step = () => {
        game.update();
        result.tickTrace.push({ tick: game.currentTick, objects: objects.map(object => ({ id: object.id,
            tile: location(object), destroyed: object.isDestroyed, actualHp: object.healthTrait?.getHitPoints() ?? null,
            disguise: object.disguiseTrait?.getDisguise()?.rules.name ?? null,
            disguiseOwner: object.disguiseTrait?.getDisguise()?.owner?.name ?? null,
            moveState: object.moveTrait?.moveState ?? null,
            observerName: apis[0].getUnitData(object.id)?.name ?? null,
            observerGenericName: apis[0].getGameObjectData(object.id)?.name ?? null,
            ownerName: apis[1].getUnitData(object.id)?.name ?? null,
            sharedDetection: players[0].sharedDetectDisguiseTrait.has(object) })) });
    };
    const until = (predicate: () => boolean, limit: number, message: string) => {
        const end = game.currentTick + limit;
        while (!predicate() && game.currentTick < end) step();
        assert(predicate(), `${message}; tick=${game.currentTick}`);
    };
    const command = (index: 0 | 1, object: any, order: OrderType, x?: number, y?: number) => {
        result.commands.push({ tick: game.currentTick, player: players[index].name, unitId: object.id, order: OrderType[order],
            targetId: x !== undefined && y === undefined ? x : null, tile: y !== undefined ? { x, y } : null });
        bots.get(players[index].name)!.actionsApi.orderUnits([object.id], order, x, y);
    };
    const finish = () => {
        result.finalTick = game.currentTick;
        result.finalCredits = players.map(player => player.credits);
        if (!result.realSaleSetup) assert(result.finalCredits.every((credits: number) => credits === options.credits), 'Mechanism fixture changed credits');
        else assert(result.events.filter((event: any) => event.type === 'ObjectSell').length === 1 &&
            result.finalCredits[0] > options.credits && result.finalCredits[1] === options.credits, 'Expected real sale income not isolated');
        assert(sha(game.rules.getIni().toString()) === result.effectiveRulesIniSha256, 'Effective rules INI changed during fixture');
        result.passed = true;
    };
    return { game, players, bots, origin, result, assert, spawn, start, snapshot, reset, reveal, step, until, command, finish,
        api: (index: number) => apis[index], observe };
}

type Harness = ReturnType<typeof makeHarness>;
function runCase(resources: Awaited<ReturnType<typeof loadSpecialtyResources>>, name: string, seed: number, body: (h: Harness) => void) {
    let h: Harness | undefined;
    try { h = makeHarness(resources, name, seed); body(h); h.finish(); return h.result; }
    catch (error) { return { ...(h?.result ?? { name, passed: false }), error: error instanceof Error ? error.stack : String(error) }; }
    finally { h?.game.dispose(); }
}

function spyAppearanceCase(resources: Awaited<ReturnType<typeof loadSpecialtyResources>>) {
    return runCase(resources, 'spy-real-makeup-same-external-E1-shape', 930041, h => {
        const spy = h.spawn('SPY', 1, 3);
        const realE1 = h.spawn('E1', 1, 18);
        h.start();
        h.result.actualRules = { primary: spy.primaryWeapon.rules.name, warhead: spy.primaryWeapon.warhead.rules.name,
            makesDisguise: spy.primaryWeapon.warhead.rules.makesDisguise, permaDisguise: spy.rules.permaDisguise };
        h.assert(h.result.actualRules.makesDisguise === true, 'Actual primary warhead is not MakesDisguise');
        // ForceAttack is required for a same-owner target. The actual MakeupKit
        // and Snapshot warhead still execute; no trait state is written here.
        h.command(1, spy, OrderType.ForceAttack, realE1.id);
        h.until(() => h.result.events.some((e: any) => e.type === 'ObjectDisguiseChange' && e.id === spy.id), 60, 'Actual MakeupKit disguise event absent');
        h.assert(h.result.events.some((e: any) => e.type === 'WeaponFire' && e.id === spy.id && e.weapon === 'MakeupKit'), 'No actual MakeupKit shot');
        const observed = h.snapshot('actual-copy-enemy-color-E1', spy, 'unit');
        const real = h.observe(0, realE1);
        h.assert(JSON.stringify(observed.unit.keys) === JSON.stringify(real.unit!.keys), 'Foreign SPY and real E1 field existence differs');
        h.assert(JSON.stringify(observed.unit.definedKeys) === JSON.stringify(real.unit!.definedKeys), 'Foreign SPY and real E1 defined fields differ');
        h.assert(JSON.stringify(observed.unit.rules) === JSON.stringify(real.unit!.rules) && observed.unit.healthLevel === real.unit!.healthLevel,
            'Same apparent E1 public rules or healthy display differ');
        h.assert(JSON.stringify(observed.generic.keys) === JSON.stringify(real.generic!.keys), 'Generic same-appearance field existence differs');
        h.result.sameAppearanceComparison = { spy: observed, realE1: real, equalKeys: true, equalDefinedKeys: true,
            aligned: ['apparent name/type/owner/rules', 'visible healthy level', 'external access permissions'],
            notAligned: ['id', 'position', 'direction: not a full spatial counterfactual'],
            trueHp: { spy: spy.healthTrait.getHitPoints(), realE1: realE1.healthTrait.getHitPoints() } };
        h.reset(); h.snapshot('copied-disguise-reset-shroud', spy, 'hidden');
        h.reveal(); h.snapshot('copied-disguise-reveal-shroud', spy, 'unit');
        h.assert(h.result.events.every((e: any) => !['InflictDamage', 'ObjectDestroy'].includes(e.type)), 'Appearance case unexpectedly caused damage');
        h.result.coverage = { actualMakeupKitAndSnapshot: true, externalSameAppearanceKeySets: true, discreteHealthOnly: true,
            dualObserverPairs: h.result.snapshots.length, shroudComposition: true, fullSpatialCounterfactual: false };
    });
}

function dogCase(resources: Awaited<ReturnType<typeof loadSpecialtyResources>>, name: 'DOG' | 'ADOG') {
    return runCase(resources, `spy-false-friendly-${name}-local-autoattack`, 930042, h => {
        const spy = h.spawn('SPY', 1, 4);
        const appearanceTarget = h.spawn('E1', 0, 18);
        const ordinaryTank = h.spawn('MTNK', 0, 1);
        const dog = h.spawn(name, 0, 16);
        h.start();
        h.result.actualRules = { primary: spy.primaryWeapon.rules.name, warhead: spy.primaryWeapon.warhead.rules.name,
            makesDisguise: spy.primaryWeapon.warhead.rules.makesDisguise, permaDisguise: spy.rules.permaDisguise };
        h.assert(h.result.actualRules.makesDisguise === true, 'Actual primary warhead is not MakesDisguise');
        h.assert(dog.rules.detectDisguise && dog.rules.detectDisguiseRange === 0 && !ordinaryTank.rules.detectDisguise,
            'Shipped dog/tank rules do not isolate local detection');
        h.command(1, spy, OrderType.Attack, appearanceTarget.id);
        h.until(() => spy.disguiseTrait.getDisguise()?.owner === h.players[0], 60, 'Spy did not copy the actual hostile E1 through MakeupKit');
        h.assert(h.result.events.some((e: any) => e.id === spy.id && e.type === 'WeaponFire' && e.weapon === 'MakeupKit'), 'No real disguise shot');
        h.snapshot('makeup-copy-false-friendly', spy, 'unit');
        const guardStart = h.game.currentTick;
        for (let tick = 0; tick < 200; tick++) h.step();
        h.snapshot('nearby-ordinary-tank-no-auto-identification', spy, 'unit');
        h.assert(!h.result.events.some((e: any) => e.type === 'WeaponFire' && e.id === ordinaryTank.id), 'Ordinary tank fired at the stationary false-friendly spy');
        h.assert(spy.healthTrait.getHitPoints() === h.result.setup.find((s: any) => s.id === spy.id).actualHp, 'Spy was damaged before dog approach');
        const approachStart = h.game.currentTick;
        h.command(0, dog, OrderType.AttackMove, h.origin.rx + 4, h.origin.ry);
        h.until(() => h.result.events.some((e: any) => e.type === 'WeaponFire' && e.id === dog.id), 700, 'Dog never naturally acquired and fired');
        h.snapshot('dog-fired-still-not-player-shared-detection', spy, 'unit');
        h.until(() => spy.isDestroyed, 100, 'Actual dog projectile did not remove spy');
        h.snapshot('actual-dog-one-hit-spy-removed', spy, 'gone');
        const damage = h.result.events.filter((e: any) => e.type === 'InflictDamage' && e.id === spy.id);
        h.assert(damage.length > 0 && damage.every((e: any) => e.attackerId === dog.id) && damage.reduce((n: number, e: any) => n + e.damage, 0) > 0,
            'Spy removal lacks actual dog damage attribution');
        h.assert(h.result.tickTrace.every((t: any) => !t.objects.find((o: any) => o.id === spy.id).sharedDetection), 'Dog incorrectly granted player-wide shared detection');
        h.assert(h.result.tickTrace.every((t: any) => t.objects.find((o: any) => o.id === spy.id).observerName !== 'SPY'),
            'Sampled observer learned real spy identity before one-hit removal');
        h.assert(!h.result.events.some((e: any) => e.type === 'WeaponFire' && e.id === ordinaryTank.id), 'Normal tank gained a dog-derived global target');
        h.result.coverage = { actualMakeupKitAndSnapshot: true, falseFriendlyExcludedFromSelf: true,
            ordinaryTankGuardWindow: { fromTick: guardStart, toTick: approachStart, ticks: 200 },
            actualDogAttackMoveOrder: true, localAutoAcquire: true, sharedDetectionNeverGranted: true,
            actualDogShots: h.result.events.filter((e: any) => e.type === 'WeaponFire' && e.id === dog.id).length,
            actualDogDamage: damage.reduce((n: number, e: any) => n + e.damage, 0), actualSpyDestroyed: true,
            firstObserverRealSpyTick: null, reasonNoRealSpySnapshot: 'One-hit removal occurs within the same update as reveal and damage.',
            dualObserverPairs: h.result.snapshots.length };
    });
}

function mirageCase(resources: Awaited<ReturnType<typeof loadSpecialtyResources>>) {
    return runCase(resources, 'MGTK-natural-tree-move-fire-and-real-damage', 930043, h => {
        const mirage = h.spawn('MGTK', 1, 3);
        const attacker = h.spawn('HTNK', 0, 18);
        const realTree = h.game.getWorld().getAllObjects().find((object: any) => object.isTerrain() && h.game.rules.general.defaultMirageDisguises.includes(object.name));
        h.assert(realTree, 'Map has no real tree comparator');
        h.start();
        h.result.actualRules = { infantryBlinkDisguiseTime: h.game.rules.general.infantryBlinkDisguiseTime,
            defaultMirageDisguises: h.game.rules.general.defaultMirageDisguises,
            mirage: { primary: mirage.rules.primary, cost: mirage.rules.cost, strength: mirage.rules.strength },
            attacker: { primary: attacker.rules.primary, cost: attacker.rules.cost, strength: attacker.rules.strength } };
        h.until(() => mirage.disguiseTrait.hasTerrainDisguise(), 60, 'Stationary mirage never became a tree');
        const firstTree = h.snapshot('natural-initial-tree', mirage, 'tree');
        const actualTree = compactData(h.api(0).getGameObjectData(realTree.id));
        h.assert(actualTree && h.api(0).getUnitData(realTree.id) === undefined && h.api(0).getAllTerrainObjects().includes(realTree.id),
            'Real tree unit/generic/list semantics differ');
        h.assert(JSON.stringify(firstTree.generic.keys) === JSON.stringify(actualTree!.keys) &&
            JSON.stringify(firstTree.generic.definedKeys) === JSON.stringify(actualTree!.definedKeys), 'Mirage tree and real tree keys disclose hidden category');
        h.result.treeComparison = { mirage: firstTree.generic, actualTree,
            equalKeys: true, equalDefinedKeys: true, equalUnitLookupUndefined: true,
            limitation: 'Different real tree species/position may differ; this tests generic contract, not identical spatial counterfactuals.' };
        h.reset(); h.snapshot('tree-reset-shroud-old-id-hidden', mirage, 'hidden');
        h.reveal(); h.snapshot('tree-reveal-shroud-restores-terrain', mirage, 'tree');
        h.command(1, mirage, OrderType.Move, h.origin.rx + 7, h.origin.ry);
        h.until(() => !mirage.disguiseTrait.isDisguised() && mirage.moveTrait.moveState !== MoveState.Idle, 100, 'Actual move did not reveal tank');
        h.snapshot('actual-movement-shows-MGTK', mirage, 'unit');
        h.until(() => mirage.tile.rx === h.origin.rx + 7 && mirage.tile.ry === h.origin.ry &&
            mirage.moveTrait.moveState === MoveState.Idle && mirage.disguiseTrait.hasTerrainDisguise(), 400, 'Arrival and actual cooldown did not restore tree');
        h.snapshot('arrival-natural-cooldown-tree', mirage, 'tree');
        h.assert(!h.result.events.some((e: any) => ['WeaponFire', 'InflictDamage'].includes(e.type)), 'Combat interfered with movement-only tree cycle');
        // Real force-fire at the visible tree tile. Its object identity is not
        // supplied to the attack order. This exercises physical terrain targeting.
        h.command(0, attacker, OrderType.ForceAttack, mirage.tile.rx, mirage.tile.ry);
        let treeDamage: any;
        for (let tick = 0; tick < 800 && !treeDamage; tick++) {
            const wasTree = mirage.disguiseTrait.hasTerrainDisguise();
            const eventIndex = h.result.events.length;
            h.step();
            const newEvents = h.result.events.slice(eventIndex);
            const damage = newEvents.find((e: any) => e.type === 'InflictDamage' && e.id === mirage.id && e.attackerId === attacker.id && e.damage > 0);
            const ownShot = newEvents.some((e: any) => e.type === 'WeaponFire' && e.id === mirage.id);
            if (wasTree && damage && !ownShot) treeDamage = { event: damage, preUpdateTree: true,
                ownShotInUpdate: false, postUpdateDisguised: mirage.disguiseTrait.isDisguised(), postUpdateTick: h.game.currentTick };
            h.assert(!mirage.isDestroyed, 'Mirage died before observing damage-caused tree reveal');
        }
        h.assert(treeDamage && !treeDamage.postUpdateDisguised, 'No isolated real-damage tree reveal observed');
        h.snapshot('real-shell-damage-reveals-tree', mirage, 'unit');
        const fire = h.result.events.filter((e: any) => e.type === 'WeaponFire' && e.id === mirage.id);
        const outgoing = h.result.events.filter((e: any) => e.type === 'InflictDamage' && e.attackerId === mirage.id && e.id === attacker.id);
        h.assert(fire.length > 0 && outgoing.some((e: any) => e.damage > 0), 'Mirage did not fire and cause actual damage');
        h.assert(h.result.tickTrace.every((t: any) => !t.objects.find((o: any) => o.id === mirage.id).sharedDetection), 'Unexpected shared detector affected tree sequence');
        h.result.damageReveal = treeDamage;
        h.result.coverage = { naturalTreeMoveTree: true, forceFireAtTerrainTile: true, actualMirageShots: fire.length,
            outgoingDamage: outgoing.reduce((n: number, e: any) => n + e.damage, 0),
            incomingDamage: h.result.events.filter((e: any) => e.type === 'InflictDamage' && e.id === mirage.id).reduce((n: number, e: any) => n + e.damage, 0),
            damageRevealWithoutOwnShotThatUpdate: true, sameGenericContractAsRealTree: true, shroudComposition: true,
            dualObserverPairs: h.result.snapshots.length };
    });
}

function ownTransportRepairCase(resources: Awaited<ReturnType<typeof loadSpecialtyResources>>) {
    return runCase(resources, 'own-ENGINEER-FV-real-board-repair-unload', 930044, h => {
        const fv = h.spawn('FV', 1, 3);
        const engineer = h.spawn('ENGINEER', 1, 4);
        const tank = h.spawn('HTNK', 1, 7);
        h.start();
        const fullHp = tank.healthTrait.getHitPoints();
        const initialWeapon = fv.primaryWeapon.rules.name;
        h.snapshot('own-empty-IFV-real-inventory', fv, 'unit');
        const initial = h.observe(1, fv);
        h.assert(initial.unit.passengerSlotCount === 0 && initial.unit.passengerSlotMax === 1 &&
            initial.unit.primaryWeapon === initialWeapon, 'Own empty IFV does not expose its actual capacity/weapon');
        // Actual force-fire is explicit damage setup. Do not set HP to manufacture
        // a wounded target, and do not alter its ordinary combat properties.
        h.command(1, fv, OrderType.ForceAttack, tank.id);
        h.until(() => tank.healthTrait.getHitPoints() < fullHp, 400, 'Real IFV missile never damaged the friendly tank');
        h.command(1, fv, OrderType.Stop);
        // Complete the real already-fired burst/projectiles before repair.
        for (let tick = 0; tick < 50; tick++) h.step();
        const woundedHp = tank.healthTrait.getHitPoints();
        h.assert(woundedHp > 0 && woundedHp < fullHp && h.result.events.some((e: any) =>
            e.type === 'InflictDamage' && e.id === tank.id && e.attackerId === fv.id && e.damage > 0), 'Damage setup lacks real missile attribution');
        h.command(1, engineer, OrderType.EnterTransport, fv.id);
        h.until(() => fv.transportTrait.units.includes(engineer) && fv.primaryWeapon.rules.name === 'RepairBullet',
            400, 'Real engineer boarding did not select repair weapon');
        h.snapshot('own-engineer-IFV-repair-inventory', fv, 'unit');
        const boarded = h.observe(1, fv);
        h.assert(boarded.unit.passengerSlotCount === 1 && boarded.unit.primaryWeapon === 'RepairBullet',
            'Own loaded IFV lost passenger/repair weapon data');
        h.assert(!h.game.getWorld().hasObjectId(engineer.id) && !engineer.isDestroyed,
            'Boarded engineer should leave world without being destroyed');
        const repairStart = h.game.currentTick;
        h.command(1, fv, OrderType.Attack, tank.id);
        h.until(() => tank.healthTrait.getHitPoints() === fullHp, 500, 'Actual RepairBullet did not restore tank HP');
        const repairedTick = h.game.currentTick;
        h.snapshot('own-IFV-repaired-actual-tank', tank, 'unit');
        const repaired = h.observe(1, tank);
        h.assert(repaired.unit.actualHp === fullHp, 'Own healed tank HP did not update');
        const pulses = h.result.events.filter((e: any) => e.tick >= repairStart && e.type === 'WeaponFire' && e.id === fv.id && e.weapon === 'RepairBullet');
        const heals = h.result.events.filter((e: any) => e.tick >= repairStart && e.type === 'HealthChange' && e.id === tank.id && e.health > e.previousHealth);
        h.assert(pulses.length > 0 && heals.length > 0, 'No actual repair shot and health increase events');
        h.command(1, fv, OrderType.DeploySelected);
        h.until(() => !fv.transportTrait.units.length && h.game.getWorld().hasObjectId(engineer.id) &&
            fv.primaryWeapon.rules.name === initialWeapon, 400, 'Real unload did not restore engineer and original IFV weapon');
        h.snapshot('own-IFV-unloaded-original-weapon', fv, 'unit');
        const empty = h.observe(1, fv);
        const ownEngineer = h.api(1).getUnitData(engineer.id);
        h.assert(empty.unit.passengerSlotCount === 0 && empty.unit.primaryWeapon === initialWeapon &&
            ownEngineer?.name === 'ENGINEER' && ownEngineer.owner === h.players[1].name &&
            ownEngineer.hitPoints === engineer.healthTrait.getHitPoints(), 'Unloaded own identity/inventory was not restored');
        h.assert(h.result.events.some((e: any) => e.type === 'EnterTransport' && e.id === fv.id) &&
            h.result.events.some((e: any) => e.type === 'LeaveTransport' && e.id === fv.id), 'Missing actual transport events');
        h.assert(h.result.events.every((e: any) => e.type !== 'ObjectDestroy'), 'Transport/repair scene destroyed a unit');
        h.result.repair = { tankId: tank.id, engineerId: engineer.id, transportId: fv.id,
            initialHp: fullHp, woundedHp, repairedHp: tank.healthTrait.getHitPoints(), healedHp: fullHp - woundedHp,
            repairStartTick: repairStart, repairedTick, actualRepairWeaponShots: pulses.length,
            actualHealthIncreaseEvents: heals.length,
            healthEventSource: 'HealthChange does not provide a source. The real recorded RepairBullet order/shot and same-window HP restoration are retained separately.' };
        h.result.coverage = { actualFriendlyFireDamageSetup: true, realEngineerBoarding: true,
            sameEngineerIdentityAfterUnload: true, ownPassengerAndRuntimeWeaponData: true,
            externalCargoAndRuntimeWeaponAbsent: true, actualRepairShotAndHpRestoration: true,
            originalWeaponRestored: true, dualObserverPairs: h.result.snapshots.length };
    });
}

function sharedDetectorCase(resources: Awaited<ReturnType<typeof loadSpecialtyResources>>) {
    return runCase(resources, 'original-NAPSIS-real-range-and-power-shared-detection', 930045, h => {
        const power = h.spawn('NAPOWR', 0, 5);
        const sensor = h.spawn('NAPSIS', 0, 1);
        const spy = h.spawn('SPY', 1, 18);
        const appearanceTarget = h.spawn('ENGINEER', 0, 18, 1);
        h.start();
        h.result.actualRules = { sensor: { name: sensor.name, techLevel: sensor.rules.techLevel, cost: sensor.rules.cost,
            prerequisite: sensor.rules.prerequisite, owner: sensor.rules.owner, powered: sensor.rules.powered,
            power: sensor.rules.power, detectDisguise: sensor.rules.detectDisguise, detectDisguiseRange: sensor.rules.detectDisguiseRange,
            aiBuildThisRaw: h.game.rules.getIni().getSection('NAPSIS').get('AIBuildThis') },
            power: { name: power.name, power: power.rules.power, cost: power.rules.cost } };
        h.assert(sensor.rules.detectDisguiseRange === 15 && sensor.poweredTrait.isPoweredOn(), 'Real powered original detector not active');
        h.command(1, spy, OrderType.Attack, appearanceTarget.id);
        h.until(() => spy.disguiseTrait.getDisguise()?.owner === h.players[0], 60, 'Real MakeupKit did not create false-friendly engineer');
        h.assert(!h.players[0].sharedDetectDisguiseTrait.has(spy), 'Initial spy is unexpectedly inside detection range');
        h.snapshot('outside-powered-sensor-false-friendly', spy, 'unit');
        const powerSamples: any[] = [];
        const powerSample = (phase: string) => powerSamples.push({ phase, tick: h.game.currentTick,
            sensorId: sensor.id, powered: sensor.poweredTrait.isPoweredOn(),
            playerPower: h.players[0].powerTrait.power, playerDrain: h.players[0].powerTrait.drain,
            sharedDetectedSpy: h.players[0].sharedDetectDisguiseTrait.has(spy), spyId: spy.id, spyTile: location(spy),
            actualDisguise: spy.disguiseTrait.getDisguise()?.rules.name ?? null,
            observerName: h.api(0).getUnitData(spy.id)?.name ?? null });
        powerSample('outside');
        h.command(1, spy, OrderType.Move, h.origin.rx + 15, h.origin.ry);
        h.until(() => h.players[0].sharedDetectDisguiseTrait.has(spy), 300, 'Movement into real NAPSIS range never shared-detected spy');
        h.snapshot('inside-powered-sensor-shared-true-identity', spy, 'unit'); powerSample('inside');
        h.assert(spy.disguiseTrait.isDisguised(), 'Detection mutated actual disguise instead of observation');
        h.command(1, spy, OrderType.Move, h.origin.rx + 18, h.origin.ry);
        h.until(() => !h.players[0].sharedDetectDisguiseTrait.has(spy), 300, 'Leaving range did not clear shared detection');
        h.snapshot('left-sensor-false-friendly-again', spy, 'unit'); powerSample('left');
        h.command(1, spy, OrderType.Move, h.origin.rx + 15, h.origin.ry);
        h.until(() => spy.tile.rx === h.origin.rx + 15 && spy.tile.ry === h.origin.ry &&
            spy.moveTrait.moveState === MoveState.Idle && h.players[0].sharedDetectDisguiseTrait.has(spy),
            400, 'Spy did not settle safely inside sensor outer range');
        h.snapshot('reentered-powered-sensor', spy, 'unit'); powerSample('reentered');
        // Real Sell changes supply through production/power hooks. The outer-ring
        // position keeps ordinary sale crew from shooting the disguised spy.
        const creditsBefore = h.players[0].credits;
        h.result.commands.push({ tick: h.game.currentTick, player: h.players[0].name, unitId: power.id, order: 'SellObject' });
        h.result.realSaleSetup = { buildingId: power.id, preplaced: true, creditsBefore,
            purpose: 'Remove real power supply; sale returns actual game funds, not a paid-production experiment.' };
        h.bots.get(h.players[0].name)!.actionsApi.sellObject(power.id);
        h.until(() => !sensor.poweredTrait.isPoweredOn() && !h.players[0].sharedDetectDisguiseTrait.has(spy), 300,
            'Real power-plant sale did not disable NAPSIS shared detection');
        h.snapshot('low-power-clears-shared-detection', spy, 'unit'); powerSample('low-power');
        h.assert(spy.disguiseTrait.isDisguised() && spy.disguiseTrait.getDisguise()?.owner === h.players[0],
            'Power exit does not preserve underlying false-friendly disguise');
        h.assert(h.result.events.every((event: any) => !['InflictDamage', 'ObjectDestroy'].includes(event.type)),
            'Combat interfered with range/power detection');
        h.assert(h.result.events.some((event: any) => event.type === 'ObjectSell' && event.id === power.id) &&
            h.result.events.some((event: any) => event.type === 'PowerLow'), 'Missing real sale or low-power event');
        h.result.realSaleSetup.creditsAfter = h.players[0].credits;
        h.result.realSaleSetup.actualCreditIncrease = h.players[0].credits - creditsBefore;
        h.result.powerSamples = powerSamples;
        h.result.coverage = { originalNonzeroRangeRule: true, actualPoweredNAPSIS: true,
            realMakeupKit: true, moveIntoAndOutOfSharedDetector: true, underlyingDisguiseUnchanged: true,
            realSaleCreatesLowPower: true, lowPowerClearsSharedDetection: true,
            noManualSharedDetectorSetChanges: true, normalPaidDetectorProduction: false,
            powerRestoration: false, allianceTransitions: false, dualObserverPairs: h.result.snapshots.length };
    });
}

export async function runObservedDisguiseFixtures(cdn?: string) {
    const sourceBefore = await sourceVersion();
    const resources = await loadSpecialtyResources(cdn, 'mp01t4.map');
    const cases = [spyAppearanceCase(resources), dogCase(resources, 'DOG'), dogCase(resources, 'ADOG'), mirageCase(resources), ownTransportRepairCase(resources), sharedDetectorCase(resources)];
    const sourceAfter = await sourceVersion();
    const sourceStable = sourceBefore.gameSourceSha256 === sourceAfter.gameSourceSha256 &&
        sourceBefore.runnerSha256 === sourceAfter.runnerSha256 && JSON.stringify(sourceBefore.files) === JSON.stringify(sourceAfter.files);
    return { format: 1, kind: 'preplaced-real-engine-observed-disguise', map: resources.mapName,
        sourceBefore, sourceAfter, sourceStable, resources: resources.hashes, cases,
        passed: sourceStable && cases.every(result => result.passed),
        tickConvention: 'Events record currentTick inside game.update; trace/snapshots after update normally have tick+1.',
        limitations: ['Preplaced mechanism units with no-op bots; not paid production, MCV openings, complete AI, strength or win-rate evidence.',
            'Referee true HP, identity and event attribution are diagnostics only; bot observation outputs are separately captured.',
            'Real shroud reveal/reset is explicit test setup, not a powered gap generator or a bot vision benefit.',
            'No rule, disguise cooldown, hit point, weapon, movement speed, ownership or detector-set mutation is used.',
            'DOG/ADOG local attacks do not grant shared detection. The separate preplaced NAPSIS case tests original powered shared detection; normal paid production, power restoration and alliance transitions are not covered.',
            'Same-appearance comparisons cover field existence and selected public values, not identical-position full counterfactual worlds.',
            'Event APIs, MapApi terrain difference channels, player metadata, allied shared intel and historic strategy compatibility require separate coverage.',
            'Existing perma-disguise spy damage behavior and attack predicates are preserved; no claimed spy reinfiltration or strategy gain.'] };
}

if (import.meta.main) {
    const { values } = parseArgs({ options: { cdn: { type: 'string', default: process.env.RA2_BENCHMARK_CDN },
        out: { type: 'string', default: '.artifacts/ai-benchmark/observed-disguise.json' } } });
    AppLogger.setLevel(AppLogger.ERROR);
    const engineErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { engineErrors.push(args.map(String).join(' ')); originalError(...args); };
    let result: any;
    try {
        const fixtures = await runObservedDisguiseFixtures(values.cdn);
        result = { ...fixtures, passed: fixtures.passed && engineErrors.length === 0,
            errorCount: engineErrors.length + fixtures.cases.filter(item => !item.passed).length + (fixtures.sourceStable ? 0 : 1), engineErrors };
    } catch (error) { result = { passed: false, errorCount: engineErrors.length + 1, engineErrors, error: error instanceof Error ? error.stack : String(error) }; }
    finally { console.error = originalError; }
    await mkdir(dirname(resolve(values.out!)), { recursive: true });
    await Bun.write(values.out!, JSON.stringify(result, null, 2) + '\n');
    process.stderr.write(JSON.stringify({ passed: result.passed, errorCount: result.errorCount, sourceStable: result.sourceStable,
        cases: result.cases?.map((item: any) => ({ name: item.name, passed: item.passed, tick: item.finalTick, error: item.error })), error: result.error }) + '\n');
    if (!result.passed) process.exitCode = 1;
}

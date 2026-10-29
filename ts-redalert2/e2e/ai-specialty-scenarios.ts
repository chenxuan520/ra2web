/**
 * Deterministic mechanics fixtures in the real game engine, using real rules and maps.
 * Units are preplaced fixtures, not free production by a competing AI. These checks
 * demonstrate weapon/deployment behavior; they do not establish AI match strength.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readMix } from '../deploy/prepare-resources';
import { IniFile } from '../src/data/IniFile';
import { MapFile } from '../src/data/MapFile';
import { TmpFile } from '../src/data/TmpFile';
import { ObjectType } from '../src/engine/type/ObjectType';
import { GameFactory } from '../src/game/GameFactory';
import { GameStatus } from '../src/game/Game';
import { Bot } from '../src/game/bot/Bot';
import { EventType } from '../src/game/event/EventType';
import { BuildStatus } from '../src/game/gameobject/Building';
import { getZoneType } from '../src/game/gameobject/unit/ZoneType';
import { AiDifficulty, type GameOpts } from '../src/game/gameopts/GameOpts';
import { GameModes } from '../src/game/ini/GameModes';
import { OrderType } from '../src/game/order/OrderType';
import { Rules } from '../src/game/rules/Rules';
import { TileSets } from '../src/game/theater/TileSets';
import { SpeedType } from '../src/game/type/SpeedType';
import { BoxedVar } from '../src/util/BoxedVar';
import { AppLogger } from '../src/util/logger';
import { CombatSquad } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/combatSquad';
import { Mission } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/mission';
import { ActionBatcher } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher';
import { Vector2 } from '../src/game/math/Vector2';
import { ParaDropSupport } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/paraDropSupport';
import { SuperWeaponStatus } from '../src/game/SuperWeapon';
import { SuperWeaponType } from '../src/game/type/SuperWeaponType';
import { StanceType } from '../src/game/gameobject/infantry/StanceType';
import { RadiationGuardMission } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/radiationGuardMission';
import { DeathType } from '../src/game/gameobject/common/DeathType';
import { RadiationTransportMission } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/radiationTransportMission';
import { MissionController } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultCdn = resolve(projectRoot, '../.cache/ai-resources/cdn');
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type SceneName = 'desolator-radiation' | 'grand-cannon' | 'tank-duel' | 'ai-desolator-safe' | 'ai-desolator-blocked' | 'ai-radiation-detour' | 'ai-american-paradrop' | 'ai-injured-tank-retreat' | 'ai-radiation-guard' | 'ai-infantry-crush' | 'ai-radiation-transport' | 'ai-rocketeer-evasion';
const sceneNames: SceneName[] = ['desolator-radiation', 'grand-cannon', 'tank-duel', 'ai-desolator-safe', 'ai-desolator-blocked', 'ai-radiation-detour', 'ai-american-paradrop', 'ai-injured-tank-retreat', 'ai-radiation-guard', 'ai-infantry-crush', 'ai-radiation-transport', 'ai-rocketeer-evasion'];
type UnitSpec = { label: string; name: string; type: ObjectType; player: number; x: number; y: number; hitPoints?: number };
type ScenarioOptions = { cdn?: string; map?: string; seed?: number; maxTicks?: number; scenarios?: SceneName[]; observe?: boolean };

async function sourceVersion() {
    const git = async (...args: string[]) => {
        const process = Bun.spawn(['git', ...args], { cwd: resolve(projectRoot, '..'), stdout: 'pipe', stderr: 'pipe' });
        const [output, error, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
        if (code) throw new Error(`git ${args[0]}: ${error}`);
        return output.trim();
    };
    const directory = resolve(projectRoot, 'src/game/ai/thirdpartbot/builtIn');
    const sourceDigest = createHash('sha256');
    for (const filename of (await readdir(directory, { recursive: true })).filter(file => file.endsWith('.ts')).sort()) {
        sourceDigest.update(filename).update('\0').update(await Bun.file(resolve(directory, filename)).text()).update('\0');
    }
    const status = await git('status', '--porcelain', '--untracked-files=all', '--', 'ts-redalert2/src/game');
    const diff = await git('diff', 'HEAD', '--', 'ts-redalert2/src/game');
    return { commit: await git('rev-parse', 'HEAD'), source: 'working-tree', dirty: !!status,
        workingTreeStatus: status || null, trackedDiffSha256: diff ? hash(diff) : null,
        builtInSourceSha256: sourceDigest.digest('hex'), runnerSha256: hash(await Bun.file(import.meta.path).text()) };
}

export async function loadSpecialtyResources(cdn: string = defaultCdn, mapName: string = 'mp08t2.map') {
    const baseBytes = new Uint8Array(await Bun.file(resolve(projectRoot, 'public/ini.mix')).arrayBuffer());
    const customBytes = new Uint8Array(await Bun.file(resolve(projectRoot, 'public/res/ra2cd.mix')).arrayBuffer());
    const base = readMix('ini.mix', baseBytes).mix;
    const custom = readMix('ra2cd.mix', customBytes).mix;
    const ini = (name: string) => new IniFile((custom.containsFile(name) ? custom : base).openFile(name));
    const rules = new IniFile(base.openFile('rules.ini')).mergeWith(ini('rulescd.ini'));
    const art = new IniFile(base.openFile('art.ini')).mergeWith(ini('artcd.ini'));
    const mapBytes = new Uint8Array(await Bun.file(resolve(cdn, 'maps', mapName)).arrayBuffer());
    const mapText = new TextDecoder().decode(mapBytes);
    const metadata = new MapFile().fromString(mapText);
    const theaters: Record<number, [string, string, string]> = {
        1: ['temperat.ini', 'isotemp.mix', '.tem'], 2: ['urban.ini', 'isourb.mix', '.urb'],
        4: ['snow.ini', 'isosnow.mix', '.sno'],
    };
    const theater = theaters[metadata.theaterType];
    if (!theater) throw new Error(`Unsupported theater ${metadata.theaterType}`);
    const [theaterIni, archive, extension] = theater;
    const terrainBytes = new Uint8Array(await Bun.file(resolve(cdn, 'game-res/v2', archive)).arrayBuffer());
    const mix = readMix(archive, terrainBytes).mix;
    const cache = new Map<string, TmpFile>();
    const tileSets = new TileSets(ini(theaterIni));
    tileSets.loadTileData({ get(name: string) {
        if (!mix.containsFile(name)) return null;
        if (!cache.has(name)) cache.set(name, new TmpFile(mix.openFile(name)));
        return cache.get(name);
    } }, extension);
    return { ini, rules, art, tileSets, mapText, mapName,
        modes: new GameModes(ini('mpmodescd.ini'), ini),
        countries: new Rules(rules).getMultiplayerCountries().map(country => country.name),
        hashes: { mapSha256: hash(mapBytes), terrainSha256: hash(terrainBytes),
            iniSha256: hash(baseBytes), customIniSha256: hash(customBytes) },
        mapBytes: mapBytes.length,
    };
}

/** Initialized real map with two no-op bots; call game.start() after placing fixtures. */
export function createSpecialtyGame(resources: Awaited<ReturnType<typeof loadSpecialtyResources>>, seed: number = 303,
    countries: string[] = ['Arabs', 'French'], startPositions: [number, number] = [0, 1]) {
    if (countries.length !== 2 || countries.some(country => !resources.countries.includes(country))) throw new Error('Two supported countries are required');
    const map = new MapFile().fromString(resources.mapText);
    if (startPositions[0] === startPositions[1] || startPositions.some(position =>
        !Number.isInteger(position) || position < 0 || position >= map.startingLocations.length)) {
        throw new Error('Two different valid fixture starting positions are required');
    }
    const opts: GameOpts = { gameMode: 1, gameSpeed: 3, credits: 10000, unitCount: 0, shortGame: true,
        superWeapons: false, buildOffAlly: false, mcvRepacks: true, cratesAppear: false,
        destroyableBridges: true, multiEngineer: false, noDogEngiKills: false,
        mapName: resources.mapName, mapTitle: resources.mapName, mapDigest: resources.hashes.mapSha256,
        mapSizeBytes: resources.mapBytes, mapOfficial: true, maxSlots: map.startingLocations.length,
        humanPlayers: [], aiPlayers: countries.map((country, index) => ({
            difficulty: AiDifficulty.Normal, countryId: resources.countries.indexOf(country),
            colorId: index, startPos: startPositions[index], teamId: -2,
        })) };
    const game: any = GameFactory.create(map as any, resources.tileSets, resources.rules, resources.art,
        resources.ini('ai.ini'), resources.ini(resources.modes.getById(1).rulesOverride), [],
        String(seed), 1, opts, resources.modes as any, true, {}, undefined, new BoxedVar(false), new BoxedVar(0));
    const bots = new Map<string, Bot>();
    game.botManager.botFactory = { create(player: any) {
        const bot = new Bot(player.name, player.country.name);
        bots.set(player.name, bot);
        return bot;
    } };
    game.init(undefined);
    return { game, players: [game.getPlayerByName('@@AI1@@'), game.getPlayerByName('@@AI2@@')], bots, options: opts };
}

/** Preplace a fixture through normal object ownership/spawn hooks; never alter its combat rules. */
export function spawnSpecialtyObject(game: any, spec: UnitSpec, origin: { rx: number; ry: number }, players: any[]) {
    const player = players[spec.player];
    const object = spec.type === ObjectType.Building ? game.createObject(spec.type, spec.name)
        : game.createUnitForPlayer(game.rules.getObject(spec.name, spec.type), player);
    if (spec.type === ObjectType.Building) game.changeObjectOwner(object, player);
    const tile = game.map.tiles.getByMapCoords(origin.rx + spec.x, origin.ry + spec.y);
    if (!tile) throw new Error(`Missing fixture tile ${origin.rx + spec.x},${origin.ry + spec.y}`);
    if (spec.hitPoints !== undefined) object.healthTrait.setHitPoints(spec.hitPoints);
    if (object.isUnit()) object.zone = getZoneType(tile.landType);
    game.spawnObject(object, tile);
    if (object.isBuilding()) object.setBuildStatus(BuildStatus.Ready, game);
    return object;
}

function specifications(name: SceneName): UnitSpec[] {
    if (name === 'ai-rocketeer-evasion') return [
        { label: 'rocketeer', name: 'JUMPJET', type: ObjectType.Infantry, player: 0, x: 0, y: 0 },
        { label: 'enemy-flak', name: 'HTK', type: ObjectType.Vehicle, player: 1, x: 8, y: 0 },
    ];
    if (name === 'ai-radiation-transport') return [
        { label: 'transport', name: 'HTK', type: ObjectType.Vehicle, player: 0, x: 0, y: 0 },
        { label: 'desolator', name: 'DESO', type: ObjectType.Infantry, player: 0, x: -1, y: 0 },
        { label: 'vision-radar', name: 'NARADR', type: ObjectType.Building, player: 0, x: 10, y: -6 },
        { label: 'friendly-engineer', name: 'ENGINEER', type: ObjectType.Infantry, player: 0, x: -4, y: 0 },
        ...[0, 1, 2, 3, 4, 5].map(index => ({ label: `enemy-engineer-${index}`, name: 'ENGINEER',
            type: ObjectType.Infantry, player: 1, x: 23 + Math.floor(index / 3), y: index % 3 })),
    ];
    if (name === 'ai-radiation-guard') return [
        { label: 'base', name: 'NACNST', type: ObjectType.Building, player: 0, x: 0, y: 0 },
        { label: 'vision-radar', name: 'NARADR', type: ObjectType.Building, player: 0, x: 20, y: -8 },
        { label: 'desolator', name: 'DESO', type: ObjectType.Infantry, player: 0, x: 16, y: 0 },
        { label: 'friendly-engineer', name: 'ENGINEER', type: ObjectType.Infantry, player: 0, x: -3, y: 0 },
        ...[0, 1, 2].map(y => ({ label: `approaching-conscript-${y}`, name: 'E2', type: ObjectType.Infantry,
            player: 1, x: 24, y })),
    ];
    if (name === 'ai-infantry-crush') return [
        { label: 'crushing-tank', name: 'HTNK', type: ObjectType.Vehicle, player: 0, x: 0, y: 0 },
        ...[0, 1, 2, 3, 4, 5].map(index => ({ label: `enemy-conscript-${index}`, name: 'E2', type: ObjectType.Infantry,
            player: 1, x: 4 + Math.floor(index / 3), y: index % 3 - 1 })),
    ];
    if (name === 'ai-american-paradrop') return [
        { label: 'power', name: 'GAPOWR', type: ObjectType.Building, player: 0, x: 0, y: 0 },
        { label: 'radar', name: 'AMRADR', type: ObjectType.Building, player: 0, x: 3, y: 0 },
    ];
    if (name === 'ai-injured-tank-retreat') return [
        { label: 'injured-rhino', name: 'HTNK', type: ObjectType.Vehicle, player: 0, x: 0, y: 0, hitPoints: 100 },
        { label: 'enemy-tank', name: 'MTNK', type: ObjectType.Vehicle, player: 1, x: 4, y: 0 },
    ];
    if (name.startsWith('ai-')) {
        const specs: UnitSpec[] = [
            { label: 'desolator', name: 'DESO', type: ObjectType.Infantry, player: 0, x: 0, y: 0 },
            ...[2, 3, 4].map((x, index) => ({ label: `enemy-engineer-${index}`, name: 'ENGINEER',
                type: ObjectType.Infantry, player: 1, x, y: 0 })),
        ];
        if (name === 'ai-desolator-blocked') specs.push({ label: 'friendly-engineer', name: 'ENGINEER',
            type: ObjectType.Infantry, player: 0, x: -2, y: 0 });
        if (name === 'ai-radiation-detour') specs.push({ label: 'detour-tank', name: 'HTNK',
            type: ObjectType.Vehicle, player: 0, x: -13, y: 0 });
        return specs;
    }
    if (name === 'desolator-radiation') return [
        { label: 'desolator', name: 'DESO', type: ObjectType.Infantry, player: 0, x: 0, y: 0 },
        { label: 'enemy-engineer', name: 'ENGINEER', type: ObjectType.Infantry, player: 1, x: 2, y: 0 },
        { label: 'friendly-engineer', name: 'ENGINEER', type: ObjectType.Infantry, player: 0, x: -2, y: 0 },
        { label: 'enemy-miner', name: 'CMIN', type: ObjectType.Vehicle, player: 1, x: 0, y: 3 },
    ];
    if (name === 'grand-cannon') return [
        { label: 'cannon', name: 'GTGCAN', type: ObjectType.Building, player: 1, x: 0, y: 0 },
        { label: 'power', name: 'GAPOWR', type: ObjectType.Building, player: 1, x: -3, y: 0 },
        { label: 'target-tank', name: 'HTNK', type: ObjectType.Vehicle, player: 0, x: 9, y: 0 },
    ];
    return [
        { label: 'rhino', name: 'HTNK', type: ObjectType.Vehicle, player: 0, x: 0, y: 0 },
        { label: 'grizzly', name: 'MTNK', type: ObjectType.Vehicle, player: 1, x: 4, y: 0 },
    ];
}

function findClearSite(game: any, specs: UnitSpec[]) {
    const candidates: any[] = [];
    game.map.tiles.forEach((tile: any) => candidates.push(tile));
    const start = game.map.startingLocations[0];
    candidates.sort((a, b) => (Math.abs(a.rx - start.x) + Math.abs(a.ry - start.y))
        - (Math.abs(b.rx - start.x) + Math.abs(b.ry - start.y)) || a.rx - b.rx || a.ry - b.ry);
    // Clear the full encounter rectangle, so terrain does not conceal a blocked
    // spawn or an unintended cliff between the participating units.
    const isRetreat = specs.some(spec => spec.label === 'injured-rhino');
    const minX = Math.min(...specs.map(spec => spec.x)) - (isRetreat || specs.some(spec => spec.label === 'rocketeer') ? 6 : 1);
    const isDetour = specs.some(spec => spec.label === 'detour-tank');
    const isGuard = specs.some(spec => spec.label === 'vision-radar');
    const maxX = Math.max(isDetour ? 13 : -Infinity, ...specs.map(spec => spec.x)) + 3;
    const minY = Math.min(...specs.map(spec => spec.y)) - (isRetreat ? 3 : 1);
    const maxY = Math.max(...specs.map(spec => spec.y)) + 3;
    return candidates.find(origin => {
        // Preserve the initial MCVs as game-end anchors without letting them
        // become accidental targets, friendly radiation victims or AI blockers.
        if (game.getCombatants().some((player: any) => player.getOwnedObjects().some((object: any) => {
            if (Math.hypot(origin.rx - object.tile.rx, origin.ry - object.tile.ry) < 13) return true;
            return specs.some(spec => Math.hypot(origin.rx + spec.x - object.tile.rx, origin.ry + spec.y - object.tile.ry)
                < (spec.name === 'GTGCAN' ? 17 : spec.name === 'DESO' ? 13 : spec.type === ObjectType.Vehicle ? 10 : 3));
        }))) return false;
        for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
            // The detour fixture intentionally leaves the intervening terrain
            // to real pathfinding; require legal starts, target and local steps.
            if (isDetour && ![...specs, { x: 13, y: 0 }].some(point => Math.abs(x - point.x) <= 1 && Math.abs(y - point.y) <= 1)) continue;
            // The guard fixture spans a base and its forward flank. Validate
            // spawn footprints; movement between them uses the real terrain.
            if (isGuard && !specs.some(spec => x >= spec.x && x <= spec.x + (spec.type === ObjectType.Building ? 2 : 0) &&
                y >= spec.y && y <= spec.y + (spec.type === ObjectType.Building ? 2 : 0)) &&
                !(x >= 14 && x <= 25 && y >= -1 && y <= 3)) continue;
            const tile = game.map.tiles.getByMapCoords(origin.rx + x, origin.ry + y);
            const level = isGuard ? game.map.tiles.getByMapCoords(origin.rx + 16, origin.ry)?.z : origin.z;
            if (!tile || ((!isGuard || (x >= 14 && y >= -1 && y <= 3)) && tile.z !== level) || tile.onBridgeLandType !== undefined
                || game.map.terrain.getPassableSpeed(tile, SpeedType.Track, false, false) <= 0
                || game.map.terrain.getPassableSpeed(tile, SpeedType.Foot, true, false) <= 0
                || game.map.getObjectsOnTile(tile).some((object: any) => object.isTechno() || object.isTerrain())) return false;
        }
        return true;
    });
}

/** Thin real Mission carrying fixture IDs; all combat decisions come from CombatSquad. */
class ScenarioCombatMission extends Mission {
    constructor(private squad: CombatSquad) { super('specialty-fixture', () => {}); }
    _onAiUpdate(context: any) { return this.squad.onAiUpdate(context, this, () => {}); }
    getGlobalDebugText() { return this.squad.getGlobalDebugText(); }
    getPriority() { return 1; }
}

export async function runSpecialtyScenarios(options: ScenarioOptions = {}) {
    const mapName = (options.map ?? 'mp08t2').replace(/(?:\.map)?$/, '.map');
    const seed = options.seed ?? 303;
    const maxTicks = options.maxTicks ?? 900;
    if (!Number.isSafeInteger(seed) || seed < 0 || !Number.isSafeInteger(maxTicks) || maxTicks < 60) {
        throw new Error('Expected nonnegative integer seed and maxTicks >= 60');
    }
    const resources = await loadSpecialtyResources(options.cdn ?? defaultCdn, mapName);
    const observe = options.observe === false ? undefined : (await import('./ai-specialty-telemetry')).observeSpecialtyCombat;
    const report: any = { format: 1, kind: 'real-engine-mechanics-fixtures', map: mapName, seed, maxTicks,
        version: await sourceVersion(),
        resources: resources.hashes, notes: [
            'Preplaced units (including a deliberately injured tank), completed buildings and a precharged paradrop are fixture setup, not AI production or an economic test.',
            'Manual fixtures use no-op bots; AI fixtures run the actual Brutal CombatSquad through a Mission and ActionBatcher, or the actual ParaDropSupport controller.',
            'The engine handles every movement, shot and damage event. The AI context sees only GameApi-visible enemies.',
            'Radiation can harm friendly units and has no engine player attribution; do not turn fixture success into match wins.',
        ], scenarios: [] };
    for (const name of options.scenarios ?? sceneNames) {
        const { game, players, bots, options: gameOptions } = createSpecialtyGame(resources, seed,
            name === 'ai-american-paradrop' ? ['Americans', 'French'] : undefined);
        let telemetry: { snapshot(): unknown; dispose(): void } | undefined;
        try {
            telemetry = observe?.(game, players);
            const specs = specifications(name);
            const origin = findClearSite(game, specs);
            if (!origin) throw new Error(`No clear encounter rectangle on ${mapName} for ${name}`);
            const units = new Map<string, any>();
            const fixtureIds = new Set<number>();
            const aiControlled = name.startsWith('ai-');
            const result: any = { name, controller: name === 'ai-radiation-transport' ? 'actual RadiationTransportMission with MissionController'
                : name === 'ai-radiation-guard' ? 'actual RadiationGuardMission'
                : name === 'ai-american-paradrop' ? 'actual ParaDropSupport'
                : aiControlled ? 'actual Brutal CombatSquad' : 'documented manual action',
                origin: { x: origin.rx, y: origin.ry }, setup: [], commands: [], controllerUpdates: 0, tankControllerUpdates: 0,
                deployEvents: [], weaponFireEvents: [], damageEvents: [], destroyEvents: [], snapshots: [],
                superWeaponsEnabled: gameOptions.superWeapons, superWeaponActivations: [], spawnedAircraft: [], spawnedInfantry: [] };
            const handleEvent = (event: any) => {
                if (event.type === EventType.UnitDeployUndeploy && fixtureIds.has(event.unit.id)) {
                    result.deployEvents.push({ tick: game.currentTick, id: event.unit.id, name: event.unit.name,
                        deployed: event.unit.deployerTrait?.isDeployed(), eventLabel: event.deployType });
                } else if (event.type === EventType.WeaponFire && fixtureIds.has(event.gameObject.id)) {
                    result.weaponFireEvents.push({ tick: game.currentTick, id: event.gameObject.id,
                        name: event.gameObject.name, weapon: event.weapon.rules.name });
                } else if (event.type === EventType.InflictDamage && fixtureIds.has(event.target.id)) {
                    result.damageEvents.push({ tick: game.currentTick, id: event.target.id, name: event.target.name,
                        attackerId: event.attacker?.obj?.id ?? event.attacker?.id ?? null,
                        damage: event.damageHitPoints, previousHealth: event.prevHealth, health: event.currentHealth,
                        radiationLevel: game.mapRadiationTrait.getRadLevel(event.target.tile) ?? 0 });
                } else if (event.type === EventType.ObjectDestroy && fixtureIds.has(event.target.id)) {
                    result.destroyEvents.push({ tick: game.currentTick, id: event.target.id, name: event.target.name,
                        deathType: DeathType[event.target.deathType] ?? null });
                } else if (name === 'ai-american-paradrop' && event.type === EventType.SuperWeaponActivate) {
                    result.superWeaponActivations.push({ tick: game.currentTick, type: event.target, owner: event.owner.name,
                        tile: { x: event.atTile.rx, y: event.atTile.ry } });
                } else if (name === 'ai-american-paradrop' && event.type === EventType.ObjectSpawn && event.gameObject.owner === players[0]) {
                    const object = event.gameObject;
                    if (object.isAircraft()) result.spawnedAircraft.push({ tick: game.currentTick, id: object.id, name: object.name });
                    if (object.isInfantry()) result.spawnedInfantry.push({ tick: game.currentTick, id: object.id, name: object.name });
                }
            };
            game.events.subscribe(handleEvent);
            for (const spec of specs) {
                const object = spawnSpecialtyObject(game, spec, origin, players);
                const tile = object.tile;
                fixtureIds.add(object.id);
                units.set(spec.label, object);
                result.setup.push({ ...spec, id: object.id, x: tile.rx, y: tile.ry,
                    hitPoints: object.healthTrait.getHitPoints(), cost: object.rules.cost });
            }
            if (name === 'ai-american-paradrop') {
                const power = players[0].superWeaponsTrait.getAll().find((weapon: any) => weapon.rules.type === SuperWeaponType.AmerParaDrop);
                if (!power) throw new Error('AMRADR did not grant the real American paradrop ability');
                result.chargeFixture = { name: power.name, originalRechargeTicks: power.rechargeTicks, fixtureRemainingTicks: 1,
                    note: 'Only this mechanics fixture shortens charge. Full AI matches never force ability readiness.' };
                power.chargeTicks = 1;
                power.status = SuperWeaponStatus.Charging;
            }
            game.start();
            for (const bot of bots.values()) {
                const originalOrder = bot.actionsApi.orderUnits;
                bot.actionsApi.orderUnits = function (unitIds: number[], orderType: OrderType, targetX?: number, targetY?: number, useBridge?: boolean) {
                    result.commands.push({ tick: game.currentTick, player: bot.name, unitIds: [...unitIds],
                        order: OrderType[orderType], target: targetY === undefined ? targetX ?? null : { x: targetX, y: targetY },
                        ...(name === 'ai-radiation-detour' ? { radiationAtOrigin: game.mapRadiationTrait.getRadLevel(origin) ?? 0,
                            desolatorDeployed: units.get('desolator').deployerTrait.isDeployed() } : {}),
                        ...(name === 'ai-injured-tank-retreat' ? {
                            sourceTile: { x: units.get('injured-rhino').tile.rx, y: units.get('injured-rhino').tile.ry },
                            enemyTile: units.get('enemy-tank').isDestroyed ? null
                                : { x: units.get('enemy-tank').tile.rx, y: units.get('enemy-tank').tile.ry },
                        } : {}) });
                    return originalOrder.call(this, unitIds, orderType, targetX, targetY, useBridge);
                };
            }
            if (name === 'ai-american-paradrop') {
                const bot = bots.get(players[0].name)!;
                const controller = new ParaDropSupport();
                const originalActivate = bot.actionsApi.activateSuperWeapon;
                bot.actionsApi.activateSuperWeapon = function (type: number, tile: any) {
                    result.commands.push({ tick: game.currentTick, player: bot.name, order: 'ActivateSuperWeapon',
                        type, target: { x: tile.rx, y: tile.ry }, readyPowers: bot.gameApi.getAllSuperWeaponData() });
                    return originalActivate.call(this, type, tile);
                };
                bot.onGameTick = () => {
                    result.controllerUpdates++;
                    controller.onAiUpdate({ game: bot.gameApi,
                        player: { name: bot.name, actions: bot.actionsApi, production: bot.productionApi },
                        difficulty: 'brutal', matchAwareness: { getMainRallyPoint: () => new Vector2(origin.rx + 1, origin.ry + 3) },
                    } as any);
                };
            } else if (aiControlled) {
                const bot = bots.get(players[0].name)!;
                const mission = name === 'ai-radiation-transport'
                    ? new RadiationTransportMission(new Vector2(origin.rx + 18, origin.ry), new Vector2(origin.rx, origin.ry), 0, () => {})
                    : name === 'ai-radiation-guard' ? new RadiationGuardMission(() => {})
                    : new ScenarioCombatMission(new CombatSquad(new Vector2(origin.rx, origin.ry),
                        new Vector2(origin.rx + 3, origin.ry), 10));
                const controlledLabel = name === 'ai-injured-tank-retreat' ? 'injured-rhino'
                    : name === 'ai-infantry-crush' ? 'crushing-tank' : name === 'ai-rocketeer-evasion' ? 'rocketeer' : 'desolator';
                mission.addUnit(units.get(controlledLabel).id);
                if (name === 'ai-radiation-transport') mission.addUnit(units.get('transport').id);
                const transportController = name === 'ai-radiation-transport' ? new MissionController(() => {}) : undefined;
                transportController?.addMission(mission);
                const tankMission = name === 'ai-radiation-detour'
                    ? new ScenarioCombatMission(new CombatSquad(new Vector2(origin.rx - 13, origin.ry),
                        new Vector2(origin.rx + 13, origin.ry), 10)) : undefined;
                if (tankMission) tankMission.addUnit(units.get('detour-tank').id);
                bot.onGameTick = () => {
                    if (game.currentTick % 6 !== 0 || units.get(controlledLabel).isDestroyed) return;
                    const batcher = new ActionBatcher();
                    const api = bot.gameApi;
                    const context = { game: api, player: { name: bot.name, actions: bot.actionsApi, production: bot.productionApi },
                        difficulty: 'brutal', actionBatcher: batcher,
                        matchAwareness: { getHostilesNearPoint(x: number, y: number, radius: number) {
                            return api.getVisibleUnits(bot.name, 'enemy').map((id: number) => api.getUnitData(id))
                                .filter((unit: any) => unit && Math.hypot(unit.tile.rx - x, unit.tile.ry - y) <= radius)
                                .map((unit: any) => ({ unitId: unit.id }));
                        } },
                    };
                    result.controllerUpdates++;
                    if (transportController) transportController.onAiUpdate(context as any);
                    else mission.onAiUpdate(context as any);
                    if (tankMission && game.currentTick >= 120) {
                        result.tankControllerUpdates++;
                        tankMission.onAiUpdate(context as any);
                    }
                    batcher.resolve(bot.actionsApi);
                };
            }
            const order = (label: string, orderType: OrderType, targetLabel?: string) => {
                const unit = units.get(label);
                const target = targetLabel ? units.get(targetLabel) : undefined;
                bots.get(unit.owner.name)!.actionsApi.orderUnits([unit.id], orderType, target?.id);
            };
            const snapshot = () => result.snapshots.push({ tick: game.currentTick,
                units: result.setup.map((setup: any) => {
                    const object = units.get(setup.label);
                    return { label: setup.label, id: setup.id, alive: object.isSpawned && !object.isDestroyed,
                        hitPoints: object.isDestroyed ? 0 : object.healthTrait.getHitPoints(),
                        tile: object.isDestroyed ? null : { x: object.tile.rx, y: object.tile.ry },
                        deployed: object.isDestroyed ? false : object.deployerTrait?.isDeployed() ?? false };
                }),
                radiationAtOrigin: game.mapRadiationTrait.getRadLevel(origin) ?? 0,
                power: players.map((player: any) => ({ power: player.powerTrait.power, drain: player.powerTrait.drain })),
                ...(name === 'ai-american-paradrop' ? { landedGis: players[0].getOwnedObjects()
                    .filter((object: any) => object.name === 'E1' && object.isInfantry()
                        && object.stance !== StanceType.Paradrop && object.tileElevation === 0).map((object: any) => object.id) } : {}),
            });
            snapshot();
            while (game.currentTick < maxTicks && game.status !== GameStatus.Ended) {
                if (game.currentTick === 0 && name === 'desolator-radiation') order('desolator', OrderType.DeploySelected);
                // The first update incorporates shroud revealed by the fixture spawns.
                if (game.currentTick === 1 && name === 'grand-cannon') order('cannon', OrderType.Attack, 'target-tank');
                if (game.currentTick === 1 && name === 'tank-duel') {
                    order('rhino', OrderType.Attack, 'grizzly');
                    order('grizzly', OrderType.Attack, 'rhino');
                }
                if (game.currentTick === 120 && name === 'ai-radiation-guard') {
                    // Scripted attackers cross a preplaced defensive position;
                    // the defender chooses its own position and deployment orders.
                    for (let index = 0; index < 3; index++) {
                        const unit = units.get(`approaching-conscript-${index}`);
                        bots.get(players[1].name)!.actionsApi.orderUnits([unit.id], OrderType.Move,
                            origin.rx + 18, origin.ry + index);
                    }
                }
                game.update();
                if (game.currentTick % 30 === 0) snapshot();
            }
            if (result.snapshots.at(-1).tick !== game.currentTick) snapshot();
            result.ticks = game.currentTick;
            result.specialty = telemetry?.snapshot() ?? null;
            const isDeploymentOrder = (command: any) => command.order === 'DeploySelected' || command.order === 'Deploy';
            result.checks = name === 'ai-rocketeer-evasion' ? {
                actualControllerRan: result.controllerUpdates > 0,
                evasionMoveIssued: result.commands.some((command: any) => command.unitIds?.includes(units.get('rocketeer').id)
                    && command.order === 'Move'),
                escapedKnownFlakRange: result.snapshots.some((sample: any) => sample.units.some((unit: any) => unit.label === 'rocketeer'
                    && unit.alive && Math.hypot(unit.tile.x - origin.rx - 8, unit.tile.y - origin.ry) >= 10)),
                rocketeerSurvives: !units.get('rocketeer').isDestroyed,
            } : name === 'ai-radiation-transport' ? {
                actualControllerRan: result.controllerUpdates > 0,
                realBoardingOrder: result.commands.some((command: any) => command.order === 'EnterTransport'),
                realUnloadOrder: result.commands.some((command: any) => command.unitIds?.includes(units.get('transport').id)
                    && command.order === 'DeploySelected'),
                payloadDelivered: result.snapshots.some((sample: any) => sample.units.some((unit: any) =>
                    unit.label === 'desolator' && unit.alive && unit.tile.x >= origin.rx + 15)),
                plumeAfterDelivery: result.deployEvents.some((event: any) => event.name === 'DESO' && event.deployed),
                enemyInfantryDamagedInRadiation: result.damageEvents.some((event: any) => event.name === 'ENGINEER'
                    && event.radiationLevel > 0 && event.attackerId === null),
                friendlyInfantrySpared: !result.damageEvents.some((event: any) => event.id === units.get('friendly-engineer').id
                    && event.radiationLevel > 0 && event.attackerId === null),
            } : name === 'ai-radiation-guard' ? {
                actualControllerRan: result.controllerUpdates > 0,
                defenderDeployed: result.deployEvents.some((event: any) => event.name === 'DESO' && event.deployed),
                enemyDamagedInRadiation: result.damageEvents.some((event: any) =>
                    event.name === 'E2' && event.radiationLevel > 0 && event.attackerId === null),
                noFriendlyRadiationDamage: !result.damageEvents.some((event: any) =>
                    event.id === units.get('friendly-engineer').id && event.radiationLevel > 0 && event.attackerId === null),
                noAssaultOrders: !result.commands.some((command: any) => command.player === players[0].name
                    && command.order === 'AttackMove'),
            } : name === 'ai-infantry-crush' ? {
                actualControllerRan: result.controllerUpdates > 0,
                deliberateMoveIssued: result.commands.some((command: any) => command.player === players[0].name && command.order === 'Move'),
                tankCrossedInfantryLine: result.snapshots.some((sample: any) => sample.units.some((unit: any) =>
                    unit.label === 'crushing-tank' && unit.alive && unit.tile.x >= origin.rx + 4)),
                // Read the real engine death type independently of the optional observer.
                infantryCrushed: result.destroyEvents.some((event: any) => event.name === 'E2' && event.deathType === 'Crush'),
            } : name === 'ai-american-paradrop' ? {
                actualControllerRan: result.controllerUpdates > 0,
                allowedWithSuperWeaponsDisabled: result.superWeaponsEnabled === false,
                actualEngineActivated: result.superWeaponActivations.some((event: any) => event.type === SuperWeaponType.AmerParaDrop),
                transportAircraftSpawned: result.spawnedAircraft.length > 0,
                gisActuallyLanded: result.snapshots.some((sample: any) => sample.landedGis.length > 0),
            } : name === 'ai-injured-tank-retreat' ? {
                actualControllerRan: result.controllerUpdates > 0,
                retreatMoveIssued: result.commands.some((command: any) => command.order === 'Move' && command.enemyTile
                    && Math.hypot(command.target.x - command.enemyTile.x, command.target.y - command.enemyTile.y)
                        > Math.hypot(command.sourceTile.x - command.enemyTile.x, command.sourceTile.y - command.enemyTile.y)),
                tankActuallyMoved: result.snapshots.some((sample: any) => sample.units.some((unit: any) =>
                    unit.label === 'injured-rhino' && unit.alive && (unit.tile.x !== origin.rx || unit.tile.y !== origin.ry))),
            } : name === 'ai-radiation-detour' ? {
                actualControllerRan: result.controllerUpdates > 0,
                plumeCreatedByAi: result.deployEvents.some((event: any) => event.name === 'DESO' && event.deployed)
                    && result.weaponFireEvents.some((event: any) => event.weapon === 'RadEruptionWeapon'),
                residualRadiationAfterUndeploy: result.snapshots.some((sample: any) => sample.radiationAtOrigin > 0
                    && sample.units.some((unit: any) => unit.label === 'desolator' && !unit.deployed)),
                tankDetoursOrWaitsForDecay: result.tankControllerUpdates > 0 && (
                    result.commands.some((command: any) => command.tick >= 120
                        && command.unitIds.includes(units.get('detour-tank').id) && ['Move', 'Stop'].includes(command.order)
                        && command.radiationAtOrigin > 0 && !command.desolatorDeployed)
                    || (result.commands.filter((command: any) => command.unitIds.includes(units.get('detour-tank').id))
                        .every((command: any) => command.radiationAtOrigin === 0)
                        && result.commands.some((command: any) => command.tick >= 120
                            && command.unitIds.includes(units.get('detour-tank').id) && ['Move', 'AttackMove'].includes(command.order)))),
                tankStayedOutsideActiveSite: result.snapshots.filter((sample: any) => sample.radiationAtOrigin > 0)
                    .every((sample: any) => sample.units.filter((unit: any) => unit.label === 'detour-tank')
                        .every((unit: any) => unit.alive && Math.hypot(unit.tile.x - origin.rx, unit.tile.y - origin.ry) >= 11)),
                noTankRadiationDamage: !result.damageEvents.some((event: any) => event.id === units.get('detour-tank').id
                    && event.radiationLevel > 0 && event.attackerId === null),
            } : name === 'ai-desolator-safe' ? {
                actualControllerRan: result.controllerUpdates > 0,
                aiIssuedDeploy: result.commands.some(isDeploymentOrder),
                deploymentExecuted: result.deployEvents.some((event: any) => event.name === 'DESO' && event.deployed),
                eruptionFired: result.weaponFireEvents.some((event: any) => event.weapon === 'RadEruptionWeapon'),
                targetDamagedInRadiation: result.damageEvents.some((event: any) => event.radiationLevel > 0 && event.attackerId === null),
            } : name === 'ai-desolator-blocked' ? {
                actualControllerRan: result.controllerUpdates > 0,
                noUnsafeDeployOrder: !result.commands.some(isDeploymentOrder),
                noEruptionFired: !result.weaponFireEvents.some((event: any) => event.weapon === 'RadEruptionWeapon'),
                friendlyInfantrySurvives: !units.get('friendly-engineer').isDestroyed &&
                    units.get('friendly-engineer').healthTrait.getHitPoints() === units.get('friendly-engineer').rules.strength,
            } : name === 'desolator-radiation' ? {
                deployedViaAction: result.deployEvents.some((event: any) => event.name === 'DESO' && event.deployed),
                eruptionFired: result.weaponFireEvents.some((event: any) => event.weapon === 'RadEruptionWeapon'),
                radiationFieldObserved: result.snapshots.some((sample: any) => sample.radiationAtOrigin > 0),
                targetDamagedInRadiation: result.damageEvents.some((event: any) => event.radiationLevel > 0 && event.attackerId === null),
            } : name === 'grand-cannon' ? {
                cannonHasPower: result.snapshots.some((sample: any) => sample.power[1].power > sample.power[1].drain),
                cannonFired: result.weaponFireEvents.some((event: any) => event.name === 'GTGCAN'),
                tankDamagedByCannon: result.damageEvents.some((event: any) => event.id === units.get('target-tank').id && event.attackerId === units.get('cannon').id),
            } : {
                rhinoFired: result.weaponFireEvents.some((event: any) => event.name === 'HTNK'),
                grizzlyFired: result.weaponFireEvents.some((event: any) => event.name === 'MTNK'),
                bothTanksDamaged: ['rhino', 'grizzly'].every(label => result.damageEvents.some((event: any) => event.id === units.get(label).id)),
            };
            result.passed = Object.values(result.checks).every(Boolean);
            report.scenarios.push(result);
        } finally {
            telemetry?.dispose();
            game.dispose();
        }
    }
    report.passed = report.scenarios.every((scene: any) => scene.passed);
    return report;
}

if (import.meta.main) {
    const { values: args } = parseArgs({ options: {
        cdn: { type: 'string', default: process.env.RA2_BENCHMARK_CDN ?? defaultCdn },
        map: { type: 'string', default: 'mp08t2' }, seed: { type: 'string', default: '303' },
        'max-ticks': { type: 'string', default: '900' }, repeat: { type: 'string', default: '2' },
        'no-telemetry': { type: 'boolean', default: false },
        scenarios: { type: 'string' },
        out: { type: 'string', default: resolve(projectRoot, '.artifacts/ai-benchmark/specialty-scenarios.json') },
    } });
    const repeat = Number(args.repeat);
    if (!Number.isSafeInteger(repeat) || repeat < 1) throw new Error('--repeat must be a positive integer');
    const selectedScenes = args.scenarios?.split(',') as SceneName[] | undefined;
    if (selectedScenes?.some(name => !sceneNames.includes(name))) throw new Error('--scenarios contains an unknown scene');
    const issues: { level: string; message: string }[] = [];
    for (const level of ['log', 'debug', 'info', 'warn', 'error'] as const) console[level] = (...args: any[]) => {
        if (level === 'error' || level === 'warn') issues.push({ level, message: args.map(arg => arg instanceof Error ? arg.stack : String(arg)).join(' ') });
    };
    AppLogger.setLevel(AppLogger.ERROR);
    AppLogger.setHandler((messages: any, context: any) => {
        issues.push({ level: String(context.level.name).toLowerCase(), message: [...messages].map(String).join(' ') });
    });
    const results: any[] = [];
    for (let index = 0; index < repeat; index++) {
        process.stderr.write(`Specialty fixtures repetition ${index + 1}/${repeat}\n`);
        results.push(await runSpecialtyScenarios({ cdn: args.cdn, map: args.map,
            seed: Number(args.seed), maxTicks: Number(args['max-ticks']), observe: !args['no-telemetry'], scenarios: selectedScenes }));
    }
    const deterministic = results.every(result => JSON.stringify(result) === JSON.stringify(results[0]));
    const output = { ...results[0], repeat, deterministic, issues,
        passed: deterministic && results.every(result => result.passed) && !issues.some(issue => issue.level === 'error') };
    await mkdir(dirname(resolve(args.out!)), { recursive: true });
    await Bun.write(resolve(args.out!), JSON.stringify(output, null, 2) + '\n');
    process.stderr.write(JSON.stringify({ passed: output.passed, deterministic,
        scenarios: output.scenarios.map((scene: any) => ({ name: scene.name, checks: scene.checks })),
        issues: issues.length, out: resolve(args.out!) }) + '\n');
    if (!output.passed) process.exitCode = 1;
}

/**
 * Real-engine AI tournament. Requires prepared local resources (see --help).
 * No renderer, browser, mocked combat, bonus credits, or forced winner is used.
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
import { GameFactory } from '../src/game/GameFactory';
import { GameStatus } from '../src/game/Game';
import { GameSpeed } from '../src/game/GameSpeed';
import { Rules } from '../src/game/rules/Rules';
import { TileSets } from '../src/game/theater/TileSets';
import { GameModes } from '../src/game/ini/GameModes';
import { AiDifficulty, type GameOpts } from '../src/game/gameopts/GameOpts';
import { BuiltInBotAdapter } from '../src/game/ai/thirdpartbot/builtIn/BuiltInBotAdapter';
import { BoxedVar } from '../src/util/BoxedVar';
import { AppLogger } from '../src/util/logger';
import { EventType } from '../src/game/event/EventType';
import { loadBaselineBot } from './ai-baseline';
import { observeBuildingMissions } from './ai-building-probe';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = resolve(projectRoot, '..');
const { values: args } = parseArgs({ options: {
    map: { type: 'string', default: 'mp08t2' },
    seeds: { type: 'string', default: '101,202,303' },
    matchups: { type: 'string', default: 'Americans:Americans,Russians:Russians' },
    'max-ticks': { type: 'string', default: '18000' },
    'sample-ticks': { type: 'string', default: '900' },
    'candidate-ref': { type: 'string', default: 'working-tree' },
    'baseline-ref': { type: 'string', default: '14ffd36' },
    'candidate-profile': { type: 'string', default: 'brutal' },
    'baseline-profile': { type: 'string', default: 'normal' },
    'no-swap': { type: 'boolean', default: false },
    credits: { type: 'string', default: '10000' },
    units: { type: 'string', default: '0' },
    cdn: { type: 'string', default: process.env.RA2_BENCHMARK_CDN ?? resolve(repositoryRoot, '.cache/ai-resources/cdn') },
    out: { type: 'string', default: resolve(projectRoot, '.artifacts/ai-benchmark/results.json') },
    help: { type: 'boolean', short: 'h' },
} });
if (args.help) {
    console.log(`Usage: bun e2e/ai-benchmark.ts [options]
  --cdn PATH                  Prepared resource root containing maps/ and game-res/v2/
  --map mp08t2,mp11t2          Official map names (or local absolute .map paths)
  --seeds 101,202,303          Fixed integer random seeds
  --matchups Americans:Americans,Russians:Russians
  --max-ticks 18000            20 simulation minutes at 15 ticks/second; timeout is a draw
  --sample-ticks 900           Periodic economy, army, queue and mission telemetry
  --candidate-ref working-tree|COMMIT  Candidate snapshot (default current checkout)
  --baseline-ref 14ffd36       Immutable historical bot snapshot
  --candidate-profile brutal  Bot profile only; engine player difficulty is Normal for both
  --baseline-profile normal   Use same refs/profiles for self-play sanity checks
  --no-swap                   Disable paired swaps of spawn position and player update order
  --credits 10000 --units 0   Identical starting resources and units for both players
  --out PATH                  Incremental JSON report; errors are recorded, never counted as wins
Resources are prepared with deploy/prepare-resources.ts; no download is performed by this runner.`);
    process.exit(0);
}
const positiveInt = (value: string, key: string, allowZero = false) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) throw new Error(`Invalid --${key}: ${value}`);
    return number;
};
const maxTicks = positiveInt(args['max-ticks']!, 'max-ticks');
const sampleTicks = positiveInt(args['sample-ticks']!, 'sample-ticks');
const credits = positiveInt(args.credits!, 'credits', true);
const unitCount = positiveInt(args.units!, 'units', true);
const seeds = args.seeds!.split(',').map(seed => positiveInt(seed, 'seeds', true));
const profiles = [args['candidate-profile'], args['baseline-profile']];
if (profiles.some(profile => profile !== 'normal' && profile !== 'brutal')) throw new Error('Profiles must be normal or brutal');
const matchups = args.matchups!.split(',').map(pair => pair.split(':'));
if (matchups.some(pair => pair.length !== 2 || pair.some(country => !country))) throw new Error('Expected country:country matchups');
const writeProgress = (message: string) => process.stderr.write(message + '\n');
const jsonString = (value: unknown) => JSON.stringify(value, (_key, item) => item instanceof Error ? item.stack : item);
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function git(...parameters: string[]): Promise<string> {
    const child = Bun.spawn(['git', ...parameters], { cwd: repositoryRoot, stdout: 'pipe', stderr: 'pipe' });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`git ${parameters[0]}: ${errors}`);
    return output.trim();
}

type Issue = { level: string; tick: number | null; message: string };
let activeTelemetry: any;
let activeGame: any;
let activeCandidateName = '@@AI1@@';
const startupIssues: Issue[] = [];
function capture(level: string, messages: unknown[], loggerName?: string) {
    const message = messages.map(value => typeof value === 'string' ? value : jsonString(value)).join(' ');
    const side = loggerName?.startsWith('@@AI') ? loggerName === activeCandidateName ? 0 : 1 : -1;
    if (activeTelemetry && message.includes('reason: NoTargets')) {
        activeTelemetry.noTargetDisbands++;
        if (side >= 0) activeTelemetry.noTargetDisbandsByPlayer[side]++;
    }
    if (activeTelemetry && side >= 0) {
        if (message.includes('reason: UnableToAcquireUnits')) activeTelemetry.unableToAcquireDisbands[side]++;
        const cancellation = /Dequeueing queue (\w+) unit (\w+) because (\w+)/.exec(message);
        if (cancellation) {
            const key = `${cancellation[1]}:${cancellation[2]}`;
            const counts = activeTelemetry.productionCancellations[side];
            counts[key] = (counts[key] ?? 0) + 1;
            if (activeTelemetry.productionCancellationSamples[side].length < 30) {
                activeTelemetry.productionCancellationSamples[side].push({ tick: activeGame?.currentTick, message });
            }
        }
    }
    if (level !== 'error' && level !== 'warn') return;
    const issue = { level, tick: activeGame?.currentTick ?? null, message };
    if (!activeTelemetry) { if (startupIssues.length < 30) startupIssues.push(issue); return; }
    activeTelemetry[level === 'error' ? 'errorCount' : 'warningCount']++;
    if (activeTelemetry.issues.length < 40 && !activeTelemetry.issues.some((entry: Issue) => entry.message === message)) activeTelemetry.issues.push(issue);
}
for (const level of ['log', 'debug', 'info', 'warn', 'error'] as const) console[level] = (...messages) => capture(level, messages);
AppLogger.setLevel(AppLogger.DEBUG);
AppLogger.setHandler((messages: any, context: any) => capture(String(context.level.name).toLowerCase(), [...messages], context.name));

const baseBytes = new Uint8Array(await Bun.file(resolve(projectRoot, 'public/ini.mix')).arrayBuffer());
const customBytes = new Uint8Array(await Bun.file(resolve(projectRoot, 'public/res/ra2cd.mix')).arrayBuffer());
const base = readMix('ini.mix', baseBytes).mix;
const custom = readMix('ra2cd.mix', customBytes).mix;
const ini = (name: string) => new IniFile((custom.containsFile(name) ? custom : base).openFile(name));
const baseRules = new IniFile(base.openFile('rules.ini')).mergeWith(ini('rulescd.ini'));
const baseArt = new IniFile(base.openFile('art.ini')).mergeWith(ini('artcd.ini'));
const modes = new GameModes(ini('mpmodescd.ini'), ini);
const countryNames = new Rules(baseRules).getMultiplayerCountries().map(country => country.name);
const baseline = await loadBaselineBot(args['baseline-ref']!);
const candidate = args['candidate-ref'] === 'working-tree'
    ? { BotAdapter: BuiltInBotAdapter, commit: await git('rev-parse', 'HEAD') }
    : await loadBaselineBot(args['candidate-ref']!);
const candidateDiff = args['candidate-ref'] === 'working-tree'
    ? await git('diff', 'HEAD', '--', 'ts-redalert2/src/game/ai/thirdpartbot/builtIn') : '';
const candidateStatus = args['candidate-ref'] === 'working-tree'
    ? await git('status', '--porcelain', '--untracked-files=all', '--', 'ts-redalert2/src/game/ai/thirdpartbot/builtIn') : '';
const engineStatus = await git('status', '--porcelain', '--untracked-files=all', '--', 'ts-redalert2/src',
    ':(exclude)ts-redalert2/src/game/ai/thirdpartbot/builtIn', ':(exclude)ts-redalert2/src/test');
const engineDiff = await git('diff', 'HEAD', '--', 'ts-redalert2/src',
    ':(exclude)ts-redalert2/src/game/ai/thirdpartbot/builtIn', ':(exclude)ts-redalert2/src/test');
async function hashBotSources() {
    const directory = resolve(projectRoot, 'src/game/ai/thirdpartbot/builtIn');
    const filenames = (await readdir(directory, { recursive: true })).filter(filename => filename.endsWith('.ts')).sort();
    const digest = createHash('sha256');
    for (const filename of filenames) digest.update(filename).update('\0').update(await Bun.file(resolve(directory, filename)).text()).update('\0');
    return digest.digest('hex');
}
const report: any = {
    format: 1, engine: 'GameFactory/Game.update (same engine, physics, economy and fog of war for both bots)',
    engineCommit: await git('rev-parse', 'HEAD'),
    engineDirty: !!engineStatus, engineWorkingTreeStatus: engineStatus || null, engineDiffSha256: engineDiff ? hash(engineDiff) : null,
    candidate: { commit: candidate.commit, profile: args['candidate-profile'], source: args['candidate-ref'],
        dirty: !!candidateStatus, workingTreeStatus: candidateStatus || null, diffSha256: candidateDiff ? hash(candidateDiff) : null,
        sourceSha256: args['candidate-ref'] === 'working-tree' ? await hashBotSources() : null },
    baseline: { commit: baseline.commit, profile: args['baseline-profile'] },
    settings: { maxTicks, sampleTicks, credits, unitCount, gameSpeed: 3, engineDifficulty: AiDifficulty.Normal,
        pairedSpawnSwap: !args['no-swap'], pairedPlayerOrderSwap: !args['no-swap'], simulationTicksPerSecond: GameSpeed.BASE_TICKS_PER_SECOND,
        shortGame: true, superWeapons: false, crates: false, engineStalemateDetection: false },
    resources: { iniSha256: hash(baseBytes), customIniSha256: hash(customBytes) },
    metricNotes: {
        playerOrder: 'Every player array is [candidate, baseline], including swapped games.',
        creditsReceived: 'All positive credit changes after initialization, including mining, sales and cancellation refunds.',
        damageDealt: 'Positive incoming engine damage against other owners; includes overkill and neutral objects.',
        lostValue: 'Sum of rule costs of owned ObjectDestroy events; may include noncombat destruction.',
        lowCreditTicks: 'Ticks ending with credits below 100.',
        processedActions: 'Processed actions with a nonempty engine action log; not a count of units ordered.',
    },
    startupIssues, matches: [],
};
const outputPath = resolve(args.out!);
await mkdir(dirname(outputPath), { recursive: true });
async function saveReport() {
    report.summary = {
        total: report.matches.length,
        candidateWins: report.matches.filter((match: any) => match.result === 'candidate-win').length,
        baselineWins: report.matches.filter((match: any) => match.result === 'baseline-win').length,
        draws: report.matches.filter((match: any) => match.result === 'draw').length,
        invalid: report.matches.filter((match: any) => match.result === 'error').length,
    };
    await Bun.write(outputPath, JSON.stringify(report, null, 2) + '\n');
}

function recordPlayer(player: any, bot: any, economy: any) {
    const objects = player.getOwnedObjects();
    const counts: Record<string, number> = {};
    for (const object of objects) counts[object.name] = (counts[object.name] ?? 0) + 1;
    const combatUnits = objects.filter((object: any) => object.rules.isSelectableCombatant && !object.isBuilding() && !object.rules.harvester);
    const missions = bot?.innerBot?.missionController?.getMissions?.() ?? [];
    return {
        name: player.name, country: player.country.name, defeated: player.defeated, resigned: player.resigned,
        credits: player.credits, creditsReceived: economy.received, creditsSpent: economy.spent,
        // Received includes harvest income, selling and production cancellation refunds.
        harvesters: objects.filter((object: any) => object.rules.harvester).length,
        buildings: objects.filter((object: any) => object.isBuilding()).length,
        army: combatUnits.length, idleArmy: combatUnits.filter((object: any) => !object.unitOrderTrait.hasTasks()).length,
        armyCentroid: combatUnits.length ? { x: combatUnits.reduce((sum: number, object: any) => sum + object.tile.rx, 0) / combatUnits.length,
            y: combatUnits.reduce((sum: number, object: any) => sum + object.tile.ry, 0) / combatUnits.length } : null,
        assetValue: objects.reduce((sum: number, object: any) => sum + (object.rules.cost ?? 0), 0),
        kills: player.getUnitsKilled(), losses: player.getUnitsLost(), score: player.score,
        power: { available: player.powerTrait.power, used: player.powerTrait.drain }, counts,
        queues: player.production.getAllQueues().map((queue: any) => ({ type: queue.type, status: queue.status,
            items: queue.getAll().map((item: any) => ({ name: item.rules.name, quantity: item.quantity, progress: item.progress })) })),
        missions: missions.map((mission: any) => ({ name: mission.getUniqueName(), state: mission.getState?.(),
            units: mission.getUnitIds().length, target: mission.squad?.targetArea ?? mission.attackArea ?? mission.defenceArea,
            center: mission.getCenterOfMass?.(), requestedUnitCount: mission.requestedUnitCount })),
    };
}

const theaterOptions: Record<number, [string, string, string]> = {
    1: ['temperat.ini', 'isotemp.mix', '.tem'], 2: ['urban.ini', 'isourb.mix', '.urb'], 4: ['snow.ini', 'isosnow.mix', '.sno'],
};
for (const mapName of args.map!.split(',')) {
    const filename = mapName.endsWith('.map') || mapName.endsWith('.mpr') ? mapName : `${mapName}.map`;
    const mapPath = resolve(args.cdn!, 'maps', filename);
    const mapBytes = new Uint8Array(await Bun.file(mapPath).arrayBuffer());
    const mapText = new TextDecoder().decode(mapBytes);
    const mapMetadata = new MapFile().fromString(mapText);
    if (mapMetadata.startingLocations.length < 2) throw new Error(`${filename} requires at least two start locations`);
    const theaterSpec = theaterOptions[mapMetadata.theaterType];
    if (!theaterSpec) throw new Error(`Unsupported benchmark theater ${mapMetadata.theaterType}`);
    const [theaterIni, tileArchive, extension] = theaterSpec;
    const tileBytes = new Uint8Array(await Bun.file(resolve(args.cdn!, 'game-res/v2', tileArchive)).arrayBuffer());
    const tileMix = readMix(tileArchive, tileBytes).mix;
    const tileData = new Map<string, TmpFile>();
    const tileSets = new TileSets(ini(theaterIni));
    tileSets.loadTileData({ get(name: string) {
        if (!tileMix.containsFile(name)) return null;
        if (!tileData.has(name)) tileData.set(name, new TmpFile(tileMix.openFile(name)));
        return tileData.get(name);
    } }, extension);

    for (const [candidateCountry, baselineCountry] of matchups) for (const seed of seeds) for (const swapped of args['no-swap'] ? [false] : [false, true]) {
        const label = `${filename} ${candidateCountry}:${baselineCountry} seed=${seed} swap=${swapped}`;
        writeProgress(`Starting ${label}`);
        const telemetry: any = { errorCount: 0, warningCount: 0, issues: [], noTargetDisbands: 0, noTargetDisbandsByPlayer: [0, 0],
            unableToAcquireDisbands: [0, 0], productionCancellations: [{}, {}], productionCancellationSamples: [[], []],
            weaponShots: [0, 0], firstShotTick: [null, null], firstAttackOrderTick: [null, null], ordersByType: [{}, {}],
            damageDealt: [0, 0], lostValue: [0, 0], producedUnits: [0, 0], processedActions: [0, 0], lowCreditTicks: [0, 0] };
        activeTelemetry = telemetry;
        const candidatePlayerName = swapped ? '@@AI2@@' : '@@AI1@@';
        const baselinePlayerName = swapped ? '@@AI1@@' : '@@AI2@@';
        activeCandidateName = candidatePlayerName;
        const bots = new Map<string, any>();
        const economy = [{ received: 0, spent: 0 }, { received: 0, spent: 0 }];
        let game: any;
        const startedAt = performance.now();
        const samples: any[] = [];
        const match: any = { map: filename, mapSha256: hash(mapBytes), terrainSha256: hash(tileBytes),
            seed, swapped, candidateCountry, baselineCountry, candidatePlayerName, baselinePlayerName, result: 'error', telemetry, samples };
        try {
            const map = new MapFile().fromString(mapText);
            const countryId = (name: string) => {
                const index = countryNames.indexOf(name);
                if (index < 0) throw new Error(`Unknown country ${name}`);
                return index;
            };
            const playerOptions = [
                { difficulty: AiDifficulty.Normal, countryId: countryId(candidateCountry), colorId: 0, startPos: swapped ? 1 : 0, teamId: -2 },
                { difficulty: AiDifficulty.Normal, countryId: countryId(baselineCountry), colorId: 1, startPos: swapped ? 0 : 1, teamId: -2 },
            ];
            if (swapped) playerOptions.reverse();
            const options: GameOpts = { gameMode: 1, gameSpeed: 3, credits, unitCount, shortGame: true, superWeapons: false,
                buildOffAlly: false, mcvRepacks: true, cratesAppear: false, destroyableBridges: true,
                multiEngineer: false, noDogEngiKills: false, mapName: filename, mapTitle: filename,
                mapDigest: hash(mapBytes), mapSizeBytes: mapBytes.length, maxSlots: map.startingLocations.length, mapOfficial: true,
                humanPlayers: [], aiPlayers: playerOptions };
            game = GameFactory.create(map as any, tileSets, baseRules, baseArt, ini('ai.ini'), ini(modes.getById(1).rulesOverride),
                [], String(seed), 1, options, modes as any, true, {}, undefined, new BoxedVar(false), new BoxedVar(0), {
                    debug(message: string) { const side = message.startsWith(`(${candidatePlayerName})`) ? 0 : message.startsWith(`(${baselinePlayerName})`) ? 1 : -1;
                        if (side >= 0) {
                            telemetry.processedActions[side]++;
                            const order = /: (\w+) order/.exec(message)?.[1];
                            if (order) telemetry.ordersByType[side][order] = (telemetry.ordersByType[side][order] ?? 0) + 1;
                            if (order === 'Attack' || order === 'AttackMove') telemetry.firstAttackOrderTick[side] ??= game.currentTick;
                        }
                    },
                });
            activeGame = game;
            game.botManager.botFactory = { create(player: any) {
                const side = player.name === candidatePlayerName ? 0 : 1;
                const BotAdapter = side === 0 ? candidate.BotAdapter : baseline.BotAdapter;
                const bot = new BotAdapter(player.name, player.country.name, profiles[side] as 'normal' | 'brutal');
                bots.set(player.name, bot);
                return bot;
            } };
            game.init(undefined);
            // All arrays in the report remain [candidate, baseline], including swapped games.
            const players = [game.getPlayerByName(candidatePlayerName), game.getPlayerByName(baselinePlayerName)];
            match.startingLocations = players.map((player: any) => map.startingLocations[player.startLocation]);
            // Observe the original credit accessor without changing its validation or value.
            for (const [side, player] of players.entries()) {
                const creditProperty = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(player), 'credits')!;
                Object.defineProperty(player, 'credits', { configurable: true,
                    get: () => creditProperty.get!.call(player),
                    set: value => { const delta = value - creditProperty.get!.call(player); creditProperty.set!.call(player, value);
                        economy[side][delta >= 0 ? 'received' : 'spent'] += Math.abs(delta); },
                });
            }
            const sideOf = (player: any) => players.indexOf(player);
            game.events.subscribe((event: any) => {
                if (event.type === EventType.WeaponFire) {
                    const side = sideOf(event.gameObject.owner);
                    if (side >= 0) { telemetry.weaponShots[side]++; telemetry.firstShotTick[side] ??= game.currentTick; }
                } else if (event.type === EventType.InflictDamage) {
                    const owner = event.attacker?.player ?? event.attacker?.owner;
                    const side = sideOf(owner);
                    if (side >= 0 && owner !== event.target.owner) telemetry.damageDealt[side] += Math.max(0, event.damageHitPoints);
                } else if (event.type === EventType.ObjectDestroy) {
                    const side = sideOf(event.target.owner);
                    if (side >= 0) telemetry.lostValue[side] += event.target.rules.cost ?? 0;
                } else if (event.type === EventType.FactoryProduceUnit) {
                    const side = sideOf(event.target.owner);
                    if (side >= 0) telemetry.producedUnits[side]++;
                }
            });
            game.start();
            // Capture AI diagnostic messages without enabling gameplay debug mode.
            for (const player of players) AppLogger.get(player.name).setLevel(AppLogger.DEBUG);
            const buildingObservers = players.map(player => observeBuildingMissions(bots.get(player.name), () => game.currentTick));
            const sample = () => {
                const playerSamples = players.map((player: any, side: number) => ({
                    ...recordPlayer(player, bots.get(player.name), economy[side]), buildingPlanning: buildingObservers[side](),
                }));
                samples.push({ tick: game.currentTick, players: playerSamples });
                writeProgress(`  tick=${game.currentTick} ${playerSamples.map((player: any, side: number) => `${side === 0 ? 'candidate' : 'baseline'} credits=${player.credits} miners=${player.harvesters} army=${player.army} buildings=${player.buildings}`).join(' | ')}`);
            };
            sample();
            while (game.currentTick < maxTicks && game.status !== GameStatus.Ended) {
                game.update();
                players.forEach((player: any, side: number) => { if (player.credits < 100) telemetry.lowCreditTicks[side]++; });
                if (game.currentTick % sampleTicks === 0) sample();
            }
            if (samples.at(-1)?.tick !== game.currentTick) sample();
            match.ticks = game.currentTick;
            match.simulationSeconds = game.currentTick / GameSpeed.BASE_TICKS_PER_SECOND;
            const survivors = players.map((player: any, side: number) => ({ side, alive: !player.defeated && !player.resigned })).filter((player: any) => player.alive);
            match.result = telemetry.errorCount ? 'error' : game.status === GameStatus.Ended && survivors.length === 1
                ? survivors[0].side === 0 ? 'candidate-win' : 'baseline-win' : 'draw';
            match.reason = telemetry.errorCount ? 'logged-runtime-errors' : game.status !== GameStatus.Ended ? 'tick-limit' : 'engine-victory-conditions';
        } catch (error) {
            match.reason = 'uncaught-runtime-error';
            match.error = error instanceof Error ? error.stack : String(error);
            if (game) match.ticks = game.currentTick;
        } finally {
            match.wallSeconds = (performance.now() - startedAt) / 1000;
            try { game?.dispose(); } catch (error) { match.disposeError = String(error); match.result = 'error'; match.reason = 'dispose-runtime-error'; }
            if (telemetry.errorCount && match.result !== 'error') { match.result = 'error'; match.reason = 'logged-runtime-errors'; }
            activeGame = undefined;
            activeTelemetry = undefined;
        }
        report.matches.push(match);
        await saveReport();
        writeProgress(`Finished ${label}: ${match.result} ticks=${match.ticks ?? 0} errors=${telemetry.errorCount} (${match.wallSeconds.toFixed(1)}s)`);
    }
}
await saveReport();
writeProgress(JSON.stringify(report.summary) + `\nReport: ${outputPath}`);
if (report.summary.invalid) process.exitCode = 1;

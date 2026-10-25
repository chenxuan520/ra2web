/** Same-unit real-engine ablation. Preplaced troops are not full-game strength evidence. */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSpecialtyGame, loadSpecialtyResources, spawnSpecialtyObject } from './ai-specialty-scenarios';
import { observeSpecialtyCombat } from './ai-specialty-telemetry';
import { ObjectType } from '../src/engine/type/ObjectType';
import { OrderType } from '../src/game/order/OrderType';
import { Vector2 } from '../src/game/math/Vector2';
import { AppLogger } from '../src/util/logger';
import { Mission } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/mission';
import { DogEscortMission } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/dogEscortMission';
import { CombatSquad } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/combatSquad';
import { ActionBatcher } from '../src/game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher';
import { SpeedType } from '../src/game/type/SpeedType';

function findArena(game: any, specs: { x: number; y: number; type: ObjectType }[]) {
    const tiles: any[] = [];
    game.map.tiles.forEach((tile: any) => tiles.push(tile));
    const starts = game.map.startingLocations;
    const middle = { x: (starts[0].x + starts[1].x) / 2, y: (starts[0].y + starts[1].y) / 2 };
    tiles.sort((a, b) => Math.hypot(a.rx - middle.x, a.ry - middle.y) - Math.hypot(b.rx - middle.x, b.ry - middle.y) || a.rx - b.rx || a.ry - b.ry);
    return tiles.find(origin => {
        if (!specs.every(spec => {
            const tile = game.map.tiles.getByMapCoords(origin.rx + spec.x, origin.ry + spec.y);
            return tile && tile.z === origin.z && tile.onBridgeLandType === undefined &&
                game.map.terrain.getPassableSpeed(tile, spec.type === ObjectType.Infantry ? SpeedType.Foot : SpeedType.Track,
                    spec.type === ObjectType.Infantry, false) > 0 &&
                !game.map.getObjectsOnTile(tile).some((o: any) => o.isTechno() || o.isTerrain()) &&
                !game.getCombatants().some((p: any) => p.getOwnedObjects().some((o: any) => Math.hypot(o.tile.rx - tile.rx, o.tile.ry - tile.ry) < 16));
        })) return false;
        const destination = game.map.tiles.getByMapCoords(origin.rx + 12, origin.ry);
        if (!destination) return false;
        return game.map.terrain.computePath(SpeedType.Track, false, origin, false, destination, false,
            { bestEffort: false, maxExpandedNodes: 2000 })
            .some((node: any) => node.tile.rx === destination.rx && node.tile.ry === destination.ry);
    });
}

class FixtureArmy extends Mission {
    private combat: CombatSquad;
    constructor(private target: Vector2) {
        super('fixture-army', () => {});
        this.combat = new CombatSquad(target, target, 15);
    }
    getAttackArea() { return this.target; }
    getPriority() { return 50; }
    getGlobalDebugText() { return this.combat.getGlobalDebugText(); }
    _onAiUpdate(context: any) { return this.combat.onAiUpdate(context, this, () => {}); }
}

export async function runRhinoDogFixtures(cdn?: string, observe = true) {
    const resources = await loadSpecialtyResources(cdn, 'mp11t2.map');
    const results: any[] = [];
    for (const opponent of ['automatic', 'C18-combat-micro']) for (const enabled of [false, true]) for (const swapped of [false, true]) {
        const { game, players, bots } = createSpecialtyGame(resources, 610101, ['Russians', 'Russians']);
        const objects: any[][] = [[], []];
        let telemetry: ReturnType<typeof observeSpecialtyCombat> | undefined;
        try {
            const specs = [0, 1].flatMap(side => [
                ...[-3, -1, 1, 3].map((y, i) => ({ label: `tank-${side}-${i}`, name: 'HTNK', type: ObjectType.Vehicle,
                    player: side, x: side ? 12 : 0, y })),
                ...[-2, 2].map((y, i) => ({ label: `dog-${side}-${i}`, name: 'DOG', type: ObjectType.Infantry,
                    player: side, x: side ? 14 : -2, y })),
            ]);
            const origin = findArena(game, specs);
            if (!origin) throw new Error('No clear dog/tank fixture arena');
            for (const spec of specs) objects[spec.player].push(spawnSpecialtyObject(game, spec, origin, players));
            const candidate = swapped ? 1 : 0;
            telemetry = observe ? observeSpecialtyCombat(game, [players[candidate], players[1 - candidate]]) : undefined;
            game.start();
            let escortCommands = 0, wrongEscortUnitCommands = 0, cohesionSum = 0, cohesionSamples = 0;
            const candidateDogIds = new Set(objects[candidate].filter(o => o.name === 'DOG').map(o => o.id));
            const armies = players.map((_p: any, side: number) => new FixtureArmy(new Vector2(origin.rx + (side ? 0 : 12), origin.ry)));
            const dogMission = new DogEscortMission(armies[candidate], () => {}, enabled);
            for (const side of [0, 1]) {
                const bot = bots.get(players[side].name)!;
                for (const object of objects[side]) {
                    if (side === candidate && object.name === 'DOG') dogMission.addUnit(object.id);
                    else armies[side].addUnit(object.id);
                }
                let initialOrder = false;
                bot.onGameTick = () => {
                    if (game.currentTick % 6) return;
                    const api = bot.gameApi;
                    if (side !== candidate && opponent === 'automatic') {
                        if (!initialOrder) {
                            bot.actionsApi.orderUnits(objects[side].map(o => o.id), OrderType.AttackMove, origin.rx + (side ? 0 : 12), origin.ry);
                            initialOrder = true;
                        }
                        return;
                    }
                    const batcher = new ActionBatcher();
                    const context: any = { game: api, player: { name: bot.name, actions: bot.actionsApi, production: bot.productionApi },
                        difficulty: 'brutal', actionBatcher: batcher, matchAwareness: {
                            getMainRallyPoint: () => new Vector2(origin.rx + (side ? 12 : 0), origin.ry),
                            getHostilesNearPoint: (x: number, y: number, radius: number) => api.getVisibleUnits(bot.name, 'enemy')
                                .map(id => api.getUnitData(id)).filter(u => u && Math.hypot(u.tile.rx - x, u.tile.ry - y) <= radius)
                                .map(u => ({ unitId: u!.id })),
                        } };
                    armies[side].onAiUpdate(context);
                    batcher.resolve(bot.actionsApi);
                    if (side === candidate) {
                        const dogBatcher = new ActionBatcher();
                        dogMission.onAiUpdate({ ...context, actionBatcher: dogBatcher });
                        dogBatcher.resolve({ orderUnits(ids: number[], ...args: any[]) {
                            escortCommands++;
                            wrongEscortUnitCommands += ids.filter(id => !candidateDogIds.has(id)).length;
                            return (bot.actionsApi.orderUnits as any).call(bot.actionsApi, ids, ...args);
                        } } as any);
                        if (game.currentTick % 30 === 0) {
                            const tanks = objects[side].filter(o => o.name === 'HTNK' && !o.isDestroyed);
                            for (const dog of objects[side].filter(o => o.name === 'DOG' && !o.isDestroyed)) if (tanks.length) {
                                cohesionSum += Math.min(...tanks.map(t => Math.hypot(t.tile.rx - dog.tile.rx, t.tile.ry - dog.tile.ry)));
                                cohesionSamples++;
                            }
                        }
                    }
                };
            }
            let ticks = 0;
            while (ticks < 1800 && objects.every(units => units.some(o => o.name === 'HTNK' && !o.isDestroyed))) {
                game.update(); ticks++;
            }
            const final = [candidate, 1 - candidate].map(side => ({
                tanks: objects[side].filter(o => o.name === 'HTNK' && !o.isDestroyed).length,
                tankHitPoints: objects[side].filter(o => o.name === 'HTNK' && !o.isDestroyed).reduce((s, o) => s + o.healthTrait.getHitPoints(), 0),
                dogs: objects[side].filter(o => o.name === 'DOG' && !o.isDestroyed).length,
            }));
            results.push({ opponent, escortEnabled: enabled, swapped, ticks, final, escortCommands, wrongEscortUnitCommands,
                meanDogDistanceFromTank: cohesionSamples ? cohesionSum / cohesionSamples : null,
                telemetry: telemetry?.snapshot() });
        } finally { telemetry?.dispose(); game.dispose(); }
    }
    return { kind: 'preplaced-real-engine-dog-escort-ablation', seed: 610101, resources: resources.hashes,
        passed: results.every(r => r.escortCommands > 0 && r.wrongEscortUnitCommands === 0),
        notes: ['Same four rhinos and two dogs on each side; does not test production or full-game win rate.',
            'C18-combat-micro uses the CombatSquad source unchanged from C18; automatic uses engine attack-move.',
            'These are exploratory development fixtures. Poor tactical outcomes are retained, not converted to success.'], results };
}

if (import.meta.main) {
    const { values: args } = parseArgs({ options: { cdn: { type: 'string', default: process.env.RA2_BENCHMARK_CDN },
        out: { type: 'string', default: '.artifacts/ai-benchmark/rhino-dog-fixtures.json' }, 'no-telemetry': { type: 'boolean' } } });
    const errors: string[] = [];
    console.log = () => {}; console.debug = () => {};
    console.error = (...args: any[]) => errors.push(args.map(String).join(' '));
    AppLogger.setLevel(AppLogger.ERROR);
    const result = await runRhinoDogFixtures(args.cdn, !args['no-telemetry']);
    const output = { ...result, errors, passed: result.passed && !errors.length };
    await mkdir(dirname(resolve(args.out!)), { recursive: true });
    await Bun.write(args.out!, JSON.stringify(output, null, 2) + '\n');
    process.stderr.write(JSON.stringify({ passed: output.passed, cases: result.results.length,
        outcomes: result.results.map(({ opponent, escortEnabled, swapped, final }) => ({ opponent, escortEnabled, swapped, final })) }) + '\n');
    if (!output.passed) process.exitCode = 1;
}

import { describe, expect, mock, test } from 'bun:test';
import { ObjectType, OrderType, QueueStatus, QueueType, Vector2, ZoneType } from '../../game/ai/thirdpartbot/builtIn/game-api';
import { DefaultStrategy } from '../../game/ai/thirdpartbot/builtIn/bot/strategy/defaultStrategy';
import { ActionBatcher } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher';
import { FieldArmyMission } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/fieldArmyMission';
import { MissionController } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController';
import { QueueController, QUEUES } from '../../game/ai/thirdpartbot/builtIn/bot/logic/building/queueController';

function fixture() {
    let tick = 3000;
    const foot: any = { name: 'E2', type: ObjectType.Infantry, strength: 100, isSelectableCombatant: true };
    const units = new Map<number, any>(Array.from({ length: 8 }, (_, i) => [i + 1, { id: i + 1, name: 'E2', owner: 'bot',
        type: ObjectType.Infantry, rules: foot, tile: { rx: 0, ry: 0 }, hitPoints: 100, maxHitPoints: 100, zone: ZoneType.Ground, isIdle: true, canMove: true }]));
    units.set(100, { id: 100, name: 'HARV', owner: 'bot', tile: { rx: 0, ry: 0 }, rules: { name: 'HARV', harvester: true } });
    units.set(101, { id: 101, name: 'NAWEAP', owner: 'bot', tile: { rx: 0, ry: 0 }, rules: { name: 'NAWEAP', weaponsFactory: true } });
    const player: any = { name: 'bot', country: { name: 'Russians', side: 1 }, credits: 5000, startLocation: new Vector2() };
    const available = [foot, { name: 'HTNK' }, { name: 'HTK' }];
    const game: any = { getCurrentTick: () => tick, getPlayers: () => ['bot', 'enemy'], areAlliedPlayers: () => false, generateRandomInt: () => 0,
        getPlayerData: (name: string) => name === 'bot' ? player : { name, isCombatant: true },
        getVisibleUnits: (_: string, relation: string, predicate = (_: any) => true) => relation === 'enemy' ? [] :
            [...units.values()].filter(unit => predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => units.get(id), getGameObjectData: (id: number) => units.get(id),
        rulesApi: { infantryRules: new Map([['E2', foot]]), vehicleRules: new Map(), aircraftRules: new Map(), buildingRules: new Map() },
        mapApi: { getTile: (rx: number, ry: number) => ({ rx, ry }), getStartingLocations: () => [new Vector2(), new Vector2(80, 0)],
            isVisibleTile: () => false, getRealMapSize: () => ({ width: 80, height: 80 }), isPassableTile: () => true } };
    const controller = new MissionController(() => {});
    const context: any = { difficulty: 'brutal', game, player: { name: 'bot', production: { getAvailableObjects: () => available } },
        matchAwareness: { getMainRallyPoint: () => new Vector2(4, 0), getThreatCache: () => null, getHostilesNearPoint: () => [] } };
    const strategy = new DefaultStrategy();
    return { units, game, context, controller, player, at(value: number) { tick = value; },
        plan() { return (strategy as any).selectRandomAttackComposition(context, () => {}, controller); } };
}

describe('bounded paid infantry support during armor assembly', () => {
    test('the explicit opening plan launches eight conscripts and requests bounded paid reinforcements', () => {
        const f = fixture(), plan = f.plan(); expect(plan.minimumUnits).toBe(8); expect(plan.maximumUnits).toBe(16);
        const army = new FieldArmyMission(plan, f.controller, () => {}); f.controller.addMission(army);
        for (let id = 1; id <= 8; id++) army.addUnit(id);
        const actionBatcher = new ActionBatcher(), orders: any[][] = [];
        const result: any = army.onAiUpdate({ ...f.context, actionBatcher });
        actionBatcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any, f.game.mapApi);
        expect(army.isAttacking()).toBe(true); expect(orders.some(order => order[1] === OrderType.AttackMove && order[2] === 80)).toBe(true);
        expect(result.unitNameToPriority.E2).toBe(95);
        f.at(4000); expect(army.onAiUpdate({ ...f.context, actionBatcher }).type).toBe('releaseUnits');
    });
    test('no income, normal difficulty and the fixed deadline do not opt into this plan', () => {
        const noIncome = fixture(); noIncome.units.delete(100); expect(noIncome.plan()?.minimumUnits).not.toBe(8);
        const normal = fixture(); normal.context.difficulty = 'normal'; expect(normal.plan().minimumUnits).toBe(3);
        const late = fixture(); late.at(4000); expect(late.plan()?.composition.E2).toBeUndefined();
    });
    test('ordinary infantry plans preserve the original Soviet home role', () => {
        const f = fixture(), army = new FieldArmyMission({ composition: { E2: 1 }, minimumUnits: 3, maximumUnits: 10 }, f.controller, () => {});
        army.addUnit(1); expect(army.onAiUpdate({ ...f.context, actionBatcher: new ActionBatcher() }).type).toBe('releaseUnits');
    });
});

function production(ownedCount: number, tick: number, priority: number) {
    const rule: any = { name: 'E2', cost: 100, type: ObjectType.Infantry };
    const own = Array.from({ length: ownedCount }, () => rule), queues = new Map(QUEUES.map(type => [type, { type, status: QueueStatus.Idle, items: [], size: 0 }]));
    const actions = { queueForProduction: mock(() => {}), unqueueFromProduction: mock(() => {}), pauseProduction: mock(() => {}), resumeProduction: mock(() => {}) };
    new QueueController().onAiUpdate({ difficulty: 'brutal', player: { name: 'bot', actions, production: {
        getAvailableObjects: (type: number) => type === QueueType.Infantry ? [rule] : [], getQueueData: (type: number) => queues.get(type) } },
        game: { getCurrentTick: () => tick, getPlayerData: () => ({ name: 'bot', country: { name: 'Russians' }, credits: 3000, startLocation: new Vector2() }),
            getVisibleUnits: (_: string, relation: string, predicate = (_: any) => true) => (relation === 'enemy' ? [] : own).filter(predicate).map((_, id) => id) } } as any,
        null, new Map([['E2', { priority, specificLocation: null }]]), () => {});
    return actions;
}

test('opening production remains paid, capped and does not change ordinary requests', () => {
    expect(production(8, 3000, 95).queueForProduction).toHaveBeenCalledWith(QueueType.Infantry, 'E2', ObjectType.Infantry, 1);
    for (const [count, tick, priority] of [[16, 3000, 95], [8, 4000, 95], [8, 3000, 20]])
        expect(production(count, tick, priority).queueForProduction).not.toHaveBeenCalled();
});

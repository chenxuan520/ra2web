import { describe, expect, test } from 'bun:test';
import { MovementZone, ObjectType, OrderType, SpeedType, Vector2 } from '../../game/ai/thirdpartbot/builtIn/game-api';
import { MissionController } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController';
import { SneakCaptureMission, SneakCaptureMissionFactory } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/sneakCaptureMission';

function fixture() {
    let tick = 0, visible = true;
    const rule = { name: 'ENGINEER', cost: 500, strength: 75, armor: 0, type: ObjectType.Infantry,
        speedType: SpeedType.Foot, movementZone: MovementZone.Infantry };
    const unit = (id: number, name: string, rx: number, flags = {}) => ({ id, name, owner: 'bot', type: ObjectType.Vehicle,
        hitPoints: 400, maxHitPoints: 400, tile: { rx, ry: 0 }, isIdle: true, isWarpedOut: false,
        rules: { name, armor: 1, ...flags } });
    const own: any[] = [unit(1, 'GACNST', 0, { constructionYard: true }), unit(2, 'CMIN', 0, { harvester: true }),
        unit(3, 'CMIN', 0, { harvester: true }), ...[4, 5, 6, 7].map(id => unit(id, 'MTNK', 1, { isSelectableCombatant: true }))];
    const target: any = { ...unit(20, 'NACNST', 24), owner: 'enemy', type: ObjectType.Building,
        foundation: { width: 3, height: 3 }, rules: { name: 'NACNST', capturable: true, constructionYard: true } };
    const enemies = [target];
    const orders: any[] = [];
    const controller = new MissionController(() => {});
    const factory = new SneakCaptureMissionFactory();
    const player = { name: 'bot', credits: 1600 };
    const game = {
        getCurrentTick: () => tick, getPlayerData: () => player,
        getVisibleUnits: (_player: string, side: string, filter: (rules: any) => boolean = () => true) =>
            (side === 'self' ? own : visible ? enemies : []).filter(object => filter(object.rules)).map(object => object.id),
        getUnitData: (id: number) => [...own, ...enemies].find(object => object.id === id),
        getGameObjectData: (id: number) => [...own, ...enemies].find(object => object.id === id),
        mapApi: { getTile: (rx: number, ry: number) => ({ rx, ry }), isVisibleTile: () => true,
            hasBridgeOnTile: () => false, isPassableTile: () => true,
            findPath: (_speed: any, start: any, end: any, options: any) =>
                [end, start].some(node => options.excludeNodes(node)) ? [] : [end, start] },
    };
    const context: any = { difficulty: 'brutal', game, player: { name: 'bot', actions: {
        orderUnits: (...args: any[]) => orders.push(args),
    }, production: { getAvailableObjects: () => [rule] } }, matchAwareness: {
        getMainRallyPoint: () => new Vector2(),
        getHostilesNearPoint2d: (point: Vector2, radius: number) => enemies.filter(enemy =>
            new Vector2(enemy.tile.rx, enemy.tile.ry).distanceTo(point) <= radius).map(enemy => ({ unitId: enemy.id })),
    } };
    return { context, target, own, enemies, orders, controller, player,
        launch(next = 0) { tick = next; factory.maybeCreateMissions(context, controller, () => {}); return controller.getMissions().at(-1) as SneakCaptureMission; },
        step(mission: SneakCaptureMission, next: number) { tick = next; return mission.onAiUpdate(context); },
        engineer(rx = 0) { const engineer = { ...unit(10, 'ENGINEER', rx), type: ObjectType.Infantry, rules: rule }; own.push(engineer); return engineer; },
        guard(rx = 24) { const guard: any = { ...unit(30, 'E2', rx), owner: 'enemy', primaryWeapon: {
            rules: { damage: 25, rof: 15 }, maxRange: 6, projectileRules: { isAntiGround: true },
            warheadRules: { verses: new Map([[0, 1]]) } } }; enemies.push(guard); return guard; },
        hide() { visible = false; },
    };
}

describe('opportunistic engineer capture', () => {
    test('funds one engineer for a visible unguarded strategic building', () => {
        const f = fixture(); const mission = f.launch();
        expect(mission).toBeInstanceOf(SneakCaptureMission);
        expect(f.step(mission, 0)).toEqual({ type: 'request', unitNameToPriority: { ENGINEER: 20 } });
        f.launch(150); expect(f.controller.getMissions()).toHaveLength(1);
    });
    test('does not start at normal difficulty, without spare funds, or into known guards', () => {
        for (const reason of ['normal', 'funds', 'guards', 'visibility', 'home-attack']) {
            const f = fixture();
            if (reason === 'normal') f.context.difficulty = 'normal';
            if (reason === 'funds') f.player.credits = 1200;
            if (reason === 'guards') f.guard();
            if (reason === 'visibility') f.hide();
            if (reason === 'home-attack') f.guard(3);
            f.launch(); expect(f.controller.getMissions()).toHaveLength(0);
        }
    });
    test('issues the real Capture command once without restarting an active approach', () => {
        const f = fixture(); const mission = f.launch(); const engineer = f.engineer(); mission.addUnit(engineer.id);
        f.step(mission, 2); engineer.isIdle = false; f.step(mission, 100);
        expect(f.orders).toEqual([[[10], OrderType.Capture, 20]]);
    });
    test('returns when guards arrive and releases once home', () => {
        const f = fixture(); const mission = f.launch(); const engineer = f.engineer(10); mission.addUnit(engineer.id);
        f.step(mission, 2); f.guard(); f.step(mission, 32);
        expect(mission.getState()).toBe('returning'); expect(f.orders.at(-1)).toEqual([[10], OrderType.Move, 0, 0]);
        engineer.isIdle = false; f.step(mission, 62); expect(f.orders).toHaveLength(2);
        engineer.tile.rx = 0; expect(f.step(mission, 92).type).toBe('disband');
    });
    test('recognizes changed ownership as success instead of creating another capture order', () => {
        const f = fixture(); const mission = f.launch(); f.target.owner = 'bot';
        expect(f.step(mission, 2)).toEqual({ type: 'disband', reason: 'captured' }); expect(f.orders).toEqual([]);
    });
    test('bounds losses to two attempts per target and waits between investments', () => {
        const f = fixture(); const first = f.launch(); first.endMission('engineer-lost');
        f.launch(150); expect(f.controller.getMissions()).toHaveLength(1);
        const second = f.launch(1800); expect(f.controller.getMissions()).toHaveLength(2); second.endMission('engineer-lost');
        f.launch(3600); expect(f.controller.getMissions()).toHaveLength(2);
    });
});

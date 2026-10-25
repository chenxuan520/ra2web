import { describe, expect, test } from 'bun:test';
import { ParaDropSupport } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/paraDropSupport';
import { SuperWeaponStatus, SuperWeaponType, Vector2 } from '../../game/ai/thirdpartbot/builtIn/game-api';

function fixture() {
    let tick = 0;
    const orders: any[] = [];
    const powers: any[] = [{ playerName: 'self', type: SuperWeaponType.AmerParaDrop, status: SuperWeaponStatus.Ready }];
    const enemies: any[] = [];
    const controller = new ParaDropSupport();
    const context: any = {
        difficulty: 'brutal', player: { name: 'self', actions: { activateSuperWeapon: (...args: any[]) => orders.push(args) } },
        matchAwareness: { getMainRallyPoint: () => new Vector2(20, 20) },
        game: {
            getCurrentTick: () => tick, getAllSuperWeaponData: () => powers,
            getPlayerData: () => ({ startLocation: new Vector2(10, 10) }),
            getVisibleUnits: () => enemies.map(enemy => enemy.id), getUnitData: (id: number) => enemies.find(enemy => enemy.id === id),
            mapApi: { getTile: (rx: number, ry: number) => ({ rx, ry }), isVisibleTile: () => true, isPassableTile: () => true },
        },
    };
    return { context, orders, powers, enemies, step(nextTick = 0) { tick = nextTick; controller.onAiUpdate(context); } };
}

describe('earned paradrop support', () => {
    test('uses its ready ability at an explored safe rally without issuing production orders', () => {
        const f = fixture(); f.step();
        expect(f.orders).toEqual([[SuperWeaponType.AmerParaDrop, { rx: 20, ry: 20 }]]);
    });
    test('leaves normal, other players and non-paradrop superweapons unchanged', () => {
        const f = fixture(); f.context.difficulty = 'normal'; f.step();
        f.context.difficulty = 'brutal'; f.powers[0].playerName = 'enemy'; f.step(30);
        f.powers[0].playerName = 'self'; f.powers[0].type = SuperWeaponType.MultiMissile; f.step(60);
        expect(f.orders).toEqual([]);
    });
    test('does not activate a charging ability or spam a still-ready command', () => {
        const f = fixture(); f.powers[0].status = SuperWeaponStatus.Charging; f.step();
        expect(f.orders).toEqual([]);
        f.powers[0].status = SuperWeaponStatus.Ready; f.step(30); f.step(32); f.step(59);
        expect(f.orders).toHaveLength(1);
    });
    test('does not drop on unseen or impassable terrain', () => {
        const f = fixture(); f.context.game.mapApi.isVisibleTile = () => false; f.step();
        f.context.game.mapApi.isVisibleTile = () => true;
        f.context.game.mapApi.isPassableTile = () => false; f.step(30);
        expect(f.orders).toEqual([]);
    });
    test('moves the drop away from known ground or anti-air coverage', () => {
        const f = fixture();
        f.enemies.push({ id: 1, owner: 'enemy', hitPoints: 100, tile: { rx: 20, ry: 20 },
            primaryWeapon: { maxRange: 7, projectileRules: { isAntiAir: true } } });
        f.step();
        expect(f.orders).toHaveLength(1);
        const point = f.orders[0][1];
        expect(new Vector2(point.rx, point.ry).distanceTo(new Vector2(20, 20))).toBeGreaterThan(10);
    });
    test('waits when both base and rally are covered rather than waste the charge', () => {
        const f = fixture();
        f.enemies.push({ id: 1, owner: 'enemy', hitPoints: 100, tile: { rx: 15, ry: 15 },
            primaryWeapon: { maxRange: 30, projectileRules: { isAntiGround: true } } });
        f.step(); expect(f.orders).toEqual([]);
    });
});

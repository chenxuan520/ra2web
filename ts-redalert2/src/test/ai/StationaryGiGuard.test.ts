import { describe, expect, test } from 'bun:test';
import { AttackState, MovementZone, ObjectType, OrderType, QueueStatus, QueueType, StanceType, Vector2, ZoneType } from '../../game/ai/thirdpartbot/builtIn/game-api';
import { StationaryGiGuard } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/stationaryGiGuard';
import { ActionBatcher } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher';
import { AttackMission } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/attackMission';

function fixture(difficulty: 'normal' | 'brutal' = 'brutal') {
    let tick = 0;
    const rules = { name: 'E1', type: ObjectType.Infantry, isSelectableCombatant: true, movementZone: MovementZone.Infantry, armor: 0 };
    const weapon = { rules: { damage: 25, rof: 15 }, projectileRules: { isAntiAir: false, isAntiGround: true },
        maxRange: 5, minRange: 0, warheadRules: { verses: new Map([[0, 1], [1, 0]]) } };
    const gi = { id: 1, name: 'E1', owner: 'bot', type: ObjectType.Infantry, rules,
        tile: { rx: 0, ry: 0 }, isIdle: true, stance: StanceType.Guard, attackState: AttackState.Idle,
        secondaryWeapon: weapon, hitPoints: 100, maxHitPoints: 100 };
    const enemy = { ...gi, id: 100, owner: 'enemy', name: 'tank', rules: { armor: 0 }, tile: { rx: 4, ry: 0 },
        zone: ZoneType.Ground, isWarpedOut: false };
    const friendly: any[] = [gi];
    const enemies: any[] = [enemy];
    const orders: any[][] = [];
    const guard = new StationaryGiGuard();
    const context = {
        difficulty,
        game: {
            getCurrentTick: () => tick, getUnitData: (id: number) => [...friendly, ...enemies].find(unit => unit.id === id),
            getGameObjectData: (id: number) => [...friendly, ...enemies].find(unit => unit.id === id),
            getPlayerData: () => ({ startLocation: new Vector2() }),
            mapApi: { getTile: () => ({}) },
            rulesApi: { infantryRules: new Map([['E1', rules]]), vehicleRules: new Map(), aircraftRules: new Map(), buildingRules: new Map() },
        },
        player: { name: 'bot', production: {
            getAvailableObjects: () => [rules], getQueueTypeForObject: () => QueueType.Infantry,
            getQueueData: () => ({ status: QueueStatus.Active, items: [{ rules, quantity: 1 }] }),
        } },
        matchAwareness: { getHostilesNearPoint: () => enemies.map(unit => ({ unitId: unit.id })),
            getHostilesNearPoint2d: () => enemies.map(unit => ({ unitId: unit.id })) },
    };
    return {
        gi, enemy, friendly, enemies, orders,
        step(nextTick: number, mission?: AttackMission) {
            tick = nextTick;
            const actionBatcher = new ActionBatcher();
            const withBatcher = { ...context, actionBatcher } as any;
            const result = mission ? mission.onAiUpdate(withBatcher) : guard.onAiUpdate(withBatcher, friendly);
            actionBatcher.resolve({ orderUnits: (...args: any[]) => orders.push(args) } as any);
            return result;
        },
    };
}

describe('stationary GI preparation guard', () => {
    test('deploys in place for a legal visible target and sends no attack or movement orders', () => {
        const f = fixture();
        f.step(0);
        expect(f.orders).toEqual([[[1], OrderType.DeploySelected]]);
        expect(f.gi.tile).toEqual({ rx: 0, ry: 0 });
    });

    test('never toggles an already deployed GI, even after the enemy leaves', () => {
        const f = fixture();
        f.step(0);
        f.gi.stance = StanceType.Deployed;
        f.step(30);
        f.enemies.length = 0;
        f.step(60);
        expect(f.orders).toHaveLength(1);
    });

    test('throttles retries if the game has not accepted a deployment', () => {
        const f = fixture();
        for (let tick = 0; tick < 30; tick += 2) f.step(tick);
        expect(f.orders).toHaveLength(1);
        f.step(30);
        expect(f.orders).toHaveLength(2);
    });

    test('does not interrupt movement or an active firing sequence', () => {
        const f = fixture();
        f.gi.isIdle = false;
        f.step(0);
        f.gi.isIdle = true;
        for (const [index, state] of [AttackState.PrepareToFire, AttackState.FireUp, AttackState.Firing].entries()) {
            f.gi.attackState = state;
            f.step((index + 1) * 6);
        }
        expect(f.orders).toEqual([]);
    });

    test.each(['distant', 'air', 'neutral', 'dead', 'warped', 'immune', 'unseen'])('ignores %s targets', reason => {
        const f = fixture();
        if (reason === 'distant') f.enemy.tile.rx = 6;
        if (reason === 'air') f.enemy.zone = ZoneType.Air;
        if (reason === 'neutral') f.enemy.owner = '@@NEUTRAL@@';
        if (reason === 'dead') f.enemy.hitPoints = 0;
        if (reason === 'warped') f.enemy.isWarpedOut = true;
        if (reason === 'immune') f.enemy.rules.armor = 1;
        if (reason === 'unseen') f.enemies.length = 0;
        f.step(0);
        expect(f.orders).toEqual([]);
    });

    test('normal difficulty and other infantry retain their existing behavior', () => {
        const normal = fixture('normal');
        normal.step(0);
        expect(normal.orders).toEqual([]);
        const otherInfantry = fixture();
        otherInfantry.gi.name = 'E2';
        otherInfantry.step(0);
        expect(otherInfantry.orders).toEqual([]);
    });

    test('preparing attacks use the guard and the original attack controller can undeploy a completed wave', () => {
        const f = fixture();
        const mission = new AttackMission('gi-wave', 1, new Vector2(), new Vector2(30, 30), 10,
            { composition: { E1: 1 }, minimumUnits: 3, maximumUnits: 6 }, () => {});
        mission.addUnit(1);
        expect(f.step(0, mission)?.type).toBe('request');
        expect(f.orders).toEqual([[[1], OrderType.DeploySelected]]);
        f.gi.stance = StanceType.Deployed;
        f.enemies.length = 0;
        for (const id of [2, 3]) {
            f.friendly.push({ ...f.gi, id });
            mission.addUnit(id);
        }
        f.step(450, mission);
        expect(mission.getState()).toBe(1);
        f.step(452, mission);
        f.step(458, mission);
        expect(f.orders.at(-1)).toEqual([[1, 2, 3], OrderType.DeploySelected]);
    });
});

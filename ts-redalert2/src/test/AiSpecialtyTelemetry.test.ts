import { describe, expect, test } from 'bun:test';
import { observeSpecialtyCombat, readForceComposition } from '../../e2e/ai-specialty-telemetry';
import { GameEventBus } from '../game/GameEventBus';
import { EventType } from '../game/event/EventType';
import { ProductionQueue, QueueStatus, QueueType } from '../game/player/production/ProductionQueue';
import { BuildStatus } from '../game/gameobject/Building';
import { StanceType } from '../game/gameobject/infantry/StanceType';
import { SuperWeaponType } from '../game/type/SuperWeaponType';
import { SuperWeaponActivateEvent } from '../game/event/SuperWeaponActivateEvent';

function fixture() {
    const queue = new ProductionQueue(QueueType.Infantry, 10, 10);
    const players = [0, 1].map(index => ({ name: `P${index}`, objects: [] as any[],
        getOwnedObjects() { return this.objects; }, production: { getAllQueues: () => index === 0 ? [queue] : [] } }));
    const game: any = { currentTick: 0, events: new GameEventBus(), alliances: { areAllied: (a: any, b: any) => a === b },
        generateRandomInt() { throw new Error('Observation must not consume RNG'); } };
    const object = (name: string, side: number, id = 1) => ({ id, name, owner: players[side],
        rules: { cost: 600, strength: 100 }, healthTrait: { maxHitPoints: 100, getHitPoints: () => 100 } });
    return { game, players, queue, object };
}

describe('specialty combat observers', () => {
    test('separates exact queue-ready, factory, placement and building-ready ticks without duplicate queue updates', () => {
        const { game, players, queue, object } = fixture();
        const observer = observeSpecialtyCombat(game, players);
        queue.push({ name: 'DESO' }, 1, 600);
        game.currentTick = 10; queue.status = QueueStatus.Ready; queue.notifyUpdated();
        game.currentTick = 12; game.events.dispatch({ type: EventType.FactoryProduceUnit, target: object('DESO', 0) });
        queue.remove(queue.getFirst()!.rules, 1);
        queue.push({ name: 'DESO' }, 1, 600);
        game.currentTick = 20; queue.status = QueueStatus.Ready;
        game.currentTick = 30; game.events.dispatch({ type: EventType.BuildingPlace, target: object('GTGCAN', 0) });
        game.currentTick = 40; game.events.dispatch({ type: EventType.BuildStatusChange, target: object('GTGCAN', 0), status: BuildStatus.Ready });
        const snapshot = observer.snapshot();
        expect(snapshot.production[0].DESO.queueReadyTicks).toEqual([10, 20]);
        expect(snapshot.production[0].DESO.factoryProducedTicks).toEqual([12]);
        expect(snapshot.production[0].GTGCAN.placedTicks).toEqual([30]);
        expect(snapshot.production[0].GTGCAN.readyTicks).toEqual([40]);
        observer.dispose(); observer.dispose();
        game.events.dispatch({ type: EventType.FactoryProduceUnit, target: object('DESO', 0) });
        expect(observer.snapshot()).toEqual(snapshot);
    });

    test('reads real deployment transitions, preserves receiver and return identity, and restores inherited methods', () => {
        const { game, players, object } = fixture();
        let calls = 0;
        const returned = {};
        class Deployer {
            deployed = false;
            isDeployed() { return this.deployed; }
            setDeployed(value: boolean) { calls++; this.deployed = value; return returned; }
        }
        const deso = { ...object('DESO', 0), deployerTrait: new Deployer() };
        const observer = observeSpecialtyCombat(game, players);
        game.events.dispatch({ type: EventType.ObjectSpawn, gameObject: deso });
        game.currentTick = 5;
        expect(deso.deployerTrait.setDeployed(true)).toBe(returned);
        deso.deployerTrait.setDeployed(true);
        // The legacy event label is inverted; only the real state is authoritative.
        game.events.dispatch({ type: EventType.UnitDeployUndeploy, unit: deso, deployType: 'undeploy' });
        game.currentTick = 7; deso.deployerTrait.setDeployed(false);
        expect(calls).toBe(3);
        expect(observer.snapshot().deployments.map(event => [event.tick, event.deployed])).toEqual([[5, true], [7, false]]);
        observer.dispose();
        expect(Object.hasOwn(deso.deployerTrait, 'setDeployed')).toBe(false);
    });

    test('counts actual lost HP and weapon/kill source types rather than requested overkill damage', () => {
        const { game, players, object } = fixture();
        const observer = observeSpecialtyCombat(game, players);
        const cannon = object('GTGCAN', 0), target = object('HTNK', 1);
        const attacker = { obj: cannon, player: players[0] };
        game.currentTick = 50;
        game.events.dispatch({ type: EventType.WeaponFire, gameObject: cannon, weapon: { name: 'GrandCannonWeapon' } });
        game.events.dispatch({ type: EventType.InflictDamage, target, attacker, damageHitPoints: 9000, prevHealth: 100, currentHealth: 0 });
        game.events.dispatch({ type: EventType.ObjectDestroy, target, attackerInfo: attacker });
        const snapshot = observer.snapshot();
        expect(snapshot.shots[0].GTGCAN.GrandCannonWeapon).toEqual({ count: 1, firstTick: 50, lastTick: 50 });
        expect(snapshot.damageBySourceType[0].GTGCAN.enemyHitPoints).toBe(100);
        expect(snapshot.damageBySourceType[0].GTGCAN.enemyKills).toBe(1);
        expect(snapshot.damageBySourceType[0].GTGCAN.killedTypes.HTNK).toBe(1);
        snapshot.damageBySourceType[0].GTGCAN.enemyHitPoints = 0;
        expect(observer.snapshot().damageBySourceType[0].GTGCAN.enemyHitPoints).toBe(100);
        observer.dispose();
    });

    test('records ownerless radiation by victim, forwards originals once, and resets context on exceptions', () => {
        const { game, players, object } = fixture();
        const victim = object('E1', 1);
        const tile = { rx: 10, ry: 20 };
        let sites = 0, applications = 0, level = 0;
        const returned = {};
        const radiation = game.mapRadiationTrait = {
            getRadSiteLevel(position: any) { expect(position).toBe(tile); return level; },
            createRadSite(position: any, value: number) { expect(this).toBe(radiation); expect(position).toBe(tile); sites++; level = value; return returned; },
            applyDamage(shouldThrow: boolean) {
                expect(this).toBe(radiation); applications++;
                if (shouldThrow) throw new Error('original radiation error');
                game.events.dispatch({ type: EventType.InflictDamage, target: victim, damageHitPoints: 40, prevHealth: 100, currentHealth: 60 });
                return returned;
            },
        };
        const original = radiation.applyDamage;
        const observer = observeSpecialtyCombat(game, players);
        expect(radiation.createRadSite(tile, 500, 11)).toBe(returned);
        expect(radiation.applyDamage(false)).toBe(returned);
        expect(() => radiation.applyDamage(true)).toThrow('original radiation error');
        game.events.dispatch({ type: EventType.InflictDamage, target: victim, damageHitPoints: 10, prevHealth: 60, currentHealth: 50 });
        const snapshot = observer.snapshot();
        expect([sites, applications]).toEqual([1, 2]);
        expect(snapshot.radiation.damageHitPointsByVictim).toEqual([0, 40]);
        expect(snapshot.radiation.siteCalls[0]).toEqual({ tick: 0, x: 10, y: 20, level: 500, radius: 11, before: 0, after: 500 });
        expect(snapshot.damageBySourceType).toEqual([{}, {}]);
        observer.dispose(); expect(radiation.applyDamage).toBe(original);
    });

    test('composition distinguishes type counts, current health and deployment without issuing orders', () => {
        const { players, object } = fixture();
        players[0].objects.push(object('HTNK', 0, 1), { ...object('HTNK', 0, 2), healthTrait: { maxHitPoints: 100, getHitPoints: () => 25 } });
        expect(readForceComposition(players[0]).HTNK).toEqual({ count: 2, value: 1200, hitPoints: 125, maxHitPoints: 200, deployed: 0 });
    });

    test('records actual superweapon activation and airborne infantry separately from factory production', () => {
        const { game, players, object } = fixture();
        const observer = observeSpecialtyCombat(game, players);
        game.currentTick = 90;
        game.events.dispatch(new SuperWeaponActivateEvent(SuperWeaponType.AmerParaDrop, players[0], { rx: 4, ry: 5 }, undefined, false));
        game.currentTick = 130;
        game.events.dispatch({ type: EventType.ObjectSpawn, gameObject: { ...object('E1', 0, 7), isInfantry: () => true,
            stance: StanceType.Paradrop, tile: { rx: 4, ry: 5 } } });
        const snapshot = observer.snapshot();
        expect(snapshot.superWeaponActivations).toEqual([{ tick: 90, player: 0, type: 6, name: 'AmerParaDrop', x: 4, y: 5 }]);
        expect(snapshot.paradropSpawns).toEqual([{ tick: 130, player: 0, id: 7, name: 'E1', x: 4, y: 5 }]);
        expect(snapshot.production[0].E1).toBeUndefined();
        observer.dispose();
    });
});

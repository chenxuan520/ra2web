import { EventType } from '../src/game/event/EventType';
import { QueueStatus } from '../src/game/player/production/ProductionQueue';
import { BuildStatus } from '../src/game/gameobject/Building';
import { StanceType } from '../src/game/gameobject/infantry/StanceType';
import { SuperWeaponType } from '../src/game/type/SuperWeaponType';
import { DeathType } from '../src/game/gameobject/common/DeathType';

type TypeProduction = { queueReadyTicks: number[]; factoryProducedTicks: number[]; placedTicks: number[]; readyTicks: number[] };
type ShotCount = { count: number; firstTick: number; lastTick: number };
type SourceDamage = {
    enemyHitPoints: number; friendlyHitPoints: number; otherHitPoints: number;
    enemyKills: number; friendlyKills: number; otherKills: number;
    damagedTypes: Record<string, number>; killedTypes: Record<string, number>;
};

/** Current force composition, without running AI queries or consuming random values. */
export function readForceComposition(player: any) {
    const composition: Record<string, { count: number; value: number; hitPoints: number; maxHitPoints: number; deployed: number }> = {};
    for (const object of player.getOwnedObjects()) {
        const entry = composition[object.name] ??= { count: 0, value: 0, hitPoints: 0, maxHitPoints: 0, deployed: 0 };
        entry.count++;
        entry.value += object.rules.cost ?? 0;
        entry.hitPoints += object.healthTrait?.getHitPoints() ?? 0;
        entry.maxHitPoints += object.healthTrait?.maxHitPoints ?? 0;
        if (object.deployerTrait?.isDeployed()) entry.deployed++;
    }
    return composition;
}

/** Observe existing engine operations. No commands, queries that consume RNG, or damage are introduced. */
export function observeSpecialtyCombat(game: any, players: any[]) {
    const data = {
        format: 1,
        playerOrder: players.map(player => player.name),
        production: players.map(() => ({} as Record<string, TypeProduction>)),
        shots: players.map(() => ({} as Record<string, Record<string, ShotCount>>)),
        damageBySourceType: players.map(() => ({} as Record<string, SourceDamage>)),
        deployments: [] as { tick: number; player: number; id: number; name: string; deployed: boolean }[],
        specialtyShots: [] as { tick: number; player: number; id: number; name: string; weapon: string }[],
        superWeaponActivations: [] as { tick: number; player: number; type: number; name: string; x: number; y: number }[],
        paradropSpawns: [] as { tick: number; player: number; id: number; name: string; x: number; y: number }[],
        ownershipChanges: [] as { tick: number; id: number; name: string; previousOwner: string; newOwner: string; previousSide: number; newSide: number }[],
        crushKills: [] as { tick: number; player: number; sourceId: number; sourceName: string; targetId: number; targetName: string; victimSide: number }[],
        radiation: {
            // Rad sites are ownerless in the engine. Never attribute their damage to a guessed DESO/player.
            attribution: 'ownerless engine radiation; recorded by victim only',
            siteCalls: [] as { tick: number; x: number; y: number; level: number; radius: number; before: number; after: number }[],
            damageHitPointsByVictim: players.map(() => 0),
            killedByVictim: players.map(() => 0),
            damageByVictimType: players.map(() => ({} as Record<string, number>)),
            damageEvents: 0,
        },
    };
    const cleanup: (() => void)[] = [];
    const watchedDeployers = new WeakSet<object>();
    let radiationDepth = 0;
    let disposed = false;
    const sideOf = (player: any) => players.indexOf(player);
    const getProduction = (side: number, name: string) => data.production[side][name] ??= {
        queueReadyTicks: [], factoryProducedTicks: [], placedTicks: [], readyTicks: [],
    };
    const getDamage = (side: number, name: string) => data.damageBySourceType[side][name] ??= {
        enemyHitPoints: 0, friendlyHitPoints: 0, otherHitPoints: 0,
        enemyKills: 0, friendlyKills: 0, otherKills: 0, damagedTypes: {}, killedTypes: {},
    };
    const relation = (owner: any, victim: any): 'enemy' | 'friendly' | 'other' => {
        if (owner === victim || game.alliances?.areAllied(owner, victim)) return 'friendly';
        return sideOf(victim) >= 0 ? 'enemy' : 'other';
    };
    const observeDeployer = (object: any) => {
        const trait = object?.deployerTrait;
        if (object?.name !== 'DESO' || !trait || watchedDeployers.has(trait)) return;
        watchedDeployers.add(trait);
        const own = Object.getOwnPropertyDescriptor(trait, 'setDeployed');
        const original = trait.setDeployed;
        trait.setDeployed = function (...args: any[]) {
            const before = this.isDeployed();
            const result = original.apply(this, args);
            const after = this.isDeployed();
            const side = sideOf(object.owner);
            if (before !== after && side >= 0) data.deployments.push({
                tick: game.currentTick, player: side, id: object.id, name: object.name, deployed: after,
            });
            return result;
        };
        cleanup.push(() => own ? Object.defineProperty(trait, 'setDeployed', own) : delete trait.setDeployed);
    };

    for (const [side, player] of players.entries()) {
        for (const object of player.getOwnedObjects()) observeDeployer(object);
        for (const queue of player.production?.getAllQueues?.() ?? []) {
            let wasReady = queue.status === QueueStatus.Ready;
            const listener = () => {
                const ready = queue.status === QueueStatus.Ready;
                const item = queue.getFirst();
                if (ready && !wasReady && item) getProduction(side, item.rules.name).queueReadyTicks.push(game.currentTick);
                wasReady = ready;
            };
            queue.onUpdate.subscribe(listener);
            cleanup.push(() => queue.onUpdate.unsubscribe(listener));
        }
    }

    const radiation = game.mapRadiationTrait;
    if (radiation) {
        const originalDamage = radiation.applyDamage;
        const originalSite = radiation.createRadSite;
        const damageDescriptor = Object.getOwnPropertyDescriptor(radiation, 'applyDamage');
        const siteDescriptor = Object.getOwnPropertyDescriptor(radiation, 'createRadSite');
        radiation.applyDamage = function (...args: any[]) {
            radiationDepth++;
            try { return originalDamage.apply(this, args); }
            finally { radiationDepth--; }
        };
        radiation.createRadSite = function (...args: any[]) {
            const [tile, level, radius] = args;
            const before = this.getRadSiteLevel(tile) ?? 0;
            const result = originalSite.apply(this, args);
            data.radiation.siteCalls.push({ tick: game.currentTick, x: tile.rx, y: tile.ry, level, radius,
                before, after: this.getRadSiteLevel(tile) ?? 0 });
            return result;
        };
        cleanup.push(() => {
            if (damageDescriptor) Object.defineProperty(radiation, 'applyDamage', damageDescriptor);
            else delete radiation.applyDamage;
            if (siteDescriptor) Object.defineProperty(radiation, 'createRadSite', siteDescriptor);
            else delete radiation.createRadSite;
        });
    }

    const listener = (event: any) => {
        const tick = game.currentTick;
        if (event.type === EventType.ObjectOwnerChange) {
            data.ownershipChanges.push({ tick, id: event.target.id, name: event.target.name,
                previousOwner: event.prevOwner.name, newOwner: event.target.owner.name,
                previousSide: sideOf(event.prevOwner), newSide: sideOf(event.target.owner) });
        } else if (event.type === EventType.ObjectSpawn) {
            const object = event.gameObject;
            observeDeployer(object);
            const side = sideOf(object.owner);
            if (side >= 0 && object.isInfantry?.() && object.stance === StanceType.Paradrop) data.paradropSpawns.push({
                tick, player: side, id: object.id, name: object.name, x: object.tile.rx, y: object.tile.ry,
            });
        } else if (event.type === EventType.SuperWeaponActivate) {
            const side = sideOf(event.owner);
            // SuperWeaponsTrait dispatches the numeric SuperWeaponType as target.
            if (side >= 0) data.superWeaponActivations.push({ tick, player: side, type: event.target,
                name: SuperWeaponType[event.target], x: event.atTile.rx, y: event.atTile.ry });
        }
        else if (event.type === EventType.FactoryProduceUnit || event.type === EventType.BuildingPlace || event.type === EventType.BuildStatusChange) {
            const target = event.target;
            const side = sideOf(target.owner);
            if (side < 0) return;
            const production = getProduction(side, target.name);
            if (event.type === EventType.FactoryProduceUnit) production.factoryProducedTicks.push(tick);
            else if (event.type === EventType.BuildingPlace) production.placedTicks.push(tick);
            else if (event.status === BuildStatus.Ready) production.readyTicks.push(tick);
        } else if (event.type === EventType.WeaponFire) {
            const object = event.gameObject;
            const side = sideOf(object.owner);
            if (side < 0) return;
            const weapon = event.weapon.name ?? event.weapon.rules.name;
            const shots = data.shots[side][object.name] ??= {};
            const count = shots[weapon] ??= { count: 0, firstTick: tick, lastTick: tick };
            count.count++; count.lastTick = tick;
            if (object.name === 'DESO' || object.name === 'GTGCAN') data.specialtyShots.push({
                tick, player: side, id: object.id, name: object.name, weapon,
            });
        } else if (event.type === EventType.InflictDamage) {
            // Derive actual lost HP, including armor and excluding overkill, from the engine health event.
            const maxHitPoints = event.target.healthTrait?.maxHitPoints ?? event.target.rules.strength;
            const lost = Math.max(0, Math.round((event.prevHealth - event.currentHealth) * maxHitPoints / 100));
            const victim = sideOf(event.target.owner);
            if (radiationDepth > 0 && !event.attacker) {
                data.radiation.damageEvents++;
                if (victim >= 0) {
                    data.radiation.damageHitPointsByVictim[victim] += lost;
                    const counts = data.radiation.damageByVictimType[victim];
                    counts[event.target.name] = (counts[event.target.name] ?? 0) + lost;
                }
            } else {
                const source = event.attacker?.obj ?? event.attacker;
                const owner = event.attacker?.player ?? source?.owner;
                const side = sideOf(owner);
                if (side < 0 || !source?.name) return;
                const entry = getDamage(side, source.name);
                entry[`${relation(owner, event.target.owner)}HitPoints`] += lost;
                entry.damagedTypes[event.target.name] = (entry.damagedTypes[event.target.name] ?? 0) + lost;
            }
        } else if (event.type === EventType.ObjectDestroy) {
            const victim = sideOf(event.target.owner);
            if (radiationDepth > 0 && !event.attackerInfo) {
                if (victim >= 0) data.radiation.killedByVictim[victim]++;
            } else {
                const source = event.attackerInfo?.obj;
                const owner = event.attackerInfo?.player ?? source?.owner;
                const side = sideOf(owner);
                if (side < 0 || !source?.name) return;
                if (event.target.deathType === DeathType.Crush) data.crushKills.push({ tick, player: side,
                    sourceId: source.id, sourceName: source.name, targetId: event.target.id, targetName: event.target.name, victimSide: victim });
                const entry = getDamage(side, source.name);
                entry[`${relation(owner, event.target.owner)}Kills`]++;
                entry.killedTypes[event.target.name] = (entry.killedTypes[event.target.name] ?? 0) + 1;
            }
        }
    };
    game.events.subscribe(listener);
    cleanup.push(() => game.events.unsubscribe(listener));
    return {
        snapshot: () => structuredClone(data),
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const restore of cleanup.reverse()) restore();
        },
    };
}

import { estimatedCombatWeapons } from "../../common/observedUnit";
import { ObjectType, OrderType, UnitData, Vector2 } from "../../../../game-api";
import { SupabotContext } from "../../common/context";
import { getInfantryCrushPoint } from "./squads/infantryCrushing";
import { isEcoOnly } from "../../common/pressure";
import { findVisiblePatches, isServed, patchDistance, PatchPoint } from "../../common/orePatches";
import { patchCapacity } from "../../building/harvester";

/** Briefly use one nearby armored miner to break an infantry rush, then resume income. */
export class MinerDefence {
    private active?: { id: number; until: number; lastOrder: number; destination?: Vector2 };
    private nextDefenceAt = 0;
    private lastGemOrder = new Map<number, number>();
    private lastBalanceOrder = new Map<number, number>();
    private dispatchTargets = new Map<number, { tile: PatchPoint; tick: number }>();

    onAiUpdate(context: SupabotContext) {
        if (context.difficulty !== "brutal") return;
        const { game, player } = context;
        const tick = game.getCurrentTick();
        if (tick % 6) return;
        const home = game.getPlayerData(player.name).startLocation;
        const enemies = game.getVisibleUnits(player.name, "enemy").map(id => game.getUnitData(id))
            .filter((unit): unit is UnitData => !!unit);
        const approaching = enemies.filter(unit => (unit.type as any) === ObjectType.Infantry && unit.rules.crushable &&
            home.distanceTo(new Vector2(unit.tile.rx, unit.tile.ry)) <= 32);
        const armorThreat = enemies.some(unit => (unit.type as any) !== ObjectType.Infantry && !unit.rules.harvester &&
            !!estimatedCombatWeapons(unit, game)[0] && home.distanceTo(new Vector2(unit.tile.rx, unit.tile.ry)) <= 24);
        const miners = game.getVisibleUnits(player.name, "self", rules => rules.harvester && rules.crusher)
            .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit && unit.canMove && !unit.isWarpedOut && !context.parasiteRepair?.isRepairing(unit.id));
        let miner = this.active ? miners.find(unit => unit.id === this.active!.id) : undefined;
        if (this.active && !miner) {
            this.active = undefined;
            this.nextDefenceAt = tick + 300;
        }
        if (!isEcoOnly(context) && !this.active && tick >= this.nextDefenceAt && approaching.length >= 6 && !armorThreat) {
            miner = miners.filter(unit => unit.hitPoints >= unit.maxHitPoints * 0.8 &&
                home.distanceTo(new Vector2(unit.tile.rx, unit.tile.ry)) <= 28).sort((a, b) => a.id - b.id)[0];
            if (miner) this.active = { id: miner.id, until: tick + 300, lastOrder: -Infinity };
        }
        if (this.active && miner) {
            let destination: Vector2 | null = null;
            if (tick < this.active.until && !armorThreat && approaching.length >= 2 && miner.hitPoints >= miner.maxHitPoints * 0.55 &&
                home.distanceTo(new Vector2(miner.tile.rx, miner.tile.ry)) <= 28) {
                destination = getInfantryCrushPoint(miner, enemies, game.mapApi, game);
                if (!destination) {
                    const center = new Vector2(approaching.reduce((sum, unit) => sum + unit.tile.rx, 0) / approaching.length,
                        approaching.reduce((sum, unit) => sum + unit.tile.ry, 0) / approaching.length);
                    const forward = center.sub(home);
                    if (forward.length() > 10) forward.multiplyScalar(10 / forward.length());
                    destination = home.clone().add(forward);
                    destination.set(Math.round(destination.x), Math.round(destination.y));
                }
            }
            if (!destination) {
                this.dispatchTargets.delete(miner.id);
                // Only known ore is a legal Gather target. Docking is a fallback when
                // no resource tile remains visible; the engine handles unloading.
                const ore = game.mapApi.getAllTilesResourceData().filter(resource => game.mapApi.isVisibleTile(resource.tile, player.name) &&
                    resource.ore + resource.gems > 0).sort((a, b) =>
                    (a.tile.rx - miner!.tile.rx) ** 2 + (a.tile.ry - miner!.tile.ry) ** 2 -
                    ((b.tile.rx - miner!.tile.rx) ** 2 + (b.tile.ry - miner!.tile.ry) ** 2))[0];
                if (ore) player.actions.orderUnits([miner.id], OrderType.Gather, ore.tile.rx, ore.tile.ry);
                else {
                    const refinery = game.getVisibleUnits(player.name, "self", rules => rules.refinery)[0];
                    if (refinery !== undefined) player.actions.orderUnits([miner.id], OrderType.Dock, refinery);
                }
                this.active = undefined;
                this.nextDefenceAt = tick + 300;
            } else if (tick - this.active.lastOrder >= 18 &&
                (miner.isIdle || !this.active.destination?.equals(destination))) {
                this.dispatchTargets.delete(miner.id);
                player.actions.orderUnits([miner.id], OrderType.Move, destination.x, destination.y);
                this.active.lastOrder = tick;
                this.active.destination = destination;
            }
        }

        // Harvester safety: if an endangered harvester (< 50% HP) is under direct hostile threat, dock at nearest safe refinery
        if (tick % 30 === 0) {
            const allMiners = game.getVisibleUnits(player.name, "self", rules => rules.harvester)
                .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit && unit.canMove && !unit.isWarpedOut && !context.parasiteRepair?.isRepairing(unit.id));
            for (const m of allMiners) {
                if (m.hitPoints < m.maxHitPoints * 0.5) {
                    const nearbyHostiles = enemies.filter(e => e.rules.isSelectableCombatant && !e.rules.harvester &&
                        new Vector2(e.tile.rx, e.tile.ry).distanceTo(new Vector2(m.tile.rx, m.tile.ry)) <= 10);
                    if (nearbyHostiles.length > 0) {
                        const refinery = game.getVisibleUnits(player.name, "self", rules => rules.refinery)
                            .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit && !enemies.some(enemy =>
                                enemy.rules.isSelectableCombatant && !enemy.rules.harvester &&
                                (enemy.tile.rx - unit.tile.rx) ** 2 + (enemy.tile.ry - unit.tile.ry) ** 2 <= 10 ** 2))
                            .sort((a, b) => (a.tile.rx - m.tile.rx) ** 2 + (a.tile.ry - m.tile.ry) ** 2 -
                                ((b.tile.rx - m.tile.rx) ** 2 + (b.tile.ry - m.tile.ry) ** 2) || a.id - b.id)[0];
                        if (refinery) {
                            this.dispatchTargets.delete(m.id);
                            player.actions.orderUnits([m.id], OrderType.Dock, refinery.id);
                        }
                    }
                }
            }

            // Gem Resource Prioritization: When visible safe gem fields exist (yielding 2x income),
            // guide healthy miners to gather gems first!
            const enemyCombatants = enemies.filter(e => e.rules.isSelectableCombatant);
            const refineries = game.getVisibleUnits(player.name, "self", rules => rules.refinery)
                .map(id => game.getUnitData(id)).filter((u): u is UnitData => !!u);
            const patches = findVisiblePatches(game, player.name);
            const tileKey = (tile: PatchPoint) => `${tile.rx}_${tile.ry}`;
            const patchByTile = new Map(patches.flatMap(patch => patch.tiles.map(tile => [tileKey(tile), patch] as const)));
            const inventory = game.getVisibleUnits(player.name, "self", rules => rules.harvester)
                .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit);
            const chrono = inventory.some(miner => miner.name === "CMIN");
            const counts = new Map(patches.map(patch => [patch.id, 0]));
            const assignments = new Map(inventory.map(miner => {
                const patch = patches.filter(patch => patchDistance(miner.tile, patch) <= 6)
                    .sort((a, b) => patchDistance(miner.tile, a) - patchDistance(miner.tile, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
                if (patch) counts.set(patch.id, counts.get(patch.id)! + 1);
                return [miner.id, patch] as const;
            }));
            for (const [id, dispatch] of this.dispatchTargets) {
                const miner = inventory.find(miner => miner.id === id), target = patchByTile.get(tileKey(dispatch.tile));
                const current = assignments.get(id);
                if (!miner || !target || current?.id === target.id || miner.isIdle && tick - dispatch.tick >= 300) {
                    this.dispatchTargets.delete(id);
                    continue;
                }
                if (current) counts.set(current.id, counts.get(current.id)! - 1);
                counts.set(target.id, counts.get(target.id)! + 1);
                assignments.set(id, target);
            }
            const canDispatch = (miner: UnitData) => {
                if (!game.mapApi.isVisibleTile(miner.tile, player.name)) return false;
                const resource = game.mapApi.getTileResourceData(miner.tile);
                // Proximity alone also matches full miners about to dock; do not cancel their real unloading.
                return !(resource && (resource.ore > 0 || resource.gems > 0)) &&
                    (miner.isIdle || miner.harvestedOre === 0 && miner.harvestedGems === 0 &&
                        refineries.some(ref => Math.hypot(ref.tile.rx - miner.tile.rx, ref.tile.ry - miner.tile.ry) <= 4));
            };
            const reserveDispatch = (miner: UnitData, tile: PatchPoint) => {
                const target = patchByTile.get(tileKey(tile))!, current = assignments.get(miner.id);
                if (current?.id !== target.id) {
                    if (current) counts.set(current.id, counts.get(current.id)! - 1);
                    counts.set(target.id, counts.get(target.id)! + 1);
                }
                assignments.set(miner.id, target);
                this.dispatchTargets.set(miner.id, { tile: { rx: tile.rx, ry: tile.ry }, tick });
            };
            const gemResources = game.mapApi.getAllTilesResourceData().filter(res => {
                if (!game.mapApi.isVisibleTile(res.tile, player.name) || res.gems <= 0) return false;
                const patch = patchByTile.get(tileKey(res.tile));
                return patch && (isServed(patch, refineries.map(ref => ref.tile)) || patchDistance({ rx: home.x, ry: home.y }, patch) <= 40) &&
                    !enemyCombatants.some(e => (e.tile.rx - res.tile.rx) ** 2 + (e.tile.ry - res.tile.ry) ** 2 <= 14 ** 2);
            });

            if (gemResources.length > 0) {
                for (const m of allMiners) {
                    if (this.active?.id === m.id || m.hitPoints < m.maxHitPoints * 0.7) continue;
                    const last = this.lastGemOrder.get(m.id) ?? -Infinity;
                    if (tick - last < 300 || this.dispatchTargets.has(m.id)) continue;
                    const mPos = new Vector2(m.tile.rx, m.tile.ry);
                    if (!canDispatch(m)) continue;

                    const targetGem = [...gemResources].sort((a, b) =>
                        mPos.distanceToSquared(new Vector2(a.tile.rx, a.tile.ry)) - mPos.distanceToSquared(new Vector2(b.tile.rx, b.tile.ry)) ||
                        a.tile.rx - b.tile.rx || a.tile.ry - b.tile.ry
                    ).find(resource => {
                        const patch = patchByTile.get(tileKey(resource.tile))!;
                        return counts.get(patch.id)! < patchCapacity(patch, chrono) && game.mapApi.findPath(m.rules.speedType,
                            { tile: m.tile, onBridge: !!m.onBridge }, { tile: resource.tile, onBridge: false },
                            { bestEffort: false, maxExpandedNodes: 256 }).some(node =>
                                node.tile.rx === resource.tile.rx && node.tile.ry === resource.tile.ry);
                    });

                    if (targetGem) {
                        player.actions.orderUnits([m.id], OrderType.Gather, targetGem.tile.rx, targetGem.tile.ry);
                        this.lastGemOrder.set(m.id, tick);
                        reserveDispatch(m, targetGem.tile);
                    }
                }
            }

            if (tick % 150 === 0) {
                const served = patches.filter(patch => isServed(patch, refineries.map(ref => ref.tile)));
                const destination = served.filter(patch => counts.get(patch.id)! < patchCapacity(patch, chrono))
                    .sort((a, b) => (patchCapacity(b, chrono) - counts.get(b.id)!) - (patchCapacity(a, chrono) - counts.get(a.id)!) ||
                        Number(b.isGem) - Number(a.isGem) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
                if (destination) {
                    const sources = served.filter(patch => counts.get(patch.id)! > patchCapacity(patch, chrono))
                        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
                    for (const source of sources) {
                        for (const m of [...allMiners].sort((a, b) => a.id - b.id)) {
                            if (assignments.get(m.id)?.id !== source.id || this.dispatchTargets.has(m.id) || this.active?.id === m.id ||
                                m.hitPoints < m.maxHitPoints * 0.7 || tick - (this.lastBalanceOrder.get(m.id) ?? -Infinity) < 600 || !canDispatch(m)) continue;
                            const point = [...destination.tiles].sort((a, b) =>
                                (a.rx - m.tile.rx) ** 2 + (a.ry - m.tile.ry) ** 2 - ((b.rx - m.tile.rx) ** 2 + (b.ry - m.tile.ry) ** 2) || a.rx - b.rx || a.ry - b.ry)[0];
                            const tile = game.mapApi.getTile(point.rx, point.ry);
                            if (!tile || !game.mapApi.isVisibleTile(tile, player.name) || enemyCombatants.some(enemy =>
                                Math.hypot(enemy.tile.rx - tile.rx, enemy.tile.ry - tile.ry) <= 14) ||
                                !game.mapApi.findPath(m.rules.speedType, { tile: m.tile, onBridge: !!m.onBridge }, { tile, onBridge: false },
                                    { bestEffort: false, maxExpandedNodes: 256 }).some(node => node.tile.rx === tile.rx && node.tile.ry === tile.ry)) continue;
                            player.actions.orderUnits([m.id], OrderType.Gather, tile.rx, tile.ry);
                            this.lastBalanceOrder.set(m.id, tick);
                            reserveDispatch(m, tile);
                            return;
                        }
                    }
                }
            }
        }
    }
}

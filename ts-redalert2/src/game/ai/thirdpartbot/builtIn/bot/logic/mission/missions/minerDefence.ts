import { OrderType, UnitData, Vector2 } from "../../../../game-api";
import { SupabotContext } from "../../common/context";
import { getInfantryCrushPoint } from "./squads/infantryCrushing";

/** Briefly use one nearby armored miner to break an infantry rush, then resume income. */
export class MinerDefence {
    private active?: { id: number; until: number; lastOrder: number; destination?: Vector2 };
    private nextDefenceAt = 0;

    onAiUpdate(context: SupabotContext) {
        if (context.difficulty !== "brutal") return;
        const { game, player } = context;
        const tick = game.getCurrentTick();
        if (tick % 6) return;
        const home = game.getPlayerData(player.name).startLocation;
        const enemies = game.getVisibleUnits(player.name, "enemy").map(id => game.getUnitData(id))
            .filter((unit): unit is UnitData => !!unit);
        const miners = game.getVisibleUnits(player.name, "self", rules => rules.harvester && rules.crusher)
            .map(id => game.getUnitData(id)).filter((unit): unit is UnitData => !!unit && unit.canMove && !unit.isWarpedOut);
        let miner = this.active ? miners.find(unit => unit.id === this.active!.id) : undefined;
        if (this.active && !miner) {
            this.active = undefined;
            this.nextDefenceAt = tick + 300;
        }
        if (!this.active && tick >= this.nextDefenceAt) {
            miner = miners.filter(unit => unit.hitPoints >= unit.maxHitPoints * 0.8 &&
                home.distanceTo(new Vector2(unit.tile.rx, unit.tile.ry)) <= 20 &&
                !!getInfantryCrushPoint(unit, enemies, game.mapApi)).sort((a, b) => a.id - b.id)[0];
            if (miner) this.active = { id: miner.id, until: tick + 180, lastOrder: -Infinity };
        }
        if (!this.active || !miner) return;
        const destination = tick < this.active.until && home.distanceTo(new Vector2(miner.tile.rx, miner.tile.ry)) <= 24
            ? getInfantryCrushPoint(miner, enemies, game.mapApi) : null;
        if (!destination) {
            // Only known ore is a legal Gather target. Docking is a fallback when
            // no resource tile remains visible; the engine handles unloading.
            const ore = game.mapApi.getAllTilesResourceData().filter(resource => resource.ore + resource.gems > 0 &&
                game.mapApi.isVisibleTile(resource.tile, player.name)).sort((a, b) =>
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
            player.actions.orderUnits([miner.id], OrderType.Move, destination.x, destination.y);
            this.active.lastOrder = tick;
            this.active.destination = destination;
        }
    }
}

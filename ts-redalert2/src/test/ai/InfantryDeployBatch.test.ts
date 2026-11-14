import { describe, expect, test } from "bun:test";
import { createSpecialtyGame, loadSpecialtyResources, spawnSpecialtyObject } from "../../../e2e/ai-specialty-scenarios";
import { ObjectType } from "../../engine/type/ObjectType";
import { SpeedType } from "../../game/type/SpeedType";
import { OrderType, StanceType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { ActionBatcher, BatchableAction } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";
import { manageAttackMicro, manageMoveMicro } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/common";

const cdn = process.env.RA2_BENCHMARK_CDN ?? process.env.RA2_PREPARED_CDN;
const deployed: any = { id: 1, name: "E1", tile: { rx: 0, ry: 0 }, stance: StanceType.Deployed, secondaryWeapon: { maxRange: 5 } };
const near: any = { id: 20, tile: { rx: 3, ry: 0 }, rules: {} };
const far: any = { id: 21, tile: { rx: 12, ry: 0 }, rules: {} };

test.each([undefined, "normal"] as const)("%s retains the original GI withdrawal commands", difficulty => {
    const original = BatchableAction.noTarget(deployed.id, OrderType.DeploySelected, 1);
    expect(manageMoveMicro(deployed, new Vector2(12, 0), difficulty).isSameAs(original)).toBe(true);
    expect(manageAttackMicro(deployed, far, difficulty).isSameAs(original)).toBe(true);
});

test("Brutal GI withdrawal targets itself for both movement and distant attacks", () => {
    const withdrawal = BatchableAction.toTargetId(deployed.id, OrderType.Deploy, deployed.id, 1);
    expect(manageMoveMicro(deployed, new Vector2(12, 0), "brutal").isSameAs(withdrawal)).toBe(true);
    expect(manageAttackMicro(deployed, far, "brutal").isSameAs(withdrawal)).toBe(true);
});

test("Brutal preserves GI deployment range and its existing withdrawal margin", () => {
    const standing = { ...deployed, stance: StanceType.Guard };
    expect(manageAttackMicro(standing, near, "brutal").isSameAs(BatchableAction.noTarget(1, OrderType.DeploySelected, 0))).toBe(true);
    expect(manageAttackMicro(deployed, { ...far, tile: { rx: 6.5, ry: 0 } }, "brutal").orderType).toBe(OrderType.Attack);
    expect(manageAttackMicro(deployed, { ...far, tile: { rx: 6.6, ry: 0 } }, "brutal").orderType).toBe(OrderType.Deploy);
});

test.each([undefined, "normal", "brutal"] as const)("%s preserves standing GI and non-GI commands", difficulty => {
    const destination = new Vector2(12, 0);
    const standing = { ...deployed, stance: StanceType.Guard }, conscript = { ...deployed, name: "E2" };
    expect(manageMoveMicro(standing, destination, difficulty).isSameAs(BatchableAction.toPoint(1, OrderType.AttackMove, destination))).toBe(true);
    expect(manageMoveMicro(conscript, destination, difficulty).isSameAs(BatchableAction.toPoint(1, OrderType.AttackMove, destination))).toBe(true);
    expect(manageAttackMicro(conscript, far, difficulty).isSameAs(BatchableAction.toTargetId(1, OrderType.Attack, far.id))).toBe(true);
});

describe.skipIf(!cdn)("native opposite GI deployment intents", () => {
    test.each(["move", "attack"] as const)("both units acknowledge deployment and %s withdrawal", async intent => {
        const resources = await loadSpecialtyResources(cdn), { game, players, bots } = createSpecialtyGame(resources, 930031, ["Americans", "Russians"]);
        try {
            const tiles: any[] = []; game.map.tiles.forEach((tile: any) => tiles.push(tile));
            const origin = tiles.sort((a, b) => a.rx - b.rx || a.ry - b.ry).find(tile => [0, 1, 3, 12].every(dx => {
                const at = game.map.tiles.getByMapCoords(tile.rx + dx, tile.ry);
                return at && at.z === tile.z && at.onBridgeLandType === undefined &&
                    game.map.terrain.getPassableSpeed(at, SpeedType.Foot, true, false) > 0 &&
                    !game.map.getObjectsOnTile(at).some((object: any) => object.isTechno() || object.isTerrain());
            }));
            expect(origin).toBeDefined();
            const a = spawnSpecialtyObject(game, { label: "deploy", name: "E1", type: ObjectType.Infantry, player: 0, x: 0, y: 0 }, origin, players);
            const b = spawnSpecialtyObject(game, { label: "withdraw", name: "E1", type: ObjectType.Infantry, player: 0, x: 1, y: 0 }, origin, players);
            b.deployerTrait.setDeployed(true); // Preplaced stance fixture; subsequent orders use the native action path.
            game.start(); const bot = bots.get(players[0].name)!;
            game.update();
            expect(b.deployerTrait.isDeployed()).toBe(true); expect(a.deployerTrait.isDeployed()).toBe(false);
            const enemy = spawnSpecialtyObject(game, { label: "visible-enemy", name: "E2", type: ObjectType.Infantry, player: 1, x: 3, y: 0 }, origin, players);
            const distant = spawnSpecialtyObject(game, { label: "distant-enemy", name: "E2", type: ObjectType.Infantry, player: 1, x: 12, y: 0 }, origin, players);
            game.update();
            const ownA = bot.gameApi.getUnitData(a.id)!, ownB = bot.gameApi.getUnitData(b.id)!, target = bot.gameApi.getUnitData(enemy.id)!;
            expect(target).toBeDefined(); expect(ownB.stance).toBe(StanceType.Deployed);
            const batcher = new ActionBatcher();
            batcher.push(manageAttackMicro(ownA, target, "brutal"));
            batcher.push(intent === "move" ? manageMoveMicro(ownB, new Vector2(origin.rx + 12, origin.ry), "brutal") :
                manageAttackMicro(ownB, bot.gameApi.getUnitData(distant.id)!, "brutal"));
            batcher.resolve(bot.actionsApi, bot.gameApi.mapApi);
            for (let i = 0; i < 30; i++) game.update();
            expect(a.deployerTrait.isDeployed()).toBe(true);
            expect(b.deployerTrait.isDeployed()).toBe(false);
        } finally { game.dispose(); }
    });
});

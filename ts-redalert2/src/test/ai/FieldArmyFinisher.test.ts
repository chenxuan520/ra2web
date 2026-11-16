import { describe, expect, test } from "bun:test";
import { MovementZone, ObjectType, OrderType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { ArmorType } from "../../game/type/ArmorType";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { FieldArmyMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/fieldArmyMission";
import type { BatchableAction } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";

function scenario(difficulty: "normal" | "brutal" = "brutal") {
    let tick = 24000, squadUpdates = 0;
    const own: any[] = Array.from({ length: 6 }, (_, index) => ({
        id: index + 1, name: "HTNK", owner: "bot", type: ObjectType.Vehicle, zone: ZoneType.Ground,
        tile: { rx: 0, ry: index % 2 }, hitPoints: 400, maxHitPoints: 400,
        rules: { name: "HTNK", type: ObjectType.Vehicle, movementZone: MovementZone.Normal, isSelectableCombatant: true },
    }));
    own.push({ id: 20, name: "NACNST", owner: "bot", type: ObjectType.Building, tile: { rx: 0, ry: 0 },
        rules: { name: "NACNST", type: ObjectType.Building, constructionYard: true } });
    own.push({ id: 21, name: "NAWEAP", owner: "bot", type: ObjectType.Building, tile: { rx: 0, ry: 2 },
        rules: { name: "NAWEAP", type: ObjectType.Building, weaponsFactory: true } });
    const building: any = { id: 30, name: "NACNST", owner: "enemy", type: ObjectType.Building,
        tile: { rx: 70, ry: 60 }, hitPoints: 1000, maxHitPoints: 1000,
        rules: { name: "NACNST", type: ObjectType.Building, constructionYard: true } };
    const enemies: any[] = [building], actions: BatchableAction[] = [];
    const game: any = {
        getCurrentTick: () => tick,
        getPlayerData: (name: string) => name === "bot"
            ? { name, startLocation: new Vector2(), credits: 62, country: { name: "Russians" } }
            : { name, isCombatant: true },
        getPlayers: () => ["bot", "enemy"], areAlliedPlayers: (a: string, b: string) => a === b,
        getVisibleUnits: (_name: string, relation: string, predicate = (_rules: any) => true) =>
            (relation === "self" ? own : enemies).filter(unit => predicate(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => [...own, ...enemies].find(unit => unit.id === id),
        getGameObjectData: (id: number) => [...own, ...enemies].find(unit => unit.id === id),
        mapApi: {
            getStartingLocations: () => [new Vector2(), new Vector2(70, 0)],
            getRealMapSize: () => ({ width: 80, height: 80 }),
            getTile: (rx: number, ry: number) => ({ rx, ry }),
            isVisibleTile: (tile: { rx: number; ry: number }) => tile.rx < 40 ||
                enemies.some(enemy => enemy.tile.rx === tile.rx && enemy.tile.ry === tile.ry),
        },
    };
    const army = new FieldArmyMission(null, new MissionController(() => {}), () => {});
    Object.assign(army, { squad: { setAirSafety() {}, setDefensiveRadius() {}, setAttackArea() {},
        onAiUpdate() { squadUpdates++; } } });
    for (let id = 1; id <= 6; id++) army.addUnit(id);
    const context: any = { game, difficulty, player: { name: "bot", production: { getAvailableObjects: () => [] } },
        actionBatcher: { push(action: BatchableAction) { actions.push(action); } },
        matchAwareness: { getMainRallyPoint: () => new Vector2(10, 0), getThreatCache: () => null } };
    return { army, game, context, enemies, building, actions,
        at(value: number) { tick = value; }, updates: () => squadUpdates,
        run() { actions.length = 0; squadUpdates = 0; army.onAiUpdate(context); },
        beginFinish() { army.onAiUpdate(context); enemies.length = 0; tick += 30; } };
}

function dogFinishScenario(name: "DOG" | "ADOG", infantryGap?: number, difficulty: "normal" | "brutal" = "brutal") {
    const f = scenario(difficulty), lookups: string[] = [];
    for (let id = 1; id <= 6; id++) f.game.getUnitData(id).rules.armor = ArmorType.Heavy;
    if (infantryGap !== undefined) {
        const infantry = f.game.getUnitData(1);
        Object.assign(infantry, { name: "E1", type: ObjectType.Infantry, tile: { rx: 70 - infantryGap, ry: 60 },
            hitPoints: 125, maxHitPoints: 125,
            rules: { name: "E1", type: ObjectType.Infantry, movementZone: MovementZone.Infantry, armor: ArmorType.None, isSelectableCombatant: true } });
    }
    f.game.rulesApi = {
        getWeapon(name: string) { lookups.push(name); return { damage: 30, rof: 30, range: 1.5, projectile: "ground", warhead: "infantry" }; },
        getProjectile: () => ({ isAntiGround: true, isAntiAir: false }),
        getWarhead: () => ({ verses: new Map([[ArmorType.None, 1], [ArmorType.Heavy, 0]]) }),
    };
    f.beginFinish();
    // Public enemy observation: exact private HP and weapon inventory are deliberately absent.
    f.enemies.push({ id: 31, name, owner: "enemy", type: ObjectType.Infantry, zone: ZoneType.Ground,
        tile: { rx: 70, ry: 60 }, rules: { name, type: ObjectType.Infantry, primary: "Teeth", isSelectableCombatant: true } });
    return { ...f, lookups };
}

describe("field army searches remaining shroud only after observing an enemy base", () => {
    test("six tanks sweep six different shrouded public points instead of following the distant last target", () => {
        const f = scenario(); f.beginFinish(); f.run();
        expect(f.army.isAttacking()).toBe(true); expect(f.actions).toHaveLength(6); expect(f.updates()).toBe(0);
        expect(new Set(f.actions.map(action => `${action.point!.x},${action.point!.y}`)).size).toBe(6);
        for (const action of f.actions) {
            expect(action.orderType).toBe(OrderType.AttackMove);
            expect(f.game.mapApi.isVisibleTile(f.game.mapApi.getTile(action.point!.x, action.point!.y), "bot")).toBe(false);
        }
    });
    test("never having observed a base preserves the original squad search", () => {
        const f = scenario(); f.enemies.length = 0; f.run();
        expect(f.actions).toHaveLength(0); expect(f.updates()).toBe(1);
    });
    test("a newly visible building ends sweeping at the next thirty-tick target check", () => {
        const f = scenario(); f.beginFinish(); f.run();
        f.enemies.push(f.building); f.at(24060); f.run();
        expect(f.actions).toHaveLength(0); expect(f.updates()).toBe(1);
        expect(f.army.getAttackArea()).toEqual(new Vector2(70, 60));
    });
    test("Normal keeps the original squad behavior after the same base disappears", () => {
        const f = scenario("normal"); f.beginFinish(); f.run();
        expect(f.actions).toHaveLength(0); expect(f.updates()).toBe(1);
        expect(f.army.getAttackArea()).toEqual(new Vector2(70, 60));
    });
    test("a visible enemy combatant prevents sweeping", () => {
        const f = scenario(); f.beginFinish();
        f.enemies.push({ id: 31, name: "HTNK", owner: "enemy", type: ObjectType.Vehicle, zone: ZoneType.Ground,
            tile: { rx: 70, ry: 60 }, hitPoints: 400,
            rules: { name: "HTNK", type: ObjectType.Vehicle, isSelectableCombatant: true } });
        f.run(); expect(f.actions).toHaveLength(0); expect(f.updates()).toBe(1);
    });
    test("a remaining visible miner no longer delays searching for hidden buildings", () => {
        const f = scenario(); f.beginFinish();
        f.enemies.push({ id: 31, name: "HARV", owner: "enemy", type: ObjectType.Vehicle, zone: ZoneType.Ground,
            tile: { rx: 70, ry: 60 }, hitPoints: 1000,
            rules: { name: "HARV", type: ObjectType.Vehicle, harvester: true, isSelectableCombatant: true } });
        f.run(); expect(f.actions).toHaveLength(6); expect(f.updates()).toBe(0);
    });
    test("sweep movement orders retain the supplied three-hundred-tick refresh interval", () => {
        const f = scenario(); f.beginFinish(); f.run();
        expect(f.actions).toHaveLength(6);
        const points = f.actions.map(action => action.point);
        f.at(24060); f.run(); expect(f.actions).toHaveLength(0);
        f.at(24330); f.run(); expect(f.actions.map(action => action.point)).toEqual(points);
    });
    test("an entirely explored grid falls back to the original squad logic", () => {
        const f = scenario(); f.beginFinish(); f.game.mapApi.isVisibleTile = () => true; f.run();
        expect(f.actions).toHaveLength(0); expect(f.updates()).toBe(1);
    });
    test.each([false, true])("protected repair orders are preserved when already sweeping=%s", alreadySweeping => {
        const f = scenario(); f.beginFinish();
        if (alreadySweeping) { f.run(); f.at(24330); }
        const checked: number[] = [];
        f.context.parasiteRepair = { isRepairing(id: number) { checked.push(id); return id === 1; } };
        f.run();
        expect(f.actions).toHaveLength(5);
        expect(f.actions.map(action => action.unitId)).not.toContain(1);
        expect(checked).toContain(1);
        expect((f.army as any).sweep.has(1)).toBe(false);
    });
    test.each(["DOG", "ADOG"] as const)("a remote %s does not recall the army away from its shroud destinations", name => {
        const f = dogFinishScenario(name, 64); f.run();
        expect(f.actions).toHaveLength(6); expect(f.updates()).toBe(0);
        expect(f.actions.every(action => action.orderType === OrderType.AttackMove)).toBe(true);
    });
    test.each(["DOG", "ADOG"] as const)("a nearby %s with no weapon against armor does not stop armored sweepers", name => {
        const f = dogFinishScenario(name); f.game.getUnitData(1).tile = { rx: 69, ry: 60 }; f.run();
        expect(f.actions).toHaveLength(6); expect(f.updates()).toBe(0);
        expect(f.lookups).toContain("Teeth");
    });
    test.each([22, 22.1])("a dog protects vulnerable infantry inside, not outside, the existing close-defense scale %s", gap => {
        const f = dogFinishScenario("DOG", gap); f.run();
        expect(f.actions).toHaveLength(gap <= 22 ? 0 : 6);
        expect(f.updates()).toBe(gap <= 22 ? 1 : 0);
    });
    test("Normal retains its original dog target and does not inspect the new sweep threat condition", () => {
        const f = dogFinishScenario("DOG", 64, "normal");
        f.game.rulesApi.getWeapon = () => { throw Error("Normal must not inspect the new dog sweep condition"); };
        f.run(); expect(f.actions).toHaveLength(0); expect(f.updates()).toBe(1);
        expect(f.army.getAttackArea()).toEqual(new Vector2(70, 60));
    });
    test("a stationary army centroid cannot blacklist a sweep unit that is still making progress", () => {
        const f = scenario(), first = f.game.getUnitData(1), second = f.game.getUnitData(2);
        first.tile = { rx: 0, ry: 4 }; second.tile = { rx: 70, ry: 4 };
        f.game.mapApi.isVisibleTile = (tile: { rx: number; ry: number }) => tile.rx !== 44 || tile.ry !== 4;
        f.beginFinish(); f.run(); expect(f.actions).toHaveLength(1);
        f.at(24060); f.run();
        first.tile.rx = 20; second.tile.rx = 50; // Keep the centroid unchanged while the assigned tank advances.
        f.at(24930); f.run();
        expect((f.army as any).sweep.get(1).progressAt).toBe(24930);
        f.at(24960); f.run();
        expect(f.updates()).toBe(0);
        expect((f.army as any).sweep.get(1)?.point).toEqual(new Vector2(44, 4));
        expect((f.army as any).failedSearches.has("44,4")).toBe(false);
    });
});

import { describe, expect, test } from "bun:test";
import { ObjectType, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { MatchAwarenessImpl } from "../../game/ai/thirdpartbot/builtIn/bot/logic/awareness";
import { getKnownEnemyDirections } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/knownEnemyDirections";
import { getStaticDefencePlacement } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/common";
import { AntiAirStaticDefence } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/antiAirStaticDefence";
import { MissionController } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missionController";
import { FieldArmyMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/fieldArmyMission";
import { AttackMission, AttackMissionFactory } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/attackMission";
import { selectRadiationGuardPoint } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/radiationGuardMission";
import { ActionBatcher } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/actionBatcher";

/** Policy-level counterfactual; real-engine shroud/collision checks are separate. */
function fixture(hiddenEnemyStart = new Vector2(90, 90), difficulty: "normal" | "brutal" = "brutal") {
    let tick = 900, revealAll = false, sensitiveReads = 0, legalPlacements = 0;
    const player = { name: "bot", isCombatant: true, country: { name: "Arabs" },
        startLocation: new Vector2(10, 10), credits: 5000 };
    const names = ["bot", "enemy", "ally", "observer"];
    const starts = [new Vector2(10, 10), new Vector2(90, 90), new Vector2(10, 60), new Vector2(60, 10)];
    const objects = new Map<number, any>();
    const visible = new Set<number>();
    const revealed = new Set<string>();
    const add = (id: number, name: string, owner: string, x: number, y: number, type = ObjectType.Building,
        extra: Record<string, unknown> = {}) => {
        const unit = { id, name, owner, type, tile: { rx: x, ry: y }, hitPoints: 1000, maxHitPoints: 1000,
            foundation: { width: 2, height: 2 }, zone: ZoneType.Ground,
            rules: { name, type, baseNormal: type === ObjectType.Building, ...extra } };
        objects.set(id, unit);
        return unit;
    };
    add(100, "NACNST", "bot", 10, 10, ObjectType.Building, { constructionYard: true });
    const ownUnits = [1, 2, 3, 4].map(id => add(id, "HTNK", "bot", 10, 10, ObjectType.Vehicle));
    const metadata = new Map<string, any>();
    for (const name of names.filter(name => name !== "bot")) {
        const data = { name, isCombatant: name !== "observer", isObserver: name === "observer" };
        for (const property of ["startLocation", "credits", "power"]) Object.defineProperty(data, property, {
            get() { sensitiveReads++; throw new Error(`Private ${name}.${property} (${hiddenEnemyStart.x},${hiddenEnemyStart.y})`); },
        });
        metadata.set(name, data);
    }
    const tile = (rx: number, ry: number) => ({ rx, ry, id: `${rx},${ry}` });
    const game: any = {
        getCurrentTick: () => tick, getTickRate: () => 15,
        generateRandom: () => 0.25, generateRandomInt: (min: number) => min,
        getPlayers: () => names,
        areAlliedPlayers: (a: string, b: string) => a === b || (["bot", "ally"].includes(a) && ["bot", "ally"].includes(b)),
        getPlayerData: (name: string) => name === "bot" ? player : metadata.get(name),
        getVisibleUnits: (_name: string, relation: string, filter = (_rules: any) => true) => [...objects.values()]
            .filter(unit => (relation === "self" ? unit.owner === "bot" : relation === "allied"
                ? ["bot", "ally"].includes(unit.owner) : unit.owner === "enemy" && visible.has(unit.id)) && filter(unit.rules))
            .map(unit => unit.id),
        getGameObjectData: (id: number) => objects.get(id), getUnitData: (id: number) => objects.get(id),
        getBuildingPlacementData: () => ({ foundation: { width: 2, height: 2 } }),
        canPlaceBuilding: (_player: string, _name: string, at: any) => {
            legalPlacements++;
            return at.rx >= 0 && at.ry >= 0;
        },
        mapApi: {
            getStartingLocations: () => starts.map(point => point.clone()), getTile: tile,
            getTilesInRect: (rect: any) => Array.from({ length: rect.width * rect.height }, (_, i) =>
                tile(rect.x + i % rect.width, rect.y + Math.floor(i / rect.width))),
            isVisibleTile: (at: any) => revealAll || revealed.has(`${at.rx},${at.ry}`) || Math.hypot(at.rx - 10, at.ry - 10) <= 25,
            getRealMapSize: () => ({ width: 100, height: 100 }), hasBridgeOnTile: () => false, isPassableTile: () => true,
        },
    };
    // Exercise the actual rally policy without requiring terrain-cache work in a
    // unit test. The separate real-engine fixture must cover that cache work.
    const awareness = Object.create(MatchAwarenessImpl.prototype) as MatchAwarenessImpl;
    Object.assign(awareness, {
        accurateWeapons: difficulty === "brutal", mainRallyPoint: player.startLocation.clone(), logger() {},
        sectorCache: { updateSectors() {}, getSectorUpdateRatio: () => 1, getOverallVisibility: () => 0 },
        buildSpaceCache: { update() {}, isFinished: () => false },
        scoutingManager: { onAiUpdate() {} }, hostileQuadTree: { clear() {}, insert() {} },
    });
    const controller = new MissionController(() => {});
    const army = new FieldArmyMission(null, controller, () => {});
    Object.assign(army, { squad: { setAirSafety() {}, setDefensiveRadius() {}, setAttackArea() {}, onAiUpdate() {} } });
    for (const unit of ownUnits) army.addUnit(unit.id);
    const context: any = { difficulty, game, player: { name: player.name,
        production: { getAvailableObjects: () => [] }, actions: {} },
        matchAwareness: awareness, actionBatcher: new ActionBatcher() };
    const buildRule: any = { name: "NALASR", type: ObjectType.Building, adjacent: 5 };
    return { game, player, names, starts, objects, visible, revealed, metadata, awareness, army, context, add,
        revealEverything() { revealAll = true; },
        setTick(at: number) { tick = at; },
        sensitiveReads: () => sensitiveReads, legalPlacements: () => legalPlacements,
        sample() {
            awareness.onAiUpdate(context);
            army.onAiUpdate(context);
            const normalController = new MissionController(() => {});
            new AttackMissionFactory().maybeCreateMissions({ ...context, difficulty: "normal" }, normalController,
                () => {}, { composition: { HTNK: 4 }, minimumUnits: 4, maximumUnits: 4 });
            return {
                rally: awareness.getMainRallyPoint().clone(), army: army.getAttackArea()?.clone(),
                normalAttack: (normalController.getMissions()[0] as AttackMission | undefined)?.getAttackArea()?.clone(),
                groundPlacement: getStaticDefencePlacement(game, player as any, buildRule),
                airPlacement: new AntiAirStaticDefence(1, 1, 7.5).getPlacementLocation(game, player as any, buildRule),
                radiationGuard: selectRadiationGuardPoint(context, 6),
            };
        },
    };
}

describe("scouting information boundary", () => {
    for (const difficulty of ["normal", "brutal"] as const) {
        test(`${difficulty}: private enemy start assignment cannot change any of the six directional policies`, () => {
            const a = fixture(new Vector2(90, 90), difficulty), b = fixture(new Vector2(60, 10), difficulty);
            const before = a.sample(), after = b.sample();
            expect(after).toEqual(before);
            expect(before.army).toEqual(new Vector2(10, 60));
            expect(before.normalAttack).toEqual(new Vector2(10, 60));
            expect(before.radiationGuard).toBeDefined();
            expect(before.groundPlacement).toBeDefined();
            expect(before.airPlacement).toBeDefined();
            expect(a.legalPlacements()).toBeGreaterThan(0);
            expect(a.sensitiveReads()).toBe(0);
            expect(b.sensitiveReads()).toBe(0);
        });
    }

    test("revealing an enemy factory changes direction; a hidden factory does not", () => {
        const f = fixture();
        const initial = f.sample();
        f.add(70, "GAWEAP", "enemy", 70, 10, ObjectType.Building, { weaponsFactory: true });
        f.setTick(990);
        expect(f.sample()).toEqual(initial);
        f.visible.add(70);
        f.revealed.add("70,10");
        f.setTick(1080);
        const observed = f.sample();
        expect(observed.rally).toEqual(new Vector2(20, 10));
        expect(observed.army).toEqual(new Vector2(70, 10));
        expect(observed.normalAttack).toEqual(new Vector2(70, 10));
        expect(observed.radiationGuard).not.toEqual(initial.radiationGuard);
        expect(getKnownEnemyDirections(f.game, f.player as any)).toEqual([new Vector2(70, 10)]);
        expect(f.sensitiveReads()).toBe(0);
    });

    test("enumeration order, duplicated starts, equal distances and enemy metadata order do not pick hidden assignments", () => {
        const a = fixture(), b = fixture();
        b.starts.reverse(); b.names.reverse(); b.starts.push(new Vector2(10, 60));
        expect(getKnownEnemyDirections(a.game, a.player as any)).toEqual([
            new Vector2(10, 60), new Vector2(60, 10), new Vector2(90, 90),
        ]);
        expect(b.sample()).toEqual(a.sample());
        for (const f of [a, b]) {
            f.add(71, "GAWEAP", "enemy", 70, 10);
            f.add(70, "NAREFN", "enemy", 10, 70);
            f.visible.add(70); f.visible.add(71);
        }
        const building = b.objects.get(71);
        b.objects.delete(71); b.objects.set(71, building);
        expect(getKnownEnemyDirections(a.game, a.player as any)).toEqual([new Vector2(10, 70), new Vector2(70, 10)]);
        expect(getKnownEnemyDirections(b.game, b.player as any)).toEqual(getKnownEnemyDirections(a.game, a.player as any));
    });

    test("no combatant enemy and no unexplored public points use safe fallbacks without sensitive data", () => {
        for (const condition of ["no-enemy", "all-known"] as const) {
            const f = fixture();
            if (condition === "no-enemy") f.names.splice(f.names.indexOf("enemy"), 1);
            else f.revealEverything();
            expect(getKnownEnemyDirections(f.game, f.player as any)).toEqual([]);
            const result = f.sample();
            expect(result.rally).toEqual(f.player.startLocation);
            expect(result.normalAttack).toBeUndefined();
            expect(result.radiationGuard).toBeUndefined();
            expect(result.groundPlacement).toBeDefined();
            expect(result.airPlacement).toBeDefined();
            expect(f.sensitiveReads()).toBe(0);
        }
    });

    test("only invalid or own public start points yield no enemy direction", () => {
        const f = fixture();
        f.game.mapApi.getStartingLocations = () => [new Vector2(10, 10), new Vector2(-1, -1)];
        f.game.mapApi.getTile = (x: number, y: number) => x < 0 || y < 0 ? undefined : { rx: x, ry: y };
        expect(getKnownEnemyDirections(f.game, f.player as any)).toEqual([]);
        expect(f.sample().rally).toEqual(f.player.startLocation);
        expect(f.sensitiveReads()).toBe(0);
    });
});

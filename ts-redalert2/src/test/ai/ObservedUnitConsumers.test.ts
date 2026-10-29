import { describe, expect, test } from "bun:test";
import { HealthLevel } from "../../game/gameobject/unit/HealthLevel";
import { RulesApi } from "../../game/api/RulesApi";
import { GameApi, MovementZone, ObjectType, SpeedType, StanceType, UnitData, Vector2, ZoneType } from "../../game/ai/thirdpartbot/builtIn/game-api";
import { estimatedCombatWeapons, estimatedHealthRatio, estimatedHitPoints, estimatedMaxHitPoints,
    estimatedPurchaseValue, isObservedLivingUnit } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/observedUnit";
import { getKnownEnemyDirections } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/knownEnemyDirections";
import { calculateGlobalThreat } from "../../game/ai/thirdpartbot/builtIn/bot/logic/threat/threatCalculator";
import { calculateSectorThreat } from "../../game/ai/thirdpartbot/builtIn/bot/logic/threat/sectorThreat";
import { findBaseThreat, raidTargetIsSafe, selectRaidTarget, visibleEnemies } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/strategicTargets";
import { chooseTacticalTarget, getCombatWeapon, getTacticalRetreatPoint } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/tacticalTargeting";
import { antiAirThreats } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/airSafety";
import { DesolatorTactics, getRadiationDeployment } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/squads/desolatorTactics";
import { safeCaptureEntry } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/sneakCaptureMission";

const rifle = { name: "M60", damage: 15, burst: 1, rof: 20, range: 4, minimumRange: 0, projectile: "Bullet", warhead: "SA" };
const flak = { ...rifle, name: "Flak", range: 8, projectile: "AA" };
const eruption = { ...rifle, name: "Eruption", areaFire: true, radLevel: 500, warhead: "Rad" };
const rules = { name: "E1", type: ObjectType.Infantry, primary: "M60", strength: 125, cost: 200,
    armor: 0, speedType: SpeedType.Foot, movementZone: MovementZone.Infantry, isSelectableCombatant: true };
const projectiles = new Map([["Bullet", { isAntiGround: true, isAntiAir: false }], ["AA", { isAntiGround: false, isAntiAir: true }]]);
const warhead = { verses: new Map([[0, 1]]), cellSpread: 10 };

function observed(id = 10, extra: any = {}): UnitData {
    return { id, name: "E1", type: ObjectType.Infantry, owner: "enemy", rules, healthLevel: HealthLevel.Green,
        tile: { rx: 4, ry: 0, z: 0 }, zone: ZoneType.Ground, direction: 0, ...extra } as UnitData;
}
function own(extra: any = {}): UnitData {
    return observed(1, { owner: "bot", name: "HTNK", type: ObjectType.Vehicle, rules: { ...rules, name: "HTNK", strength: 400 },
        hitPoints: 400, maxHitPoints: 400, purchaseValue: 900, canMove: true, tile: { rx: 0, ry: 0, z: 0 },
        primaryWeapon: { rules: rifle, projectileRules: projectiles.get("Bullet"), warheadRules: warhead,
            maxRange: 6, minRange: 0, cooldownTicks: 19 }, ...extra });
}
function fixture(enemies: UnitData[], allies = [own()]) {
    const objects = [...allies, ...enemies];
    const allRules = [...new Map(objects.map(unit => [unit.name, unit.rules])).values()];
    const weapons = new Map([["M60", rifle], ["Flak", flak], ["Eruption", eruption]]);
    const map = { getTile: (rx: number, ry: number) => ({ rx, ry, z: 0 }), isPassableTile: () => true,
        isVisibleTile: () => true, hasBridgeOnTile: () => false, getStartingLocations: () => [new Vector2(), new Vector2(50, 50)] };
    const game = {
        rulesApi: {
            healthDisplayConditions: { conditionYellow: 0.5, conditionRed: 0.25 },
            getWeapon: (name: string) => weapons.get(name), getProjectile: (name: string) => projectiles.get(name), getWarhead: () => warhead,
            infantryRules: new Map(allRules.filter(rule => rule.type === ObjectType.Infantry).map(rule => [rule.name, rule])),
            vehicleRules: new Map(allRules.filter(rule => rule.type === ObjectType.Vehicle).map(rule => [rule.name, rule])),
            buildingRules: new Map(allRules.filter(rule => rule.type === ObjectType.Building).map(rule => [rule.name, rule])), aircraftRules: new Map(),
            radiation: { radDurationMultiple: 1, radLevelDelay: 90, radLevelMax: 500, radApplicationDelay: 16, radLevelFactor: 0.2, radSiteWarhead: "Rad" },
        },
        getVisibleUnits: (_player: string, relation: string, filter: (rules: any) => boolean = () => true) =>
            (relation === "enemy" ? enemies : allies).filter(unit => filter(unit.rules)).map(unit => unit.id),
        getUnitData: (id: number) => objects.find(unit => unit.id === id), getGameObjectData: (id: number) => objects.find(unit => unit.id === id),
        getUnitsInArea: () => objects.map(unit => unit.id), mapApi: map, getPlayers: () => ["bot", "enemy"],
        areAlliedPlayers: (a: string, b: string) => a === b, getPlayerData: (name: string) => ({ name, isCombatant: true }),
    } as unknown as GameApi;
    const player = { name: "bot", startLocation: new Vector2() };
    const context = { game, player, matchAwareness: { getHostilesNearPoint2d: () => enemies.map(unit => ({ unitId: unit.id })) } } as any;
    return { game, player, context };
}

describe("consumer estimates for uniform foreign observations", () => {
    test("uses public color interval upper endpoints, never a fabricated measured ratio", () => {
        const unit = observed(), { game } = fixture([unit]);
        expect(estimatedHealthRatio(unit, game)).toBe(1);
        expect(estimatedHitPoints({ ...unit, healthLevel: HealthLevel.Yellow }, game)).toBe(62.5);
        expect(estimatedHitPoints({ ...unit, healthLevel: HealthLevel.Red }, game)).toBe(31.25);
        expect(isObservedLivingUnit({ ...unit, healthLevel: HealthLevel.Red })).toBe(true);
        game.rulesApi.healthDisplayConditions.conditionYellow = 0.6;
        expect(estimatedHealthRatio({ ...unit, healthLevel: HealthLevel.Yellow }, game)).toBe(0.6);
        expect(estimatedHealthRatio({ ...unit, healthLevel: undefined }, game)).toBeUndefined();
        expect(estimatedHitPoints({ ...unit, healthLevel: undefined }, game)).toBeUndefined();
        expect(estimatedHealthRatio({ ...unit, healthLevel: HealthLevel.Red })).toBeUndefined();
        expect(estimatedMaxHitPoints(unit)).toBe(125);
        expect(estimatedPurchaseValue(unit)).toBe(200);
        expect(Object.hasOwn(unit, "hitPoints")).toBe(false);
    });

    test("unknown HP and runtime weapon do not make an observed armed enemy dead or harmless", () => {
        const unit = observed(10, { healthLevel: undefined }), { game, player } = fixture([unit]);
        expect(isObservedLivingUnit(unit)).toBe(true);
        expect(getCombatWeapon(unit, own(), false, game)).toMatchObject({ range: 4, damage: 15 });
        expect(calculateGlobalThreat(game, player as any, 1, true).totalOffensiveLandThreat).toBeGreaterThan(0);
        expect(calculateSectorThreat(0, 0, 10, game, player as any)).toBe(125 - 400);
        const unknown = observed(11, { healthLevel: undefined, rules: { ...rules, strength: undefined } });
        expect(estimatedHitPoints(unknown, game)).toBeUndefined();
        expect(chooseTacticalTarget(own(), [unknown], new Map(), undefined, game)?.id).toBe(11);
    });

    test("known own HP, purchase value, runtime weapon and cooldown take precedence without mutation", () => {
        const unit = own({ hitPoints: 100, maxHitPoints: 500, healthLevel: HealthLevel.Green });
        const { game } = fixture([]);
        Object.freeze(unit);
        expect(estimatedHealthRatio(unit, game)).toBe(0.2);
        expect(estimatedHitPoints(unit, game)).toBe(100);
        expect(estimatedMaxHitPoints(unit)).toBe(500);
        expect(estimatedPurchaseValue(unit)).toBe(900);
        expect(estimatedCombatWeapons(unit, game)[0]).toBe(unit.primaryWeapon);
        expect(estimatedCombatWeapons(unit, game)[0].cooldownTicks).toBe(19);
        expect(estimatedCombatWeapons({ ...unit, primaryWeapon: undefined }, game)[0]).toBeUndefined();
        expect(isObservedLivingUnit({ ...unit, hitPoints: 0 })).toBe(false);
        expect(isObservedLivingUnit({ ...unit, isWarpedOut: true })).toBe(false);
    });

    test("nominal foreign weapons contain no runtime cooldown and do not backfill actual fields", () => {
        const unit = Object.freeze(observed()), { game } = fixture([unit]);
        const weapon = estimatedCombatWeapons(unit, game)[0];
        expect(weapon.estimateSource).toBe("apparent-base-rules");
        expect(weapon.cooldownTicks).toBeUndefined();
        expect(unit.primaryWeapon).toBeUndefined();
        expect(Object.hasOwn(unit, "primaryWeapon")).toBe(false);
    });

    test("unknown foreign stance retains both nominal directed weapons without inventing deployment", () => {
        const deployedRifle = { ...rifle, name: "Para", damage: 25, range: 7 };
        const gi = observed(12, { rules: { ...rules, deployFire: true, deployFireWeapon: 1, secondary: "Para" } });
        const { game } = fixture([gi]);
        const originalGetWeapon = game.rulesApi.getWeapon.bind(game.rulesApi);
        game.rulesApi.getWeapon = (name: string) => name === "Para" ? deployedRifle : originalGetWeapon(name);
        expect(gi.stance).toBeUndefined();
        expect(gi.isFiring).toBeUndefined();
        expect(getCombatWeapon(gi, own(), true, game)).toMatchObject({ range: 7, damage: 25 });
        const ownGi = own({ rules: gi.rules, stance: StanceType.None,
            secondaryWeapon: { rules: deployedRifle, maxRange: 7, minRange: 0, cooldownTicks: 11,
                projectileRules: projectiles.get("Bullet"), warheadRules: warhead } });
        expect(getCombatWeapon(ownGi, observed(), true, game)?.weapon).toBe(ownGi.primaryWeapon);
        expect(getCombatWeapon({ ...ownGi, stance: StanceType.Deployed }, observed(), true, game)?.weapon)
            .toBe(ownGi.secondaryWeapon);
        const unknownDeso = observed(13, { name: "DESO",
            rules: { ...rules, name: "DESO", deployFire: true, deployFireWeapon: 1, secondary: "Eruption" } });
        const estimatedThreat = getCombatWeapon(unknownDeso, own(), true, game);
        expect(estimatedThreat?.weapon.rules.name).toBe("M60");
        expect(estimatedThreat?.weapon.rules.areaFire).not.toBe(true);
        expect(unknownDeso.stance).toBeUndefined();
    });

    test("equivalent third-party infantry appearances give identical living, threat and targeting decisions", () => {
        // The API tests establish SPY/E1 projection equivalence. Consumers get
        // only these two independent legal observations, never hidden origins.
        const apparentSpy = observed(10, { healthLevel: HealthLevel.Yellow });
        const realInfantry = observed(10, { healthLevel: HealthLevel.Yellow });
        const decision = (enemy: UnitData) => {
            const { game, player, context } = fixture([enemy]);
            return {
                living: visibleEnemies(context).map(unit => unit.id),
                threat: calculateGlobalThreat(game, player as any, 1, true),
                attack: getCombatWeapon(enemy, own(), false, game),
                target: chooseTacticalTarget(own(), [enemy], new Map(), undefined, game)?.id,
                retreat: getTacticalRetreatPoint(own({ hitPoints: 50 }), [enemy], game.mapApi, () => true, game),
            };
        };
        const a = decision(apparentSpy), b = decision(realInfantry);
        expect(a).toEqual(b);
        expect(a.living).toEqual([10]);
        expect(a.threat.totalOffensiveLandThreat).toBeGreaterThan(0);
        expect(a.target).toBe(10);
        expect(a.retreat).not.toBeNull();
        expect(Object.values(a.threat).every(Number.isFinite)).toBe(true);
    });

    test("visible buildings remain known directions and nominal armed guards prevent a raid", () => {
        const base = own({ id: 20, type: ObjectType.Building, rules: { name: "GACNST", constructionYard: true } });
        const enemyBase = observed(21, { type: ObjectType.Building, rules: { name: "NAREFN", type: ObjectType.Building, refinery: true, strength: 900 },
            tile: { rx: 40, ry: 40 }, name: "NAREFN", foundation: { width: 3, height: 3 } });
        const guard = observed(22, { tile: { rx: 42, ry: 40 }, type: ObjectType.Building, rules: { ...rules, type: ObjectType.Building } });
        const { game, player, context } = fixture([enemyBase, guard], [base, own()]);
        expect(getKnownEnemyDirections(game, player as any)).toContainEqual(new Vector2(40, 40));
        expect(raidTargetIsSafe(enemyBase, [own()], [enemyBase, guard], game)).toBe(false);
        expect(findBaseThreat(context)).toEqual(new Vector2());
        expect(selectRaidTarget(fixture([enemyBase]).context, [own()], [])?.id).toBe(21);
    });

    test("nominal flak and desolator capabilities use public rules without claiming an observed deployment", () => {
        const aa = observed(30, { rules: { ...rules, primary: "Flak" } });
        const deso = observed(31, { name: "DESO",
            rules: { ...rules, name: "DESO", deployFire: true, deployFireWeapon: 1, secondary: "Eruption" } });
        const { game } = fixture([aa, deso]);
        expect(antiAirThreats(own({ name: "JUMPJET", zone: ZoneType.Air }), [aa], game)).toHaveLength(1);
        expect(getRadiationDeployment(deso, game)).toMatchObject({ radius: 11, lifetime: 546 });
        expect(deso.stance).toBeUndefined();
        expect(getCombatWeapon(deso, own(), true, game)?.weapon.rules.name).toBe("M60");
    });

    test("unknown external DESO stance does not create a remembered past deployment", () => {
        const deso = observed(31, { name: "DESO", tile: { rx: 4, ry: 0 },
            rules: { ...rules, name: "DESO", deployFire: true, deployFireWeapon: 1, secondary: "Eruption" } });
        const traveller = own({ tile: { rx: 20, ry: 0 } });
        const { game, context } = fixture([deso], [traveller]);
        game.getCurrentTick = () => 0;
        const tactics = new DesolatorTactics();
        expect(getRadiationDeployment(deso, game)).not.toBeNull(); // Nominal capability alone is insufficient.
        tactics.observe(context, [traveller]);
        // This only means no recorded site blocks the route; it is not a
        // claim that unknown external radiation is physically absent.
        expect(tactics.isSafeMove(traveller, new Vector2(4, 0))).toBe(true);
    });

    test("known own deployment memory survives unknown stance and disappearance until its original expiry", () => {
        const ownDeso = own({ id: 31, name: "DESO", tile: { rx: 4, ry: 0 }, stance: StanceType.Deployed,
            rules: { ...rules, name: "DESO", deployFire: true, deployFireWeapon: 1, secondary: "Eruption" },
            secondaryWeapon: { rules: eruption, warheadRules: warhead, maxRange: 4 } });
        const traveller = own({ tile: { rx: 20, ry: 0 } });
        const allies = [traveller, ownDeso], enemies: UnitData[] = [];
        const { game, context } = fixture(enemies, allies);
        game.getUnitData = (id: number) => [...allies, ...enemies].find(unit => unit.id === id);
        let tick = 0;
        game.getCurrentTick = () => tick;
        const lifetime = getRadiationDeployment(ownDeso, game)!.lifetime;
        const tactics = new DesolatorTactics();
        tactics.observe(context, [traveller]);
        const crossing = new Vector2(4, 0);
        expect(tactics.isSafeMove(traveller, crossing)).toBe(false);

        // Lost shared intelligence: the same now-external unit has only the
        // uniform appearance contract, and no known deployment state.
        allies.splice(1, 1);
        enemies.push(observed(31, { name: "DESO", tile: ownDeso.tile, rules: ownDeso.rules }));
        tick = 1;
        tactics.observe(context, [traveller]);
        expect(tactics.isSafeMove(traveller, crossing)).toBe(false);
        enemies.splice(0, 1);
        tick = lifetime - 1;
        tactics.observe(context, [traveller]);
        expect(tactics.isSafeMove(traveller, crossing)).toBe(false);
        tick = lifetime;
        tactics.observe(context, [traveller]);
        expect(tactics.isSafeMove(traveller, crossing)).toBe(true);
    });

    test("unknown garrison is not interpreted as a known empty capturable building", () => {
        const target = observed(40, { rules: { ...rules, capturable: true, canBeOccupied: true }, foundation: { width: 1, height: 1 } });
        const { context } = fixture([target]);
        expect(safeCaptureEntry(context, own(), target)).toBe(false);
    });

    test("display thresholds are public rules rather than a unit measurement", () => {
        const api = new RulesApi({ audioVisual: { conditionYellow: 0.6, conditionRed: 0.2, privateUnrelated: 99 } });
        expect(api.healthDisplayConditions).toEqual({ conditionYellow: 0.6, conditionRed: 0.2 });
        api.healthDisplayConditions.conditionRed = 0.8;
        expect(api.healthDisplayConditions.conditionRed).toBe(0.2);
    });
});

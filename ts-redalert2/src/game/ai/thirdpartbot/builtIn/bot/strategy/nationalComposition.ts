import { GameApi, MovementZone, ObjectType, PlayerData } from "../../game-api";
import type { SideComposition } from "./compositionUtils";

export type StrategicSituation = {
    country: string;
    tick: number;
    credits: number;
    harvesters: number;
    own: Record<string, number>;
    enemy: { infantry: number; vehicles: number; aircraft: number; defences: number };
};

const situations = new WeakMap<GameApi, { tick: number; players: Map<string, StrategicSituation> }>();

export const NATIONAL_SUPPORT_LIMITS: Readonly<Record<string, number>> = {
    DESO: 2, SNIPE: 2, TNKD: 4, TTNK: 4, MGTK: 4, APOC: 4,
};

/** Only the player's units and currently visible enemy objects inform new investments. */
export function readStrategicSituation(game: GameApi, player: PlayerData): StrategicSituation {
    const tick = game.getCurrentTick();
    let cache = situations.get(game);
    if (!cache || cache.tick !== tick) {
        cache = { tick, players: new Map() };
        situations.set(game, cache);
    }
    const cached = cache.players.get(player.name);
    if (cached) return cached;
    const own: Record<string, number> = {};
    let harvesters = 0;
    game.getVisibleUnits(player.name, "self", rules => {
        own[rules.name] = (own[rules.name] ?? 0) + 1;
        if (rules.harvester) harvesters++;
        return true;
    });
    const enemy = { infantry: 0, vehicles: 0, aircraft: 0, defences: 0 };
    game.getVisibleUnits(player.name, "enemy", rules => {
        // Armed structures are not IsSelectableCombatant in the stock rules.
        if (rules.type === ObjectType.Building) {
            if (rules.primary || rules.secondary) enemy.defences++;
            return true;
        }
        if (!rules.isSelectableCombatant || rules.harvester) return false;
        if (rules.type === ObjectType.Aircraft || rules.movementZone === MovementZone.Fly) enemy.aircraft++;
        else if (rules.type === ObjectType.Infantry) enemy.infantry++;
        else if (rules.type === ObjectType.Vehicle) enemy.vehicles++;
        return true;
    });
    const result = { country: player.country?.name ?? "", tick, credits: player.credits, harvesters, own, enemy };
    cache.players.set(player.name, result);
    return result;
}

export function countCoreTanks(situation: StrategicSituation): number {
    return ["MTNK", "HTNK", "MGTK", "APOC"].reduce((sum, name) => sum + (situation.own[name] ?? 0), 0);
}

export function hasEstablishedEconomy(situation: StrategicSituation): boolean {
    return situation.harvesters >= 2 && (situation.credits >= 1200 || countCoreTanks(situation) >= 4);
}

export function hasMatureEconomy(situation: StrategicSituation): boolean {
    return situation.tick >= 8 * 60 * 15 && situation.harvesters >= 2 &&
        countCoreTanks(situation) >= 4 && (situation.harvesters >= 3 || situation.credits >= 2500);
}

/** Keep the tank/AA core; choose specialist support from scouted targets and available tech. */
export function selectNationalComposition(
    base: SideComposition,
    available: ReadonlySet<string>,
    situation: StrategicSituation,
    reservedSupport: Readonly<Record<string, number>> = {},
): SideComposition {
    const allied = base.composition.MTNK !== undefined;
    const soviet = base.composition.HTNK !== undefined;
    if ((!allied && !soviet) || !hasEstablishedEconomy(situation)) return base;

    const composition = { ...base.composition };
    const supportUnits: Record<string, number> = {};
    const { enemy, own, country } = situation;
    const mature = hasMatureEconomy(situation);
    const canSupport = (name: string) => available.has(name) &&
        (own[name] ?? 0) + (reservedSupport[name] ?? 0) < NATIONAL_SUPPORT_LIMITS[name];
    let specialist: string | undefined;
    if (country === "British" && canSupport("SNIPE") && enemy.infantry >= 3) {
        specialist = "SNIPE";
    } else if (country === "Germans" && canSupport("TNKD") && enemy.vehicles >= 3 && enemy.vehicles >= enemy.infantry) {
        specialist = "TNKD";
    } else if (country === "Russians" && canSupport("TTNK") && enemy.infantry + enemy.vehicles >= 4 &&
        (situation.credits >= 1200 || mature)) {
        specialist = "TTNK";
    }
    if (specialist) {
        composition[specialist] = 1;
        supportUnits[specialist] = 1;
    }

    // Expensive late units supplement a functioning army; they do not replace its cheap core.
    if (mature && enemy.vehicles >= 3 && !composition.SREF && !composition.V3) {
        const heavy = allied ? "MGTK" : "APOC";
        if (canSupport(heavy)) {
            composition[heavy] = 1;
            supportUnits[heavy] = 1;
        }
    }
    if (Object.keys(supportUnits).length === 0) return base;
    return { ...base, composition, supportUnits,
        maximumUnits: mature ? Math.max(base.maximumUnits, 8) : base.maximumUnits };
}

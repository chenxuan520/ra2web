import type { GlobalThreat } from "../logic/threat/threat";
import type { Compositions, SideComposition } from "./compositionUtils";

/** Choose a counter from scouted threats, retaining a mobile tank screen. */
export function selectAdaptiveComposition(
    compositions: Compositions,
    available: string[],
    threat: GlobalThreat | null,
    harvesters: number,
): SideComposition | null {
    const choose = (...names: string[]) => names.find(name => available.includes(name));
    const core = choose("alliedTanks", "sovietTanks");
    if (!core) {
        const fallback = choose("gis", "conscripts") ?? available[0];
        if (!fallback) return null;
        return { ...compositions[fallback], composition: { ...compositions[fallback].composition }, maximumUnits: 6 };
    }

    const allied = core === "alliedTanks";
    const air = threat?.totalOffensiveAirThreat ?? 0;
    const antiAir = threat?.totalAvailableAntiAirFirepower ?? 0;
    const land = threat?.totalOffensiveLandThreat ?? 0;
    const staticDefence = threat?.totalDefensiveThreat ?? 0;
    const needsAntiAir = air > 0 && air * 1.3 > antiAir;
    // A tank-heavy opening keeps pressure on income. Siege only comes with
    // evidence of fortifications, and never sacrifices the escort to build it.
    const siege = !needsAntiAir && staticDefence > Math.max(2, land * 0.75)
        ? choose(allied ? "alliedArtillery" : "sovietArtillery")
        : undefined;
    const selected = siege ?? core;
    const composition = { ...compositions[selected].composition };
    const tank = allied ? "MTNK" : "HTNK";
    const aa = allied ? "FV" : "HTK";
    if (siege) {
        composition[tank] = 3;
        composition[aa] = 1;
    } else {
        composition[tank] = needsAntiAir ? 3 : 5;
        composition[aa] = needsAntiAir ? 3 : 1;
    }

    return {
        composition,
        minimumUnits: 4,
        // Launch a usable early squad promptly; grow waves with actual income.
        maximumUnits: harvesters >= 4 ? 12 : 6,
    };
}

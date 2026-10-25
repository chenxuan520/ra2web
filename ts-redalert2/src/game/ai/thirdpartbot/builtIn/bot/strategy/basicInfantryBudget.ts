/** One budget shared by the standing reserve, field requests and production cap. */
export function getBasicInfantryBudget(name: string, difficulty: string | undefined) {
    if (name === "E1") return { reserve: 5, total: 9 };
    // P1b experiment: fund armor with a smaller conscript contingent. This is
    // a live-unit cap, not free units or a change to infantry costs/strength.
    return difficulty === "brutal" ? { reserve: 6, total: 12 } : { reserve: 12, total: 32 };
}

/** One budget shared by the standing reserve, field requests and production cap. */
export function getBasicInfantryBudget(name: string, difficulty: string | undefined) {
    if (name === "E1") return { reserve: 5, total: 9 };
    return difficulty === "brutal" ? { reserve: 6, total: 12 } : { reserve: 12, total: 32 };
}

export const isSovietCountry = (name: string | undefined) =>
    !!name && ["Africans", "Arabs", "Confederation", "Russians"].includes(name);

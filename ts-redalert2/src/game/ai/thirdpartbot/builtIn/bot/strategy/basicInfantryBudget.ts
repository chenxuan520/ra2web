/** One budget shared by the standing reserve, field requests and production cap. */
export function getBasicInfantryBudget(name: string, _difficulty: string | undefined) {
    if (name === "E1") return { reserve: 5, total: 9 };
    // Restore the C18 budget. Test command roles independently from spending.
    return { reserve: 12, total: 32 };
}

export const isSovietCountry = (name: string | undefined) =>
    !!name && ["Africans", "Arabs", "Confederation", "Russians"].includes(name);

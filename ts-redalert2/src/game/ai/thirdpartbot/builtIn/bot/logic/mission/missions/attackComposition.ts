import { SideComposition } from "../../../strategy/compositionUtils";
import { UnitComposition } from "../../../strategy/strategy";

/** Reserve explicit support slots without making the minimum core wait for them. */
export function allocateAttackComposition(plan: SideComposition, count: number, includeSupport = true): UnitComposition {
    const weights = Object.entries(plan.composition).filter(([, weight]) => Number.isFinite(weight) && weight > 0);
    const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
    if (total <= 0) return {};
    const supports = Object.entries(plan.supportUnits ?? {}).filter(([name, amount]) =>
        Number.isFinite(amount) && amount >= 1 && weights.some(([unitName]) => name === unitName));
    const supportNames = new Set(supports.map(([name]) => name));
    const core = weights.filter(([name]) => !supportNames.has(name));
    // Existing compositions retain their historical rounding and normal behavior.
    if (!supports.length || !core.length) {
        return Object.fromEntries(weights.map(([name, weight]) => [name, Math.round(weight * count / total)]));
    }
    let remaining = Math.max(0, Math.floor(count));
    const result: UnitComposition = {};
    if (includeSupport) for (const [name, amount] of supports) {
        const reserved = Math.min(Math.floor(amount), Math.max(0, remaining - 1));
        if (reserved > 0) result[name] = reserved;
        remaining -= reserved;
    }
    const coreWeight = core.reduce((sum, [, weight]) => sum + weight, 0);
    const allocations = core.map(([name, weight], index) => {
        const exact = weight * remaining / coreWeight;
        return { name, amount: Math.floor(exact), remainder: exact - Math.floor(exact), index };
    });
    let extras = remaining - allocations.reduce((sum, entry) => sum + entry.amount, 0);
    for (const entry of [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
        if (extras-- > 0) entry.amount++;
    }
    for (const { name, amount } of allocations) if (amount > 0) result[name] = amount;
    return result;
}

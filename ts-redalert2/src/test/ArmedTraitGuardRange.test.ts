import { expect, test } from 'bun:test';
import { ArmedTrait } from '../game/gameobject/trait/ArmedTrait';

function weapon(range: number, neverUse = false) {
    return { range, rules: { neverUse } } as any;
}
function scan(primary: any, secondary: any, selected?: any, guardRange = 4, override?: number) {
    return ArmedTrait.prototype.computeGuardScanRange.call({
        primaryWeapon: primary, secondaryWeapon: secondary, guardWeaponRangeOverride: override,
        gameObject: { rules: { guardRange } },
    } as any, selected);
}

test('a missing secondary weapon does not crash a primary guard scan', () => {
    const primary = weapon(5);
    expect(scan(primary, undefined, primary)).toBe(9);
});
test('a missing primary weapon does not crash a secondary guard scan', () => {
    const secondary = weapon(7);
    expect(scan(undefined, secondary, secondary)).toBe(13);
});
test('two empty slots retain the existing rules-based guard range', () => {
    expect(scan(undefined, undefined)).toBe(7);
});
test('the selected weapon, not an unrelated longer weapon, determines the scan', () => {
    const primary = weapon(10), secondary = weapon(2);
    expect(scan(primary, secondary, secondary, 2)).toBe(3);
});
test('the existing neverUse weapon inclusion and fifteen-tile cap are unchanged', () => {
    const primary = weapon(8, true), secondary = weapon(2);
    expect(scan(primary, secondary, secondary, 2)).toBe(15);
});
test('an unselected secondary weapon still does not extend the primary scan', () => {
    const primary = weapon(5), secondary = weapon(13);
    expect(scan(primary, secondary, primary)).toBe(9);
});
test('the explicit override short-circuits empty weapon slots', () => {
    expect(scan(undefined, undefined, undefined, 4, 6)).toBe(11);
});
test('a zero override is not replaced by a longer weapon range', () => {
    const primary = weapon(10);
    expect(scan(primary, undefined, primary, 4, 0)).toBe(7);
});
test('a larger rules-based guard range still applies the original cap', () => {
    const primary = weapon(3);
    expect(scan(primary, undefined, primary, 10)).toBe(15);
});

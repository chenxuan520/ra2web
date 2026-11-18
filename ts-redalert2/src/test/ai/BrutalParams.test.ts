import { describe, expect, test } from 'bun:test';
import { BRUTAL_PARAMS } from '../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams';
import { GROUPS, parseParams, renderParams } from '../../../e2e/league/p4/paramSpace';

// V0 has no later refinery-hold mechanism, so its three absent knobs are not invented.
const keys = {
    economy: `firstRefineryPriority barracksPriority secondRefineryIntruderRadius secondRefineryIntruderCount
        secondRefineryIntruderCreditsBelow secondRefineryCredits secondRefineryCoreArmor secondRefineryCostMargin
        maxRefineries harvestersPerRefinery extraRefineryPriority russianRadarMinRefineries russianRadarMinArmor
        russianRadarMinCredits radarMinHarvesters radarMinArmor radarPriority techMinHarvesters techMinArmor techPriority
        depotMinCredits depotMinArmor defenseMaxCount defenseMinCredits defenseCooldownTicks defenseStartRadius
        defenseAnchorRadius defenseInfantryIntruders defensePriority teslaMaxCount teslaMinPowerMargin teslaRadius
        teslaMinCredits teslaMinArmor teslaPriority firstFactoryPrioritySoviet firstFactoryPriorityAllied
        secondFactoryMinRefineries secondFactoryMinHarvesters secondFactoryMinCredits secondFactoryMinArmor
        secondFactoryHarvesterOverride extraFactoryPriority maxFactories`,
    assault: `marchCohesion marchLead marchResume marchArrive engageSpread spreadSpacing spreadMaxOffset
        dogHunt dogBiteRange dogLeash dogsPerTank dogMax
        tankOpening tankOpeningUntil tankOpeningFactoryPriority
        lateGameTick heavyDefenceCount defenceArmorFloor defenceForceRatio lateAdvantageMinArmor
        lateAdvantageForceRatio lateAdvantageMinHpFraction emptyFieldForceRatio minArmorShortMap minArmorLongMapVsArmor
        assaultMinArmor assaultArmorLead assaultArmorCap assaultForceRatio retreatArmorCap retreatPowerFloor
        retreatForceRatio decimatedEarly decimatedVsHeavyDefence decimatedLate formedArmor`,
};

describe('central brutal strategy parameters', () => {
    test('the eight strategy groups retain every legacy economy and assault name', () => {
        expect(Object.keys(BRUTAL_PARAMS)).toEqual([...GROUPS]);
        for (const group of ['economy', 'assault'] as const)
            for (const key of keys[group].trim().split(/\s+/)) expect(Object.hasOwn(BRUTAL_PARAMS[group], key)).toBe(true);
    });
    test('all values are finite and have at most two decimal places', () => {
        const values = Object.values(BRUTAL_PARAMS).flatMap(group => Object.values(group));
        expect(values.every(Number.isFinite)).toBe(true);
        expect(values.every(value => Number(value.toFixed(2)) === value)).toBe(true);
    });
    test('the line parser round-trips the parameter file byte for byte', async () => {
        const source = await Bun.file(new URL('../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams.ts', import.meta.url)).text();
        const parsed = parseParams(source);
        expect(Object.keys(parsed)).toHaveLength(Object.values(BRUTAL_PARAMS).flatMap(group => Object.keys(group)).length);
        expect(renderParams(source, parsed)).toBe(source);
    });
});

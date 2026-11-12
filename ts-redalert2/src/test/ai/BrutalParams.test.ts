import { describe, expect, test } from 'bun:test';
import { BRUTAL_PARAMS } from '../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams';

// V0 has no later refinery-hold mechanism, so its three absent knobs are not invented.
const keys = {
    economy: `ecoOnly firstRefineryPriority barracksPriority secondRefineryIntruderRadius secondRefineryIntruderCount
        secondRefineryIntruderCreditsBelow secondRefineryCredits secondRefineryCoreArmor secondRefineryCostMargin
        maxRefineries harvestersPerRefinery extraRefineryPriority russianRadarMinRefineries russianRadarMinArmor
        russianRadarMinCredits radarMinHarvesters radarMinArmor radarPriority techMinHarvesters techMinArmor techPriority
        depotMinCredits depotMinArmor defenseMaxCount defenseMinCredits defenseCooldownTicks defenseStartRadius
        defenseAnchorRadius defenseInfantryIntruders defensePriority teslaMaxCount teslaMinPowerMargin teslaRadius
        teslaMinCredits teslaMinArmor teslaPriority firstFactoryPrioritySoviet firstFactoryPriorityAllied
        secondFactoryMinRefineries secondFactoryMinHarvesters secondFactoryMinCredits secondFactoryMinArmor
        secondFactoryHarvesterOverride extraFactoryPriority maxFactories`,
    assault: `lateGameTick heavyDefenceCount defenceArmorFloor defenceForceRatio lateAdvantageMinArmor
        lateAdvantageForceRatio lateAdvantageMinHpFraction emptyFieldForceRatio minArmorShortMap minArmorLongMapVsArmor
        assaultMinArmor assaultArmorLead assaultArmorCap assaultForceRatio retreatArmorCap retreatPowerFloor
        retreatForceRatio decimatedEarly decimatedVsHeavyDefence decimatedLate formedArmor`,
};

describe('central brutal strategy parameters', () => {
    test('keys retain the champion thresholds and the numeric eco-only diagnostic switch', () => {
        expect(Object.keys(BRUTAL_PARAMS)).toEqual(['economy', 'assault']);
        for (const group of ['economy', 'assault'] as const)
            expect(Object.keys(BRUTAL_PARAMS[group]).sort()).toEqual(keys[group].trim().split(/\s+/).sort());
    });
    test('all 66 values are finite and have at most two decimal places', () => {
        const values = Object.values(BRUTAL_PARAMS).flatMap(group => Object.values(group));
        expect(values).toHaveLength(66);
        expect(values.every(Number.isFinite)).toBe(true);
        expect(values.every(value => Number(value.toFixed(2)) === value)).toBe(true);
    });
});

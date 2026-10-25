import { describe, expect, test } from 'bun:test';
import { allocateAttackComposition } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/attackComposition';
import { AttackMission } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/attackMission';
import { Vector2 } from '../../game/ai/thirdpartbot/builtIn/game-api';

describe('national support slots in attack waves', () => {
    const plan = { composition: { HTNK: 5, HTK: 1, DESO: 1 }, supportUnits: { DESO: 1 }, minimumUnits: 4, maximumUnits: 6 };

    test('a full wave reserves its requested DESO without rounding it out', () => {
        expect(allocateAttackComposition(plan, 6)).toEqual({ DESO: 1, HTNK: 4, HTK: 1 });
    });

    test('minimum departure needs a mixed core but not the slow support unit', () => {
        expect(allocateAttackComposition(plan, 4, false)).toEqual({ HTNK: 3, HTK: 1 });
    });

    test('two support types do not inflate the total wave budget', () => {
        const extended = { ...plan, composition: { ...plan.composition, APOC: 1 }, supportUnits: { DESO: 1, APOC: 1 } };
        expect(allocateAttackComposition(extended, 8)).toEqual({ DESO: 1, APOC: 1, HTNK: 5, HTK: 1 });
    });

    test('malformed support does not create unavailable requests or remove every core slot', () => {
        expect(allocateAttackComposition({ ...plan, supportUnits: { DESO: 99, MISSING: 1, HTK: NaN } }, 4))
            .toEqual({ DESO: 3, HTNK: 1 });
        expect(allocateAttackComposition({ ...plan, supportUnits: { MISSING: 1, DESO: -1 } }, 6))
            .toEqual({ HTNK: 4, HTK: 1, DESO: 1 });
    });

    test('historical compositions without explicit support retain their rounding', () => {
        expect(allocateAttackComposition({ composition: { MTNK: 5, FV: 1 }, minimumUnits: 4, maximumUnits: 6 }, 4))
            .toEqual({ MTNK: 3, FV: 1 });
    });

    test('pending support counts only unfilled reservations and stops after departure', () => {
        const mission = new AttackMission('supported', 1, new Vector2(), new Vector2(20, 20), 10, plan, () => {});
        const units = new Map<number, any>();
        const game = { getGameObjectData: (id: number) => units.get(id), getCurrentTick: () => 0 } as any;
        expect(mission.getPendingSupportUnits(game)).toEqual({ DESO: 1 });
        units.set(1, { id: 1, name: 'DESO', tile: { rx: 0, ry: 0 } });
        // A support unit owned by another mission still leaves this reservation unfilled.
        expect(mission.getPendingSupportUnits(game)).toEqual({ DESO: 1 });
        mission.addUnit(1);
        expect(mission.getPendingSupportUnits(game)).toEqual({});
        for (const [index, name] of ['HTNK', 'HTNK', 'HTNK', 'HTNK', 'HTK'].entries()) {
            const id = index + 2;
            units.set(id, { id, name, tile: { rx: 0, ry: 0 } });
            mission.addUnit(id);
        }
        expect(mission.onAiUpdate({ game, difficulty: 'brutal' } as any)).toEqual({ type: 'noop' });
        mission.removeUnit(1);
        expect(mission.getPendingSupportUnits(game)).toEqual({});
    });
});

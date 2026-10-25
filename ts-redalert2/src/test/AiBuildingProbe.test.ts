import { describe, expect, test } from 'bun:test';
import { observeBuildingMissions } from '../../e2e/ai-building-probe';

describe('building planning telemetry', () => {
    test('preserves method receiver, return identity and original call counts', () => {
        const location = { rx: 4, ry: 9 };
        const calls = { priority: 0, location: 0 };
        const mission = {
            queueType: 0,
            token: 42,
            getUniqueName: () => 'structures',
            getPriorityForBuildingOption(option: { name: string }) {
                expect(this.token).toBe(42);
                expect(option.name).toBe('GAWEAP');
                calls.priority++;
                return 10;
            },
            getBestLocationForStructure(game: object, player: object, option: { name: string }) {
                expect(this.token).toBe(42);
                expect(option.name).toBe('GAWEAP');
                calls.location++;
                return location;
            },
        };
        const snapshot = observeBuildingMissions({ innerBot: { missionController: { getMissions: () => [mission] } } }, () => 12);
        const option = { name: 'GAWEAP' };

        expect(mission.getPriorityForBuildingOption(option)).toBe(10);
        expect(mission.getBestLocationForStructure({}, {}, option)).toBe(location);
        snapshot();
        snapshot();
        expect(calls).toEqual({ priority: 1, location: 1 });
    });

    test('snapshots remain isolated while failed placement later succeeds', () => {
        let tick = 12;
        let location: { rx: number; ry: number } | undefined;
        const mission = {
            queueType: 0,
            getUniqueName: () => 'structures',
            getPriorityForBuildingOption: (_option: { name: string }) => 10,
            getBestLocationForStructure: (_game: object, _player: object, _option: { name: string }) => location,
        };
        const snapshot = observeBuildingMissions({ innerBot: { missionController: { getMissions: () => [mission] } } }, () => tick);
        const option = { name: 'GAWEAP' };
        mission.getPriorityForBuildingOption(option);
        expect(mission.getBestLocationForStructure({}, {}, option)).toBeUndefined();
        const first = snapshot() as Record<string, any>;
        expect(first.structures.placementFailures).toBe(1);
        first.structures.options.GAWEAP.priority = -999;
        expect((snapshot() as Record<string, any>).structures.options.GAWEAP.priority).toBe(10);

        tick = 16;
        location = { rx: 2, ry: 3 };
        mission.getBestLocationForStructure({}, {}, option);
        const last = snapshot() as Record<string, any>;
        expect(last.structures.lastSelected).toEqual({ tick: 16, name: 'GAWEAP', location });
        expect(last.structures.consecutivePlacementFailures).toBe(0);
        expect(last.structures.options.GAWEAP.placementAttempts).toBe(2);
        expect(first.structures.lastSelected.location).toBeNull();
    });

    test('ignores bots and missions without the observed methods', () => {
        expect(observeBuildingMissions({}, () => 0)()).toEqual({});
        expect(observeBuildingMissions({ innerBot: { missionController: { getMissions: () => [{}] } } }, () => 0)()).toEqual({});
    });
});

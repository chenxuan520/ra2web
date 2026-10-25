import { expect, test } from 'bun:test';
import { AiMobilityProbe } from '../../../e2e/ai-mobility-probe';

test('mobility samples only assigned escorts and separates infantry from tracked movement', () => {
    const object = (id: number, name: string, x: number, moving = false) => ({ id, name, tile: { rx: x, ry: 0 },
        moveTrait: { velocity: { x: moving ? 1 : 0 } }, unitOrderTrait: { hasTasks: () => true }, isDestroyed: false });
    const objects = [object(1, 'HTNK', 25, true), object(2, 'DOG', 26), object(3, 'DOG', 100), object(4, 'E2', 5)];
    const players = ['a', 'b'].map((name, startLocation) => ({ name, startLocation, getOwnedObjects: () => name === 'a' ? objects : [] }));
    const mission = (name: string, ids: number[]) => ({ getUniqueName: () => name, getUnitIds: () => ids });
    const bots = new Map([['a', { innerBot: { missionController: { getMissions: () => [
        mission('fieldArmy', [1]), mission('dogEscort', [2]), mission('scout', [3]), mission('infantryHome', [4]),
    ] } } }]]);
    const probe = new AiMobilityProbe(); probe.sample(120, players, bots, [{ x: 0, y: 0 }, { x: 50, y: 0 }]);
    const row = probe.snapshot().players[0];
    expect(row.escortDogSamples).toBe(1); expect(row.meanEscortDogTankDistance).toBe(1);
    expect(row.mobileConscriptSamples).toBe(0); expect(row.homeConscriptSamples).toBe(1);
    expect(row.movingTankSamples).toBe(1); expect(row.firstTankBeyondHome20Tick).toBe(120);
    expect(objects[0].tile.rx).toBe(25);
    expect(probe.snapshot().players[1].roleTelemetryAvailable).toBe(false);
});

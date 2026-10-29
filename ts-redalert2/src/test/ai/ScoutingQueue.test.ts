import { describe, expect, test } from "bun:test";
import { Vector2 } from "../../game/math/Vector2";
import { getUnseenStartingLocations, ScoutingManager } from "../../game/ai/thirdpartbot/builtIn/bot/logic/common/scout";

type ScoutSector = { x: number; y: number; minimumRadius: number; distance: number; visibility: number };

function fixture(sectors: ScoutSector[] = []) {
    let tick = 0;
    const player: any = { name: "scout", startLocation: new Vector2(10, 10) };
    const starts = [player.startLocation.clone()];
    const visible = new Set<string>();
    const scans: number[] = [];
    const game: any = {
        getCurrentTick: () => tick,
        generateRandom() { throw new Error("Scouting queue must not consume random values"); },
        generateRandomInt() { throw new Error("Scouting queue must not consume random values"); },
        mapApi: {
            // MapApi creates new vectors on every call, even for our own start.
            getStartingLocations: () => starts.map(point => point.clone()),
            getTile: (rx: number, ry: number) => ({ rx, ry }),
            isVisibleTile: (tile: { rx: number; ry: number }, name: string) => {
                expect(name).toBe(player.name);
                return visible.has(`${tile.rx},${tile.ry}`);
            },
        },
    };
    const cache: any = {
        forEachInRadius(x: number, y: number, radius: number,
            visit: (x: number, y: number, sector: any, distance: number) => void) {
            expect([x, y]).toEqual([10, 10]);
            scans.push(radius);
            for (const sector of sectors) {
                if (radius >= sector.minimumRadius) {
                    visit(sector.x, sector.y, { value: { sectorVisibilityRatio: sector.visibility } }, sector.distance);
                }
            }
        },
    };
    const manager = new ScoutingManager(() => {});
    return { game, player, starts, visible, scans, cache, manager,
        setTick(value: number) { tick = value; },
        start() { manager.onGameStart(game, player, cache); },
        update() { manager.onAiUpdate(game, player, cache); },
    };
}

describe("scouting queue lifecycle", () => {
    test("unseen-start helper excludes a coordinate-identical own start even under shroud", () => {
        const f = fixture();
        f.starts.push(new Vector2(70, 20), new Vector2(80, 30));
        f.visible.add("80,30");
        expect(f.game.mapApi.getStartingLocations()[0]).not.toBe(f.player.startLocation);
        expect(getUnseenStartingLocations(f.game, f.player)).toEqual([new Vector2(70, 20)]);
    });

    test("initial permanent targets exclude cloned own coordinates without needing own visibility", () => {
        const f = fixture();
        f.starts.push(new Vector2(70, 20));
        f.start();
        const target = f.manager.getNewScoutTarget();
        expect(target?.target).toEqual(new Vector2(70, 20));
        expect(target?.permanent).toBe(true);
        expect(target?.priority).toBe(900);
        expect(f.manager.hasScoutTargets()).toBe(false);
        expect(f.scans).toEqual([16]);
    });

    test("a consumed queue refills at the original expansion tick and advances its radius once", () => {
        const near = { x: 18, y: 10, minimumRadius: 8, distance: 1, visibility: 0 };
        const far = { x: 43, y: 10, minimumRadius: 33, distance: 4, visibility: 0 };
        const f = fixture([near, far]);
        f.visible.add("10,10");
        f.start();
        expect(f.manager.getNewScoutTarget()?.target).toEqual(new Vector2(18, 10));
        expect(f.manager.hasScoutTargets()).toBe(false);
        near.visibility = 1;
        f.setTick(3960); // floor(tick / 120) = 33, strictly greater than 16 + 16.
        f.update();
        const target = f.manager.getNewScoutTarget();
        expect(target?.target).toEqual(new Vector2(43, 10));
        expect(target?.priority).toBe(896);
        expect(target?.permanent).toBe(false);
        expect(f.manager.hasScoutTargets()).toBe(false);
        f.update();
        expect(f.manager.hasScoutTargets()).toBe(false);
        expect(f.scans).toEqual([16, 33]);
    });

    test("an empty queue does not expand before the existing strict time/radius threshold", () => {
        const f = fixture([{ x: 43, y: 10, minimumRadius: 33, distance: 4, visibility: 0 }]);
        f.visible.add("10,10");
        f.start();
        for (const tick of [0, 3839, 3840, 3959]) {
            f.setTick(tick);
            f.update();
            expect(f.manager.hasScoutTargets()).toBe(false);
        }
        expect(f.scans).toEqual([16]);
    });

    test("an explored map still performs a due scan without fabricating targets or rescanning each update", () => {
        const f = fixture([
            { x: 18, y: 10, minimumRadius: 8, distance: 1, visibility: 1 },
            { x: 43, y: 10, minimumRadius: 33, distance: 4, visibility: 1 },
        ]);
        f.starts.push(new Vector2(70, 20));
        f.visible.add("10,10");
        f.visible.add("70,20");
        f.start();
        f.setTick(3960);
        f.update();
        f.update();
        expect(f.manager.hasScoutTargets()).toBe(false);
        expect(f.scans).toEqual([16, 33]);
    });

    test("existing visible head is removed before expansion while remaining priorities stay unchanged", () => {
        const near = { x: 18, y: 10, minimumRadius: 8, distance: 1, visibility: 0 };
        const f = fixture([near, { x: 43, y: 10, minimumRadius: 33, distance: 4, visibility: 0 }]);
        f.starts.push(new Vector2(70, 20));
        f.visible.add("10,10");
        f.start();
        f.visible.add("70,20");
        // The queued nearby target remains, but its mostly explored sector need
        // not enqueue another target during this scan. No queue dedup is tested.
        near.visibility = 0.9;
        f.setTick(3960);
        f.update();
        const remaining = [f.manager.getNewScoutTarget(), f.manager.getNewScoutTarget()];
        expect(remaining.map(target => [target?.target.x, target?.target.y, target?.priority])).toEqual([
            [18, 10, 899], [43, 10, 896],
        ]);
        expect(f.manager.hasScoutTargets()).toBe(false);
        expect(f.scans).toEqual([16, 33]);
    });

    test("an unseen existing head stays queued and visible heads are still consumed one per update", () => {
        const f = fixture([
            { x: 18, y: 10, minimumRadius: 8, distance: 1, visibility: 0 },
            { x: 26, y: 10, minimumRadius: 16, distance: 2, visibility: 0 },
        ]);
        f.visible.add("10,10");
        f.start();
        f.setTick(30);
        f.update();
        expect(f.manager.hasScoutTargets()).toBe(true);
        f.visible.add("18,10");
        f.visible.add("26,10");
        f.update();
        expect(f.manager.getNewScoutTarget()?.target).toEqual(new Vector2(26, 10));
        expect(f.manager.hasScoutTargets()).toBe(false);
        expect(f.scans).toEqual([16]);
    });
});

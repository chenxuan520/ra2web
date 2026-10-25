import { describe, expect, test } from "bun:test";
import { getGrandCannonPlacement, getStrategicBuildingPriority } from "../../game/ai/thirdpartbot/builtIn/bot/logic/building/strategicBuildings";
import { BaseBuildingMission } from "../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseBuildingMission";
import { ObjectType, QueueType, Vector2 } from "../../game/ai/thirdpartbot/builtIn/game-api";

function fixture() {
    let tick = 6000;
    const building = (name: string, rx: number, ry: number, flags = {}) => ({ name, owner: "bot", tile: { rx, ry },
        foundation: { width: 3, height: 3 }, rules: { name, type: ObjectType.Building, baseNormal: true, ...flags } });
    const unit = (name: string, flags = {}) => ({ name, owner: "bot", tile: { rx: 0, ry: 0 },
        rules: { name, type: ObjectType.Vehicle, ...flags } });
    const own: any[] = [building("GACNST", 0, 0, { constructionYard: true }), building("GAREFN", 10, 0, { refinery: true }),
        building("GAWEAP", 0, 10, { weaponsFactory: true }), ...Array.from({ length: 2 }, () => unit("CMIN", { harvester: true })),
        ...Array.from({ length: 4 }, () => unit("MTNK"))];
    const enemies: any[] = Array.from({ length: 4 }, (_, i) => ({ name: "E1", owner: "enemy", tile: { rx: 8, ry: i },
        rules: { name: "E1", type: ObjectType.Infantry, isSelectableCombatant: true } }));
    const player = { name: "bot", country: { name: "French" }, credits: 3000, startLocation: new Vector2(),
        power: { total: 300, drain: 150, isLowPower: false } };
    const cannon = { name: "GTGCAN", cost: 2000, power: -100, adjacent: 2, primary: "GrandCannonWeapon", type: ObjectType.Building };
    const tiles = [{ id: "rear", rx: -4, ry: 0 }, { id: "blind", rx: 6, ry: 0 }];
    const game = {
        getCurrentTick: () => tick,
        getPlayerData: () => player,
        getVisibleUnits: (_player: string, side: string, filter: (rules: any) => boolean) =>
            (side === "self" ? own : enemies).flatMap((object, id) => filter(object.rules) ? [side === "self" ? id : 1000 + id] : []),
        getUnitData: (id: number) => id >= 1000 ? enemies[id - 1000] : own[id],
        getBuildingPlacementData: () => ({ foundation: { width: 2, height: 2 } }),
        canPlaceBuilding: () => true,
        rulesApi: { getWeapon: () => ({ range: 15, minimumRange: 3 }) },
        mapApi: { getTilesInRect: (rect: any) => tiles.filter(tile => tile.rx >= rect.x && tile.rx < rect.x + rect.width &&
            tile.ry >= rect.y && tile.ry < rect.y + rect.height) },
    };
    return { game, player, cannon, own, enemies, unit, building, setTick: (next: number) => tick = next,
        priority: (option = cannon) => getStrategicBuildingPriority(game as any, player as any, option as any, null) };
}

describe("staged technology and national base defence", () => {
    test("a funded French base under visible ground pressure requests one powered grand cannon", () => {
        const f = fixture();
        expect(f.priority()).toBe(24);
        f.own.push(f.building("GTGCAN", 4, 4));
        f.setTick(6002);
        expect(f.priority()).toBe(0);
    });

    test.each(["country", "credits", "power", "miners", "army", "visibility", "distance"])("defers the cannon for insufficient %s", reason => {
        const f = fixture();
        if (reason === "country") f.player.country.name = "Americans";
        if (reason === "credits") f.player.credits = 2599;
        if (reason === "power") f.player.power.total = 249;
        if (reason === "miners") f.own.splice(3, 1);
        if (reason === "army") f.own.pop();
        if (reason === "visibility") f.enemies.length = 0;
        if (reason === "distance") f.enemies.forEach(enemy => enemy.tile = { rx: 100, ry: 100 });
        expect(f.priority()).toBe(0);
    });

    test("only a larger economy and army under heavier pressure permit a second cannon", () => {
        const f = fixture();
        f.setTick(9000);
        f.own.push(f.building("GTGCAN", 4, 4), f.unit("CMIN", { harvester: true }), f.unit("CMIN", { harvester: true }),
            ...Array.from({ length: 4 }, () => f.unit("MTNK")));
        f.enemies.push(...f.enemies.map(enemy => ({ ...enemy })));
        expect(f.priority()).toBe(16);
        f.own.push(f.building("GTGCAN", 8, 4));
        f.setTick(9002);
        expect(f.priority()).toBe(0);
    });

    test("cannon placement protects the threatened economy while avoiding its blind zone", () => {
        const f = fixture();
        expect(getGrandCannonPlacement(f.game as any, f.player as any, f.cannon as any)?.id).toBe("rear");
    });

    test("normal difficulty does not acquire the new grand cannon policy", () => {
        const f = fixture();
        const context = { difficulty: "normal", game: f.game, player: { name: "bot", production: { getAvailableObjects: () => [f.cannon] } },
            matchAwareness: { getThreatCache: () => null } };
        expect(new BaseBuildingMission(QueueType.Armory, () => {})._onAiUpdate(context as any)).toEqual({ type: "noop" });
    });

    test("investments keep their production request after paying below the admission threshold", () => {
        const f = fixture();
        f.player.credits = 50;
        f.enemies.length = 0;
        expect(getStrategicBuildingPriority(f.game as any, f.player as any, f.cannon as any, null, true)).toBe(24);
        expect(getStrategicBuildingPriority(f.game as any, f.player as any,
            { ...f.cannon, name: "GATECH" } as any, null, true)).toBe(18);
    });

    test("the first specialist radar can outrank another factory once a core army exists", () => {
        const f = fixture();
        f.player.country.name = "Arabs";
        f.player.credits = 300;
        expect(f.priority({ ...f.cannon, name: "NARADR", cost: 1000 })).toBe(18);
    });

    test("one income expansion precedes funded late technology", () => {
        const f = fixture();
        expect(f.priority({ ...f.cannon, name: "GAREFN" })).toBe(18);
        expect(f.priority({ ...f.cannon, name: "GATECH" })).toBe(0);
        f.setTick(9000);
        f.enemies.forEach(enemy => enemy.rules.type = ObjectType.Vehicle);
        expect(f.priority({ ...f.cannon, name: "GATECH" })).toBe(18);
        f.player.credits = 100;
        f.setTick(9002);
        expect(f.priority({ ...f.cannon, name: "GATECH" })).toBe(0);
    });
});

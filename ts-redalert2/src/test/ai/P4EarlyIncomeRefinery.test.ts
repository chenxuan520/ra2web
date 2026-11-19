import { expect, test } from 'bun:test';
import { getEconomyBuildingPriority } from '../../game/ai/thirdpartbot/builtIn/bot/logic/building/economyPlan';
import { BRUTAL_PARAMS } from '../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams';
import { BaseBuildingMission } from '../../game/ai/thirdpartbot/builtIn/bot/logic/mission/missions/baseBuildingMission';
import { Vector2 } from '../../game/ai/thirdpartbot/builtIn/game-api';
import { parseGenome, type ParamSpace } from '../../../e2e/league/p4/paramSpace';
import { population } from '../../../e2e/league/p4/evolveCore';

const flag = 'enableEarlyIncomeRefinery';
function withFlag(value: number, check: () => void) {
    const params = BRUTAL_PARAMS.economy as Record<string, number>, previous = params[flag]; params[flag] = value;
    try { check(); } finally { if (previous === undefined) delete params[flag]; else params[flag] = previous; }
}
function fixture(names = ['NAREFN', 'NAWEAP', 'HARV'], resources: any[] = [{ tile: { rx: 1, ry: 1, visible: true }, ore: 10, gems: 0 }], intruders = 0) {
    const owned = names.map(name => ({ name, harvester: ['HARV', 'CMIN'].includes(name) }));
    const enemies = Array.from({ length: intruders }, (_, index) => ({ id: 100 + index, tile: { rx: 2, ry: 2 }, rules: { isSelectableCombatant: true } }));
    let resourceReads = 0;
    const player: any = { name: 'bot', country: { name: 'Russians' }, credits: 62, startLocation: new Vector2() };
    const game: any = {
        getCurrentTick: () => 6000,
        getVisibleUnits: (_name: string, relation: string, filter: any) => relation === 'self'
            ? owned.flatMap((rules, id) => filter(rules) ? [id] : []) : enemies.filter(enemy => filter(enemy.rules)).map(enemy => enemy.id),
        getUnitData: (id: number) => enemies.find(enemy => enemy.id === id),
        mapApi: { getStartingLocations: () => [{ distanceTo: () => 120 }],
            getAllTilesResourceData() { resourceReads++; return resources; }, isVisibleTile: (tile: any) => tile.visible },
    };
    const rules: any = { name: 'NAREFN', refinery: true, cost: 2000, freeUnit: 'HARV' };
    return { game, player, rules, resourceReads: () => resourceReads,
        priority: (committed = false) => getEconomyBuildingPriority(game, player, rules, committed) };
}

test('the income ability has a legal binary value and generated search range', async () => {
    expect([0, 1]).toContain((BRUTAL_PARAMS.economy as Record<string, number>)[flag]);
    const space: ParamSpace = await Bun.file(new URL('../../../e2e/league/p4/paramSpace.json', import.meta.url)).json();
    expect(space[`economy.${flag}`]).toEqual({ min: 0, max: 1, int: true, mutable: true, weight: 1 });
});
test.each([
    ['NAREFN', 'NAWEAP', 'HARV'], ['GAREFN', 'GAWEAP', 'CMIN'],
])('a %s first-factory opening can fund the real supplied miner before the old army/cash thresholds', (refinery, factory, miner) => {
    const f = fixture([refinery, factory, miner]); f.rules.name = refinery; f.rules.freeUnit = miner;
    withFlag(0, () => { expect(f.priority()).toBe(0); expect(f.resourceReads()).toBe(0); });
    withFlag(1, () => expect(f.priority()).toBe(BRUTAL_PARAMS.economy.secondMinerPriority));
    expect(f.player.credits).toBe(62); expect(f.rules.cost).toBe(2000);
});
test('no factory, no surviving income unit or no rule-supplied miner cannot enable a new investment', () => {
    const missingFactory = fixture(['NAREFN', 'HARV']), missingIncome = fixture(['NAREFN', 'NAWEAP']);
    const wrongUnit = fixture(); wrongUnit.rules.freeUnit = 'DOG';
    withFlag(1, () => {
        for (const f of [missingFactory, missingIncome, wrongUnit]) { expect(f.priority()).toBe(0); expect(f.resourceReads()).toBe(0); }
    });
});
test('depleted or hidden resource tiles do not justify the new income request', () => {
    const empty = fixture(undefined, [{ tile: { rx: 1, ry: 1, visible: true }, ore: 0, gems: 0 }]);
    const hidden = fixture(undefined, [{ tile: { rx: 2, ry: 2, visible: false },
        get ore() { throw new Error('Do not read hidden ore'); }, get gems() { throw new Error('Do not read hidden gems'); } }]);
    const gems = fixture(undefined, [{ tile: { rx: 1, ry: 1, visible: true }, ore: 0, gems: 10 }]);
    withFlag(1, () => {
        expect(empty.priority()).toBe(0); expect(hidden.priority()).toBe(0);
        expect(gems.priority()).toBe(BRUTAL_PARAMS.economy.secondMinerPriority);
    });
});
test('the original visible home-intruder veto and committed investment priority stay intact', () => {
    const unsafe = fixture(undefined, undefined, 3);
    withFlag(1, () => {
        expect(unsafe.priority()).toBe(0); expect(unsafe.resourceReads()).toBe(0);
        expect(unsafe.priority(true)).toBe(BRUTAL_PARAMS.economy.firstRefineryPriority); expect(unsafe.resourceReads()).toBe(0);
    });
});
test('first and later refineries do not use the new second-refinery priority', () => {
    const first = fixture(['NAWEAP', 'HARV']);
    const later = fixture(['NAREFN', 'NAREFN', 'NAWEAP', 'HARV', 'HARV', 'HARV', 'HARV']);
    withFlag(1, () => {
        expect(first.priority()).toBe(BRUTAL_PARAMS.economy.firstRefineryPriority);
        expect(later.priority()).toBe(BRUTAL_PARAMS.economy.extraRefineryPriority);
        expect(first.resourceReads() + later.resourceReads()).toBe(0);
    });
});
test('Normal building priorities bypass the brutal economy policy even when the switch is enabled', () => {
    const f = fixture(), mission: any = Object.create(BaseBuildingMission.prototype);
    const priority = () => mission.getPriorityForBuildingOption(f.rules, f.game, f.player, null, 'normal', false);
    let off: number;
    withFlag(0, () => { off = priority(); });
    withFlag(1, () => expect(priority()).toBe(off!));
    expect(f.resourceReads()).toBe(0);
});
test('run3 founders activate the new switch through the existing seeded evolution routine while control stays off', async () => {
    const source = await Bun.file(new URL('../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams.ts', import.meta.url)).text();
    const space: ParamSpace = await Bun.file(new URL('../../../e2e/league/p4/paramSpace.json', import.meta.url)).json();
    const genome = parseGenome(source);
    genome.base[`economy.${flag}`] = 0;
    for (const table of Object.values(genome.overrides)) delete table[`economy.${flag}`];
    const rows = population(genome, [], space, 3, 0, false, `economy.${flag}`);
    expect(rows.slice(0, 4).map(row => row.genome.base[`economy.${flag}`])).toEqual([1, 1, 1, 1]);
    expect(rows[3].seed).toBeGreaterThan(300003); expect((rows[3].seed - 300003) % 1000).toBe(0);
    expect(rows).toEqual(population(genome, [], space, 3, 0, false, `economy.${flag}`));
    expect(rows[15].genome.base[`economy.${flag}`]).toBe(0);
});

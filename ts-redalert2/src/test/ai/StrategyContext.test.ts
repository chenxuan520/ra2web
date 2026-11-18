import { afterEach, expect, test } from 'bun:test';
import { BRUTAL_PARAMS, BRUTAL_OVERRIDES } from '../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams';
import { LARGE_MAP_AREA, sp, strategyContext, type ParamPath } from '../../game/ai/thirdpartbot/builtIn/bot/strategy/params';
import { OVERRIDE_LABELS, genomeKey, parseGenome, renderGenome, validateGenome, type BaseParams, type Genome, type ParamSpace } from '../../../e2e/league/p4/paramSpace';

const tables = BRUTAL_OVERRIDES as Record<typeof OVERRIDE_LABELS[number], BaseParams>;
afterEach(() => { for (const table of Object.values(tables)) for (const path of Object.keys(table)) delete table[path]; });
function fixture(area = LARGE_MAP_AREA, country = 'Americans') {
    const state = { area, country };
    const game: any = { mapApi: { getRealMapSize: () => ({ width: state.area, height: 1 }) },
        getPlayerData: (name: string) => ({ name, country: { name: state.country } }) };
    return { game, state };
}
async function files() {
    const source = await Bun.file(new URL('../../game/ai/thirdpartbot/builtIn/bot/strategy/brutalParams.ts', import.meta.url)).text();
    const space: ParamSpace = await Bun.file(new URL('../../../e2e/league/p4/paramSpace.json', import.meta.url)).json();
    return { source, space, genome: parseGenome(source) };
}
test('four empty tables return every base parameter exactly', () => {
    const f = fixture();
    for (const [group, values] of Object.entries(BRUTAL_PARAMS)) for (const [name, value] of Object.entries(values))
        expect(sp(f.game, 'bot', `${group}.${name}` as ParamPath)).toBe(value);
});
test('large-map override does not affect a small map', () => {
    tables.largeMap['assault.minArmorShortMap'] = 5;
    expect(sp(fixture().game, 'bot', 'assault.minArmorShortMap')).toBe(5);
    expect(sp(fixture(LARGE_MAP_AREA - 1).game, 'bot', 'assault.minArmorShortMap')).toBe(BRUTAL_PARAMS.assault.minArmorShortMap);
});
test('faction has precedence over map size and preserves legitimate zero overrides', () => {
    tables.largeMap['assault.minArmorShortMap'] = 6; tables.soviet['assault.minArmorShortMap'] = 5;
    expect(sp(fixture(LARGE_MAP_AREA, 'Russians').game, 'bot', 'assault.minArmorShortMap')).toBe(5);
    expect(sp(fixture().game, 'bot', 'assault.minArmorShortMap')).toBe(6);
    tables.soviet['assault.tankOpening'] = 0;
    expect(sp(fixture(LARGE_MAP_AREA, 'Russians').game, 'bot', 'assault.tankOpening')).toBe(0);
});
test('area boundary is inclusive and separate games keep independent immutable tags', () => {
    const large = fixture(), small = fixture(LARGE_MAP_AREA - 1, 'Russians');
    expect(strategyContext(large.game, 'bot')).toEqual({ faction: 'allied', mapSize: 'largeMap' });
    expect(strategyContext(small.game, 'bot')).toEqual({ faction: 'soviet', mapSize: 'smallMap' });
    large.state.area = 1; large.state.country = 'Russians';
    expect(strategyContext(large.game, 'bot')).toEqual({ faction: 'allied', mapSize: 'largeMap' });
});
test('parse/render and adding then removing an override are byte-identical', async () => {
    const { source, genome, space } = await files();
    expect(renderGenome(source, genome)).toBe(source); expect(validateGenome(genome, space)).toEqual([]);
    genome.overrides.largeMap['assault.minArmorShortMap'] = 5;
    const added = renderGenome(source, genome), parsed = parseGenome(added);
    expect(parsed.overrides.largeMap).toEqual({ 'assault.minArmorShortMap': 5 });
    delete parsed.overrides.largeMap['assault.minArmorShortMap'];
    expect(renderGenome(added, parsed)).toBe(source);
});
test('override key ordering and genome identities are deterministic', async () => {
    const { source, genome } = await files(), other = structuredClone(genome);
    genome.overrides.largeMap['assault.minArmorShortMap'] = 5; genome.overrides.largeMap['assault.assaultMinArmor'] = 6;
    other.overrides.largeMap['assault.assaultMinArmor'] = 6; other.overrides.largeMap['assault.minArmorShortMap'] = 5;
    expect(renderGenome(source, genome)).toBe(renderGenome(source, other)); expect(genomeKey(genome)).toBe(genomeKey(other));
});
test('immutable, out-of-range, unknown and twenty-fifth overrides are rejected', async () => {
    const { genome, space } = await files();
    const withEntry = (path: string, value: number): Genome => ({ ...structuredClone(genome), overrides: { ...structuredClone(genome.overrides), largeMap: { [path]: value } } });
    expect(validateGenome(withEntry('economy.firstRefineryPriority', 50), space).join()).toContain('Immutable');
    expect(validateGenome(withEntry('assault.minArmorShortMap', 1000), space).join()).toContain('Out of range');
    expect(validateGenome(withEntry('assault.missing', 1), space).join()).toContain('Unknown');
    const crowded = structuredClone(genome);
    for (const path of Object.keys(space).filter(path => space[path].mutable).slice(0, 25)) crowded.overrides.smallMap[path] = crowded.base[path];
    expect(validateGenome(crowded, space).join()).toContain('24');
});
test('base keys, fractional integer parameters and malformed override lines cannot bypass validation', async () => {
    const { source, genome, space } = await files();
    delete genome.base['assault.minArmorShortMap']; expect(validateGenome(genome, space).join()).toContain('Missing');
    genome.base['assault.minArmorShortMap'] = 4.5; expect(validateGenome(genome, space).join()).toContain('Out of range');
    expect(() => parseGenome(source.replace('    largeMap: {', "    largeMap: {\n        'assault.minArmorShortMap': NaN,"))).toThrow('Invalid');
});

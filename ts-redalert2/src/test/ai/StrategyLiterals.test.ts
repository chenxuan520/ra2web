import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ALL_MAPS } from '../../../e2e/league/p4/arena';
import { DECISION_FILES, countStrategyLiterals } from '../../../e2e/league/p4/literalCounts';

const builtin = resolve(import.meta.dir, '../../game/ai/thirdpartbot/builtIn');
test('decision files never regain the extracted numeric literals', async () => {
    const budget = await Bun.file(new URL('../../../e2e/league/p4/literal-budget.json', import.meta.url)).json();
    expect(Object.keys(budget).sort()).toEqual([...DECISION_FILES].sort());
    for (const file of DECISION_FILES) expect(countStrategyLiterals(await readFile(resolve(builtin, 'bot', file), 'utf8'))).toBeLessThanOrEqual(budget[file]);
});
test('literal counting strips comments and strings and excludes zero, one and two', () => {
    expect(countStrategyLiterals('0 + 1 + 2 + 3 + 0.25 + -9999; // 500\n"600"; \'700\'; `800`; /*900*/')).toBe(3);
    expect(countStrategyLiterals('E2; value10; object.3; 10.5;')).toBe(1);
});
test('BUILTIN does not encode a concrete arena map or league member', async () => {
    const league = await Bun.file(new URL('../../../e2e/league/league.json', import.meta.url)).json();
    const forbidden: string[] = [...ALL_MAPS, ...league.members.map((member: any) => member.id)];
    const pattern = new RegExp(`(?<![\\w-])(?:${forbidden.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`);
    for (const file of (await readdir(builtin, { recursive: true })).filter(file => file.endsWith('.ts'))) {
        const source = await readFile(resolve(builtin, file), 'utf8');
        expect({ file, match: pattern.exec(source)?.[0] }).toEqual({ file, match: undefined });
    }
});

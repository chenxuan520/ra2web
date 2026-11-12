import { describe, expect, test } from 'bun:test';
import { BUILTIN, validateLeague, type GitQuery, type League, type Member } from '../../../e2e/league/registry';

function member(id: string, role: Member['role'] = 'history', active = true): Member {
    return { id, tag: `league/${id}`, tree: 'a'.repeat(40), profile: id === 'orig' ? 'normal' : 'brutal', role, active, note: id,
        ...(role === 'exploiter' || role === 'sparring' ? { style: id.split('-')[1], target: 'm0', winsVsTarget: 8 } : {}) };
}
function fixture(): League {
    return { schema: 1, round: 0, champion: null, members: ['orig', 'r4', 'v0', 'm0'].map(id => member(id)) };
}
function fakeGit(league: League, fail?: 'tag' | 'tree' | 'adapter'): GitQuery {
    return args => {
        const ref = args.at(-1)!;
        if (args[0] === 'rev-parse' && ref.endsWith('^{commit}')) {
            if (fail === 'tag') throw new Error('missing tag');
            return 'b'.repeat(40);
        }
        if (args[0] === 'rev-parse' && ref.endsWith(`:${BUILTIN}`)) {
            if (fail === 'tree') return 'c'.repeat(40);
            return league.members.find(entry => ref === `${entry.tag}:${BUILTIN}`)!.tree;
        }
        if (args[0] === 'cat-file') {
            if (fail === 'adapter') throw new Error('missing adapter');
            return '';
        }
        throw new Error(`Unexpected git query ${args.join(' ')}`);
    };
}
const valid = (league: League) => validateLeague(league, fakeGit(league));

describe('league registry', () => {
    test('valid initial members use an injected git query, not real tags', async () => {
        const league = fixture(); expect(await valid(league)).toEqual(league);
    });
    test('valid champion and inactive history are retained', async () => {
        const league = fixture(); league.champion = 'm0'; league.members[3].role = 'champion'; league.members[2].active = false;
        expect(await valid(league)).toEqual(league);
    });
    test.each(['schema', 'round', 'id', 'duplicate', 'tag', 'hash', 'profile', 'protocol', 'role', 'active', 'note'])(
        '%s validation rejects malformed input', async kind => {
            const league: any = fixture();
            if (kind === 'schema') league.schema = 2;
            if (kind === 'round') league.round = -1;
            if (kind === 'id') league.members[0].id = '../escape';
            if (kind === 'duplicate') league.members.push({ ...league.members[0] });
            if (kind === 'tag') league.members[0].tag = 'other/orig';
            if (kind === 'hash') league.members[0].tree = 'not-a-tree';
            if (kind === 'profile') league.members[0].profile = 'easy';
            if (kind === 'protocol') league.members[1].profile = 'normal';
            if (kind === 'role') league.members[0].role = 'candidate';
            if (kind === 'active') league.members[0].active = 1;
            if (kind === 'note') delete league.members[0].note;
            await expect(validateLeague(league, fakeGit(league))).rejects.toThrow();
        });
    test.each(['tag', 'tree', 'adapter'] as const)('missing or changed git %s is rejected', async failure => {
        const league = fixture(); await expect(validateLeague(league, fakeGit(league, failure))).rejects.toThrow();
    });
    test('active pool is bounded at twelve without deleting inactive records', async () => {
        const league = fixture(); league.members = Array.from({ length: 13 }, (_, index) => member(`v${index}`));
        await expect(valid(league)).rejects.toThrow('12 active');
        league.members[12].active = false; expect((await valid(league)).members).toHaveLength(13);
    });
    test('active exploiter pool is bounded at four', async () => {
        const league = fixture(); league.members = Array.from({ length: 5 }, (_, index) => member(`x-${String.fromCharCode(97 + index)}-01`, 'exploiter'));
        await expect(valid(league)).rejects.toThrow('4 active exploiters');
        league.members[4].active = false; expect((await valid(league)).members).toHaveLength(5);
    });
    test('sparring is valid and its active pool is bounded at six', async () => {
        const league = fixture(); league.members = Array.from({ length: 7 }, (_, index) => member(`x-${String.fromCharCode(97 + index)}-01`, 'sparring'));
        await expect(valid(league)).rejects.toThrow('6 active sparring');
        league.members[6].active = false; expect((await valid(league)).members).toHaveLength(7);
    });
    test.each(['exploiter', 'sparring'] as const)('styles are unique across an inactive %s and exploiters', async role => {
        const league = fixture(); const first = member('x-rush-01', 'exploiter'), second = member('x-rush-02', role, false);
        league.members.push(first, second); await expect(valid(league)).rejects.toThrow('duplicate style');
    });
    test('sparring requires the same style, target and win-count fields', async () => {
        for (const patch of [{ style: '' }, { target: '' }, { winsVsTarget: -1 }, { winsVsTarget: 25 }]) {
            const league = fixture(); league.members.push({ ...member('x-rush-01', 'sparring'), ...patch });
            await expect(valid(league)).rejects.toThrow();
        }
    });
    test.each(['absent', 'inactive', 'wrong-role', 'extra', 'late-null'])( '%s champion reference is rejected', async kind => {
        const league = fixture(); league.champion = 'm0'; league.members[3].role = 'champion';
        if (kind === 'absent') league.champion = 'c9';
        if (kind === 'inactive') league.members[3].active = false;
        if (kind === 'wrong-role') league.members[3].role = 'history';
        if (kind === 'extra') league.members.push(member('c1', 'champion', false));
        if (kind === 'late-null') { league.champion = null; league.round = 1; league.members[3].role = 'history'; }
        await expect(valid(league)).rejects.toThrow();
    });
    test('an independently frozen safety replacement retains its blocked predecessor', async () => {
        const league = fixture(); league.members[2].active = false; league.members[2].blockedReason = 'invalid coordinate orders';
        league.members.push({ ...member('v5', 'champion'), tree: 'b'.repeat(40), replaces: 'v0' }); league.champion = 'v5';
        expect(await valid(league)).toEqual(league);
    });
    test.each(['active', 'empty', 'not-string'])('a blocked member cannot be %s', async reason => {
        const league: any = fixture(); league.members[2].active = false; league.members[2].blockedReason = 'invalid coordinates';
        if (reason === 'active') league.members[2].active = true;
        if (reason === 'empty') league.members[2].blockedReason = '';
        if (reason === 'not-string') league.members[2].blockedReason = true;
        await expect(valid(league)).rejects.toThrow('blocked');
    });
    test.each(['missing', 'self', 'unblocked', 'same-tree'])('a safety replacement rejects its %s predecessor', async reason => {
        const league = fixture(); league.members[2].active = false; league.members[2].blockedReason = 'invalid coordinates';
        const replacement = { ...member('v5', 'champion'), tree: 'b'.repeat(40), replaces: 'v0' };
        if (reason === 'missing') replacement.replaces = 'c9';
        if (reason === 'self') replacement.replaces = 'v5';
        if (reason === 'unblocked') delete league.members[2].blockedReason;
        if (reason === 'same-tree') replacement.tree = league.members[2].tree;
        league.members.push(replacement); league.champion = 'v5';
        await expect(valid(league)).rejects.toThrow('safety replacement');
    });
    test.each(['member:x-air-01', 'map:mp11t2'])('optional repair %s is valid without changing historical attempts', async fixes => {
        const league = fixture(); league.members[3].fixes = fixes; league.members[3].attempts = 3;
        expect(await valid(league)).toEqual(league);
    });
    test.each(['', 'member:r4', 'member:x-Air-01', 'map:mp11-t2', 'map:../mp11t2', 'other:mp11t2', 1])('malformed repair %s is rejected', async fixes => {
        const league: any = fixture(); league.members[3].fixes = fixes;
        await expect(valid(league)).rejects.toThrow('fixes');
    });
    test('eco repair is accepted without changing historical attempt limits', async () => {
        const league = fixture(); league.members[3].fixes = 'eco'; league.members[3].attempts = 3;
        expect(await valid(league)).toEqual(league);
    });
    test('eco does not accept a suffix or change existing repair formats', async () => {
        for (const fixes of ['eco:mp11t2', 'eco ', 'Eco']) {
            const league = fixture(); league.members[3].fixes = fixes;
            await expect(valid(league)).rejects.toThrow('fixes');
        }
    });
    test('empty members and null input are rejected', async () => {
        await expect(validateLeague(null, () => '')).rejects.toThrow();
        const league = fixture(); league.members = []; await expect(valid(league)).rejects.toThrow();
    });
    test('exploiter target, recent win count and champion attempts have valid ranges', async () => {
        for (const patch of [{ style: '' }, { target: '' }, { winsVsTarget: -1 }, { winsVsTarget: 25 }, { attempts: 4 }]) {
            const league = fixture(); league.members.push({ ...member('x-rush-01', 'exploiter'), ...patch });
            await expect(valid(league)).rejects.toThrow();
        }
        const league = fixture(); league.members.push({ ...member('x-rush-01', 'exploiter'), winsVsTarget: 0 });
        expect(await valid(league)).toEqual(league);
    });
});

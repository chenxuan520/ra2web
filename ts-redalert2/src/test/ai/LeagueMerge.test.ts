import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mergeShards, type ShardOutput } from '../../../e2e/league/merge';
import { pairingJobs, shardJobs, compareGames } from '../../../e2e/league/schedule';
import type { FrozenMember } from '../../../e2e/league/run';

function member(id: string): FrozenMember {
    return { id, ref: `league/${id}`, commit: 'c'.repeat(40), tree: (id === 'm0' ? 'a' : 'b').repeat(40), profile: 'brutal' };
}
function resign(output: ShardOutput) {
    output.manifest.fingerprint = createHash('sha256').update(JSON.stringify(output.manifest.config)).digest('hex');
}
function shards(count = 12, opponent = 'r4'): ShardOutput[] {
    const jobs = pairingJobs('m0', opponent, 0, 'dev'), a = member('m0'), b = member(opponent);
    return Array.from({ length: count }, (_, index) => {
        const config: ShardOutput['manifest']['config'] = { round: 0, kind: 'dev', versions: { [a.id]: a, [b.id]: b },
            runtime: { engineCommit: 'engine', bunVersion: '1.3.14' }, resources: { iniSha256: 'ini' }, jobs, cdn: 'cdn', shard: `${index}/${count}` };
        const games = shardJobs(jobs, config.shard!).flatMap(job => [false, true].map(swapped => ({
            round: 0, kind: 'dev' as const, a: a.id, b: b.id, aTree: a.tree, bTree: b.tree,
            map: job.map, seed: job.seed, aCountry: job.aCountry, bCountry: job.bCountry, swapped,
            result: swapped ? 'b-win' as const : 'a-win' as const, reason: 'engine-victory-conditions', ticks: 100,
        })));
        const output = { manifest: { schema: 1, fingerprint: '', config }, games }; resign(output); return output;
    });
}

describe('strict league shard merge', () => {
    test('complete shards merge to 24 stably sorted games without changing inputs', () => {
        const input = shards().reverse(), before = JSON.stringify(input), games = mergeShards(input);
        expect(games).toHaveLength(24); expect(games).toEqual([...games].sort(compareGames));
        expect(JSON.stringify(input)).toBe(before);
    });
    test('empty shards are valid when all scheduled games are present', () => {
        expect(mergeShards(shards(24))).toHaveLength(24);
    });
    test('missing one shard is caught from the full schedule, not the surviving rows', () => {
        const input = shards(); input.pop(); expect(() => mergeShards(input)).toThrow('Missing league jobs');
    });
    test('an entirely missing opponent is invalid even when each surviving pairing is complete', () => {
        const input = shards(1);
        input[0].manifest.config.jobs.push(...pairingJobs('m0', 'v0', 0, 'dev'));
        input[0].manifest.config.versions.v0 = member('v0'); resign(input[0]);
        expect(() => mergeShards(input)).toThrow('Incomplete shard');
    });
    test('a partial paired job and duplicate rows cannot merge', () => {
        const partial = shards(); partial[0].games.pop(); expect(() => mergeShards(partial)).toThrow('Incomplete shard');
        const duplicate = shards(); duplicate[0].games[1] = { ...duplicate[0].games[0] };
        expect(() => mergeShards(duplicate)).toThrow('duplicate game');
        const repeated = shards(); expect(() => mergeShards([...repeated, repeated[0]])).toThrow('duplicate game');
    });
    test.each(['runtime', 'resources', 'versions', 'jobs'])( 'different frozen %s is rejected', field => {
        const input = shards(), config = input[1].manifest.config;
        if (field === 'runtime') config.runtime = { engineCommit: 'different' };
        if (field === 'resources') config.resources = { iniSha256: 'different' };
        if (field === 'versions') config.versions = { ...config.versions, m0: { ...config.versions.m0, tree: 'd'.repeat(40) } };
        if (field === 'jobs') config.jobs = [...config.jobs].reverse();
        resign(input[1]); expect(() => mergeShards(input)).toThrow('different frozen');
    });
    test('damaged manifest fingerprint is rejected', () => {
        const input = shards(); input[0].manifest.fingerprint = 'bad'; expect(() => mergeShards(input)).toThrow('Invalid league shard manifest');
    });
    test('a game from another shard or a changed candidate tree is rejected', () => {
        const wrongShard = shards(); wrongShard[0].games[0] = { ...wrongShard[1].games[0] };
        expect(() => mergeShards(wrongShard)).toThrow('Unexpected');
        const tree = shards(); tree[0].games[0].aTree = 'd'.repeat(40); expect(() => mergeShards(tree)).toThrow('identity');
    });
    test('error rows remain errors, never victories', () => {
        const input = shards(); input[0].games[0].result = 'error'; input[0].games[0].reason = 'logged-runtime-errors';
        expect(mergeShards(input).filter(game => game.result === 'error')).toHaveLength(1);
    });
    test('a selfcheck must remain mirrored after merge', () => {
        const input = shards(12, 'm0'); input[0].games[1].ticks++;
        expect(() => mergeShards(input)).toThrow('not mirrored');
    });
    test('empty input is rejected', () => {
        expect(() => mergeShards([])).toThrow('No league shards');
    });
});

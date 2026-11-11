import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const BUILTIN = 'ts-redalert2/src/game/ai/thirdpartbot/builtIn';
export const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const LEAGUE_PATH = resolve(import.meta.dir, 'league.json');
export type Profile = 'normal' | 'brutal';
export type Role = 'history' | 'champion' | 'exploiter' | 'sparring';
export interface Member {
    id: string;
    tag: string;
    tree: string;
    profile: Profile;
    role: Role;
    active: boolean;
    note: string;
    style?: string;
    target?: string;
    winsVsTarget?: number;
    attempts?: number;
    blockedReason?: string;
    replaces?: string;
}
export interface League {
    schema: 1;
    round: number;
    champion: string | null;
    members: Member[];
}
export type GitQuery = (args: readonly string[]) => string | Promise<string>;
export async function gitQuery(args: readonly string[]): Promise<string> {
    const child = Bun.spawn(['git', ...args], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`git ${args[0]}: ${error.trim()}`);
    return output.trim();
}
function check(value: unknown, message: string): asserts value {
    if (!value) throw new Error(`Invalid league: ${message}`);
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const memberId = /^(orig|r4|m0|v[0-9]+|c[0-9]+|x-[a-z]+-[0-9]{2})$/;
const treeHash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Validate the registry and immutable tag trees before starting any game. Git is injectable for unit tests. */
export async function validateLeague(value: unknown, query: GitQuery = gitQuery): Promise<League> {
    check(object(value) && value.schema === 1, 'schema must be 1');
    check(Number.isSafeInteger(value.round) && (value.round as number) >= 0, 'round must be a nonnegative integer');
    check(Array.isArray(value.members) && value.members.length > 0, 'members must be a nonempty array');
    const ids = new Set<string>(), styles = new Set<string>();
    for (const entry of value.members) {
        check(object(entry) && typeof entry.id === 'string' && memberId.test(entry.id), 'invalid member id');
        check(!ids.has(entry.id), `duplicate id ${entry.id}`); ids.add(entry.id);
        check(entry.tag === `league/${entry.id}`, `tag does not match ${entry.id}`);
        check(typeof entry.tree === 'string' && treeHash.test(entry.tree), `invalid tree for ${entry.id}`);
        check(entry.profile === 'normal' || entry.profile === 'brutal', `invalid profile for ${entry.id}`);
        check(entry.id === 'orig' ? entry.profile === 'normal' : entry.profile === 'brutal', `profile violates fixed protocol for ${entry.id}`);
        check(['history', 'champion', 'exploiter', 'sparring'].includes(entry.role as string), `invalid role for ${entry.id}`);
        check(typeof entry.active === 'boolean' && typeof entry.note === 'string', `invalid active/note for ${entry.id}`);
        if (entry.blockedReason !== undefined) check(typeof entry.blockedReason === 'string' && entry.blockedReason.trim().length > 0 && !entry.active,
            `blocked member ${entry.id} must remain inactive with a reason`);
        if (entry.role === 'exploiter' || entry.role === 'sparring') {
            check(typeof entry.style === 'string' && entry.style.trim().length > 0, `missing style for ${entry.id}`);
            check(!styles.has(entry.style), `duplicate style ${entry.style}`); styles.add(entry.style);
            check(typeof entry.target === 'string' && memberId.test(entry.target), `invalid target for ${entry.id}`);
            check(Number.isInteger(entry.winsVsTarget) && (entry.winsVsTarget as number) >= 0 && (entry.winsVsTarget as number) <= 24,
                `invalid winsVsTarget for ${entry.id}`);
        }
        if (entry.attempts !== undefined) check(Number.isInteger(entry.attempts) && (entry.attempts as number) >= 1 && (entry.attempts as number) <= 3,
            `invalid attempts for ${entry.id}`);
    }
    const members = value.members as Member[], active = members.filter(member => member.active);
    check(active.length <= 12, 'more than 12 active members');
    check(active.filter(member => member.role === 'exploiter').length <= 4, 'more than 4 active exploiters');
    check(active.filter(member => member.role === 'sparring').length <= 6, 'more than 6 active sparring');
    const champions = members.filter(member => member.role === 'champion');
    if (value.champion === null) {
        check(value.round === 0 && champions.length === 0, 'null champion is only valid before round 0');
    } else {
        check(typeof value.champion === 'string' && champions.length === 1 && champions[0].id === value.champion && champions[0].active,
            'champion must identify the only active champion member');
    }
    for (const member of members) {
        if (member.replaces !== undefined) {
            const previous = members.find(entry => entry.id === member.replaces);
            check(previous && previous.id !== member.id && previous.blockedReason && !previous.active &&
                previous.profile === member.profile && previous.tree !== member.tree, `invalid safety replacement ${member.id}`);
        }
        const commit = (await query(['rev-parse', '--verify', '--end-of-options', `${member.tag}^{commit}`])).trim();
        check(treeHash.test(commit), `tag ${member.tag} does not resolve to a commit`);
        const tree = (await query(['rev-parse', '--verify', '--end-of-options', `${member.tag}:${BUILTIN}`])).trim();
        check(tree === member.tree, `tree mismatch for ${member.id}`);
        await query(['cat-file', '-e', `${member.tag}:${BUILTIN}/BuiltInBotAdapter.ts`]);
    }
    return value as unknown as League;
}
export async function loadLeague(path = LEAGUE_PATH, query: GitQuery = gitQuery): Promise<League> {
    return validateLeague(await Bun.file(path).json(), query);
}

if (import.meta.main) {
    try {
        const { values } = parseArgs({ options: { check: { type: 'boolean' } } });
        if (!values.check) throw new Error('Usage: bun e2e/league/registry.ts --check');
        const league = await loadLeague();
        process.stdout.write(JSON.stringify({ valid: true, round: league.round, champion: league.champion,
            members: league.members.length, active: league.members.filter(member => member.active).length,
            trees: Object.fromEntries(league.members.map(member => [member.id, member.tree])) }, null, 2) + '\n');
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
    }
}

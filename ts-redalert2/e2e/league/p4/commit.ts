import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BUILTIN, REPO_ROOT } from '../registry';

export const PARAMETER_PATH = `${BUILTIN}/bot/strategy/brutalParams.ts`;
export async function git(args: readonly string[], environment: Record<string, string | undefined> = {}, input?: string): Promise<string> {
    const child = Bun.spawn(['git', ...args], { cwd: REPO_ROOT, env: { ...process.env, ...environment },
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    if (input !== undefined) child.stdin.write(input);
    await child.stdin.end();
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(`git ${args[0]}: ${error.trim()}`);
    return output.trim();
}
export async function buildCommit(baseCommit: string, parameterSource: string): Promise<string> {
    const scratch = resolve(REPO_ROOT, 'ts-redalert2/.artifacts/p4/git-scratch');
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, 'index-'));
    const environment = { GIT_INDEX_FILE: join(directory, 'index'), GIT_AUTHOR_NAME: 'p4-evolve', GIT_AUTHOR_EMAIL: 'p4-evolve@invalid',
        GIT_COMMITTER_NAME: 'p4-evolve', GIT_COMMITTER_EMAIL: 'p4-evolve@invalid',
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
    try {
        const blob = await git(['hash-object', '-w', '--stdin'], environment, parameterSource);
        await git(['read-tree', baseCommit], environment);
        await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${PARAMETER_PATH}`], environment);
        const tree = await git(['write-tree'], environment);
        return await git(['commit-tree', tree, '-p', baseCommit, '-m', 'p4-evolve'], environment);
    } finally { await rm(directory, { recursive: true, force: true }); }
}

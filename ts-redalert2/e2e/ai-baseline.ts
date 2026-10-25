import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BuiltInBotAdapter } from '../src/game/ai/thirdpartbot/builtIn/BuiltInBotAdapter';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = dirname(projectRoot.replace(/\/$/, ''));
const sourcePrefix = 'ts-redalert2/src/game/ai/thirdpartbot/builtIn/';

async function git(...args: string[]): Promise<string> {
    const process = Bun.spawn(['git', ...args], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
    const [output, error, code] = await Promise.all([
        new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args[0]} failed: ${error.trim()}`);
    return output;
}

/** Freeze a historical bot while sharing the current engine and its API with both players. */
export async function loadBaselineBot(ref: string): Promise<{
    BotAdapter: typeof BuiltInBotAdapter;
    commit: string;
}> {
    const commit = (await git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)).trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('Expected a full Git commit hash');
    const files = (await git('ls-tree', '-r', '--name-only', commit, '--', sourcePrefix)).trim().split('\n');
    if (!files.some(file => file === `${sourcePrefix}BuiltInBotAdapter.ts`)) {
        throw new Error(`Commit ${commit} does not contain the built-in bot adapter`);
    }
    const snapshotRoot = join(projectRoot, '.cache', 'ai-baselines', commit);
    for (const file of files) {
        if (!file.startsWith(sourcePrefix) || !file.endsWith('.ts')) continue;
        const destination = join(snapshotRoot, file.slice(sourcePrefix.length));
        if (relative(snapshotRoot, destination).startsWith('..')) throw new Error('Invalid snapshot path');
        let source = await git('show', `${commit}:${file}`);
        if (file.endsWith('/game-api.ts')) {
            // Only the engine API is shared. All strategy, recovery and micro code
            // remains the exact implementation from this immutable Git commit.
            source = 'export * from "@/game/ai/thirdpartbot/builtIn/game-api";\n';
        } else if (file.endsWith('/BuiltInBotAdapter.ts')) {
            source = source.replaceAll("'../../../bot/Bot'", "'@/game/bot/Bot'")
                .replaceAll("'../BotRegistry'", "'@/game/ai/thirdpartbot/BotRegistry'");
        }
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, source);
    }
    await writeFile(join(snapshotRoot, 'snapshot.json'), JSON.stringify({ commit, sourcePrefix,
        sharedEngine: 'current checkout', adaptation: 'engine API shim and external adapter import paths only' }, null, 2));
    const module = await import(pathToFileURL(join(snapshotRoot, 'BuiltInBotAdapter.ts')).href);
    return { BotAdapter: module.BuiltInBotAdapter, commit };
}

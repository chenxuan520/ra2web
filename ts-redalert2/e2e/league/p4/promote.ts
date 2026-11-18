import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BUILTIN, REPO_ROOT, loadLeague, validateLeague } from '../registry';
import { git, PARAMETER_PATH } from './commit';
import { holdoutJobs, TRAIN_OPPONENTS, HOLDOUT_OPPONENTS } from './arena';
import { parseGenome, validateGenome, type ParamSpace } from './paramSpace';
import { judgePromotion, promotedLeague, promotionMarkdown, type PromotionPlan, type PromotionDecision } from './promoteCore';
import type { ArenaGame } from './play';

const projectRoot = resolve(REPO_ROOT, 'ts-redalert2'), root = join(projectRoot, '.artifacts/p4/evo-state/promotions');
async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')); }
async function save(path: string, value: unknown) {
    await mkdir(resolve(path, '..'), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n'); await rename(temporary, path);
}
async function sourceRun(commit: string): Promise<number | null> {
    const artifacts = join(projectRoot, '.artifacts/p4');
    for (const name of await readdir(artifacts)) {
        const match = /^run-(\d+)$/.exec(name); if (!match) continue;
        const path = join(artifacts, name, 'candidate/candidate.json'); if (!await Bun.file(path).exists()) continue;
        if ((await json<{ commit: string }>(path)).commit === commit) return Number(match[1]);
    }
    return null;
}
async function plan(candidateRef: string) {
    const league = await loadLeague(); if (!league.champion) throw new Error('A champion is required');
    const baseCommit = await git(['rev-parse', 'HEAD']), champion = league.members.find(member => member.id === league.champion)!;
    if (baseCommit !== await git(['rev-parse', 'refs/heads/master']) || await git(['rev-parse', `${baseCommit}:${BUILTIN}`]) !== champion.tree)
        throw new Error('master must match the registered champion before promotion');
    const candidate = await git(['rev-parse', '--verify', `${candidateRef}^{commit}`]), candidateTree = await git(['rev-parse', `${candidate}:${BUILTIN}`]);
    const changed = await git(['diff', '--name-only', baseCommit, candidate, '--', BUILTIN]);
    if (changed && changed !== PARAMETER_PATH) throw new Error('Promotion candidate may only change brutalParams.ts');
    const source = await git(['show', `${candidate}:${PARAMETER_PATH}`]), space: ParamSpace = await json(join(import.meta.dir, 'paramSpace.json'));
    const errors = validateGenome(parseGenome(source + '\n'), space); if (errors.length) throw new Error(errors.join('; '));
    let counter = { last: 0 };
    if (await Bun.file(join(root, 'counter.json')).exists()) counter = await json(join(root, 'counter.json'));
    const promotion = counter.last + 1; if (promotion > 500) throw new Error('Promotion seed range exhausted');
    const opponents = [...TRAIN_OPPONENTS, ...HOLDOUT_OPPONENTS];
    const candidateJobs = [league.champion, ...opponents].flatMap(opponent => holdoutJobs('cand', opponent, promotion).map(job => ({ ...job, aRef: candidate })));
    const baselineJobs = opponents.flatMap(opponent => holdoutJobs(league.champion!, opponent, promotion));
    const value: PromotionPlan = { promotion, champion: league.champion, candidate, candidateTree, championTree: champion.tree,
        baseCommit, jobs: [...candidateJobs, ...baselineJobs], trees: { ...Object.fromEntries(league.members.map(member => [member.id, member.tree])), cand: candidateTree }, run: await sourceRun(candidate) };
    await git(['update-ref', `refs/evo/promo/p${promotion}-cand`, candidate, '']);
    await save(join(root, `p${promotion}/plan.json`), value); await save(join(root, `p${promotion}/jobs.json`), value.jobs); await save(join(root, 'counter.json'), { last: promotion });
    console.log(JSON.stringify({ promotion, candidate, jobs: value.jobs.length, games: value.jobs.length * 2, jobsFile: join(root, `p${promotion}/jobs.json`) }, null, 2));
}
function replaceTraining(source: string, training: readonly string[]): string {
    const line = /^export const TRAIN_OPPONENTS = \[[^\n]*\];$/m;
    if (!line.test(source)) throw new Error('Unexpected arena training-pool format');
    return source.replace(line, `export const TRAIN_OPPONENTS = [${training.map(id => `'${id}'`).join(', ')}];`);
}
async function publish(plan: PromotionPlan, decision: PromotionDecision, gamesText: string) {
    const league = await loadLeague();
    if (league.champion !== plan.champion || await git(['rev-parse', 'HEAD']) !== plan.baseCommit) throw new Error('Promotion champion/baseCommit changed');
    if (await git(['status', '--porcelain', '--untracked-files=all', '--', 'ts-redalert2/src', 'ts-redalert2/e2e', 'docs/ai-league'])) throw new Error('Freeze source and league files before --write');
    if (await git(['diff', '--cached', '--name-only'])) throw new Error('Resolve existing staged work before --write');
    const nextId = `c${Number(plan.champion.slice(1)) + 1}`, tag = `league/${nextId}`;
    if (await git(['tag', '--list', tag])) throw new Error(`Frozen tag already exists: ${tag}`);
    const parameterSource = await git(['show', `${plan.candidate}:${PARAMETER_PATH}`]) + '\n';
    const paths = { params: resolve(REPO_ROOT, PARAMETER_PATH), league: join(projectRoot, 'e2e/league/league.json'), arena: join(import.meta.dir, 'arena.ts'),
        results: join(REPO_ROOT, 'docs/ai-league/p4-results.jsonl'), markdown: join(REPO_ROOT, 'docs/ai-league/P4.md') };
    const backups = new Map<string, Uint8Array | null>();
    for (const path of Object.values(paths)) backups.set(path, await Bun.file(path).exists() ? new Uint8Array(await Bun.file(path).arrayBuffer()) : null);
    let committed = false;
    try {
        await git(['tag', tag, plan.candidate]);
        const adopted = promotedLeague(league, nextId, plan.candidateTree, plan.promotion, TRAIN_OPPONENTS);
        await validateLeague(adopted.league);
        const oldGenome = parseGenome(await readFile(paths.params, 'utf8')), newGenome = parseGenome(parameterSource);
        await writeFile(paths.params, parameterSource); await save(paths.league, adopted.league);
        await writeFile(paths.arena, replaceTraining(await readFile(paths.arena, 'utf8'), adopted.training));
        await writeFile(paths.results, (backups.get(paths.results) ? new TextDecoder().decode(backups.get(paths.results)!) : '') + gamesText);
        const previous = backups.get(paths.markdown) ? new TextDecoder().decode(backups.get(paths.markdown)!) : '';
        const records = previous.split(/\r?\n/).filter(line => /^\| \d+ \| c\d+ \|/.test(line));
        const row = `| ${plan.promotion} | ${nextId} | ${plan.run ?? 'trial'} | ${decision.rates.overallDelta.toFixed(6)} | ${decision.rates.holdoutDelta.toFixed(6)} | ${decision.direct.wins - decision.direct.losses} | ${decision.candidate.winMedian} | ${decision.candidate.timeouts} |`;
        const differences = Object.keys(newGenome.base).filter(path => oldGenome.base[path] !== newGenome.base[path]).sort()
            .map(path => `| ${path} | ${oldGenome.base[path]} | ${newGenome.base[path]} |`);
        for (const [table, values] of Object.entries(newGenome.overrides)) for (const [path, value] of Object.entries(values)) differences.push(`| ${table}:${path} | ${oldGenome.overrides[table as keyof typeof oldGenome.overrides][path] ?? '-'} | ${value} |`);
        await writeFile(paths.markdown, ['# Phase 4 AI league', '', '| Promotion | Champion | Run | Overall delta | Holdout delta | Direct net wins | Win median | Timeouts |',
            '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |', ...records, row, '', promotionMarkdown(decision), '',
            '## Parameter changes', '', '| Parameter | Previous | New |', '| --- | ---: | ---: |', ...differences, ''].join('\n'));
        const checks = [['bun', 'test'], ['bun', 'run', 'typecheck:entry'], ['bun', 'run', 'typecheck:server'], ['bun', '--bun', 'tsc', '-p', 'e2e/tsconfig.ai-league.json'],
            ['bun', 'e2e/league/registry.ts', '--check'], ['bun', 'run', 'build']];
        const logs = join(root, `p${plan.promotion}/checks`); await mkdir(logs, { recursive: true });
        const result = await Promise.all(checks.map(async (command, index) => {
            const child = Bun.spawn(command, { cwd: projectRoot, stdout: 'pipe', stderr: 'pipe' });
            const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
            await writeFile(join(logs, `${index}.log`), output + error); return code;
        }));
        if (result.some(code => code !== 0)) throw new Error('Promotion source checks failed; inspect local checks, no commit/push performed');
        await git(['add', '--', ...Object.values(paths)]);
        const indexedTree = await git(['write-tree']);
        if (await git(['rev-parse', `${indexedTree}:${BUILTIN}`]) !== plan.candidateTree) throw new Error('master worktree BUILTIN does not exactly match candidate');
        await git(['diff', '--cached', '--check']); await git(['diff', '--check', 'origin/master..HEAD']);
        await git(['commit', '-m', `feat(ai): promote ${nextId} from phase 4 run ${plan.run ?? 'trial'} (H1-H6)`]); committed = true;
        await git(['push', '--atomic', 'origin', 'master', `refs/tags/${tag}`]);
        console.log(JSON.stringify({ champion: nextId, commit: await git(['rev-parse', 'HEAD']), tree: plan.candidateTree, tag }, null, 2));
    } catch (error) {
        if (!committed) {
            // Only undo files/tag created by this publication attempt; preflight required a clean source tree.
            for (const [path, bytes] of backups) {
                if (bytes === null) { if (await Bun.file(path).exists()) await unlink(path); }
                else await writeFile(path, bytes);
            }
            const staged = (await git(['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);
            if (staged.length) await git(['restore', '--staged', '--', ...staged]);
            if (await git(['tag', '--list', tag])) await git(['tag', '-d', tag]);
        }
        throw error;
    }
}
export async function main() {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { candidate: { type: 'string' }, promotion: { type: 'string' },
        games: { type: 'string' }, 'eco-candidate': { type: 'string' }, write: { type: 'boolean' } } });
    if (positionals[0] === 'plan') { if (!values.candidate) throw new Error('--candidate is required'); await plan(values.candidate); return; }
    if (positionals[0] !== 'judge' || !values.promotion || !values.games || !values['eco-candidate']) throw new Error('Usage: promote.ts plan --candidate X | judge --promotion P --games FILE --eco-candidate FILE [--write]');
    const promotion = Number(values.promotion); if (!Number.isSafeInteger(promotion) || promotion < 1 || promotion > 500) throw new Error('Invalid promotion');
    const proposal: PromotionPlan = await json(join(root, `p${promotion}/plan.json`));
    const gamesText = await readFile(resolve(values.games), 'utf8'), games: ArenaGame[] = gamesText.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    const ecoCandidate: any = await json(resolve(values['eco-candidate']));
    if (ecoCandidate.tree !== proposal.candidateTree) throw new Error('Economic candidate tree mismatch');
    const baseline = await json(join(REPO_ROOT, 'docs/ai-league/eco-baseline.json'));
    const decision = judgePromotion(games, proposal, ecoCandidate, baseline); await save(join(root, `p${promotion}/result.json`), decision);
    console.log(promotionMarkdown(decision));
    try { if (values.write && decision.pass) await publish(proposal, decision, gamesText); }
    finally { await git(['update-ref', '-d', `refs/evo/promo/p${promotion}-cand`, proposal.candidate]); }
}
if (import.meta.main) {
    try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

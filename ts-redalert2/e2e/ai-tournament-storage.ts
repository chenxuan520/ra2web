import { mkdir, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

/** Preserve every interrupted/error attempt before rerunning its paired job in place. */
export async function archiveJobAttempt(output: string, id: string): Promise<string[]> {
    const sources = ['json', 'log', 'verified.json'].map(extension => ({ extension, path: join(output, 'jobs', `${id}.${extension}`) }));
    const existing = [] as typeof sources;
    for (const source of sources) if (await Bun.file(source.path).exists()) existing.push(source);
    if (!existing.length) return [];
    const directory = join(output, 'archives', id);
    await mkdir(directory, { recursive: true });
    const lastAttempt = (await readdir(directory)).reduce((highest, file) => Math.max(highest, Number(/^attempt-(\d+)\./.exec(file)?.[1] ?? 0)), 0);
    const prefix = `attempt-${String(lastAttempt + 1).padStart(4, '0')}`;
    const destinations: string[] = [];
    for (const source of existing) {
        const destination = join(directory, `${prefix}.${source.extension}`);
        await rename(source.path, destination);
        destinations.push(destination);
    }
    return destinations;
}

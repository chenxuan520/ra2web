import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(process.env.APP_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const dataDir = resolve(process.env.DATA_DIR ?? '/data');
const pvpgnPrefix = resolve(process.env.PVPGN_PREFIX ?? '/opt/pvpgn');
const assetDir = resolve(process.env.ASSET_DIR ?? join(dataDir, 'cdn'));
const archiveUrl = process.env.GAME_RES_ARCHIVE_URL ?? 'https://download.ra2web.com/full-pack.7z';
const archiveSha256 = process.env.GAME_RES_SHA256 ?? '541828fa48f31059eb5edb127b07253515c8f92adeaa1f0fd0b84d6ffa6656f3';

const children: { process: ReturnType<typeof Bun.spawn>; signal: 'SIGQUIT' | 'SIGTERM' }[] = [];
let stopping = false;
async function stop(exitCode: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.process.kill(child.signal);
    const timeout = setTimeout(() => children.forEach(child => child.process.kill('SIGKILL')), 15000);
    await Promise.all(children.map(child => child.process.exited));
    clearTimeout(timeout);
    process.exit(exitCode);
}
process.on('SIGTERM', () => void stop(0));
process.on('SIGINT', () => void stop(0));

async function run(command: string[]): Promise<void> {
    const child = { process: Bun.spawn(command, { cwd: appDir, stdout: 'inherit', stderr: 'inherit' }), signal: 'SIGTERM' as const };
    children.push(child);
    try {
        if (await child.process.exited !== 0) throw new Error(`启动准备失败：${command[0]}`);
    }
    finally {
        children.splice(children.indexOf(child), 1);
    }
}

async function hasGameFiles(directory: string): Promise<boolean> {
    const entries = await readdir(directory).catch(() => [] as string[]);
    return ['ra2.mix', 'language.mix', 'multi.mix'].every(name => entries.some(entry => entry.toLowerCase() === name));
}

async function prepareAssets(): Promise<void> {
    const version = createHash('sha256');
    for (const filename of ['deploy/prepare-resources.ts', 'public/ini.mix', 'public/res/ra2cd.mix']) version.update(await readFile(join(appDir, filename)));
    const currentVersion = version.digest('hex');
    const versionPath = join(assetDir, '.ra2web-resource-version');
    const cachedVersion = await readFile(versionPath, 'utf8').catch(() => '');
    if (cachedVersion === currentVersion && await stat(join(assetDir, 'game-res/v2/manifest.json')).then(() => true, () => false)) {
        return;
    }
    const sourceDir = process.env.GAME_FILES_DIR;
    if (sourceDir && await hasGameFiles(sourceDir)) {
        await run([process.execPath, join(appDir, 'deploy/prepare-resources.ts'), sourceDir, assetDir]);
        await writeFile(versionPath, currentVersion);
        return;
    }
    if (process.env.AUTO_DOWNLOAD_ASSETS === 'false') {
        console.info('未挂载游戏资源；请通过游戏页面导入本地游戏副本。');
        return;
    }
    console.info('首次启动：下载并校验游戏资源，后续启动使用持久缓存。');
    const downloadDir = join(dataDir, 'resource-import');
    await mkdir(downloadDir, { recursive: true });
    const archivePath = join(downloadDir, 'game.7z');
    const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) {
        throw new Error(`游戏资源下载失败：HTTP ${response.status}`);
    }
    const archive = new Uint8Array(await response.arrayBuffer());
    if (createHash('sha256').update(archive).digest('hex') !== archiveSha256.toLowerCase()) {
        throw new Error('游戏资源 SHA-256 校验失败；请挂载兼容的本地游戏副本。');
    }
    await writeFile(archivePath, archive);
    const filesDir = join(downloadDir, 'files');
    await mkdir(filesDir, { recursive: true });
    await run(['7z', 'x', '-y', `-o${filesDir}`, archivePath, '*.mix', '*.MIX', '*.mmx', '*.MMX']);
    if (!await hasGameFiles(filesDir)) {
        throw new Error('资源包缺少 ra2.mix、language.mix 或 multi.mix。');
    }
    await run([process.execPath, join(appDir, 'deploy/prepare-resources.ts'), filesDir, assetDir]);
    await writeFile(versionPath, currentVersion);
    await rm(downloadDir, { recursive: true, force: true });
}

async function prepareConfig(): Promise<string> {
    const stateDir = join(dataDir, 'pvpgn');
    await mkdir(stateDir, { recursive: true });
    await cp(join(pvpgnPrefix, 'var/pvpgn'), stateDir, { recursive: true, force: false, errorOnExist: false });
    const template = await readFile(join(pvpgnPrefix, 'etc/pvpgn/bnetd.conf'), 'utf8');
    let config = template.replaceAll(join(pvpgnPrefix, 'var/pvpgn'), stateDir);
    const settings: Record<string, string> = {
        servaddrs: '""',
        w3routeaddr: '""',
        wolv1addrs: '""',
        wolv2addrs: `"127.0.0.1:${process.env.PVPGN_PORT ?? '4005'}"`,
        ircaddrs: '""',
        telnetaddrs: '""',
        apiregaddrs: '""',
        wgameresaddrs: '""',
        new_accounts: 'true',
        auto_create_account: 'true',
        quota_min_games: '0',
        quota_min_acc_age: '0',
        quota_lines: '20',
        quota_dobae: '30',
        quota_wrapline: '200',
        quota_maxline: '200',
        quota_time: '5',
        sync_on_logoff: 'true',
        shutdown_delay: '0',
        track: '0',
        loglevels: 'fatal,error,warn,info',
    };
    for (const [key, value] of Object.entries(settings)) {
        config = config.replace(new RegExp(`^\\s*${key}\\s*=.*$`, 'gm'), '');
        config += `\n${key} = ${value}\n`;
    }
    const configPath = join(stateDir, 'bnetd.conf');
    await writeFile(configPath, config, { mode: 0o600 });
    return configPath;
}

await mkdir(dataDir, { recursive: true });
await prepareAssets();
const configPath = await prepareConfig();
children.push(
    { process: Bun.spawn([join(pvpgnPrefix, 'sbin/bnetd'), '-f', '-c', configPath], { stdout: 'inherit', stderr: 'inherit' }), signal: 'SIGQUIT' },
    { process: Bun.spawn([process.execPath, join(appDir, 'server/index.ts')], {
        cwd: appDir,
        env: { ...process.env, ASSET_DIR: assetDir, PVPGN_HOST: '127.0.0.1' },
        stdout: 'inherit',
        stderr: 'inherit',
    }), signal: 'SIGTERM' },
);
for (const child of children) {
    void child.process.exited.then(code => stop(code || 1));
}
console.info(`RA2WEB 已启动：前端与联机服务共用端口 ${process.env.HTTP_PORT ?? '8080'}。`);

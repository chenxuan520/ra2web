import { describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { Crc32 } from '../../data/Crc32';
import { DataStream } from '../../data/DataStream';
import { Blowfish } from '../../data/encoding/Blowfish';
import { BlowfishKey } from '../../data/encoding/BlowfishKey';
import { IniFile } from '../../data/IniFile';
import { MapFile } from '../../data/MapFile';
import { MixEntry } from '../../data/MixEntry';
import { RealFileSystem } from '../../data/vfs/RealFileSystem';
import { VirtualFile } from '../../data/vfs/VirtualFile';
import { VirtualFileSystem } from '../../data/vfs/VirtualFileSystem';
import { buildMix, encodePng, prepareBundledResources, prepareResourceData, prepareResources, readMix, validateAudio, verifySourceChecksum } from '../../../deploy/prepare-resources';
import { MapDigest } from '../../engine/MapDigest';
import { MapList } from '../../engine/MapList';
import { resourceConfigs, ResourceType } from '../../engine/resourceConfigs';
import { GameModes } from '../../game/ini/GameModes';
import { fixtureMix, fixtureSources } from './fixtures';

const logger = { info() {}, warn() {}, error() {} };

function outputVfs(files: Map<string, Uint8Array>): VirtualFileSystem {
    const vfs = new VirtualFileSystem(new RealFileSystem(), logger);
    for (const [name, bytes] of files) {
        if (name.endsWith('.mix')) vfs.addArchive(readMix(name, bytes).mix, name);
    }
    return vfs;
}

async function packBundle(source: string, archive: string): Promise<void> {
    await rm(archive, { force: true });
    const child = Bun.spawn(['7z', 'a', '-t7z', '-mx=1', '-snl', archive, 'game-res', 'maps'], { cwd: source, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Fixture 7z creation failed: ${stderr}`);
}

async function withBundledFixture(run: (fixture: { source: string; output: string; archive: string; files: Map<string, Uint8Array> }) => Promise<void>): Promise<void> {
    const root = await mkdtemp('/tmp/opencode/ra2-bundled-fixture-');
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Bundled preparation must not fetch'); });
    try {
        const source = join(root, 'source');
        const output = join(root, 'cdn');
        const archive = join(root, 'game-res.7z');
        const { files } = await prepareResourceData(fixtureSources());
        for (const [name, bytes] of files) {
            await mkdir(dirname(join(source, name)), { recursive: true });
            await writeFile(join(source, name), bytes);
        }
        await packBundle(source, archive);
        await run({ source, output, archive, files });
        expect(fetch).not.toHaveBeenCalled();
    }
    finally {
        fetch.mockRestore();
        await rm(root, { recursive: true, force: true });
    }
}

const bundledMarker = '.ra2web-bundled-sha256';

describe('bundled resource preparation', () => {
    test('extracts once and validates the SHA cache without fetching or rewriting files', async () => {
        await withBundledFixture(async ({ output, archive, files }) => {
            const first = await prepareBundledResources(output, archive);
            expect(first.cached).toBe(false);
            expect(first.outputFolder).toBe(output);
            expect(first.files.length).toBe(files.size);
            expect(first.totalBytes).toBe([...files.values()].reduce((sum, bytes) => sum + bytes.length, 0));
            expect(first.mapNames).toEqual(['fixture.map', 'snowfixture.mpr', 'urbanfixture.map']);
            expect(first.archiveSha256).toBe(createHash('sha256').update(await readFile(archive)).digest('hex'));
            expect(await readFile(join(output, bundledMarker), 'utf8')).toBe(first.archiveSha256);
            const manifest = JSON.parse(await readFile(join(output, 'game-res/v2/manifest.json'), 'utf8'));
            const mixNames = [...resourceConfigs].filter(([type]) => type < ResourceType.HalloweenMix).map(([, config]) => config.src);
            expect(mixNames).toHaveLength(21);
            expect(Object.keys(manifest.checksums).sort()).toEqual(mixNames.sort());
            for (const [name, bytes] of files) {
                expect(await readFile(join(output, name))).toEqual(Buffer.from(bytes));
                if (name.endsWith('.mix')) {
                    const crc = manifest.checksums[name.slice('game-res/v2/'.length)];
                    expect(typeof crc).toBe('number');
                    expect(Crc32.calculateCrc(bytes)).toBe(crc);
                }
            }
            const mix = await stat(join(output, 'game-res/v2/ui.mix'));
            const marker = await stat(join(output, bundledMarker));
            const decode = spyOn(DataStream.prototype, 'readUint16');
            try {
                const cached = await prepareBundledResources(output, archive);
                expect(cached).toEqual({ ...first, cached: true });
                expect(decode).not.toHaveBeenCalled();
                expect((await stat(join(output, 'game-res/v2/ui.mix'))).ino).toBe(mix.ino);
                expect((await stat(join(output, bundledMarker))).ino).toBe(marker.ino);
            }
            finally {
                decode.mockRestore();
            }
        });
    });

    test('adopting bundled resources clears conflicting raw-source cache markers on extraction and cache reuse', async () => {
        await withBundledFixture(async ({ output, archive }) => {
            const rawMarker = join(output, '.ra2web-resource-version');
            await mkdir(output, { recursive: true });
            await writeFile(rawMarker, 'raw-source-version');
            expect((await prepareBundledResources(output, archive)).cached).toBe(false);
            await expect(lstat(rawMarker)).rejects.toMatchObject({ code: 'ENOENT' });
            await writeFile(rawMarker, 'raw-source-version');
            expect((await prepareBundledResources(output, archive)).cached).toBe(true);
            await expect(lstat(rawMarker)).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    test('refreshes prepared files when the local archive SHA changes', async () => {
        await withBundledFixture(async ({ source, output, archive, files }) => {
            const first = await prepareBundledResources(output, archive);
            const mix = readMix('ui.mix', files.get('game-res/v2/ui.mix')!);
            mix.entries.set(MixEntry.hashFilename('bundle-update.ini'), new TextEncoder().encode('[Bundle]\nVersion=2\n'));
            const updated = buildMix(mix.entries);
            await writeFile(join(source, 'game-res/v2/ui.mix'), updated);
            const manifest = JSON.parse(new TextDecoder().decode(files.get('game-res/v2/manifest.json')));
            manifest.checksums['ui.mix'] = Crc32.calculateCrc(updated);
            await writeFile(join(source, 'game-res/v2/manifest.json'), JSON.stringify(manifest));
            await packBundle(source, archive);
            const refreshed = await prepareBundledResources(output, archive);
            expect(refreshed.cached).toBe(false);
            expect(refreshed.archiveSha256).not.toBe(first.archiveSha256);
            expect(await readFile(join(output, 'game-res/v2/ui.mix'))).toEqual(Buffer.from(updated));
            expect(await readFile(join(output, bundledMarker), 'utf8')).toBe(refreshed.archiveSha256);
            expect((await prepareBundledResources(output, archive)).cached).toBe(true);
        });
    });

    test('repairs missing required files and same-size CRC damage from the local archive', async () => {
        await withBundledFixture(async ({ output, archive, files }) => {
            await prepareBundledResources(output, archive);
            await rm(join(output, bundledMarker));
            expect((await prepareBundledResources(output, archive)).cached).toBe(false);
            for (const name of ['game-res/v2/ui.mix', 'maps/fixture.map', 'maps/missions.pkt', 'game-res/v2/glsl.png', 'game-res/v2/manifest.json', 'maps/manifest.json']) {
                await rm(join(output, name));
                expect((await prepareBundledResources(output, archive)).cached).toBe(false);
                expect(await readFile(join(output, name))).toEqual(Buffer.from(files.get(name)!));
            }
            const mixNames = [...resourceConfigs].filter(([type]) => type < ResourceType.HalloweenMix).map(([, config]) => `game-res/v2/${config.src}`);
            expect(mixNames).toHaveLength(21);
            for (const name of [...mixNames, 'maps/fixture.map', 'game-res/v2/ls/ls800ustates.png']) {
                const damaged = Uint8Array.from(files.get(name)!);
                damaged[damaged.length - 1] ^= 1;
                await writeFile(join(output, name), damaged);
                expect((await prepareBundledResources(output, archive)).cached).toBe(false);
                expect(await readFile(join(output, name))).toEqual(Buffer.from(files.get(name)!));
            }
            expect((await prepareBundledResources(output, archive)).cached).toBe(true);
        });
    });

    test('fails on a corrupt archive without retaining or writing a cache marker', async () => {
        await withBundledFixture(async ({ output, archive, files }) => {
            await prepareBundledResources(output, archive);
            const original = await readFile(archive);
            const damaged = Uint8Array.from(original);
            damaged[32] ^= 1;
            for (const bytes of [original.subarray(0, original.length - 20), damaged]) {
                await writeFile(archive, bytes);
                await expect(prepareBundledResources(output, archive)).rejects.toThrow();
                await expect(lstat(join(output, bundledMarker))).rejects.toMatchObject({ code: 'ENOENT' });
                expect(await readFile(join(output, 'game-res/v2/ui.mix'))).toEqual(Buffer.from(files.get('game-res/v2/ui.mix')!));
                await writeFile(archive, original);
                expect((await prepareBundledResources(output, archive)).cached).toBe(false);
            }
        });
    });

    test('requires version 2 MIX manifests, numeric matching CRCs and valid map filenames, digests and sizes', async () => {
        await withBundledFixture(async ({ source, output, archive, files }) => {
            const manifest = JSON.parse(new TextDecoder().decode(files.get('game-res/v2/manifest.json')));
            const maps = JSON.parse(new TextDecoder().decode(files.get('maps/manifest.json')));
            const missingCrc = { ...manifest.checksums };
            delete missingCrc['ui.mix'];
            const invalid = [
                ['game-res/v2/manifest.json', { ...manifest, version: 1 }],
                ['game-res/v2/manifest.json', { ...manifest, format: 'zip' }],
                ['game-res/v2/manifest.json', { ...manifest, checksums: missingCrc }],
                ['game-res/v2/manifest.json', { ...manifest, checksums: { ...manifest.checksums, 'expandspawn09.mix': 0 } }],
                ['game-res/v2/manifest.json', { ...manifest, checksums: { ...manifest.checksums, 'ui.mix': String(manifest.checksums['ui.mix']) } }],
                ['game-res/v2/manifest.json', { ...manifest, checksums: { ...manifest.checksums, 'ui.mix': 0 } }],
                ['maps/manifest.json', { ...maps, maps: [{ ...maps.maps[0], fileName: '../escape.map' }] }],
                ['maps/manifest.json', { ...maps, maps: maps.maps.map((map, index) => index ? map : { ...map, digest: '0' }) }],
                ['maps/manifest.json', { ...maps, maps: maps.maps.map((map, index) => index ? map : { ...map, size: map.size + 1 }) }],
            ] as const;
            for (const [name, content] of invalid) {
                await writeFile(join(source, name), JSON.stringify(content));
                await packBundle(source, archive);
                await expect(prepareBundledResources(output, archive)).rejects.toThrow();
                await expect(lstat(join(output, bundledMarker))).rejects.toMatchObject({ code: 'ENOENT' });
                await writeFile(join(source, name), files.get(name)!);
            }
        });
    });

    test('repairs symlink cache files, directories and markers without modifying their targets', async () => {
        await withBundledFixture(async ({ source, output, archive, files }) => {
            await prepareBundledResources(output, archive);
            await rm(join(output, 'game-res/v2/ui.mix'));
            await symlink(join(source, 'game-res/v2/ui.mix'), join(output, 'game-res/v2/ui.mix'));
            expect((await prepareBundledResources(output, archive)).cached).toBe(false);
            expect((await lstat(join(output, 'game-res/v2/ui.mix'))).isSymbolicLink()).toBe(false);
            expect(await readFile(join(source, 'game-res/v2/ui.mix'))).toEqual(Buffer.from(files.get('game-res/v2/ui.mix')!));
            await rm(join(output, 'maps'), { recursive: true });
            await symlink(join(source, 'maps'), join(output, 'maps'), 'dir');
            expect((await prepareBundledResources(output, archive)).cached).toBe(false);
            expect((await lstat(join(output, 'maps'))).isSymbolicLink()).toBe(false);
            expect(await readFile(join(source, 'maps/fixture.map'))).toEqual(Buffer.from(files.get('maps/fixture.map')!));
            await writeFile(join(source, 'keep.txt'), 'untouched');
            await rm(join(output, bundledMarker));
            await symlink(join(source, 'keep.txt'), join(output, bundledMarker));
            expect((await prepareBundledResources(output, archive)).cached).toBe(false);
            expect(await readFile(join(source, 'keep.txt'), 'utf8')).toBe('untouched');
        });
    });

    test('reports a missing system 7z clearly without fetching or writing a marker', async () => {
        await withBundledFixture(async ({ output, archive }) => {
            const which = spyOn(Bun, 'which').mockReturnValue(null);
            try {
                await expect(prepareBundledResources(output, archive)).rejects.toThrow('require system 7z');
                await expect(lstat(join(output, bundledMarker))).rejects.toMatchObject({ code: 'ENOENT' });
            }
            finally {
                which.mockRestore();
            }
        });
    });

    test('rejects unexpected archive paths and symlink entries before publishing resources', async () => {
        await withBundledFixture(async ({ source, output, archive }) => {
            const unexpected = join(source, 'maps/..escape.map');
            await writeFile(unexpected, 'unsafe');
            await packBundle(source, archive);
            await expect(prepareBundledResources(output, archive)).rejects.toThrow('Unsafe bundled entry');
            await expect(lstat(join(output, bundledMarker))).rejects.toMatchObject({ code: 'ENOENT' });
            await rm(unexpected);
            await rm(join(source, 'game-res/v2/ui.mix'));
            await symlink(join(source, 'maps/fixture.map'), join(source, 'game-res/v2/ui.mix'));
            await packBundle(source, archive);
            await expect(prepareBundledResources(output, archive)).rejects.toThrow('Unsafe bundled entry');
            await expect(lstat(join(output, bundledMarker))).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });
});

describe('resource MIX preparation', () => {
    test('builds a deterministic, hash-preserving MIX from sliced data', () => {
        const slice = new Uint8Array([99, 1, 2, 3, 88]).subarray(1, 4);
        const entries = new Map([[MixEntry.hashFilename('TEST.SHP'), slice], [0xFFFFFFFE, new Uint8Array()]]);
        const bytes = buildMix(entries);
        const archive = readMix('fixture.mix', bytes);
        expect(archive.mix.openFile('test.shp').getBytes()).toEqual(new Uint8Array([1, 2, 3]));
        expect(archive.entries.get(0xFFFFFFFE)).toEqual(new Uint8Array());
        expect(buildMix(new Map([...entries].reverse()))).toEqual(bytes);
    });

    test('rejects truncated, duplicate and out-of-bounds indexes and missing checksum trailers', () => {
        const valid = fixtureMix({ 'a.shp': new Uint8Array([1]), 'b.shp': new Uint8Array([2]) });
        expect(() => readMix('bad.mix', valid.subarray(0, 20))).toThrow();
        const invalidOffset = valid.slice();
        new DataView(invalidOffset.buffer).setUint32(14, 999, true);
        expect(() => readMix('bad.mix', invalidOffset)).toThrow('Out-of-bounds');
        const duplicate = valid.slice();
        const duplicateView = new DataView(duplicate.buffer);
        duplicateView.setUint32(22, duplicateView.getUint32(10, true), true);
        expect(() => readMix('bad.mix', duplicate)).toThrow('Invalid MIX index');
        const checked = new Uint8Array(valid.length + 20);
        checked.set(valid);
        new DataView(checked.buffer).setUint32(0, 0x00010000, true);
        checked.set(createHash('sha1').update(valid.subarray(34)).digest(), valid.length);
        expect(readMix('checked.mix', checked).entries.size).toBe(2);
        expect(() => readMix('checked.mix', checked.subarray(0, checked.length - 1))).toThrow('Invalid MIX index or data size');
    });

    test('accepts legacy unencrypted MIX headers without changing filename hashes', () => {
        const westwood = fixtureMix({ 'legacy.shp': new Uint8Array([4, 5]) });
        const archive = readMix('legacy.mix', westwood.subarray(4));
        expect(archive.mix.openFile('LEGACY.SHP').getBytes()).toEqual(new Uint8Array([4, 5]));
    });

    test('validates and flattens an encrypted MIX with existing cipher types', () => {
        const valid = fixtureMix({ 'encrypted.shp': new Uint8Array([7, 8]) });
        const keyBytes = new Uint8Array(80);
        const key = new BlowfishKey().decryptKey(keyBytes);
        const header = new Uint8Array(24);
        header.set(valid.subarray(4, 28));
        const cipher = new Blowfish(key).encrypt(new Uint32Array(header.buffer));
        const encrypted = new Uint8Array(84 + 24 + 2);
        new DataView(encrypted.buffer).setUint32(0, 0x00020000, true);
        encrypted.set(keyBytes, 4);
        encrypted.set(new Uint8Array(cipher.buffer), 84);
        encrypted.set([7, 8], 108);
        const parsed = readMix('encrypted.mix', encrypted);
        expect(parsed.mix.openFile('encrypted.shp').getBytes()).toEqual(new Uint8Array([7, 8]));
        expect(readMix('flat.mix', buildMix(parsed.entries)).mix.openFile('encrypted.shp').getBytes()).toEqual(new Uint8Array([7, 8]));
    });

    test('keeps source CRC validation strict', () => {
        expect(() => verifySourceChecksum('RA2.MIX', new Uint8Array([1]))).toThrow('Unsupported or damaged');
        expect(() => verifySourceChecksum('MULTI.MIX', new Uint8Array([2]))).toThrow('Unsupported or damaged');
        expect(verifySourceChecksum('language.mix', new Uint8Array([1]))).toBe(Crc32.calculateCrc(new Uint8Array([1])));
    });

    test('prepares every existing CDN resource without duplicating full archives', async () => {
        const result = await prepareResourceData(fixtureSources());
        const manifest = JSON.parse(new TextDecoder().decode(result.files.get('game-res/v2/manifest.json')));
        expect(manifest.version).toBe(2);
        expect(manifest.format).toBe('mix');
        for (const [type, config] of resourceConfigs) {
            if (type >= ResourceType.HalloweenMix) continue;
            const bytes = result.files.get(`game-res/v2/${config.src}`)!;
            expect(bytes).toBeDefined();
            expect(typeof manifest.checksums[config.src]).toBe('number');
            expect(Crc32.calculateCrc(bytes)).toBe(manifest.checksums[config.src]);
            expect(() => readMix(config.src, bytes)).not.toThrow();
        }
        const vfs = outputVfs(result.files);
        expect(new IniFile(vfs.openFile('rules.ini')).getSection('Fixture')?.getString('Owner')).toBe('local');
        expect(new IniFile(vfs.openFile('ui.ini')).getSection('Fixture')?.getString('Owner')).toBe('custom');
        expect(vfs.openFile('duplicate.shp').getSize()).toBe(33);
        expect(readMix('vxl.mix', result.files.get('game-res/v2/vxl.mix')!).mix.containsFile('tank.hva')).toBe(true);
        expect(readMix('vxl.mix', result.files.get('game-res/v2/vxl.mix')!).mix.containsFile('tank.vxl')).toBe(true);
        expect(readMix('eva-ally.mix', result.files.get('game-res/v2/eva-ally.mix')!).mix.containsFile('ally.wav')).toBe(true);
        expect(readMix('eva-sov.mix', result.files.get('game-res/v2/eva-sov.mix')!).mix.containsFile('sov.wav')).toBe(true);
        expect(readMix('sounds.mix', result.files.get('game-res/v2/sounds.mix')!).mix.containsFile('ally.wav')).toBe(false);
        validateAudio(vfs);
        expect(result.files.get('game-res/v2/glsl.png')).toBeDefined();
        expect(result.files.get('game-res/v2/ls/ls800ustates.png')).toBeDefined();
        expect(result.files.get('game-res/v2/ls/ls800obs.png')).toBeDefined();
        expect([...result.files.keys()].some(name => name.endsWith('ra2.mix') || name.endsWith('language.mix') || name.endsWith('multi.mix'))).toBe(false);
        const repeated = await prepareResourceData(fixtureSources());
        expect([...repeated.files]).toEqual([...result.files]);
    });

    test('exports only available maps with the exact client packet and digest contract', async () => {
        const result = await prepareResourceData(fixtureSources());
        expect(result.maps.map(map => map.fileName)).toEqual(['fixture.map', 'snowfixture.mpr', 'urbanfixture.map']);
        expect(result.maps.map(map => map.theater)).toEqual(['Temperate', 'Snow', 'Urban']);
        const vfs = outputVfs(result.files);
        const modes = new GameModes(new IniFile(vfs.openFile('mpmodescd.ini')), name => new IniFile(vfs.openFile(name)));
        const maps = new MapList(modes).addFromIni(new IniFile(vfs.openFile('missions.pkt'))).getAll();
        expect(maps.map(map => map.fileName)).toEqual(result.maps.map(map => map.fileName));
        for (const map of result.maps) {
            const bytes = result.files.get(`maps/${map.fileName}`)!;
            const file = VirtualFile.fromBytes(bytes, map.fileName);
            expect(MapDigest.compute(file)).toBe(map.digest);
            expect(new MapFile().fromVirtualFile(file).getSection('Map')).toBeDefined();
        }
    });

    test('includes MMX packet maps and resolves .mpr contents for .map requests', async () => {
        const sources = fixtureSources();
        const main = readMix('multi.mix', sources.get('MULTI.MIX')!);
        sources.set('BONUS.MMX', fixtureMix({ 'bonus.pkt': '[MultiMaps]\n1=bonus\n[bonus]\nDescription=NOSTR:Bonus\nMaxPlayers=2\nGameMode=standard\n', 'bonus.mpr': main.mix.openFile('fixture.map').getBytes() }));
        const result = await prepareResourceData(sources);
        expect(result.maps.at(-1)?.fileName).toBe('bonus.map');
        expect(result.files.get('maps/bonus.map')).toEqual(main.mix.openFile('fixture.map').getBytes());
    });

    test('stores shared EVA sounds once while keeping both side-specific mixes', async () => {
        const sources = fixtureSources();
        const appIni = readMix('ini.mix', sources.get('ini.mix')!);
        appIni.entries.set(MixEntry.hashFilename('eva.ini'), new TextEncoder().encode('[EVA]\nAllied=shared\nRussian=shared\n'));
        sources.set('ini.mix', buildMix(appIni.entries));
        const language = readMix('language.mix', sources.get('LANGUAGE.MIX')!);
        const audio = readMix('audio.mix', language.mix.openFile('audio.mix').getBytes());
        audio.entries.set(MixEntry.hashFilename('shared.wav'), new Uint8Array([7]));
        sources.set('audio.mix', buildMix(audio.entries));
        const result = await prepareResourceData(sources);
        expect(readMix('sounds.mix', result.files.get('game-res/v2/sounds.mix')!).mix.containsFile('shared.wav')).toBe(true);
        expect(readMix('eva-ally.mix', result.files.get('game-res/v2/eva-ally.mix')!).mix.containsFile('shared.wav')).toBe(false);
        expect(readMix('eva-sov.mix', result.files.get('game-res/v2/eva-sov.mix')!).mix.containsFile('shared.wav')).toBe(false);
    });

    test('preserves direct startup WAV priority instead of replacing it with BAG audio', async () => {
        const sources = fixtureSources();
        const initial = await prepareResourceData(sources);
        const wav = readMix('ui.mix', initial.files.get('game-res/v2/ui.mix')!).mix.openFile('uslide1.wav').getBytes().slice();
        wav[wav.length - 1] ^= 1;
        const language = readMix('language.mix', sources.get('LANGUAGE.MIX')!);
        const audio = readMix('audio.mix', language.mix.openFile('audio.mix').getBytes());
        audio.entries.set(MixEntry.hashFilename('uslide1.wav'), wav);
        sources.set('audio.mix', buildMix(audio.entries));
        const result = await prepareResourceData(sources);
        expect(readMix('ui.mix', result.files.get('game-res/v2/ui.mix')!).mix.openFile('uslide1.wav').getBytes()).toEqual(wav);
    });

    test('rejects a configured startup WAV missing from both MIX and BAG', async () => {
        const sources = fixtureSources();
        const appIni = readMix('ini.mix', sources.get('ini.mix')!);
        appIni.entries.set(MixEntry.hashFilename('sound.ini'), new TextEncoder().encode('[Defaults]\nType=Global\n[SoundList]\n0=uslide1\n[uslide1]\nSounds=missingstartup\n'));
        sources.set('ini.mix', buildMix(appIni.entries));
        await expect(prepareResourceData(sources)).rejects.toThrow('Missing startup sound spec');
        appIni.entries.set(MixEntry.hashFilename('sound.ini'), new TextEncoder().encode('[Defaults]\nType=Global\n[SoundList]\n' + ['uslide1', 'uslide2', 'umenucl1', 'uacbopen', 'umessage', 'umenscol'].map((name, index) => `${index}=${name}`).join('\n') + '\n' + ['uslide1', 'uslide2', 'umenucl1', 'uacbopen', 'umessage', 'umenscol'].map(name => `[${name}]\nSounds=${name === 'uslide1' ? 'missingstartup' : name}\n`).join('')));
        sources.set('ini.mix', buildMix(appIni.entries));
        await expect(prepareResourceData(sources)).rejects.toThrow('Missing startup sound file: missingstartup.wav');
    });

    test('rejects missing nested MIX files and invalid audio bounds', async () => {
        const missing = fixtureSources();
        missing.set('RA2.MIX', fixtureMix({}));
        await expect(prepareResourceData(missing)).rejects.toThrow('Missing nested MIX');
        const invalid = fixtureSources();
        const audio = fixtureMix({ 'audio.idx': new Uint8Array([71, 65, 66, 65, 2, 0, 0, 0, 1, 0, 0, 0]), 'audio.bag': new Uint8Array() });
        invalid.set('audio.mix', audio);
        await expect(prepareResourceData(invalid)).rejects.toThrow('Invalid audio.idx size');
    });

    test('writes PNG chunks with numeric CRC and reversible RGBA scanlines', () => {
        const rgba = new Uint8Array([252, 0, 0, 255, 0, 0, 0, 0]);
        const png = encodePng(2, 1, rgba);
        expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
        let position = 8;
        const compressed = [];
        while (position < png.length) {
            const length = view.getUint32(position);
            const type = new TextDecoder().decode(png.subarray(position + 4, position + 8));
            expect(Crc32.calculateCrc(png.subarray(position + 4, position + 8 + length))).toBe(view.getUint32(position + 8 + length));
            if (type === 'IDAT') compressed.push(png.subarray(position + 8, position + 8 + length));
            position += length + 12;
        }
        expect(new Uint8Array(inflateSync(Buffer.concat(compressed)))).toEqual(new Uint8Array([0, ...rgba]));
    });

    test('rejects output overlapping sources before writing', async () => {
        const source = await mkdtemp('/tmp/opencode/ra2-resource-overlap-');
        try {
            await writeFile(`${source}/keep.txt`, 'untouched');
            await expect(prepareResources(source, `${source}/cdn`)).rejects.toThrow('Output folder must not be inside');
            expect(await readFile(`${source}/keep.txt`, 'utf8')).toBe('untouched');
            await symlink(source, `${source}-alias`, 'dir');
            await expect(prepareResources(source, `${source}-alias/cdn`)).rejects.toThrow('Output folder must not be inside');
            await symlink(`${source}/missing`, `${source}-dangling`, 'dir');
            await expect(prepareResources(source, `${source}-dangling/cdn`)).rejects.toThrow('Output entry must not be a symbolic link');
        }
        finally {
            await rm(`${source}-dangling`, { force: true });
            await rm(`${source}-alias`, { force: true });
            await rm(source, { recursive: true, force: true });
        }
    });
});

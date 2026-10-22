import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import { buildMix, encodePng, prepareResourceData, prepareResources, readMix, validateAudio, verifySourceChecksum } from '../../../deploy/prepare-resources';
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

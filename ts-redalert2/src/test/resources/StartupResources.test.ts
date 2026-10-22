import { expect, spyOn, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IniFile } from '../../data/IniFile';
import { Palette } from '../../data/Palette';
import { PcxFile } from '../../data/PcxFile';
import { ShpFile } from '../../data/ShpFile';
import { IdxFile } from '../../data/IdxFile';
import { WaveFile } from '@ra2web/wavefile';
import { AudioBagFile } from '../../data/AudioBagFile';
import { RealFileSystem } from '../../data/vfs/RealFileSystem';
import { VirtualFileSystem } from '../../data/vfs/VirtualFileSystem';
import { Engine } from '../../engine/Engine';
import { GameRes } from '../../engine/gameRes/GameRes';
import { GameResConfig } from '../../engine/gameRes/GameResConfig';
import { GameResSource } from '../../engine/gameRes/GameResSource';
import { SoundKey } from '../../engine/sound/SoundKey';
import { Sound } from '../../engine/sound/Sound';
import { ChannelType } from '../../engine/sound/ChannelType';
import { SoundSpecs } from '../../engine/sound/SoundSpecs';
import { resourceConfigs, ResourceType } from '../../engine/resourceConfigs';
import { prepareResourceData, readMix } from '../../../deploy/prepare-resources';
import { fixtureSources } from './fixtures';

const logger = { info() {}, warn() {}, error() {} };
const coreMixNames = ['ini.mix', 'ui.mix', 'strings.mix'];
const menuImages = ['mnscrnl.shp', 'lwscrnl.shp', 'sdtp.shp', 'sdwrnanm.shp', 'sdwrntmp.shp', 'sdbtnbkgd.shp', 'sdbtnanm.shp', 'sdbtm.shp', 'sdmpbtn.shp', 'mouse.shp', 'pudlgbgn.shp', 'mnbttn.shp'];
const menuPalettes = ['shell.pal', 'shell2.pal', 'sdbtnanm.pal', 'mousepal.pal', 'dialog.pal', 'mainbttn.pal'];
const cssImages = ['cue_i.pcx', 'cce_i.pcx', 'cce_il.pcx', 'cce_ir.pcx', 'wouref.pcx', 'wodref.pcx', 'wouact.pcx', 'wodact.pcx', 'dnarrowr.pcx', 'dnarrowp.pcx', 'uparrowr.pcx', 'uparrowp.pcx', 'sbgript.pcx', 'sbgripm.pcx', 'sbgripb.pcx', 'trakgrip.pcx'];
const menuSoundKeys = [SoundKey.GUIMoveInSound, SoundKey.GUIMoveOutSound, SoundKey.GUIMainButtonSound, SoundKey.GenericClick, SoundKey.GUICheckboxSound, SoundKey.GUIComboOpenSound, SoundKey.IncomingMessage, SoundKey.PlayerJoined, SoundKey.PlayerLeft];

function menuWavNames(vfs: VirtualFileSystem): string[] {
    const rules = new IniFile(vfs.openFile('rules.ini')).getSection('AudioVisual')!;
    const specs = new SoundSpecs(new IniFile(vfs.openFile('sound.ini')));
    const names = new Set<string>();
    for (const key of menuSoundKeys) {
        const soundName = rules.getString(SoundKey[key]);
        if (!soundName) continue;
        const spec = specs.getSpec(soundName);
        expect(spec, soundName).toBeDefined();
        for (const name of spec!.sounds) names.add(`${name}.wav`);
    }
    console.log(JSON.stringify({ menuSoundMappings: menuSoundKeys.map(key => ({ key: SoundKey[key], spec: rules.getString(SoundKey[key]), sounds: specs.getSpec(rules.getString(SoundKey[key]))?.sounds })), startupWavNames: [...names] }));
    return [...names];
}

function assertMenuAudio(vfs: VirtualFileSystem) {
    Engine.sounds.clearAll();
    Engine.sounds.setVfs(vfs);
    const names = menuWavNames(vfs);
    let totalBytes = 0;
    try {
        expect(vfs.fileExists('audio.bag')).toBe(false);
        expect(vfs.fileExists('audio.idx')).toBe(false);
        for (const name of names) {
            const wav = Engine.getSounds().get(name);
            expect(wav, name).toBeDefined();
            expect(vfs.debugListFileOwners(name), name).toEqual(['ui.mix']);
            const raw = wav!.getRawData()!;
            expect(new TextDecoder().decode(raw.subarray(0, 4)), name).toBe('RIFF');
            expect(new TextDecoder().decode(raw.subarray(8, 12)), name).toBe('WAVE');
            expect(() => wav!.isRawImaAdpcm(), name).not.toThrow();
            const decoded = wav!.getData();
            const parsed = new WaveFile();
            parsed.fromBuffer(decoded as any);
            expect(parsed.bitDepth, name).toBe('16');
            expect(parsed.getSamples(true).length, name).toBeGreaterThan(0);
            totalBytes += raw.length;
        }
        expect(totalBytes).toBeLessThan(512 * 1024);
        const requested: string[] = [];
        const soundSpecs = new SoundSpecs(new IniFile(vfs.openFile('sound.ini')));
        const audioVisual = new IniFile(vfs.openFile('rules.ini')).getSection('AudioVisual')!;
        const audioFiles = {
            get(name: string) {
                requested.push(name);
                return Engine.getSounds().get(name);
            },
        };
        const played = { isPlaying: () => false, stop() {} };
        const output = {
            initialize() {}, dispose() {},
            playWavFile(wav: { getData(): Uint8Array }) { expect(wav.getData().length).toBeGreaterThan(44); return played; },
            playWavSequence() { return played; },
            playWavLoop() { return played; },
        };
        const sound = new Sound(output, audioFiles, soundSpecs, { ini: audioVisual }, {} as Document);
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        try {
            for (const key of menuSoundKeys) {
                if (audioVisual.getString(SoundKey[key])) expect(sound.play(key, ChannelType.Ui)).toBeDefined();
            }
            expect(errors.mock.calls).toEqual([]);
            expect(new Set(requested)).toEqual(new Set(names));
        }
        finally {
            errors.mockRestore();
        }
        console.log(JSON.stringify({ startupAudioBytes: totalBytes, startupAudioCount: names.length }));
    }
    finally {
        Engine.sounds.clearAll();
    }
    return names;
}

function coreVfs(files: ReadonlyMap<string, Uint8Array>) {
    const vfs = new VirtualFileSystem(new RealFileSystem(), logger);
    for (const name of coreMixNames) vfs.addArchive(readMix(name, files.get(name)!).mix, name);
    return vfs;
}

function assertStartup(vfs: VirtualFileSystem) {
    expect(vfs.listArchives()).toEqual(coreMixNames);
    for (const name of ['shroud.shp', ...menuImages, ...menuPalettes, ...cssImages]) expect(vfs.fileExists(name), name).toBe(true);
    Engine.destroy();
    try {
        Engine.vfs = vfs;
        Engine.iniFiles.setVfs(vfs);
        const log = spyOn(console, 'log').mockImplementation(() => {});
        try {
            expect(() => Engine.loadRules()).not.toThrow();
        }
        finally {
            log.mockRestore();
        }
        expect(Engine.getModHash()).toBeGreaterThanOrEqual(0);
        for (const mode of Engine.getMpModes().getAll()) expect(vfs.fileExists(mode.rulesOverride), mode.rulesOverride).toBe(true);
        expect(new IniFile(vfs.openFile('missions.pkt')).getSection('MultiMaps')).toBeDefined();
    }
    finally {
        Engine.destroy();
    }
}

test('startup core MIX files contain rules hashing, menu, pointer and dialog dependencies without game MIX files', async () => {
    const prepared = await prepareResourceData(fixtureSources());
    const files = new Map(coreMixNames.map(name => [name, prepared.files.get(`game-res/v2/${name}`)!]));
    const vfs = coreVfs(files);
    assertStartup(vfs);
    for (const name of ['shroud.shp', ...menuImages, ...menuPalettes, ...cssImages]) expect(vfs.debugListFileOwners(name), name).toEqual(['ui.mix']);
    for (const name of ['generic.shp', 'neutral.shp', 'anim.shp', 'tank.vxl', 'audio.bag']) expect(vfs.fileExists(name), name).toBe(false);
    assertMenuAudio(vfs);
});

test('CDN startup loads maps and core archives when browser filesystem storage is unavailable', async () => {
    const sources = fixtureSources();
    const prepared = await prepareResourceData(sources);
    const config = new GameResConfig('https://resources.invalid/game-res/v2/');
    config.source = GameResSource.Cdn;
    const gameRes = Object.assign(Object.create(GameRes.prototype), {
        appVersion: 'test', appResPath: 'https://resources.invalid/',
        strings: { get: (key: string) => key }, rootEl: {},
    }) as { loadResources(rfs: undefined, config: GameResConfig, progress: () => void): Promise<unknown>; initUiCssVariables(): Promise<void> };
    const ui = spyOn(gameRes, 'initUiCssVariables').mockResolvedValue(undefined);
    const download = Object.assign(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname.slice(1);
        const bytes = path === 'ra2cd.mix' ? sources.get('ra2cd.mix') : prepared.files.get(path);
        if (!bytes) return new Response('Not found', { status: 404 });
        return new Response(bytes, { headers: { 'Content-Type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
    }, { preconnect: globalThis.fetch.preconnect });
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(download);
    Engine.destroy();
    try {
        await gameRes.loadResources(undefined, config, () => {});
        expect(Engine.rfs).toBeUndefined();
        expect(Engine.vfs?.listArchives()).toEqual(['ra2cd.mix', ...coreMixNames]);
        expect(Engine.getMapList()?.getAll().length).toBe(3);
        expect(ui).toHaveBeenCalledTimes(1);
    }
    finally {
        fetch.mockRestore();
        ui.mockRestore();
        Engine.destroy();
    }
});

const cdnFolder = process.env.RA2_PREPARED_CDN;
(cdnFolder ? test : test.skip)('actual prepared CDN boots Engine rules and all menu assets using only the three startup MIX files', async () => {
    const files = new Map<string, Uint8Array>();
    for (const name of coreMixNames) files.set(name, await readFile(join(cdnFolder!, 'game-res/v2', name)));
    const vfs = coreVfs(files);
    const names = ['shroud.shp', ...menuImages, ...menuPalettes, ...cssImages];
    const missing = names.filter(name => !vfs.fileExists(name));
    expect(missing).toEqual([]);
    assertStartup(vfs);
    for (const name of names) expect(vfs.debugListFileOwners(name), name).toEqual(['ui.mix']);
    for (const type of [ResourceType.BuildGen, ResourceType.Anims]) {
        const name = resourceConfigs.get(type)!.src;
        const gameMix = readMix(name, await readFile(join(cdnFolder!, 'game-res/v2', name)));
        for (const file of names) expect(gameMix.mix.containsFile(file), `${name}/${file}`).toBe(false);
    }
    for (const name of menuImages) {
        const image = new ShpFile(vfs.openFile(name));
        expect(image.width, name).toBeGreaterThan(0);
        expect(image.height, name).toBeGreaterThan(0);
        expect(image.numImages, name).toBeGreaterThan(0);
    }
    for (const name of menuPalettes) expect(new Palette(vfs.openFile(name)).size, name).toBe(256);
    for (const name of cssImages) {
        const image = new PcxFile(vfs.openFile(name));
        expect(image.width, name).toBeGreaterThan(0);
        expect(image.height, name).toBeGreaterThan(0);
    }
    const wavNames = assertMenuAudio(vfs);
    const sourceFolder = process.env.RA2_RESOURCE_SOURCE;
    if (sourceFolder) {
        const language = readMix('language.mix', await readFile(join(sourceFolder, 'LANGUAGE.MIX')));
        const audio = readMix('audio.mix', language.mix.openFile('audio.mix').getBytes());
        const idx = new IdxFile(audio.mix.openFile('audio.idx').stream);
        const rawBag = audio.mix.openFile('audio.bag').getBytes();
        for (const [name] of idx.entries) {
            if (!wavNames.includes(name)) idx.entries.delete(name);
        }
        const wavArchive = await new AudioBagFile().fromVirtualFile(audio.mix.openFile('audio.bag'), idx);
        for (const name of wavNames) {
            const entry = idx.entries.get(name)!;
            const raw = vfs.openFile(name).getBytes();
            expect(Buffer.from(raw).equals(Buffer.from(wavArchive.openFile(name).getBytes())), name).toBe(true);
            const dataOffset = raw[20] === 17 ? 60 : 44;
            expect(Buffer.from(raw.subarray(dataOffset, dataOffset + entry.length)).equals(Buffer.from(rawBag.subarray(entry.offset, entry.offset + entry.length))), name).toBe(true);
        }
    }
    console.log(JSON.stringify({ startupWavs: wavNames }));
}, 120000);

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
import { GameResBoxApi } from '../../gui/component/GameResBoxApi';
import { GameResForm, type GameResFormProps } from '../../gui/component/GameResForm';
import { HtmlReactElement } from '../../gui/HtmlReactElement';
import { GameResImporter } from '../../engine/gameRes/GameResImporter';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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

function initFixture(modName?: string) {
    const root = {};
    const gameRes = Object.assign(Object.create(GameRes.prototype), {
        appConfig: { gameresBaseUrl: 'https://resources.invalid/game-res/v2/' },
        strings: { get: (key: string) => key }, rootEl: {}, viewport: {},
        fsAccessLib: { support: { adapter: {} }, adapters: {} },
        splashScreen: { setLoadingText() {}, setBackgroundImage() {} },
        localPrefs: { getItem: () => undefined }, modName,
    }) as any;
    return { gameRes, rfs: { getRootDirectory: () => root } };
}

test('resource selection presents an explicit server choice and keeps local uploads available', () => {
    const props = { strings: { get: (key: string) => key }, onDownloadArchive() {}, onBrowseFolder() {}, onBrowseArchive() {}, onDrop() {}, onClose() {} } as any;
    const markup = renderToStaticMarkup(React.createElement(GameResForm, { ...props, closable: true }));
    expect(markup).toContain('ts:gameres_use_server');
    expect(markup).toContain('ts:gameres_browse_folder');
    expect(markup).toContain('ts:gameres_browse_archive');
    expect(markup).not.toContain('close-button');
    expect(markup).not.toContain('full-pack.7z');
    const localOnly = renderToStaticMarkup(React.createElement(GameResForm, { ...props, closable: false }));
    expect(localOnly).not.toContain('ts:gameres_use_server');
    expect(localOnly).toContain('ts:gameres_browse_archive');
});

for (const cancellation of ['AbortError', 'empty', 'null'] as const) {
    for (const closable of [true, false]) {
        test(`cancelled archive picker ${cancellation} leaves the ${closable ? 'server/local' : 'local-only'} resource chooser open`, async () => {
            let form!: GameResFormProps;
            const element = {};
            const dialog = { setSize() {}, render() {}, getElement: () => element, unrender() {} };
            const root = { appendChild() {}, contains: () => true, removeChild() {} };
            const fsAccessLib = {
                async polyfillDataTransferItem() {}, async showDirectoryPicker() { return {} as FileSystemDirectoryHandle; },
                async showOpenFilePicker(): Promise<any> {
                    if (cancellation === 'AbortError') throw new DOMException('Cancelled', 'AbortError');
                    return cancellation === 'empty' ? [] : null;
                },
            };
            const factory = spyOn(HtmlReactElement, 'factory').mockImplementation((_component, props: any) => {
                form = props.children.props;
                return dialog as any;
            });
            const unrender = spyOn(dialog, 'unrender');
            const remove = spyOn(root, 'removeChild');
            const picker = spyOn(fsAccessLib, 'showOpenFilePicker');
            try {
                const api = new GameResBoxApi({ value: { x: 0, y: 0, width: 800, height: 600 } } as any, { get: (key: string) => key } as any, root as any, fsAccessLib);
                let resolved = false;
                const selection = api.promptForGameRes(undefined, closable);
                void selection.then(() => { resolved = true; });
                await Promise.resolve();
                await form.onBrowseArchive();
                expect(picker).toHaveBeenCalledTimes(1);
                expect(resolved).toBe(false);
                expect(unrender).not.toHaveBeenCalled();
                expect(remove).not.toHaveBeenCalled();
                const archive = { kind: 'file', name: 'local-game.7z' };
                if (closable) form.onClose!();
                else {
                    picker.mockResolvedValueOnce([archive]);
                    await form.onBrowseArchive();
                }
                expect(await selection).toBe(closable ? undefined : archive);
                expect(unrender).toHaveBeenCalledTimes(1);
                expect(remove).toHaveBeenCalledTimes(1);
            }
            finally { factory.mockRestore(); unrender.mockRestore(); remove.mockRestore(); picker.mockRestore(); }
        });
    }
}

test('an explicit server selection loads the existing CDN without importing an archive or requiring browser storage', async () => {
    const { gameRes } = initFixture();
    const loader = {};
    const prompt = spyOn(GameResBoxApi.prototype, 'promptForGameRes').mockResolvedValue(undefined);
    const load = spyOn(gameRes, 'loadResources').mockResolvedValue(loader);
    const importer = spyOn(GameResImporter.prototype, 'import');
    Engine.destroy();
    try {
        const result = await gameRes.init(undefined, () => { throw new Error('Unexpected load error'); }, () => { throw new Error('Unexpected import error'); });
        expect(prompt.mock.calls).toEqual([[undefined, true]]);
        expect(result.configToPersist.source).toBe(GameResSource.Cdn);
        expect(result.configToPersist.getCdnBaseUrl()).toBe('https://resources.invalid/game-res/v2/');
        expect(result.cdnResLoader).toBe(loader);
        expect(load.mock.calls[0][0]).toBeUndefined();
        expect(importer).not.toHaveBeenCalled();
    }
    finally { prompt.mockRestore(); load.mockRestore(); importer.mockRestore(); Engine.destroy(); }
});

test('a failed server selection falls back to a local resource upload without offering the broken server again', async () => {
    const { gameRes, rfs } = initFixture();
    const localDirectory = { kind: 'directory', name: 'game-files' };
    const prompt = spyOn(GameResBoxApi.prototype, 'promptForGameRes').mockResolvedValueOnce(undefined).mockResolvedValueOnce(localDirectory as any);
    const load = spyOn(gameRes, 'loadResources').mockRejectedValueOnce(new Error('Missing server manifest')).mockResolvedValueOnce(undefined);
    const initRfs = spyOn(Engine, 'initRfs').mockResolvedValue(rfs as any);
    const importer = spyOn(GameResImporter.prototype, 'import').mockResolvedValue(undefined);
    const failures: string[] = [];
    Engine.destroy();
    try {
        const result = await gameRes.init(undefined, (error: Error) => { failures.push(error.message); }, () => { throw new Error('Unexpected import error'); });
        expect(prompt.mock.calls).toEqual([[undefined, true], [undefined, false]]);
        expect(failures).toEqual(['Missing server manifest']);
        expect(result.configToPersist.source).toBe(GameResSource.Local);
        expect(initRfs.mock.calls[0][0]).toBe(localDirectory);
        expect(importer.mock.calls[0][0]).toBe(localDirectory);
    }
    finally { prompt.mockRestore(); load.mockRestore(); initRfs.mockRestore(); importer.mockRestore(); Engine.destroy(); }
});

test('a client archive selection is imported into browser storage rather than fetched from the server', async () => {
    const { gameRes, rfs } = initFixture();
    const archive = { kind: 'file', name: 'local-game.7z' };
    const storage = spyOn(gameRes, 'getBrowserFsHandle').mockResolvedValue(undefined);
    storage.mockResolvedValueOnce(undefined).mockResolvedValueOnce({});
    const initRfs = spyOn(Engine, 'initRfs').mockResolvedValue(rfs as any);
    const files = spyOn(gameRes, 'lookForGameFiles').mockResolvedValue(false);
    const prompt = spyOn(GameResBoxApi.prototype, 'promptForGameRes').mockResolvedValue(archive as any);
    const importer = spyOn(GameResImporter.prototype, 'import').mockResolvedValue(undefined);
    const load = spyOn(gameRes, 'loadResources').mockResolvedValue(undefined);
    Engine.destroy();
    try {
        const result = await gameRes.init(undefined, () => { throw new Error('Unexpected load error'); }, () => { throw new Error('Unexpected import error'); });
        expect(result.configToPersist.source).toBe(GameResSource.Archive);
        expect(importer.mock.calls[0][0]).toBe(archive);
        expect(load.mock.calls[0][1].source).toBe(GameResSource.Archive);
    }
    finally { storage.mockRestore(); initRfs.mockRestore(); files.mockRestore(); prompt.mockRestore(); importer.mockRestore(); load.mockRestore(); Engine.destroy(); }
});

for (const source of [GameResSource.Local, GameResSource.Archive, GameResSource.Cdn]) {
    test(`a saved resource source ${source} is respected without forcing another source selection`, async () => {
        const { gameRes } = initFixture();
        const config = new GameResConfig('https://resources.invalid/game-res/v2/');
        config.source = source;
        const prompt = spyOn(GameResBoxApi.prototype, 'promptForGameRes');
        const load = spyOn(gameRes, 'loadResources').mockResolvedValue(undefined);
        const splash = spyOn(gameRes, 'loadSplashScreenBackground').mockResolvedValue(undefined);
        Engine.destroy();
        try {
            await gameRes.init(config, () => { throw new Error('Unexpected load error'); }, () => { throw new Error('Unexpected import error'); });
            expect(prompt).not.toHaveBeenCalled();
            expect(load.mock.calls[0][1]).toBe(config);
        }
        finally { prompt.mockRestore(); load.mockRestore(); splash.mockRestore(); Engine.destroy(); }
    });
}

test('an installed MOD does not reuse a saved server source instead of compatible local game assets', async () => {
    const { gameRes, rfs } = initFixture('example-mod');
    const saved = new GameResConfig('https://resources.invalid/game-res/v2/');
    saved.source = GameResSource.Cdn;
    const directory = { kind: 'directory', name: 'game-files' };
    const storage = spyOn(gameRes, 'getBrowserFsHandle').mockResolvedValueOnce(undefined).mockResolvedValueOnce({});
    const initRfs = spyOn(Engine, 'initRfs').mockResolvedValue(rfs as any);
    const files = spyOn(gameRes, 'lookForGameFiles').mockResolvedValue(false);
    const modDir = spyOn(Engine, 'getModDir').mockResolvedValue({} as any);
    const mapDir = spyOn(Engine, 'getMapDir').mockResolvedValue(undefined);
    const mod = spyOn(gameRes, 'loadMod').mockResolvedValue({});
    const prompt = spyOn(GameResBoxApi.prototype, 'promptForGameRes').mockResolvedValue(directory as any);
    const load = spyOn(gameRes, 'loadResources').mockResolvedValue(undefined);
    const splash = spyOn(gameRes, 'loadSplashScreenBackground').mockResolvedValue(undefined);
    const importer = spyOn(GameResImporter.prototype, 'import').mockResolvedValue(undefined);
    Engine.destroy();
    try {
        const result = await gameRes.init(saved, () => { throw new Error('Unexpected load error'); }, () => { throw new Error('Unexpected import error'); });
        expect(mod).toHaveBeenCalledTimes(1);
        expect(prompt.mock.calls).toEqual([[undefined, false]]);
        expect(result.configToPersist.source).toBe(GameResSource.Local);
        expect(load.mock.calls[0][1].source).toBe(GameResSource.Local);
        expect(importer.mock.calls[0][0]).toBe(directory);
    }
    finally {
        for (const mock of [storage, initRfs, files, modDir, mapDir, mod, prompt, load, splash, importer]) mock.mockRestore();
        Engine.destroy();
    }
});

test('an obsolete custom CDN failure leaves the current server source available', async () => {
    const { gameRes } = initFixture();
    const saved = new GameResConfig('https://resources.invalid/game-res/v2/');
    saved.source = GameResSource.Cdn;
    saved.cdnUrl = 'https://obsolete.invalid/game-res/v2/';
    const prompt = spyOn(GameResBoxApi.prototype, 'promptForGameRes').mockResolvedValue(undefined);
    const load = spyOn(gameRes, 'loadResources').mockRejectedValueOnce(new Error('Obsolete CDN unavailable')).mockResolvedValueOnce({});
    const splash = spyOn(gameRes, 'loadSplashScreenBackground').mockResolvedValue(undefined);
    const failures: string[] = [];
    Engine.destroy();
    try {
        const result = await gameRes.init(saved, (error: Error) => { failures.push(error.message); }, () => { throw new Error('Unexpected import error'); });
        expect(failures).toEqual(['Obsolete CDN unavailable']);
        expect(prompt.mock.calls).toEqual([[undefined, true]]);
        expect(result.configToPersist.source).toBe(GameResSource.Cdn);
        expect(result.configToPersist.getCdnBaseUrl()).toBe('https://resources.invalid/game-res/v2/');
    }
    finally { prompt.mockRestore(); load.mockRestore(); splash.mockRestore(); Engine.destroy(); }
});

test('a selected MOD only offers local upload and preserves the local import path', async () => {
    const { gameRes, rfs } = initFixture('example-mod');
    const directory = { kind: 'directory', name: 'game-files' };
    const prompt = spyOn(GameResBoxApi.prototype, 'promptForGameRes').mockResolvedValue(directory as any);
    const load = spyOn(gameRes, 'loadResources').mockResolvedValue(undefined);
    const initRfs = spyOn(Engine, 'initRfs').mockResolvedValue(rfs as any);
    const importer = spyOn(GameResImporter.prototype, 'import').mockResolvedValue(undefined);
    Engine.destroy();
    try {
        const result = await gameRes.init(undefined, () => { throw new Error('Unexpected load error'); }, () => { throw new Error('Unexpected import error'); });
        expect(prompt.mock.calls).toEqual([[undefined, false]]);
        expect(result.configToPersist.source).toBe(GameResSource.Local);
        expect(importer.mock.calls[0][0]).toBe(directory);
    }
    finally { prompt.mockRestore(); load.mockRestore(); initRfs.mockRestore(); importer.mockRestore(); Engine.destroy(); }
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

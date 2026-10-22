import { expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Crc32 } from '../../data/Crc32';
import { IniFile } from '../../data/IniFile';
import { MapFile } from '../../data/MapFile';
import { MixEntry } from '../../data/MixEntry';
import { Palette } from '../../data/Palette';
import { PcxFile } from '../../data/PcxFile';
import { ShpFile } from '../../data/ShpFile';
import { TmpFile } from '../../data/TmpFile';
import { VxlFile } from '../../data/VxlFile';
import { HvaFile } from '../../data/HvaFile';
import { WavFile } from '../../data/WavFile';
import { RealFileSystem } from '../../data/vfs/RealFileSystem';
import { VirtualFile } from '../../data/vfs/VirtualFile';
import { VirtualFileSystem } from '../../data/vfs/VirtualFileSystem';
import { CdnResourceLoader } from '../../engine/gameRes/CdnResourceLoader';
import { LazyResourceCollection } from '../../engine/LazyResourceCollection';
import { MapDigest } from '../../engine/MapDigest';
import { ResourceLoader } from '../../engine/ResourceLoader';
import { MapList } from '../../engine/MapList';
import { resourceConfigs, resourcesForPrefetch, ResourceType, theaterSpecificResources } from '../../engine/resourceConfigs';
import { SoundSpecs } from '../../engine/sound/SoundSpecs';
import { TheaterType } from '../../engine/TheaterType';
import { GameModes } from '../../game/ini/GameModes';
import { TileSets } from '../../game/theater/TileSets';
import { prepareResources, readMix, validateAudio } from '../../../deploy/prepare-resources';

const cdnFolder = process.env.RA2_PREPARED_CDN;
const logger = { info() {}, warn() {}, error() {} };
const readOutput = (name: string) => readFile(join(cdnFolder!, name));

(cdnFolder ? test : test.skip)('prepared local CDN satisfies client menu, prefetch, theater, audio and official map contracts', async () => {
    const manifest = JSON.parse(await readOutput('game-res/v2/manifest.json').then(bytes => bytes.toString('utf8')));
    expect(manifest.version).toBe(2);
    expect(manifest.format).toBe('mix');
    const vfs = new VirtualFileSystem(new RealFileSystem(), logger);
    const mixes = new Map<string, ReturnType<typeof readMix>>();
    const resourceTypes = [...new Set([ResourceType.Ini, ResourceType.Ui, ResourceType.Strings, ResourceType.Cameo, ResourceType.EvaAlly, ResourceType.EvaSov, ResourceType.UiAlly, ResourceType.UiSov, ...resourcesForPrefetch])];
    for (const type of resourceTypes) {
        const name = resourceConfigs.get(type)!.src;
        const bytes = await readOutput(`game-res/v2/${name}`);
        expect(typeof manifest.checksums[name]).toBe('number');
        expect(Crc32.calculateCrc(bytes)).toBe(manifest.checksums[name]);
        const mix = readMix(name, bytes);
        mixes.set(name, mix);
        if (!['sidec01.mix', 'sidec02.mix'].includes(name)) vfs.addArchive(mix.mix, name);
    }
    for (const name of ['rules.ini', 'art.ini', 'ai.ini', 'rulescd.ini', 'artcd.ini', 'mpmodescd.ini', 'sound.ini', 'eva.ini', 'ui.ini', 'temperat.ini', 'snow.ini', 'urban.ini', 'ra2.csf', 'cameocd.mix', 'sidec01cd.mix', 'sidec02cd.mix']) expect(vfs.fileExists(name)).toBe(true);
    for (const name of ['mnscrnl.shp', 'lwscrnl.shp', 'sdtp.shp', 'sdwrnanm.shp', 'sdbtnbkgd.shp', 'sdbtnanm.shp', 'sdbtm.shp', 'sdmpbtn.shp', 'pudlgbgn.shp', 'mnbttn.shp']) {
        const shp = new ShpFile(vfs.openFile(name));
        expect(shp.width).toBeGreaterThan(0);
        expect(shp.height).toBeGreaterThan(0);
        expect(shp.numImages).toBeGreaterThan(0);
    }
    for (const name of ['shell.pal', 'shell2.pal', 'sdbtnanm.pal', 'dialog.pal', 'mainbttn.pal']) expect(new Palette(vfs.openFile(name)).size).toBe(256);
    for (const name of ['cue_i.pcx', 'cce_i.pcx', 'cce_il.pcx', 'cce_ir.pcx', 'usai.pcx', 'rusi.pcx']) {
        const image = new PcxFile(vfs.openFile(name));
        expect(image.width).toBeGreaterThan(0);
        expect(image.height).toBeGreaterThan(0);
    }
    for (const type of [ResourceType.UiAlly, ResourceType.UiSov]) {
        const side = mixes.get(resourceConfigs.get(type)!.src)!;
        for (const name of ['sidebar.pal', 'credits.shp', 'radar.shp', 'top.shp', 'gclock2.shp']) expect(side.mix.containsFile(name)).toBe(true);
    }
    expect(new VxlFile(vfs.openFile('mtnk.vxl')).voxelCount).toBeGreaterThan(0);
    expect(new HvaFile(vfs.openFile('mtnk.hva')).sections.length).toBeGreaterThan(0);
    validateAudio(vfs);
    await vfs.addBagFile('audio.bag');
    expect(vfs.hasArchive('audio.bag')).toBe(true);
    const soundNames = new Set(new SoundSpecs(new IniFile(vfs.openFile('sound.ini'))).getAll().flatMap(spec => spec.sounds));
    let decodedSounds = 0;
    for (const sound of soundNames) {
        const name = `${sound}.wav`;
        if (!vfs.fileExists(name)) continue;
        const wav = new WavFile(vfs.openFile(name));
        expect(() => wav.isRawImaAdpcm()).not.toThrow();
        decodedSounds++;
    }
    expect(decodedSounds).toBeGreaterThan(500);
    const modes = new GameModes(new IniFile(vfs.openFile('mpmodescd.ini')), name => new IniFile(vfs.openFile(name)));
    const mapList = new MapList(modes).addFromIni(new IniFile(vfs.openFile('missions.pkt')));
    const mapManifest = JSON.parse(await readOutput('maps/manifest.json').then(bytes => bytes.toString('utf8')));
    expect(mapList.getAll().length).toBe(mapManifest.maps.length);
    const theaters = new Set<TheaterType>();
    const tileSetsByTheater = new Map<TheaterType, TileSets>();
    for (const [type, iniName, extension] of [[TheaterType.Temperate, 'temperat.ini', '.tem'], [TheaterType.Snow, 'snow.ini', '.sno'], [TheaterType.Urban, 'urban.ini', '.urb']] as const) {
        const tiles = new LazyResourceCollection(file => new TmpFile(file));
        tiles.setVfs(vfs);
        const tileSets = new TileSets(new IniFile(vfs.openFile(iniName)));
        tileSets.loadTileData({ get: (name: string) => tiles.has(name) ? tiles.get(name) : undefined }, extension);
        expect(tileSets.readMaxTileNum()).toBeGreaterThan(0);
        tileSetsByTheater.set(type, tileSets);
    }
    for (const map of mapManifest.maps) {
        const bytes = await readOutput(`maps/${map.fileName}`);
        expect(bytes.length).toBe(map.size);
        const file = VirtualFile.fromBytes(bytes, map.fileName);
        expect(MapDigest.compute(file)).toBe(map.digest);
        const parsed = new MapFile().fromVirtualFile(file) as MapFile;
        expect(parsed.startingLocations.length).toBe(map.maxSlots);
        const tileSets = tileSetsByTheater.get(parsed.theaterType)!;
        for (const tileNum of new Set(parsed.tiles.map(tile => tile.tileNum))) expect(tileSets.getTile(tileNum)?.files.length).toBeGreaterThan(0);
        theaters.add(parsed.theaterType);
        for (const type of theaterSpecificResources.get(parsed.theaterType)!) expect(mixes.has(resourceConfigs.get(type)!.src)).toBe(true);
    }
    expect(theaters).toEqual(new Set([TheaterType.Temperate, TheaterType.Snow, TheaterType.Urban]));
    expect(mapList.getByName('mp08t2.map')).toBeDefined();
    expect(mapList.getByName('mp21s2.map')).toBeDefined();
    expect(mapList.getByName('mp29u2.map')).toBeDefined();
    for (const name of ['glsl.png', ...['ustates', 'france', 'germany', 'ukingdom', 'russia', 'cuba', 'libya', 'iraq', 'korea', 'obs'].map(country => `ls/ls800${country}.png`)]) {
        expect(Array.from((await readOutput(`game-res/v2/${name}`)).subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
    const audioMix = mixes.get('sounds.mix')!;
    expect(audioMix.entries.get(MixEntry.hashFilename('audio.idx'))?.length).toBeGreaterThan(12);
    const sourceFolder = process.env.RA2_RESOURCE_SOURCE;
    if (sourceFolder) {
        const fileNames = [...mapManifest.maps.map(map => `maps/${map.fileName}`), 'maps/missions.pkt', 'maps/manifest.json', 'game-res/v2/manifest.json', ...[...mixes.keys()].map(name => `game-res/v2/${name}`), 'game-res/v2/glsl.png', ...['ustates', 'france', 'germany', 'ukingdom', 'russia', 'cuba', 'libya', 'iraq', 'korea', 'obs'].map(country => `game-res/v2/ls/ls800${country}.png`)];
        const hashes = new Map<string, string>();
        for (const name of fileNames) hashes.set(name, createHash('sha256').update(await readOutput(name)).digest('hex'));
        const repeated = await prepareResources(sourceFolder, cdnFolder!);
        expect(repeated.mapNames).toEqual(mapManifest.maps.map(map => map.fileName));
        for (const [name, hash] of hashes) expect(createHash('sha256').update(await readOutput(name)).digest('hex')).toBe(hash);
    }
    console.log(JSON.stringify({ maps: mapManifest.maps.length, mixFiles: mixes.size, decodedSounds, theaters: [...theaters].map(type => TheaterType[type]), cdnFolder }));
}, 120000);

const httpBaseUrl = process.env.RA2_RESOURCE_HTTP_BASE;
(cdnFolder && httpBaseUrl ? test : test.skip)('prepared MIX and maps load through an existing server with the real client HTTP loaders', async () => {
    const baseUrl = new URL('game-res/v2/', httpBaseUrl).href;
    const manifest = await new ResourceLoader(baseUrl).loadJson('manifest.json');
    const loader = new CdnResourceLoader(baseUrl, manifest);
    const names = ['ini.mix', 'ui.mix', 'strings.mix'];
    const configs = await Promise.all(names.map(async name => ({ id: name, src: name, type: 'binary' as const, sizeHint: (await stat(join(cdnFolder!, 'game-res/v2', name))).size })));
    const progress: number[] = [];
    const result = await loader.loadResources(configs, undefined, percent => progress.push(percent));
    for (const name of names) expect(readMix(name, new Uint8Array(result.pop(name))).entries.size).toBeGreaterThan(0);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((percent, index) => index === 0 || percent >= progress[index - 1])).toBe(true);
    expect(progress.at(-1)).toBe(100);
    const map = await new ResourceLoader(new URL('maps/', httpBaseUrl).href).loadBinary('mp08t2.map');
    expect(new MapFile().fromVirtualFile(VirtualFile.fromBytes(map, 'mp08t2.map')).getSection('Map')).toBeDefined();
}, 120000);

import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { AudioBagFile } from '../src/data/AudioBagFile';
import { Crc32 } from '../src/data/Crc32';
import { DataStream } from '../src/data/DataStream';
import { Blowfish } from '../src/data/encoding/Blowfish';
import { BlowfishKey } from '../src/data/encoding/BlowfishKey';
import { IdxFile } from '../src/data/IdxFile';
import { IniFile } from '../src/data/IniFile';
import { MapFile } from '../src/data/MapFile';
import { MixEntry } from '../src/data/MixEntry';
import { MixFile } from '../src/data/MixFile';
import { Palette } from '../src/data/Palette';
import { ShpFile } from '../src/data/ShpFile';
import { RealFileSystem } from '../src/data/vfs/RealFileSystem';
import { VirtualFileSystem } from '../src/data/vfs/VirtualFileSystem';
import { SoundKey } from '../src/engine/sound/SoundKey';
import { SoundSpecs } from '../src/engine/sound/SoundSpecs';
import { ImageUtils } from '../src/engine/gfx/ImageUtils';
import { MapDigest } from '../src/engine/MapDigest';
import { MapList } from '../src/engine/MapList';
import { resourceConfigs, ResourceType } from '../src/engine/resourceConfigs';
import { TheaterType } from '../src/engine/TheaterType';
import { GameModes } from '../src/game/ini/GameModes';

interface ResourceMix {
    name: string;
    bytes: Uint8Array;
    mix: MixFile;
    entries: Map<number, Uint8Array>;
}
interface PreparedMap {
    fileName: string;
    uiName: string;
    maxSlots: number;
    gameModes: number[];
    theater: string;
    digest: string;
    size: number;
}
const logger = { info() {}, warn() {}, error() {} };
const sourceChecksums = new Map<string, number[]>([
    ['ra2.mix', [0x0E7BA3BE, 0x5DC70844, 0xD48F0E34]],
    ['multi.mix', [0x984EFDB6, 0x3CDB648F]],
]);
const implicitMixes = ['cache.mix', 'load.mix', 'local.mix', 'neutral.mix', 'audio.mix', 'conquer.mix', 'generic.mix', 'isogen.mix', 'cameo.mix'];
const separateMixes = ['sidec01.mix', 'sidec02.mix', 'isotemp.mix', 'temperat.mix', 'tem.mix', 'isosnow.mix', 'snow.mix', 'sno.mix', 'isourb.mix', 'urban.mix', 'urb.mix'];
const loadingImages = ['ustates', 'france', 'germany', 'ukingdom', 'russia', 'cuba', 'libya', 'iraq', 'korea', 'obs'];
const startupSoundKeys = [SoundKey.GUIMoveInSound, SoundKey.GUIMoveOutSound, SoundKey.GUIMainButtonSound, SoundKey.GenericClick, SoundKey.GUICheckboxSound, SoundKey.GUIComboOpenSound, SoundKey.IncomingMessage, SoundKey.PlayerJoined, SoundKey.PlayerLeft];
const startupUiFiles = [
    'rulescd.ini', 'artcd.ini', 'mpmodescd.ini', 'rules.ini', 'art.ini', 'ai.ini',
    'nodogengikills.ini', 'temperat.ini', 'snow.ini', 'urban.ini', 'shroud.shp',
    'mnscrnl.shp', 'lwscrnl.shp', 'sdtp.shp', 'sdwrnanm.shp', 'sdwrntmp.shp',
    'sdbtnbkgd.shp', 'sdbtnanm.shp', 'sdbtm.shp', 'sdmpbtn.shp', 'mouse.shp',
    'shell.pal', 'shell2.pal', 'sdbtnanm.pal', 'mousepal.pal',
    'pudlgbgn.shp', 'dialog.pal', 'mnbttn.shp', 'mainbttn.pal', 'menulogo.png',
    'cue_i.pcx', 'cce_i.pcx', 'cce_il.pcx', 'cce_ir.pcx',
    'wouref.pcx', 'wodref.pcx', 'wouact.pcx', 'wodact.pcx', 'dnarrowr.pcx',
    'dnarrowp.pcx', 'uparrowr.pcx', 'uparrowp.pcx', 'sbgript.pcx', 'sbgripm.pcx',
    'sbgripb.pcx', 'trakgrip.pcx',
];

export function verifySourceChecksum(name: string, bytes: Uint8Array): number {
    const checksum = Crc32.calculateCrc(bytes);
    const expected = sourceChecksums.get(name.toLowerCase());
    if (expected && !expected.includes(checksum)) {
        throw new Error(`Unsupported or damaged ${name}: CRC ${checksum.toString(16).toUpperCase()}, expected ${expected.map(value => value.toString(16).toUpperCase()).join(', ')}`);
    }
    return checksum;
}

export function readMix(name: string, bytes: Uint8Array): ResourceMix {
    if (bytes.length < 6) throw new Error(`Truncated MIX header: ${name}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flags = view.getUint32(0, true);
    const westwood = (flags & ~0x00030000) === 0;
    const encrypted = westwood && (flags & 0x00020000) !== 0;
    if (westwood && bytes.length < (encrypted ? 92 : 10)) throw new Error(`Truncated MIX header: ${name}`);
    let header = view;
    let headerStart = westwood ? 4 : 0;
    if (encrypted) {
        const key = new BlowfishKey().decryptKey(bytes.subarray(4, 84));
        const block = new Uint32Array(2);
        block[0] = view.getUint32(84, true);
        block[1] = view.getUint32(88, true);
        const decrypted = new Blowfish(key).decrypt(block);
        header = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength);
        headerStart = 0;
    }
    const expectedCount = header.getUint16(headerStart, true);
    const dataLength = header.getUint32(headerStart + 2, true);
    const expectedStart = encrypted ? 84 + Math.ceil((6 + expectedCount * MixEntry.size) / 8) * 8 : headerStart + 6 + expectedCount * MixEntry.size;
    const checksumLength = westwood && (flags & 0x00010000) !== 0 ? 20 : 0;
    if (expectedStart + dataLength + checksumLength > bytes.length) throw new Error(`Invalid MIX index or data size: ${name}`);
    const stream = new DataStream(bytes);
    stream.dynamicSize = false;
    const mix = new MixFile(stream);
    const { index, dataStart } = mix as unknown as { index: Map<number, MixEntry>; dataStart: number };
    if (index.size !== expectedCount || dataStart !== expectedStart) throw new Error(`Invalid MIX index or data size: ${name}`);
    const entries = new Map<number, Uint8Array>();
    for (const entry of index.values()) {
        if (entry.offset + entry.length > dataLength) throw new Error(`Out-of-bounds MIX entry ${entry.hash.toString(16)}: ${name}`);
        entries.set(entry.hash, bytes.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.length));
    }
    return { name, bytes, mix, entries };
}

export function buildMix(entries: ReadonlyMap<number, Uint8Array>): Uint8Array {
    const items = [...entries].sort(([left], [right]) => left - right);
    const dataLength = items.reduce((sum, [, bytes]) => sum + bytes.length, 0);
    if (items.length > 0xFFFF || dataLength > 0xFFFFFFFF || items.some(([hash]) => !Number.isInteger(hash) || hash < 0 || hash > 0xFFFFFFFF)) {
        throw new Error('MIX index or data exceeds format limits');
    }
    const stream = new DataStream(10 + items.length * MixEntry.size + dataLength);
    stream.dynamicSize = false;
    stream.writeUint32(0);
    stream.writeUint16(items.length);
    stream.writeUint32(dataLength);
    let offset = 0;
    for (const [hash, bytes] of items) {
        stream.writeUint32(hash);
        stream.writeUint32(offset);
        stream.writeUint32(bytes.length);
        offset += bytes.length;
    }
    for (const [, bytes] of items) stream.writeUint8Array(bytes);
    return stream.toUint8Array();
}

function isVoxelData(bytes: Uint8Array): boolean {
    if (new TextDecoder().decode(bytes.subarray(0, 15)) === 'Voxel Animation') return true;
    if (bytes.length < 24) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frames = view.getUint32(16, true);
    const sections = view.getUint32(20, true);
    return frames > 0 && sections > 0 && 24 + sections * 16 + frames * sections * 48 === bytes.length;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || rgba.length !== width * height * 4) throw new Error('Invalid PNG dimensions or pixel data');
    const rows = new Uint8Array((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const chunk = (type: string, data: Uint8Array) => {
        const result = Buffer.alloc(data.length + 12);
        result.writeUInt32BE(data.length, 0);
        result.write(type, 4, 4, 'ascii');
        result.set(data, 8);
        result.writeUInt32BE(Crc32.calculateCrc(result.subarray(4, data.length + 8)), data.length + 8);
        return result;
    };
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())]);
}

function shpPng(vfs: VirtualFileSystem, name: string, paletteName: string): Uint8Array {
    const shp = new ShpFile(vfs.openFile(name));
    const palette = new Palette(vfs.openFile(paletteName));
    const bitmap = ImageUtils.convertShpToBitmap(shp, palette);
    const rgba = new Uint8Array(bitmap.width * bitmap.height * 4);
    for (let i = 0; i < bitmap.data.length; i++) {
        const color = palette.getColor(bitmap.data[i]);
        rgba.set([color.r, color.g, color.b, bitmap.data[i] ? 255 : 0], i * 4);
    }
    return encodePng(bitmap.width, bitmap.height, rgba);
}

export function validateAudio(vfs: VirtualFileSystem): void {
    const idxBytes = vfs.openFile('audio.idx').getBytes();
    const bag = vfs.openFile('audio.bag');
    if (idxBytes.length < 12) throw new Error('Truncated audio.idx');
    const count = new DataView(idxBytes.buffer, idxBytes.byteOffset, idxBytes.byteLength).getInt32(8, true);
    if (count < 0 || idxBytes.length !== 12 + count * 36) throw new Error('Invalid audio.idx size');
    const idx = new IdxFile(new DataStream(idxBytes));
    if (idx.entries.size !== count) throw new Error('Duplicate audio.idx filenames');
    for (const entry of idx.entries.values()) {
        if (entry.offset + entry.length > bag.getSize() || !entry.sampleRate || (!(entry.flags & 0x02) && (!(entry.flags & 0x08) || !entry.chunkSize))) {
            throw new Error(`Invalid audio.idx entry: ${entry.filename}`);
        }
    }
}

export async function prepareResourceData(input: ReadonlyMap<string, Uint8Array>): Promise<{ files: Map<string, Uint8Array>; maps: PreparedMap[] }> {
    const sources = new Map([...input].map(([name, bytes]) => [name.toLowerCase(), bytes]));
    const required = (name: string) => {
        const bytes = sources.get(name);
        if (!bytes) throw new Error(`Missing source file: ${name}`);
        return readMix(name, bytes);
    };
    const custom = required('ra2cd.mix');
    const appIni = required('ini.mix');
    const language = required('language.mix');
    const ra2 = required('ra2.mix');
    const multi = required('multi.mix');
    const mapMixes = [...sources].filter(([name]) => name.endsWith('.mmx')).sort(([left], [right]) => left.localeCompare(right)).map(([name, bytes]) => readMix(name, bytes));
    const vfs = new VirtualFileSystem(new RealFileSystem(), logger);
    for (const archive of [custom, ...mapMixes, language, ra2]) vfs.addArchive(archive.mix, archive.name);
    const nested = new Map<string, ResourceMix>();
    for (const name of [...implicitMixes, ...separateMixes]) {
        const bytes = sources.get(name) ?? (vfs.fileExists(name) ? vfs.openFile(name).getBytes() : undefined);
        if (!bytes) throw new Error(`Missing nested MIX: ${name}`);
        const archive = readMix(name, bytes);
        nested.set(name, archive);
        if (implicitMixes.includes(name)) vfs.addArchive(archive.mix, name);
    }
    vfs.addArchive(multi.mix, multi.name);
    vfs.addArchive(appIni.mix, 'app-ini.mix');
    validateAudio(vfs);
    const gameModes = new GameModes(new IniFile(vfs.openFile('mpmodescd.ini')), name => new IniFile(vfs.openFile(name)));
    const mapList = new MapList(gameModes);
    mapList.addFromIni(new IniFile(vfs.openFile('missions.pkt')));
    for (const archive of [multi, ...mapMixes]) {
        for (const name of [archive.name.replace(/\.[^.]+$/, '.pkt'), 'mpmaps.ini']) {
            if (archive.mix.containsFile(name)) mapList.addFromIni(new IniFile(archive.mix.openFile(name)));
        }
    }
    const files = new Map<string, Uint8Array>();
    const maps: PreparedMap[] = [];
    const packet = new IniFile();
    const multiMaps = packet.getOrCreateSection('MultiMaps');
    for (const manifest of mapList.getAll()) {
        if (!manifest.gameModes.length) continue;
        const candidates = [manifest.fileName, manifest.fileName.replace(/\.(map|mpr)$/i, '.map'), manifest.fileName.replace(/\.(map|mpr)$/i, '.mpr')];
        const sourceName = candidates.find(name => vfs.fileExists(name));
        if (!sourceName) continue;
        const fileName = manifest.fileName.toLowerCase();
        if (!/^[a-z0-9][a-z0-9_.() -]*\.(map|mpr)$/.test(fileName) || fileName.includes('..')) throw new Error(`Unsafe map filename: ${manifest.fileName}`);
        const file = vfs.openFile(sourceName);
        const parsed = new MapFile().fromVirtualFile(file) as MapFile;
        if (![TheaterType.Temperate, TheaterType.Snow, TheaterType.Urban].includes(parsed.theaterType)) continue;
        if (parsed.fullSize.width <= 0 || parsed.fullSize.height <= 0 || parsed.startingLocations.length < 2 || manifest.maxSlots < 2 || manifest.maxSlots > 8) throw new Error(`Invalid multiplayer map: ${fileName}`);
        const bytes = file.getBytes();
        files.set(`maps/${fileName}`, bytes);
        const sectionName = fileName.replace(/\.[^.]+$/, '');
        multiMaps.set(String(maps.length + 1), sectionName);
        packet.getOrCreateSection(sectionName).fromJson({ File: fileName, Description: manifest.uiName, MaxPlayers: String(manifest.maxSlots), GameMode: manifest.gameModes.map(mode => mode.mapFilter).join(',') });
        maps.push({ fileName, uiName: manifest.uiName, maxSlots: manifest.maxSlots, gameModes: manifest.gameModes.map(mode => mode.id), theater: TheaterType[parsed.theaterType], digest: MapDigest.compute(file), size: bytes.length });
    }
    if (!maps.length) throw new Error('No supported multiplayer maps were found');
    const packetBytes = new TextEncoder().encode(packet.toString());
    files.set('maps/missions.pkt', packetBytes);
    files.set('maps/manifest.json', new TextEncoder().encode(JSON.stringify({ version: 1, maps }, null, 2) + '\n'));
    const groups = new Map<string, Map<number, Uint8Array>>();
    for (const [type, config] of resourceConfigs) {
        if (type < ResourceType.HalloweenMix) groups.set(config.src, new Map());
    }
    const iniHashes = new Set([...appIni.entries.keys(), ...custom.entries.keys(), MixEntry.hashFilename('missions.pkt')]);
    const startupWavs = new Set<string>();
    const audioVisual = new IniFile(vfs.openFile('rules.ini')).getSection('AudioVisual');
    const soundSpecs = new SoundSpecs(new IniFile(vfs.openFile('sound.ini')));
    for (const key of startupSoundKeys) {
        const soundName = audioVisual?.getString(SoundKey[key]);
        if (!soundName) continue;
        const spec = soundSpecs.getSpec(soundName);
        if (!spec) throw new Error(`Missing startup sound spec: ${soundName}`);
        for (const name of spec.sounds) startupWavs.add(`${name}.wav`);
    }
    const startupUiHashes = new Set([...startupUiFiles, ...gameModes.getAll().map(mode => mode.rulesOverride), ...startupWavs].map(name => MixEntry.hashFilename(name)));
    const csfHash = MixEntry.hashFilename('ra2.csf');
    const eva = new IniFile(vfs.openFile('eva.ini'));
    const evaHashes = new Map<string, Set<number>>();
    for (const [target, key] of [['eva-ally.mix', 'Allied'], ['eva-sov.mix', 'Russian']]) {
        evaHashes.set(target, new Set(eva.getOrderedSections().map(section => section.getString(key).trim()).filter(Boolean).map(name => MixEntry.hashFilename(name.replace(/\.wav$/i, '') + '.wav'))));
    }
    const seen = new Set<number>();
    const containers = new Set([...implicitMixes, ...separateMixes].map(name => MixEntry.hashFilename(name)));
    const add = (archive: ResourceMix, defaultTarget: string, root: boolean = false) => {
        for (const [hash, bytes] of archive.entries) {
            if (seen.has(hash) || (root && containers.has(hash)) || (root && new TextDecoder().decode(bytes.subarray(0, 3)) === 'BIK')) continue;
            seen.add(hash);
            const target = startupUiHashes.has(hash) ? 'ui.mix' : iniHashes.has(hash) ? 'ini.mix' : hash === csfHash ? 'strings.mix' : isVoxelData(bytes) ? 'vxl.mix' : defaultTarget;
            const evaTargets = defaultTarget === 'sounds.mix' ? [...evaHashes].filter(([, hashes]) => hashes.has(hash)).map(([name]) => name) : [];
            groups.get(evaTargets.length === 1 ? evaTargets[0] : target)!.set(hash, bytes);
        }
    };
    add(custom, 'ini.mix');
    add(language, 'ui.mix', true);
    add(ra2, 'ui.mix', true);
    for (const name of implicitMixes) {
        const target = name === 'audio.mix' ? 'sounds.mix' : name === 'conquer.mix' ? 'anims.mix' : name === 'cameo.mix' ? 'cameo.mix' : ['generic.mix', 'neutral.mix', 'isogen.mix'].includes(name) ? 'build-gen.mix' : 'ui.mix';
        add(nested.get(name)!, target);
    }
    add(appIni, 'ini.mix');
    const idx = new IdxFile(vfs.openFile('audio.idx').stream);
    for (const [name] of idx.entries) {
        if (!startupWavs.has(name)) idx.entries.delete(name);
    }
    const startupAudio = await new AudioBagFile().fromVirtualFile(vfs.openFile('audio.bag'), idx);
    for (const name of startupWavs) {
        const hash = MixEntry.hashFilename(name);
        if (groups.get('ui.mix')!.has(hash)) continue;
        if (!startupAudio.containsFile(name)) throw new Error(`Missing startup sound file: ${name}`);
        groups.get('ui.mix')!.set(hash, startupAudio.openFile(name).getBytes());
    }
    groups.get('ini.mix')!.set(MixEntry.hashFilename('missions.pkt'), packetBytes);
    for (const [name, entries] of groups) {
        files.set(`game-res/v2/${name}`, separateMixes.includes(name) ? nested.get(name)!.bytes : buildMix(entries));
    }
    if (vfs.fileExists('glsl.shp') && vfs.fileExists('gls.pal')) files.set('game-res/v2/glsl.png', shpPng(vfs, 'glsl.shp', 'gls.pal'));
    for (const country of loadingImages) {
        const name = `ls800${country}.shp`;
        const palette = country === 'obs' ? 'mplsobs.pal' : 'mpls.pal';
        if (vfs.fileExists(name) && vfs.fileExists(palette)) files.set(`game-res/v2/ls/ls800${country}.png`, shpPng(vfs, name, palette));
    }
    const checksums: Record<string, number> = {};
    for (const [name, bytes] of files) {
        if (name.startsWith('game-res/v2/') && name.endsWith('.mix')) checksums[name.slice('game-res/v2/'.length)] = Crc32.calculateCrc(bytes);
    }
    files.set('game-res/v2/manifest.json', new TextEncoder().encode(JSON.stringify({ version: 2, format: 'mix', checksums }, null, 2) + '\n'));
    return { files, maps };
}

async function resolveOutputFolder(path: string): Promise<string> {
    try {
        return await realpath(path);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return undefined;
        });
        if (entry?.isSymbolicLink()) throw new Error(`Output entry must not be a symbolic link: ${path}`);
        return join(await resolveOutputFolder(dirname(path)), basename(path));
    }
}

export async function prepareResources(sourceFolder: string, outputFolder: string) {
    const source = await realpath(sourceFolder);
    const output = await resolveOutputFolder(resolve(outputFolder));
    const overlap = relative(source, output);
    if (!overlap || (!overlap.startsWith('..' + sep) && overlap !== '..' && !overlap.startsWith(sep))) throw new Error('Output folder must not be inside the source folder');
    const entries = await readdir(source, { withFileTypes: true });
    const names = new Map<string, string>();
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const name = entry.name.toLowerCase();
        if (!name.endsWith('.mix') && !name.endsWith('.mmx')) continue;
        if (names.has(name)) throw new Error(`Ambiguous case-insensitive filename: ${entry.name}`);
        names.set(name, entry.name);
    }
    const input = new Map<string, Uint8Array>();
    const sources: { name: string; size: number; crc: number }[] = [];
    for (const name of ['ra2.mix', 'language.mix', 'multi.mix']) {
        const actual = names.get(name);
        if (!actual) throw new Error(`Missing source file: ${name}`);
        const bytes = await readFile(join(source, actual));
        sources.push({ name, size: bytes.length, crc: verifySourceChecksum(name, bytes) });
        input.set(name, bytes);
    }
    for (const [name, actual] of names) {
        if (name.endsWith('.mmx') || [...implicitMixes, ...separateMixes].includes(name)) input.set(name, await readFile(join(source, actual)));
    }
    const publicFolder = fileURLToPath(new URL('../public/', import.meta.url));
    input.set('ini.mix', await readFile(join(publicFolder, 'ini.mix')));
    input.set('ra2cd.mix', await readFile(join(publicFolder, 'res/ra2cd.mix')));
    const prepared = await prepareResourceData(input);
    const summary = [];
    for (const [name, bytes] of prepared.files) {
        const target = join(output, name);
        if (await resolveOutputFolder(target) !== target) throw new Error(`Output entry must not be a symbolic link: ${name}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
        summary.push({ name, size: bytes.length });
    }
    return { sourceFolder: source, outputFolder: output, gameResFolder: join(output, 'game-res/v2'), mapsFolder: join(output, 'maps'), sources, files: summary, totalBytes: summary.reduce((sum, file) => sum + file.size, 0), mapNames: prepared.maps.map(map => map.fileName) };
}

export async function prepareBundledResources(outputFolder = fileURLToPath(new URL('../public/cdn/', import.meta.url)), archivePath = fileURLToPath(new URL('./game-res.7z', import.meta.url))) {
    const output = await resolveOutputFolder(resolve(outputFolder));
    const marker = join(output, '.ra2web-bundled-sha256');
    try {
        const archive = await realpath(archivePath);
        const archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
        const executable = Bun.which('7z');
        if (!executable) throw new Error('Bundled resources require system 7z (p7zip-full); install it before running prepare:bundled');
        const run7z = async (args: string[]) => {
            const child = Bun.spawn([executable, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
            const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
            if (code !== 0) throw new Error(`Bundled archive ${args[0]} failed: ${stderr.trim() || stdout.trim()}`);
            return stdout;
        };
        const mixes = [...resourceConfigs].filter(([type]) => type < ResourceType.HalloweenMix).map(([, config]) => config.src);
        const directories = new Set(['game-res', 'game-res/v2', 'game-res/v2/ls', 'maps']);
        const allowed = new Set(['game-res/v2/manifest.json', 'game-res/v2/glsl.png', 'maps/manifest.json', 'maps/missions.pkt', ...mixes.map(name => `game-res/v2/${name}`), ...loadingImages.map(name => `game-res/v2/ls/ls800${name}.png`)]);
        const safeMapName = (name: string) => /^[a-z0-9][a-z0-9_.() -]*\.(map|mpr)$/.test(name) && !name.includes('..');
        const files = new Map<string, { size: number; crc: number }>();
        const seen = new Set<string>();
        const listing = await run7z(['l', '-slt', '-ba', archive]);
        for (const block of listing.trim().split(/\r?\n\r?\n/)) {
            const entry = Object.fromEntries(block.split(/\r?\n/).map(line => {
                const split = line.indexOf(' = ');
                return [line.slice(0, split), line.slice(split + 3)];
            }));
            const name = entry.Path;
            const directory = entry.Attributes?.includes('D');
            if (!name || seen.has(name) || entry.Attributes?.includes('l') || 'Symbolic Link' in entry || 'Hard Link' in entry || entry.Encrypted === '+' || !(directory ? directories.has(name) : allowed.has(name) || (name.startsWith('maps/') && safeMapName(name.slice(5))))) {
                throw new Error(`Unsafe bundled entry: ${name}`);
            }
            seen.add(name);
            if (directory) continue;
            const size = Number(entry.Size);
            if (!Number.isSafeInteger(size) || size < 0 || !/^[0-9A-F]{8}$/i.test(entry.CRC)) throw new Error(`Invalid bundled size or CRC: ${name}`);
            files.set(name, { size, crc: parseInt(entry.CRC, 16) });
        }
        const validate = async (folder: string, parseMixes = false) => {
            for (const [name, expected] of files) {
                const target = join(folder, name);
                const entry = await lstat(target);
                if (!entry.isFile() || entry.nlink !== 1 || await resolveOutputFolder(target) !== target) throw new Error(`Bundled cache entry must be a regular file: ${name}`);
                const bytes = await readFile(target);
                if (bytes.length !== expected.size || Crc32.calculateCrc(bytes) !== expected.crc) throw new Error(`Bundled size or CRC mismatch: ${name}`);
                if (parseMixes && name.endsWith('.mix')) readMix(name, bytes);
            }
            const manifest = JSON.parse(await readFile(join(folder, 'game-res/v2/manifest.json'), 'utf8'));
            if (manifest.version !== 2 || manifest.format !== 'mix' || !manifest.checksums || Object.keys(manifest.checksums).length !== mixes.length) throw new Error('Invalid bundled version 2 MIX manifest');
            for (const name of mixes) {
                const crc = manifest.checksums[name];
                if (!Number.isInteger(crc) || crc < 0 || crc > 0xFFFFFFFF || crc !== files.get(`game-res/v2/${name}`)?.crc) throw new Error(`Invalid bundled manifest CRC: ${name}`);
            }
            if (!files.has('maps/missions.pkt') || !files.has('game-res/v2/manifest.json') || !files.has('maps/manifest.json')) throw new Error('Missing bundled resource manifest or map packet');
            const mapManifest = JSON.parse(await readFile(join(folder, 'maps/manifest.json'), 'utf8'));
            if (mapManifest.version !== 1 || !Array.isArray(mapManifest.maps) || !mapManifest.maps.length) throw new Error('Invalid bundled map manifest');
            const mapNames: string[] = [];
            for (const map of mapManifest.maps) {
                if (!map || typeof map.fileName !== 'string' || !safeMapName(map.fileName) || mapNames.includes(map.fileName)) throw new Error('Invalid bundled map filename');
                const expected = files.get(`maps/${map.fileName}`);
                if (!expected || map.size <= 0 || map.size !== expected.size || map.digest !== expected.crc.toString(16)) throw new Error(`Invalid bundled map size or digest: ${map.fileName}`);
                mapNames.push(map.fileName);
            }
            if (mapNames.length !== [...files.keys()].filter(name => name.startsWith('maps/') && /\.(map|mpr)$/.test(name)).length) throw new Error('Bundled map manifest does not match archive maps');
            return mapNames;
        };
        const summary = { archivePath: archive, archiveSha256, outputFolder: output, gameResFolder: join(output, 'game-res/v2'), mapsFolder: join(output, 'maps'), files: [...files].map(([name, file]) => ({ name, size: file.size })), totalBytes: [...files.values()].reduce((sum, file) => sum + file.size, 0) };
        try {
            const entry = await lstat(marker);
            if (entry.isFile() && entry.nlink === 1 && await readFile(marker, 'utf8') === archiveSha256) {
                const mapNames = await validate(output);
                await rm(join(output, '.ra2web-resource-version'), { force: true });
                return { ...summary, mapNames, cached: true };
            }
        }
        catch {}
        await rm(marker, { recursive: true, force: true });
        await mkdir(output, { recursive: true });
        const staging = await mkdtemp(join(output, '.ra2web-bundled-'));
        try {
            await run7z(['x', '-y', `-o${staging}`, archive]);
            const mapNames = await validate(staging, true);
            for (const name of ['game-res', 'maps']) {
                await rm(join(output, name), { recursive: true, force: true });
                await rename(join(staging, name), join(output, name));
            }
            await rm(join(output, '.ra2web-resource-version'), { force: true });
            await writeFile(marker, archiveSha256, { flag: 'wx' });
            return { ...summary, mapNames, cached: false };
        }
        finally {
            await rm(staging, { recursive: true, force: true });
        }
    }
    catch (error) {
        await rm(marker, { recursive: true, force: true });
        throw error;
    }
}

if (import.meta.main) {
    try {
        const bundled = process.argv[2] === '--bundled';
        if (bundled ? process.argv.length < 3 || process.argv.length > 4 : process.argv.length !== 4) throw new Error('Usage: bun deploy/prepare-resources.ts <source-folder> <output-cdn-folder> | --bundled [output-cdn-folder]');
        console.log(JSON.stringify(await (bundled ? prepareBundledResources(process.argv[3]) : prepareResources(process.argv[2], process.argv[3])), null, 2));
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

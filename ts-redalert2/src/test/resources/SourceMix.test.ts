import { expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MixEntry } from '../../data/MixEntry';
import { readMix, verifySourceChecksum } from '../../../deploy/prepare-resources';

const sourceFolder = process.env.RA2_RESOURCE_SOURCE;
const cdnFolder = process.env.RA2_PREPARED_CDN;
const nestedNames = ['cache.mix', 'load.mix', 'local.mix', 'neutral.mix', 'audio.mix', 'conquer.mix', 'generic.mix', 'isogen.mix', 'cameo.mix'];
const separateNames = ['sidec01.mix', 'sidec02.mix', 'isotemp.mix', 'temperat.mix', 'tem.mix', 'isosnow.mix', 'snow.mix', 'sno.mix', 'isourb.mix', 'urban.mix', 'urb.mix'];

(sourceFolder ? test : test.skip)('local source MIX files retain strict CRC and bounded nested indexes', async () => {
    const names = new Map((await readdir(sourceFolder!)).map(name => [name.toLowerCase(), name]));
    const archives = [];
    for (const name of ['ra2.mix', 'language.mix', 'multi.mix']) {
        const bytes = await readFile(join(sourceFolder!, names.get(name)!));
        expect(verifySourceChecksum(name, bytes)).toBeGreaterThanOrEqual(0);
        archives.push(readMix(name, bytes));
    }
    const nested = [];
    for (const name of [...nestedNames, ...separateNames]) {
        const owner = archives.find(archive => archive.mix.containsFile(name));
        expect(owner).toBeDefined();
        const bytes = owner!.mix.openFile(name).getBytes();
        const archive = readMix(name, bytes);
        expect(archive.entries.size).toBeGreaterThan(0);
        nested.push(archive);
        if (cdnFolder && separateNames.includes(name)) expect(Buffer.from(await readFile(join(cdnFolder, 'game-res/v2', name))).equals(Buffer.from(bytes))).toBe(true);
    }
    if (cdnFolder) {
        const outputs = [];
        for (const name of ['ini.mix', 'ui.mix', 'strings.mix', 'build-gen.mix', 'anims.mix', 'vxl.mix', 'cameo.mix', 'sounds.mix', 'eva-ally.mix', 'eva-sov.mix']) outputs.push(readMix(name, await readFile(join(cdnFolder, 'game-res/v2', name))));
        const custom = readMix('ra2cd.mix', await readFile(new URL('../../../public/res/ra2cd.mix', import.meta.url)));
        const seen = new Set(custom.entries.keys());
        const containers = new Set([...nestedNames, ...separateNames].map(name => MixEntry.hashFilename(name)));
        for (const archive of [archives[1], archives[0], ...nested.filter(item => nestedNames.includes(item.name))]) {
            for (const [hash, bytes] of archive.entries) {
                if (seen.has(hash) || containers.has(hash) || hash === MixEntry.hashFilename('missions.pkt') || new TextDecoder().decode(bytes.subarray(0, 3)) === 'BIK') continue;
                seen.add(hash);
                const output = outputs.find(item => item.entries.has(hash));
                expect(output).toBeDefined();
                expect(Buffer.from(output!.entries.get(hash)!).equals(Buffer.from(bytes))).toBe(true);
            }
        }
    }
}, 120000);

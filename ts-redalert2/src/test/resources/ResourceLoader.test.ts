import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Crc32 } from '../../data/Crc32';
import { CdnResourceLoader } from '../../engine/gameRes/CdnResourceLoader';
import { ResourceLoader } from '../../engine/ResourceLoader';

const restores: (() => void)[] = [];
afterEach(() => {
    for (const restore of restores.splice(0)) restore();
});

function mockDownload(chunks: Uint8Array[], type = 'application/octet-stream') {
    const implementation = Object.assign(async () => new Response(new ReadableStream({
        start(controller) {
            for (const bytes of chunks) controller.enqueue(bytes);
            controller.close();
        },
    }), { headers: { 'Content-Type': type, 'Content-Length': String(chunks.reduce((sum, bytes) => sum + bytes.length, 0)) } }), { preconnect: globalThis.fetch.preconnect });
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(implementation);
    restores.push(() => fetch.mockRestore());
    return fetch;
}

describe('CDN resource downloads', () => {
    test('forwards byte deltas through the fetch options object', async () => {
        mockDownload([new Uint8Array(4), new Uint8Array(2), new Uint8Array(4)]);
        const deltas: number[] = [];
        const bytes = await new ResourceLoader('https://resources.invalid/').loadBinary('ui.mix', undefined, { onProgress: delta => deltas.push(delta) });
        expect(bytes.byteLength).toBe(10);
        expect(deltas).toEqual([4, 2, 4]);
    });

    test('accumulates unequal chunk deltas across resources monotonically', async () => {
        mockDownload([new Uint8Array(4), new Uint8Array(2), new Uint8Array(4)]);
        const progress: number[] = [];
        const result = await new ResourceLoader('https://resources.invalid/').loadResources([
            { id: 'first', src: 'first.mix', type: 'binary', sizeHint: 10 },
            { id: 'second', src: 'second.mix', type: 'binary', sizeHint: 10 },
        ], undefined, percent => progress.push(percent));
        expect(result.pop('first').byteLength).toBe(10);
        expect(result.pop('second').byteLength).toBe(10);
        expect(progress).toEqual([20, 30, 50, 70, 80, 100]);
    });

    test('keeps numeric manifest CRC validation and query cache keys intact', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const fetch = mockDownload([bytes.subarray(0, 1), bytes.subarray(1)]);
        const crc = Crc32.calculateCrc(bytes);
        const loader = new CdnResourceLoader('https://resources.invalid/', { version: 2, format: 'mix', checksums: { 'ui.mix': crc } });
        const deltas: number[] = [];
        expect(new Uint8Array(await loader.loadBinary('ui.mix', undefined, { onProgress: delta => deltas.push(delta) }))).toEqual(bytes);
        expect(fetch.mock.calls[0][0]).toBe(`https://resources.invalid/ui.mix?h=${crc.toString(16)}`);
        expect(deltas).toEqual([1, 3]);
        const corruptLoader = new CdnResourceLoader('https://resources.invalid/', { version: 2, format: 'mix', checksums: { 'ui.mix': crc ^ 1 } });
        await expect(corruptLoader.loadBinary('ui.mix')).rejects.toThrow('Checksum mismatch');
    });

    test('rejects SPA HTML fallbacks instead of treating them as MIX bytes', async () => {
        mockDownload([new TextEncoder().encode('<html>not a MIX</html>')], 'text/html');
        await expect(new ResourceLoader('https://resources.invalid/').loadBinary('missing.mix')).rejects.toThrow('invalid mime type');
    });
});

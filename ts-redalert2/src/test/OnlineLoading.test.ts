import { expect, test } from 'bun:test';
import { LanMatchSession, type LanMatchTransport } from '../network/lan/LanMatchSession';
import type { LanMeshAppMessage, LanMeshSnapshot } from '../network/lan/LanMeshSession';
import type { LanLaunchDescriptor } from '../network/lan/LanRoomSession';
import { EventDispatcher } from '../util/event';
import { VirtualFile } from '../data/vfs/VirtualFile';
import { MapDigest } from '../engine/MapDigest';
import { LanRoomSession } from '../network/lan/LanRoomSession';
import { OnlineSession } from '../network/online/OnlineSession';

class Transport {
    snapshot: Pick<LanMeshSnapshot, 'members'> = { members: [
        { id: 'host', name: 'host', isSelf: true, isDirect: true, status: 'self' },
        { id: 'guest', name: 'guest', isSelf: false, isDirect: true, status: 'connected' },
    ] };
    readonly onSnapshotChange = new EventDispatcher<this, Pick<LanMeshSnapshot, 'members'>>() as EventDispatcher<Transport, Pick<LanMeshSnapshot, 'members'>> & LanMatchTransport['onSnapshotChange'];
    readonly onAppMessage = new EventDispatcher<this, LanMeshAppMessage>() as EventDispatcher<Transport, LanMeshAppMessage> & LanMatchTransport['onAppMessage'];
    getSelf() { return { id: 'host', name: 'host' }; }
    getSnapshot() { return this.snapshot; }
    broadcastAppMessage(_payload: unknown) {}
}

test('a player disconnected during loading does not block the remaining online player forever', () => {
    const transport = new Transport();
    const descriptor = {
        kind: 'lan', roomId: 'room', gameId: '1', timestamp: 1700000000000,
        hostPeerId: 'host', localPeerId: 'host', localPlayerName: 'host',
        gameOpts: {}, humanAssignments: [
            { peerId: 'host', slotIndex: 0, name: 'host' },
            { peerId: 'guest', slotIndex: 1, name: 'guest' },
        ],
        mapTransferStateByPeerId: {}, returnRoute: { screenType: 22 },
    } as LanLaunchDescriptor;
    const session = new LanMatchSession(transport, descriptor);
    try {
        session.reportLoadProgress(100);
        expect(session.areAllPlayersLoaded()).toBe(false);
        transport.snapshot = { members: transport.snapshot.members.filter(member => member.id === 'host') };
        transport.onSnapshotChange.dispatch(transport, transport.snapshot);
        expect(session.areAllPlayersLoaded()).toBe(true);
        session.submitLocalTurn(0, new Uint8Array([1, 0, 0, 0]));
        expect(session.tryConsumeTurn(0)?.dropPeerIds).toEqual(['guest']);
    }
    finally { session.dispose(); }
});

test('large online map transfers to multiple peers keep every chunk below gateway burst limits', async () => {
    const session = new OnlineSession();
    const sent: { time: number; message: any }[] = [];
    Object.assign(session, {
        identity: { id: 'host', name: 'host' },
        room: { id: 'room', hostPeerId: 'host', members: [{ id: 'host', name: 'host' }, { id: 'guest', name: 'guest' }, { id: 'other', name: 'other' }], started: false },
        socket: { readyState: WebSocket.OPEN, close() {}, send(raw: string) { sent.push({ time: Date.now(), message: JSON.parse(raw) }); } },
    });
    const bytes = new Uint8Array(1600 * 1024);
    const file = VirtualFile.fromBytes(bytes, 'large.map');
    const room = new LanRoomSession(session, { getById: id => ({ id, mpDialogSettings: {} }) }, { load: () => Promise.reject(new Error('Not local')) });
    try {
        room.startHosting({
            gameOpts: {
                gameMode: 1, maxSlots: 3, mapOfficial: false, mapName: file.filename,
                mapDigest: MapDigest.compute(file), mapSizeBytes: bytes.length,
                humanPlayers: [{ name: 'host', countryId: 0, colorId: 0, startPos: 0, teamId: -2 }], aiPlayers: [undefined, undefined, undefined],
            } as any,
            slotsInfo: [{ type: 3, name: 'host' }, { type: 0 }, { type: 0 }], currentMapFile: file,
        });
        await Promise.all(['guest', 'other'].map(peerId => (room as any).sendMapToPeer(peerId)));
        for (const peerId of ['guest', 'other']) {
            const chunks = sent.filter(entry => entry.message.targetPeerId === peerId && entry.message.payload?.type === 'map-chunk');
            expect(chunks).toHaveLength(Math.ceil(Math.ceil(bytes.length / 3) * 4 / (12 * 1024)));
            expect(chunks.map(entry => entry.message.payload.index)).toEqual(chunks.map((_, index) => index));
            expect(Buffer.from(chunks.map(entry => entry.message.payload.data).join(''), 'base64')).toEqual(Buffer.from(bytes));
        }
        const bursts = sent.map(entry => sent.filter(other => other.time >= entry.time && other.time < entry.time + 1000).length);
        expect(Math.max(...bursts)).toBeLessThan(128);
        expect(sent.at(-1)!.time - sent[0].time).toBeGreaterThan(1000);
    }
    finally { room.dispose(); session.dispose(); }
}, 20000);

test('synchronous LAN transport preserves custom map completion', async () => {
    const transports: any[] = [];
    function transport(id: string) {
        const value = {
            onSnapshotChange: new EventDispatcher(), onAppMessage: new EventDispatcher(),
            getSelf: () => ({ id, name: id }),
            getSnapshot: () => ({
                self: { id, name: id }, roomId: 'room', isInRoom: true, roomReady: true, directPeerCount: 1, activeQrPayloadText: '',
                members: ['host', 'guest'].map(peerId => ({ id: peerId, name: peerId, isSelf: peerId === id, isDirect: true, status: peerId === id ? 'self' : 'connected' })),
            }),
            ensureLocalRoom() { return this.getSnapshot(); },
            sendAppMessage(peerId: string, payload: unknown) {
                const recipient = transports.find(peer => peer.getSelf().id === peerId);
                recipient.onAppMessage.dispatch(recipient, { from: this.getSelf(), payload, timestamp: Date.now() });
            },
            broadcastAppMessage(payload: unknown) {
                for (const peer of transports) if (peer !== this) this.sendAppMessage(peer.getSelf().id, payload);
            },
        };
        transports.push(value);
        return value;
    }
    const modes = { getById: (id: number) => ({ id, mpDialogSettings: {} }) };
    const loader = { load: () => Promise.reject(new Error('Not local')) };
    const host = new LanRoomSession(transport('host') as any, modes, loader);
    const guest = new LanRoomSession(transport('guest') as any, modes, loader);
    const file = VirtualFile.fromBytes(new Uint8Array(40 * 1024), 'custom.map');
    try {
        host.startHosting({
            gameOpts: {
                gameMode: 1, maxSlots: 2, mapOfficial: false, mapName: file.filename,
                mapDigest: MapDigest.compute(file), mapSizeBytes: file.getBytes().length,
                humanPlayers: [{ name: 'host', countryId: 0, colorId: 0, startPos: 0, teamId: -2 }], aiPlayers: [undefined, undefined],
            } as any,
            slotsInfo: [{ type: 3, name: 'host' }, { type: 0 }], currentMapFile: file,
        });
        await (host as any).sendMapToPeer('guest');
        expect(guest.getResolvedCustomMapFile()?.getBytes()).toEqual(file.getBytes());
        expect(host.getSnapshot().members.find(member => member.peerId === 'guest')?.mapTransfer.status).toBe('complete');
        expect(guest.getSnapshot().localMapFileReady).toBe(true);
    }
    finally { host.dispose(); guest.dispose(); }
});

test('an early map completion cancels queued chunks and preserves the completed state', async () => {
    const session = new OnlineSession();
    const sent: any[] = [];
    Object.assign(session, {
        identity: { id: 'host', name: 'host' },
        room: { id: 'room', hostPeerId: 'host', members: [{ id: 'host', name: 'host' }, { id: 'guest', name: 'guest' }], started: false },
        socket: { readyState: WebSocket.OPEN, close() {}, send(raw: string) { sent.push(JSON.parse(raw)); } },
    });
    const file = VirtualFile.fromBytes(new Uint8Array(40 * 1024), 'custom.map');
    const digest = MapDigest.compute(file);
    const room = new LanRoomSession(session, { getById: id => ({ id, mpDialogSettings: {} }) }, { load: () => Promise.reject(new Error('Not local')) });
    try {
        room.startHosting({
            gameOpts: {
                gameMode: 1, maxSlots: 2, mapOfficial: false, mapName: file.filename, mapDigest: digest, mapSizeBytes: file.getBytes().length,
                humanPlayers: [{ name: 'host', countryId: 0, colorId: 0, startPos: 0, teamId: -2 }], aiPlayers: [undefined, undefined],
            } as any,
            slotsInfo: [{ type: 3, name: 'host' }, { type: 0 }], currentMapFile: file,
        });
        const sending = (room as any).sendMapToPeer('guest');
        session.onAppMessage.dispatch(session, { from: { id: 'guest', name: 'guest' }, payload: { type: 'map-complete', peerId: 'guest', digest, ok: true }, timestamp: Date.now() });
        await sending;
        expect(sent.filter(message => message.payload?.type === 'map-chunk')).toEqual([]);
        expect(room.getSnapshot().members.find(member => member.peerId === 'guest')?.mapTransfer.status).toBe('complete');
    }
    finally { room.dispose(); session.dispose(); }
});

test('starting a game cancels a waiting map chunk', async () => {
    const session = new OnlineSession();
    const room = { id: 'room', hostPeerId: 'host', members: [{ id: 'host', name: 'host' }, { id: 'guest', name: 'guest' }], started: false };
    const sent: string[] = [];
    Object.assign(session, {
        identity: { id: 'host', name: 'host' }, room,
        roomState: { gameOpts: { mapDigest: '1234' }, mapTransferStateByPeerId: { guest: { status: 'sending' } } },
        socket: { readyState: WebSocket.OPEN, close() {}, send(raw: string) { sent.push(raw); } },
    });
    try {
        const pending = session.sendAppMessage('guest', { type: 'map-chunk', digest: '1234', index: 0, data: 'AAAA' });
        room.started = true;
        await pending;
        expect(sent).toEqual([]);
    }
    finally { session.dispose(); }
});

test('leaving a room immediately cancels waiting map chunks while retaining the lobby connection', async () => {
    const session = new OnlineSession();
    const sent: any[] = [];
    Object.assign(session, {
        identity: { id: 'host', name: 'host' },
        room: { id: 'room', hostPeerId: 'host', members: [{ id: 'host', name: 'host' }, { id: 'guest', name: 'guest' }], started: false },
        roomState: { gameOpts: { mapDigest: '1234' }, mapTransferStateByPeerId: { guest: { status: 'sending' } } },
        socket: { readyState: WebSocket.OPEN, close() {}, send(raw: string) { sent.push(JSON.parse(raw)); } },
    });
    try {
        const pending = session.sendAppMessage('guest', { type: 'map-chunk', digest: '1234', index: 0, data: 'AAAA' });
        const leaving = session.leaveRoom();
        await pending;
        expect(session.getRoom()).toBeUndefined();
        expect(session.getSnapshot().isInRoom).toBe(false);
        expect(sent.map(message => message.type)).toEqual(['leave-room']);
        (session as any).handleMessage({ type: 'result', requestId: sent[0].requestId, ok: true });
        await leaving;
        expect(session.isLoggedIn()).toBe(true);
    }
    finally { session.dispose(); }
});

test('a recoverable room closure preserves the online identity and lobby connection', () => {
    const session = new OnlineSession();
    let closes = 0;
    const logs: { level: string; text: string }[] = [];
    Object.assign(session, {
        identity: { id: 'guest', name: 'guest' },
        room: { id: 'room', hostPeerId: 'host', members: [{ id: 'host', name: 'host' }, { id: 'guest', name: 'guest' }], started: false },
        socket: { readyState: WebSocket.OPEN, close() { closes++; } },
    });
    session.onLog.subscribe(entry => logs.push(entry));
    try {
        (session as any).handleMessage({ type: 'room', room: null });
        (session as any).handleMessage({ type: 'error', message: '房主已退出，房间已关闭。', fatal: false });
        expect(session.getRoom()).toBeUndefined();
        expect(session.getSelf().id).toBe('guest');
        expect(session.isLoggedIn()).toBe(true);
        expect(closes).toBe(0);
        expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', text: '房主已退出，房间已关闭。' }));
        (session as any).handleMessage({ type: 'error', message: 'PvPGN 连接已断开，请重新登录。' });
        expect(session.isLoggedIn()).toBe(false);
        expect(closes).toBe(1);
    }
    finally { session.dispose(); }
});

for (const interruption of ['leave', 'dispose', 'replace', 'failed-save'] as const) {
    test(`an interrupted map save cannot publish stale completion after ${interruption}`, async () => {
        let release!: () => void;
        let entered!: () => void;
        const saving = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        const session = new OnlineSession();
        const sent: any[] = [];
        Object.assign(session, {
            identity: { id: 'guest', name: 'guest' },
            room: { id: 'room', hostPeerId: 'host', members: [{ id: 'host', name: 'host' }, { id: 'guest', name: 'guest' }], started: false },
            socket: { readyState: WebSocket.OPEN, close() {}, send(raw: string) { sent.push(JSON.parse(raw)); } },
        });
        const file = VirtualFile.fromBytes(new Uint8Array([1, 2, 3]), 'a.map');
        const replacement = VirtualFile.fromBytes(new Uint8Array([4, 5, 6]), 'b.map');
        const room = new LanRoomSession(session, { getById: id => ({ id, mpDialogSettings: {} }) }, { load: () => Promise.reject(new Error('Not local')) }, {
            async containsEntry() { entered(); await saving; if (interruption === 'failed-save') throw new Error('Save failed'); return false; },
            async writeFile() {},
        });
        function state(map: VirtualFile) {
            return {
                version: 1, hostPeerId: 'host', memberOrder: ['host', 'guest'],
                humanAssignments: ['host', 'guest'].map((peerId, slotIndex) => ({ peerId, name: peerId, slotIndex })),
                gameOpts: { gameMode: 1, maxSlots: 2, mapOfficial: false, mapName: map.filename, mapDigest: MapDigest.compute(map), mapSizeBytes: map.getSize(), humanPlayers: ['host', 'guest'].map(name => ({ name, countryId: 0, colorId: 0, startPos: -2, teamId: -2 })), aiPlayers: [undefined, undefined] },
                slotsInfo: ['host', 'guest'].map(name => ({ type: 3, name })), readyStateByPeerId: { host: false, guest: false },
                mapTransferStateByPeerId: { host: { status: 'complete', updatedAt: 1 }, guest: { status: 'pending', updatedAt: 1 } },
            };
        }
        function offer(map: VirtualFile) {
            (room as any).handleStateSync({ id: 'host', name: 'host' }, { type: 'state-sync', state: state(map) });
            (room as any).handleMapOffer({ id: 'host', name: 'host' }, { type: 'map-offer', peerId: 'guest', filename: map.filename, digest: MapDigest.compute(map), totalChunks: 1, sizeBytes: map.getSize() });
        }
        try {
            offer(file);
            const completed = (room as any).handleMapChunk({ id: 'host', name: 'host' }, { type: 'map-chunk', peerId: 'guest', digest: MapDigest.compute(file), index: 0, data: Buffer.from(file.getBytes()).toString('base64') });
            await started;
            if (interruption === 'dispose') room.dispose();
            else room.leaveRoom();
            if (interruption === 'replace') offer(replacement);
            const activeTransfer = (room as any).incomingTransfers.get('host');
            release();
            await completed;
            expect(sent.filter(message => message.payload?.type === 'map-complete')).toEqual([]);
            expect((room as any).incomingTransfers.get('host')).toBe(activeTransfer);
            if (interruption === 'replace') {
                expect(room.getSnapshot().roomState?.gameOpts.mapName).toBe('b.map');
                expect(room.getSnapshot().members.find(member => member.peerId === 'guest')?.mapTransfer.status).toBe('receiving');
                expect(room.getResolvedCustomMapFile()).toBeUndefined();
            }
        }
        finally { release(); room.dispose(); session.dispose(); }
    });
}

test('a completion for an old map cannot complete the current map transfer', () => {
    const session = new OnlineSession();
    Object.assign(session, {
        identity: { id: 'host', name: 'host' },
        room: { id: 'room', hostPeerId: 'host', members: [{ id: 'host', name: 'host' }, { id: 'guest', name: 'guest' }], started: false },
        socket: { readyState: WebSocket.OPEN, close() {}, send() {} },
    });
    const file = VirtualFile.fromBytes(new Uint8Array([4, 5, 6]), 'b.map');
    const room = new LanRoomSession(session, { getById: id => ({ id, mpDialogSettings: {} }) }, { load: () => Promise.reject(new Error('Not local')) });
    try {
        room.startHosting({
            gameOpts: { gameMode: 1, maxSlots: 2, mapOfficial: false, mapName: file.filename, mapDigest: MapDigest.compute(file), mapSizeBytes: file.getSize(), humanPlayers: [{ name: 'host', countryId: 0, colorId: 0, startPos: 0, teamId: -2 }], aiPlayers: [undefined, undefined] } as any,
            slotsInfo: [{ type: 3, name: 'host' }, { type: 0 }], currentMapFile: file,
        });
        session.onAppMessage.dispatch(session, { from: { id: 'guest', name: 'guest' }, payload: { type: 'map-complete', peerId: 'guest', digest: 'old-map', ok: true }, timestamp: Date.now() });
        expect(room.getSnapshot().members.find(member => member.peerId === 'guest')?.mapTransfer.status).toBe('pending');
        session.onAppMessage.dispatch(session, { from: { id: 'guest', name: 'guest' }, payload: { type: 'map-complete', peerId: 'guest', digest: MapDigest.compute(file), ok: true }, timestamp: Date.now() });
        expect(room.getSnapshot().members.find(member => member.peerId === 'guest')?.mapTransfer.status).toBe('complete');
    }
    finally { room.dispose(); session.dispose(); }
});

test('closing an online session cancels its pending map chunk', async () => {
    const session = new OnlineSession();
    const sent: string[] = [];
    Object.assign(session, {
        identity: { id: 'host', name: 'host' },
        room: { id: 'room', hostPeerId: 'host', members: [{ id: 'host', name: 'host' }, { id: 'guest', name: 'guest' }], started: false },
        roomState: { gameOpts: { mapDigest: '1234' } },
        socket: { readyState: WebSocket.OPEN, close() {}, send(raw: string) { sent.push(raw); } },
    });
    const pending = session.sendAppMessage('guest', { type: 'map-chunk', digest: '1234', index: 0, data: 'AAAA' });
    session.dispose();
    await pending;
    expect(sent).toEqual([]);
});

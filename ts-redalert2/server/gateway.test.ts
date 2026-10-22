import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createServer } from 'node:net';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, validateLaunch, validateRoomState, validateActionData } from './gateway';
import { roomConfigSignature } from '../src/network/online/roomConfigSignature';
import { OnlineSession } from '../src/network/online/OnlineSession';
import { parseIrc, wolHash } from './pvpgn';
import type { LanLaunchDescriptor, LanRoomState } from '../src/network/lan/LanRoomSession';
import type { OnlineRoom, OnlineServerMessage } from '../src/network/online/OnlineProtocol';

function fixture() {
    const members = [{ id: 'player1', name: 'player1' }, { id: 'player2', name: 'player2' }];
    const state: LanRoomState = {
        version: 1,
        hostPeerId: 'player1',
        memberOrder: members.map(member => member.id),
        humanAssignments: members.map((member, slotIndex) => ({ peerId: member.id, name: member.name, slotIndex })),
        gameOpts: {
            gameMode: 1, gameSpeed: 3, credits: 10000, unitCount: 5, shortGame: true,
            superWeapons: false, buildOffAlly: false, mcvRepacks: true, cratesAppear: false,
            destroyableBridges: true, multiEngineer: false, noDogEngiKills: false,
            mapName: 'mp11t2.map', mapTitle: 'Test map', mapDigest: '12345678', mapSizeBytes: 100,
            maxSlots: 2, mapOfficial: true,
            humanPlayers: members.map((member, index) => ({ name: member.name, countryId: index, colorId: index, startPos: index, teamId: -2 })),
            aiPlayers: [undefined, undefined],
        },
        slotsInfo: members.map(member => ({ type: 3, name: member.name })),
        readyStateByPeerId: { player1: true, player2: true },
        mapTransferStateByPeerId: Object.fromEntries(members.map(member => [member.id, { status: 'complete' as const, totalBytes: 100, receivedBytes: 100, updatedAt: 1 }])),
    };
    const room: OnlineRoom = { id: '12345678', hostPeerId: 'player1', members, started: false };
    const descriptor: LanLaunchDescriptor = {
        kind: 'lan', roomId: room.id, gameId: 'untrusted', timestamp: 1,
        hostPeerId: 'player1', localPeerId: 'player1', localPlayerName: 'player1',
        gameOpts: state.gameOpts, humanAssignments: state.humanAssignments,
        mapTransferStateByPeerId: state.mapTransferStateByPeerId, returnRoute: { screenType: 22 },
    };
    return { state, room, descriptor, ready: new Map(members.map(member => [member.id, true])) };
}

describe('PvPGN protocol', () => {
    test('rejects malformed room states before publishing them to other players', () => {
        const f = fixture();
        expect(() => validateRoomState(f.state, f.room)).not.toThrow();
        const invalid = structuredClone(f.state) as unknown as { gameOpts: { maxSlots: unknown } };
        invalid.gameOpts.maxSlots = { toString: null, valueOf: null };
        expect(() => validateRoomState(invalid, f.room)).toThrow();
    });
    test('rejects empty, truncated and privileged game action packets', () => {
        expect(() => validateActionData('AQAAAA==')).not.toThrow();
        for (const encoded of ['', 'AA==', 'AQ==', 'AQEAAA==', 'AQAAAAA=', 'AQkCAP8A']) expect(() => validateActionData(encoded)).toThrow();
    });
    test('parses CDR2 names and nested STARTG metadata', () => {
        expect(parseIrc(':host!CDR2@127.0.0.1 STARTG player2 :player1 127.0.0.1 player2 127.0.0.1 :42 1700000000')).toEqual({
            prefix: 'host!CDR2@127.0.0.1', command: 'STARTG', params: ['player2'],
            trailing: 'player1 127.0.0.1 player2 127.0.0.1 :42 1700000000',
        });
        expect(parseIrc('PING :token').trailing).toBe('token');
    });
    test('restricts WOL password bytes instead of truncating passwords', () => {
        expect(wolHash('a')).toBe('aaaaaaaa');
        expect(wolHash('b')).toBe('Iaaaaaaa');
        expect(wolHash('testpass')).toHaveLength(8);
        expect(() => wolHash('toolongpw')).toThrow();
        expect(() => wolHash('中文')).toThrow();
        expect(() => wolHash('a\n')).toThrow();
    });
    test('requires authenticated, ready, uniquely assigned enemy players', () => {
        const f = fixture();
        expect(() => validateLaunch(f.descriptor, f.state, f.room, f.ready)).not.toThrow();
        f.ready.set('player2', false);
        expect(() => validateLaunch(f.descriptor, f.state, f.room, f.ready)).toThrow('准备');
        f.ready.set('player2', true);
        f.state.gameOpts.humanPlayers[1].name = 'player1';
        expect(() => validateLaunch(f.descriptor, f.state, f.room, f.ready)).toThrow('重复');
    });
    test('rejects all-allied and stale configurations', () => {
        const f = fixture();
        f.state.gameOpts.humanPlayers.forEach(player => player.teamId = 0);
        expect(() => validateLaunch(f.descriptor, f.state, f.room, f.ready)).toThrow('敌对');
        f.descriptor = structuredClone(f.descriptor);
        f.descriptor.gameOpts.credits = 5000;
        expect(() => validateLaunch(f.descriptor, f.state, f.room, f.ready)).toThrow('变更');
    });
    test('rejects stale assignments and map snapshots even when players are ready', () => {
        const f = fixture();
        const assignments = structuredClone(f.descriptor);
        assignments.humanAssignments[1].slotIndex = 0;
        expect(() => validateLaunch(assignments, f.state, f.room, f.ready)).toThrow('变更');
        const map = structuredClone(f.descriptor);
        map.mapTransferStateByPeerId.player2.status = 'pending';
        expect(() => validateLaunch(map, f.state, f.room, f.ready)).toThrow('地图状态已变更');
        f.state.mapTransferStateByPeerId.player2.status = 'pending';
        expect(() => validateLaunch(f.descriptor, f.state, f.room, f.ready)).toThrow('地图加载');
    });
});

class BrowserClient {
    private readonly messages: OnlineServerMessage[] = [];
    private readonly pending = new Set<{ accept(message: OnlineServerMessage): boolean; resolve(message: OnlineServerMessage): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    private constructor(readonly socket: WebSocket) {
        socket.onmessage = event => {
            const message = JSON.parse(event.data as string) as OnlineServerMessage;
            const waiter = [...this.pending].find(entry => entry.accept(message));
            if (waiter) { clearTimeout(waiter.timer); this.pending.delete(waiter); waiter.resolve(message); }
            else this.messages.push(message);
        };
        socket.onclose = () => {
            for (const waiter of this.pending) { clearTimeout(waiter.timer); waiter.reject(new Error('Connection closed')); }
            this.pending.clear();
        };
    }
    static async connect(url: string): Promise<BrowserClient> {
        const socket = new WebSocket(url);
        const client = new BrowserClient(socket);
        await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('Connection failed')); });
        return client;
    }
    send(message: unknown): void { this.socket.send(JSON.stringify(message)); }
    wait(accept: (message: OnlineServerMessage) => boolean): Promise<OnlineServerMessage> {
        const index = this.messages.findIndex(accept);
        if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
            const waiter = { accept, resolve, reject, timer: setTimeout(() => { this.pending.delete(waiter); reject(new Error('Response timed out')); }, 10000) };
            this.pending.add(waiter);
        });
    }
    async request(type: string, fields: Record<string, unknown> = {}): Promise<Extract<OnlineServerMessage, { type: 'result' }>> {
        const requestId = crypto.randomUUID();
        const response = this.wait(message => message.type === 'result' && message.requestId === requestId);
        this.send({ type, requestId, ...fields });
        return await response as Extract<OnlineServerMessage, { type: 'result' }>;
    }
    async close(): Promise<void> {
        for (const item of this.pending) clearTimeout(item.timer);
        this.pending.clear();
        if (this.socket.readyState === WebSocket.CLOSED) return;
        const closed = new Promise<void>(resolve => this.socket.addEventListener('close', () => resolve(), { once: true }));
        this.socket.close();
        await closed;
    }
}

test('does not reinsert a client closed immediately after join ACK', async () => {
    let resolveAck!: (message: unknown) => void;
    let markEntered!: () => void;
    let reply: unknown;
    let websocket: any;
    const ack = new Promise(resolve => { resolveAck = resolve; });
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const serve = spyOn(Bun, 'serve').mockImplementation((options: any) => {
        websocket = options.websocket;
        return { stop: () => Promise.resolve() } as any;
    });
    let gateway: ReturnType<typeof createGateway> | undefined;
    let serial = 0;
    function client(id: string) {
        const data: any = {
            identity: { id, name: id }, channel: '#Lob_45_0', pendingNames: [], list: [],
            queue: Promise.resolve(), queued: 0, queuedBytes: 0, rateStarted: Date.now(),
            rateCount: 0, chatTimes: [], closed: false, ip: 'fake', destroyed: false,
        };
        const messages: any[] = [];
        const ws: any = {
            data, messages, getBufferedAmount: () => 0,
            send(raw: string) { messages.push(JSON.parse(raw)); },
            close() { websocket.close(ws); },
        };
        data.upstream = {
            send() {},
            destroy() { data.destroyed = true; },
            exchange(lines: string[], accept: (message: unknown) => boolean) {
                const join = lines.find(line => line.startsWith('JOINGAME '));
                const channel = join ? join.split(' ')[1] : '#Lob_45_0';
                data.pendingNames = id === 'player1' ? ['@player1,0,0'] : ['@player1,0,0', 'player2,0,0'];
                const response = { prefix: 'pvpgn', command: '366', params: [id, channel] };
                expect(accept(response)).toBe(true);
                if (join && id === 'player2') { reply = response; markEntered(); return ack; }
                return Promise.resolve(response);
            },
        };
        websocket.open(ws);
        return ws;
    }
    async function request(ws: any, type: string, fields: Record<string, unknown> = {}) {
        const requestId = String(++serial);
        websocket.message(ws, JSON.stringify({ type, requestId, ...fields }));
        await ws.data.queue;
        return ws.messages.find((message: any) => message.type === 'result' && message.requestId === requestId);
    }
    try {
        gateway = createGateway();
        const host = client('player1'), guest = client('player2');
        const created = await request(host, 'create-room');
        expect(created.ok).toBe(true);
        const joining = request(guest, 'join-room', { roomId: created.data.id });
        await entered;
        resolveAck(reply);
        websocket.close(guest);
        await joining;
        expect(guest.data.closed).toBe(true);
        expect(guest.data.destroyed).toBe(true);
        expect(guest.data.roomId).toBeUndefined();
        expect(guest.data.queued).toBe(0);
        expect(guest.data.queuedBytes).toBe(0);
        expect(host.messages.some((message: any) => message.type === 'room' && message.room?.members.some((member: any) => member.id === 'player2'))).toBe(false);
        expect(await request(host, 'app-message', { payload: { type: 'state-sync', state: fixture().state } })).toMatchObject({ ok: false, error: '玩家配置无效。' });
    }
    finally {
        resolveAck(reply);
        try { await gateway?.stop(); }
        finally { serve.mockRestore(); }
    }
});

const prefix = process.env.PVPGN_TEST_PREFIX;
(prefix ? describe : describe.skip)('gateway with real PvPGN', () => {
    let directory: string;
    let daemon: ReturnType<typeof Bun.spawn>;
    let gateway: ReturnType<typeof createGateway>;
    const browsers: BrowserClient[] = [];
    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'ra2web-gateway-'));
        const portServer = createServer();
        await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
        const port = (portServer.address() as { port: number }).port;
        await new Promise<void>((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));
        const state = join(directory, 'pvpgn');
        await cp(join(prefix!, 'var/pvpgn'), state, { recursive: true });
        let config = (await readFile(join(prefix!, 'etc/pvpgn/bnetd.conf'), 'utf8')).replaceAll(join(prefix!, 'var/pvpgn'), state);
        for (const [key, value] of Object.entries({ servaddrs: '""', w3routeaddr: '""', wolv1addrs: '""', wolv2addrs: `"127.0.0.1:${port}"`, ircaddrs: '""', telnetaddrs: '""', apiregaddrs: '""', wgameresaddrs: '""', track: '0', loglevels: 'fatal,error,warn,info', quota_min_games: '0', quota_min_acc_age: '0', quota_lines: '20', quota_dobae: '30', quota_wrapline: '200', quota_maxline: '200', quota_time: '5', shutdown_delay: '0', sync_on_logoff: 'true' })) {
            config = config.replace(new RegExp(`^\\s*${key}\\s*=.*$`, 'gm'), '') + `\n${key} = ${value}\n`;
        }
        await writeFile(join(directory, 'bnetd.conf'), config);
        daemon = Bun.spawn([join(prefix!, 'sbin/bnetd'), '-f', '-c', join(directory, 'bnetd.conf')], { stdout: 'ignore', stderr: 'ignore' });
        const staticDir = join(directory, 'web');
        await mkdir(staticDir);
        await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>RA2WEB</title>');
        gateway = createGateway({ hostname: '127.0.0.1', port: 0, pvpgnPort: port, staticDir });
        const deadline = Date.now() + 5000;
        while (!(await fetch(new URL('/healthz', gateway.server.url))).ok) {
            if (Date.now() > deadline) throw new Error('PvPGN startup failed');
            await Bun.sleep(50);
        }
    });
    afterAll(async () => {
        const bounded = async (operation: Promise<unknown>, label: string) => {
            let timer: ReturnType<typeof setTimeout>;
            try {
                await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} cleanup timed out`)), 3000); })]);
            }
            finally { clearTimeout(timer!); }
        };
        try {
            await bounded(Promise.all(browsers.map(browser => browser.close())), 'Browser');
            await bounded(gateway?.stop() ?? Promise.resolve(), 'Gateway');
            await expect(fetch(new URL('/healthz', gateway.server.url), { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
            if (daemon) { daemon.kill('SIGQUIT'); await bounded(daemon.exited, 'PvPGN'); }
        }
        finally {
            daemon?.kill('SIGKILL');
            if (directory) await rm(directory, { recursive: true, force: true });
        }
    }, 15000);
    test('rejects anonymous operations, malformed input and case-insensitive duplicate logins', async () => {
        const endpoint = new URL('/ws', gateway.server.url).toString().replace('http:', 'ws:');
        const browser = await BrowserClient.connect(endpoint), duplicate = await BrowserClient.connect(endpoint);
        browsers.push(browser, duplicate);
        for (const type of ['create-room', 'list-rooms']) {
            expect(await browser.request(type)).toMatchObject({ ok: false, error: '请先登录。' });
        }
        browser.send({ type: 'app-message', payload: { type: 'ready', peerId: 'anonymous', ready: true } });
        expect(await browser.wait(message => message.type === 'error')).toMatchObject({ message: '请先登录。' });
        for (const raw of ['{', 'null', '[]', '{"type":"login"}']) {
            browser.socket.send(raw);
            expect(await browser.wait(message => message.type === 'error')).toMatchObject({ message: '请求格式无效。' });
        }
        const user = `auth${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
        for (const fields of [
            { user: 'bad\r\nuser', pass: 'testpass' },
            { user: 'x'.repeat(16), pass: 'testpass' },
            { user, pass: '' },
            { user, pass: 'toolongpw' },
            { user, pass: 'a\r\n' },
            { user, pass: '中文' },
        ]) {
            const rejected = await browser.request('login', fields);
            expect(rejected.ok).toBe(false);
            expect(rejected.error).toMatch(/用户名|Password/);
        }
        expect(await browser.request('login', { user: user.toUpperCase(), pass: 'testpass' })).toMatchObject({ ok: true, data: { id: user, name: user } });
        for (const name of [user, user.toUpperCase()]) {
            expect(await duplicate.request('login', { user: name, pass: 'testpass' })).toMatchObject({ ok: false, error: '该用户已经登录。' });
        }
        await Promise.all([browser.close(), duplicate.close()]);
    }, 15000);
    test('authenticates, discovers real rooms, starts consistent games and enforces relay identities', async () => {
        const endpoint = new URL('/ws', gateway.server.url).toString().replace('http:', 'ws:');
        const a = await BrowserClient.connect(endpoint), b = await BrowserClient.connect(endpoint), outsider = await BrowserClient.connect(endpoint);
        browsers.push(a, b, outsider);
        expect((await a.request('login', { user: 'player1', pass: 'testpass' })).ok).toBe(true);
        expect((await b.request('login', { user: 'player2', pass: 'testpass' })).ok).toBe(true);
        expect((await outsider.request('login', { user: 'outside', pass: 'testpass' })).ok).toBe(true);
        expect((await outsider.request('create-room')).ok).toBe(true);
        const created = await a.request('create-room');
        expect(created.ok).toBe(true);
        const room = created.data as OnlineRoom;
        const listed = await b.request('list-rooms');
        expect((listed.data as { id: string }[]).some(entry => entry.id === room.id)).toBe(true);
        expect((await b.request('join-room', { roomId: room.id })).ok).toBe(true);
        a.send({ type: 'chat', text: '/kick player2' });
        expect(await a.wait(message => message.type === 'error')).toMatchObject({ message: '聊天消息无效：最多 200 字节，不能以 / 开头。' });
        a.send({ type: 'chat', text: 'x'.repeat(201) });
        expect(await a.wait(message => message.type === 'error')).toMatchObject({ message: '聊天消息无效：最多 200 字节，不能以 / 开头。' });
        a.send({ type: 'chat', text: 'real-pvpgn-chat' });
        expect((await b.wait(message => message.type === 'chat' && message.text === 'real-pvpgn-chat')).type).toBe('chat');
        await a.wait(message => message.type === 'chat' && message.text === 'real-pvpgn-chat');
        const repeat = Buffer.alloc(200, 'z').toString();
        a.send({ type: 'chat', text: repeat });
        const echoed = await a.wait(message => (message.type === 'chat' && message.text === repeat) || message.type === 'error');
        expect(echoed).toMatchObject({ type: 'chat', text: repeat });
        expect(await b.wait(message => message.type === 'chat')).toMatchObject({ text: repeat });
        const f = fixture();
        f.room.id = room.id;
        f.descriptor.roomId = room.id;
        f.state.readyStateByPeerId.player2 = false;
        a.send({ type: 'app-message', payload: { type: 'state-sync', state: f.state } });
        await b.wait(message => message.type === 'app-message' && (message.payload as { type: string }).type === 'state-sync');
        b.send({ type: 'app-message', payload: { type: 'state-sync', state: f.state } });
        expect(await b.wait(message => message.type === 'error')).toMatchObject({ message: '只有房主可以同步房间配置。' });
        b.send({ type: 'app-message', targetPeerId: 'player1', payload: { type: 'slot-request', peerId: 'player2', slotIndex: 0, countryId: 1, colorId: 1, startPos: 1, teamId: -2 } });
        expect(await b.wait(message => message.type === 'error')).toMatchObject({ message: '玩家只能修改自己的槽位。' });
        b.send({ type: 'app-message', targetPeerId: 'player1', payload: { type: 'slot-request', peerId: 'player2', slotIndex: 1, countryId: 1, colorId: 1, startPos: 1, teamId: -2 } });
        expect(await a.wait(message => message.type === 'app-message' && (message.payload as { type: string }).type === 'slot-request')).toMatchObject({ from: { id: 'player2' }, payload: { peerId: 'player2', slotIndex: 1 } });
        b.send({ type: 'app-message', targetPeerId: 'player1', payload: { type: 'ready', peerId: 'player1', ready: true } });
        expect(await b.wait(message => message.type === 'error')).toMatchObject({ message: '玩家身份或房间状态无效。' });
        a.send({ type: 'app-message', targetPeerId: 'outside', payload: { type: 'map-offer', peerId: 'outside', filename: f.state.gameOpts.mapName, digest: f.state.gameOpts.mapDigest, sizeBytes: f.state.gameOpts.mapSizeBytes, totalChunks: 1 } });
        expect(await a.wait(message => message.type === 'error')).toMatchObject({ message: '目标玩家不在当前房间。' });
        expect(await b.request('start-game', { descriptor: f.descriptor })).toMatchObject({ ok: false, error: '只有房主可以开始尚未开始的游戏。' });
        expect(await a.request('start-game', { descriptor: f.descriptor })).toMatchObject({ ok: false, error: '所有玩家准备后才能开始。' });
        b.send({ type: 'app-message', targetPeerId: 'player1', payload: { type: 'ready', peerId: 'player2', ready: true, configSignature: roomConfigSignature(f.state) } });
        await a.wait(message => message.type === 'app-message' && (message.payload as { type: string }).type === 'ready');
        f.state.readyStateByPeerId.player2 = true;
        a.send({ type: 'app-message', payload: { type: 'state-sync', state: f.state } });
        await b.wait(message => message.type === 'app-message' && (message.payload as { type: string }).type === 'state-sync');
        const stale = structuredClone(f.descriptor);
        f.state.gameOpts.credits = 5000;
        a.send({ type: 'app-message', payload: { type: 'state-sync', state: f.state } });
        await b.wait(message => message.type === 'app-message' && (message.payload as { type: string }).type === 'state-sync');
        expect(await a.request('start-game', { descriptor: stale })).toMatchObject({ ok: false, error: '房间配置已变更，请重新准备。' });
        expect(await a.request('start-game', { descriptor: f.descriptor })).toMatchObject({ ok: false, error: '所有玩家准备后才能开始。' });
        b.send({ type: 'app-message', targetPeerId: 'player1', payload: { type: 'ready', peerId: 'player2', ready: true, configSignature: roomConfigSignature(f.state) } });
        await a.wait(message => message.type === 'app-message' && (message.payload as { type: string }).type === 'ready');
        expect((await a.request('start-game', { descriptor: f.descriptor })).ok).toBe(true);
        const launchA = await a.wait(message => message.type === 'launch') as Extract<OnlineServerMessage, { type: 'launch' }>;
        const launchB = await b.wait(message => message.type === 'launch') as Extract<OnlineServerMessage, { type: 'launch' }>;
        expect(launchA.descriptor.gameId).toMatch(/^\d+$/);
        expect(launchA.descriptor.gameId).toBe(launchB.descriptor.gameId);
        expect(launchA.descriptor.timestamp).toBe(launchB.descriptor.timestamp);
        expect(launchB.descriptor.localPeerId).toBe('player2');
        expect(launchA.descriptor.returnRoute).toEqual({ screenType: 22, params: {} });
        expect(launchB.descriptor.returnRoute).toEqual({ screenType: 22, params: {} });
        expect((await outsider.request('leave-room')).ok).toBe(true);
        expect((await outsider.request('join-room', { roomId: room.id })).ok).toBe(false);
        const turn = { type: 'lan-game-turn', gameId: launchA.descriptor.gameId, tick: 0, fromPeerId: 'player1', turnId: 'player1:0:1', actionData: 'AQAAAA==', dropPeerIds: [] };
        b.send({ type: 'app-message', payload: turn });
        expect(await b.wait(message => message.type === 'error')).toMatchObject({ message: '对局或发送者身份无效。' });
        a.send({ type: 'app-message', payload: { ...turn, dropPeerIds: ['player2'] } });
        expect(await a.wait(message => message.type === 'error')).toMatchObject({ message: '掉线玩家名单无效。' });
        a.send({ type: 'app-message', payload: turn });
        const received = await b.wait(message => message.type === 'app-message' && (message.payload as { type: string }).type === 'lan-game-turn');
        expect(received).toMatchObject({ from: { id: 'player1' }, payload: turn });
        a.send({ type: 'app-message', payload: { type: 'lan-game-load-progress', gameId: launchA.descriptor.gameId, fromPeerId: 'player1', loadPercent: 100 } });
        await b.wait(message => message.type === 'app-message' && (message.payload as { type: string }).type === 'lan-game-load-progress');
        b.send({ type: 'app-message', payload: { type: 'lan-game-load-progress', gameId: launchA.descriptor.gameId, fromPeerId: 'player2', loadPercent: 100 } });
        await b.wait(message => message.type === 'app-message' && (message.payload as { fromPeerId?: string }).fromPeerId === 'player1');
        expect((await b.request('leave-room')).ok).toBe(true);
        expect((await a.request('leave-room')).ok).toBe(true);
        const failed = await outsider.request('join-room', { roomId: '00000000' });
        expect(failed.ok).toBe(false);
        await Promise.all([a.close(), b.close(), outsider.close()]);
    }, 30000);
    for (const exit of ['leave', 'disconnect'] as const) {
        test(`keeps the real online guest logged in after the pre-game host ${exit}`, async () => {
            const endpoint = new URL('/ws', gateway.server.url).toString().replace('http:', 'ws:');
            const host = await BrowserClient.connect(endpoint);
            browsers.push(host);
            const guest = new OnlineSession();
            const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
            const hostName = `host${suffix}`, guestName = `guest${suffix}`;
            const globals = globalThis as any;
            const previousLocation = globals.location;
            try {
                expect((await host.request('login', { user: hostName, pass: 'testpass' })).ok).toBe(true);
                globals.location = { protocol: 'http:', host: gateway.server.url.host };
                try { expect(await guest.login(guestName, 'testpass')).toEqual({ id: guestName, name: guestName }); }
                finally { globals.location = previousLocation; }
                const created = await host.request('create-room');
                expect(created.ok).toBe(true);
                const room = created.data as OnlineRoom;
                expect((await guest.joinRoom(room.id)).members).toHaveLength(2);
                const notice = new Promise<{ level: string; text: string }>(resolve => {
                    guest.onLog.subscribe(entry => { if (entry.text === '房主已退出，房间已关闭。') resolve(entry); });
                });
                if (exit === 'leave') expect((await host.request('leave-room')).ok).toBe(true);
                else await host.close();
                expect(await notice).toMatchObject({ level: 'warn', text: '房主已退出，房间已关闭。' });
                expect(guest.isLoggedIn()).toBe(true);
                expect(guest.getSelf().id).toBe(guestName);
                expect(guest.getRoom()).toBeUndefined();
                expect(await guest.createRoom()).toMatchObject({ hostPeerId: guestName, members: [{ id: guestName, name: guestName }], started: false });
                expect((await guest.listRooms()).some(entry => entry.id === room.id)).toBe(false);
                await guest.leaveRoom();
                expect(guest.isLoggedIn()).toBe(true);
            }
            finally { globals.location = previousLocation; guest.dispose(); await host.close(); }
        }, 15000);
    }
    test('does not echo chat rejected by the upstream-compatible rate limit', async () => {
        const endpoint = new URL('/ws', gateway.server.url).toString().replace('http:', 'ws:');
        const host = await BrowserClient.connect(endpoint), guest = await BrowserClient.connect(endpoint);
        browsers.push(host, guest);
        const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 6);
        expect((await host.request('login', { user: `rateh${suffix}`, pass: 'testpass' })).ok).toBe(true);
        expect((await guest.request('login', { user: `rateg${suffix}`, pass: 'testpass' })).ok).toBe(true);
        const created = await host.request('create-room');
        expect((await guest.request('join-room', { roomId: (created.data as OnlineRoom).id })).ok).toBe(true);
        for (let index = 0; index < 20; index++) {
            const text = `quota-${index}`;
            host.send({ type: 'chat', text });
            const result = await host.wait(message => (message.type === 'chat' && message.text === text) || message.type === 'error');
            if (index < 19) {
                expect(result).toMatchObject({ type: 'chat', text });
                expect(await guest.wait(message => message.type === 'chat' && message.text === text)).toMatchObject({ text });
            }
            else expect(result).toMatchObject({ type: 'error', message: '聊天过于频繁，请稍后再试。' });
        }
        await Bun.sleep(5100);
        host.send({ type: 'chat', text: 'quota-recovered' });
        expect(await guest.wait(message => message.type === 'chat' && message.text === 'quota-recovered')).toMatchObject({ text: 'quota-recovered' });
        await Promise.all([host.close(), guest.close()]);
    }, 15000);
    test('returns real failures instead of static fallback or simulated authentication', async () => {
        const base = gateway.server.url;
        expect((await fetch(new URL('/cdn/missing.mix', base))).status).toBe(404);
        expect((await fetch(new URL('/ws', base), { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
        const browser = await BrowserClient.connect(new URL('/ws', base).toString().replace('http:', 'ws:'));
        browsers.push(browser);
        const rejected = await browser.request('login', { user: 'player1', pass: 'badpass' });
        expect(rejected.ok).toBe(false);
        expect(rejected.error).toContain('378');
        await browser.close();
    });
    test('closes clients and settles requests on daemon shutdown, then restores persisted accounts', async () => {
        const base = gateway.server.url;
        const endpoint = new URL('/ws', base).toString().replace('http:', 'ws:');
        const browser = await BrowserClient.connect(endpoint), retry = await BrowserClient.connect(endpoint);
        browsers.push(browser, retry);
        const user = `save${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
        expect((await browser.request('login', { user, pass: 'testpass' })).ok).toBe(true);
        const closed = new Promise<CloseEvent>(resolve => browser.socket.addEventListener('close', resolve, { once: true }));
        const pending = browser.request('list-rooms').catch(error => { expect(error.message).toBe('Connection closed'); });
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('PvPGN shutdown or request timed out')), 3000); });
        try {
            daemon.kill('SIGQUIT');
            const [code, event] = await Promise.race([Promise.all([daemon.exited, closed, pending]), timeout]);
            expect(code).toBe(0);
            expect(event.code).toBe(1011);
            expect(browser.socket.readyState).toBe(WebSocket.CLOSED);
            const health = await fetch(new URL('/healthz', base), { signal: AbortSignal.timeout(3000) });
            expect(health.status).toBe(503);
            expect(await health.json()).toEqual({ ok: false, pvpgn: false });
            const offline = await Promise.race([retry.request('login', { user, pass: 'testpass' }), timeout]);
            expect(offline.ok).toBe(false);
            expect(offline.error).toContain('PvPGN connection failed');
        }
        finally { clearTimeout(timer!); }
        daemon = Bun.spawn([join(prefix!, 'sbin/bnetd'), '-f', '-c', join(directory, 'bnetd.conf')], { stdout: 'ignore', stderr: 'ignore' });
        const deadline = Date.now() + 5000;
        while (true) {
            const health = await fetch(new URL('/healthz', base), { signal: AbortSignal.timeout(3000) });
            await health.arrayBuffer();
            if (health.ok) break;
            if (Date.now() > deadline) throw new Error('PvPGN restart failed');
            await Bun.sleep(50);
        }
        const rejected = await retry.request('login', { user, pass: 'badpass' });
        expect(rejected.ok).toBe(false);
        expect(rejected.error).toContain('378');
        expect(await retry.request('login', { user, pass: 'testpass' })).toMatchObject({ ok: true, data: { id: user, name: user } });
        expect((await retry.request('create-room')).ok).toBe(true);
        expect((await retry.request('leave-room')).ok).toBe(true);
        await retry.close();
    }, 15000);
});

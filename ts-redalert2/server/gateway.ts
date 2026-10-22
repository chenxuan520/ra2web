import { createConnection } from 'node:net';
import { realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ServerWebSocket } from 'bun';
import type { LanLaunchDescriptor, LanRoomState } from '../src/network/lan/LanRoomSession';
import type { OnlineClientMessage, OnlineIdentity, OnlineRoom, OnlineRoomSummary, OnlineServerMessage } from '../src/network/online/OnlineProtocol';
import { PvpgnConnection, type IrcMessage, wolHash } from './pvpgn';
import { roomConfigSignature } from '../src/network/online/roomConfigSignature';
import { OrderType } from '../src/game/order/OrderType';

interface Client {
    ws?: ServerWebSocket<Client>;
    upstream?: PvpgnConnection;
    identity?: OnlineIdentity;
    channel: string;
    roomId?: string;
    pendingNames: string[];
    list: OnlineRoomSummary[];
    queue: Promise<void>;
    queued: number;
    queuedBytes: number;
    rateStarted: number;
    rateCount: number;
    chatTimes: number[];
    closed: boolean;
    ip: string;
}

interface Room {
    id: string;
    hostPeerId: string;
    members: Map<string, Client>;
    started: boolean;
    starting: boolean;
    joining: number;
    startAcks: Map<string, { gameId: string; timestamp: number }>;
    startWaiter?: { resolve(): void; reject(error: Error): void };
    state?: LanRoomState;
    configSignature?: string;
    launch?: LanLaunchDescriptor;
    ready: Map<string, boolean>;
    loadProgress: Map<string, Record<string, unknown>>;
    lastTick: Map<string, number>;
}

export interface GatewayOptions {
    hostname?: string;
    port?: number;
    pvpgnHost?: string;
    pvpgnPort?: number;
    staticDir?: string;
    assetDir?: string;
    timeoutMs?: number;
    publicOrigin?: string;
    tls?: { cert: string; key: string };
}

const lobby = '#Lob_45_0';
const roomIdPattern = /^[a-z0-9]{6,12}$/;
const usernamePattern = /^[a-zA-Z0-9_\[\]-]{2,15}$/;
const identityFromNick = (name: string): OnlineIdentity => ({ id: name.toLowerCase(), name: name.toLowerCase() });
const channelForRoom = (id: string) => `#ra2_${id}`;
const nickFromPrefix = (prefix: string) => prefix.split('!')[0].replace(/^[@+]/, '').toLowerCase();

function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function validateRoomState(value: unknown, room: OnlineRoom): asserts value is LanRoomState {
    check(isRecord(value) && value.version === 1 && value.hostPeerId === room.hostPeerId && isRecord(value.gameOpts), '房间配置无效。');
    const opts = value.gameOpts;
    check(Number.isInteger(opts.maxSlots) && Number(opts.maxSlots) >= 2 && Number(opts.maxSlots) <= 8 && Number.isInteger(opts.gameMode), '地图玩家数量或模式无效。');
    check(typeof opts.mapName === 'string' && /^[^/\\\\\0\r\n]{1,255}\.(map|mpr)$/i.test(opts.mapName) && typeof opts.mapDigest === 'string' && /^[a-f0-9]{1,8}$/i.test(opts.mapDigest), '地图配置无效。');
    check(typeof opts.mapTitle === 'string' && opts.mapTitle.length <= 255 && Number.isInteger(opts.mapSizeBytes) && Number(opts.mapSizeBytes) > 0 && Number(opts.mapSizeBytes) <= 16 * 1024 * 1024, '地图大小或标题无效。');
    check(Array.isArray(opts.humanPlayers) && opts.humanPlayers.length <= 8 && opts.humanPlayers.every(player => isRecord(player) && typeof player.name === 'string' && room.members.some(member => member.name === player.name) && ['countryId', 'colorId', 'startPos', 'teamId'].every(key => Number.isInteger(player[key]) && Number(player[key]) >= -3 && Number(player[key]) <= 255)), '玩家配置无效。');
    check(Array.isArray(opts.aiPlayers) && opts.aiPlayers.length <= 8 && opts.aiPlayers.every(player => player == null), '在线对战只支持人类玩家。');
    check(Array.isArray(value.memberOrder) && value.memberOrder.every(id => typeof id === 'string' && room.members.some(member => member.id === id)), '房间成员顺序无效。');
    check(Array.isArray(value.humanAssignments) && value.humanAssignments.length <= 8 && value.humanAssignments.every(assignment => isRecord(assignment) && typeof assignment.peerId === 'string' && room.members.some(member => member.id === assignment.peerId && member.name === assignment.name) && Number.isInteger(assignment.slotIndex) && Number(assignment.slotIndex) >= 0 && Number(assignment.slotIndex) < Number(opts.maxSlots)), '玩家槽位无效。');
    check(Array.isArray(value.slotsInfo) && value.slotsInfo.length <= 9 && value.slotsInfo.every(slot => isRecord(slot) && Number.isInteger(slot.type) && Number(slot.type) >= 0 && Number(slot.type) <= 4), '槽位配置无效。');
    check(isRecord(value.readyStateByPeerId) && Object.values(value.readyStateByPeerId).every(ready => typeof ready === 'boolean') && isRecord(value.mapTransferStateByPeerId) && Object.values(value.mapTransferStateByPeerId).every(transfer => isRecord(transfer) && typeof transfer.status === 'string' && ['idle', 'pending', 'sending', 'receiving', 'complete', 'error'].includes(transfer.status) && Number.isFinite(transfer.updatedAt)), '准备或地图传输状态无效。');
}

export function validateActionData(encoded: string): void {
    const bytes = Buffer.from(encoded, 'base64');
    check(bytes.length > 0 && bytes.length <= 65535, '动作数据无效。');
    const count = bytes[0];
    check(count > 0, '动作包不能为空。');
    let position = 1;
    for (let index = 0; index < count; index++) {
        check(position + 3 <= bytes.length, '动作包被截断。');
        const type = bytes[position];
        const length = bytes.readUInt16LE(position + 1);
        position += 3;
        check(type <= 13 && type !== 1 && type !== 4 && position + length <= bytes.length, '动作类型或长度无效。');
        if ([0, 2, 3].includes(type)) check(length === 0, '动作参数长度无效。');
        if ([5, 6, 7, 8].includes(type)) check(type === 5 ? length === 8 : type === 8 ? length <= 512 && length % 4 === 0 : length === 4, '动作参数长度无效。');
        if (type === 9) check(length >= 2 && bytes[position] <= OrderType.PlaceBomb && (bytes[position + 1] === 0 ? length === 2 : bytes[position + 1] === 2 ? length === 6 : bytes[position + 1] === 3 ? length === 7 : bytes[position + 1] === 4 ? length === 11 : bytes[position + 1] === 5 && length === 12), '指令参数长度无效。');
        if (type === 10) check(length >= 2 && bytes[position] <= 5 && bytes[position + 1] <= 4 && ([0, 1, 4].includes(bytes[position + 1]) ? length === 9 : length === 2), '生产参数长度无效。');
        if (type === 11) check(length === 2, '联盟参数长度无效。');
        if (type === 12) check(length >= 6 && (bytes[position + 1] === 2 ? length === 6 : bytes[position + 1] === 4 && length === 10), '超武参数长度无效。');
        if (type === 13) check(length === 4, '地图标记长度无效。');
        position += length;
    }
    check(position === bytes.length, '动作包含有多余数据。');
}

export function validateLaunch(descriptor: LanLaunchDescriptor, state: LanRoomState, room: OnlineRoom, ready: ReadonlyMap<string, boolean>): void {
    check(isRecord(descriptor) && descriptor.kind === 'lan', '无效的开局配置。');
    check(state.version === 1 && state.hostPeerId === room.hostPeerId, '房间配置与房主不一致。');
    check(isDeepStrictEqual(descriptor.gameOpts, state.gameOpts) && isDeepStrictEqual(descriptor.humanAssignments, state.humanAssignments), '房间配置已变更，请重新准备。');
    check(isDeepStrictEqual(descriptor.mapTransferStateByPeerId, state.mapTransferStateByPeerId), '地图状态已变更，请重新准备。');
    const opts = state.gameOpts;
    check(isRecord(opts) && Number.isInteger(opts.maxSlots) && opts.maxSlots >= 2 && opts.maxSlots <= 8, '地图玩家数量无效。');
    check(Array.isArray(opts.humanPlayers) && Array.isArray(opts.aiPlayers) && opts.aiPlayers.every(player => player == null), '在线对战只支持人类玩家。');
    check(typeof opts.mapName === 'string' && opts.mapName.length <= 255 && typeof opts.mapDigest === 'string' && /^[a-f0-9]{1,8}$/i.test(opts.mapDigest), '地图配置无效。');
    check(Number.isInteger(opts.gameSpeed) && opts.gameSpeed >= 0 && opts.gameSpeed <= 6, '游戏速度无效。');
    check(Number.isFinite(opts.credits) && opts.credits >= 0 && opts.credits <= 100000 && Number.isInteger(opts.unitCount) && opts.unitCount >= 0 && opts.unitCount <= 100, '游戏选项无效。');
    check(Array.isArray(state.humanAssignments) && state.humanAssignments.length === room.members.length && opts.humanPlayers.length === room.members.length, '玩家名单不完整。');
    const ids = new Set<string>();
    const slots = new Set<number>();
    const names = new Set<string>();
    for (const assignment of state.humanAssignments) {
        const member = room.members.find(member => member.id === assignment.peerId);
        check(member && member.name === assignment.name && !ids.has(member.id) && !names.has(member.name), '玩家身份不一致。');
        check(Number.isInteger(assignment.slotIndex) && assignment.slotIndex >= 0 && assignment.slotIndex < opts.maxSlots && !slots.has(assignment.slotIndex), '玩家槽位不一致。');
        check(state.slotsInfo?.[assignment.slotIndex]?.name === member.name && state.slotsInfo[assignment.slotIndex].type === 3, '房间槽位尚未同步。');
        check(state.readyStateByPeerId?.[member.id] === true && ready.get(member.id) === true, '所有玩家准备后才能开始。');
        check(state.mapTransferStateByPeerId?.[member.id]?.status === 'complete', '所有玩家地图加载完成后才能开始。');
        ids.add(member.id);
        slots.add(assignment.slotIndex);
        names.add(member.name);
    }
    check(new Set(opts.humanPlayers.map(player => player.name)).size === names.size && opts.humanPlayers.every(player => names.has(player.name)), '玩家名称不能重复或缺失。');
    const combatants = opts.humanPlayers.filter(player => player.countryId !== -3);
    check(combatants.length >= 2, '至少需要两名战斗玩家。');
    check(combatants.some((player, index) => combatants.slice(index + 1).some(other => player.teamId === -2 || other.teamId === -2 || player.teamId !== other.teamId)), '至少需要两个敌对队伍。');
}

export function createGateway(options: GatewayOptions = {}) {
    const host = options.pvpgnHost ?? process.env.PVPGN_HOST ?? '127.0.0.1';
    const port = options.pvpgnPort ?? Number(process.env.PVPGN_PORT ?? 4005);
    const timeoutMs = options.timeoutMs ?? 10000;
    const staticDir = resolve(options.staticDir ?? process.env.STATIC_DIR ?? 'dist');
    const assetDir = options.assetDir ?? process.env.ASSET_DIR;
    const configuredOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
    const publicOrigin = configuredOrigin ? new URL(configuredOrigin).origin : undefined;
    const clients = new Set<Client>();
    const identities = new Map<string, Client>();
    const reserved = new Map<string, Client>();
    const rooms = new Map<string, Room>();
    const loginAttempts = new Map<string, { time: number; count: number }>();

    function send(client: Client, message: OnlineServerMessage): void {
        if (client.closed || !client.ws) return;
        if (client.ws.getBufferedAmount() > 2 * 1024 * 1024) {
            client.ws.close(1013, '连接拥塞，请重新连接。');
            cleanup(client);
            return;
        }
        client.ws.send(JSON.stringify(message));
    }

    function roomSnapshot(room: Room): OnlineRoom {
        return { id: room.id, hostPeerId: room.hostPeerId, members: [...room.members.values()].map(client => client.identity!), started: room.started };
    }

    function publishRoom(room: Room): void {
        const message: OnlineServerMessage = { type: 'room', room: roomSnapshot(room) };
        for (const member of room.members.values()) send(member, message);
    }

    function removeMember(client: Client): void {
        const room = client.roomId ? rooms.get(client.roomId) : undefined;
        client.roomId = undefined;
        if (!room || !client.identity) return;
        room.startWaiter?.reject(new Error('开局期间有玩家离开。'));
        room.members.delete(client.identity.id);
        room.ready.delete(client.identity.id);
        if (!room.members.size || (!room.started && room.hostPeerId === client.identity.id)) {
            rooms.delete(room.id);
            for (const member of room.members.values()) {
                member.roomId = undefined;
                send(member, { type: 'room', room: null });
                send(member, { type: 'error', message: '房主已退出，房间已关闭。', fatal: false });
                member.queue = member.queue.then(async () => {
                    if (!member.upstream || member.closed || member.channel !== channelForRoom(room.id) || member.roomId) return;
                    await member.upstream.exchange([`PART ${channelForRoom(room.id)}`, `JOIN ${lobby}`], message => message.command === '366' && message.params.includes(lobby));
                    member.channel = lobby;
                }).catch(() => member.ws?.close(1011, '大厅连接已断开。'));
            }
            return;
        }
        publishRoom(room);
    }

    function disconnectUpstream(client: Client): void {
        const upstream = client.upstream;
        client.upstream = undefined;
        upstream?.destroy();
    }

    function cleanup(client: Client): void {
        if (client.closed) return;
        client.closed = true;
        removeMember(client);
        disconnectUpstream(client);
        clients.delete(client);
        if (client.identity && identities.get(client.identity.id) === client) identities.delete(client.identity.id);
        for (const [id, owner] of reserved) if (owner === client) reserved.delete(id);
    }

    function onIrc(client: Client, message: IrcMessage): void {
        if (message.command === '353') {
            client.pendingNames.push(...(message.trailing ?? '').split(/ +/).filter(Boolean));
        }
        else if (message.command === 'PART' && message.params[0]?.startsWith('#ra2_')) {
            const departing = identities.get(nickFromPrefix(message.prefix));
            if (departing?.roomId && channelForRoom(departing.roomId) === message.params[0]) {
                removeMember(departing);
                send(departing, { type: 'room', room: null });
            }
        }
        else if (message.command === 'PRIVMSG') {
            const room = client.roomId ? rooms.get(client.roomId) : undefined;
            const from = identities.get(nickFromPrefix(message.prefix))?.identity;
            if (room && from && room.members.has(from.id) && message.params[0] === channelForRoom(room.id)) {
                send(client, { type: 'chat', from, text: message.trailing ?? '', timestamp: Date.now() });
            }
        }
        else if (message.command === 'STARTG') {
            const room = client.roomId ? rooms.get(client.roomId) : undefined;
            const metadata = message.trailing?.match(/:(\d+) (\d+)\s*$/);
            if (room?.starting && client.identity && metadata && nickFromPrefix(message.prefix) === room.hostPeerId && message.params[0]?.toLowerCase() === client.identity.id) {
                room.startAcks.set(client.identity.id, { gameId: metadata[1], timestamp: Number(metadata[2]) * 1000 });
                if (room.startAcks.size === room.members.size) room.startWaiter?.resolve();
            }
        }
        else if (message.command === '326') {
            const [, channel, count, maximum, gameType] = message.params;
            const id = channel?.replace(/^#ra2_/, '');
            const room = id ? rooms.get(id) : undefined;
            if (room && gameType === '45' && !room.started && !room.starting && Number.isInteger(Number(count))) {
                client.list.push({ id: room.id, hostName: room.members.get(room.hostPeerId)?.identity?.name ?? '', playerCount: Number(count), maxPlayers: Math.min(Number(maximum), room.state?.gameOpts.maxSlots ?? 8), mapTitle: room.state?.gameOpts.mapTitle ?? '' });
            }
        }
    }

    async function login(client: Client, message: Extract<OnlineClientMessage, { type: 'login' }>): Promise<OnlineIdentity> {
        check(!client.identity && typeof message.user === 'string' && usernamePattern.test(message.user), '用户名须为 2–15 个英文字母、数字或 -_[]。');
        const passwordHash = wolHash(message.pass);
        const id = message.user.toLowerCase();
        check(!identities.has(id) && !reserved.has(id), '该用户已经登录。');
        const now = Date.now();
        for (const [ip, entry] of loginAttempts) if (now - entry.time > 60000) loginAttempts.delete(ip);
        const attempt = loginAttempts.get(client.ip) ?? { time: now, count: 0 };
        check(++attempt.count <= 20, '登录尝试过多，请稍后再试。');
        loginAttempts.set(client.ip, attempt);
        reserved.set(id, client);
        disconnectUpstream(client);
        let upstream: PvpgnConnection;
        upstream = new PvpgnConnection(host, port, timeoutMs, response => onIrc(client, response), () => {
            if (client.upstream !== upstream) return;
            client.upstream = undefined;
            if (client.identity && !client.closed) {
                send(client, { type: 'error', message: 'PvPGN 连接已断开，请重新登录。' });
                client.ws?.close(1011, 'PvPGN 连接已断开。');
                cleanup(client);
            }
        });
        client.upstream = upstream;
        try {
            await upstream.connected;
            const accepted = await upstream.exchange(['CVERS 0 16640', `APGAR ${passwordHash}`, `NICK ${id}`, `USER ${id} 0 * :${id}`], response => response.command === '376');
            check(accepted.params[0]?.toLowerCase() === id, 'PvPGN 返回了不一致的身份。');
            await upstream.exchange([`JOIN ${lobby}`], response => response.command === '366' && response.params.includes(lobby));
            check(!client.closed, '连接已关闭。');
            client.identity = identityFromNick(id);
            identities.set(id, client);
            client.channel = lobby;
            return client.identity;
        }
        catch (error) {
            disconnectUpstream(client);
            throw error;
        }
        finally {
            reserved.delete(id);
        }
    }

    async function joinRoom(client: Client, room: Room, create: boolean): Promise<OnlineRoom> {
        check(!client.roomId && !room.started && !room.starting, '请先退出当前房间，或选择未开始的房间。');
        check(room.members.size + room.joining < (room.state?.gameOpts.maxSlots ?? 8), '房间已满。');
        room.joining++;
        const channel = channelForRoom(room.id);
        client.pendingNames = [];
        try {
            await client.upstream!.exchange([`PART ${client.channel}`, create ? `JOINGAME ${channel} 1 8 45 1 1 0 0` : `JOINGAME ${channel} 0`], response => response.command === '366' && response.params.includes(channel));
            const names = client.pendingNames.map(name => name.replace(/^[@+]/, '').split(',')[0].toLowerCase());
            check(names.includes(client.identity!.id) && names.includes(room.hostPeerId) && client.pendingNames.some(name => name.startsWith('@') && name.slice(1).split(',')[0].toLowerCase() === room.hostPeerId), 'PvPGN 房间成员验证失败。');
            check(!client.closed && rooms.get(room.id) === room && !room.started && !room.starting, '房间已关闭或已经开始。');
            client.roomId = room.id;
            client.channel = channel;
            room.members.set(client.identity!.id, client);
            room.ready.set(client.identity!.id, false);
            publishRoom(room);
            if (room.state) send(client, { type: 'app-message', from: room.members.get(room.hostPeerId)!.identity!, payload: { type: 'state-sync', state: room.state }, timestamp: Date.now() });
            return roomSnapshot(room);
        }
        catch (error) {
            if (create) rooms.delete(room.id);
            await client.upstream?.exchange([`PART ${channel}`, `JOIN ${lobby}`], response => response.command === '366' && response.params.includes(lobby)).catch(() => undefined);
            client.channel = lobby;
            throw error;
        }
        finally {
            room.joining--;
        }
    }

    function relay(client: Client, message: Extract<OnlineClientMessage, { type: 'app-message' }>): void {
        const room = client.roomId ? rooms.get(client.roomId) : undefined;
        check(room && client.identity && isRecord(message.payload) && typeof message.payload.type === 'string', '请先加入房间。');
        const payload = message.payload;
        const type = payload.type as string;
        const id = client.identity.id;
        check(['state-sync', 'slot-request', 'ready', 'map-offer', 'map-chunk', 'map-complete', 'lan-game-turn', 'lan-game-load-progress'].includes(type), '应用消息类型无效。');
        check(!message.targetPeerId || !message.excludedPeerId, '不能同时指定目标与排除玩家。');
        if (['slot-request', 'ready', 'map-complete'].includes(type)) check(message.targetPeerId === room.hostPeerId, '该消息只能发送给房主。');
        if (['lan-game-turn', 'lan-game-load-progress', 'state-sync'].includes(type)) check(!message.targetPeerId && !message.excludedPeerId, '房间状态与对局消息必须广播。');
        if (['state-sync', 'map-offer', 'map-chunk'].includes(type)) check(room.hostPeerId === id && !room.started && !room.starting, '只有房主可以同步房间配置。');
        if (['slot-request', 'ready', 'map-complete'].includes(type)) check(payload.peerId === id && !room.started && !room.starting, '玩家身份或房间状态无效。');
        if (payload.type === 'state-sync') {
            validateRoomState(payload.state, roomSnapshot(room));
            const state = payload.state;
            const signature = roomConfigSignature(state);
            if (room.configSignature !== signature) room.ready.clear();
            room.configSignature = signature;
            room.state = structuredClone(state);
            room.ready.set(id, state.readyStateByPeerId?.[id] === true);
            const summary = Buffer.from(JSON.stringify({ mapName: state.gameOpts.mapName, mapDigest: state.gameOpts.mapDigest, gameSpeed: state.gameOpts.gameSpeed })).toString('base64');
            client.upstream!.send(`GAMEOPT ${channelForRoom(room.id)} :RA2WEB ${summary}`);
        }
        else if (payload.type === 'ready') {
            check(typeof payload.ready === 'boolean', '准备状态无效。');
            check(payload.configSignature === room.configSignature, '房间配置已变更，请重新准备。');
            room.ready.set(id, payload.ready);
        }
        else if (payload.type === 'slot-request') {
            check(room.state?.humanAssignments.some(assignment => assignment.peerId === id && assignment.slotIndex === payload.slotIndex), '玩家只能修改自己的槽位。');
            check(['countryId', 'colorId', 'startPos', 'teamId'].every(key => Number.isInteger(payload[key]) && Number(payload[key]) >= -3 && Number(payload[key]) <= 255), '玩家选项无效。');
        }
        else if (payload.type === 'map-offer' || payload.type === 'map-chunk') {
            check(message.targetPeerId && message.targetPeerId !== id && payload.peerId === message.targetPeerId && payload.digest === room.state?.gameOpts.mapDigest && Number.isInteger(payload.totalChunks) && Number(payload.totalChunks) >= 1 && Number(payload.totalChunks) <= 8192, '地图传输身份无效。');
            if (payload.type === 'map-offer') check(payload.filename === room.state?.gameOpts.mapName && payload.sizeBytes === room.state?.gameOpts.mapSizeBytes, '地图传输配置无效。');
            else check(Number.isInteger(payload.index) && Number(payload.index) >= 0 && Number(payload.index) < Number(payload.totalChunks) && typeof payload.data === 'string' && payload.data.length <= 16384 && /^[A-Za-z0-9+/=]+$/.test(payload.data), '地图分片无效。');
        }
        else if (payload.type === 'map-complete') {
            check(typeof payload.ok === 'boolean' && payload.digest === room.state?.gameOpts.mapDigest, '地图完成状态无效。');
        }
        else if (payload.type === 'lan-game-load-progress' || payload.type === 'lan-game-turn') {
            check(room.started && room.launch && payload.gameId === room.launch.gameId && payload.fromPeerId === id, '对局或发送者身份无效。');
            if (payload.type === 'lan-game-load-progress') {
                check(Number.isFinite(payload.loadPercent) && Number(payload.loadPercent) >= 0 && Number(payload.loadPercent) <= 100, '加载进度无效。');
                for (const [peerId, progress] of room.loadProgress) {
                    const from = room.launch.humanAssignments.find(assignment => assignment.peerId === peerId);
                    if (from && peerId !== id) send(client, { type: 'app-message', from: { id: peerId, name: from.name }, payload: progress, timestamp: Date.now() });
                }
                room.loadProgress.set(id, structuredClone(payload));
            }
            else {
                check(Number.isInteger(payload.tick) && Number(payload.tick) >= 0 && Number(payload.tick) <= (room.lastTick.get(id) ?? -1) + 2, '对局帧编号无效。');
                check(typeof payload.turnId === 'string' && payload.turnId.startsWith(`${id}:${payload.tick}:`) && payload.turnId.length <= 100, '对局帧身份无效。');
                check(typeof payload.actionData === 'string' && payload.actionData.length <= 87384 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.actionData), '动作数据无效。');
                validateActionData(payload.actionData);
                check(Array.isArray(payload.dropPeerIds) && payload.dropPeerIds.every(peerId => typeof peerId === 'string' && room.launch!.humanAssignments.some(assignment => assignment.peerId === peerId) && !room.members.has(peerId)), '掉线玩家名单无效。');
                room.lastTick.set(id, Math.max(room.lastTick.get(id) ?? -1, Number(payload.tick)));
            }
        }
        if (message.targetPeerId) check(room.members.has(message.targetPeerId), '目标玩家不在当前房间。');
        check(!message.excludedPeerId || room.members.has(message.excludedPeerId), '排除的玩家不在当前房间。');
        for (const [peerId, member] of room.members) {
            if (peerId === id || peerId === message.excludedPeerId || (message.targetPeerId && peerId !== message.targetPeerId)) continue;
            send(member, { type: 'app-message', from: client.identity, payload, timestamp: Date.now() });
        }
    }

    async function startGame(client: Client, descriptor: LanLaunchDescriptor): Promise<void> {
        const room = client.roomId ? rooms.get(client.roomId) : undefined;
        check(room && room.state && client.identity?.id === room.hostPeerId && !room.started && !room.starting, '只有房主可以开始尚未开始的游戏。');
        validateLaunch(descriptor, room.state, roomSnapshot(room), room.ready);
        check(room.joining === 0, '还有玩家正在加入，请稍后再试。');
        room.starting = true;
        room.startAcks.clear();
        const acknowledgements = new Promise<void>((resolve, reject) => { room.startWaiter = { resolve, reject }; });
        const timer = setTimeout(() => room.startWaiter?.reject(new Error('PvPGN 开局确认超时。')), timeoutMs);
        try {
            await Promise.all([
                client.upstream!.exchange([`STARTG ${channelForRoom(room.id)} ${[...room.members.keys()].join(',')}`], message => message.command === 'STARTG'),
                acknowledgements,
            ]);
            const metadata = room.startAcks.get(room.hostPeerId);
            check(metadata && [...room.startAcks.values()].every(ack => isDeepStrictEqual(ack, metadata)), 'PvPGN 开局响应不一致。');
            check(rooms.get(room.id) === room && room.members.size === room.state.humanAssignments.length, '开局期间有玩家离开。');
            const base = structuredClone(descriptor);
            base.roomId = room.id;
            base.gameId = metadata.gameId;
            base.timestamp = metadata.timestamp;
            base.hostPeerId = room.hostPeerId;
            base.returnRoute = { screenType: 22, params: {} };
            room.launch = base;
            room.started = true;
            publishRoom(room);
            for (const member of room.members.values()) {
                send(member, { type: 'launch', descriptor: { ...base, localPeerId: member.identity!.id, localPlayerName: member.identity!.name } });
            }
        }
        catch (error) {
            for (const member of [...room.members.values()]) {
                send(member, { type: 'error', message: '开局失败，请重新登录并创建房间。' });
                member.ws?.close(1011, '开局失败。');
                cleanup(member);
            }
            throw error;
        }
        finally {
            clearTimeout(timer);
            room.startWaiter = undefined;
            room.starting = false;
        }
    }

    async function handle(client: Client, message: OnlineClientMessage): Promise<unknown> {
        if (message.type === 'login') return login(client, message);
        check(client.identity && client.upstream, '请先登录。');
        switch (message.type) {
            case 'list-rooms':
                client.list = [];
                await client.upstream.exchange(['LIST'], response => response.command === '323');
                return client.list;
            case 'create-room': {
                check(!client.roomId, '请先退出当前房间。');
                const id = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
                const room: Room = { id, hostPeerId: client.identity.id, members: new Map(), started: false, starting: false, joining: 0, startAcks: new Map(), ready: new Map(), loadProgress: new Map(), lastTick: new Map() };
                rooms.set(id, room);
                return joinRoom(client, room, true);
            }
            case 'join-room': {
                check(typeof message.roomId === 'string' && roomIdPattern.test(message.roomId), '房间编号无效。');
                const room = rooms.get(message.roomId);
                check(room, '房间不存在或已关闭。');
                return joinRoom(client, room, false);
            }
            case 'leave-room':
                await client.upstream.exchange([`PART ${client.channel}`, `JOIN ${lobby}`], response => response.command === '366' && response.params.includes(lobby));
                removeMember(client);
                client.channel = lobby;
                send(client, { type: 'room', room: null });
                return undefined;
            case 'start-game':
                return startGame(client, message.descriptor);
            case 'chat': {
                check(client.roomId && typeof message.text === 'string' && message.text.trim().length > 0 && !message.text.trimStart().startsWith('/') && Buffer.byteLength(message.text) <= 200 && !/[\r\n\0]/.test(message.text), '聊天消息无效：最多 200 字节，不能以 / 开头。');
                const now = Date.now();
                client.chatTimes = client.chatTimes.filter(time => now - time < 5000);
                check(client.chatTimes.length < 19, '聊天过于频繁，请稍后再试。');
                client.upstream.send(`PRIVMSG ${channelForRoom(client.roomId)} :${message.text}`);
                client.chatTimes.push(now);
                send(client, { type: 'chat', from: client.identity, text: message.text, timestamp: now });
                return undefined;
            }
            case 'app-message':
                relay(client, message);
                return undefined;
            default:
                throw new Error('未知的联机请求。');
        }
    }

    async function health(): Promise<boolean> {
        if (!await Bun.file(join(staticDir, 'index.html')).exists()) return false;
        return new Promise<boolean>(resolveHealth => {
            const socket = createConnection({ host, port });
            const timer = setTimeout(() => done(false), Math.min(timeoutMs, 3000));
            const done = (ok: boolean) => { clearTimeout(timer); socket.destroy(); resolveHealth(ok); };
            socket.once('connect', () => done(true));
            socket.once('error', () => done(false));
        });
    }

    const tls = options.tls ?? (process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE ? { cert: process.env.TLS_CERT_FILE, key: process.env.TLS_KEY_FILE } : undefined);
    const server = Bun.serve<Client>({
        hostname: options.hostname ?? '0.0.0.0',
        port: options.port ?? Number(process.env.HTTP_PORT ?? 8080),
        ...(tls ? { tls: { cert: Bun.file(tls.cert), key: Bun.file(tls.key) } } : {}),
        async fetch(request, server) {
            const url = new URL(request.url);
            if (url.pathname === '/healthz') {
                const ok = await health();
                return Response.json({ ok, pvpgn: ok }, { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
            }
            if (url.pathname === '/ws') {
                const origin = request.headers.get('origin');
                if (origin && origin !== (publicOrigin ?? url.origin)) return new Response('Forbidden', { status: 403 });
                if (clients.size >= 256) return new Response('Busy', { status: 503 });
                const client: Client = { channel: lobby, pendingNames: [], list: [], queue: Promise.resolve(), queued: 0, queuedBytes: 0, rateStarted: Date.now(), rateCount: 0, chatTimes: [], closed: false, ip: server.requestIP(request)?.address ?? 'unknown' };
                if (server.upgrade(request, { data: client })) return;
                return new Response('WebSocket required', { status: 426 });
            }
            if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
            try {
                const path = decodeURIComponent(url.pathname);
                check(!path.includes('\0') && !path.includes('\\') && !path.split('/').some(part => part.startsWith('.')), '无效路径。');
                const base = path.startsWith('/cdn/') && assetDir ? resolve(assetDir) : staticDir;
                const relative = path.startsWith('/cdn/') && assetDir ? path.slice(5) : path === '/' ? 'index.html' : path.slice(1);
                const target = resolve(base, relative);
                check(target.startsWith(base + sep), '无效路径。');
                const fileInfo = await stat(target).catch(() => undefined);
                if (!fileInfo?.isFile()) return new Response('Not found', { status: 404 });
                const real = await realpath(target);
                check(real.startsWith((await realpath(base)) + sep), '无效路径。');
                return new Response(request.method === 'HEAD' ? null : Bun.file(real), { headers: {
                    'Content-Length': String(fileInfo.size),
                    'Cross-Origin-Opener-Policy': 'same-origin',
                    'Cross-Origin-Embedder-Policy': 'require-corp',
                    'X-Content-Type-Options': 'nosniff',
                    'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
                } });
            }
            catch {
                return new Response('Bad request', { status: 400 });
            }
        },
        websocket: {
            maxPayloadLength: 128 * 1024,
            idleTimeout: 120,
            sendPings: true,
            open(ws) { ws.data.ws = ws; clients.add(ws.data); },
            message(ws, raw) {
                const client = ws.data;
                const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
                if (Date.now() - client.rateStarted > 1000) { client.rateStarted = Date.now(); client.rateCount = 0; }
                if (++client.rateCount > 240 || client.queued >= 128 || client.queuedBytes + size > 1024 * 1024 || typeof raw !== 'string') {
                    ws.close(1008, '请求过多或格式无效。');
                    cleanup(client);
                    return;
                }
                let message: OnlineClientMessage;
                try {
                    const parsed: unknown = JSON.parse(raw);
                    check(isRecord(parsed) && typeof parsed.type === 'string', '请求格式无效。');
                    if (parsed.type !== 'chat' && parsed.type !== 'app-message') check(typeof parsed.requestId === 'string' && parsed.requestId.length > 0 && parsed.requestId.length <= 100, '请求编号无效。');
                    message = parsed as unknown as OnlineClientMessage;
                }
                catch {
                    send(client, { type: 'error', message: '请求格式无效。' });
                    return;
                }
                client.queued++;
                client.queuedBytes += size;
                client.queue = client.queue.then(async () => {
                    if (client.closed) return;
                    const requestId = 'requestId' in message ? message.requestId : undefined;
                    try {
                        const data = await handle(client, message);
                        if (requestId) send(client, { type: 'result', requestId, ok: true, data });
                    }
                    catch (error) {
                        const text = error instanceof Error ? error.message : '联机操作失败。';
                        if (requestId) send(client, { type: 'result', requestId, ok: false, error: text });
                        else send(client, { type: 'error', message: text });
                    }
                }).finally(() => { client.queued--; client.queuedBytes -= size; });
            },
            close(ws) { cleanup(ws.data); },
        },
    });
    return { server, stop: async () => {
        const activeClients = [...clients];
        void server.stop(true);
        for (const client of activeClients) cleanup(client);
        await Promise.all(activeClients.map(client => client.queue));
    } };
}

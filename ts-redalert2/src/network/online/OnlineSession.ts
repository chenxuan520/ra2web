import type { LanMatchTransport } from '@/network/lan/LanMatchSession';
import type { LanMeshAppMessage, LanMeshChatEntry, LanMeshLogEntry, LanMeshSnapshot } from '@/network/lan/LanMeshSession';
import type { LanLaunchDescriptor, LanRoomState, LanRoomTransport } from '@/network/lan/LanRoomSession';
import type { OnlineClientMessage, OnlineIdentity, OnlineRequest, OnlineRoom, OnlineRoomSummary, OnlineServerMessage } from './OnlineProtocol';
import { EventDispatcher } from '@/util/event';
import { roomConfigSignature } from './roomConfigSignature';

type RequestFields<T> = T extends OnlineRequest ? Omit<T, 'requestId'> : never;

const REQUEST_TIMEOUT = 20000;

export class OnlineSession implements LanRoomTransport, LanMatchTransport {
    private socket?: WebSocket;
    private identity?: OnlineIdentity;
    private room?: OnlineRoom;
    private roomState?: LanRoomState;
    private stateSignature?: string;
    private error?: string;
    private disposed = false;
    private requestCounter = 0;
    private connectTimer?: ReturnType<typeof setTimeout>;
    private rejectConnect?: (error: Error) => void;
    private launchTimer?: ReturnType<typeof setTimeout>;
    private pendingLaunch?: LanLaunchDescriptor;
    private launchDescriptor?: LanLaunchDescriptor;
    private matchAttached = false;
    private matchMessages: LanMeshAppMessage[] = [];
    private mapSendQueue = Promise.resolve();
    private pending = new Map<string, {
        resolve: (data: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();

    public readonly onSnapshotChange = new EventDispatcher<LanRoomTransport, LanMeshSnapshot>() as EventDispatcher<LanRoomTransport, LanMeshSnapshot> & LanMatchTransport['onSnapshotChange'];
    public readonly onAppMessage = new EventDispatcher<LanRoomTransport, LanMeshAppMessage>() as EventDispatcher<LanRoomTransport, LanMeshAppMessage> & LanMatchTransport['onAppMessage'];
    public readonly onChat = new EventDispatcher<this, LanMeshChatEntry>();
    public readonly onLog = new EventDispatcher<this, LanMeshLogEntry>();
    public readonly onLaunch = new EventDispatcher<this, LanLaunchDescriptor>();

    getSelf(): OnlineIdentity {
        return this.identity ? { ...this.identity } : { id: '', name: '' };
    }

    getRoom(): OnlineRoom | undefined {
        return this.room ? structuredClone(this.room) : undefined;
    }

    getError(): string | undefined {
        return this.error;
    }

    isLoggedIn(): boolean {
        return Boolean(this.identity && this.socket?.readyState === WebSocket.OPEN);
    }

    isDisposed(): boolean {
        return this.disposed;
    }

    isRoomStateSynced(): boolean {
        return Boolean(this.room && this.roomState && this.roomState.humanAssignments.length === this.room.members.length &&
            this.room.members.every((member) => this.roomState!.humanAssignments.some((assignment) => assignment.peerId === member.id)));
    }

    getSnapshot(): LanMeshSnapshot {
        const self = this.getSelf();
        return {
            self,
            roomId: this.room?.id,
            isInRoom: Boolean(this.room && this.isLoggedIn()),
            roomReady: Boolean(this.room && this.isLoggedIn()),
            directPeerCount: this.room?.members.filter((member) => member.id !== self.id).length ?? 0,
            members: (this.room?.members ?? []).map((member) => ({
                ...member,
                isSelf: member.id === self.id,
                isDirect: true,
                status: 'connected',
            })),
            activeQrPayloadText: '',
        };
    }

    ensureLocalRoom(): LanMeshSnapshot {
        this.requireRoom();
        return this.getSnapshot();
    }

    async login(user: string, pass: string): Promise<OnlineIdentity> {
        if (!/^[A-Za-z0-9_\[\]-]{2,15}$/.test(user)) {
            throw new Error('用户名必须为 2–15 位 ASCII 字母、数字或 _-[]。');
        }
        if (!/^[\x20-\x7e]{1,8}$/.test(pass)) {
            throw new Error('密码必须为 1–8 位可打印 ASCII 字符。');
        }
        if (this.socket || this.disposed) {
            throw new Error('请先退出当前在线会话再登录。');
        }
        this.error = undefined;
        try {
            await this.connect();
            const identity = await this.request<OnlineIdentity>({ type: 'login', user, pass });
            if (!identity || typeof identity.id !== 'string' || !identity.id || typeof identity.name !== 'string' || !identity.name) {
                throw new Error('在线服务没有返回有效的 PvPGN 身份。');
            }
            this.identity = { ...identity };
            this.dispatchSnapshot();
            return this.getSelf();
        }
        catch (error) {
            this.fail(error as Error);
            throw error;
        }
    }

    async listRooms(): Promise<OnlineRoomSummary[]> {
        this.requireLogin();
        const rooms = await this.request<OnlineRoomSummary[]>({ type: 'list-rooms' });
        if (!Array.isArray(rooms)) {
            throw new Error('在线服务返回的房间列表无效。');
        }
        return rooms;
    }

    async createRoom(): Promise<OnlineRoom> {
        this.requireLogin();
        const room = await this.request<OnlineRoom>({ type: 'create-room' });
        if (!this.room && room?.id) {
            this.updateRoom(room);
        }
        return this.requireRoom();
    }

    async joinRoom(roomId: string): Promise<OnlineRoom> {
        this.requireLogin();
        if (!roomId.trim()) {
            throw new Error('请输入房间号。');
        }
        const room = await this.request<OnlineRoom>({ type: 'join-room', roomId: roomId.trim() });
        if (!this.room && room?.id) {
            this.updateRoom(room);
        }
        return this.requireRoom();
    }

    leaveRoom(): Promise<void> {
        if (!this.room) {
            return Promise.resolve();
        }
        if (this.launchDescriptor) {
            this.dispose();
            return Promise.resolve();
        }
        const operation = this.request<void>({ type: 'leave-room' }).catch((error) => {
            this.fail(error);
            throw error;
        });
        this.clearRoom();
        this.dispatchSnapshot();
        void operation.catch(() => undefined);
        return operation;
    }

    async startGame(descriptor: LanLaunchDescriptor): Promise<void> {
        const room = this.requireRoom();
        if (room.hostPeerId !== this.getSelf().id || room.started || descriptor.roomId !== room.id) {
            throw new Error('只有当前房主可以请求服务端开始游戏。');
        }
        await this.request<void>({ type: 'start-game', descriptor });
    }

    async sendChat(text: string): Promise<void> {
        this.requireRoom();
        if (new TextEncoder().encode(text).length > 200 || text.trimStart().startsWith('/') || /[\r\n\0]/.test(text)) {
            throw new Error('聊天消息最多 200 字节，不能以 / 开头或包含换行、空字符。');
        }
        if (text.trim()) {
            this.send({ type: 'chat', text: text.trim() });
        }
    }

    sendAppMessage(peerId: string, payload: unknown): void | Promise<void> {
        const room = this.requireRoom();
        this.checkAppMessage(payload);
        if ((payload as { type?: string })?.type === 'ready') {
            payload = { ...(payload as Record<string, unknown>), configSignature: this.stateSignature };
        }
        const message = { type: 'app-message' as const, targetPeerId: peerId, payload };
        if ((payload as { type?: string })?.type === 'map-chunk') {
            const digest = (payload as { digest: string }).digest;
            const operation = this.mapSendQueue.then(async () => {
                await new Promise<void>(resolve => setTimeout(resolve, 25));
                if (!this.isLoggedIn() || this.room?.id !== room.id || this.room.started || this.roomState?.gameOpts.mapDigest !== digest || this.roomState.mapTransferStateByPeerId[peerId]?.status !== 'sending' || !this.room.members.some(member => member.id === peerId)) return;
                this.send(message);
            });
            this.mapSendQueue = operation.catch(() => undefined);
            return operation;
        }
        this.send(message);
    }

    broadcastAppMessage(payload: unknown, excludedPeerId?: string): void {
        const room = this.requireRoom();
        this.checkAppMessage(payload);
        if (this.isStateSync(payload)) {
            if (room.started) {
                return;
            }
            if (room.hostPeerId !== this.getSelf().id) {
                throw new Error('只有房主可以同步房间配置。');
            }
            const state = this.updateState(payload.state);
            payload = { type: 'state-sync', state };
            this.onAppMessage.dispatch(this, { from: this.getSelf(), payload, timestamp: Date.now() });
        }
        this.send({ type: 'app-message', payload, excludedPeerId });
    }

    flushMatchMessages(): void {
        if (!this.launchDescriptor) {
            throw new Error('尚未收到服务端开局消息。');
        }
        this.matchAttached = true;
        const messages = this.matchMessages;
        this.matchMessages = [];
        messages.forEach((entry) => this.onAppMessage.dispatch(this, entry));
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.closeConnection(new Error('在线会话已关闭。'));
        this.dispatchSnapshot();
    }

    private connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.rejectConnect = reject;
            const socket = this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
            this.connectTimer = setTimeout(() => this.fail(new Error('在线连接超时，请检查 WebSocket 网关及 PvPGN。')), REQUEST_TIMEOUT);
            socket.onopen = () => {
                clearTimeout(this.connectTimer);
                this.connectTimer = undefined;
                this.rejectConnect = undefined;
                resolve();
            };
            socket.onmessage = (event) => {
                let message: OnlineServerMessage;
                try {
                    message = JSON.parse(event.data);
                }
                catch {
                    this.fail(new Error('在线服务返回了无效消息。'));
                    return;
                }
                if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
                    this.fail(new Error('在线服务返回了无效消息。'));
                    return;
                }
                this.handleMessage(message);
            };
            socket.onerror = () => this.fail(new Error('在线连接失败，请检查 WebSocket 网关及 PvPGN。'));
            socket.onclose = () => this.fail(new Error('在线连接已断开，房间和待处理请求已清除，请重新登录。'));
        });
    }

    private request<T>(message: RequestFields<OnlineRequest>): Promise<T> {
        const requestId = String(++this.requestCounter);
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => this.fail(new Error(`在线请求 ${message.type} 超时。`)), REQUEST_TIMEOUT);
            this.pending.set(requestId, { resolve: (data) => resolve(data as T), reject, timer });
            try {
                this.send({ ...message, requestId });
            }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(error);
            }
        });
    }

    private send(message: OnlineClientMessage): void {
        if (this.disposed || this.socket?.readyState !== WebSocket.OPEN) {
            throw new Error('在线连接不可用，请重新登录。');
        }
        this.socket.send(JSON.stringify(message));
    }

    private requireLogin(): void {
        if (!this.isLoggedIn()) {
            throw new Error('请先登录 PvPGN。');
        }
    }

    private requireRoom(): OnlineRoom {
        this.requireLogin();
        if (!this.room) {
            throw new Error('请先通过在线服务创建或加入房间。');
        }
        return structuredClone(this.room);
    }

    private checkAppMessage(payload: unknown): void {
        const type = (payload as { type?: string })?.type;
        if (type === 'start-game' || type === 'host-handover') {
            throw new Error('在线房主与开局只能由服务端决定。');
        }
    }

    private isStateSync(payload: unknown): payload is { type: 'state-sync'; state: LanRoomState } {
        return Boolean(payload && typeof payload === 'object' && (payload as { type?: string }).type === 'state-sync');
    }

    private updateState(state: LanRoomState): LanRoomState {
        const next = structuredClone(state);
        const signature = roomConfigSignature(next);
        if (signature !== this.stateSignature) {
            Object.keys(next.readyStateByPeerId).forEach((peerId) => next.readyStateByPeerId[peerId] = false);
            if (next.gameOpts.mapDigest !== this.roomState?.gameOpts.mapDigest) {
                next.mapTransferStateByPeerId = Object.fromEntries((this.room?.members ?? []).map((member) => [member.id, {
                    status: member.id === next.hostPeerId || next.gameOpts.mapOfficial ? 'complete' : 'pending',
                    totalBytes: next.gameOpts.mapSizeBytes,
                    receivedBytes: member.id === next.hostPeerId || next.gameOpts.mapOfficial ? next.gameOpts.mapSizeBytes : 0,
                    updatedAt: Date.now(),
                }]));
            }
        }
        this.stateSignature = signature;
        this.roomState = next;
        return next;
    }

    private updateRoom(room: OnlineRoom | null): void {
        if (!room || (this.room && room.id !== this.room.id)) {
            this.clearRoom();
        }
        this.room = room ? structuredClone(room) : undefined;
        this.dispatchSnapshot();
        this.tryLaunch();
    }

    private handleMessage(message: OnlineServerMessage): void {
        if (message.type === 'result') {
            const pending = this.pending.get(message.requestId);
            if (!pending) {
                return;
            }
            clearTimeout(pending.timer);
            this.pending.delete(message.requestId);
            if (message.ok) {
                pending.resolve(message.data);
            }
            else {
                const error = new Error(message.error || '在线服务拒绝了请求。');
                this.log('error', error.message);
                pending.reject(error);
            }
            return;
        }
        if (message.type === 'error') {
            if (message.fatal === false) this.log('warn', message.message);
            else this.fail(new Error(message.message));
            return;
        }
        if (message.type === 'room') {
            this.updateRoom(message.room);
            return;
        }
        if (message.type === 'chat') {
            this.onChat.dispatch(this, { from: message.from, text: message.text, timestamp: message.timestamp });
            return;
        }
        if (message.type === 'app-message') {
            if (!this.room || !this.room.members.some((member) => member.id === message.from.id)) {
                return;
            }
            const entry: LanMeshAppMessage = { from: message.from, payload: message.payload, timestamp: message.timestamp };
            const type = (entry.payload as { type?: string })?.type;
            if (type === 'start-game' || type === 'host-handover') {
                return;
            }
            if (type === 'ready' && this.room.hostPeerId === this.getSelf().id &&
                (entry.payload as { configSignature?: string }).configSignature !== this.stateSignature) {
                return;
            }
            if (type === 'lan-game-load-progress' || type === 'lan-game-turn') {
                if (this.matchAttached) {
                    this.onAppMessage.dispatch(this, entry);
                }
                else if (this.matchMessages.length < 4096) {
                    this.matchMessages.push(entry);
                }
                else {
                    this.fail(new Error('开局消息缓冲已满，连接已关闭。'));
                }
                return;
            }
            if (this.isStateSync(entry.payload)) {
                if (message.from.id !== this.room.hostPeerId || this.launchDescriptor) {
                    return;
                }
                entry.payload = { type: 'state-sync', state: this.updateState(entry.payload.state) };
            }
            this.onAppMessage.dispatch(this, entry);
            this.tryLaunch();
            return;
        }
        if (message.type === 'launch') {
            const descriptor = message.descriptor;
            if (!descriptor || !/^[1-9]\d*$/.test(descriptor.gameId) || !Number.isSafeInteger(Number(descriptor.gameId)) ||
                !Number.isSafeInteger(descriptor.timestamp) || descriptor.timestamp < 1000000000000) {
                this.fail(new Error('服务端没有返回有效的 PvPGN gameId 和毫秒开局时间。'));
                return;
            }
            if (this.launchDescriptor) {
                return;
            }
            this.pendingLaunch = structuredClone(descriptor);
            clearTimeout(this.launchTimer);
            this.launchTimer = setTimeout(() => this.fail(new Error('开局房间状态同步超时。')), REQUEST_TIMEOUT);
            this.tryLaunch();
        }
    }

    private tryLaunch(): void {
        const descriptor = this.pendingLaunch;
        if (!descriptor || !this.room?.started || !this.roomState || this.room.id !== descriptor.roomId ||
            this.room.hostPeerId !== descriptor.hostPeerId || descriptor.humanAssignments.length !== this.room.members.length ||
            JSON.stringify(this.roomState.gameOpts) !== JSON.stringify(descriptor.gameOpts) ||
            JSON.stringify(this.roomState.humanAssignments) !== JSON.stringify(descriptor.humanAssignments) ||
            !descriptor.humanAssignments.every((assignment) => this.room!.members.some((member) => member.id === assignment.peerId))) {
            return;
        }
        clearTimeout(this.launchTimer);
        this.launchTimer = undefined;
        this.pendingLaunch = undefined;
        this.launchDescriptor = { ...descriptor, localPeerId: this.getSelf().id, localPlayerName: this.getSelf().name };
        this.onLaunch.dispatch(this, this.launchDescriptor);
    }

    private clearRoom(): void {
        clearTimeout(this.launchTimer);
        this.launchTimer = undefined;
        this.room = undefined;
        this.roomState = undefined;
        this.stateSignature = undefined;
        this.pendingLaunch = undefined;
        this.launchDescriptor = undefined;
        this.matchMessages = [];
        this.matchAttached = false;
    }

    private closeConnection(error: Error): void {
        const socket = this.socket;
        this.socket = undefined;
        if (socket) {
            socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
            socket.close();
        }
        clearTimeout(this.connectTimer);
        this.connectTimer = undefined;
        this.rejectConnect?.(error);
        this.rejectConnect = undefined;
        this.pending.forEach((pending) => {
            clearTimeout(pending.timer);
            pending.reject(error);
        });
        this.pending.clear();
        this.identity = undefined;
        this.clearRoom();
    }

    private fail(error: Error): void {
        this.error = error.message;
        this.closeConnection(error);
        this.log('error', error.message);
        this.dispatchSnapshot();
    }

    private dispatchSnapshot(): void {
        this.onSnapshotChange.dispatch(this, this.getSnapshot());
    }

    private log(level: LanMeshLogEntry['level'], text: string): void {
        this.onLog.dispatch(this, { level, text, timestamp: Date.now() });
    }
}

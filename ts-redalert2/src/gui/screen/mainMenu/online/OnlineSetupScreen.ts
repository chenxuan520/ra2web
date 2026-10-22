import { MusicType } from '@/engine/sound/Music';
import { OBS_COUNTRY_ID, NO_TEAM_ID } from '@/game/gameopts/constants';
import { ChatHistory } from '@/gui/chat/ChatHistory';
import { HtmlReactElement } from '@/gui/HtmlReactElement';
import { HtmlView } from '@/gui/jsx/HtmlView';
import { jsx } from '@/gui/jsx/jsx';
import { JsxRenderer } from '@/gui/jsx/JsxRenderer';
import { MainMenuScreenType, ScreenType } from '@/gui/screen/ScreenType';
import { MainMenuRoute } from '@/gui/screen/mainMenu/MainMenuRoute';
import { MainMenuScreen } from '@/gui/screen/mainMenu/MainMenuScreen';
import { LobbyType } from '@/gui/screen/mainMenu/lobby/component/viewmodel/lobby';
import { PregameController, PregameMapSelectionResult } from '@/gui/screen/mainMenu/lobby/PregameController';
import { SlotType } from '@/network/gameopt/SlotInfo';
import { ChatRecipientType } from '@/network/chat/ChatMessage';
import { LanMatchSession } from '@/network/lan/LanMatchSession';
import type { LanMeshAppMessage } from '@/network/lan/LanMeshSession';
import { LanLaunchDescriptor, LanRoomSession, LanRoomSnapshot } from '@/network/lan/LanRoomSession';
import { OnlineRoomSummary } from '@/network/online/OnlineProtocol';
import { OnlineSession } from '@/network/online/OnlineSession';
import { RECIPIENT_ALL } from '@/network/gservConfig';
import { uint8ArrayToBase64String } from '@/util/string';
import { OnlineSetup, OnlineSetupProps, OnlineSlotConfig } from './OnlineSetup';

type PregameDependencies = ConstructorParameters<typeof PregameController>;
type RoomDependencies = ConstructorParameters<typeof LanRoomSession>;

export class OnlineSetupScreen extends MainMenuScreen {
    declare public title: string;
    declare public musicType: MusicType;

    private session: OnlineSession;
    private roomSession: LanRoomSession;
    private pregameController: PregameController;
    private readonly chatHistory = new ChatHistory();
    private form?: HtmlReactElement<OnlineSetupProps>;
    private rooms: OnlineRoomSummary[] = [];
    private error?: string;
    private busy = false;
    private visible = false;
    private stacked = false;
    private gameTransition = false;
    private activeMatchSession?: LanMatchSession;

    private readonly onlineApi = {
        login: (user: string, pass: string) => this.perform(async () => {
            if (this.session.isDisposed()) {
                this.createSessions();
            }
            const identity = await this.session.login(user, pass);
            this.localPrefs.setItem('_r_onlinePlayerName', identity.name);
            this.pregameController = this.createPregameController();
            this.rooms = await this.session.listRooms();
        }),
        refreshRooms: () => this.perform(async () => {
            this.rooms = await this.session.listRooms();
        }),
        createRoom: () => this.perform(async () => {
            if (!this.pregameController.isInitialized()) {
                await this.pregameController.initialize();
            }
            this.pregameController.updateSelfName(this.session.getSelf().name);
            await this.session.createRoom();
            const snapshot = this.pregameController.getSnapshot();
            const maxSlots = Math.min(8, snapshot.gameOpts.maxSlots + (snapshot.gameOpts.humanPlayers[0]?.countryId === OBS_COUNTRY_ID ? 1 : 0));
            snapshot.gameOpts.aiPlayers.fill(undefined);
            for (let index = 1; index < snapshot.slotsInfo.length; index++) {
                snapshot.slotsInfo[index] = { type: index < maxSlots ? SlotType.Open : SlotType.Closed };
            }
            this.roomSession.startHosting(snapshot);
        }),
        joinRoom: (roomId: string) => this.perform(async () => {
            await this.session.joinRoom(roomId);
        }),
        leaveRoom: () => this.perform(async () => {
            await this.session.leaveRoom();
            this.chatHistory.reset();
            this.pregameController = this.createPregameController();
            this.rooms = await this.session.listRooms();
        }),
        changeMap: () => this.perform(async () => {
            if (!this.roomSession.getSnapshot().isHost) {
                throw new Error('只有房主可以选择地图。');
            }
            await this.controller.pushScreen(MainMenuScreenType.MapSelection, {
                lobbyType: LobbyType.MultiplayerHost,
                gameOpts: this.pregameController.getGameOpts(),
                usedSlots: () => this.pregameController.getUsedSlots(),
            });
        }),
        setReady: (ready: boolean) => this.perform(async () => {
            const snapshot = this.roomSession.getSnapshot();
            if (!snapshot.roomState || !snapshot.localMapFileReady || !this.session.isRoomStateSynced()) {
                throw new Error('请等待房间配置和地图同步完成。');
            }
            await this.roomSession.setReady(ready);
        }),
        setSlotConfig: (config: Partial<OnlineSlotConfig>) => this.perform(async () => {
            const snapshot = this.roomSession.getSnapshot();
            const assignment = snapshot.roomState?.humanAssignments.find((member) => member.peerId === this.session.getSelf().id);
            const human = snapshot.roomState?.gameOpts.humanPlayers.find((player) => player.name === assignment?.name);
            if (!assignment || !human) {
                throw new Error('当前玩家没有可修改的成员槽位。');
            }
            if (snapshot.isHost) {
                const pregame = this.pregameController.getSnapshot();
                Object.assign(pregame.gameOpts.humanPlayers.find((player) => player.name === human.name)!, config);
                this.roomSession.applyHostPregameSnapshot(pregame);
                return;
            }
            await this.roomSession.requestSlotConfig(assignment.slotIndex, {
                countryId: human.countryId,
                colorId: human.colorId,
                startPos: human.startPos,
                teamId: human.teamId,
                ...config,
            });
        }),
        sendChat: (text: string) => this.perform(async () => {
            await this.session.sendChat(text);
        }),
        startGame: () => this.perform(async () => {
            const snapshot = this.roomSession.getSnapshot();
            if (!this.canStart(snapshot) || !snapshot.roomState) {
                throw new Error('至少需要两名敌对战斗玩家，所有成员准备并完成地图同步后才能开始。');
            }
            const self = this.session.getSelf();
            const descriptor: LanLaunchDescriptor = {
                kind: 'lan',
                roomId: snapshot.mesh.roomId!,
                gameId: '',
                timestamp: 0,
                hostPeerId: snapshot.roomState.hostPeerId,
                localPeerId: self.id,
                localPlayerName: self.name,
                gameOpts: snapshot.roomState.gameOpts,
                humanAssignments: snapshot.roomState.humanAssignments,
                mapTransferStateByPeerId: snapshot.roomState.mapTransferStateByPeerId,
                returnRoute: new MainMenuRoute(MainMenuScreenType.OnlineSetup, {}),
            };
            await this.session.startGame(descriptor);
        }),
        logout: async () => {
            this.releaseSessions();
            this.rooms = [];
            this.error = undefined;
            this.chatHistory.reset();
            this.createSessions();
            this.installDebugApi();
            this.refreshView();
        },
        back: async () => {
            this.releaseSessions();
            await this.controller.goToScreenBlocking(MainMenuScreenType.Home);
        },
    };

    constructor(
        private readonly rootController: { goToScreen(screenType: number, params?: any): void },
        private readonly strings: PregameDependencies[0],
        private readonly jsxRenderer: JsxRenderer,
        private readonly rules: PregameDependencies[1],
        private readonly mapFileLoader: PregameDependencies[2],
        private readonly mapList: PregameDependencies[3] & NonNullable<RoomDependencies[4]>,
        private readonly gameModes: PregameDependencies[4],
        private readonly localPrefs: PregameDependencies[5],
        _messageBoxApi: unknown,
        private readonly mapDir?: RoomDependencies[3]
    ) {
        super();
        this.title = '在线对战';
        this.musicType = MusicType.Intro;
        this.createSessions();
    }

    onEnter(): void {
        if (this.session.isDisposed() || this.gameTransition) {
            this.releaseSessions();
            this.gameTransition = false;
            this.createSessions();
        }
        this.visible = true;
        this.stacked = false;
        this.controller.onScreenChange.unsubscribe(this.handleMenuNavigation);
        this.controller.onScreenChange.subscribe(this.handleMenuNavigation);
        this.controller.toggleMainVideo(false);
        this.controller.setSidebarButtons([{ label: '返回主菜单', isBottom: true, onClick: this.onlineApi.back }]);
        this.controller.setSidebarMpContent({ text: '' });
        this.controller.setSidebarPreview();
        this.controller.toggleSidebarPreview(false);
        this.installDebugApi();
        this.refreshView();
        this.controller.showSidebarButtons();
    }

    async onLeave(): Promise<void> {
        this.visible = false;
        this.form = undefined;
        await this.controller.hideSidebarButtons();
    }

    async onStack(): Promise<void> {
        this.stacked = true;
        await this.onLeave();
    }

    async onUnstack(params?: PregameMapSelectionResult): Promise<void> {
        if (this.gameTransition) {
            return;
        }
        this.visible = true;
        this.stacked = false;
        if (params && this.roomSession.getSnapshot().isHost) {
            try {
                const changedMapFile = params.changedMapFile ?? await this.mapFileLoader.load(params.mapName);
                this.pregameController.applyMapSelection({ ...params, changedMapFile });
                this.roomSession.applyHostPregameSnapshot(this.pregameController.getSnapshot());
            }
            catch (error) {
                this.error = (error as Error).message;
            }
        }
        this.refreshView();
        this.controller.setSidebarButtons([{ label: '返回主菜单', isBottom: true, onClick: this.onlineApi.back }]);
        this.controller.setSidebarMpContent({ text: '' });
        this.controller.setSidebarPreview();
        this.controller.toggleSidebarPreview(false);
        this.controller.showSidebarButtons();
    }

    destroy(): void {
        this.visible = false;
        this.form = undefined;
        this.controller?.onScreenChange.unsubscribe(this.handleMenuNavigation);
        if (this.gameTransition && this.session.getRoom()?.started && !this.session.isDisposed()) {
            this.unsubscribeSessionEvents();
            this.roomSession.dispose();
            return;
        }
        this.releaseSessions();
    }

    private createPregameController(): PregameController {
        return new PregameController(this.strings, this.rules, this.mapFileLoader, this.mapList, this.gameModes, this.localPrefs, this.session.getSelf().name);
    }

    private createSessions(): void {
        this.session = new OnlineSession();
        this.pregameController = this.createPregameController();
        this.session.onAppMessage.subscribe(this.handleRoomAppMessage);
        this.roomSession = new LanRoomSession(this.session, this.gameModes, {
            load: (name) => this.mapList.getByName(name) ? this.mapFileLoader.load(name) : Promise.reject(new Error('等待房主传输自定义地图。')),
        }, this.mapDir, this.mapList);
        this.roomSession.onSnapshotChange.subscribe(this.handleRoomSnapshot);
        this.roomSession.onLog.subscribe(this.handleLog);
        this.session.onSnapshotChange.subscribe(this.handleSessionSnapshot);
        this.session.onLog.subscribe(this.handleLog);
        this.session.onChat.subscribe(this.handleChat);
        this.session.onLaunch.subscribe(this.handleLaunch);
    }

    private unsubscribeSessionEvents(): void {
        this.roomSession.onSnapshotChange.unsubscribe(this.handleRoomSnapshot);
        this.roomSession.onLog.unsubscribe(this.handleLog);
        this.session.onSnapshotChange.unsubscribe(this.handleSessionSnapshot);
        this.session.onAppMessage.unsubscribe(this.handleRoomAppMessage);
        this.session.onLog.unsubscribe(this.handleLog);
        this.session.onChat.unsubscribe(this.handleChat);
        this.session.onLaunch.unsubscribe(this.handleLaunch);
    }

    private releaseSessions(): void {
        this.unsubscribeSessionEvents();
        this.roomSession.dispose();
        this.activeMatchSession?.dispose();
        this.activeMatchSession = undefined;
        this.session.dispose();
        const debugRoot = (window as any).__ra2debug;
        if (debugRoot?.online?.session === this.session) {
            delete debugRoot.online;
        }
    }

    private handleMenuNavigation = (screenType?: number) => {
        if (screenType === MainMenuScreenType.OnlineSetup || (screenType === MainMenuScreenType.MapSelection && this.stacked) || this.gameTransition) {
            return;
        }
        this.releaseSessions();
        this.controller.onScreenChange.unsubscribe(this.handleMenuNavigation);
    };

    private handleRoomAppMessage = (entry: LanMeshAppMessage) => {
        const payload = entry.payload as { type?: string; state?: { gameOpts: { mapDigest: string } } };
        const state = this.roomSession.getSnapshot().roomState;
        if (payload?.type === 'state-sync' && payload.state && state && !this.roomSession.getSnapshot().isHost &&
            payload.state.gameOpts.mapDigest !== state.gameOpts.mapDigest) {
            this.roomSession.leaveRoom();
        }
    };

    private handleSessionSnapshot = () => {
        if (!this.session.isLoggedIn()) {
            this.rooms = [];
        }
        this.error = this.session.getError() ?? this.error;
        this.refreshView();
    };

    private handleRoomSnapshot = (snapshot: LanRoomSnapshot) => {
        if (snapshot.roomState && !this.gameTransition) {
            const currentMapFile = this.roomSession.getResolvedCustomMapFile() ??
                (this.pregameController.isInitialized() && this.pregameController.getGameOpts().mapDigest === snapshot.roomState.gameOpts.mapDigest
                    ? this.pregameController.getCurrentMapFile()
                    : undefined);
            this.pregameController.hydrate({
                gameOpts: snapshot.roomState.gameOpts,
                slotsInfo: snapshot.roomState.slotsInfo,
                currentMapFile,
            });
        }
        this.refreshView();
    };

    private handleLog = (entry: { level: string; text: string }) => {
        if (entry.level === 'error' || entry.level === 'warn') {
            this.error = entry.text;
            this.refreshView();
        }
    };

    private handleChat = (entry: { from: { name: string }; text: string; timestamp: number }) => {
        this.chatHistory.addChatMessage({ from: entry.from.name, to: { type: ChatRecipientType.Channel, name: RECIPIENT_ALL }, text: entry.text, time: new Date(entry.timestamp) });
        this.refreshView();
    };

    private handleLaunch = (descriptor: LanLaunchDescriptor) => {
        if (this.gameTransition) {
            return;
        }
        this.gameTransition = true;
        this.activeMatchSession = new LanMatchSession(this.session, descriptor);
        this.session.flushMatchMessages();
        const map = this.roomSession.getResolvedCustomMapFile();
        this.rootController.goToScreen(ScreenType.Game, {
            create: true,
            lanLaunch: descriptor,
            lanMatchSession: this.activeMatchSession,
            lanMapDataBase64: map ? uint8ArrayToBase64String(map.getBytes()) : undefined,
            returnTo: new MainMenuRoute(MainMenuScreenType.OnlineSetup, {}),
        });
    };

    private canStart(snapshot: LanRoomSnapshot): boolean {
        const state = snapshot.roomState;
        const players = state?.gameOpts.humanPlayers.filter((player) => player.countryId !== OBS_COUNTRY_ID) ?? [];
        return Boolean(state && snapshot.isHost && snapshot.canStart && !this.session.getRoom()?.started &&
            snapshot.members.every((member) => member.ready) && players.length >= 2 &&
            players.some((left, index) => players.slice(index + 1).some((right) => left.teamId === NO_TEAM_ID || right.teamId === NO_TEAM_ID || left.teamId !== right.teamId)));
    }

    private async perform(action: () => Promise<void>): Promise<void> {
        if (this.busy) {
            throw new Error('请等待当前在线操作完成。');
        }
        this.busy = true;
        this.error = undefined;
        this.refreshView();
        try {
            await action();
        }
        catch (error) {
            this.error = (error as Error).message;
            throw error;
        }
        finally {
            this.busy = false;
            this.refreshView();
        }
    }

    private buildProps(): OnlineSetupProps {
        const roomSnapshot = this.roomSession.getSnapshot();
        return {
            strings: this.strings,
            session: this.session,
            roomSnapshot,
            pregameController: this.pregameController,
            chatHistory: this.chatHistory,
            rooms: this.rooms,
            initialUsername: this.localPrefs.getItem('_r_onlinePlayerName') ?? '',
            busy: this.busy,
            error: this.error,
            modeLabel: roomSnapshot.roomState ? this.strings.get(this.gameModes.getById(roomSnapshot.roomState.gameOpts.gameMode).label) : '',
            canStart: this.canStart(roomSnapshot),
            onlineApi: this.onlineApi,
            onHostPregameChanged: () => {
                try {
                    this.roomSession.applyHostPregameSnapshot(this.pregameController.getSnapshot());
                }
                catch (error) {
                    this.error = (error as Error).message;
                    this.refreshView();
                }
            },
            onSendChat: this.onlineApi.sendChat,
        };
    }

    private refreshView(): void {
        if (!this.visible) {
            return;
        }
        if (this.form) {
            this.form.applyOptions((options) => Object.assign(options, this.buildProps()));
        }
        else {
            const [component] = this.jsxRenderer.render(jsx(HtmlView, {
                width: 632,
                height: '100%',
                innerRef: (ref: HtmlReactElement<OnlineSetupProps>) => this.form = ref,
                component: OnlineSetup,
                props: this.buildProps(),
            }));
            this.controller.setMainComponent(component);
        }
    }

    private installDebugApi(): void {
        const debugRoot = ((window as any).__ra2debug ??= {});
        if (debugRoot.online?.session && debugRoot.online.session !== this.session) {
            debugRoot.online.session.dispose();
        }
        const screen = this;
        debugRoot.online = {
            get session() { return screen.session; },
            get sessionSnapshot() { return screen.session.getSnapshot(); },
            get roomSnapshot() { return screen.roomSession.getSnapshot(); },
            get rooms() { return screen.rooms; },
            get matchSession() { return screen.activeMatchSession; },
            get canStart() { return screen.canStart(screen.roomSession.getSnapshot()); },
            onlineApi: this.onlineApi,
        };
    }
}

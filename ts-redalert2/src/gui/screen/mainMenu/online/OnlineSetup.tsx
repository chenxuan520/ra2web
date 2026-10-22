import React, { useState } from 'react';
import { ChatHistory } from '@/gui/chat/ChatHistory';
import { LobbyForm } from '@/gui/screen/mainMenu/lobby/component/LobbyForm';
import { LobbyType, PlayerStatus } from '@/gui/screen/mainMenu/lobby/component/viewmodel/lobby';
import { PregameController } from '@/gui/screen/mainMenu/lobby/PregameController';
import { OBS_COUNTRY_ID, OBS_COUNTRY_NAME, OBS_TEAM_ID, RANDOM_COUNTRY_ID } from '@/game/gameopts/constants';
import { LanRoomSnapshot } from '@/network/lan/LanRoomSession';
import { OnlineRoomSummary } from '@/network/online/OnlineProtocol';
import { OnlineSession } from '@/network/online/OnlineSession';
import { RECIPIENT_ALL } from '@/network/gservConfig';

export interface OnlineSlotConfig {
    countryId: number;
    colorId: number;
    startPos: number;
    teamId: number;
}

export interface OnlineSetupProps {
    strings: any;
    session: OnlineSession;
    roomSnapshot: LanRoomSnapshot;
    pregameController: PregameController;
    chatHistory: ChatHistory;
    rooms: OnlineRoomSummary[];
    initialUsername: string;
    busy: boolean;
    error?: string;
    modeLabel: string;
    canStart: boolean;
    onlineApi: {
        login(user: string, pass: string): Promise<void>;
        refreshRooms(): Promise<void>;
        createRoom(): Promise<void>;
        joinRoom(roomId: string): Promise<void>;
        leaveRoom(): Promise<void>;
        changeMap(): Promise<void>;
        setReady(ready: boolean): Promise<void>;
        setSlotConfig(config: Partial<OnlineSlotConfig>): Promise<void>;
        sendChat(text: string): Promise<void>;
        startGame(): Promise<void>;
        logout(): Promise<void>;
        back(): Promise<void>;
    };
    onHostPregameChanged(): void;
    onSendChat(text: string): Promise<void>;
}

export const OnlineSetup: React.FC<OnlineSetupProps> = (props) => {
    const { session, roomSnapshot, pregameController, onlineApi, busy } = props;
    const [username, setUsername] = useState(props.initialUsername);
    const [password, setPassword] = useState('');
    const [roomId, setRoomId] = useState('');
    const run = (operation: Promise<void>) => { void operation.catch(() => undefined); };
    const loggedIn = session.isLoggedIn();
    const state = roomSnapshot.roomState;
    const self = session.getSelf();
    const member = roomSnapshot.members.find((candidate) => candidate.isSelf);
    const assignment = state?.humanAssignments.find((candidate) => candidate.peerId === self.id);
    const inRoom = roomSnapshot.mesh.isInRoom;

    let formProps: any;
    if (state) {
        formProps = pregameController.createLobbyFormProps({
            lobbyType: roomSnapshot.isHost ? LobbyType.MultiplayerHost : LobbyType.MultiplayerGuest,
            activeSlotIndex: assignment?.slotIndex ?? -1,
            messages: props.chatHistory.getAll().slice(-180),
            localUsername: self.name,
            channels: [RECIPIENT_ALL],
            chatHistory: props.chatHistory,
            onSendMessage: (message: any) => {
                const text = typeof message === 'string' ? message : message?.value;
                if (typeof text === 'string') {
                    run(props.onSendChat(text));
                }
            },
            onStateChange: roomSnapshot.isHost ? props.onHostPregameChanged : undefined,
            decoratePlayerSlot: (slot, _slotInfo, slotIndex) => {
                const player = roomSnapshot.members.find((candidate) => candidate.slotIndex === slotIndex);
                slot.status = player?.isHost ? PlayerStatus.Host : player?.ready ? PlayerStatus.Ready : PlayerStatus.NotReady;
            },
        });
        formProps.availableAiNames = new Map();
        if (!roomSnapshot.isHost) {
            formProps.onCountrySelect = (country: string) => run(onlineApi.setSlotConfig({ countryId: pregameController.getCountryIdByName(country) }));
            formProps.onColorSelect = (color: string) => run(onlineApi.setSlotConfig({ colorId: pregameController.getColorIdByName(color) }));
            formProps.onStartPosSelect = (startPos: number) => run(onlineApi.setSlotConfig({ startPos }));
            formProps.onTeamSelect = (teamId: number) => run(onlineApi.setSlotConfig(teamId === OBS_TEAM_ID
                ? { countryId: OBS_COUNTRY_ID }
                : { teamId, ...(formProps.playerSlots[assignment?.slotIndex]?.country === OBS_COUNTRY_NAME ? { countryId: RANDOM_COUNTRY_ID } : {}) }));
        }
    }

    return (
        <div className="lobby-form lan-setup-form" data-online-view={!loggedIn ? 'login' : inRoom ? 'room' : 'rooms'} style={{ height: '100%', overflowY: 'auto', padding: '18px 30px' }}>
            <div className="lan-panel-header">
                <h3>在线对战 · PvPGN</h3>
                {loggedIn ? <span data-online-user>{self.name}</span> : null}
            </div>
            {props.error ? <div className="lan-setup-notice" role="alert" data-online-error>{props.error}</div> : null}
            {!loggedIn ? (
                <form className="lan-panel" onSubmit={(event) => {
                    event.preventDefault();
                    const pass = password;
                    setPassword('');
                    run(onlineApi.login(username, pass));
                }}>
                    <p>使用真实 PvPGN 账号登录；首次登录自动注册。密码仅用于本次登录，不会保存到本机。</p>
                    <label className="lan-input-label" htmlFor="online-user">用户名（2–15 位 ASCII 字母、数字或 _-[]）</label>
                    <input id="online-user" name="user" className="lan-text-input" data-online-input="username" type="text" minLength={2} maxLength={15} value={username} disabled={busy} autoComplete="username" required onChange={(event) => setUsername(event.target.value)} />
                    <label className="lan-input-label" htmlFor="online-pass">密码（1–8 位可打印 ASCII 字符）</label>
                    <input id="online-pass" name="pass" className="lan-text-input" data-online-input="password" type="password" minLength={1} maxLength={8} value={password} disabled={busy} autoComplete="off" required onChange={(event) => setPassword(event.target.value)} />
                    <div className="lan-actions">
                        <button className="dialog-button" type="submit" data-online-action="login" disabled={busy}>{busy ? '正在连接…' : '登录 / 首次注册'}</button>
                    </div>
                </form>
            ) : !inRoom ? (
                <div className="lan-panel">
                    <div className="lan-actions">
                        <button className="dialog-button" data-online-action="refresh" disabled={busy} onClick={() => run(onlineApi.refreshRooms())}>刷新房间</button>
                        <button className="dialog-button" data-online-action="create" disabled={busy} onClick={() => run(onlineApi.createRoom())}>创建房间</button>
                    </div>
                    <form className="lan-actions" onSubmit={(event) => { event.preventDefault(); run(onlineApi.joinRoom(roomId)); }}>
                        <label htmlFor="online-room-id">房间号</label>
                        <input id="online-room-id" data-online-input="room-id" value={roomId} disabled={busy} required onChange={(event) => setRoomId(event.target.value)} />
                        <button className="dialog-button" type="submit" data-online-action="join" disabled={busy}>按房间号加入</button>
                    </form>
                    <h3>可加入房间</h3>
                    {props.rooms.length ? props.rooms.map((room) => (
                        <div className="lan-panel" key={room.id} data-online-room={room.id}>
                            <div><strong>{room.hostName} 的房间</strong> · 房间号 {room.id}</div>
                            <div>{room.mapTitle || '等待房主选择地图'} · {room.playerCount}/{room.maxPlayers} 人</div>
                            <button className="dialog-button" data-online-action="join-listed" disabled={busy || room.playerCount >= room.maxPlayers} onClick={() => run(onlineApi.joinRoom(room.id))}>加入</button>
                        </div>
                    )) : <p data-online-empty>暂无可加入房间，请刷新或创建房间。</p>}
                </div>
            ) : (
                <>
                    <div className="lan-room-status-strip" data-online-room-id={roomSnapshot.mesh.roomId}>
                        <span className="lan-status-chip">房间号 <strong>{roomSnapshot.mesh.roomId}</strong></span>
                        <span className="lan-status-chip">房主 <strong>{roomSnapshot.members.find((candidate) => candidate.isHost)?.name ?? session.getRoom()?.members.find((candidate) => candidate.id === session.getRoom()?.hostPeerId)?.name}</strong></span>
                        <span className="lan-status-chip" data-online-stat="members">{roomSnapshot.members.length} 人</span>
                    </div>
                    <div data-online-map>{state ? `${state.gameOpts.mapTitle} · ${props.modeLabel}` : '正在接收房主配置…'}</div>
                    <div className="lan-actions">
                        <button className="dialog-button" data-online-action="ready" disabled={busy || !state || !roomSnapshot.localMapFileReady || !session.isRoomStateSynced()} onClick={() => run(onlineApi.setReady(!member?.ready))}>{member?.ready ? '取消准备' : '准备'}</button>
                        {roomSnapshot.isHost ? <button className="dialog-button" data-online-action="map" disabled={busy} onClick={() => run(onlineApi.changeMap())}>选择地图 / 模式</button> : null}
                        <button className="dialog-button" data-online-action="start" disabled={busy || !props.canStart} onClick={() => run(onlineApi.startGame())}>开始游戏</button>
                        <button className="dialog-button" data-online-action="leave" disabled={busy} onClick={() => run(onlineApi.leaveRoom())}>离开房间</button>
                    </div>
                    <div className="lan-hint">所有成员需准备；至少两名非观察者且不在同一队伍。房间选项或成员变化会清除准备状态。</div>
                    <div className="lan-room-status-strip" style={{ marginTop: 8 }}>
                        {roomSnapshot.members.map((player) => <span className="lan-status-chip" key={player.peerId} data-online-member={player.name} data-online-ready={player.ready}>{player.name} · {player.ready ? '已准备' : '未准备'} · 地图 {player.mapTransfer.status === 'complete' ? '就绪' : player.mapTransfer.status}</span>)}
                    </div>
                    {formProps ? <div className="lan-room-form-shell lan-room-form-shell-compact" data-online-lobby inert={busy || Boolean(session.getRoom()?.started)}><LobbyForm {...formProps} /></div> : null}
                </>
            )}
            <div className="lan-actions">
                {loggedIn ? <button className="dialog-button" data-online-action="logout" disabled={busy} onClick={() => run(onlineApi.logout())}>退出登录</button> : null}
                <button className="dialog-button" data-online-action="back" onClick={() => run(onlineApi.back())}>返回主菜单</button>
            </div>
        </div>
    );
};

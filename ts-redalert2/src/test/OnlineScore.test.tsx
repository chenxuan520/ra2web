import { expect, spyOn, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScoreTable } from '../gui/screen/mainMenu/score/ScoreTable';
import * as THREE from 'three';
import { Game, GameStatus } from '../game/Game';
import { Player } from '../game/Player';
import { PlayerList } from '../game/PlayerList';
import { World } from '../game/World';
import { GameObject } from '../game/gameobject/GameObject';
import { MapSupport } from '../engine/MapSupport';
import { VirtualFile } from '../data/vfs/VirtualFile';
import { MapDigest } from '../engine/MapDigest';
import { fixtureSources } from './resources/fixtures';
import { readMix } from '../../deploy/prepare-resources';
import { ActionType } from '../game/action/ActionType';
import { AllianceStatus, Alliances } from '../game/Alliances';
import { ActionFactory } from '../game/action/ActionFactory';
import { ActionQueue } from '../game/action/ActionQueue';
import { LanMatchSession } from '../network/lan/LanMatchSession';
import { LanLockstepTurnManager } from '../network/lan/LanLockstepTurnManager';
import { OnlineSession } from '../network/online/OnlineSession';
import { MainMenuScreenType } from '../gui/screen/ScreenType';
import { ObjectType } from '../engine/type/ObjectType';
import { CompositeDisposable } from '../util/disposable/CompositeDisposable';
import { EventDispatcher } from '../util/event';

async function loadGameScreen() {
    const globals = globalThis as any;
    const previousThree = globals.THREE;
    const previousWindow = globals.window;
    globals.THREE = THREE;
    globals.window = { THREE };
    try { return (await import('../gui/screen/game/GameScreen')).GameScreen; }
    finally { globals.THREE = previousThree; globals.window = previousWindow; }
}

test('leaving an online match is displayed as a loss without changing the shared simulation', () => {
    const player = { name: 'player', defeated: false, isObserver: false, score: 0, country: undefined };
    const markup = renderToStaticMarkup(<ScoreTable
        game={{ getNonNeutralPlayers: () => [player], gameOpts: {}, currentTime: 1000, speed: { value: 1 } }}
        localPlayer={player}
        singlePlayer={false}
        tournament={false}
        quit={true}
        strings={{ get: (key: string) => key }}
    />);
    expect(markup).toContain('gui:gameresultdefeat');
    expect(markup).not.toContain('gui:gameresultvictory');
    expect(player.defeated).toBe(false);
});

test('quitting a lagging LAN observer match disables turns before closing its transport', async () => {
    const GameScreen = await loadGameScreen();
    let quit!: () => Promise<void>;
    let connected = true;
    const game = { status: GameStatus.Started, currentTick: 0, speed: { value: 1 } };
    const match = {
        onActionsReceived: new EventDispatcher(),
        submitLocalTurn() {
            if (!connected) throw new Error('Online transport is closed');
            return 'turn';
        },
        tryConsumeTurn: () => undefined,
        dispose() {},
    };
    const manager = new LanLockstepTurnManager(game, {}, { dequeueAll: () => [] }, {}, match as any);
    manager.init();
    let turnsBlocked = false;
    const screen = Object.assign(Object.create(GameScreen.prototype), {
        controller: { goToScreen() {} }, isSinglePlayer: false, isLanGame: true, isTournament: false, lagState: true,
        pointer: { lock() {}, setVisible() {} }, playerUi: { dispose() {} }, gameTurnMgr: manager,
        lanMatchSession: { leaveRoom() {
            connected = false;
            turnsBlocked = manager.getErrorState();
            manager.doGameTurn(0);
        } },
    }) as { initGameMenuEvents(...args: any[]): void };
    const menu = { onOpen: new EventDispatcher(), onObserve: new EventDispatcher(), onCancel: new EventDispatcher(), onQuit: { subscribe(handler: () => Promise<void>) { quit = handler; } } };
    screen.initGameMenuEvents(menu, {}, game, { isObserver: true }, {}, {});
    await quit();
    expect(turnsBlocked).toBe(true);
});

async function onlinePair(assetCount: number, screenType = MainMenuScreenType.OnlineSetup, peers = ['host', 'guest'], onlineTransport = false) {
    const GameScreen = await loadGameScreen();
    const pending: { from: string; payload: any }[] = [];
    let synchronous = false;
    const transports: any[] = [];
    for (const id of peers) {
        const transport = {
            closed: false, onSnapshotChange: new EventDispatcher(), onAppMessage: new EventDispatcher(),
            getSelf: () => ({ id, name: id }),
            getSnapshot() { return { members: peers.filter(peerId => !transports.find(peer => peer.id === peerId)!.closed).map(peerId => ({ id: peerId, name: peerId, isSelf: peerId === id, status: 'connected' })) }; },
            broadcastAppMessage(payload: unknown) { if (this.closed) throw new Error('Transport closed'); pending.push({ from: id, payload }); if (synchronous) flush(); },
            leaveRoom() {
                flush();
                this.closed = true;
                for (const peer of transports) {
                    if (onlineTransport) {
                        if (!peer.closed) (peer as any).handleMessage({ type: 'room', room: { id: 'room', hostPeerId: 'host', members: transports.filter(peer => !peer.closed).map(peer => ({ id: peer.id, name: peer.id })), started: true } });
                    }
                    else peer.onSnapshotChange.dispatch(peer, peer.getSnapshot());
                }
            },
        };
        if (onlineTransport) {
            const session = new OnlineSession() as any;
            Object.assign(session, {
                identity: { id, name: id }, room: { id: 'room', hostPeerId: 'host', members: peers.map(id => ({ id, name: id })), started: true },
                socket: { readyState: WebSocket.OPEN, send(raw: string) { pending.push({ from: id, payload: JSON.parse(raw).payload }); if (synchronous) flush(); }, close() { this.readyState = WebSocket.CLOSED; transport.leaveRoom.call(session); } },
                id, closed: false,
            });
            transports.push(session);
        }
        else transports.push(Object.assign(transport, { id }));
    }
    function flush() {
        for (const entry of pending.splice(0)) for (const peer of transports) {
            if (peer.getSelf().id !== entry.from && !peer.closed) peer.onAppMessage.dispatch(peer, { from: { id: entry.from, name: entry.from }, payload: entry.payload, timestamp: Date.now() });
        }
    }
    const bytes = readMix('multi.mix', fixtureSources().get('MULTI.MIX')!).mix.openFile('fixture.map').getBytes();
    const mapFile = VirtualFile.fromBytes(bytes, 'fixture.map');
    const mapCheck = spyOn(MapSupport, 'check').mockReturnValue(undefined);
    const states: any[] = [];
    try {
        for (const [index, id] of peers.entries()) {
            const players = new PlayerList();
            for (const name of peers) {
                const player = new Player(name, { isPlayable: () => true } as any);
                player.radarTrait = { isDisabled: () => false, setDisabled() {} };
                players.addPlayer(player);
            }
            const world = new World();
            const opts = { gameSpeed: 3, gameMode: 1, shortGame: true, mapName: mapFile.filename, mapDigest: MapDigest.compute(mapFile), mapOfficial: true, humanPlayers: peers.map(name => ({ name, countryId: 0 })), aiPlayers: [] };
            const map = { tileOccupation: { unoccupyTileRange() {} }, technosByTile: { remove() {} }, dispose() {} };
            const selection = { cleanupUnit() {}, getSelectedUnits: () => [], removeFromSelection() {}, removeUnitsFromGroup() {} };
            const game = new Game(world, map, { general: { baseUnit: ['AMCV'] }, mpDialogSettings: {} }, {}, {}, '1', 1700000000000, opts, {}, players, selection, new Alliances(players), { value: 0 }, {}, { update() {}, dispose() {} });
            game.status = GameStatus.Started;
            game.localPlayer = players.getPlayerByName(id);
            game.mapShroudTrait = { getPlayerShroud: () => undefined };
            for (const player of players.getAll()) for (let number = 0; number < assetCount; number++) {
                const object = new GameObject(ObjectType.Vehicle, 'AMCV', { insignificant: false, legalTarget: true, points: 1 }, {}) as any;
                object.id = world.getAllObjects().length + 1;
                object.position = { tile: { rx: number, ry: 0 }, worldPosition: new THREE.Vector3() };
                object.isTechno = () => true;
                player.addOwnedObject(object);
                world.spawnObject(object);
                object.onSpawn(game);
            }
            const descriptor = { kind: 'lan', roomId: 'room', gameId: '1', timestamp: 1700000000000, hostPeerId: 'host', localPeerId: id, localPlayerName: id, gameOpts: opts, humanAssignments: peers.map((peerId, slotIndex) => ({ peerId, name: peerId, slotIndex })), mapTransferStateByPeerId: {}, returnRoute: { screenType } } as any;
            const match = new LanMatchSession(transports[index] as any, descriptor);
            (match as any).loadPercentByPeerId = new Map(peers.map(peerId => [peerId, 100]));
            const navigations: any[] = [], replaySaves: any[] = [], gameLogs: boolean[] = [];
            const screen = Object.assign(Object.create(GameScreen.prototype), {
                disposables: new CompositeDisposable(), pointer: { lock() {}, unlock() {}, setVisible() {} }, music: { async play() {} },
                gameLoader: { async load() { return { game, theater: { type: 0 } }; }, clearStaticCaches() {} },
                loadingScreenApiFactory: { create: () => ({ onLoadProgress() {}, dispose() {} }) },
                localPrefs: { removeItem() {} }, config: {}, runtimeVars: { cheatsEnabled: {} },
                mapFileLoader: { load: async () => mapFile }, loadUi: () => ({}), controller: { goToScreen(type: number, params: any) { navigations.push({ type, params }); } },
                playerUi: { dispose() {} }, logGame(_game: Game, won: boolean) { gameLogs.push(won); }, replayManager: { async saveReplay(replay: any) { replaySaves.push(replay); } }, gameEndHandled: false,
            });
            await screen.onEnter({ lanLaunch: descriptor, lanMatchSession: match });
            const manager = screen.gameTurnMgr as LanLockstepTurnManager;
            const factory = (manager as any).actionFactory as ActionFactory;
            const actions = (manager as any).inputActions as ActionQueue;
            let quit!: () => Promise<void>;
            const menu = { onOpen: new EventDispatcher(), onObserve: new EventDispatcher(), onCancel: new EventDispatcher(), onQuit: { subscribe(handler: () => Promise<void>) { quit = handler; } } };
            let endings = 0;
            const ended: Promise<void>[] = [];
            game.onEnd.subscribe(() => { endings++; ended.push(screen.onGameEnd(game, game.localPlayer, { play() {} }, screen.replay)); });
            screen.initGameMenuEvents(menu, { play() {} }, game, game.localPlayer, actions, factory);
            states.push({ game, screen, match, manager, actions, factory, navigations, replaySaves, gameLogs, ended, quit: () => quit(), endings: () => endings });
        }
    }
    finally { mapCheck.mockRestore(); }
    return {
        states, flush, transports,
        disconnect(index: number) { if (onlineTransport) transports[index].fail(new Error('Connection lost')); else transports[index].leaveRoom(); },
        sync() { synchronous = true; flush(); },
        stats: () => states.map(state => state.game.playerList.getAll().map((player: Player) => ({ name: player.name, score: player.score, kills: player.getUnitsKilled(), losses: player.getUnitsLost(), resigned: player.resigned, defeated: player.defeated, assets: player.getOwnedObjects().length }))),
        async finish() { await Promise.all(states.flatMap(state => state.ended)); },
        dispose() { for (const state of states) { state.manager.dispose(); state.match.dispose(); state.screen.disposables.dispose(); } if (onlineTransport) for (const transport of transports) transport.dispose(); },
    };
}

for (const quitter of [0, 1]) for (const assetCount of [1, 9]) {
    test(`online quit by ${quitter ? 'guest' : 'host'} synchronizes ${assetCount} assets before leaving`, async () => {
        const pair = await onlinePair(assetCount);
        const self = pair.states[quitter], other = pair.states[1 - quitter];
        try {
            expect(self.manager.doGameTurn(0)).toBe(false);
            pair.flush();
            self.screen.lagState = true;
            const quitting = self.quit();
            await Promise.resolve();
            expect(pair.transports[quitter].closed).toBe(false);
            expect(self.manager.getErrorState()).toBe(false);
            other.manager.doGameTurn(0);
            pair.flush();
            expect(self.manager.doGameTurn(0)).toBe(true);
            await Promise.resolve();
            expect(pair.transports[quitter].closed).toBe(false);
            self.manager.doGameTurn(1);
            pair.flush();
            other.manager.doGameTurn(1);
            pair.flush();
            self.manager.doGameTurn(1);
            for (let round = 2; round <= 40 && pair.states.some(state => state.game.status !== GameStatus.Ended); round++) {
                pair.flush();
                self.manager.doGameTurn(round);
                pair.flush();
                other.manager.doGameTurn(round);
                pair.flush();
                await Promise.resolve();
            }
            await quitting;
            await pair.finish();
            const stats = pair.stats();
            expect(stats[0]).toEqual(stats[1]);
            expect(stats[0][quitter]).toMatchObject({ losses: assetCount, assets: 0, defeated: true, resigned: true });
            expect(stats[0][1 - quitter]).toMatchObject({ losses: 0, assets: assetCount, defeated: false });
            expect(self.endings()).toBe(1);
            expect(other.endings()).toBe(1);
            for (const state of pair.states) {
                expect(state.navigations).toHaveLength(1);
                expect(state.navigations[0].params.route.screenType).toBe(MainMenuScreenType.Score);
                expect(state.replaySaves).toHaveLength(1);
                expect(state.gameLogs).toHaveLength(1);
            }
        }
        finally { pair.dispose(); }
    }, 10000);
}

for (const quitter of [0, 1]) {
    test(`a synchronous online quit by peer ${quitter} handles one terminal navigation`, async () => {
        const pair = await onlinePair(1);
        try {
            pair.sync();
            const self = pair.states[quitter], other = pair.states[1 - quitter];
            const quitting = self.quit();
            other.manager.doGameTurn(0);
            self.manager.doGameTurn(0);
            other.manager.doGameTurn(0);
            await quitting;
            await pair.finish();
            expect(pair.stats()[0]).toEqual(pair.stats()[1]);
            expect(pair.stats()[0][quitter]).toMatchObject({ assets: 0, losses: 1, resigned: true, defeated: true });
            await self.quit();
            for (const state of pair.states) {
                expect(state.navigations).toHaveLength(1);
                expect(state.replaySaves).toHaveLength(1);
                expect(state.endings()).toBe(1);
            }
        }
        finally { pair.dispose(); }
    }, 10000);
}

test('an opponent ending the game while online quit is pending does not navigate or save twice', async () => {
    const pair = await onlinePair(1);
    try {
        const [host, guest] = pair.states;
        guest.actions.push(guest.factory.create(ActionType.ResignGame));
        host.manager.doGameTurn(0);
        guest.manager.doGameTurn(0);
        const quitting = host.quit();
        pair.flush();
        guest.manager.doGameTurn(0);
        host.manager.doGameTurn(0);
        await quitting;
        await pair.finish();
        expect(pair.stats()[0]).toEqual(pair.stats()[1]);
        expect(pair.stats()[0][0]).toMatchObject({ assets: 1, losses: 0, resigned: false, defeated: false });
        for (const state of pair.states) {
            expect(state.navigations).toHaveLength(1);
            expect(state.replaySaves).toHaveLength(1);
            expect(state.endings()).toBe(1);
        }
    }
    finally { pair.dispose(); }
}, 10000);

test('an online fixed-team resignation transfers assets and credits through the shared game rules', async () => {
    const pair = await onlinePair(9, MainMenuScreenType.OnlineSetup, ['host', 'guest', 'enemy']);
    try {
        for (const state of pair.states) {
            const host = state.game.getPlayerByName('host'), guest = state.game.getPlayerByName('guest');
            state.game.rules.mpDialogSettings = { mustAlly: true, allyChangeAllowed: false };
            state.game.alliances.setAlliance(host, guest, AllianceStatus.Formed);
            host.credits = 101;
            guest.credits = 7;
        }
        const quitter = pair.states[0].quit();
        for (const state of pair.states) state.manager.doGameTurn(0);
        pair.flush();
        for (const state of pair.states) state.manager.doGameTurn(0);
        await quitter;
        const stats = pair.stats();
        expect(stats[0]).toEqual(stats[1]);
        expect(stats[0]).toEqual(stats[2]);
        expect(stats[0][0]).toMatchObject({ assets: 0, losses: 0, resigned: true, defeated: true });
        expect(stats[0][1]).toMatchObject({ assets: 18, losses: 0, defeated: false });
        for (const state of pair.states) expect(state.game.getPlayerByName('guest').credits).toBe(108);
        expect(pair.states[0].navigations).toHaveLength(1);
        expect(pair.states[0].navigations[0].params.route.params.quit).toBe(true);
    }
    finally { pair.dispose(); }
}, 10000);

for (const screenType of [MainMenuScreenType.OnlineSetup, MainMenuScreenType.LanSetup]) {
    test(`an incomplete ${screenType === MainMenuScreenType.OnlineSetup ? 'online' : 'LAN'} turn still commits a peer drop`, async () => {
        const pair = await onlinePair(1, screenType);
        try {
            const [host, guest] = pair.states;
            host.manager.doGameTurn(0);
            guest.match.leaveRoom();
            expect(host.manager.doGameTurn(0)).toBe(true);
            await pair.finish();
            expect(pair.stats()[0][1]).toMatchObject({ assets: 0, losses: 1, defeated: true });
            expect(host.match.getSnapshot().activePeerIds).toEqual(['host']);
        }
        finally { pair.dispose(); }
    }, 10000);
}

test('an online terminal turn already dropping a third peer is not rewritten after the winner leaves', async () => {
    const pair = await onlinePair(9, MainMenuScreenType.OnlineSetup, ['host', 'guest', 'third'], true);
    try {
        const [host, guest] = pair.states;
        pair.transports.forEach((transport, index) => transport.launchDescriptor = pair.states[index].match.getLaunchDescriptor());
        host.actions.push(host.factory.create(ActionType.ResignGame));
        pair.disconnect(2);
        host.manager.doGameTurn(0);
        guest.manager.doGameTurn(0);
        pair.flush();
        guest.manager.doGameTurn(0);
        expect(pair.transports[1].closed).toBe(true);
        host.manager.doGameTurn(0);
        await pair.finish();
        expect(pair.stats()[0]).toEqual(pair.stats()[1]);
        expect(pair.stats()[0][1]).toMatchObject({ assets: 9, losses: 0, defeated: false });
        expect(pair.stats()[0][2]).toMatchObject({ assets: 0, losses: 9, defeated: true });
    }
    finally { pair.dispose(); }
}, 10000);

test('losing the local online connection releases a pending quit without inventing losses', async () => {
    const pair = await onlinePair(9, MainMenuScreenType.OnlineSetup, ['host', 'guest'], true);
    try {
        const host = pair.states[0];
        pair.transports[0].launchDescriptor = host.match.getLaunchDescriptor();
        host.manager.doGameTurn(0);
        pair.flush();
        const quitting = host.quit();
        pair.disconnect(0);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(host.manager.getErrorState()).toBe(true);
        await quitting;
        expect(host.navigations).toHaveLength(1);
        expect(host.navigations[0].params.route.params.quit).toBe(true);
        expect(pair.stats()[0][0]).toMatchObject({ assets: 9, losses: 0, defeated: false, resigned: false });
    }
    finally { pair.dispose(); }
}, 10000);

test('leaving the game screen cancels pending online quit and releases the original match listener', async () => {
    const pair = await onlinePair(1);
    try {
        const host = pair.states[0];
        host.manager.doGameTurn(0);
        pair.flush();
        const quitting = host.quit();
        expect((host.match.onSnapshotChange as any).listeners.size).toBe(1);
        host.screen.clearDebugBridge = () => {};
        await host.screen.onLeave();
        await quitting;
        expect((host.match.onSnapshotChange as any).listeners.size).toBe(0);
        expect((host.game.onEnd as any).listeners.size).toBe(1);
        expect(host.navigations).toHaveLength(0);
    }
    finally { pair.dispose(); }
});

test('LAN action factories retain the existing local resignation and drop guards', async () => {
    const pair = await onlinePair(1, MainMenuScreenType.LanSetup);
    try {
        const host = pair.states[0];
        for (const type of [ActionType.ResignGame, ActionType.DropPlayer]) {
            const action = host.factory.create(type);
            action.player = host.game.localPlayer;
            action.process();
        }
        expect(pair.stats()[0][0]).toMatchObject({ assets: 1, losses: 0, resigned: false, defeated: false });
    }
    finally { pair.dispose(); }
});

for (const first of [0, 1]) {
    test(`an online complete turn survives peer ${first} leaving before the other consumes it`, async () => {
        const pair = await onlinePair(1);
        try {
            pair.states[1].actions.push(pair.states[1].factory.create(ActionType.ResignGame));
            pair.states[0].manager.doGameTurn(0);
            pair.states[1].manager.doGameTurn(0);
            pair.flush();
            pair.states[first].manager.doGameTurn(0);
            expect(pair.transports[first].closed).toBe(true);
            pair.states[1 - first].manager.doGameTurn(0);
            await pair.finish();
            expect(pair.stats()[0]).toEqual(pair.stats()[1]);
            expect(pair.stats()[0][0]).toMatchObject({ assets: 1, losses: 0 });
            expect(pair.stats()[0][1]).toMatchObject({ assets: 0, losses: 1, resigned: true });
        }
        finally { pair.dispose(); }
    }, 10000);
}

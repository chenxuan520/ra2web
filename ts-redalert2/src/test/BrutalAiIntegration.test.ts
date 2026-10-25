import { describe, expect, test } from 'bun:test';
import { StorageKey } from '../LocalPrefs';
import { BotFactory } from '../game/bot/BotFactory';
import { DummyBot } from '../game/bot/DummyBot';
import { BuiltInBotAdapter } from '../game/ai/thirdpartbot/builtIn/BuiltInBotAdapter';
import { AiDifficulty } from '../game/gameopts/GameOpts';
import { PregameController } from '../gui/screen/mainMenu/lobby/PregameController';
import { LobbyForm } from '../gui/screen/mainMenu/lobby/component/LobbyForm';
import { LobbyType } from '../gui/screen/mainMenu/lobby/component/viewmodel/lobby';
import { Parser } from '../network/gameopt/Parser';
import { Serializer } from '../network/gameopt/Serializer';

function createLobby(saved = new Map<string, string>()) {
    const mode = { id: 1, label: 'Battle', mapFilter: 'standard', mpDialogSettings: {} };
    const map = {
        fileName: 'fixture.map', maxSlots: 4, gameModes: [mode], official: true,
        getFullMapTitle: () => 'Fixture',
    };
    const rules = {
        getMultiplayerCountries: () => [{ name: 'Americans', uiName: 'Americans' }],
        getMultiplayerColors: () => new Map([[0, { asHexString: () => '#ff0000' }]]),
        mpDialogSettings: { alliesAllowed: true, mustAlly: false },
    };
    return new PregameController(
        { get: (key: string) => key }, rules,
        { load: async () => ({ getBytes: () => new Uint8Array([1, 2, 3]), getSize: () => 3 }) },
        { getAll: () => [map], getByName: () => map },
        { getAll: () => [mode], getById: () => mode },
        { getItem: key => saved.get(key), setItem: (key, value) => { saved.set(key, value); }, removeItem: key => { saved.delete(key); } },
        'Human',
    );
}

describe('Brutal AI integration', () => {
    test('creates a real strategy bot for Brutal and keeps the training dummy available', () => {
        const factory = new BotFactory(undefined);
        const player = { isAi: true, name: 'Computer', country: { name: 'Americans' } };
        expect(factory.create({ ...player, aiDifficulty: AiDifficulty.Brutal })).toBeInstanceOf(BuiltInBotAdapter);
        expect(factory.create({ ...player, aiDifficulty: AiDifficulty.Normal })).toBeInstanceOf(BuiltInBotAdapter);
        expect(factory.create({ ...player, aiDifficulty: AiDifficulty.Easy })).toBeInstanceOf(DummyBot);
    });

    test('selects Brutal from the lobby and restores it after reopening the lobby', async () => {
        const saved = new Map<string, string>();
        const lobby = createLobby(saved);
        await lobby.initialize();
        const props = lobby.createLobbyFormProps({ lobbyType: LobbyType.Singleplayer, activeSlotIndex: 0 });
        expect(props.availableAiNames.get('Brutal')).toBe('GUI:AIBrutal');
        new LobbyForm(props).onPlayerSelect('Brutal', 1);
        expect(lobby.getGameOpts().aiPlayers[1]?.difficulty).toBe(AiDifficulty.Brutal);

        const restored = createLobby(saved);
        await restored.initialize();
        expect(restored.getGameOpts().aiPlayers[1]?.difficulty).toBe(AiDifficulty.Brutal);
        const restoredProps = restored.createLobbyFormProps({ lobbyType: LobbyType.Singleplayer, activeSlotIndex: 0 });
        expect(restoredProps.playerSlots[1].aiDifficulty).toBe(AiDifficulty.Brutal);
    });

    test('restores Brutal from JSON preferences alongside custom bots', async () => {
        const saved = new Map([[StorageKey.LastBots, JSON.stringify([
            null,
            { d: AiDifficulty.Brutal, c: -2, co: -2, s: -2, t: -2 },
            { d: AiDifficulty.Custom, b: 'custom-bot', c: -2, co: -2, s: -2, t: -2 },
        ])]]);
        const lobby = createLobby(saved);
        await lobby.initialize();
        expect(lobby.getGameOpts().aiPlayers[1]?.difficulty).toBe(AiDifficulty.Brutal);
        expect(lobby.getGameOpts().aiPlayers[2]?.customBotId).toBe('custom-bot');
    });

    test('preserves the existing numeric difficulty through replay options and lobby snapshots', async () => {
        const lobby = createLobby();
        await lobby.initialize();
        const props = lobby.createLobbyFormProps({ lobbyType: LobbyType.Singleplayer, activeSlotIndex: 0 });
        new LobbyForm(props).onPlayerSelect('Brutal', 1);

        const parsed = new Parser().parseOptions(new Serializer().serializeOptions(lobby.getGameOpts()));
        expect(AiDifficulty.Brutal).toBe(0);
        expect(parsed.aiPlayers[1]).toEqual(lobby.getGameOpts().aiPlayers[1]);
        expect(parsed.aiPlayers[0]).toBeUndefined();

        const guest = createLobby();
        guest.hydrate(lobby.getSnapshot());
        expect(guest.getGameOpts().aiPlayers[1]?.difficulty).toBe(AiDifficulty.Brutal);
        expect(guest.getSlotsInfo()[1].difficulty).toBe(AiDifficulty.Brutal);
    });
});

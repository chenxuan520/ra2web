import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const url = process.env.RA2WEB_TEST_URL ?? 'http://127.0.0.1:8080';
const executablePath = process.env.CHROME_BIN;
assert(executablePath, 'Set CHROME_BIN to an existing Chrome executable; this test never downloads a browser.');
const output = process.env.RA2WEB_TEST_OUTPUT ?? await mkdtemp(join(tmpdir(), 'ra2web-e2e-'));
const mode = process.env.RA2WEB_TEST_MODE ?? 'combat';
const mapName = process.env.RA2WEB_TEST_MAP ?? 'mp08t2.map';
const launchOptions = { executablePath, headless: true, args: ['--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] };
const browsers = await Promise.all([chromium.launch(launchOptions), chromium.launch(launchOptions)]);
const contexts = await Promise.all(browsers.map(browser => browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true })));
const pages = await Promise.all(contexts.map(context => context.newPage()));
const failures = [[], []];
const pageErrors = [[], []];
const diagnostics = [[], []];
const samples = [];
const scoreSamples = [];
const steps = [];
pages.forEach((page, index) => {
    page.on('pageerror', error => pageErrors[index].push(error.message));
    page.on('console', message => { if (message.type() === 'error') diagnostics[index].push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) failures[index].push({ url: response.url(), status: response.status() }); });
});
const api = (page, method, value) => page.evaluate(({ method, value }) => window.__ra2debug.online.onlineApi[method](value), { method, value });

async function enterOnline(page) {
    await page.goto(url);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForFunction(() => {
        const controller = window.__ra2debug?.mainMenuController;
        return controller?.screens.has(22) && controller.getCurrentScreenType() === 0;
    }, null, { timeout: 60000 });
    await page.getByText('在线对战', { exact: true }).click();
    await page.locator('[data-online-view="login"]').waitFor();
}

async function sample() {
    const tick = Math.max(...await Promise.all(pages.map(page => page.evaluate(() => window.__ra2debug.game.currentTick)))) + 10;
    await Promise.all(pages.map(page => page.evaluate(tick => {
        const debug = window.__ra2debug;
        const game = debug.game;
        const update = game.update.bind(game);
        debug.onlineSample = undefined;
        game.update = () => {
            update();
            if (game.currentTick === tick) {
                debug.onlineSample = {
                    tick, hash: game.getHash(),
                    objects: game.world.getAllObjects().filter(object => object.owner && !object.owner.isAi).map(object => ({ id: object.id, owner: object.owner.name, name: object.name, hp: object.healthTrait?.hitPoints, rx: object.tile.rx, ry: object.tile.ry })),
                };
                game.update = update;
            }
        };
    }, tick)));
    await Promise.all(pages.map(page => page.waitForFunction(() => Boolean(window.__ra2debug.onlineSample), null, { timeout: 30000 })));
    const pair = await Promise.all(pages.map(page => page.evaluate(() => window.__ra2debug.onlineSample)));
    assert.deepEqual(pair[0], pair[1], `Different game states at tick ${tick}`);
    samples.push(pair[0]);
    return pair[0];
}

function verifyDiagnostics() {
    assert.equal(pageErrors.flat().length, 0, `Uncaught browser errors: ${JSON.stringify(pageErrors)}`);
    const errors = diagnostics.flat().filter(message => !(new URL(url).protocol === 'http:' && message.startsWith("The Cross-Origin-Opener-Policy header has been ignored, because the URL's origin was untrustworthy.")));
    assert.equal(errors.length, 0, `Browser errors: ${JSON.stringify(diagnostics)}`);
    assert.equal(failures.flat().length, 0, `Failed resource requests: ${JSON.stringify(failures)}`);
}

async function quitAndReturn() {
    const [, guest] = pages;
    await guest.evaluate(() => window.__ra2debug.gameScreen.menu.open());
    await guest.waitForFunction(() => Boolean(window.__ra2debug.gameScreen.menu.getCurrentScreen()?.params?.onQuit), null, { timeout: 10000 });
    await guest.evaluate(() => window.__ra2debug.gameScreen.menu.getCurrentScreen().params.onQuit());
    await Promise.all(pages.map(page => page.waitForFunction(() => window.__ra2debug?.mainMenuController?.getCurrentScreenType() === 12, null, { timeout: 30000 })));
    await pages[0].getByText('胜利！', { exact: true }).waitFor({ timeout: 15000 });
    await pages[1].getByText('失败！', { exact: true }).waitFor({ timeout: 15000 });
    steps.push('winner-and-loser');
    await Promise.all(pages.map((page, index) => page.screenshot({ path: join(output, `score-${index}.png`) })));
    const scores = await Promise.all(pages.map(page => page.locator('.score-table tbody tr').evaluateAll(rows => rows.map(row => {
        const cells = [...row.querySelectorAll('td')].map(cell => cell.textContent.trim());
        return { name: cells[0], score: cells[3], kills: cells[4], losses: cells[5] };
    }).sort((left, right) => left.name.localeCompare(right.name)))));
    scoreSamples.push(scores);
    assert.deepEqual(scores[0], scores[1], 'Players disagree on post-quit score statistics');
    steps.push('score-statistics-match');
    await Promise.all(pages.map(page => page.getByText('继续', { exact: true }).click()));
    await Promise.all(pages.map(page => page.locator('[data-online-view="login"]').waitFor({ timeout: 15000 })));
    steps.push('return-to-online-login');
}

try {
    await Promise.all(pages.map(enterOnline));
    const [host, guest] = pages;
    const suffix = Date.now().toString(36).slice(-6);
    await Promise.all(pages.map(async (page, index) => {
        await page.locator('[data-online-input="username"]').fill(`${index ? 'guest' : 'host'}${suffix}`);
        await page.locator('[data-online-input="password"]').fill('testpass');
        await page.locator('[data-online-action="login"]').click();
        await page.waitForFunction(() => window.__ra2debug?.online?.session.isLoggedIn() && window.__ra2debug.online.rooms !== undefined, null, { timeout: 20000 });
    }));
    steps.push('real-pvpgn-login');
    if (new URL(url).protocol === 'https:') {
        for (const page of pages) {
            const connection = await page.evaluate(() => ({ secure: isSecureContext, isolated: crossOriginIsolated, url: window.__ra2debug.online.session.socket.url }));
            assert.equal(connection.secure, true);
            assert.equal(connection.isolated, true);
            assert.equal(connection.url, `${url.replace(/^https:/, 'wss:').replace(/\/$/, '')}/ws`);
        }
        steps.push('https-wss-origin-and-isolation-verified');
    }
    await host.locator('[data-online-action="create"]').click();
    await host.waitForFunction(() => Boolean(window.__ra2debug.online.roomSnapshot.roomState), null, { timeout: 20000 });
    await host.evaluate(async ({ mode, mapName }) => {
        const screen = window.__ra2debug.mainMenuController.getCurrentScreen();
        let map = await screen.mapFileLoader.load(mapName);
        let selectedName = mapName;
        if (mode === 'combat' || mode === 'large-map' || mode === 'transfer-leave') {
            let content = map.readAsString().replace(/^Official=.*$/im, 'Official=no').replace(/\[Waypoints\][\s\S]*?(?=\n\[|$)/i, '[Waypoints]\n0=50027\n1=50037\n');
            if (mode !== 'combat') content += '\n[OnlineTransferTest]\n' + Array.from({ length: 1600 }, (_, index) => `${index}=${'x'.repeat(1024)}`).join('\n');
            map = map.constructor.fromBytes(new TextEncoder().encode(content), mode === 'combat' ? 'online-combat-test.map' : 'online-large-test.map');
            if (mode === 'transfer-leave') {
                if (!screen.mapDir) throw new Error('Local map storage is required for the transfer-leave regression');
                await screen.mapDir.writeFile(map);
            }
            screen.mapList.addFromMapFile(map);
            selectedName = map.filename;
        }
        screen.pregameController.applyMapSelection({ gameMode: screen.gameModes.getById(1), mapName: selectedName, changedMapFile: map });
        const state = screen.pregameController.getSnapshot();
        state.gameOpts.unitCount = 5;
        state.gameOpts.gameSpeed = 3;
        screen.pregameController.hydrate(state);
        screen.roomSession.applyHostPregameSnapshot(state);
    }, { mode, mapName });
    const room = await host.evaluate(() => window.__ra2debug.online.session.getRoom());
    const rooms = await guest.evaluate(() => window.__ra2debug.online.session.listRooms());
    assert(rooms.some(entry => entry.id === room.id), 'PvPGN did not list the host room');
    await api(guest, 'joinRoom', room.id);
    if (mode === 'transfer-leave') {
        await guest.waitForFunction(() => {
            const transfer = window.__ra2debug.online.roomSnapshot.members.find(member => member.isSelf)?.mapTransfer;
            return transfer?.status === 'receiving' && transfer.receivedBytes > 0 && transfer.receivedBytes < transfer.totalBytes;
        }, null, { timeout: 15000 });
        await api(host, 'leaveRoom');
        await host.waitForFunction(() => window.__ra2debug.online.session.isLoggedIn() && !window.__ra2debug.online.session.getRoom(), null, { timeout: 15000 });
        await guest.waitForFunction(() => window.__ra2debug.online.session.isLoggedIn() && !window.__ra2debug.online.session.getRoom(), null, { timeout: 15000 });
        assert.equal(await guest.evaluate(() => window.__ra2debug.online.session.getSelf().name), `guest${suffix}`);
        await host.waitForTimeout(250);
        await host.locator('[data-online-action="create"]').click();
        await host.waitForFunction(() => Boolean(window.__ra2debug.online.roomSnapshot.roomState), null, { timeout: 15000 });
        const recreated = await host.evaluate(() => window.__ra2debug.online.session.getRoom());
        assert.notEqual(recreated.id, room.id);
        assert.equal(recreated.members.length, 1);
        assert.equal(await host.evaluate(() => window.__ra2debug.online.session.isLoggedIn()), true);
        const listedAgain = await guest.evaluate(() => window.__ra2debug.online.session.listRooms());
        assert(listedAgain.some(entry => entry.id === recreated.id));
        await guest.locator('[data-online-action="create"]').click();
        await guest.waitForFunction(() => Boolean(window.__ra2debug.online.roomSnapshot.roomState), null, { timeout: 15000 });
        const guestRoom = await guest.evaluate(() => window.__ra2debug.online.session.getRoom());
        assert.equal(guestRoom.hostPeerId, `guest${suffix}`);
        assert.equal(guestRoom.members.length, 1);
        assert.notEqual(guestRoom.id, recreated.id);
        steps.push('leave-during-map-transfer-retains-both-lobby-logins');
        steps.push('guest-creates-room-without-relogin');
        verifyDiagnostics();
        await writeFile(join(output, 'result.json'), JSON.stringify({ ok: true, mode, steps, failures, diagnostics }, null, 2));
        console.log(JSON.stringify({ ok: true, mode, steps, output }));
    }
    else {
    await Promise.all(pages.map(page => page.waitForFunction(() => window.__ra2debug.online.roomSnapshot.roomState?.humanAssignments.length === 2 && window.__ra2debug.online.roomSnapshot.localMapFileReady, null, { timeout: 30000 })));
    steps.push(mode === 'combat' || mode === 'large-map' ? 'custom-map-transferred-and-verified' : 'official-map-loaded');
    if (mode === 'large-map') {
        const sizes = await Promise.all(pages.map(page => page.evaluate(() => window.__ra2debug.online.roomSnapshot.roomState.gameOpts.mapSizeBytes)));
        assert(sizes[0] > 1.5 * 1024 * 1024);
        assert.equal(sizes[0], sizes[1]);
        steps.push('large-map-transfer-without-rate-disconnect');
    }
    if (mode === 'refresh') {
        await guest.reload();
        await guest.getByRole('button', { name: 'Close', exact: true }).click();
        await host.waitForFunction(() => window.__ra2debug.online.session.getRoom()?.members.length === 1, null, { timeout: 15000 });
        await guest.waitForFunction(() => {
            const controller = window.__ra2debug?.mainMenuController;
            return controller?.screens.has(22) && controller.getCurrentScreenType() === 0;
        }, null, { timeout: 60000 });
        await guest.getByText('在线对战', { exact: true }).click();
        await guest.locator('[data-online-input="username"]').fill(`guest${suffix}`);
        await guest.locator('[data-online-input="password"]').fill('testpass');
        await guest.locator('[data-online-action="login"]').click();
        await guest.waitForFunction(() => window.__ra2debug?.online?.session.isLoggedIn() && window.__ra2debug.online.rooms !== undefined, null, { timeout: 20000 });
        await api(guest, 'joinRoom', room.id);
        await Promise.all(pages.map(page => page.waitForFunction(() => window.__ra2debug.online.roomSnapshot.roomState?.humanAssignments.length === 2 && window.__ra2debug.online.roomSnapshot.localMapFileReady, null, { timeout: 30000 })));
        steps.push('browser-refresh-relogin-and-rejoin');
    }
    await api(host, 'setSlotConfig', { countryId: 0, colorId: 0, startPos: 0, teamId: -2 });
    await api(guest, 'setSlotConfig', { countryId: 5, colorId: 1, startPos: 1, teamId: -2 });
    await host.waitForFunction(() => window.__ra2debug.online.roomSnapshot.roomState.gameOpts.humanPlayers.every(player => player.countryId >= 0), null, { timeout: 10000 });
    await api(host, 'sendChat', 'host-to-guest');
    await guest.getByText('host-to-guest', { exact: false }).waitFor();
    await api(guest, 'sendChat', 'guest-to-host');
    await host.getByText('guest-to-host', { exact: false }).waitFor();
    steps.push('bidirectional-pvpgn-chat');
    await api(guest, 'setReady', true);
    await host.waitForFunction(() => window.__ra2debug.online.roomSnapshot.members.find(member => !member.isSelf)?.ready, null, { timeout: 10000 });
    await api(host, 'setReady', true);
    await host.waitForFunction(() => window.__ra2debug.online.canStart, null, { timeout: 10000 });
    if (mode === 'loading-drop') {
        await guest.route('**/cdn/game-res/v2/build-gen.mix*', async route => { await new Promise(resolve => setTimeout(resolve, 60000)); await route.continue().catch(() => undefined); });
    }
    await api(host, 'startGame');
    if (mode === 'loading-drop') {
        await guest.waitForFunction(() => Boolean(window.__ra2debug.online.matchSession), null, { timeout: 15000 });
        await guest.close();
        await host.getByText('胜利！', { exact: true }).waitFor({ timeout: 30000 });
        await host.waitForFunction(() => window.__ra2debug?.mainMenuController?.getCurrentScreenType() === 12, null, { timeout: 15000 });
        steps.push('loading-drop-does-not-deadlock');
        verifyDiagnostics();
        await writeFile(join(output, 'result.json'), JSON.stringify({ ok: true, mode, steps, failures, diagnostics }, null, 2));
        console.log(JSON.stringify({ ok: true, mode, steps, output }));
        process.exitCode = 0;
    }
    else {
    await Promise.all(pages.map(page => page.waitForFunction(() => window.__ra2debug?.game?.currentTick >= 30, null, { timeout: 90000 })));
    const launches = await Promise.all(pages.map(page => page.evaluate(() => window.__ra2debug.online.matchSession.getLaunchDescriptor())));
    assert.match(launches[0].gameId, /^[1-9]\d*$/);
    assert.equal(launches[0].gameId, launches[1].gameId);
    assert.equal(launches[0].timestamp, launches[1].timestamp);
    assert.notEqual(launches[0].localPeerId, launches[1].localPeerId);
    steps.push('real-startg-and-load-barrier');
    await Promise.all(pages.map((page, index) => page.screenshot({ path: join(output, `game-${index}.png`) })));
    const initial = await sample();
    if (mode === 'smoke' || mode === 'refresh') {
        steps.push('official-map-lockstep-smoke');
    }
    else if (mode === 'drop') {
        await guest.close();
        await host.getByText('胜利！', { exact: true }).waitFor({ timeout: 15000 });
        await host.waitForFunction(() => window.__ra2debug?.mainMenuController?.getCurrentScreenType() === 12, null, { timeout: 15000 });
        steps.push('midgame-drop-resolved');
    }
    else if (mode === 'combat' || mode === 'large-map') {
        await host.waitForFunction(() => window.__ra2debug.game.world.getAllObjects().some(object => (object.name === 'MTNK' && object.healthTrait.hitPoints < 300) || (object.name === 'HTNK' && object.healthTrait.hitPoints < 400)), null, { timeout: 60000 });
        await sample();
        steps.push('player-versus-player-damage');
    }
    else {
        const owned = launches.map(launch => initial.objects.filter(object => object.owner === launch.localPlayerName));
        for (let index = 0; index < pages.length; index++) {
            const unit = owned[index].find(object => object.name === 'MTNK' || object.name === 'HTNK');
            const target = { id: unit.id, rx: unit.rx + 3, ry: unit.ry };
            await pages[index].evaluate(target => window.__ra2debug.actionsApi.orderUnits([target.id], 0, target.rx, target.ry), target);
            await Promise.all(pages.map(page => page.waitForFunction(target => { const object = window.__ra2debug.game.getObjectById(target.id); return object.tile.rx === target.rx && object.tile.ry === target.ry; }, target, { timeout: 90000 })));
            await sample();
        }
        steps.push('both-players-move-through-lockstep');
        await Promise.all(pages.map((page, index) => page.evaluate(id => window.__ra2debug.actionsApi.orderUnits([id], 10), owned[index].find(object => object.name === 'AMCV' || object.name === 'SMCV').id)));
        await Promise.all(pages.map(page => page.waitForFunction(() => window.__ra2debug.game.world.getAllObjects().filter(object => object.name === 'GACNST' || object.name === 'NACNST').length === 2, null, { timeout: 90000 })));
        await sample();
        steps.push('both-construction-yards-deployed');
        await host.evaluate(() => window.__ra2debug.actionsApi.queueForProduction(0, 2, 'GAPOWR', 1));
        await Promise.all(pages.map(page => page.waitForFunction(() => window.__ra2debug.game.playerList.getAll().find(player => player.name.startsWith('host')).production.getQueue(0).status === 3, null, { timeout: 150000 })));
        const placement = await host.evaluate(() => {
            const debug = window.__ra2debug;
            const yard = debug.game.world.getAllObjects().find(object => object.owner === debug.localPlayer && object.name === 'GACNST');
            const worker = debug.game.getConstructionWorker(debug.localPlayer);
            for (let dx = -8; dx <= 8; dx++) for (let dy = -8; dy <= 8; dy++) {
                const position = { rx: yard.tile.rx + dx, ry: yard.tile.ry + dy };
                if (worker.canPlaceAt('GAPOWR', position, { normalizedTile: true })) return position;
            }
            throw new Error('No legal placement found');
        });
        await host.evaluate(position => window.__ra2debug.actionsApi.placeBuilding('GAPOWR', position.rx, position.ry), placement);
        await Promise.all(pages.map(page => page.waitForFunction(() => window.__ra2debug.game.world.getAllObjects().some(object => object.name === 'GAPOWR'), null, { timeout: 90000 })));
        await sample();
        steps.push('production-and-placement-synchronized');
        const attack = await host.evaluate(() => {
            const debug = window.__ra2debug;
            const target = debug.game.world.getAllObjects().find(object => object.name === 'GAPOWR');
            const tanks = debug.game.world.getAllObjects().filter(object => object.owner === debug.localPlayer && object.name === 'MTNK');
            debug.actionsApi.orderUnits(tanks.map(object => object.id), 3, target.id);
            return { id: target.id, hp: target.healthTrait.hitPoints };
        });
        await Promise.all(pages.map(page => page.waitForFunction(target => { const object = window.__ra2debug.game.world.getAllObjects().find(object => object.id === target.id); return !object || object.healthTrait.hitPoints < target.hp; }, attack, { timeout: 120000 })));
        await sample();
        await Promise.all(pages.map(page => page.waitForFunction(id => !window.__ra2debug.game.world.hasObjectId(id), attack.id, { timeout: 180000 })));
        await sample();
        steps.push('attack-damage-and-destruction-synchronized');
    }
    if (mode !== 'drop') await quitAndReturn();
    verifyDiagnostics();
    await writeFile(join(output, 'result.json'), JSON.stringify({ ok: true, url, mode, mapName, steps, samples, scoreSamples, failures, diagnostics }, null, 2));
    console.log(JSON.stringify({ ok: true, mode, mapName, gameId: launches[0].gameId, steps, stateComparisons: samples.length, output }));
    }
    }
}
catch (error) {
    await writeFile(join(output, 'result.json'), JSON.stringify({ ok: false, error: error.message, steps, samples, scoreSamples, failures, diagnostics, pageErrors }, null, 2));
    console.error(error);
    console.error(JSON.stringify({ output, diagnostics, failures, pageErrors }));
    process.exitCode = 1;
}
finally {
    await Promise.all(browsers.map(browser => browser.close()));
}

import { DataStream } from '../../data/DataStream';
import { SoundKey } from '../../engine/sound/SoundKey';
import { MixEntry } from '../../data/MixEntry';
import { buildMix } from '../../../deploy/prepare-resources';

export function fixtureMix(files: Record<string, string | Uint8Array>): Uint8Array {
    return buildMix(new Map(Object.entries(files).map(([name, bytes]) => [MixEntry.hashFilename(name), typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes])));
}

function fixtureMap(theater: string): string {
    const tiles = new Uint8Array((2 * 2 - 1) * 2 * 11 + 4);
    const compressed = new Uint8Array([tiles.length + 17, ...tiles, 17, 0, 0]);
    const packed = new DataStream(4 + compressed.length);
    packed.writeUint16(compressed.length);
    packed.writeUint16(tiles.length);
    packed.writeUint8Array(compressed);
    return `[Basic]\nName=Fixture ${theater}\nOfficial=yes\nNewINIFormat=4\nGameMode=standard\n[Map]\nSize=0,0,2,2\nLocalSize=0,0,2,2\nTheater=${theater}\n[Waypoints]\n0=1001\n1=2002\n[IsoMapPack5]\n1=${Buffer.from(packed.toUint8Array()).toString('base64')}\n[OverlayPack]\n1=\n[OverlayDataPack]\n1=\n`;
}

function fixtureShp(): Uint8Array {
    const stream = new DataStream(33);
    stream.writeUint16(0);
    stream.writeUint16(1);
    stream.writeUint16(1);
    stream.writeUint16(1);
    stream.writeUint16(0);
    stream.writeUint16(0);
    stream.writeUint16(1);
    stream.writeUint16(1);
    stream.writeUint32(1);
    stream.writeUint32(0);
    stream.writeUint32(0);
    stream.writeUint32(32);
    stream.writeUint8(1);
    return stream.toUint8Array();
}

export function fixtureSources(): Map<string, Uint8Array> {
    const emptyMix = fixtureMix({});
    const packet = '[MultiMaps]\n1=fixture\n2=missing\n3=snowfixture\n4=urbanfixture\n[fixture]\nDescription=NOSTR:Fixture\nMaxPlayers=2\nGameMode=standard\n[missing]\nMaxPlayers=2\nGameMode=standard\n[snowfixture]\nDescription=NOSTR:Snow\nFile=snowfixture.mpr\nMaxPlayers=2\nGameMode=standard\n[urbanfixture]\nDescription=NOSTR:Urban\nMaxPlayers=2\nGameMode=standard\n';
    const menuSounds = new Map([
        [SoundKey.GUIMoveInSound, 'uslide1'], [SoundKey.GUIMoveOutSound, 'uslide2'],
        [SoundKey.GUIMainButtonSound, 'umenucl1'], [SoundKey.GenericClick, 'umenucl1'],
        [SoundKey.GUICheckboxSound, 'umenucl1'], [SoundKey.GUIComboOpenSound, 'uacbopen'],
        [SoundKey.IncomingMessage, 'umessage'], [SoundKey.PlayerJoined, 'umenscol'],
    ]);
    const audioNames = ['fixture', ...new Set(menuSounds.values())];
    const idx = new DataStream(12 + audioNames.length * 36);
    idx.writeString('GABA');
    idx.writeUint32(2);
    idx.writeUint32(audioNames.length);
    for (let i = 0; i < audioNames.length; i++) {
        idx.writeString(audioNames[i], 'ASCII', 16);
        idx.writeUint32(i * 4);
        idx.writeUint32(4);
        idx.writeUint32(22050);
        idx.writeUint32(2);
        idx.writeUint32(0);
    }
    const bag = new Uint8Array(audioNames.length * 4);
    for (let i = 0; i < bag.length; i++) bag[i] = i;
    const audioVisual = '[AudioVisual]\n' + [...menuSounds].map(([key, name]) => `${SoundKey[key]}=${name}`).join('\n') + '\n';
    const soundIni = '[Defaults]\nVolume=100\nType=Global\n[SoundList]\n' + [...new Set(menuSounds.values())].map((name, i) => `${i}=${name}`).join('\n') + '\n' + [...new Set(menuSounds.values())].map(name => `[${name}]\nSounds=${name}\n`).join('');
    const shp = fixtureShp();
    const palette = new Uint8Array(768);
    palette[3] = 63;
    const hva = new DataStream(88);
    hva.writeString('fixture', 'ASCII', 16);
    hva.writeUint32(1);
    hva.writeUint32(1);
    const menuImages = ['mnscrnl.shp', 'lwscrnl.shp', 'sdtp.shp', 'sdwrnanm.shp', 'sdwrntmp.shp', 'sdbtnbkgd.shp', 'sdbtnanm.shp', 'sdbtm.shp', 'sdmpbtn.shp', 'mnbttn.shp'];
    const menuPalettes = ['shell.pal', 'shell2.pal', 'sdbtnanm.pal', 'mousepal.pal', 'mainbttn.pal'];
    const cssImages = ['cue_i.pcx', 'cce_i.pcx', 'cce_il.pcx', 'cce_ir.pcx', 'wouref.pcx', 'wodref.pcx', 'wouact.pcx', 'wodact.pcx', 'dnarrowr.pcx', 'dnarrowp.pcx', 'uparrowr.pcx', 'uparrowp.pcx', 'sbgript.pcx', 'sbgripm.pcx', 'sbgripb.pcx', 'trakgrip.pcx'];
    const ra2 = fixtureMix({
        'cache.mix': fixtureMix({ 'anim.pal': palette }),
        'load.mix': fixtureMix({ 'ls800ustates.shp': shp, 'ls800obs.shp': shp, 'mpls.pal': palette, 'mplsobs.pal': palette }),
        'local.mix': fixtureMix({ 'missions.pkt': packet, 'rules.ini': '[Fixture]\nOwner=local\n' + audioVisual, 'pudlgbgn.shp': shp, 'dialog.pal': palette, 'glsl.shp': shp, 'gls.pal': palette, 'duplicate.shp': shp }),
        'neutral.mix': fixtureMix({ 'neutral.shp': shp }),
        'conquer.mix': fixtureMix({ 'anim.shp': shp, 'shroud.shp': shp, 'mouse.shp': shp, 'tank.vxl': new TextEncoder().encode('Voxel Animation\0fixture'), 'tank.hva': hva.toUint8Array() }),
        'generic.mix': fixtureMix({ 'generic.shp': shp, 'duplicate.shp': new Uint8Array([9]), ...Object.fromEntries(menuImages.map(name => [name, shp])), ...Object.fromEntries(menuPalettes.map(name => [name, palette])), ...Object.fromEntries(cssImages.map(name => [name, new Uint8Array([1])])) }),
        'isogen.mix': fixtureMix({ 'isogen.shp': shp }),
        'sidec01.mix': fixtureMix({ 'sidebar.pal': palette, 'top.shp': shp }),
        'sidec02.mix': fixtureMix({ 'sidebar.pal': palette, 'top.shp': shp }),
        'isotemp.mix': fixtureMix({ 'fixture.tem': new Uint8Array([1]) }),
        'temperat.mix': fixtureMix({ 'temperat.pal': palette }),
        'tem.mix': emptyMix,
        'isosnow.mix': fixtureMix({ 'fixture.sno': new Uint8Array([2]) }),
        'snow.mix': fixtureMix({ 'snow.pal': palette }),
        'sno.mix': emptyMix,
        'isourb.mix': fixtureMix({ 'fixture.urb': new Uint8Array([3]) }),
        'urban.mix': fixtureMix({ 'urban.pal': palette }),
        'urb.mix': emptyMix,
    });
    return new Map([
        ['RA2.MIX', ra2],
        ['LANGUAGE.MIX', fixtureMix({ 'ra2.csf': new Uint8Array([1, 2, 3]), 'audio.mix': fixtureMix({ 'audio.idx': idx.toUint8Array(), 'audio.bag': bag, 'ally.wav': new Uint8Array([4]), 'sov.wav': new Uint8Array([5]), 'sound.wav': new Uint8Array([6]) }), 'cameo.mix': fixtureMix({ 'xxicon.shp': shp }) })],
        ['MULTI.MIX', fixtureMix({ 'fixture.map': fixtureMap('TEMPERATE'), 'snowfixture.mpr': fixtureMap('SNOW'), 'urbanfixture.map': fixtureMap('URBAN') })],
        ['ini.mix', fixtureMix({ 'rules.ini': '[Fixture]\nOwner=app\n', 'art.ini': '', 'ai.ini': '', 'sound.ini': soundIni, 'eva.ini': '[EVA]\nAllied=ally\nRussian=sov\n', 'missions.pkt': packet })],
        ['ra2cd.mix', fixtureMix({ 'mpmodescd.ini': '[Battle]\n1=GUI:Battle,STT:Battle,mpbattle.ini,standard,true\n', 'mpbattle.ini': '[MultiplayerDialogSettings]\n', 'rulescd.ini': '', 'artcd.ini': '', 'nodogengikills.ini': '', 'temperat.ini': '', 'snow.ini': '', 'urban.ini': '', 'ui.ini': '[Fixture]\nOwner=custom\n' })],
    ]);
}

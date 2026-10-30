import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { readMix, encodePng, verifySourceChecksum } from '/workspace/ra2web/ts-redalert2/deploy/prepare-resources';
import { ShpFile } from '/workspace/ra2web/ts-redalert2/src/data/ShpFile';
import { Palette } from '/workspace/ra2web/ts-redalert2/src/data/Palette';
import { IniFile } from '/workspace/ra2web/ts-redalert2/src/data/IniFile';
import { Rules } from '/workspace/ra2web/ts-redalert2/src/game/rules/Rules';
import { Art } from '/workspace/ra2web/ts-redalert2/src/game/art/Art';
import { ObjectType } from '/workspace/ra2web/ts-redalert2/src/engine/type/ObjectType';
import { SequenceType } from '/workspace/ra2web/ts-redalert2/src/game/art/SequenceType';
const out='/workspace/scratch/visible-deso-material';
const root='/workspace/ra2web/ts-redalert2';
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const originalLog=console.log;console.log=()=>{};
const sourceBytes=new Uint8Array(await Bun.file('/workspace/ra2web/.cache/ai-resources/source/RA2.MIX').arrayBuffer());
const crc=verifySourceChecksum('ra2.mix',sourceBytes);
const source=readMix('ra2.mix',sourceBytes);
const archives:any[]=[source];
for(const name of ['cache.mix','load.mix','local.mix','neutral.mix','audio.mix','conquer.mix','generic.mix','isogen.mix','cameo.mix','temperat.mix','tem.mix']) if(source.mix.containsFile(name))archives.push(readMix(name,source.mix.openFile(name).getBytes()));
const hits=archives.filter(a=>a.mix.containsFile('deso.shp'));
const palHits=archives.filter(a=>a.mix.containsFile('unittem.pal'));
if(!hits.length||!palHits.length)throw new Error(JSON.stringify({hits:hits.map(a=>a.name),palHits:palHits.map(a=>a.name),archives:archives.map(a=>a.name)}));
const archive=hits.at(-1),palArchive=palHits.at(-1);
const file=archive.mix.openFile('deso.shp');const shpBytes=file.getBytes();const shp=new ShpFile(file);
const paletteFile=palArchive.mix.openFile('unittem.pal'),paletteBytes=paletteFile.getBytes(),palette=new Palette(paletteFile);
const baseBytes=new Uint8Array(await Bun.file(root+'/public/ini.mix').arrayBuffer());
const customBytes=new Uint8Array(await Bun.file(root+'/public/res/ra2cd.mix').arrayBuffer());
const base=readMix('ini.mix',baseBytes).mix,custom=readMix('ra2cd.mix',customBytes).mix;
const ini=(name:string)=>new IniFile((custom.containsFile(name)?custom:base).openFile(name));
const rulesIni=new IniFile(base.openFile('rules.ini')).mergeWith(ini('rulescd.ini'));
const artIni=new IniFile(base.openFile('art.ini')).mergeWith(ini('artcd.ini'));
const rules=new Rules(rulesIni),art=new Art(rules,artIni,undefined,undefined).getObject('DESO',ObjectType.Infantry);
const sequences=Object.fromEntries([...art.sequences].map(([n,v]:[any,any])=>[SequenceType[n],v]));
const frames=shp.images.map((frame,index)=>{
 const canvas=new Uint8Array(shp.width*shp.height);
 for(let y=0;y<frame.height;y++)for(let x=0;x<frame.width;x++){
  const xx=x+frame.x, yy=y+frame.y;
  if(xx<0||yy<0||xx>=shp.width||yy>=shp.height)throw new Error('frame exceeds canvas');
  canvas[yy*shp.width+xx]=frame.imageData[y*frame.width+x];
 }
 const rgba=new Uint8Array(canvas.length*4);
 for(let i=0;i<canvas.length;i++){const c=palette.getColor(canvas[i]);rgba.set([c.r,c.g,c.b,canvas[i]?255:0],i*4);}
 return{index,x:frame.x,y:frame.y,width:frame.width,height:frame.height,decodedBytes:frame.imageData.length,rawIndexSha256:sha(frame.imageData),canvasIndexSha256:sha(canvas),canvasRgbaSha256:sha(rgba),silhouetteSha256:sha(canvas.map(v=>v?1:0)),canvas,rgba};
});
const groups=(key:string)=>Object.values(Object.groupBy(frames,f=>(f as any)[key])).filter(v=>v!.length>1).map(v=>v!.map(f=>f.index));
const referencedBy=(index:number)=>Object.entries(sequences).flatMap(([name,v]:[string,any])=>{
 const dirs=v.facingMult?8:1;const seen=[];
 for(let d=0;d<dirs;d++)for(let i=0;i<v.frameCount;i++)if(v.startFrame+d*v.facingMult+i===index)seen.push(d);
 return seen.length?[{sequence:name,directions:[...new Set(seen)]}]:[];
});
const comparisons=[...Array(8).keys(),86,164,292,293,294,295,296,297,298,299,300,305,310,313].map(i=>{
 const f=frames[i];return{frame:i,referencedBy:referencedBy(i),indexEquivalentTo:frames.filter(g=>g.canvasIndexSha256===f.canvasIndexSha256).map(g=>g.index),rgbaEquivalentTo:frames.filter(g=>g.canvasRgbaSha256===f.canvasRgbaSha256).map(g=>g.index),silhouetteEquivalentTo:frames.filter(g=>g.silhouetteSha256===f.silhouetteSha256).map(g=>g.index)};
});
const images=[];
for(const i of [0,86,164,292,293,294,295,296,297,298,299,300,305,310,313]){const f=frames[i];const data=encodePng(shp.width,shp.height,f.rgba);const name=`deso-${i}.png`;await Bun.write(out+'/'+name,data);images.push({path:name,bytes:data.length,sha256:sha(data)});}
const pixelDifferences=[[298,297],[298,313]].map(([a,b])=>({frames:[a,b], differences:[...frames[a].canvas].flatMap((v,i)=>v!==frames[b].canvas[i]?[{x:i%shp.width,y:Math.floor(i/shp.width),a:v,b:frames[b].canvas[i],aRemap:v>=16&&v<32,bRemap:frames[b].canvas[i]>=16&&frames[b].canvas[i]<32}]:[])}));
const result={kind:'original-deso-shp-decoded-material-audit',noGameTicks:true,noRendererFrames:true,source:{path:'source/RA2.MIX',bytes:sourceBytes.length,sha256:sha(sourceBytes),verifiedCrc32:crc.toString(16),archive:archive.name,archiveSha256:sha(archive.bytes),entry:'deso.shp',entryBytes:shpBytes.length,entrySha256:sha(shpBytes),allEntryHits:hits.map(a=>({name:a.name,sha256:sha(a.mix.openFile('deso.shp').getBytes())})),paletteArchive:palArchive.name,paletteSha256:sha(paletteBytes),palette:'unittem.pal'},ini:{baseSha256:sha(baseBytes),customSha256:sha(customBytes),mergedRulesSha256:sha(rulesIni.toString()),mergedArtSha256:sha(artIni.toString())},shp:{width:shp.width,height:shp.height,numImages:shp.numImages},sequences,frames:frames.map(({canvas,rgba,...f})=>({...f,referencedBy:referencedBy(f.index)})),indexEquivalentGroups:groups('canvasIndexSha256'),rgbaEquivalentGroups:groups('canvasRgbaSha256'),silhouetteEquivalentGroups:groups('silhouetteSha256'),pixelDifferences,comparisons,images,boundaries:['Palette is original unittem without owner remap or lighting; equal index canvases imply same palette pixels, but unequal index canvases may be equivalent under remap/lighting/occlusion.','No GPU rendering, no actual current-frame observation, no API integration, no proof of deployment or radiation from hidden state.','Full canvas includes SHP image placement; shadows are separate second-half frames.']};
await Bun.write(out+'/material.json',JSON.stringify(result,null,2)+'\n');console.log=originalLog;console.log(JSON.stringify({source:result.source,shp:result.shp,comparisons},null,2));

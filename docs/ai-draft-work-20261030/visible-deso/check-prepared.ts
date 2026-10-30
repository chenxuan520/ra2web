import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { readMix } from '/workspace/ra2web/ts-redalert2/deploy/prepare-resources';
const root='/workspace/ra2web/.cache/ai-resources/cdn/game-res/v2';
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const output:any[]=[];const log=console.log;console.log=()=>{};
for(const name of (await readdir(root)).filter(f=>f.endsWith('.mix')).sort()){
 const bytes=new Uint8Array(await Bun.file(root+'/'+name).arrayBuffer());const r=readMix(name,bytes);
 for(const entry of ['deso.shp','unittem.pal'])if(r.mix.containsFile(entry)){const e=r.mix.openFile(entry).getBytes();output.push({archive:name,archiveBytes:bytes.length,archiveSha256:sha(bytes),entry,entryBytes:e.length,entrySha256:sha(e)});}
}
console.log=log;await Bun.write('/workspace/scratch/visible-deso-material/prepared-cross-check.json',JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));

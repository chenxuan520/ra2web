# Archived unexecuted verification draft. Requires a completed, frozen 48-run report; no such report was produced.
import argparse, collections, hashlib, json, pathlib, subprocess
p=argparse.ArgumentParser();p.add_argument('raw');p.add_argument('--out',required=True);a=p.parse_args()
rawpath=pathlib.Path(a.raw);raw=rawpath.read_bytes();d=json.loads(raw);checks=[]
def ck(v,m):
    if not v: raise AssertionError(m)
    checks.append(m)
def sha(b):return hashlib.sha256(b).hexdigest()
ck(d['kind']=='real-engine-paid-scouting-route-mechanism','mechanism report identity')
ck(d['passed'] and d['errorCount']==0 and not d['engineErrors'],'actual zero errors')
ck(d['sourceStable'] and d['sourceBefore']==d['sourceAfter'],'source stable before/after')
ck(d['maxTicks']==4800 and d['seed']==840101 and not d['qualificationEligible'],'fixed development cutoff/seed; no qualification')
rs=d['runs'];bs=d['boundaries'];ck(len(rs)==48,'48 main repetitions')
expected={(m,s,c,arm,r) for m in ['mp08t2','tn01t2'] for s in [0,1] for c in ['open','defended'] for arm in ['S1','S2','R2'] for r in [0,1]}
def identity(r):
    i=r['identity'];return (i['map'],i['side'],i['scene'],i['arm'],r['repeat'])
ck(set(map(identity,rs))==expected and len(set(map(identity,rs)))==48,'all registered identities unique and complete')
ck(len(d['layouts'])==8,'8 registered physical scenario layouts')
for li,l in enumerate(d['layouts']):
    ck(l['scoutSlot']==l['side']==l['scoutPhysicalStart'] and l['opponentSlot']==1-l['side'],f'layout{li} physical + slot mapping')
    ck(l['settings']=={'credits':10000,'extraUnits':0,'engineDifficulty':[4,4]},f'layout{li} fair engine settings')
    ck(len(l['publicPoints'])==3 and len({(q['x'],q['y']) for q in l['publicPoints']})==3 and l['emptyPublicCandidateIndex']==0,f'layout{li} public directions/empty reference')
    ck(l['productionAvailable'] and not any(l['initialTargetVisible']),f'layout{li} prerequisites and initial hidden targets')
    ck(len(l['postPlacementPaths'])==3 and all(x['nodes']>0 for x in l['postPlacementPaths']),f'layout{li} complete paths from actual factory exit')
    if l['scene']=='defended':ck(l['initialGuardVisible'] is False,f'layout{li} guard not initially visible')
rows=[]
for idx,r in enumerate(rs+bs):
    tag=f'run{idx}';m=r['metrics'];ck(r['passed'] and r['qualificationEligible'] is False and all(r['checks'].values()),tag+' actual mechanism checks')
    ck(m['finalTick']==r['maxTicks'],tag+' cutoff reached')
    bal=m['initialCredits'];debit=credit=0
    for e in r['creditsLedger']:
        ck(e['before']==bal and e['after']-e['before']==e['delta'],tag+' ledger continuity')
        bal=e['after'];debit+=max(0,-e['delta']);credit+=max(0,e['delta'])
    ck((bal,debit,credit)==(m['finalCredits'],m['grossCreditsDecreased'],m['grossCreditsIncreased']),tag+' ledger independently summed')
    done=sum(x['paidCredits'] for x in r['production']);pending=sum(x['creditsSpent'] for x in m['finalQueue']['items'])
    ck(done==m['completedDogCredits'] and pending==m['inProgressCredits'] and debit-credit==done+pending,tag+' completed/in-progress/refund separated')
    ck(all(x['name']=='DOG' and x['paidCredits']==x['nominalCost']==200 for x in r['production']),tag+' real completed dogs paid actual 200')
    ck(m['completedDogs']==len(r['production']) and m['acceptedQuantity']<= (1 if r['identity']['arm']=='S1' else 2),tag+' output and admitted budget')
    coords={};total=0;auc=0;thresholds={str(n):None for n in [100,250,500,1000,2000]}
    for e in r['revealEvents']:
        ck(len(e['newTiles'])==len(set(e['newTiles'])) and not set(e['newTiles']) & coords.keys(),tag+' newly revealed tile union unique')
        for q in e['newTiles']:coords[q]=e['tick']
        total+=len(e['newTiles']);auc+=len(e['newTiles'])*(r['maxTicks']-e['tick']+1)
        ck(e['totalNew']==total,tag+' reveal cumulative count')
        for n in thresholds:
            if thresholds[n] is None and total>=int(n):thresholds[n]=e['tick']
    ck((total,auc,thresholds)==(m['newRevealedUnion'],m['unionTileTicks'],m['coverageThresholdTicks']),tag+' reveal area/curve/first threshold independently recomputed')
    ck(r['perDogRevealAttribution'] is None,tag+' missing per-unit attribution retained')
    if r['identity']['arm']=='R2':ck(m['overlapLeaseTicks']==0,tag+' distinct route leases')
    points=r['layout']['publicPoints'][:m['targetCount']]
    ck(all(x['target'] in points for x in r['commands']),tag+' all issued goals registered public coordinates')
    ck(m['commands']==len(r['commands']) and m['repeatedTargetCommands']==sum(x['reason']=='same-target-refresh' for x in r['commands']),tag+' command metrics')
    if idx<48:
        ck(r['maxTicks']==4800 and r['identity']['boundary'] is None,tag+' full main mechanism cutoff')
        expectedlayout=next(l for l in d['layouts'] if (l['map'],l['side'],l['scene'])==tuple(r['identity'][k] for k in ['map','side','scene']))
        ck(r['layout']==expectedlayout,tag+' frozen registered setup')
    rows.append({'identity':r['identity'],'repeat':r.get('repeat'),'maxTicks':r['maxTicks'],'passed':r['passed'],'metrics':m,'waypointSeen':r['waypointSeen'],'firstKnownObjects':r['firstKnownObjects'],'entranceFirstSeenByOpponent':r['entranceFirstSeenByOpponent'],'production':r['production'],'events':r['events'],'routeEvents':r['routeEvents'],'perDogRevealAttribution':None})
for key0 in {(m,s,c,arm) for m,s,c,arm,r in expected}:
    pair=[r for r in rs if identity(r)[:4]==key0];x=[{k:v for k,v in r.items() if k not in ['repeat','contentSha256']} for r in pair]
    ck(x[0]==x[1],f'{key0} actual full deterministic repeat equality')
ck(len(bs)==7 and collections.Counter(r['identity']['boundary'] for r in bs)==collections.Counter({'one-unknown':1,'all-explored':1,'unavailable':1,'in-progress':1,'cancel-refund':1,'hidden-permutation':2}),'7 boundary executions, 6 classes')
h=[r for r in bs if r['identity']['boundary']=='hidden-permutation'];cut=min(r['metrics']['firstHiddenTargetSeen'] if r['metrics']['firstHiddenTargetSeen'] is not None else r['maxTicks'] for r in h)
prefix=[ [c for c in r['commands'] if c['tick']<cut] for r in h]
ck(prefix[0]==prefix[1] and len(prefix[0])>0,'nonempty hidden-permutation command prefix equality')
ck(cut==d['hiddenPermutationCheck']['cutoffExclusive'],'legal discovery cutoff independently computed')
root=pathlib.Path('/workspace/ra2web');src=d['sourceBefore'];commit=src['commit']
for part,directory in [('game','src/game'),('engine','src')]:
    files=subprocess.check_output(['git','ls-tree','-r','--name-only',commit,'--','ts-redalert2/'+directory],cwd=root,text=True).splitlines();files=sorted(x for x in files if x.endswith('.ts'))
    dig=hashlib.sha256();prefix0='ts-redalert2/'+directory+'/'
    for f in files:
        dig.update(f[len(prefix0):].encode());dig.update(b'\0');dig.update(subprocess.check_output(['git','show',commit+':'+f],cwd=root));dig.update(b'\0')
    ck(src[part]=={'files':len(files),'sha256':dig.hexdigest()},part+' exact frozen Git object bytes')
for field,file in [('runnerSha256','e2e/ai-paid-scouting.ts'),('supportSha256','e2e/ai-specialty-scenarios.ts'),('tsconfigSha256','e2e/tsconfig.ai-paid-scouting.json')]:
    ck(src[field]==sha(subprocess.check_output(['git','show',commit+':ts-redalert2/'+file],cwd=root)),field+' frozen Git bytes')
ck(not src['workingTreeStatus'],'formal source scope clean')
out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=True)
(out/'compact-runs.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False,separators=(',',':'))+'\n' for r in rows))
receipt={'kind':'independent-root-paid-scouting-reconstruction','source':src,'raw':{'bytes':len(raw),'sha256':sha(raw)},'checks':len(checks),'mainRuns':48,'uniqueConditions':24,'boundaries':7,'qualificationEligible':False,'allPassed':True,'limits':['Original raw trace and engine behaviors remain audit inputs, not an independent reimplementation of the game.','Mechanism outcome only; no full Bot strategy or strength pass.']}
(out/'root-verification.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
(out/'pair-comparisons.json').write_text(json.dumps(d['routePairs'],ensure_ascii=False,indent=2)+'\n')
print(json.dumps(receipt,ensure_ascii=False))

import {test} from 'node:test'; import assert from 'node:assert/strict';
import {readConfig} from '../src/catalog.ts'; import {fetchUsageSnapshot,createUsageProvider} from '../src/usage.ts';
const config=readConfig({OMNIROUTE_BASE_URL:'https://example.test/v1'});
const response=(data:unknown)=> (async()=>Response.json(data)) as typeof fetch;
async function usageReport(native:boolean,key:string,payload:unknown){
 let calls=0;const fetchImpl=async()=>{calls++;return Response.json(payload);};
 const report=native?await createUsageProvider(config,fetchImpl).fetchUsage({provider:'omniroute',credential:{type:'api_key',apiKey:key}},{fetch:fetchImpl}):await fetchUsageSnapshot(config,key,fetchImpl);
 assert.ok(report);assert.equal(calls,1);return report;
}
test('personal daily and weekly USD usage maps without fabricating absent fields',async()=>{
 const r=await fetchUsageSnapshot(config,'secret',response({allowed:true,personal:{dailySpentUsd:1.25,dailyLimitUsd:5,dailyResetAtIso:'2026-11-09T00:00:00Z',weeklyLimitUsd:20}}));
 assert.equal(r.provider,'omniroute'); assert.equal(r.limits.length,2); assert.equal(r.limits[0].amount.used,1.25);assert.equal(r.limits[0].amount.limit,5);assert.equal(r.limits[0].window?.resetsAt,Date.parse('2026-11-09T00:00:00Z')); assert.equal(r.limits[1].amount.used,undefined);assert.equal(r.limits[1].status,'unknown');assert.equal(r.raw,undefined);
 assert.equal(r.limits[0].amount.usedFraction,.25);assert.equal(r.limits[0].amount.remaining,3.75);assert.equal(r.limits[0].amount.remainingFraction,.75);assert.equal(r.limits[0].status,'ok');
 assert.deepEqual(r.limits[1].amount,{unit:'usd',limit:20});
 assert.equal(r.limits[0].id,'personal:daily');assert.equal(r.limits[1].id,'personal:weekly');assert.equal(r.limits[0].scope.windowId,'daily');assert.equal(r.limits[0].window?.id,'daily');
});
test('provider snapshots map explicit raw quotas and do not guess units',async()=>{
 const s={connectionId:'a',provider:'claude',quotas:{session:{usedPercentage:60,resetAt:'2026-11-09T00:00:00Z'},ambiguous:{used:10},requests:{used:5,total:10}}};
 const r=await fetchUsageSnapshot(config,'secret',response({allowed:true,provider:s,providers:[s]}));
 assert.equal(r.limits.length,3);assert.equal(r.limits[0].amount.usedFraction,.6);assert.equal(r.limits[1].amount.usedFraction,undefined);assert.equal(r.limits[1].status,'unknown');assert.equal(r.limits[2].amount.usedFraction,.5);assert.match(r.notes!.join(' '),/cutoff/i);
});
test('personal zero limits, missing limits and explicit zero spending remain distinct',async()=>{
 for(const [personal,amount,status] of [
  [{dailySpentUsd:0,dailyLimitUsd:5},{unit:'usd',used:0,limit:5,usedFraction:0,remaining:5,remainingFraction:1},'ok'],
  [{dailySpentUsd:0,dailyLimitUsd:0},{unit:'usd',used:0,limit:0},'exhausted'],
  [{dailyLimitUsd:0},{unit:'usd',limit:0},'unknown'],
  [{dailySpentUsd:2},{unit:'usd',used:2},'unknown'],
 ] as const){
  const r=await fetchUsageSnapshot(config,'secret',response({allowed:true,personal}));
  assert.deepEqual(r.limits[0].amount,amount);assert.equal(r.limits[0].status,status);
 }
});
test('personal overage and extreme finite ratios expose finite exhausted amounts',async()=>{
 for(const [used,limit] of [[6.25,5],[Number.MAX_VALUE,Number.MIN_VALUE]]){
  const r=await fetchUsageSnapshot(config,'secret',response({allowed:true,personal:{dailySpentUsd:used,dailyLimitUsd:limit}}));
  assert.deepEqual(r.limits[0].amount,{unit:'usd',used,limit,usedFraction:1,remaining:0,remainingFraction:0});assert.equal(r.limits[0].status,'exhausted');
  for(const value of Object.values(r.limits[0].amount))if(typeof value==='number')assert.ok(Number.isFinite(value));
 }
});
test('raw explicit percentage overage stays exhausted while invalid remaining and bare amounts stay unknown',async()=>{
 const r=await fetchUsageSnapshot(config,'secret',response({allowed:true,provider:{connectionId:'a',provider:'upstream',quotas:{
  overage:{usedPercentage:125,remainingPercentage:25},
  extremePercentage:{usedPercentage:Number.MAX_VALUE},
  extremeRatio:{used:Number.MAX_VALUE,total:Number.MIN_VALUE},
  invalidRemaining:{remainingPercentage:101},
  negativeRemaining:{remainingPercentage:-1},
  invalidUsed:{usedPercentage:-1},
  bareUsed:{used:125},
  bareRemaining:{remaining:0},
 }}}));
 assert.equal(r.limits.length,8);
 assert.deepEqual(r.limits[0].amount,{unit:'percent',used:125,limit:100,usedFraction:1});
 assert.equal(r.limits[1].amount.used,Number.MAX_VALUE);assert.equal(r.limits[2].amount.used,Number.MAX_VALUE);assert.equal(r.limits[2].amount.limit,Number.MIN_VALUE);
 for(const limit of r.limits.slice(0,3)){
  assert.equal(limit.status,'exhausted');assert.equal(limit.amount.usedFraction,1);
  for(const value of Object.values(limit.amount))if(typeof value==='number')assert.ok(Number.isFinite(value));
 }
 for(const limit of r.limits.slice(3)){assert.deepEqual(limit.amount,{unit:'unknown'});assert.equal(limit.status,'unknown');}
});
test('empty, invalid, refused and forbidden usage are never zero',async()=>{
 assert.deepEqual((await fetchUsageSnapshot(config,'secret',response({allowed:true,personal:null,provider:null,providers:[]}))).limits,[]);
 await assert.rejects(fetchUsageSnapshot(config,'secret',response({allowed:false,error:{message:'secret'}})),/refused/);
 await assert.rejects(fetchUsageSnapshot(config,'secret',response({})),/invalid/);
 await assert.rejects(fetchUsageSnapshot(config,'secret',(async()=>new Response('secret',{status:403})) as typeof fetch),/allowUsageCommand/);
});
test('native provider uses credential and avoids stale last-good reports',async()=>{
 const provider=createUsageProvider(config,response({allowed:true})); assert.equal(provider.id,'omniroute');assert.equal(provider.retainLastGoodOnFailure,false);
 const result=await provider.fetchUsage({provider:'omniroute',credential:{type:'api_key',apiKey:'secret'}},{fetch:fetch as any});assert.deepEqual(result?.limits,[]);
});
for(const native of [false,true]){
 const mode=native?'native':'direct';
 test(`${mode} usage normalizes credential echoes before redaction and truncation`,async()=>{
  const marker='sk-private-test-value',controlEcho='sk-\x1bprivate-test-value';
  for(const key of [marker,controlEcho]){
   const report=await usageReport(native,key,{allowed:true,providers:[{
    provider:`provider-${controlEcho}`,connectionId:`account-${controlEcho}`,quotas:{
     [`window-${marker}`]:{usedPercentage:25},
     [`window-${controlEcho}`]:{usedPercentage:100},
     ['x'.repeat(115)+controlEcho]:{usedPercentage:30},
    },
   },{provider:'x'.repeat(115)+controlEcho,connectionId:'x'.repeat(115)+controlEcho,quotas:{session:{usedPercentage:40}}}]});
   const text=JSON.stringify(report);assert.ok(!text.includes(marker));assert.ok(!text.includes('sk-pr'));assert.ok(!text.includes('\\u001b'));assert.match(text,/redacted/);
   assert.equal(report.limits.length,4);assert.equal(report.limits[0].label,'provider-[redacted] window-[redacted] (raw)');assert.equal(report.limits[0].window?.label,'window-[redacted]');
   assert.equal(report.limits[2].window?.label,'x'.repeat(115)+'[reda');assert.equal(report.limits[3].label,'x'.repeat(115)+'[reda session (raw)');
   assert.equal(report.limits[0].amount.usedFraction,.25);assert.equal(report.limits[1].amount.usedFraction,1);assert.equal(report.limits[1].status,'exhausted');
   assert.equal(new Set(report.limits.map(limit=>limit.id)).size,4);
  }
 });
 test(`${mode} usage keeps colliding account labels distinct and raw identities stable`,async()=>{
  const key='sk-private-test-value',long='a'.repeat(120);
  for(const [first,second] of [
   [{provider:'upstream',connectionId:'a'},{provider:'upstream',connectionId:'a\x1b'}],
   [{provider:'upstream',connectionId:long+'1'},{provider:'upstream',connectionId:long+'2'}],
   [{provider:'upstream',connectionId:key},{provider:'upstream',connectionId:'[redacted]'}],
   [{provider:'upstream',connectionId:'a'},{provider:'upstream\x1b',connectionId:'a'}],
   [{provider:'first',connectionId:'shared'},{provider:'second',connectionId:'shared'}],
   [{provider:'a:b',connectionId:'c'},{provider:'a',connectionId:'b:c'}],
  ]){
   const a={...first,quotas:{session:{usedPercentage:25}}},b={...second,quotas:{session:{usedPercentage:100}}};
   const forward=await usageReport(native,key,{allowed:true,providers:[a,b,{...a}]});
   const reverse=await usageReport(native,key,{allowed:true,providers:[b,a,{...b}]});
   assert.equal(forward.limits.length,2);assert.notEqual(forward.limits[0].scope.accountId,forward.limits[1].scope.accountId);assert.notEqual(forward.limits[0].id,forward.limits[1].id);
   assert.deepEqual(forward.limits.map(limit=>[limit.amount.usedFraction,limit.status]),[[.25,'ok'],[1,'exhausted']]);assert.deepEqual(reverse.limits,[...forward.limits].reverse());
   assert.ok(!JSON.stringify(forward).includes(key));
   const changed=await usageReport(native,key,{allowed:true,providers:[{...a,quotas:{session:{usedPercentage:50}}}]});
   assert.equal(changed.limits[0].id,forward.limits[0].id);assert.equal(changed.limits[0].scope.accountId,forward.limits[0].scope.accountId);
  }
 });
 test(`${mode} usage uses raw quota names rather than colliding display labels for identity`,async()=>{
  const key='sk-private-test-value',long='q'.repeat(120),names=['session','session\x1b',long+'1',long+'2',`window-${key}`,'window-[redacted]'];
  const entries=names.map((name,i)=>[name,{usedPercentage:(i+1)*10}] as const);
  const forward=await usageReport(native,key,{allowed:true,provider:{provider:'upstream',connectionId:'a',quotas:Object.fromEntries(entries)}});
  const reverse=await usageReport(native,key,{allowed:true,provider:{provider:'upstream',connectionId:'a',quotas:Object.fromEntries([...entries].reverse())}});
  assert.equal(forward.limits.length,names.length);assert.deepEqual(reverse.limits,[...forward.limits].reverse());
  assert.equal(new Set(forward.limits.map(limit=>limit.id)).size,names.length);assert.equal(new Set(forward.limits.map(limit=>limit.scope.windowId)).size,names.length);assert.equal(new Set(forward.limits.map(limit=>limit.window?.id)).size,names.length);
  assert.equal(new Set(forward.limits.map(limit=>limit.scope.accountId)).size,1);
  assert.deepEqual(forward.limits.map(limit=>limit.window?.label),['session','session',long,long,'window-[redacted]','window-[redacted]']);
  for(const limit of forward.limits){assert.equal(limit.window?.id,limit.scope.windowId);assert.equal(limit.label,`upstream ${limit.window?.label} (raw)`);}
  assert.ok(!JSON.stringify(forward).includes(key));
 });
 test(`${mode} usage anonymous fallbacks cannot collide with real connection names`,async()=>{
  const report=await usageReport(native,'secret',{allowed:true,providers:[
   {provider:'upstream',quotas:{session:{usedPercentage:25}}},
   {provider:'upstream',connectionId:'snapshot-1',quotas:{session:{usedPercentage:100}}},
   {provider:'upstream',quotas:{session:{usedPercentage:50}}},
  ]});
  assert.equal(report.limits.length,3);assert.equal(new Set(report.limits.map(limit=>limit.scope.accountId)).size,3);assert.equal(new Set(report.limits.map(limit=>limit.id)).size,3);
  assert.deepEqual(report.limits.map(limit=>limit.amount.usedFraction),[.25,1,.5]);
 });
}

import {test} from 'node:test'; import assert from 'node:assert/strict';
import {readConfig} from '../src/catalog.ts'; import {fetchUsageSnapshot,createUsageProvider} from '../src/usage.ts';
const config=readConfig({OMNIROUTE_BASE_URL:'https://example.test/v1'});
const response=(data:unknown)=> (async()=>Response.json(data)) as typeof fetch;
test('personal daily and weekly USD usage maps without fabricating absent fields',async()=>{
 const r=await fetchUsageSnapshot(config,'secret',response({allowed:true,personal:{dailySpentUsd:1.25,dailyLimitUsd:5,dailyResetAtIso:'2026-11-09T00:00:00Z',weeklyLimitUsd:20}}));
 assert.equal(r.provider,'omniroute'); assert.equal(r.limits.length,2); assert.equal(r.limits[0].amount.used,1.25);assert.equal(r.limits[0].amount.limit,5);assert.equal(r.limits[0].window?.resetsAt,Date.parse('2026-11-09T00:00:00Z')); assert.equal(r.limits[1].amount.used,undefined);assert.equal(r.limits[1].status,'unknown');assert.equal(r.raw,undefined);
 assert.equal(r.limits[0].amount.usedFraction,.25);assert.equal(r.limits[0].amount.remaining,3.75);assert.equal(r.limits[0].amount.remainingFraction,.75);assert.equal(r.limits[0].status,'ok');
 assert.deepEqual(r.limits[1].amount,{unit:'usd',limit:20});
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
test('native usage report redacts credential echoes before truncating remote labels',async()=>{
 const key='sk-private-test-value';
 const r=await fetchUsageSnapshot(config,key,response({allowed:true,providers:[{provider:`provider-${key}`,connectionId:`account-${key}`,quotas:{[`window-${key}`]:{usedPercentage:25},['x'.repeat(115)+key]:{usedPercentage:30}}}]}));
 const text=JSON.stringify(r);assert.ok(!text.includes(key));assert.ok(!text.includes('sk-pr'));assert.match(text,/redacted/);
});

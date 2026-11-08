import {test} from 'node:test';import assert from 'node:assert/strict';
import {readConfig} from '../src/catalog.ts';import {runDoctor} from '../src/doctor.ts';
const config=readConfig({OMNIROUTE_BASE_URL:'https://example.test/v1'});
test('doctor only GETs models and health, exposes sanitized checks and version',async()=>{
 const urls:string[]=[];const r=await runDoctor(config,'secret',(async(url,init)=>{urls.push(String(url));assert.equal(init?.method,'GET');return String(url).endsWith('/health')?Response.json({data:[{id:'a',state:'ok'},{id:'b',state:'cooling'}]}):Response.json({data:[{id:'a'}]},{headers:{'x-omniroute-version':'3.8.54'}});}) as typeof fetch);
 assert.deepEqual(urls,['https://example.test/v1/models','https://example.test/v1/models/health']);assert.equal(r.version,'3.8.54');assert.equal(r.modelCount,1);assert.equal(r.health?.states.cooling,1);assert.match(r.checks.map(c=>c.message).join(' '),/no pause observed/i);
});
test('catalog schema identity is not a deployment version or an unhealthy gateway',async()=>{
 const r=await runDoctor(config,'secret',(async(url)=>String(url).endsWith('/health')?Response.json({data:[{id:'a',state:'ok'}]}):Response.json({data:[{id:'a'}]},{headers:{'X-Model-Catalog-Version':'model-metadata-v1:static'}})) as typeof fetch);
 assert.ok(r.checks.every(c=>c.status==='ok'));assert.equal(r.version,undefined);assert.equal(r.modelCount,1);assert.deepEqual(r.health,{total:1,states:{ok:1}});
 assert.match(r.checks.find(c=>c.id==='version')!.message,/inference was not tested/i);
});
test('present malformed and empty deployment versions warn without leaking the value',async()=>{
 for(const version of ['private-invalid-version','']){
  const r=await runDoctor(config,'secret',(async(url)=>String(url).endsWith('/health')?Response.json({data:[{id:'a',state:'ok'}]}):Response.json({data:[{id:'a'}]},{headers:{'x-omniroute-version':version}})) as typeof fetch);
  assert.equal(r.version,undefined);assert.equal(r.checks.find(c=>c.id==='version')?.status,'warning');
  if(version)assert.ok(!JSON.stringify(r).includes(version));
 }
});
test('optional missing health does not invalidate successful basic catalog',async()=>{
 const r=await runDoctor(config,'secret',(async(url)=>String(url).endsWith('/health')?new Response('secret',{status:404}):Response.json({data:[]})) as typeof fetch);
 assert.equal(r.checks.find(c=>c.id==='models')?.status,'ok');assert.equal(r.checks.find(c=>c.id==='health')?.status,'warning');assert.ok(!JSON.stringify(r).includes('secret'));
});
test('invalid catalog is reported, not silently accepted',async()=>{
 const r=await runDoctor(config,'secret',(async()=>Response.json({data:[{id:99}]})) as typeof fetch);assert.equal(r.checks.find(c=>c.id==='models')?.status,'error');
});
test('doctor shows validated endpoint and transport before other checks',async()=>{
 const r=await runDoctor(config,'secret',(async()=>Response.json({data:[]})) as typeof fetch);
 assert.equal(r.checks[0].id,'endpoint');assert.match(r.checks[0].message,/https:\/\/example.test\/v1/);assert.match(r.checks[0].message,/HTTPS/);
 const local=await runDoctor({...config,baseUrl:'http://localhost:20128/v1'},'secret',(async()=>Response.json({data:[]})) as typeof fetch);assert.match(local.checks[0].message,/loopback HTTP/);
});
test('doctor rejects unsafe configured URLs without exposing components or sending requests',async()=>{
 for(const baseUrl of ['https://user:secret@example.test/v1','https://example.test/v1?token=secret','https://example.test/v1#secret']){
  let sent=false;const r=await runDoctor({...config,baseUrl},'secret',(async()=>{sent=true;return Response.json({data:[]});}) as typeof fetch);
  assert.equal(r.checks[0].id,'endpoint');assert.equal(r.checks[0].status,'error');assert.equal(sent,false);assert.ok(!JSON.stringify(r).includes('secret'));
 }
});

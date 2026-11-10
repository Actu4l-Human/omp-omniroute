import {test} from 'node:test';import assert from 'node:assert/strict';
import {readConfig} from '../src/catalog.ts';import {runDoctor} from '../src/doctor.ts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const config=readConfig({OMNIROUTE_BASE_URL:'https://example.test/v1'});
test('doctor only GETs models, health and sessions, exposes sanitized checks and version',async()=>{
 const urls:string[]=[];const r=await runDoctor(config,'secret',(async(url,init)=>{urls.push(String(url));assert.equal(init?.method,'GET');return String(url).endsWith('/me/sessions')?Response.json({sessions:[],total:0,limit:20,offset:0}):String(url).includes('/health')?Response.json({data:[{id:'a',state:'ok'},{id:'b',state:'cooling'}]}):Response.json({data:[{id:'a'}]},{headers:{'x-omniroute-version':'3.8.54'}});}) as typeof fetch);
 assert.deepEqual(urls,['https://example.test/v1/models','https://example.test/v1/models/health','https://example.test/v1/me/sessions']);assert.equal(r.version,'3.8.54');assert.equal(r.modelCount,1);assert.equal(r.health?.states.cooling,1);assert.match(r.checks.map(c=>c.message).join(' '),/no pause observed/i);assert.equal(r.checks.find(c=>c.id==='sessions')?.status,'ok');
});
test('catalog schema identity is not a deployment version or an unhealthy gateway',async()=>{
 const r=await runDoctor(config,'secret',(async(url)=>String(url).includes('/health')?Response.json({data:[{id:'a',state:'ok'}]}):Response.json({data:[{id:'a'}]},{headers:{'X-Model-Catalog-Version':'model-metadata-v1:static'}})) as typeof fetch);
 assert.ok(r.checks.every(c=>c.status==='ok'));assert.equal(r.version,undefined);assert.equal(r.modelCount,1);assert.deepEqual(r.health,{total:1,states:{ok:1},coverage:{catalog:1,matched:1,unobserved:0,healthOnly:0}});
 assert.match(r.checks.find(c=>c.id==='version')!.message,/inference was not tested/i);
});
test('present malformed and empty deployment versions warn without leaking the value',async()=>{
 for(const version of ['private-invalid-version','']){
  const r=await runDoctor(config,'secret',(async(url)=>String(url).includes('/health')?Response.json({data:[{id:'a',state:'ok'}]}):Response.json({data:[{id:'a'}]},{headers:{'x-omniroute-version':version}})) as typeof fetch);
  assert.equal(r.version,undefined);assert.equal(r.checks.find(c=>c.id==='version')?.status,'warning');
  if(version)assert.ok(!JSON.stringify(r).includes(version));
 }
});
test('optional missing health does not invalidate successful basic catalog',async()=>{
 const r=await runDoctor(config,'secret',(async(url)=>String(url).includes('/health')?new Response('secret',{status:404}):Response.json({data:[]})) as typeof fetch);
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
test('partial health coverage is informational and uses raw catalog IDs independently of filters',async()=>{
 const r=await runDoctor({...config,include:['not-listed']},'secret',(async(url)=>String(url).includes('/health')?Response.json({data:[{id:'a',state:'ok'}]}):Response.json({data:[{id:'a'},{id:'b'},{id:'c'}]})) as typeof fetch);
 assert.deepEqual(r.health,{total:1,states:{ok:1},coverage:{catalog:3,matched:1,unobserved:2,healthOnly:0}});
 assert.equal(r.checks.find(c=>c.id==='health')?.status,'ok');
});
test('disjoint health IDs do not imply catalog observations or unhealthy catalog models',async()=>{
 const r=await runDoctor(config,'secret',(async(url)=>String(url).includes('/health')?Response.json({data:[{id:'A',state:'ok'},{id:'a ',state:'ok'}]}):Response.json({data:[{id:'a'},{id:'b'}]})) as typeof fetch);
 assert.deepEqual(r.health?.coverage,{catalog:2,matched:0,unobserved:2,healthOnly:2});
 assert.equal(r.checks.find(c=>c.id==='health')?.status,'ok');
});
test('coverage counts unique exact IDs while health totals and states retain every observation',async()=>{
 const r=await runDoctor(config,'secret',(async(url)=>String(url).includes('/health')?Response.json({data:[{id:'a',state:'ok'},{id:'a',state:'cooling'},{id:'x',state:'ok'},{id:'x',state:'ok'}]}):Response.json({data:[{id:'a'},{id:'a'},{id:'b'},{id:'b'}]})) as typeof fetch);
 assert.equal(r.modelCount,4);assert.deepEqual(r.health,{total:4,states:{ok:3,cooling:1},coverage:{catalog:2,matched:1,unobserved:1,healthOnly:1}});
 assert.equal(r.checks.find(c=>c.id==='health')?.status,'warning');
});
test('empty health observations warn even when the catalog is empty',async()=>{
 for(const data of [[{id:'a'},{id:'a'},{id:'b'}],[]]){
  const r=await runDoctor(config,'secret',(async(url)=>String(url).includes('/health')?Response.json({data:[]}):Response.json({data})) as typeof fetch);
  const count=data.length?2:0;
  assert.deepEqual(r.health,{total:0,states:{},coverage:{catalog:count,matched:0,unobserved:count,healthOnly:0}});
  assert.equal(r.checks.find(c=>c.id==='health')?.status,'warning');
 }
});
test('doctor leaves override checks absent when no file is configured',async()=>{
 const r=await runDoctor(config,'secret',(async()=>Response.json({data:[]})) as typeof fetch);
 assert.equal(r.overrides,undefined);assert.ok(!r.checks.some(c=>c.id.startsWith('overrides')));
});
test('doctor validates overrides independently and continues network checks after sanitized failures',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'private-doctor-'));
 try{
  const path=join(dir,'private-overrides.json');
  for(const [contents,expected] of [[undefined,/not found/i],['{"private-model":',/valid JSON/i],['{"private-model":{"private-field":"private-value"}}',/unsupported field or value/i],[' '.repeat(262145),/256 KiB/]] as const){
   if(contents!==undefined)await writeFile(path,contents);
   const urls:string[]=[];
   const r=await runDoctor({...config,overridesFile:path},'private-key',(async(url)=>{urls.push(String(url));return Response.json({data:[{id:'a',state:'ok'}]});}) as typeof fetch);
   const check=r.checks.find(c=>c.id==='overrides-file')!;
   assert.equal(check.status,'error');assert.match(check.message,/OMNIROUTE_OVERRIDES_FILE/);assert.match(check.message,expected);
   assert.deepEqual(urls,['https://example.test/v1/models','https://example.test/v1/models/health','https://example.test/v1/me/sessions']);
   assert.equal(r.checks.find(c=>c.id==='models')?.status,'ok');assert.equal(r.checks.find(c=>c.id==='health')?.status,'ok');assert.equal(r.overrides,undefined);
   for(const privateText of [dir,path,'private-key','private-model','private-field','private-value'])assert.ok(!JSON.stringify(r).includes(privateText));
  }
  const unreadable=await runDoctor({...config,overridesFile:dir},'secret',(async()=>Response.json({data:[]})) as typeof fetch);
  assert.equal(unreadable.checks.find(c=>c.id==='overrides-file')?.status,'error');assert.ok(!JSON.stringify(unreadable).includes(dir));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('doctor audits exact raw override IDs independently of filters and never rewrites qualified keys',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'omp-doctor-'));
 try{
  const path=join(dir,'overrides.json');
  await writeFile(path,JSON.stringify({'vendor/a':{},'omniroute/vendor/a':{},'omniroute/vendor/b':{},missing:{}}));
  const r=await runDoctor({...config,overridesFile:path,include:['not-listed'],exclude:['*']},'secret',(async()=>Response.json({data:[{id:'vendor/a',state:'ok'},{id:'vendor/b',state:'ok'},{id:'omniroute/vendor/b',state:'ok'}]})) as typeof fetch);
  assert.equal(r.checks.find(c=>c.id==='overrides-file')?.status,'ok');
  assert.deepEqual(r.overrides,{matched:2,unmatched:[{id:'omniroute/vendor/a',suggestedId:'vendor/a'},{id:'missing'}]});
  const check=r.checks.find(c=>c.id==='overrides-match')!;
  assert.equal(check.status,'warning');
  await writeFile(path,JSON.stringify({'vendor/a':{}}));
  const matched=await runDoctor({...config,overridesFile:path},'secret',(async()=>Response.json({data:[{id:'vendor/a',state:'ok'}]})) as typeof fetch);
  assert.deepEqual(matched.overrides,{matched:1,unmatched:[]});assert.equal(matched.checks.find(c=>c.id==='overrides-match')?.status,'ok');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('catalog outage or missing credentials retain file validation without claiming override matches',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'omp-doctor-'));
 try{
  const path=join(dir,'overrides.json');
  for(const valid of [true,false]){
   await writeFile(path,valid?'{"vendor/a":{}}':'{broken');
   for(const key of ['secret',undefined]){
    const r=await runDoctor({...config,overridesFile:path},key,(async()=>new Response('private-body',{status:503})) as typeof fetch);
    assert.equal(r.checks.find(c=>c.id==='overrides-file')?.status,valid?'ok':'error');
    assert.equal(r.checks.find(c=>c.id==='models')?.status,'error');
    assert.equal(r.overrides,undefined);assert.ok(!r.checks.some(c=>c.id==='overrides-match'));assert.ok(!JSON.stringify(r).includes('private-body'));
   }
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, mapCatalog, fetchCatalog } from '../src/catalog.ts';

const env = { OMNIROUTE_BASE_URL: 'https://router.example.com/v1/', OMNIROUTE_API_KEY: 'test-key' };
const config = () => readConfig(env);
const chat = (extra = {}) => ({ id: 'vendor/chat', context_length: 32000, max_output_tokens: 4096,
  capabilities: { reasoning: true, tool_calling: true, vision: true, effort_tiers: ['low', 'medium', 'high'] },
  input_modalities: ['text', 'image'], pricing: { input: 2, output: 8, cached: 0.5, cache_creation: 2.5 }, ...extra });

test('configuration normalizes the API root and keeps keys out of returned settings', () => {
  assert.equal(config().baseUrl, 'https://router.example.com/v1');
  assert.equal(readConfig({...env, OMNIROUTE_BASE_URL: 'https://router.example.com'}).baseUrl, config().baseUrl);
  assert.equal(JSON.stringify(config()).includes('test-key'), false);
  assert.throws(() => readConfig({...env, OMNIROUTE_BASE_URL: 'https://u:p@router.example/v1'}), /credentials/);
  assert.throws(() => readConfig({...env, OMNIROUTE_BASE_URL: 'http://router.example/v1'}), /HTTPS/);
  assert.throws(() => readConfig({...env, OMNIROUTE_REFRESH_MS: 'NaN'}), /REFRESH/);
  assert.equal(readConfig({...env, OMNIROUTE_BASE_URL: 'http://localhost:20128'}).baseUrl, 'http://localhost:20128/v1');
});
test('maps gateway metadata to OMP, retaining original metadata separately', () => {
  const row = chat(); const {models, metadata} = mapCatalog({ data: [row] }, config());
  assert.deepEqual(models[0], { id: 'vendor/chat', name: 'vendor/chat', api: 'omniroute-chat', kind: 'chat',
    reasoning: true, supportsTools: true, thinking: {mode: 'effort', efforts: ['low','medium','high']}, input: ['text','image'],
    contextWindow: 32000, maxTokens: 4096, cost: {input:2,output:8,cacheRead:0.5,cacheWrite:2.5},
    compat: {supportsReasoningEffort:true,trustExplicitThinkingOnly:true,supportsUsageInStreaming:true} });
  assert.deepEqual(metadata.get(row.id)?.raw, row);
  assert.equal(metadata.get(row.id)?.tools, true);
  assert.equal(metadata.get(row.id)?.pricingStatus, 'estimated');
});
test('selects embedding and image transports and excludes unsupported types', () => {
  const {models} = mapCatalog({data:[chat({id:'embed',type:'embedding'}),chat({id:'image',type:'image'}),chat({id:'audio',type:'audio'})]},config());
  assert.deepEqual(models.map(x => [x.id,x.api,x.kind]), [['embed','openai-embeddings','embedding'],['image','openai-images','image']]);
  assert.equal(models[0].reasoning,false);
});
test('preserves explicit empty effort tiers and false capabilities', () => {
  const {models,metadata} = mapCatalog({data:[chat({capabilities:{reasoning:true,tool_calling:false,vision:false,effort_tiers:[]}, input_modalities:['text']})]},config());
  assert.equal(models.length,0);
  const opts = readConfig({...env,OMNIROUTE_REQUIRE_TOOLS:'false'});
  const result = mapCatalog({data:[chat({capabilities:{reasoning:true,tool_calling:false,vision:false,effort_tiers:[]},input_modalities:['text']})]},opts);
  assert.equal(result.models[0].thinking,undefined);
  assert.equal(result.models[0].compat?.supportsReasoningEffort,false);
  assert.equal(result.metadata.get('vendor/chat')?.tools,false);
  assert.equal(result.models[0].supportsTools,false);
  assert.deepEqual(result.models[0].input,['text']);
});
test('converts per-token strings only when numeric per-million fields are absent', () => {
  const {models} = mapCatalog({data:[chat({pricing:{input:0,output:4,prompt:'0.000002',completion:'0.000099',input_cache_read:'0.0000005',input_cache_write:'0.000003'}})]},config());
  assert.deepEqual(models[0].cost,{input:0,output:4,cacheRead:0.5,cacheWrite:3});
});
test('labels unknown and variable prices without claiming zero is free', () => {
  const result = mapCatalog({data:[chat({id:'unknown',pricing:undefined}),chat({id:'auto/fast',owned_by:'combo'}),chat({id:'free',pricing:{input:0,output:0,cached:0,cache_creation:0}})]},config());
  assert.match(result.models[0].name,/price unknown/);
  assert.match(result.models[1].name,/price variable/);
  assert.equal(result.metadata.get('auto/fast')?.pricingStatus,'variable');
  assert.deepEqual(result.models[1].cost,{input:0,output:0,cacheRead:0,cacheWrite:0});
  assert.equal(result.models[2].name,'free');
});
test('applies comma-separated glob include/exclude filters without changing IDs', () => {
  const opts=readConfig({...env,OMNIROUTE_INCLUDE:'vendor/*,auto/*',OMNIROUTE_EXCLUDE:'*/blocked'});
  const {models}=mapCatalog({data:[chat(),chat({id:'vendor/blocked'}),chat({id:'other/x'})]},opts);
  assert.deepEqual(models.map(x=>x.id),['vendor/chat']);
});
test('rejects malformed catalog envelopes, skips malformed and duplicate rows', () => {
  assert.throws(()=>mapCatalog({items:[]},config()),/data array/);
  const {models}=mapCatalog({data:[null,{},chat({id:'bad\nname'}),chat(),chat(),chat({id:'limits',context_length:-1,max_output_tokens:NaN})]},config());
  assert.deepEqual(models.map(x=>x.id),['vendor/chat','limits']);
  assert.equal(models[1].contextWindow,8192);
  assert.equal(models[1].maxTokens,2048);
});
test('authenticated discovery forbids redirects and bounds request time',async()=>{
  let called=false;
  const payload=await fetchCatalog(config(),'safe-key',async(url,init)=>{
    called=true;assert.equal(url,'https://router.example.com/v1/models');
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer safe-key');
    assert.equal(init?.redirect,'error');assert.ok(init?.signal);
    return new Response(JSON.stringify({data:[chat()]}));
  });
  assert.ok(called);assert.equal(payload.data.length,1);
});
test('missing key, HTTP errors, malformed JSON and oversized data fail without credential leakage',async()=>{
  await assert.rejects(()=>fetchCatalog(config(),undefined),/API_KEY/);
  await assert.rejects(()=>fetchCatalog(config(),'secret',async()=>new Response('secret',{status:401})),/^Error: OmniRoute models request failed \(HTTP 401\)/);
  await assert.rejects(()=>fetchCatalog(config(),'secret',async()=>new Response('{')),/valid JSON/);
  await assert.rejects(()=>fetchCatalog(config(),'secret',async()=>new Response('{}',{headers:{'content-length':'99999999'}})),/too large/);
});
test('applies validated overrides before filtering and preserves original gateway metadata',()=>{
  const row=chat({capabilities:{reasoning:true,thinking:true,tool_calling:false,vision:true,effort_tiers:['high']}});
  const result=mapCatalog({data:[row]},config(),{'vendor/chat':{context_length:64000,max_output_tokens:2000,capabilities:{thinking:false,tool_calling:true,vision:false}}});
  assert.equal(result.models.length,1);assert.equal(result.models[0].reasoning,false);assert.equal(result.models[0].supportsTools,true);
  assert.deepEqual(result.models[0].input,['text']);assert.equal(result.models[0].contextWindow,64000);
  assert.deepEqual(result.metadata.get('vendor/chat')?.raw,row);
  assert.equal(result.metadata.get('vendor/chat')?.appliedOverrides?.capabilities?.thinking,false);
});
test('explicit override pricing interpretation wins while missing rates never become known',()=>{
  const result=mapCatalog({data:[chat({id:'auto/test'}),chat({id:'unknown',pricing:undefined})]},config(),{
    'auto/test':{pricingStatus:'estimated',pricing:{input:1,output:2}},unknown:{pricingStatus:'estimated'},
  });
  assert.equal(result.metadata.get('auto/test')?.pricingStatus,'estimated');assert.equal(result.models[0].cost.input,1);
  assert.equal(result.metadata.get('unknown')?.pricingStatus,'unknown');
});
test('native chat identifier is retained when all adapter features are disabled',()=>{
  const opts=readConfig({...env,OMNIROUTE_INSPECT_REQUESTS:'false'});
  assert.equal(mapCatalog({data:[chat()]},opts).models[0].api,'openai-completions');
  opts.stickySessions=true;assert.equal(mapCatalog({data:[chat()]},opts).models[0].api,'omniroute-chat');
});

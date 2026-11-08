import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, mapCatalog, fetchCatalog } from '../src/catalog.ts';
import { setImmediate as nextTurn } from 'node:timers/promises';

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
  const malformed = [null, {}, chat({id:42}), chat({id:''}), chat({id:'bad\nname'}), chat({id:'x'.repeat(513)})];
  const result=mapCatalog({data:[...malformed,chat(),chat({type:'audio'}),chat({id:'limits',context_length:-1,max_output_tokens:NaN})]},config());
  assert.deepEqual(result.models.map(x=>x.id),['vendor/chat','limits']);
  assert.equal(result.models[1].contextWindow,8192);
  assert.equal(result.models[1].maxTokens,2048);
  assert.equal(result.skipped,7);
  assert.deepEqual(result.diagnostics.skippedByReason,{
    invalid:6,duplicate:1,include:0,exclude:0,'unsupported-type':0,'tools-required':0,'unsupported-input':0,
  });
  assert.deepEqual([...result.rejections],[['vendor/chat',['duplicate']]]);
  assert.deepEqual(result.diagnostics.fallbacks,{
    chat:{contextWindow:1,maxTokens:1},embedding:{contextWindow:0,maxTokens:0},image:{contextWindow:0,maxTokens:0},
  });
});
test('attributes each skipped row to its first rejection without retaining rejected metadata',()=>{
  const opts=readConfig({...env,OMNIROUTE_INCLUDE:'vendor/*',OMNIROUTE_EXCLUDE:'*/blocked'});
  const result=mapCatalog({data:[
    chat(),
    chat({id:'other/blocked',type:'audio'}),
    chat({id:'vendor/blocked',type:'audio'}),
    {id:'vendor/audio',type:'audio',capabilities:{tool_calling:false}},
    chat({id:'vendor/no-tools',capabilities:{tool_calling:false},input_modalities:['audio']}),
    chat({id:'vendor/no-input',input_modalities:[]}),
    chat({id:'vendor/audio-input',input_modalities:['audio'],private_payload:'not retained'}),
  ]},opts);
  assert.deepEqual(result.models.map(x=>x.id),['vendor/chat']);
  assert.deepEqual([...result.metadata.keys()],['vendor/chat']);
  assert.equal(result.skipped,6);
  assert.deepEqual(result.diagnostics.skippedByReason,{
    invalid:0,duplicate:0,include:1,exclude:1,'unsupported-type':1,'tools-required':1,'unsupported-input':2,
  });
  assert.equal(Object.values(result.diagnostics.skippedByReason).reduce((sum,count)=>sum+count,0),result.skipped);
  assert.deepEqual([...result.rejections],[
    ['other/blocked',['include']],['vendor/blocked',['exclude']],['vendor/audio',['unsupported-type']],
    ['vendor/no-tools',['tools-required']],['vendor/no-input',['unsupported-input']],['vendor/audio-input',['unsupported-input']],
  ]);
  assert.deepEqual(result.diagnostics.fallbacks,{
    chat:{contextWindow:0,maxTokens:0},embedding:{contextWindow:0,maxTokens:0},image:{contextWindow:0,maxTokens:0},
  });
});
test('keeps unique reasons per ID without treating previously rejected rows as accepted duplicates',()=>{
  const id='vendor/retried';
  const accepted=chat({id});
  const result=mapCatalog({data:[
    chat({id,type:'audio'}),
    chat({id,capabilities:{tool_calling:false}}),
    chat({id,capabilities:{tool_calling:false},input_modalities:[]}),
    accepted,
    chat({id,type:'image',pricing:{input:99,output:99}}),
  ]},config());
  assert.deepEqual(result.models.map(x=>[x.id,x.kind,x.cost.input]),[[id,'chat',2]]);
  assert.deepEqual(result.metadata.get(id)?.raw,accepted);
  assert.deepEqual([...result.rejections],[[id,['unsupported-type','tools-required','duplicate']]]);
  assert.equal(result.skipped,4);
  assert.deepEqual(result.diagnostics.skippedByReason,{
    invalid:0,duplicate:1,include:0,exclude:0,'unsupported-type':1,'tools-required':2,'unsupported-input':0,
  });
});
test('counts actual default limits by mapped kind, not explicit values or clamping',()=>{
  const result=mapCatalog({data:[
    {id:'chat-default'},
    chat({id:'chat-explicit',context_length:8192,max_output_tokens:2048}),
    chat({id:'chat-clamped',context_length:64,max_output_tokens:2048}),
    {id:'embed-context',type:'embedding',context_length:0,max_output_tokens:512},
    {id:'embed-output',type:'embedding',context_length:128,max_output_tokens:NaN},
    {id:'image-output',type:'image',context_length:4096},
    {id:'image-context',type:'image',max_output_tokens:1},
    {id:'override-explicit',type:'image'},
  ]},config(),{'override-explicit':{context_length:8192,max_output_tokens:2048}});
  assert.deepEqual(result.diagnostics.fallbacks,{
    chat:{contextWindow:1,maxTokens:1},embedding:{contextWindow:1,maxTokens:1},image:{contextWindow:1,maxTokens:1},
  });
  assert.equal(result.skipped,0);
  assert.equal(result.rejections.size,0);
  assert.deepEqual(result.models.map(x=>[x.id,x.contextWindow,x.maxTokens]),[
    ['chat-default',8192,2048],['chat-explicit',8192,2048],['chat-clamped',64,64],
    ['embed-context',8192,512],['embed-output',128,128],['image-output',4096,2048],
    ['image-context',8192,1],['override-explicit',8192,2048],
  ]);
  assert.deepEqual(result.metadata.get('chat-default')?.defaultsUsed,['context_length=8192','max_output_tokens=2048']);
  assert.deepEqual(result.metadata.get('embed-context')?.defaultsUsed,['context_length=8192']);
  assert.deepEqual(result.metadata.get('embed-output')?.defaultsUsed,['max_output_tokens=2048']);
  assert.deepEqual(result.metadata.get('image-output')?.defaultsUsed,['max_output_tokens=2048']);
  assert.deepEqual(result.metadata.get('image-context')?.defaultsUsed,['context_length=8192']);
  for(const id of ['chat-explicit','chat-clamped','override-explicit'])assert.deepEqual(result.metadata.get(id)?.defaultsUsed,[]);
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
test('override diagnostics audit raw IDs even when mapping filters reject every model',()=>{
  const rows=[{id:'vendor/a'},{id:'vendor/a'},{id:'omniroute/vendor/b'},{id:'vendor/b'},{id:'vendor/no-tools',capabilities:{tool_calling:false}}];
  const overrides={'vendor/a':{name:'Filtered'},'omniroute/vendor/a':{name:'Do not apply'},'omniroute/vendor/b':{},'vendor/no-tools':{},missing:{}};
  const expected={matched:3,unmatched:[{id:'omniroute/vendor/a',suggestedId:'vendor/a'},{id:'missing'}]};
  const filtered=mapCatalog({data:rows},{...config(),exclude:['*']},overrides);
  assert.equal(filtered.models.length,0);assert.deepEqual(filtered.diagnostics.overrides,expected);
  const mapped=mapCatalog({data:rows},config(),overrides);
  assert.deepEqual(mapped.diagnostics.overrides,expected);
  assert.equal(mapped.models.find(row=>row.id==='vendor/a')?.name,'Filtered [price unknown]');
  assert.equal(mapped.models.some(row=>row.id==='omniroute/vendor/a'),false);
  assert.deepEqual(mapCatalog({data:rows},config()).diagnostics.overrides,{matched:0,unmatched:[]});
});
test('catalog failures retain their original errors when body or reader cancellation rejects',async()=>{
  const max=5*1024*1024;
  for(const kind of ['http','length','chunks'] as const){
    let cancelled=0;
    const body=new ReadableStream<Uint8Array>({
      start(controller){controller.enqueue(new Uint8Array(kind==='chunks'?max+1:1));},
      cancel(){cancelled++;return Promise.reject(new Error('private cleanup failure'));},
    });
    const response=new Response(body,kind==='http'?{status:401}:kind==='length'?{headers:{'content-length':String(max+1)}}:{});
    const message=kind==='http'?'OmniRoute models request failed (HTTP 401)':'OmniRoute models response is too large';
    await assert.rejects(fetchCatalog(config(),'private-key',async()=>response),{message});
    assert.equal(cancelled,1);
  }
});
test('catalog rejection does not wait for nonsettling cleanup',async()=>{
  for(const kind of ['http','length','chunks'] as const){
    const body=new ReadableStream<Uint8Array>({
      start(controller){controller.enqueue(new Uint8Array(kind==='chunks'?5*1024*1024+1:1));},
      cancel(){return Promise.withResolvers<void>().promise;},
    });
    const response=new Response(body,kind==='http'?{status:503}:kind==='length'?{headers:{'content-length':'99999999'}}:{});
    let failure:unknown;
    void fetchCatalog(config(),'private-key',async()=>response).catch(error=>{failure=error;});
    // All fixture reads settle immediately; drain their microtasks without awaiting cleanup.
    await nextTurn();
    assert.ok(failure instanceof Error);
    assert.equal(failure.message,kind==='http'?'OmniRoute models request failed (HTTP 503)':'OmniRoute models response is too large');
  }
});

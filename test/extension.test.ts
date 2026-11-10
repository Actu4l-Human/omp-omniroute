import test from 'node:test';
import assert from 'node:assert/strict';
import { installOmniRoute } from '../src/extension.ts';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
const env = { OMNIROUTE_BASE_URL:'https://router.example/v1', OMNIROUTE_API_KEY:'test-key' };
function harness(fetchImpl:typeof fetch,selectModel:(model:any)=>Promise<boolean>=async()=>true,settings:Record<string,string>={}) {
  const handlers = new Map<string,Function>(); const commands = new Map<string,any>();
  let provider:any; let registrations=0; const notices:string[]=[];const noticeTypes:string[]=[];const statuses:string[]=[]; const timers:Function[]=[];let clears=0;
  const timeouts=new Map<number,Function>();let timeoutId=0;let registry:any[]=[];const selections:any[]=[];
  const ctx:any={ui:{notify:(s:string,type:string)=>{notices.push(s);noticeTypes.push(type);},setStatus:(_id:string,status:string)=>statuses.push(status)},isIdle:()=>true,
    models:{current:()=>ctx.model},
    setInterval:(f:Function)=>{timers.push(f);return -timers.length;},
    setTimeout:(f:Function)=>{const id=++timeoutId;timeouts.set(id,()=>{timeouts.delete(id);return f();});return id;},
    clearTimer:(id:number)=>{clears++;timeouts.delete(id);},
    modelRegistry:{ refreshDiscoverableProviders:async(ids:string[],strategy:string)=>{
      assert.deepEqual(ids,['omniroute']);assert.equal(strategy,'online');
      try {registry=(await provider.fetchDynamicModels(env.OMNIROUTE_API_KEY)).map((model:any)=>({...model,provider:'omniroute'}));} catch { /* OMP retains last-good rows. */ }
    },find:(provider:string,id:string)=>registry.find(model=>model.provider===provider && model.id===id)}, hasUI:true};
  const pi:any={on:(name:string,fn:Function)=>handlers.set(name,fn),registerCommand:(name:string,opts:any)=>commands.set(name,opts),
    setModel:async(model:any)=>{if(!await selectModel(model))return false;selections.push(model);ctx.model=model;return true;},
    registerProvider:(name:string,p:any)=>{assert.equal(name,'omniroute');provider=p;registrations++;}};
  return {install:()=>installOmniRoute(pi as ExtensionAPI,{...env,...settings},fetchImpl,(()=>{throw new Error('not used in lifecycle tests');})),handlers,commands,ctx,notices,noticeTypes,statuses,timers,timeouts,selections,get registry(){return registry;},get provider(){return provider;},get registrations(){return registrations;},get clears(){return clears;}};
}
test('registers exactly one env-auth provider and uses scoped periodic refresh with cleanup',async()=>{
  let requests=0;
  const h=harness(async()=>{requests++;return new Response(JSON.stringify({data:[{id:'m'}]}));});
  await h.install();assert.equal(h.registrations,1);
  assert.equal(h.provider.apiKey,'OMNIROUTE_API_KEY');assert.equal(h.provider.authHeader,true);
  assert.equal(typeof h.provider.streamSimple,'function');
  await h.handlers.get('session_start')!({},h.ctx);assert.equal(requests,1);assert.equal(h.timers.length,1);
  await h.timers[0]();assert.equal(requests,2);
  await h.commands.get('omniroute-status').handler('',h.ctx);assert.match(h.notices.at(-1)!,/1 model/);
  await h.handlers.get('session_shutdown')!({},h.ctx);assert.equal(h.clears,1);
});
test('failed refresh does not replace retained metadata or claim success',async()=>{
  let fail=false;
  const h=harness(async()=>fail?new Response('never expose body',{status:503}):new Response(JSON.stringify({data:[{id:'m',effort_tiers:['high']}]})));
  await h.install();await h.handlers.get('session_start')!({},h.ctx);fail=true;
  await h.commands.get('omniroute-refresh').handler('',h.ctx);assert.match(h.notices.at(-1)!,/HTTP 503/);
  await h.commands.get('omniroute-model').handler('m',h.ctx);assert.match(h.notices.at(-1)!,/effort_tiers/);
});
test('coalesces simultaneous timer and manual refresh',async()=>{
  let resolve!:()=>void;let calls=0;
  const h=harness(async()=>{calls++;await new Promise<void>(r=>resolve=r);return new Response('{"data":[]}');});
  await h.install();const start=h.handlers.get('session_start')!({},h.ctx);
  await Promise.resolve();const manual=h.commands.get('omniroute-refresh').handler('',h.ctx);
  await Promise.resolve();assert.equal(calls,1);resolve();await Promise.all([start,manual]);
});
for(const enabled of [true,false]) {
  test(`coalesced controls complete one trailing pass to ${enabled?'scoped':'native'} chat`,{timeout:5000},async(t)=>{
    const entered=Promise.withResolvers<void>();const gate=Promise.withResolvers<void>();
    let requests=0;
    const h=harness(async()=>{requests++;return Response.json({data:[{id:'m'}]});},
      async()=>{entered.resolve();await gate.promise;return true;},
      {OMNIROUTE_INSPECT_REQUESTS:'false',OMNIROUTE_BYPASS_CACHE:String(!enabled)});
    const work:Promise<unknown>[]=[];
    t.after(async()=>{gate.resolve();await Promise.allSettled(work);await h.handlers.get('session_shutdown')!({},h.ctx);});
    await h.install();
    h.ctx.model={provider:'omniroute',id:'m',api:enabled?'openai-completions':'omniroute-chat'};
    work.push(h.handlers.get('session_start')!({},h.ctx));
    await entered.promise;
    let completed=0;
    for(let i=0;i<3;i++)work.push(h.commands.get('omniroute-controls').handler(`cache-bypass ${enabled?'on':'off'}`,h.ctx).then(()=>completed++));
    await Promise.resolve();assert.equal(completed,0);assert.equal(requests,1);
    gate.resolve();await Promise.all(work);
    assert.equal(completed,3);assert.equal(requests,2);
    assert.equal(h.registry[0].api,enabled?'omniroute-chat':'openai-completions');
    assert.equal(h.ctx.model,h.registry[0]);assert.equal(h.selections.length,2);
  });
}
test('unchanged transport controls and alert changes retain ordinary refresh coalescing',{timeout:5000},async(t)=>{
  const entered=Promise.withResolvers<void>();const gate=Promise.withResolvers<void>();let requests=0;
  const h=harness(async()=>{requests++;return Response.json({data:[{id:'m'}]});},
    async()=>{entered.resolve();await gate.promise;return true;},{OMNIROUTE_INSPECT_REQUESTS:'false'});
  const work:Promise<unknown>[]=[];
  t.after(async()=>{gate.resolve();await Promise.allSettled(work);await h.handlers.get('session_shutdown')!({},h.ctx);});
  await h.install();h.ctx.model={provider:'omniroute',id:'m'};
  work.push(h.handlers.get('session_start')!({},h.ctx));await entered.promise;
  work.push(h.commands.get('omniroute-controls').handler('cache-bypass off',h.ctx));
  await h.commands.get('omniroute-controls').handler('alerts off',h.ctx);
  work.push(h.commands.get('omniroute-refresh').handler('',h.ctx));
  gate.resolve();await Promise.all(work);
  assert.equal(requests,1);assert.equal(h.ctx.model.api,'openai-completions');assert.equal(h.selections.length,1);
});
test('shutdown suppresses a control revision waiting behind authentication',{timeout:5000},async(t)=>{
  const entered=Promise.withResolvers<void>();const gate=Promise.withResolvers<void>();let requests=0;
  const h=harness(async()=>{requests++;return Response.json({data:[{id:'m'}]});},
    async()=>{entered.resolve();await gate.promise;return true;},{OMNIROUTE_INSPECT_REQUESTS:'false'});
  const work:Promise<unknown>[]=[];
  t.after(async()=>{gate.resolve();await Promise.allSettled(work);});
  await h.install();h.ctx.model={provider:'omniroute',id:'m'};
  work.push(h.handlers.get('session_start')!({},h.ctx));await entered.promise;
  work.push(h.commands.get('omniroute-controls').handler('cache-bypass on',h.ctx));
  await h.handlers.get('session_shutdown')!({},h.ctx);
  gate.resolve();await Promise.all(work);
  // The host's in-flight setModel cannot be cancelled; no trailing work may start.
  assert.equal(requests,1);assert.equal(h.selections.length,1);assert.equal(h.timeouts.size,0);
  assert.equal(h.registry[0].api,'openai-completions');
});
test('does not register a provider when key is missing',async()=>{
  const handlers=new Map<string,Function>();let registered=false;const notices:string[]=[];
  const pi:any={registerProvider:()=>registered=true,on:(n:string,f:Function)=>handlers.set(n,f)};
  await installOmniRoute(pi,{OMNIROUTE_BASE_URL:env.OMNIROUTE_BASE_URL});
  assert.equal(registered,false);
  handlers.get('session_start')!({}, {ui:{notify:(s:string)=>notices.push(s)}});
  assert.match(notices[0],/OMNIROUTE_API_KEY/);
});
test('rebinds an idle selected OmniRoute model after refreshing cached transport metadata',async()=>{
  const h=harness(async()=>new Response('{"data":[{"id":"m"}]}'));
  await h.install();
  // Use a separate host to exercise rebinding the cached transport descriptor.
  const handlers=new Map<string,Function>();let provider:any;let selected:any;
  const next={provider:'omniroute',id:'m',api:'omniroute-chat'};
  const pi:any={registerProvider:(_n:string,p:any)=>provider=p,registerCommand:()=>{},on:(n:string,f:Function)=>handlers.set(n,f),setModel:async(m:any)=>{selected=m;return true;}};
  await installOmniRoute(pi,{...env,OMNIROUTE_REPORTED_COST:'true'},async()=>new Response('{"data":[{"id":"m"}]}'),(()=>{throw new Error('not used');}));
  const ctx:any={...h.ctx,model:{provider:'omniroute',id:'m',api:'openai-completions'},models:{current:()=>ctx.model},isIdle:()=>true,
    modelRegistry:{refreshDiscoverableProviders:async()=>{await provider.fetchDynamicModels('test-key');},find:()=>next}};
  await handlers.get('session_start')!({},ctx);
  assert.equal(selected,next);
});
test('refresh rebinds changed metadata only while idle after successful discovery',async()=>{
  let fail=false;let idle=true;let selections=0;
  const fetchImpl:typeof fetch=async()=>fail?new Response('',{status:503}):Response.json({data:[{id:'m'}]});
  const h=harness(fetchImpl);
  const handlers=new Map<string,Function>();let provider:any;
  let current={provider:'omniroute',id:'m',api:'openai-completions',input:['text'],cost:{input:1,output:2}};
  const ctx:any={...h.ctx,model:structuredClone(current),models:{current:()=>ctx.model},isIdle:()=>idle,
    modelRegistry:{refreshDiscoverableProviders:async()=>{
      try {await provider.fetchDynamicModels('test-key');} catch { /* OMP retains last-good rows. */ }
    },find:()=>structuredClone(current)}};
  const pi:any={registerProvider:(_n:string,p:any)=>provider=p,registerCommand:()=>{},
    on:(n:string,f:Function)=>handlers.set(n,f),setModel:async(m:any)=>{selections++;ctx.model=m;return true;}};
  await installOmniRoute(pi,env,fetchImpl,(()=>{throw new Error('not used');}));
  await handlers.get('session_start')!({},ctx);
  await h.timers[0]();await h.timers[0]();
  assert.equal(selections,0);
  current={...current,api:'omniroute-chat',input:['text','image'],cost:{input:3,output:4}};
  await h.timers[0]();
  assert.equal(selections,1);assert.deepEqual(ctx.model,current);
  const selected=ctx.model;
  current={...current,cost:{input:5,output:6}};idle=false;
  await h.timers[0]();
  assert.equal(selections,1);assert.equal(ctx.model,selected);
  idle=true;fail=true;
  await h.timers[0]();
  assert.equal(selections,1);assert.equal(ctx.model,selected);
  await handlers.get('session_shutdown')!({},ctx);
});
test('refresh ignores resolver identity without resolving credentials but retains header changes',async()=>{
  const h=harness(async()=>Response.json({data:[{id:'m'}]}));
  const handlers=new Map<string,Function>();let provider:any;let selections=0;let resolutions=0;
  const resolveHeaders=async()=>{resolutions++;return {Authorization:'Bearer fixture-key'};};
  let current:any={provider:'omniroute',id:'m',api:'openai-completions',headers:{'X-Fixture':'first'},resolveHeaders};
  const ctx:any={...h.ctx,model:{...current},models:{current:()=>ctx.model},
    modelRegistry:{refreshDiscoverableProviders:async()=>{await provider.fetchDynamicModels('test-key');},
      find:()=>({...current,...(current.resolveHeaders?{resolveHeaders:async()=>resolveHeaders()}: {})})}};
  const pi:any={registerProvider:(_name:string,p:any)=>provider=p,registerCommand:()=>{},
    on:(name:string,handler:Function)=>handlers.set(name,handler),
    setModel:async(model:any)=>{selections++;ctx.model=model;return true;}};
  try {
    await installOmniRoute(pi,env,async()=>Response.json({data:[{id:'m'}]}),()=>{throw new Error('No inference');});
    await handlers.get('session_start')!({},ctx);await h.timers[0]();
    assert.equal(selections,0);assert.equal(resolutions,0);
    current={...current,headers:{'X-Fixture':'second'}};await h.timers[0]();
    assert.equal(selections,1);assert.equal(ctx.model.headers['X-Fixture'],'second');
    current={...current,resolveHeaders:undefined};await h.timers[0]();
    assert.equal(selections,2);assert.equal(ctx.model.resolveHeaders,undefined);
    current={...current,resolveHeaders};await h.timers[0]();
    assert.equal(selections,3);assert.equal(resolutions,0);
  } finally {await handlers.get('session_shutdown')?.({},ctx);}
});
test('registers usage and doctor commands without making background management requests',async()=>{
  const paths:string[]=[];
  const h=harness(async(url)=>{const path=new URL(String(url)).pathname;paths.push(path);
    if(path==='/api/usage/om-usage')return Response.json({allowed:true,personal:{dailySpentUsd:1,dailyLimitUsd:5}});
    if(path==='/v1/models/health')return Response.json({data:[{id:'m',state:'ok'}]});
    return Response.json({data:[{id:'m'}]},{headers:{'x-omniroute-version':'3.8.54'}});
  });
  await h.install();assert.equal(typeof h.provider.usage.fetchUsage,'function');assert.equal(paths.length,0);
  await h.commands.get('omniroute-usage').handler('',h.ctx);assert.match(h.notices.at(-1)!,/Personal daily/);
  await h.commands.get('omniroute-doctor').handler('',h.ctx);assert.match(h.notices.at(-1)!,/Inference was not tested/);
  assert.ok(paths.every(p=>p==='/v1/models'||p==='/v1/models/health'||p==='/api/usage/om-usage'||p==='/v1/me/status'||p==='/v1/me/sessions'));
});
test('catalog alerts suppress baseline and unchanged refresh, then summarize real changes',async()=>{
  let model='one';const h=harness(async()=>Response.json({data:[{id:model}]}));
  await h.install();await h.handlers.get('session_start')!({},h.ctx);assert.equal(h.notices.length,0);
  await h.timers[0]();assert.equal(h.notices.length,0);
  model='two';await h.timers[0]();assert.match(h.notices.at(-1)!,/1 added.*1 removed/);
  const count=h.notices.length;await h.timers[0]();assert.equal(h.notices.length,count);
  await h.commands.get('omniroute-changes').handler('',h.ctx);assert.match(h.notices.at(-1)!,/two/);
});
test('controls toggle only supported local settings, refresh routing, and reject arbitrary headers',async()=>{
  const h=harness(async()=>Response.json({data:[{id:'m'}]}));await h.install();
  await h.commands.get('omniroute-controls').handler('cache-bypass on',h.ctx);assert.match(h.notices.at(-1)!,/"bypassCache": true/);
  await h.commands.get('omniroute-controls').handler('Authorization Bearer secret',h.ctx);assert.match(h.notices.at(-1)!,/Usage:/);
  await h.commands.get('omniroute-last').handler('',h.ctx);assert.match(h.notices.at(-1)!,/No inspected/);
});
test('manual refresh respects a newer or cleared selection despite a command model snapshot',async()=>{
  for(const selection of [{provider:'omniroute',id:'b'},{provider:'another',id:'b'},undefined]) {
    const {promise:started,resolve:entered}=Promise.withResolvers<void>();
    const {promise:gate,resolve:release}=Promise.withResolvers<void>();
    const h=harness(async()=>{entered();await gate;return Response.json({data:[{id:'a'}]});});
    await h.install();h.ctx.model={provider:'omniroute',id:'a',api:'openai-completions'};
    const commandCtx={...h.ctx};
    const refreshing=h.commands.get('omniroute-refresh').handler('',commandCtx);
    await started;h.ctx.model=selection;release();await refreshing;
    assert.equal(h.ctx.model,selection);assert.deepEqual(h.selections,[]);
  }
});
test('a busy refresh applies changed metadata on becoming idle without another discovery',async()=>{
  let rate=1;let requests=0;let idle=true;
  const h=harness(async()=>{requests++;return Response.json({data:[{id:'m',pricing:{input:rate,output:2}}]});});
  h.ctx.isIdle=()=>idle;
  await h.install();await h.handlers.get('session_start')!({},h.ctx);
  h.ctx.model=structuredClone(h.registry[0]);rate=3;idle=false;
  await h.timers[0]();
  assert.equal(h.ctx.model.cost.input,1);assert.equal(h.timeouts.size,1);assert.equal(requests,2);
  await [...h.timeouts.values()][0]();
  assert.equal(h.ctx.model.cost.input,1);assert.equal(h.timeouts.size,1);
  idle=true;await [...h.timeouts.values()][0]();
  assert.equal(h.ctx.model.cost.input,3);assert.equal(h.selections.length,1);
  assert.equal(requests,2);assert.equal(h.timeouts.size,0);
  await h.timers[0]();assert.equal(h.selections.length,1);
  await h.handlers.get('session_shutdown')!({},h.ctx);
});
test('deferred rebinds stop after selection changes, discovery failure, or session shutdown',async()=>{
  for(const stop of ['selection','failure','shutdown']) {
    let rate=1;let fail=false;let idle=true;
    const h=harness(async()=>fail?new Response('',{status:503}):Response.json({data:[{id:'m',pricing:{input:rate,output:2}}]}));
    h.ctx.isIdle=()=>idle;
    await h.install();await h.handlers.get('session_start')!({},h.ctx);
    h.ctx.model=structuredClone(h.registry[0]);rate=3;idle=false;await h.timers[0]();
    const queued=[...h.timeouts.values()][0];
    if(stop==='selection')h.ctx.model={provider:'omniroute',id:'new-selection'};
    if(stop==='failure'){fail=true;await h.timers[0]();assert.equal(h.timeouts.size,0);}
    if(stop==='shutdown'){await h.handlers.get('session_shutdown')!({},h.ctx);assert.equal(h.timeouts.size,0);}
    const selected=h.ctx.model;idle=true;await queued();
    assert.equal(h.ctx.model,selected);assert.deepEqual(h.selections,[]);assert.equal(h.timeouts.size,0);
    if(stop!=='shutdown')await h.handlers.get('session_shutdown')!({},h.ctx);
  }
});
test('model inspection explains skipped IDs, fallback limits, and qualified selectors',async()=>{
  const h=harness(async()=>Response.json({data:[{id:'vendor/chat'},{id:'vendor/no-tools',capabilities:{tool_calling:false}},{id:'omniroute/vendor/chat',context_length:9000,max_output_tokens:1000}]}));
  await h.install();await h.handlers.get('session_start')!({},h.ctx);
  const inspect=h.commands.get('omniroute-model');
  await inspect.handler('omniroute/vendor/no-tools',h.ctx);
  const skipped=JSON.parse(h.notices.at(-1)!);
  assert.equal(skipped.id,'vendor/no-tools');assert.equal(skipped.accepted,false);
  assert.deepEqual(skipped.rejections.map((r:any)=>r.reason),['tools-required']);
  await inspect.handler('vendor/chat',h.ctx);
  const accepted=JSON.parse(h.notices.at(-1)!);
  assert.equal(accepted.accepted,true);assert.deepEqual(accepted.defaultsUsed,['context_length=8192','max_output_tokens=2048']);
  assert.match(accepted.guidance,/OMNIROUTE_OVERRIDES_FILE/);
  await inspect.handler('omniroute/vendor/chat',h.ctx);
  assert.equal(JSON.parse(h.notices.at(-1)!).id,'omniroute/vendor/chat');
  await h.commands.get('omniroute-status').handler('',h.ctx);
  assert.match(h.notices.at(-1)!,/tools-required: 1/);assert.match(h.notices.at(-1)!,/chat: 1 context, 1 output/);
  await h.handlers.get('session_shutdown')!({},h.ctx);
});
test('catalog success and changes survive rejected or thrown selected-model updates, including deferred updates',async()=>{
  for(const failure of ['rejected','failed'])for(const deferred of [false,true]) {
    let context=8192;let idle=true;let recover=false;
    const h=harness(async()=>Response.json({data:[{id:'m',context_length:context}]}),async()=>{
      if(recover)return true;
      if(failure==='failed')throw new Error('private host error');
      return false;
    });
    h.ctx.isIdle=()=>idle;
    await h.install();await h.handlers.get('session_start')!({},h.ctx);
    const selected=h.ctx.model=structuredClone(h.registry[0]);context=16384;idle=!deferred;
    await h.timers[0]();
    if(deferred){assert.equal(h.timeouts.size,1);idle=true;await [...h.timeouts.values()][0]();}
    assert.equal(h.registry[0].contextWindow,16384);assert.equal(h.ctx.model,selected);assert.deepEqual(h.selections,[]);
    assert.equal(h.statuses.at(-1),`OmniRoute: 1 models; selected model ${failure}`);
    await h.commands.get('omniroute-status').handler('',h.ctx);assert.equal(h.noticeTypes.at(-1),'warning');
    assert.ok(!h.notices.join('\n').includes('private host error'));
    await h.commands.get('omniroute-changes').handler('',h.ctx);
    assert.deepEqual(JSON.parse(h.notices.at(-1)!).changes.changed.map((change:any)=>[change.id,change.categories]),[['m',['limits']]]);
    recover=true;await h.timers[0]();
    assert.equal(h.ctx.model.contextWindow,16384);assert.equal(h.selections.length,1);
    assert.equal(h.statuses.at(-1),'OmniRoute: 1 models');
    await h.commands.get('omniroute-status').handler('',h.ctx);assert.equal(h.noticeTypes.at(-1),'info');
    await h.handlers.get('session_shutdown')!({},h.ctx);
  }
});
test('a missing selected model warns without switching, deduplicates alerts, and recovers when it returns',async()=>{
  let present=true;
  const h=harness(async()=>Response.json({data:present?[{id:'m'}]:[]}));
  await h.install();await h.handlers.get('session_start')!({},h.ctx);
  const selected=h.ctx.model=structuredClone(h.registry[0]);present=false;
  await h.timers[0]();
  assert.equal(h.registry.length,0);assert.equal(h.ctx.model,selected);assert.deepEqual(h.selections,[]);
  assert.equal(h.statuses.at(-1),'OmniRoute: 0 models; selected model missing');
  const warnings=h.noticeTypes.filter(type=>type==='warning').length;assert.equal(warnings,1);
  await h.timers[0]();assert.equal(h.noticeTypes.filter(type=>type==='warning').length,warnings);
  present=true;await h.timers[0]();
  assert.equal(h.ctx.model,selected);assert.deepEqual(h.selections,[]);assert.equal(h.statuses.at(-1),'OmniRoute: 1 models');
  await h.commands.get('omniroute-status').handler('',h.ctx);assert.equal(h.noticeTypes.at(-1),'info');
  await h.handlers.get('session_shutdown')!({},h.ctx);
});
test('selection warnings do not follow a different selected model or survive a failed catalog refresh',async()=>{
  let rows=[{id:'m'},{id:'other'}];let fail=false;
  const h=harness(async()=>fail?new Response('',{status:503}):Response.json({data:rows}));
  await h.install();await h.handlers.get('session_start')!({},h.ctx);
  const selected=h.ctx.model=structuredClone(h.registry[0]);rows=[{id:'other'}];await h.timers[0]();
  h.ctx.model=structuredClone(h.registry[0]);
  await h.commands.get('omniroute-status').handler('',h.ctx);
  assert.equal(h.noticeTypes.at(-1),'info');assert.equal(h.statuses.at(-1),'OmniRoute: 1 models');
  h.ctx.model=selected;await h.timers[0]();fail=true;await h.timers[0]();
  assert.equal(h.statuses.at(-1),'OmniRoute: catalog stale');assert.equal(h.ctx.model,selected);
  await h.handlers.get('session_shutdown')!({},h.ctx);
});

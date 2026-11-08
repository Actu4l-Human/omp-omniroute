import test from 'node:test';
import assert from 'node:assert/strict';
import { installOmniRoute } from '../src/extension.ts';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
const env = { OMNIROUTE_BASE_URL:'https://router.example/v1', OMNIROUTE_API_KEY:'test-key' };
function harness(fetchImpl:typeof fetch) {
  const handlers = new Map<string,Function>(); const commands = new Map<string,any>();
  let provider:any; let registrations=0; const notices:string[]=[]; const timers:Function[]=[];let clears=0;
  const ctx:any={ui:{notify:(s:string)=>notices.push(s),setStatus:()=>{}},
    setInterval:(f:Function)=>{timers.push(f);return timers.length;},clearTimer:()=>{clears++;},
    modelRegistry:{ refreshDiscoverableProviders:async(ids:string[],strategy:string)=>{
      assert.deepEqual(ids,['omniroute']);assert.equal(strategy,'online');
      try {await provider.fetchDynamicModels(env.OMNIROUTE_API_KEY);} catch { /* OMP retains last-good rows. */ }
    }}, hasUI:true};
  const pi:any={on:(name:string,fn:Function)=>handlers.set(name,fn),registerCommand:(name:string,opts:any)=>commands.set(name,opts),
    registerProvider:(name:string,p:any)=>{assert.equal(name,'omniroute');provider=p;registrations++;}};
  return {install:()=>installOmniRoute(pi as ExtensionAPI,env,fetchImpl,(()=>{throw new Error('not used in lifecycle tests');})),handlers,commands,ctx,notices,timers,get provider(){return provider;},get registrations(){return registrations;},get clears(){return clears;}};
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
  // The shared harness does not supply setModel: install a separate host with an observable binding.
  const handlers=new Map<string,Function>();let provider:any;let selected:any;
  const next={provider:'omniroute',id:'m',api:'omniroute-chat'};
  const pi:any={registerProvider:(_n:string,p:any)=>provider=p,registerCommand:()=>{},on:(n:string,f:Function)=>handlers.set(n,f),setModel:async(m:any)=>{selected=m;return true;}};
  await installOmniRoute(pi,{...env,OMNIROUTE_REPORTED_COST:'true'},async()=>new Response('{"data":[{"id":"m"}]}'),(()=>{throw new Error('not used');}));
  const ctx:any={...h.ctx,model:{provider:'omniroute',id:'m',api:'openai-completions'},isIdle:()=>true,
    modelRegistry:{refreshDiscoverableProviders:async()=>{await provider.fetchDynamicModels('test-key');},find:()=>next}};
  await handlers.get('session_start')!({},ctx);
  assert.equal(selected,next);
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
  assert.ok(paths.every(p=>p==='/v1/models'||p==='/v1/models/health'||p==='/api/usage/om-usage'));
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

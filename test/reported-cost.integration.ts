import { test, expect } from 'bun:test';
import { streamOmniRoute,streamNative } from '../src/reported-cost.ts';
import type { Model, Context } from '@oh-my-pi/pi-ai';
const model:Model<'omniroute-chat'>={id:'fixture-chat',name:'Fixture',provider:'omniroute',api:'omniroute-chat',baseUrl:'https://router.example/v1',reasoning:false,input:['text'],cost:{input:1,output:2,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:2048,compat:{supportsUsageInStreaming:true}};
const context:Context={messages:[{role:'user',content:'Hello',timestamp:Date.now()}]};
const frame=(obj:unknown)=>`data: ${JSON.stringify(obj)}\n\n`;
for(const reported of [0,0.0123,undefined]) {
  test(`real OMP adapter preserves streamed response and applies cost ${reported}`,async()=>{
    let body:any;
    const fetchImpl:typeof fetch=async(_url,init)=>{
      body=JSON.parse(String(init?.body));
      return new Response(frame({id:'r1',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'Hello'},finish_reason:null}]})+
        frame({id:'r1',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+
        frame({id:'r1',object:'chat.completion.chunk',choices:[],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110,...(reported===undefined?{}:{cost:reported})}})+
        'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    };
    const stream=streamOmniRoute(model,context,{apiKey:'test-key',fetch:fetchImpl});
    const events=[];for await(const event of stream)events.push(event);
    const result=await stream.result();
    expect(result.stopReason).toBe('stop');expect(result.content).toContainEqual(expect.objectContaining({type:'text',text:'Hello'}));
    expect(result.usage.input).toBe(100);expect(result.usage.output).toBe(10);
    expect(result.usage.cost.total).toBeCloseTo(reported??0.00012,10);
    expect(body.model).toBe('fixture-chat');expect(body.stream_options.include_usage).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });
}

import {createOmniRouteStream} from '../src/reported-cost.ts';
import {registerCustomApi,unregisterCustomApis,streamSimple,__providerInFlightForTesting} from '@oh-my-pi/pi-ai';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

for(const [mode,adapter] of [['reported',streamOmniRoute],['disabled',streamNative]] as const) {
test(`registered ${mode} adapter completes under a one-request provider cap and dispatches once`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'omp-inflight-'));
  __providerInFlightForTesting.setRoot(root);
  let dispatches=0,fetches=0;
  registerCustomApi('omniroute-chat',adapter,'omniroute-regression');
  try {
    const events=streamSimple(model,context,{
      apiKey:'key',maxInFlightRequests:{omniroute:1},signal:AbortSignal.timeout(1500),
      beforeDispatch:()=>{dispatches++;},
      fetch:async()=>{
        fetches++;
        return new Response(frame({id:'r',choices:[{index:0,delta:{content:'bounded'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0}})+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
      },
    });
    for await(const _ of events){}
    expect((await events.result()).stopReason).toBe('stop');
    expect(fetches).toBe(1);expect(dispatches).toBe(1);
  } finally {
    unregisterCustomApis('omniroute-regression');
    __providerInFlightForTesting.setRoot(undefined);
    await rm(root,{recursive:true,force:true});
  }
});
}
test('adapter sends optional controls and records sanitized routing/cost metadata without changing native accounting',async()=>{
  let headers:Headers|undefined;let inspection:any;
  const stream=createOmniRouteStream({getSettings:()=>({reportedCost:false,inspectRequests:true,stickySessions:true,bypassCache:true,bypassMemory:true}),getPricingStatus:()=> 'estimated',getSessionId:()=> 'session1',onRequest:r=>inspection=r,getSecrets:()=>['test-key']});
  const events=stream(model,context,{apiKey:'test-key',fetch:async(_url,init)=>{
    headers=new Headers(init?.headers);
    return new Response(frame({id:'r',model:'served',provider:'p',choices:[{index:0,delta:{content:'hello'},finish_reason:null}]})+
      frame({id:'r',choices:[{index:0,delta:{},finish_reason:'stop'}]})+
      frame({id:'r',choices:[],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110,cost:0.0123}})+'data: [DONE]\n\n',{
      headers:{'content-type':'text/event-stream','x-omniroute-request-id':'req1','x-omniroute-decision':'strategy=auto; provider=p; latency_ms=3','set-cookie':'secret'},
    });
  }});
  for await(const _ of events){}const result=await events.result();
  expect(headers!.get('x-omniroute-no-cache')).toBe('true');expect(headers!.get('x-omniroute-no-memory')).toBe('true');
  expect(headers!.get('x-session-id')).toStartWith('omp-');
  expect(result.usage.cost.total).toBeCloseTo(0.00012,10);
  expect(inspection.cost).toEqual({source:'reported',usd:0.0123});expect(inspection.requestId).toBe('req1');
  expect(JSON.stringify(inspection)).not.toContain('hello');expect(JSON.stringify(inspection)).not.toContain('test-key');
});
test('disabled controls and observer errors never prevent response delivery',async()=>{
  const stream=createOmniRouteStream({getSettings:()=>({reportedCost:true,inspectRequests:true,stickySessions:false,bypassCache:false,bypassMemory:false}),onRequest:()=>{throw new Error('observer error');}});
  const events=stream(model,context,{apiKey:'key',fetch:async(_url,init)=>{
    expect(new Headers(init?.headers).has('x-session-id')).toBe(false);
    return new Response(frame({id:'r',choices:[{index:0,delta:{content:'safe'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0}})+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  for await(const _ of events){}expect((await events.result()).usage.cost.total).toBe(0);
});

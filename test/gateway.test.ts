import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/catalog.ts';
import { getGatewayJson, gatewayUrl } from '../src/gateway.ts';
const config=readConfig({OMNIROUTE_BASE_URL:'https://example.test/prefix/v1'});
test('derived endpoints preserve proxy prefix and refuse arbitrary destinations',()=>{
 assert.equal(gatewayUrl(config,'usage'),'https://example.test/prefix/api/usage/om-usage?format=json');
 assert.throws(()=>gatewayUrl(config,'https://evil.test' as any));
});
test('GET uses bearer, no redirects, bounds and sanitizes failures',async()=>{
 const r=await getGatewayJson(config,'models','secret',(async(url,init)=>{
 assert.equal(url,'https://example.test/prefix/v1/models'); assert.equal(init?.method,'GET'); assert.equal(init?.redirect,'error'); assert.equal(new Headers(init?.headers).get('authorization'),'Bearer secret');return Response.json({data:[]});}) as typeof fetch);
 assert.deepEqual(r.payload,{data:[]});
 await assert.rejects(getGatewayJson(config,'usage','secret',(async()=>new Response('secret',{status:403})) as typeof fetch),/HTTP 403/);
 await assert.rejects(getGatewayJson(config,'models','secret',(async()=>new Response('x',{headers:{'content-length':String(6*1024*1024)}})) as typeof fetch),/too large/);
 await assert.rejects(getGatewayJson(config,'models','secret',(async()=>{throw new Error('secret');}) as typeof fetch),e=>!String(e).includes('secret'));
});
test('deadline covers a stalled body even when mock fetch ignores signal',async()=>{
 await assert.rejects(getGatewayJson({...config,timeoutMs:20},'models','secret',(async()=>new Response(new ReadableStream({start(){}}))) as typeof fetch),/timeout/);
});
test('already cancelled requests do not send credentials',async()=>{
 let sent=false;await assert.rejects(getGatewayJson(config,'models','secret',(async()=>{sent=true;return Response.json({data:[]});}) as typeof fetch,AbortSignal.abort()),/cancelled/);assert.equal(sent,false);
});
test('streamed oversized bodies are bounded without content-length',async()=>{
 await assert.rejects(getGatewayJson(config,'models','secret',(async()=>new Response(new Uint8Array(5*1024*1024+1))) as typeof fetch),/too large/);
});
test('external cancellation rejects promptly even if fetch ignores its signal',async()=>{
 const controller=new AbortController();
 const pending=getGatewayJson({...config,timeoutMs:150},'models','secret',(()=>new Promise<Response>(()=>{})) as typeof fetch,controller.signal);
 controller.abort();
 const outcome=await Promise.race([pending.then(()=> 'resolved',error=>String(error)),new Promise<string>(resolve=>setImmediate(()=>resolve('still waiting')))]);
 assert.match(outcome,/cancelled/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequestHeaders, createRequestObserver, redactText} from '../src/telemetry.ts';
const off={stickySessions:false,bypassCache:false,bypassMemory:false};
test('request controls preserve other headers and use stable opaque session affinity',()=>{
  const a=buildRequestHeaders({...off,stickySessions:true,bypassCache:true,bypassMemory:true},'private/path/session',{Authorization:'Bearer secret','X-Test':'ok'});
  const b=buildRequestHeaders({...off,stickySessions:true},'private/path/session');
  const c=buildRequestHeaders({...off,stickySessions:true},'another-session');
  assert.equal(a.Authorization,'Bearer secret');assert.equal(a['X-Test'],'ok');
  assert.equal(a['X-Session-Id'],b['X-Session-Id']);assert.notEqual(a['X-Session-Id'],c['X-Session-Id']);
  assert.ok(!a['X-Session-Id'].includes('private/path'));assert.equal(a['X-OmniRoute-No-Cache'],'true');assert.equal(a['x-omniroute-no-memory'],'true');
  assert.deepEqual(buildRequestHeaders(off,'session'),{});
});
test('observer records whitelisted metadata, separates reported from estimated and excludes prompts/headers',()=>{
  const o=createRequestObserver('auto/fast','variable',100);
  o.response({status:200,headers:{'x-omniroute-request-id':'r1','x-omniroute-decision':'strategy=auto; provider=example; latency_ms=12','x-omniroute-provider':'example','x-omniroute-version':'3.8.54','authorization':'Bearer SECRET','set-cookie':'SECRET'}});
  o.sse(JSON.stringify({model:'served-model',provider:'example',choices:[{delta:{content:'PRIVATE PROMPT'}}],usage:{cost:0}}));
  const r=o.finish({usage:{input:100,output:10,cacheRead:0,cacheWrite:0,totalTokens:110,cost:{input:1,output:1,cacheRead:0,cacheWrite:0,total:2}},stopReason:'stop'},150);
  assert.equal(r.cost.source,'reported');assert.equal(r.cost.usd,0);assert.equal(r.elapsedMs,50);
  assert.equal(r.responseModel,'served-model');assert.equal(r.requestId,'r1');
  assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('observer preserves zero cost and routing identifiers after invalid or terminal events',()=>{
  const o=createRequestObserver('requested','estimated',0);
  o.sse('{"model":"served","provider":"upstream","id":"request","usage":{"cost":0.5}}');
  o.sse('{"usage":{"cost":0}}');
  assert.equal(o.reportedCost,0);
  for(const data of ['{','[DONE]','null','[]','0','true','"text"','{"usage":null}','{"usage":{"cost":-1}}']) {
    o.sse(data);
    assert.equal(o.reportedCost,0);
    const r=o.finish({},10);
    assert.deepEqual(r.cost,{source:'reported',usd:0});
    assert.equal(r.responseModel,'served');assert.equal(r.upstreamProvider,'upstream');assert.equal(r.requestId,'request');
  }
});
test('new response resets retry metadata and unknown cost is not reported as free',()=>{
  const o=createRequestObserver('auto/fast','variable',0);o.response({status:200,headers:{'x-omniroute-request-id':'attempt1'}});o.sse('{"usage":{"cost":0.5}}');
  o.response({status:200,headers:{'x-omniroute-request-id':'attempt2','x-omniroute-response-cost':'0.0000000000'}});
  const r=o.finish({usage:{cost:{total:0}}},10);
  assert.equal(r.cost.source,'unknown');assert.equal(r.cost.usd,undefined);assert.equal(r.requestId,'attempt2');
  assert.equal(r.gatewayCostHeaderUsd,0);assert.equal(r.observedResponses,2);
});
test('estimated cost is labeled and inspection strings remove controls and secrets',()=>{
  const o=createRequestObserver('fixed','estimated',0);const r=o.finish({usage:{cost:{total:0.2}}},10);
  assert.equal(r.cost.source,'estimated');assert.equal(r.cost.usd,0.2);
  assert.equal(redactText('hi\u001b[31m secret\nline',['secret']).includes('secret'),false);
  assert.ok(!redactText('hi\u001b[31m secret\nline',['secret']).includes('\u001b'));
});

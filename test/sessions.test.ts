import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchSessions,fetchSessionDetail,mapSessions} from '../src/sessions.ts';
const config={baseUrl:'https://example.test/v1',refreshMs:300000,timeoutMs:1000,include:[],exclude:[],variablePrice:[],requireTools:true,reportedCost:false,inspectRequests:true,catalogAlerts:true,stickySessions:false,bypassCache:false,bypassMemory:false};
const response=(payload:unknown)=>(async()=>new Response(JSON.stringify(payload),{headers:{'content-type':'application/json'}})) as unknown as typeof fetch;
const session={id:'key:abc',client:'omp',projectName:'demo',lastModel:'m',firstSeenAt:'2026-11-09T00:00:00Z',lastSeenAt:'2026-11-10T00:00:00Z',requestCount:4,errorCount:1,tokens:{input:100,output:10,cacheRead:40,cacheCreation:5,uncachedInput:55,total:110},costUsd:1.5,unpricedCount:0};
test('sessions map cached-token breakdown and totals without fabricating fields',async()=>{
  const r=await fetchSessions(config,'secret',response({sessions:[session],total:1,limit:20,offset:0}));
  assert.equal(r.total,1);assert.equal(r.sessions.length,1);
  const s=r.sessions[0];
  assert.equal(s.tokens?.cacheRead,40);assert.equal(s.tokens?.uncachedInput,55);assert.equal(s.costUsd,1.5);
  assert.equal(s.requestCount,4);assert.equal(s.errorCount,1);
});
test('invalid session rows are skipped and shape failures throw',async()=>{
  const r=await fetchSessions(config,'secret',response({sessions:[session,{noId:true},'x'],total:3,limit:20,offset:0}));
  assert.equal(r.sessions.length,1);
  await assert.rejects(fetchSessions(config,'secret',response({})),/invalid shape/);
});
test('friendly errors for auth, scope and pre-3.8.54 deployments',async()=>{
  const status=(code:number)=>((async()=>new Response('',{status:code})) as unknown as typeof fetch);
  await assert.rejects(fetchSessions(config,'secret',status(403)),/self:usage/);
  await assert.rejects(fetchSessions(config,'secret',status(401)),/authentication failed/);
  await assert.rejects(fetchSessions(config,'secret',status(404)),/3\.8\.54/);
});
test('session detail maps the same row shape and bounds the id',async()=>{
  const detail=await fetchSessionDetail(config,'secret','key:abc',response({session,recentRequests:[{id:1}]}));
  assert.equal(detail.session.tokens?.cacheCreation,5);assert.equal(detail.recentRequests.length,1);
  await assert.rejects(fetchSessionDetail(config,'secret','bad id'),/Invalid session id/);
});
test('missing sessions field throws rather than reading undefined',()=>{
  assert.throws(()=>mapSessions({total:0}),/invalid shape/);
});

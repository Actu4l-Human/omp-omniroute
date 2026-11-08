import test from 'node:test';
import assert from 'node:assert/strict';
import { diffCatalog } from '../src/changes.ts';
import { mapCatalog, readConfig } from '../src/catalog.ts';
const config=readConfig({OMNIROUTE_BASE_URL:'https://router.example'});
const row=(id:string, extra={})=>({id,name:id,pricing:{input:1,output:2},...extra});
const catalog=(rows:unknown[])=>mapCatalog({data:rows},config);
test('suppresses initial and unchanged catalogs including arbitrary raw changes',()=>{
  const a=catalog([row('a')]);
  assert.equal(diffCatalog(undefined,a),undefined);
  assert.equal(diffCatalog(a,catalog([row('a',{irrelevant:123})])),undefined);
});
test('reports added removed and categorized changes by stable model ID',()=>{
  const before=catalog([row('a'),row('removed')]);
  const after=catalog([row('a',{type:'embedding',context_length:99,capabilities:{vision:true},pricing:{input:4,output:8}}),row('added')]);
  assert.deepEqual(diffCatalog(before,after),{added:[{id:'added',name:'added'}],removed:[{id:'removed',name:'removed'}],changed:[{id:'a',name:'a',categories:['rates','capabilities','limits','transport']}]});
});
test('distinguishes unknown zero placeholders from explicitly zero prices',()=>{
  const a=catalog([row('a',{pricing:{}})]);
  const b=catalog([row('a',{pricing:{input:0,output:0,cached:0,cache_creation:0}})]);
  assert.deepEqual(diffCatalog(a,b)?.changed[0]?.categories,['rates']);
});
test('ignores ordering of semantic sets and reports meaningful capability changes',()=>{
  const a=catalog([row('a',{capabilities:{reasoning:true,effort_tiers:['low','high']}})]);
  const b=structuredClone(a); b.models[0].thinking!.efforts!.reverse();
  assert.equal(diffCatalog(a,b),undefined);
  b.metadata.get('a')!.tools=false;
  assert.deepEqual(diffCatalog(a,b)?.changed[0]?.categories,['capabilities']);
});

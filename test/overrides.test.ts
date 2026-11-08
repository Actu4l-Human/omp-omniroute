import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOverrides, applyOverrides, applyOverridesToRow } from '../src/overrides.ts';
async function withFile(contents:string, run:(path:string)=>Promise<void>) {
  const dir=await mkdtemp(join(tmpdir(),'omp-overrides-'));
  try { const path=join(dir,'overrides.json'); await writeFile(path,contents); await run(path); }
  finally {await rm(dir,{recursive:true,force:true});}
}
test('absent override path is empty; explicit missing file fails',async()=>{
  assert.deepEqual(Object.keys(await loadOverrides()),[]);
  await assert.rejects(loadOverrides('/nonexistent/overrides.json'));
});
test('merges exact existing rows only, preserves originals and false/zero values',async()=>{
  await withFile(JSON.stringify({'vendor/a':{name:'Local',type:'embedding',context_length:100,capabilities:{reasoning:false},pricing:{input:0},pricingStatus:'estimated'},'new':{name:'No insertion'}}),async path=>{
    const overrides=await loadOverrides(path);
    const row={id:'vendor/a',name:'Original',capabilities:{reasoning:true,tool_calling:true},pricing:{input:3,output:5}};
    const before=structuredClone(row);
    const result=applyOverridesToRow(row,overrides);
    assert.equal(result.effective.id,'vendor/a'); assert.equal(result.effective.name,'Local');
    assert.deepEqual(result.effective.capabilities,{reasoning:false,tool_calling:true});
    assert.deepEqual(result.effective.pricing,{input:0,output:5});
    assert.deepEqual(result.applied,overrides['vendor/a']); assert.deepEqual(row,before);
    assert.deepEqual((applyOverrides({data:[row,{id:'other'}]},overrides) as any).data,[result.effective,{id:'other'}]);
  });
});
test('rejects invalid fields, identifiers, nested values and prototype pollution',async()=>{
  const invalid=[{'x':{endpoint:'https://evil'}},{'x':{id:'other'}},{'x':{api:'arbitrary'}},{'x':{type:'audio'}},{'x':{context_length:0}},{'x':{max_output_tokens:1.1}},{'x':{pricing:{input:-1}}},{'x':{pricing:{input:'1'}}},{'x':{pricing:{input:Infinity}}},{'x':{capabilities:{vision:'yes'}}},{'x':{capabilities:{effort_tiers:['extreme']}}},{'x':{input_modalities:['binary']}},{'x':{pricingStatus:'free'}},{'x':{capabilities:{headers:{}}}},{'':{}},[]];
  for(const value of invalid) await withFile(JSON.stringify(value),async path=>{await assert.rejects(loadOverrides(path),/override/i);});
  for(const contents of ['{"__proto__":{}}','{"x":{"capabilities":{"constructor":true}}}','{"x":{"pricing":{"__proto__":0}}}'])
    await withFile(contents,async path=>{await assert.rejects(loadOverrides(path),/override/i);});
});
test('rejects oversized files and malformed JSON',async()=>{
  for(const contents of ['{broken',' '.repeat(262145)]) await withFile(contents,async path=>{await assert.rejects(loadOverrides(path),/override/i);});
});
test('supported native API override sets matching type and rejects contradictions',async()=>{
  await withFile('{"x":{"api":"openai-images"}}',async path=>{const result=applyOverridesToRow({id:'x'},await loadOverrides(path)); assert.equal(result.effective.type,'image');});
  await withFile('{"x":{"api":"openai-images","type":"embedding"}}',async path=>{await assert.rejects(loadOverrides(path),/override/i);});
});

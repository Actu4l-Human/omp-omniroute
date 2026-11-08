import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOverrides, applyOverrides, applyOverridesToRow, auditOverrides } from '../src/overrides.ts';
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
test('audits exact unique override keys and only suggests existing stripped provider IDs',()=>{
  const overrides={'vendor/a':{},'omniroute/vendor/a':{},'omniroute/vendor/b':{},'omniroute/missing':{},'Vendor/a':{}};
  const before=structuredClone(overrides);
  assert.deepEqual(auditOverrides(overrides,['vendor/a','vendor/a','vendor/b','omniroute/vendor/b']),{
    matched:2,unmatched:[{id:'omniroute/vendor/a',suggestedId:'vendor/a'},{id:'omniroute/missing'},{id:'Vendor/a'}],
  });
  assert.deepEqual(overrides,before);
  assert.deepEqual(auditOverrides({},['vendor/a']),{matched:0,unmatched:[]});
});
test('loader errors identify the setting and remedy without exposing paths or invalid contents',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'private-overrides-'));
  try {
    const path=join(dir,'private-file.json');
    for(const [contents,expected] of [[undefined,/not found/i],['{"private-model":',/valid JSON/i],['{"private-model":{"private-field":"private-value"}}',/unsupported field or value/i],[' '.repeat(262145),/256 KiB/]] as const){
      if(contents!==undefined)await writeFile(path,contents);
      await assert.rejects(loadOverrides(path),(error:Error)=>{
        assert.match(error.message,/OMNIROUTE_OVERRIDES_FILE/);assert.match(error.message,expected);
        for(const privateText of [dir,path,'private-model','private-field','private-value'])assert.ok(!error.message.includes(privateText));
        return true;
      });
    }
    await assert.rejects(loadOverrides(dir),(error:Error)=>{
      assert.match(error.message,/OMNIROUTE_OVERRIDES_FILE/);assert.ok(!error.message.includes(dir));return true;
    });
  } finally {await rm(dir,{recursive:true,force:true});}
});

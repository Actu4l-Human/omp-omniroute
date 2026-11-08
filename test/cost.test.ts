import test from 'node:test';
import assert from 'node:assert/strict';
import { readReportedCost, applyReportedCost } from '../src/cost.ts';
test('accepts only finite nonnegative numeric usage.cost in a parsed object payload',()=>{
  assert.equal(readReportedCost({usage:{cost:0}}),0);
  assert.equal(readReportedCost({usage:{cost:0.0123}}),0.0123);
  for(const payload of [undefined,null,[],0,true,'[DONE]',{}, {usage:null},{usage:[]},{usage:'cost'},
    {usage:{cost:-1}},{usage:{cost:'0.1'}},{usage:{cost:NaN}},{usage:{cost:Infinity}}]) {
    assert.equal(readReportedCost(payload),undefined);
  }
});
test('uses the reported total, scaling estimated buckets without inventing a detailed bill',()=>{
  const cost={input:1,output:3,cacheRead:0,cacheWrite:0,total:4};
  applyReportedCost(cost,0.4);
  assert.deepEqual(cost,{input:0.1,output:0.30000000000000004,cacheRead:0,cacheWrite:0,total:0.4});
  applyReportedCost(cost,0);assert.equal(cost.total,0);assert.equal(cost.output,0);
});
test('keeps tiny positive estimates finite and additive when applying a reported total',()=>{
  const cost={input:1e-308,output:0,cacheRead:0,cacheWrite:0,total:1e-308};
  applyReportedCost(cost,10);
  assert.deepEqual(cost,{input:10,output:0,cacheRead:0,cacheWrite:0,total:10});
  assert.ok(Object.values(cost).every(Number.isFinite));
  assert.equal(cost.input+cost.output+cost.cacheRead+cost.cacheWrite,cost.total);
});
test('keeps component-only aggregators additive when price was unknown',()=>{
  const cost={input:0,output:0,cacheRead:0,cacheWrite:0,total:0};
  applyReportedCost(cost,0.25);assert.deepEqual(cost,{input:0.25,output:0,cacheRead:0,cacheWrite:0,total:0.25});
});

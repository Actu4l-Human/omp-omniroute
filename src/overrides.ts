import { open } from 'node:fs/promises';

export interface ModelOverride {
  name?: string;
  type?: 'chat' | 'text' | 'completion' | 'embedding' | 'image';
  api?: 'openai-completions' | 'openai-embeddings' | 'openai-images';
  context_length?: number;
  max_output_tokens?: number;
  capabilities?: { reasoning?: boolean; thinking?: boolean; supportsThinking?: boolean; vision?: boolean; tool_calling?: boolean; effort_tiers?: string[] };
  input_modalities?: string[];
  pricing?: {input?: number; output?: number; cached?: number; cache_creation?: number};
  pricingStatus?: 'estimated' | 'unknown' | 'variable';
}
export type ModelOverrides = Record<string, ModelOverride>;
export interface OverrideDiagnostics {matched:number;unmatched:{id:string;suggestedId?:string}[]}
export function auditOverrides(overrides:ModelOverrides,ids:Iterable<string>):OverrideDiagnostics {
  const available=ids instanceof Set?ids:new Set(ids);
  const diagnostics:OverrideDiagnostics={matched:0,unmatched:[]};
  for(const id of Object.keys(overrides)) {
    if(available.has(id)){diagnostics.matched++;continue;}
    const stripped=id.startsWith('omniroute/')?id.slice('omniroute/'.length):undefined;
    diagnostics.unmatched.push({id,...(stripped!==undefined&&available.has(stripped)?{suggestedId:stripped}:{})});
  }
  return diagnostics;
}
const MAX_BYTES=256*1024;
const forbidden=new Set(['__proto__','prototype','constructor']);
const fields=new Set(['name','type','api','context_length','max_output_tokens','capabilities','input_modalities','pricing','pricingStatus']);
const apis={'openai-completions':'chat','openai-embeddings':'embedding','openai-images':'image'} as const;
class OverrideError extends Error {}
function fail():never {throw new OverrideError('Invalid model overrides in OMNIROUTE_OVERRIDES_FILE: unsupported field or value; use only supported override fields and values.');}
function record(value:unknown): Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail();
  for(const key of Object.keys(value)) if(forbidden.has(key)) fail();
  return value as Record<string,unknown>;
}
function choices(value:unknown,allowed:string[]):void {if(typeof value!=='string'||!allowed.includes(value)) fail();}
function strings(value:unknown,allowed:string[]):void {
  if(!Array.isArray(value)||value.length>allowed.length||new Set(value).size!==value.length) fail();
  for(const item of value) choices(item,allowed);
}
function validate(value:unknown):ModelOverrides {
  const all=record(value);
  for(const [id,candidate] of Object.entries(all)) {
    if(!id||id.length>512||/[\x00-\x1f\x7f]/.test(id)) fail();
    const row=record(candidate);
    for(const [key,v] of Object.entries(row)) {
      if(!fields.has(key)) fail();
      if(key==='name'&&(typeof v!=='string'||!v.trim()||v.length>240||/[\x00-\x1f\x7f]/.test(v))) fail();
      if(key==='type') choices(v,['chat','text','completion','embedding','image']);
      if(key==='api') choices(v,Object.keys(apis));
      if(key==='pricingStatus') choices(v,['estimated','unknown','variable']);
      if(['context_length','max_output_tokens'].includes(key)&&(typeof v!=='number'||!Number.isSafeInteger(v)||v<=0)) fail();
      if(key==='input_modalities') strings(v,['text','image']);
      if(key==='capabilities') for(const [cap,c] of Object.entries(record(v))) {
        if(cap==='effort_tiers') strings(c,['minimal','low','medium','high','xhigh','max']);
        else if(!['reasoning','thinking','supportsThinking','vision','tool_calling'].includes(cap)||typeof c!=='boolean') fail();
      }
      if(key==='pricing') for(const [rate,n] of Object.entries(record(v))) {
        if(!['input','output','cached','cache_creation'].includes(rate)||typeof n!=='number'||!Number.isFinite(n)||n<0) fail();
      }
    }
    if(row.api && row.type) {
      const kind=['text','completion'].includes(row.type as string)?'chat':row.type;
      if(apis[row.api as keyof typeof apis]!==kind) fail();
    }
  }
  return structuredClone(all) as ModelOverrides;
}
/** A missing path disables overrides; an explicitly configured unreadable file fails closed. */
export async function loadOverrides(path?:string):Promise<ModelOverrides> {
  if(path===undefined||path==='') return {};
  try {
    const handle=await open(path,'r');
    try {
      const stat=await handle.stat();
      if(!stat.isFile()||stat.size>MAX_BYTES) throw new OverrideError('Set OMNIROUTE_OVERRIDES_FILE to a regular model overrides file of at most 256 KiB.');
      const bytes=Buffer.alloc(MAX_BYTES+1); let total=0;
      while(total<bytes.length) {
        const {bytesRead}=await handle.read(bytes,total,bytes.length-total,null);
        if(bytesRead===0) break; total+=bytesRead;
      }
      if(total>MAX_BYTES) throw new OverrideError('Model overrides file exceeds 256 KiB; reduce the file configured by OMNIROUTE_OVERRIDES_FILE.');
      let parsed:unknown;
      try {parsed=JSON.parse(bytes.subarray(0,total).toString('utf8'));} catch {throw new OverrideError('Model overrides file is not valid JSON; correct the JSON in OMNIROUTE_OVERRIDES_FILE.');}
      return validate(parsed);
    } finally {await handle.close();}
  } catch(error) {
    if(error instanceof OverrideError) throw error;
    if(error instanceof Error && 'code' in error && error.code==='ENOENT') throw new OverrideError('Model overrides file not found; set OMNIROUTE_OVERRIDES_FILE to an existing file (relative paths use the working directory), or unset it.');
    throw new OverrideError('Cannot read model overrides; check that OMNIROUTE_OVERRIDES_FILE names a readable regular file and that file permissions allow access, or unset it.');
  }
}
export function applyOverridesToRow(row:Record<string,unknown>,overrides:ModelOverrides):{effective:Record<string,unknown>;applied?:ModelOverride} {
  const id=row.id;
  if(typeof id!=='string'||!Object.hasOwn(overrides,id)) return {effective:row};
  // Revalidate programmatic callers too; never allow an ID, endpoint or credential override.
  const applied=validate({[id]:overrides[id]})[id];
  const effective={...row,...structuredClone(applied)} as Record<string,unknown>;
  for(const field of ['capabilities','pricing'] as const) if(applied[field]) {
    const original=row[field];
    effective[field]={...(original&&typeof original==='object'&&!Array.isArray(original)?original:{}),...applied[field]};
  }
  if(applied.api) effective.type=apis[applied.api];
  return {effective,applied};
}
/** Retains the envelope and never inserts models absent from the gateway. */
export function applyOverrides(payload:unknown,overrides:ModelOverrides):unknown {
  if(!payload||typeof payload!=='object'||Array.isArray(payload)) return payload;
  const envelope=payload as Record<string,unknown>;
  if(!Array.isArray(envelope.data)) return payload;
  return {...envelope,data:envelope.data.map(row=>row&&typeof row==='object'&&!Array.isArray(row)?applyOverridesToRow(row,overrides).effective:row)};
}

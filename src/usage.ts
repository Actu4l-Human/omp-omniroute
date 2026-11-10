import {createHash} from 'node:crypto';
import type {UsageProvider,UsageReport,UsageLimit,UsageAmount} from '@oh-my-pi/pi-ai';
import {PROVIDER,type Config} from './catalog.ts';
import {getGatewayJson,GatewayError,asRecord,safeLabel} from './gateway.ts';
const numeric=(v:unknown):number|undefined=>typeof v==='number' && Number.isFinite(v) && v>=0?v:typeof v==='string' && /^\d+(\.\d+)?$/.test(v) && Number.isFinite(Number(v))?Number(v):undefined;
const reset=(v:unknown):number|undefined=>typeof v==='string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v))?Date.parse(v):undefined;
// Fractions describe consumed allowance (0..1); raw amounts retain any overage.
const usedFraction=(used:number,limit:number):number=>used>=limit?1:used/limit;
const normalizeLabel=(value:string):string=>value.replace(/[\x00-\x1f\x7f-\x9f]/g,'');
// Hash raw, domain-separated identity tuples, never lossy display labels.
const opaqueId=(namespace:'account'|'anonymous'|'quota',...identity:(string|number|null)[]):string=>`${namespace}:${createHash('sha256').update(JSON.stringify([namespace,...identity])).digest('hex')}`;
function status(amount:UsageAmount):UsageLimit['status']{
 const ratio=amount.usedFraction ?? (amount.used!==undefined && amount.limit!==undefined && amount.limit>0?usedFraction(amount.used,amount.limit):undefined);
 if(ratio!==undefined)return ratio>=1?'exhausted':ratio>=.8?'warning':'ok';
 return amount.used!==undefined && amount.limit===0?'exhausted':'unknown';
}
function mapUsage(payload:unknown,key:string|undefined):UsageReport {
 const normalizedKey=key?normalizeLabel(key):'';
 const labelText=(value:unknown,fallback:string)=>{
  const normalized=typeof value==='string'?normalizeLabel(value):value;
  return safeLabel(typeof normalized==='string' && normalizedKey?normalized.split(normalizedKey).join('[redacted]'):normalized,fallback);
 };
 const root=asRecord(payload);if(root?.allowed===false)throw new Error('OmniRoute usage request was refused; check the key and allowUsageCommand permission');
 if(root?.allowed!==true)throw new Error('OmniRoute usage response has an invalid shape');
 const report:UsageReport={provider:PROVIDER,fetchedAt:Date.now(),limits:[],notes:['Provider quotas are raw cached upstream snapshots, not cutoff-adjusted usable allowance. Cache observation time is not supplied.']};
 const personal=asRecord(root.personal);
 if(personal)for(const period of ['daily','weekly']){
  const used=numeric(personal[period+'SpentUsd']),limit=numeric(personal[period+'LimitUsd']),resetsAt=reset(personal[period+'ResetAtIso']);
  const exceeded=personal[period+'Exceeded']===true;
  if(used===undefined && limit===undefined && !exceeded)continue;
  const amount:UsageAmount={unit:'usd',...(used!==undefined?{used}:{}),...(limit!==undefined?{limit}:{})};
  if(used!==undefined && limit!==undefined && limit>0){
   amount.usedFraction=usedFraction(used,limit);amount.remaining=Math.max(0,limit-used);amount.remainingFraction=amount.remaining/limit;
  }
  // OmniRoute 3.8.54 explicitly reports whether the key exceeded each window; trust it over ratio math.
  report.limits.push({id:`personal:${period}`,label:`Personal ${period}`,scope:{provider:PROVIDER,windowId:period},window:{id:period,label:period,...(resetsAt!==undefined?{resetsAt}:{})},amount,status:exceeded?'exhausted':status(amount)});
 }
 const snapshots=Array.isArray(root.providers)&&root.providers.length?root.providers:root.provider?[root.provider]:[];
 const seen=new Set<string>();
 for(const [i,candidate] of snapshots.entries()){
  const snapshot=asRecord(candidate);const quotas=asRecord(snapshot?.quotas);if(!snapshot || !quotas)continue;
  const provider=labelText(snapshot.provider,'Provider');
  const rawProvider=typeof snapshot.provider==='string'?snapshot.provider:null;
  const rawAccount=typeof snapshot.connectionId==='string' && snapshot.connectionId.trim()?snapshot.connectionId:undefined;
  // Missing connection IDs have only snapshot-local identity, separate from real account names.
  const account=rawAccount!==undefined?opaqueId('account',rawProvider,rawAccount):opaqueId('anonymous',rawProvider,i);
  if(seen.has(account))continue;seen.add(account);
  for(const [name,value] of Object.entries(quotas)){
   const q=asRecord(value);if(!q)continue;const label=labelText(name,'Quota'),quota=opaqueId('quota',account,name);
   const used=numeric(q.used),total=numeric(q.total),usedPercent=numeric(q.usedPercentage),remainingPercent=numeric(q.remainingPercentage);
   const amount:UsageAmount={unit:'unknown'};
   if(usedPercent!==undefined){amount.unit='percent';amount.used=usedPercent;amount.limit=100;amount.usedFraction=usedFraction(usedPercent,100);}
   else if(remainingPercent!==undefined && remainingPercent<=100){amount.unit='percent';amount.remaining=remainingPercent;amount.limit=100;amount.remainingFraction=remainingPercent/100;amount.usedFraction=1-remainingPercent/100;}
   else if(used!==undefined && total!==undefined && total>0){amount.used=used;amount.limit=total;amount.usedFraction=usedFraction(used,total);}
   // A bare used/remaining value has no reliable unit; do not guess a percentage.
   const resetsAt=reset(q.resetAt);
   report.limits.push({id:quota,label:`${provider} ${label} (raw)`,scope:{provider:PROVIDER,accountId:account,windowId:quota},window:{id:quota,label,...(resetsAt!==undefined?{resetsAt}:{})},amount,status:status(amount)});
  }
 }
 if(!report.limits.length)report.notes!.push('No usable usage data is available; this does not mean zero usage.');
 return report;
}
// OmniRoute 3.8.54 GET /v1/me/status: key-scoped monthly spend, token totals and limit entries.
function mergeSelfStatus(report:UsageReport,payload:unknown):void{
 const root=asRecord(payload);if(!root)return;
 const usage=asRecord(root.usage);const cost=asRecord(usage?.cost);const tokens=asRecord(usage?.tokens);
 if(cost && numeric(cost.usedUsd)!==undefined){
  const resetsAt=reset(String(cost.resetAt??''));
  const limit=numeric(cost.limitUsd);const used=numeric(cost.usedUsd)!;
  const amount:UsageAmount={unit:'usd',used,...(limit!==undefined?{limit}:{})};
  if(limit!==undefined && limit>0){amount.usedFraction=usedFraction(used,limit);amount.remaining=Math.max(0,limit-used);amount.remainingFraction=amount.remaining/limit;}
  report.limits.push({id:'status:monthly',label:'Monthly spend',scope:{provider:PROVIDER,windowId:'status-monthly'},window:{id:'status-monthly',label:'monthly',...(resetsAt!==undefined?{resetsAt}:{})},amount,status:status(amount)});
 }
 for(const entry of Array.isArray(root.limits)?root.limits:[]){
  const l=asRecord(entry);if(!l)continue;
  const used=numeric(l.used),limit=numeric(l.limit);if(used===undefined && limit===undefined)continue;
  const label=safeLabel(typeof l.label==='string'?l.label:typeof l.type==='string'?l.type:'limit','Limit');
  const amount:UsageAmount={unit:'unknown',...(used!==undefined?{used}:{}),...(limit!==undefined?{limit}:{})};
  if(used!==undefined && limit!==undefined && limit>0)amount.usedFraction=usedFraction(used,limit);
  const resetsAt=reset(String(l.resetAt??''));
  report.limits.push({id:'status:'+opaqueId('quota',label,used??0,limit??0),label:`${label} (status)`,scope:{provider:PROVIDER,windowId:'status'},window:{id:'status',label,...(resetsAt!==undefined?{resetsAt}:{})},amount,status:status(amount)});
 }
 const parts:string[]=[];
 if(tokens)for(const [key,label] of [['inputTokens','input'],['outputTokens','output'],['cacheReadTokens','cache read'],['cacheCreationTokens','cache write'],['reasoningTokens','reasoning']] as const){const v=numeric(tokens[key]);if(v!==undefined)parts.push(`${label}: ${v}`);}
 if(cost && numeric(cost.listPriceUsd)!==undefined)parts.push(`list-price: ${numeric(cost.listPriceUsd)}`);
 if(parts.length)report.notes!.push(`Self-service monthly tokens/cost: ${parts.join(', ')}`);
}
export async function fetchUsageSnapshot(config:Config,key:string|undefined,fetchImpl:typeof fetch=fetch,signal?:AbortSignal):Promise<UsageReport>{
 try {
  const report=mapUsage((await getGatewayJson(config,'usage',key,fetchImpl,signal)).payload,key);
  // 3.8.54 self-service status is additive: never replace the legacy snapshot, never fail usage when it is absent.
  try{mergeSelfStatus(report,(await getGatewayJson(config,'meStatus',key,fetchImpl,signal)).payload);}catch{}
  return report;
 }
 catch(error){if(error instanceof GatewayError && error.status===403)throw new Error('OmniRoute usage requires allowUsageCommand for this API key (HTTP 403); ask your gateway administrator to enable it if desired');if(error instanceof GatewayError && error.status===401)throw new Error('OmniRoute usage authentication failed (HTTP 401); check your API key');throw error;}
}
export function createUsageProvider(config:Config,fetchImpl?:typeof fetch):UsageProvider{
 return {id:PROVIDER,cacheVersion:4,retainLastGoodOnFailure:false,validatesCredentials:false,
 supports:params=>params.provider===PROVIDER && params.credential.type==='api_key',
 fetchUsage:(params,ctx)=>fetchUsageSnapshot(config,params.credential.apiKey,fetchImpl ?? ctx.fetch as typeof fetch,params.signal)};
}

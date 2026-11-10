import { createHash } from 'node:crypto';
import type { ProviderResponseMetadata } from '@oh-my-pi/pi-ai';
import { readReportedCost } from './cost.ts';

export interface RequestControls { stickySessions:boolean; bypassCache:boolean; bypassMemory:boolean; }
export interface RequestRecord {
  requestedModel:string; servedModel?:string; responseModel?:string; upstreamProvider?:string; requestId?:string;
  routingDecision?:string; gatewayVersion?:string; status?:number; observedResponses:number;
  startedAt:string; finishedAt:string; elapsedMs:number; outcome:string;
  tokens?:{input?:number;output?:number;cacheRead?:number;cacheWrite?:number;total?:number};
  cost:{source:'reported'|'estimated'|'unknown';usd?:number};
  gatewayCostHeaderUsd?:number; ompTotalUsd?:number; cacheHit?:boolean;
  rateLimits?:Record<string,string>;
}
const obj=(v:unknown):Record<string,unknown> => v && typeof v==='object' && !Array.isArray(v)?v as Record<string,unknown>:{};
const nonnegative=(v:unknown):number|undefined=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:undefined;
export function redactText(s:string,secrets:string[]=[]):string {
  for(const secret of secrets.filter(x=>x.length>0))s=s.split(secret).join('[redacted]');
  return s.replace(/Bearer\s+[^\s;,]+/gi,'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g,'[redacted]')
    .replace(/[\x00-\x1f\x7f-\x9f]/g,' ').slice(0,300);
}
export function buildRequestHeaders(controls:RequestControls,sessionId?:string,headers:Record<string,string>={}):Record<string,string> {
  const result={...headers};
  const set=(name:string,value:string)=>{for(const old of Object.keys(result))if(old.toLowerCase()===name.toLowerCase())delete result[old];result[name]=value;};
  if(sessionId) {
    const tag='omp-'+createHash('sha256').update('omp-omniroute/session/'+sessionId).digest('hex').slice(0,32);
    // OmniRoute 3.8.54 attributes requests to agent sessions via x-omniroute-session-id
    // (read before client-native session headers). Sticky routing additionally pins X-Session-Id.
    set('X-OmniRoute-Session-Id',tag);
    if(controls.stickySessions)set('X-Session-Id',tag);
  }
  if(controls.bypassCache)set('X-OmniRoute-No-Cache','true');
  if(controls.bypassMemory)set('x-omniroute-no-memory','true');
  return result;
}
export function createRequestObserver(modelId:string,pricingStatus:string|undefined,started=Date.now(),secrets:string[]=[]) {
  let reported:number|undefined;
  let info:Partial<RequestRecord>={};let attempts=0;
  const text=(v:unknown)=>typeof v==='string'&&v.length>0?redactText(v,secrets):undefined;
  return {
    response(response:ProviderResponseMetadata) {
      reported=undefined;info={};attempts++;
      const h=Object.fromEntries(Object.entries(response.headers).map(([k,v])=>[k.toLowerCase(),v]));
      info.status=response.status;
      info.requestId=text(h['x-omniroute-request-id'])??text(response.requestId);
      info.upstreamProvider=text(h['x-omniroute-provider']);
      info.servedModel=text(h['x-omniroute-model']);
      info.routingDecision=text(h['x-omniroute-decision']);
      info.gatewayVersion=text(h['x-omniroute-version']);
      const raw=h['x-omniroute-response-cost'];
      if(raw && /^\d+(?:\.\d+)?$/.test(raw))info.gatewayCostHeaderUsd=nonnegative(Number(raw));
      const hit=h['x-omniroute-cache-hit'];if(hit==='true'||hit==='false')info.cacheHit=hit==='true';
      else if(h['x-omniroute-cache']==='HIT'||h['x-omniroute-cache']==='MISS')info.cacheHit=h['x-omniroute-cache']==='HIT';
      // Per-key policy may forward upstream anthropic-ratelimit-* headers (OmniRoute 3.8.54).
      const rateLimits:Record<string,string>={};
      for(const [name,value] of Object.entries(h))if(name.startsWith('anthropic-ratelimit-') && typeof value==='string' && value.trim())rateLimits[name]=redactText(value,secrets);
      if(Object.keys(rateLimits).length)info.rateLimits=rateLimits;
    },
    sse(data:string) {
      // Read only routing identifiers and usage total. Never retain prompt/content bytes.
      try {
        const payload:unknown=JSON.parse(data);
        const cost=readReportedCost(payload);if(cost!==undefined)reported=cost;
        const event=obj(payload);info.responseModel??=text(event.model);info.upstreamProvider??=text(event.provider);info.requestId??=text(event.id);
      }catch{}
    },
    get reportedCost(){return reported;},
    finish(message:unknown,ended=Date.now()):RequestRecord {
      const m=obj(message);const usage=obj(m.usage);const cost=obj(usage.cost);const estimate=nonnegative(cost.total);
      const source=reported!==undefined?'reported':pricingStatus==='estimated'&&estimate!==undefined?'estimated':'unknown';
      return {...info,requestedModel:redactText(modelId,secrets),observedResponses:attempts,
        startedAt:new Date(started).toISOString(),finishedAt:new Date(ended).toISOString(),elapsedMs:Math.max(0,ended-started),
        outcome:text(m.stopReason)??'error',
        tokens:{input:nonnegative(usage.input),output:nonnegative(usage.output),cacheRead:nonnegative(usage.cacheRead),cacheWrite:nonnegative(usage.cacheWrite),total:nonnegative(usage.totalTokens)},
        ompTotalUsd:estimate,
        cost:{source,...(source==='reported'?{usd:reported}:source==='estimated'?{usd:estimate}:{})},
      };
    },
  };
}

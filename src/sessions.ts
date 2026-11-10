import type {Config} from './catalog.ts';
import {getGatewayJson,GatewayError,asRecord,safeLabel} from './gateway.ts';

/** OmniRoute 3.8.54 GET /v1/me/sessions (key-scoped, requires the self:usage scope). */
export interface AgentSessionSummary {
  id:string; client?:string; projectName?:string; lastModel?:string;
  firstSeenAt?:string; lastSeenAt?:string; requestCount?:number; errorCount?:number;
  tokens?:{input?:number;output?:number;cacheRead?:number;cacheCreation?:number;uncachedInput?:number;total?:number};
  costUsd?:number; unpricedCount?:number;
}
export interface AgentSessionsReport {total:number; limit:number; offset:number; sessions:AgentSessionSummary[]; }
export interface AgentSessionDetail {session:AgentSessionSummary; recentRequests:unknown[];}
const num=(v:unknown):number|undefined=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:undefined;
const str=(v:unknown,max=120):string|undefined=>typeof v==='string'&&v.trim()?safeLabel(v,'').slice(0,max)||undefined:undefined;

export function mapSessions(payload:unknown):AgentSessionsReport {
  const root=asRecord(payload);
  if(!root || !Array.isArray(root.sessions)) throw new Error('OmniRoute sessions response has an invalid shape');
  const sessions:AgentSessionSummary[]=[];
  for(const candidate of root.sessions) {
    const s=asRecord(candidate);if(!s || typeof s.id!=='string' || !s.id)continue;
    const t=asRecord(s.tokens);
    sessions.push({
      id:s.id,
      client:str(s.client), projectName:str(s.projectName), lastModel:str(s.lastModel),
      firstSeenAt:str(s.firstSeenAt,40), lastSeenAt:str(s.lastSeenAt,40),
      requestCount:num(s.requestCount), errorCount:num(s.errorCount),
      ...(t?{tokens:{input:num(t.input),output:num(t.output),cacheRead:num(t.cacheRead),cacheCreation:num(t.cacheCreation),uncachedInput:num(t.uncachedInput),total:num(t.total)}}:{}),
      costUsd:num(s.costUsd), unpricedCount:num(s.unpricedCount),
    });
  }
  return {total:num(root.total)??sessions.length, limit:num(root.limit)??20, offset:num(root.offset)??0, sessions};
}
export interface AgentSessionRequest {
  timestamp?:string; provider?:string; model?:string; status?:number; success?:boolean;
  tokens?:{input?:number;output?:number;cacheRead?:number;cacheCreation?:number;reasoning?:number};
  latencyMs?:number; ttftMs?:number;
}
export async function fetchSessions(config:Config,key:string|undefined,fetchImpl:typeof fetch=fetch,signal?:AbortSignal,query='?limit=20&sort=lastSeen&order=desc'):Promise<AgentSessionsReport> {
  try {return mapSessions((await getGatewayJson(config,'sessions',key,fetchImpl,signal,'',query)).payload);}
  catch(error){
    if(error instanceof GatewayError && error.status===403)throw new Error('OmniRoute sessions require the self:usage key scope (HTTP 403); ask your gateway administrator to enable it if desired');
    if(error instanceof GatewayError && error.status===401)throw new Error('OmniRoute sessions authentication failed (HTTP 401); check your API key');
    if(error instanceof GatewayError && error.status===404)throw new Error('OmniRoute sessions endpoint not found; it requires OmniRoute 3.8.54 or later');
    throw error;
  }
}
export async function fetchSessionDetail(config:Config,key:string|undefined,id:string,fetchImpl:typeof fetch=fetch,signal?:AbortSignal):Promise<AgentSessionDetail> {
  if(!/^[\w.:-]{1,256}$/.test(id))throw new Error('Invalid session id');
  const {payload}=await getGatewayJson(config,'sessions',key,fetchImpl,signal,'/'+encodeURIComponent(id));
  const root=asRecord(payload);
  if(!root)throw new Error('OmniRoute session detail response has an invalid shape');
  const mapped=mapSessions({sessions:[root.session],total:1,limit:1,offset:0});
  if(!mapped.sessions.length)throw new Error('OmniRoute session detail response has an invalid shape');
  return {session:mapped.sessions[0], recentRequests:mapRecentRequests(root.recentRequests)};
}
/** Bounded, redacted projection of the gateway's recent-request rows; connection ids stay behind the account-quota scope. */
export function mapRecentRequests(rows:unknown):AgentSessionRequest[] {
  if(!Array.isArray(rows))return [];
  const out:AgentSessionRequest[]=[];
  for(const candidate of rows){
    const r=asRecord(candidate);if(!r)continue;
    const t=asRecord(r.tokens);
    out.push({
      timestamp:str(r.timestamp,40), provider:str(r.provider), model:str(r.model),
      status:num(r.status), success:r.success===true||r.success===false?r.success:undefined,
      ...(t?{tokens:{input:num(t.input),output:num(t.output),cacheRead:num(t.cacheRead),cacheCreation:num(t.cacheCreation),reasoning:num(t.reasoning)}}:{}),
      latencyMs:num(r.latencyMs), ttftMs:num(r.ttftMs),
    });
  }
  return out;
}

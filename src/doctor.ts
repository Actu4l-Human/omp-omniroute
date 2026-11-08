import type {Config} from './catalog.ts';
import {getGatewayJson,GatewayError,asRecord,gatewayUrl} from './gateway.ts';
import {loadOverrides,auditOverrides,type ModelOverrides,type OverrideDiagnostics} from './overrides.ts';
export interface DoctorCheck {id:string;status:'ok'|'warning'|'error';message:string}
export interface DoctorReport {checks:DoctorCheck[];version?:string;modelCount?:number;overrides?:OverrideDiagnostics;health?:{total:number;states:Record<string,number>;coverage:{catalog:number;matched:number;unobserved:number;healthOnly:number}}}
export async function runDoctor(config:Config,key:string|undefined,fetchImpl:typeof fetch=fetch):Promise<DoctorReport>{
 const report:DoctorReport={checks:[]};
 const catalogIds=new Set<string>();
 let endpointValid=true;
 try {
  const endpoint=new URL(gatewayUrl(config,'models'));endpoint.pathname=endpoint.pathname.slice(0,-7);
  const loopback=['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname);
  const transport=endpoint.protocol==='https:'?'HTTPS':loopback?'loopback HTTP':'trusted-network HTTP (unencrypted)';
  const display=key?endpoint.toString().split(key).join('[redacted]'):endpoint.toString();
  report.checks.push({id:'endpoint',status:endpoint.protocol==='https:' || loopback?'ok':'warning',message:`Configured API endpoint: ${display} (${transport}).`});
 }catch{report.checks.push({id:'endpoint',status:'error',message:'Invalid configured API endpoint; use an HTTP(S) /v1 URL without credentials, query, or fragment.'});endpointValid=false;}
 let overrides:ModelOverrides|undefined;
 if(config.overridesFile){
  try{
   overrides=await loadOverrides(config.overridesFile);
   report.checks.push({id:'overrides-file',status:'ok',message:'OMNIROUTE_OVERRIDES_FILE is readable, bounded, and contains valid model overrides. Matching requires a successful catalog GET.'});
  }catch(error){report.checks.push({id:'overrides-file',status:'error',message:error instanceof Error?error.message:'Cannot load model overrides; check the file configured by OMNIROUTE_OVERRIDES_FILE.'});}
 }
 if(!endpointValid)return report;
 try {
  const {payload,headers}=await getGatewayJson(config,'models',key,fetchImpl);const root=asRecord(payload);
  if(!Array.isArray(root?.data) || root.data.some(row=>typeof asRecord(row)?.id!=='string' || !(asRecord(row)!.id as string).trim()))throw new GatewayError('OmniRoute models response has an invalid data array');
  for(const row of root.data)catalogIds.add(asRecord(row)!.id as string);
  report.modelCount=root.data.length;report.checks.push({id:'models',status:'ok',message:`Authenticated catalog GET succeeded (${report.modelCount} models). Inference was not tested.`});
  const version=headers.get('x-omniroute-version');
  if(version===null)report.checks.push({id:'version',status:'ok',message:'Catalog does not advertise a deployment version; inference was not tested.'});
  else if(version && /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version) && version.length<80){report.version=version;report.checks.push({id:'version',status:'ok',message:`Deployment reports version ${version}.`});}
  else report.checks.push({id:'version',status:'warning',message:'Deployment version header is unrecognized.'});
 }catch(error){report.checks.push({id:'models',status:'error',message:error instanceof GatewayError?error.message:'Catalog check failed.'});return report;}
 if(overrides){
  report.overrides=auditOverrides(overrides,catalogIds);
  const unmatched=report.overrides.unmatched.length;
  report.checks.push({id:'overrides-match',status:unmatched?'warning':'ok',message:`${report.overrides.matched} override key(s) matched raw catalog IDs; ${unmatched} unmatched.${unmatched?' Correct OMNIROUTE_OVERRIDES_FILE using exact raw catalog IDs; see overrides.unmatched for IDs and suggestedId hints. Keys are not automatically rewritten.':''}`});
 }
 try{
  const {payload}=await getGatewayJson(config,'health',key,fetchImpl);const root=asRecord(payload);
  if(!Array.isArray(root?.data))throw new GatewayError('OmniRoute health response has an invalid data array');
  const states:Record<string,number>={},healthIds=new Set<string>();
  for(const row of root.data){const r=asRecord(row);if(typeof r?.id!=='string' || typeof r.state!=='string')throw new GatewayError('OmniRoute health response has an invalid row');healthIds.add(r.id);const state=['ok','cooling','disabled','unavailable','unknown','blocked'].includes(r.state)?r.state:'unknown';states[state]=(states[state]??0)+1;}
  let matched=0;for(const id of healthIds)if(catalogIds.has(id))matched++;
  const coverage={catalog:catalogIds.size,matched,unobserved:catalogIds.size-matched,healthOnly:healthIds.size-matched};
  report.health={total:root.data.length,states,coverage};
  report.checks.push({id:'health',status:healthIds.size===0 || Object.keys(states).some(s=>s!=='ok')?'warning':'ok',message:`${healthIds.size===0?'No health observations received.':'Read-only model health received.'} Coverage (unique exact IDs): ${matched}/${coverage.catalog} catalog IDs matched, ${coverage.unobserved} unobserved, ${coverage.healthOnly} health-only. Unobserved catalog IDs are not evidence of unhealthy models. "ok" means no pause observed by this instance, not guaranteed upstream availability; connection-level pauses may be absent.`});
 }catch(error){const unsupported=error instanceof GatewayError && [404,405,501].includes(error.status??0);report.checks.push({id:'health',status:'warning',message:unsupported?'Optional model health endpoint is unsupported; the basic catalog GET succeeded.':error instanceof GatewayError?`Optional health check failed: ${error.message}`:'Optional health check failed.'});}
 return report;
}

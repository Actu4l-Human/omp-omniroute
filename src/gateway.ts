import type { Config } from './catalog.ts';
export type GatewayEndpoint = 'models' | 'health' | 'usage' | 'sessions' | 'meStatus';
export class GatewayError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {super(message); this.name='GatewayError';this.status=status;}
}
export function gatewayUrl(config: Config, endpoint: GatewayEndpoint, suffix = '', query?: string): string {
  const base=new URL(config.baseUrl);
  if(base.username || base.password || base.search || base.hash || !['http:','https:'].includes(base.protocol)) throw new GatewayError('Invalid OmniRoute base URL');
  const path=base.pathname.replace(/\/+$/,'');
  if(endpoint==='sessions' && suffix && !/^\/[\w.:%-]*$/.test(suffix)) throw new GatewayError('Invalid OmniRoute session id');
  if(endpoint==='models') base.pathname=path+'/models';
  else if(endpoint==='health') base.pathname=path+'/models/health';
  else if(endpoint==='usage'){base.pathname=path.slice(0,-3)+'/api/usage/om-usage';base.search='?format=json';}
  else if(endpoint==='meStatus')base.pathname=path+'/me/status';
  else if(endpoint==='sessions'){base.pathname=path+'/me/sessions'+suffix;base.search=query??'';}
  else throw new GatewayError('Unsupported OmniRoute endpoint');
  return base.toString();
}
/** Bounded same-origin GET. Never surfaces upstream error bodies, keys, or arbitrary exception text. */
export async function getGatewayJson(config:Config, endpoint:GatewayEndpoint, key:string|undefined, fetchImpl:typeof fetch=fetch, signal?:AbortSignal, suffix='', query?:string):Promise<{payload:unknown;headers:Headers}> {
  if(!key || key==='OMNIROUTE_API_KEY' || /[\r\n]/.test(key)) throw new GatewayError('Set a valid OMNIROUTE_API_KEY');
  if(signal?.aborted)throw new GatewayError('OmniRoute request cancelled');
  const url=gatewayUrl(config,endpoint,suffix,query); const controller=new AbortController();
  let rejectCancellation:(reason:GatewayError)=>void;
  const cancellation=new Promise<never>((_,reject)=>{rejectCancellation=reject;});
  const abort=()=>{rejectCancellation(new GatewayError('OmniRoute request cancelled'));controller.abort();};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let timer:ReturnType<typeof setTimeout>;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new GatewayError('OmniRoute request failed (timeout)'));},config.timeoutMs);});
  const work=async()=>{
    let response:Response;
    try {response=await fetchImpl(url,{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},signal:controller.signal});}
    catch{throw new GatewayError('OmniRoute request failed (network, redirect, or timeout)');}
    const cancel=()=>{void response.body?.cancel().catch(()=>{});};
    if(!response.ok){cancel();throw new GatewayError(`OmniRoute request failed (HTTP ${response.status})`,response.status);}
    if(controller.signal.aborted){cancel();throw new GatewayError('OmniRoute request failed (timeout or cancelled)');}
    const max=5*1024*1024;
    if(Number(response.headers.get('content-length'))>max){cancel();throw new GatewayError('OmniRoute response is too large');}
    const reader=response.body?.getReader();if(!reader)throw new GatewayError('OmniRoute response has no body');
    const cancelReader=()=>{void reader.cancel().catch(()=>{});}; controller.signal.addEventListener('abort',cancelReader,{once:true});
    const chunks:Uint8Array[]=[];let total=0;
    try {for(;;){if(controller.signal.aborted)throw new GatewayError('OmniRoute request failed (timeout or cancelled)');const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max){cancelReader();throw new GatewayError('OmniRoute response is too large');}chunks.push(value);}}
    catch(error){if(error instanceof GatewayError)throw error;throw new GatewayError('OmniRoute response could not be read');}
    finally{controller.signal.removeEventListener('abort',cancelReader);reader.releaseLock();}
    if(controller.signal.aborted)throw new GatewayError('OmniRoute request failed (timeout or cancelled)');
    const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    let payload:unknown;try{payload=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new GatewayError('OmniRoute response is not valid JSON');}
    return {payload,headers:response.headers};
  };
  try{return await Promise.race([work(),deadline,cancellation]);}finally{clearTimeout(timer!);signal?.removeEventListener('abort',abort);}
}
export const asRecord=(value:unknown):Record<string,unknown>|undefined=>value!==null && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:undefined;
/** Strip terminal controls and bound remote labels before display. */
export const safeLabel=(value:unknown,fallback:string):string=>typeof value==='string' && value.trim()?value.replace(/[\x00-\x1f\x7f-\x9f]/g,'').slice(0,120):fallback;

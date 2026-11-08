import {createAssistantMessageEventStream,streamSimple,type AssistantMessageEventStream,type Model,type Api,type Context,type SimpleStreamOptions} from '@oh-my-pi/pi-ai';
import {applyReportedCost} from './cost.ts';
import {buildRequestHeaders,createRequestObserver,type RequestControls,type RequestRecord} from './telemetry.ts';

export interface AdapterSettings extends RequestControls {reportedCost:boolean;inspectRequests:boolean;}
export interface AdapterDependencies {
  getSettings():AdapterSettings;
  getPricingStatus?(modelId:string):string|undefined;
  getSessionId?():string|undefined;
  getSecrets?():string[];
  onRequest?(record:RequestRecord):void;
}
/** Provider-scoped wrapper. The native openai-completions API is never replaced. */
export function createOmniRouteStream(deps:AdapterDependencies) {
  return (model:Model<Api>,context:Context,options?:SimpleStreamOptions):AssistantMessageEventStream=>{
    const settings={...deps.getSettings()};
    const headers=buildRequestHeaders(settings,options?.sessionId??deps.getSessionId?.(),options?.headers);
    // OMP sets this marker when dispatching a registered API. Its outer layer
    // already owns the provider permit and has called beforeDispatch. Do not
    // reacquire that permit (a cap of one would deadlock) or repeat its callback.
    // Direct adapter calls still use the normal native concurrency handling.
    const nativeOptions:SimpleStreamOptions={...options,headers,...(options?.waitForTerminalDrain!==undefined?{
      maxInFlightRequests:{},beforeDispatch:undefined,
    }:{})};
    if(!settings.reportedCost&&!settings.inspectRequests) return streamSimple({...model,api:'openai-completions'},context,nativeOptions);
    const output=createAssistantMessageEventStream();
    const secrets=[...(deps.getSecrets?.()??[]),...(typeof options?.apiKey==='string'?[options.apiKey]:[])];
    const observer=createRequestObserver(model.id,deps.getPricingStatus?.(model.id),Date.now(),secrets);
    let recorded=false;
    const finish=(message:unknown)=>{
      if(recorded||!settings.inspectRequests)return;recorded=true;
      try{deps.onRequest?.(observer.finish(message));}catch{/* Observability must not break inference. */}
    };
    void(async()=>{
      try {
        const inner=streamSimple({...model,api:'openai-completions'},context,{
          ...nativeOptions,
          onResponse:async(response,wireModel,signal)=>{observer.response(response);await options?.onResponse?.(response,wireModel,signal);},
          onSseEvent:(event,wireModel)=>{observer.sse(event.data);options?.onSseEvent?.(event,wireModel);},
        });
        for await(const event of inner) {
          if(event.type==='done'||event.type==='error') {
            const message=event.type==='done'?event.message:event.error;
            if(settings.reportedCost&&observer.reportedCost!==undefined)applyReportedCost(message.usage.cost,observer.reportedCost);
            finish(message);
          }
          output.push(event);
        }
        if(!output.done) {
          const result=await inner.result();
          if(settings.reportedCost&&observer.reportedCost!==undefined)applyReportedCost(result.usage.cost,observer.reportedCost);
          finish(result);output.end(result);
        }
      }catch(error){finish({stopReason:options?.signal?.aborted?'aborted':'error'});output.fail(error);}
    })();
    return output;
  };
}
const noControls={stickySessions:false,bypassCache:false,bypassMemory:false};
/** Backward-compatible opt-in reported-cost entry point. */
export const streamOmniRoute=createOmniRouteStream({getSettings:()=>({...noControls,reportedCost:true,inspectRequests:false})});
/** Native behavior for cached custom-API rows when all adapter features are disabled. */
export const streamNative=createOmniRouteStream({getSettings:()=>({...noControls,reportedCost:false,inspectRequests:false})});

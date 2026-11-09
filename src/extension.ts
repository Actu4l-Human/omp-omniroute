import type { ExtensionAPI, ExtensionContext, ProviderConfig } from '@oh-my-pi/pi-coding-agent';
import type {Model} from '@oh-my-pi/pi-ai';
import { PROVIDER, readConfig, fetchCatalog, mapCatalog, type Catalog, type CatalogSkipReason, type Config } from './catalog.ts';
import {loadOverrides} from './overrides.ts';
import {diffCatalog,type CatalogDiff} from './changes.ts';
import {createUsageProvider,fetchUsageSnapshot} from './usage.ts';
import {runDoctor} from './doctor.ts';
import type {RequestRecord} from './telemetry.ts';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

function sameModelMetadata(current:Model,selected:Model):boolean {
  if(current===selected)return true;
  // OMP rebuilds opaque request-time resolvers on discovery; compare their presence, not closure identity.
  if((current.resolveHeaders===undefined)!==(selected.resolveHeaders===undefined))return false;
  const {resolveHeaders:_currentResolver,...currentData}=current;
  const {resolveHeaders:_selectedResolver,...selectedData}=selected;
  return isDeepStrictEqual(currentData,selectedData);
}

/** Runtime dependencies are injectable for offline verification; no credentials are persisted. */
export async function installOmniRoute(pi: ExtensionAPI, env: Record<string,string|undefined> = process.env, fetchImpl: typeof fetch = fetch, adapter?: NonNullable<ProviderConfig['streamSimple']>): Promise<void> {
  let config: Config;
  try {
    config=readConfig(env);
    if (!env.OMNIROUTE_API_KEY || env.OMNIROUTE_API_KEY === 'OMNIROUTE_API_KEY' || /[\r\n]/.test(env.OMNIROUTE_API_KEY)) throw new Error('Set a valid OMNIROUTE_API_KEY before starting OMP');
  } catch (error) {
    const message=error instanceof Error?error.message:'Invalid OmniRoute configuration';
    pi.on('session_start',(_event,ctx)=>{ctx.ui.notify(`OmniRoute disabled: ${message}`,'warning');});
    if(typeof pi.registerCommand==='function')pi.registerCommand('omniroute-doctor',{description:'Explain invalid OmniRoute configuration',handler:async(_args,ctx)=>{ctx.ui.notify(`OmniRoute configuration error: ${message}`,'error');}});
    return;
  }
  let catalog: Catalog=mapCatalog({data:[]},config);
  let lastSuccess: number|undefined; let lastError: string|undefined;
  let alertBaseline:Catalog|undefined;let lastChanges:{at:string;changes:CatalogDiff}|undefined;
  let lastRequest:RequestRecord|undefined;let sessionId:string=randomUUID();
  const show=(ctx:ExtensionContext,data:unknown,type:'info'|'warning'|'error'='info')=>{
    const message=typeof data==='string'?data:JSON.stringify(data,null,2);
    ctx.ui.notify(env.OMNIROUTE_API_KEY?message.split(env.OMNIROUTE_API_KEY).join('[redacted]'):message,type);
  };
  let pending: Promise<void>|undefined;
  let pendingGeneration=0;let sessionGeneration=0;
  let controlRevision=0;let pendingControlRevision=0;
  let cancelIdleRebind:(()=>void)|undefined;
  let modelUpdate:{id:string;state:'pending'|'missing'|'rejected'|'failed'}|undefined;
  const modelUpdateMessages={
    pending:'Selected-model metadata is waiting for the session to become idle.',
    missing:'The selected OmniRoute model is absent from the latest discovered catalog. It remains selected; choose an available model or check filters and refresh.',
    rejected:'Selected-model metadata was not applied because OMP could not resolve model authentication. Check authentication and run /omniroute-refresh while idle.',
    failed:'Selected-model metadata could not be applied. The catalog was refreshed; retry /omniroute-refresh while idle and check OMP diagnostics if this persists.',
  } as const;
  let timer: ReturnType<ExtensionContext['setInterval']>|undefined;
  let timerContext: ExtensionContext|undefined;
  const registration: ProviderConfig={
    baseUrl:config.baseUrl,apiKey:'OMNIROUTE_API_KEY',authHeader:true,usage:createUsageProvider(config,fetchImpl),
    // Always retain this scoped adapter so older cached custom-API rows remain runnable.
    // Every newly discovered model still has its explicit per-model api.
    api:'omniroute-chat',
    async fetchDynamicModels(key) {
      try {
        // Intentionally do not store the key or put auth on individual catalog rows.
        const overrides=await loadOverrides(config.overridesFile);
        const next=mapCatalog(await fetchCatalog(config,key,fetchImpl),config,overrides);
        catalog=next;lastSuccess=Date.now();lastError=undefined;
        return next.models;
      } catch (error) {
        lastError=error instanceof Error?error.message:'OmniRoute discovery failed';
        // Throw rather than return []: OMP retains its last successful catalog.
        throw error;
      }
    },
  };
  if (adapter) registration.streamSimple=adapter;
  else {
    const {createOmniRouteStream}=await import('./reported-cost.ts');
    registration.streamSimple=createOmniRouteStream({getSettings:()=>config,getPricingStatus:id=>catalog.metadata.get(id)?.pricingStatus,
      getSessionId:()=>sessionId,getSecrets:()=>env.OMNIROUTE_API_KEY?[env.OMNIROUTE_API_KEY]:[],onRequest:record=>{lastRequest=record;}});
  }
  pi.registerProvider(PROVIDER,registration);

  const currentModelUpdate=(ctx:ExtensionContext)=>{
    const selected=ctx.models.current();
    if(selected?.provider!==PROVIDER || selected.id!==modelUpdate?.id)modelUpdate=undefined;
    return modelUpdate;
  };
  const hasWarning=(ctx:ExtensionContext)=>{
    const update=currentModelUpdate(ctx);
    return !!lastError || catalog.diagnostics.overrides.unmatched.length>0 || (!!update && update.state!=='pending');
  };
  const summary=(ctx:ExtensionContext)=>{
    const skipped=Object.entries(catalog.diagnostics.skippedByReason).filter(([,count])=>count>0).map(([reason,count])=>`${reason}: ${count}`).join(', ');
    const fallbacks=Object.entries(catalog.diagnostics.fallbacks).filter(([,counts])=>counts.contextWindow || counts.maxTokens)
      .map(([kind,counts])=>`${kind}: ${counts.contextWindow} context, ${counts.maxTokens} output`).join('; ');
    const unmatched=catalog.diagnostics.overrides.unmatched.length;
    const update=currentModelUpdate(ctx);
    return `${catalog.models.length} model(s), ${catalog.skipped} skipped${skipped?` (${skipped})`:''}. Last success: ${lastSuccess?new Date(lastSuccess).toISOString():'not fetched in this session'}. ${lastError?`Refresh failed: ${lastError}. Retaining last successful catalog.`:'Catalog costs are estimates; unknown/variable costs are not free.'}${fallbacks?` Fallback limits (${fallbacks}). Use /omniroute-model <id> and exact-ID overrides to supply verified limits.`:''}${unmatched?` ${unmatched} override key(s) matched no gateway model. Use /omniroute-doctor for exact IDs and suggestions.`:''}${update?` ${modelUpdateMessages[update.state]}`:''}`;
  };
  function updateStatus(ctx:ExtensionContext):void {
    const update=currentModelUpdate(ctx);
    const unmatched=catalog.diagnostics.overrides.unmatched.length;
    if(ctx.hasUI)ctx.ui.setStatus('omniroute',lastError?'OmniRoute: catalog stale':`OmniRoute: ${catalog.models.length} models${unmatched?`; ${unmatched} unmatched overrides`:''}${update?`; selected model ${update.state}`:''}`);
  }
  function setModelUpdate(ctx:ExtensionContext,id:string,state:NonNullable<typeof modelUpdate>['state']):void {
    const previous=currentModelUpdate(ctx);
    modelUpdate={id,state};
    updateStatus(ctx);
    if(state!=='pending' && (previous?.id!==id || previous.state!==state))show(ctx,modelUpdateMessages[state],'warning');
  }
  function clearIdleRebind():void {
    cancelIdleRebind?.();
    cancelIdleRebind=undefined;
  }
  async function rebindSelected(ctx:ExtensionContext,id:string,generation:number):Promise<void> {
    if(generation!==sessionGeneration || lastError)return;
    // Command contexts snapshot ctx.model; the query facade reads the live selection.
    const selected=ctx.models.current();
    if(selected?.provider!==PROVIDER || selected.id!==id){updateStatus(ctx);return;}
    const current=ctx.modelRegistry.find(PROVIDER,id);
    if(!catalog.metadata.has(id) || !current){setModelUpdate(ctx,id,'missing');return;}
    if(sameModelMetadata(current,selected)){modelUpdate=undefined;updateStatus(ctx);return;}
    if(!ctx.isIdle()) {
      setModelUpdate(ctx,id,'pending');
      // agent_end can precede the host becoming idle. A managed timer also covers
      // discovery completing during that unwind, without another catalog request.
      const timer=ctx.setTimeout(()=>{
        cancelIdleRebind=undefined;
        return rebindSelected(ctx,id,generation);
      },100);
      cancelIdleRebind=()=>ctx.clearTimer(timer);
      return;
    }
    let state:'rejected'|'failed'|undefined;
    try {if(!await pi.setModel(current))state='rejected';}
    catch {state='failed';}
    if(generation!==sessionGeneration)return;
    const latest=ctx.models.current();
    if(latest?.provider!==PROVIDER || latest.id!==id){updateStatus(ctx);return;}
    if(state)setModelUpdate(ctx,id,state);
    else {modelUpdate=undefined;updateStatus(ctx);}
  }
  async function refresh(ctx: ExtensionContext): Promise<void> {
    const generation=sessionGeneration;
    if (pending) {
      const represented=pendingGeneration===generation && pendingControlRevision===controlRevision;
      await pending;
      if(!represented && generation===sessionGeneration)await refresh(ctx);
      return;
    }
    pendingGeneration=generation;
    pendingControlRevision=controlRevision;
    pending=(async()=>{
      try {
        if (typeof ctx.modelRegistry.refreshDiscoverableProviders !== 'function') throw new Error('This extension requires OMP 18.18.1 or later');
        await ctx.modelRegistry.refreshDiscoverableProviders([PROVIDER],'online');
        if(generation!==sessionGeneration)return;
        clearIdleRebind();
        const selected=ctx.models.current();
        if(!lastError && selected?.provider===PROVIDER)await rebindSelected(ctx,selected.id,generation);
      } catch(error) {lastError=error instanceof Error?error.message:'OmniRoute refresh failed';}
      if(generation!==sessionGeneration)return;
      if(lastError){clearIdleRebind();modelUpdate=undefined;}
      if(!lastError) {
        const changes=diffCatalog(alertBaseline,catalog);alertBaseline=catalog;
        if(changes) {
          lastChanges={at:new Date().toISOString(),changes};
          if(config.catalogAlerts)show(ctx,`OmniRoute catalog changed: ${changes.added.length} added, ${changes.removed.length} removed, ${changes.changed.length} changed. Use /omniroute-changes for details.`);
        }
      }
      updateStatus(ctx);
    })();
    try {await pending;} finally {pending=undefined;}
  }
  pi.on('session_start',async(_event,ctx)=>{
    sessionGeneration++;clearIdleRebind();modelUpdate=undefined;
    if (timer!==undefined && timerContext) timerContext.clearTimer(timer);
    timerContext=ctx;
    sessionId=ctx.sessionManager?.getSessionId?.()??randomUUID();
    timer=ctx.setInterval(()=>refresh(ctx),config.refreshMs);
    // Force an initial scoped refresh: OMP's default persisted TTL is 24 hours,
    // which is too stale for a frequently changed gateway roster.
    await refresh(ctx);
    if(hasWarning(ctx))show(ctx,summary(ctx),'warning');
  });
  pi.on('session_shutdown',()=>{
    sessionGeneration++;clearIdleRebind();modelUpdate=undefined;
    if (timer!==undefined && timerContext) timerContext.clearTimer(timer);
    timer=undefined;timerContext=undefined;
  });
  pi.registerCommand('omniroute-refresh',{description:'Refresh only the OmniRoute model catalog now',handler:async(_args,ctx)=>{
    await refresh(ctx);show(ctx,summary(ctx),hasWarning(ctx)?'warning':'info');
  }});
  pi.registerCommand('omniroute-status',{description:'Show OmniRoute discovery health and pricing caveats',handler:async(_args,ctx)=>{
    updateStatus(ctx);show(ctx,summary(ctx),hasWarning(ctx)?'warning':'info');
  }});
  pi.registerCommand('omniroute-usage',{description:'Read key-scoped gateway usage and quota data',handler:async(_args,ctx)=>{
    try{show(ctx,await fetchUsageSnapshot(config,env.OMNIROUTE_API_KEY,fetchImpl));}catch(error){show(ctx,error instanceof Error?error.message:'Usage lookup failed','warning');}
  }});
  pi.registerCommand('omniroute-doctor',{description:'Validate local overrides and read-only authenticated catalog, version and health checks',handler:async(_args,ctx)=>{
    const report=await runDoctor(config,env.OMNIROUTE_API_KEY,fetchImpl);
    show(ctx,report,report.checks.some(c=>c.status==='error')?'error':report.checks.some(c=>c.status==='warning')?'warning':'info');
  }});
  pi.registerCommand('omniroute-last',{description:'Show the latest inspected chat request, without prompts or secrets',handler:async(_args,ctx)=>{
    show(ctx,lastRequest??'No inspected chat request in this process yet. Inspection is enabled by default; use /omniroute-controls inspect on if disabled.');
  }});
  pi.registerCommand('omniroute-changes',{description:'Show the latest meaningful catalog change',handler:async(_args,ctx)=>{
    show(ctx,lastChanges??'No catalog changes observed after the initial successful discovery.');
  }});
  const controls={'sticky':'stickySessions','cache-bypass':'bypassCache','memory-bypass':'bypassMemory','inspect':'inspectRequests','alerts':'catalogAlerts'} as const;
  const skipDescriptions:Record<CatalogSkipReason,string>={
    invalid:'Invalid catalog row or model ID',duplicate:'Duplicate model ID',
    include:'Does not match OMNIROUTE_INCLUDE',exclude:'Matches OMNIROUTE_EXCLUDE',
    'unsupported-type':'Model type has no supported OMP transport','tools-required':'Tool calling is explicitly disabled while OMNIROUTE_REQUIRE_TOOLS is true',
    'unsupported-input':'No supported text or image input modality',
  };
  pi.registerCommand('omniroute-controls',{description:'Show or change session-local inspection, sticky and bypass controls',
    getArgumentCompletions:prefix=>{
      const choices=Object.keys(controls).flatMap(control=>[`${control} on`,`${control} off`]);
      const matches=choices.filter(value=>value.startsWith(prefix.trimStart())).map(value=>({value,label:value}));
      return matches.length?matches:null;
    },handler:async(args,ctx)=>{
    const parts=args.trim().split(/\s+/).filter(Boolean);
    if(parts.length) {
      if(parts.length!==2 || !Object.hasOwn(controls,parts[0]) || !['on','off'].includes(parts[1])) {show(ctx,'Usage: /omniroute-controls [sticky|cache-bypass|memory-bypass|inspect|alerts] [on|off]','warning');return;}
      if(ctx.isIdle && !ctx.isIdle()){show(ctx,'Change request controls when the current turn is idle.','warning');return;}
      const field=controls[parts[0] as keyof typeof controls];const enabled=parts[1]==='on';
      if(field!=='catalogAlerts' && config[field]!==enabled)controlRevision++;
      config[field]=enabled;
      if(field!=='catalogAlerts')await refresh(ctx);
    }
    show(ctx,{stickySessions:config.stickySessions,bypassCache:config.bypassCache,bypassMemory:config.bypassMemory,inspectRequests:config.inspectRequests,catalogAlerts:config.catalogAlerts,scope:'Chat requests in this OMP process only; environment defaults return on reload.',...(lastError?{warning:'Discovery failed; native cached models may not use new controls until a successful refresh.'}:{})});
  }});
  pi.registerCommand('omniroute-model',{description:'Inspect accepted or skipped metadata: /omniroute-model <model id or provider/id>',
    getArgumentCompletions:prefix=>{
      const query=prefix.trimStart();
      const ids=new Set([...catalog.metadata.keys(),...catalog.rejections.keys()]);
      const matches=[...ids].flatMap(id=>{
        const value=id.startsWith(query)?id:`${PROVIDER}/${id}`;
        if(value!==id && ids.has(value))return [];
        return value.startsWith(query)?[{value,label:value,description:catalog.metadata.has(id)?'Accepted model':`Skipped: ${catalog.rejections.get(id)!.map(reason=>skipDescriptions[reason]).join('; ')}`}]:[];
      });
      return matches.length?matches:null;
    },handler:async(args,ctx)=>{
      const input=args.trim();
      // Exact gateway IDs win when an ID itself begins with "omniroute/".
      const id=catalog.metadata.has(input) || catalog.rejections.has(input)?input:input.startsWith(`${PROVIDER}/`)?input.slice(PROVIDER.length+1):input;
      const details=catalog.metadata.get(id);const reasons=catalog.rejections.get(id);
      if(details || reasons)show(ctx,{id,accepted:!!details,...details,...(reasons?{rejections:reasons.map(reason=>({reason,message:skipDescriptions[reason]}))}:{}),
        ...(details?.defaultsUsed.length?{guidance:'Set verified context_length/max_output_tokens in OMNIROUTE_OVERRIDES_FILE under this exact gateway ID, then /omniroute-refresh.'}:{})},details?'info':'warning');
      else show(ctx,'No metadata for that ID in the last successful discovery. Use /omniroute-refresh, then pass the exact gateway model ID or omniroute/<gateway ID>.','warning');
    }});
}
export default function omniroute(pi: ExtensionAPI): Promise<void> {return installOmniRoute(pi);}

import type { ExtensionAPI, ExtensionContext, ProviderConfig } from '@oh-my-pi/pi-coding-agent';
import { PROVIDER, readConfig, fetchCatalog, mapCatalog, type Catalog, type Config } from './catalog.ts';
import {loadOverrides} from './overrides.ts';
import {diffCatalog,type CatalogDiff} from './changes.ts';
import {createUsageProvider,fetchUsageSnapshot} from './usage.ts';
import {runDoctor} from './doctor.ts';
import type {RequestRecord} from './telemetry.ts';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

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
  let catalog: Catalog={models:[],metadata:new Map(),skipped:0};
  let lastSuccess: number|undefined; let lastError: string|undefined;
  let alertBaseline:Catalog|undefined;let lastChanges:{at:string;changes:CatalogDiff}|undefined;
  let lastRequest:RequestRecord|undefined;let sessionId:string=randomUUID();
  const show=(ctx:ExtensionContext,data:unknown,type:'info'|'warning'|'error'='info')=>{
    const message=typeof data==='string'?data:JSON.stringify(data,null,2);
    ctx.ui.notify(env.OMNIROUTE_API_KEY?message.split(env.OMNIROUTE_API_KEY).join('[redacted]'):message,type);
  };
  let pending: Promise<void>|undefined;
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

  const summary=()=>`${catalog.models.length} model(s), ${catalog.skipped} skipped. Last success: ${lastSuccess?new Date(lastSuccess).toISOString():'not fetched in this session'}. ${lastError?`Refresh failed: ${lastError}. Retaining last successful catalog.`:'Catalog costs are estimates; unknown/variable costs are not free.'}`;
  async function refresh(ctx: ExtensionContext): Promise<void> {
    if (pending) return pending;
    pending=(async()=>{
      try {
        if (typeof ctx.modelRegistry.refreshDiscoverableProviders !== 'function') throw new Error('This extension requires OMP 18.18.1 or later');
        await ctx.modelRegistry.refreshDiscoverableProviders([PROVIDER],'online');
        // OMP can select a persisted model before session_start. Rebind the same
        // ID after successful discovery so updated API/capabilities/prices apply.
        // Never change the selection in the middle of a streamed turn.
        if (!lastError && ctx.model?.provider===PROVIDER && ctx.isIdle()) {
          const current=ctx.modelRegistry.find(PROVIDER,ctx.model.id);
          if (current && !isDeepStrictEqual(current,ctx.model)) await pi.setModel(current);
        }
      } catch(error) {lastError=error instanceof Error?error.message:'OmniRoute refresh failed';}
      if(!lastError) {
        const changes=diffCatalog(alertBaseline,catalog);alertBaseline=catalog;
        if(changes) {
          lastChanges={at:new Date().toISOString(),changes};
          if(config.catalogAlerts)show(ctx,`OmniRoute catalog changed: ${changes.added.length} added, ${changes.removed.length} removed, ${changes.changed.length} changed. Use /omniroute-changes for details.`);
        }
      }
      if (ctx.hasUI) ctx.ui.setStatus('omniroute',lastError?'OmniRoute: catalog stale':`OmniRoute: ${catalog.models.length} models`);
    })();
    try {await pending;} finally {pending=undefined;}
  }
  pi.on('session_start',async(_event,ctx)=>{
    if (timer!==undefined && timerContext) timerContext.clearTimer(timer);
    timerContext=ctx;
    sessionId=ctx.sessionManager?.getSessionId?.()??randomUUID();
    timer=ctx.setInterval(()=>refresh(ctx),config.refreshMs);
    // Force an initial scoped refresh: OMP's default persisted TTL is 24 hours,
    // which is too stale for a frequently changed gateway roster.
    await refresh(ctx);
    if (lastError) ctx.ui.notify(summary(),'warning');
  });
  pi.on('session_shutdown',()=>{
    if (timer!==undefined && timerContext) timerContext.clearTimer(timer);
    timer=undefined;timerContext=undefined;
  });
  pi.registerCommand('omniroute-refresh',{description:'Refresh only the OmniRoute model catalog now',handler:async(_args,ctx)=>{
    await refresh(ctx);ctx.ui.notify(summary(),lastError?'warning':'info');
  }});
  pi.registerCommand('omniroute-status',{description:'Show OmniRoute discovery health and pricing caveats',handler:async(_args,ctx)=>{
    ctx.ui.notify(summary(),lastError?'warning':'info');
  }});
  pi.registerCommand('omniroute-usage',{description:'Read key-scoped gateway usage and quota data',handler:async(_args,ctx)=>{
    try{show(ctx,await fetchUsageSnapshot(config,env.OMNIROUTE_API_KEY,fetchImpl));}catch(error){show(ctx,error instanceof Error?error.message:'Usage lookup failed','warning');}
  }});
  pi.registerCommand('omniroute-doctor',{description:'Read-only authenticated catalog, version and health checks',handler:async(_args,ctx)=>{
    const report=await runDoctor(config,env.OMNIROUTE_API_KEY,fetchImpl);
    show(ctx,report,report.checks.some(c=>c.status==='error')?'error':report.checks.some(c=>c.status==='warning')?'warning':'info');
  }});
  pi.registerCommand('omniroute-last',{description:'Show the latest inspected chat request, without prompts or secrets',handler:async(_args,ctx)=>{
    show(ctx,lastRequest??'No inspected chat request in this process yet. Inspection is enabled by default; use /omniroute-controls inspect on if disabled.');
  }});
  pi.registerCommand('omniroute-changes',{description:'Show the latest meaningful catalog change',handler:async(_args,ctx)=>{
    show(ctx,lastChanges??'No catalog changes observed after the initial successful discovery.');
  }});
  pi.registerCommand('omniroute-controls',{description:'Show or change session-local inspection, sticky and bypass controls',handler:async(args,ctx)=>{
    const controls={'sticky':'stickySessions','cache-bypass':'bypassCache','memory-bypass':'bypassMemory','inspect':'inspectRequests','alerts':'catalogAlerts'} as const;
    const parts=args.trim().split(/\s+/).filter(Boolean);
    if(parts.length) {
      if(parts.length!==2 || !Object.hasOwn(controls,parts[0]) || !['on','off'].includes(parts[1])) {show(ctx,'Usage: /omniroute-controls [sticky|cache-bypass|memory-bypass|inspect|alerts] [on|off]','warning');return;}
      if(ctx.isIdle && !ctx.isIdle()){show(ctx,'Change request controls when the current turn is idle.','warning');return;}
      const field=controls[parts[0] as keyof typeof controls];config[field]=parts[1]==='on';
      if(field!=='catalogAlerts')await refresh(ctx);
    }
    show(ctx,{stickySessions:config.stickySessions,bypassCache:config.bypassCache,bypassMemory:config.bypassMemory,inspectRequests:config.inspectRequests,catalogAlerts:config.catalogAlerts,scope:'Chat requests in this OMP process only; environment defaults return on reload.',...(lastError?{warning:'Discovery failed; native cached models may not use new controls until a successful refresh.'}:{})});
  }});
  pi.registerCommand('omniroute-model',{description:'Inspect retained OmniRoute metadata: /omniroute-model <exact model id>',handler:async(args,ctx)=>{
    const id=args.trim();const details=catalog.metadata.get(id);
    ctx.ui.notify(details?JSON.stringify({id,...details},null,2):'No metadata for that ID in the last successful discovery. Use /omniroute-refresh, then pass the exact gateway model ID.',details?'info':'warning');
  }});
}
export default function omniroute(pi: ExtensionAPI): Promise<void> {return installOmniRoute(pi);}

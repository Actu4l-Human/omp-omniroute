import type { Catalog, OmniRouteModel, ModelMetadata } from './catalog.ts';
export type ChangeCategory='rates'|'capabilities'|'limits'|'transport';
export interface CatalogModelName {id:string;name:string}
export interface CatalogDiff {
  added:CatalogModelName[];
  removed:CatalogModelName[];
  changed:(CatalogModelName & {categories:ChangeCategory[]})[];
}
const sorted=(values:readonly string[]|undefined)=>[...(values??[])].sort();
function signature(model:OmniRouteModel,meta:ModelMetadata|undefined):Record<ChangeCategory,unknown> {
  return {
    rates:[model.cost?.input,model.cost?.output,model.cost?.cacheRead,model.cost?.cacheWrite,meta?.pricingStatus,sorted(meta?.missingPriceFields)],
    capabilities:[model.reasoning,model.supportsTools,meta?.tools,sorted(model.input),model.thinking?.mode,sorted(model.thinking?.efforts),model.compat && 'supportsReasoningEffort' in model.compat ? model.compat.supportsReasoningEffort : undefined],
    limits:[model.contextWindow,model.maxTokens],
    transport:[model.kind,model.api],
  };
}
const identity=(model:OmniRouteModel):CatalogModelName=>({id:model.id,name:model.name??model.id});
/** undefined means initial baseline or no meaningful change; raw metadata is deliberately ignored. */
export function diffCatalog(previous:Catalog|undefined,next:Catalog):CatalogDiff|undefined {
  if(!previous) return undefined;
  const before=new Map(previous.models.map(m=>[m.id,m]));
  const after=new Map(next.models.map(m=>[m.id,m]));
  const diff:CatalogDiff={added:[],removed:[],changed:[]};
  for(const model of next.models) {
    const old=before.get(model.id);
    if(!old) {diff.added.push(identity(model));continue;}
    const a=signature(old,previous.metadata.get(model.id)),b=signature(model,next.metadata.get(model.id));
    const categories=(Object.keys(a) as ChangeCategory[]).filter(key=>JSON.stringify(a[key])!==JSON.stringify(b[key]));
    if(categories.length) diff.changed.push({...identity(model),categories});
  }
  for(const model of previous.models) if(!after.has(model.id)) diff.removed.push(identity(model));
  return diff.added.length||diff.removed.length||diff.changed.length?diff:undefined;
}

import type { ProviderModelConfig } from '@oh-my-pi/pi-coding-agent';
import type { Effort } from '@oh-my-pi/pi-ai';
import {applyOverridesToRow,type ModelOverrides,type ModelOverride} from './overrides.ts';

export const PROVIDER = 'omniroute';
export interface Config {
  baseUrl: string;
  refreshMs: number;
  timeoutMs: number;
  include: string[];
  exclude: string[];
  variablePrice: string[];
  requireTools: boolean;
  reportedCost: boolean;
  inspectRequests: boolean;
  catalogAlerts: boolean;
  stickySessions: boolean;
  bypassCache: boolean;
  bypassMemory: boolean;
  overridesFile?: string;
}
export interface ModelMetadata {
  raw: Record<string, unknown>;
  appliedOverrides?: ModelOverride;
  tools: boolean | null;
  pricingStatus: 'estimated' | 'unknown' | 'variable';
  missingPriceFields: string[];
  defaultsUsed: string[];
}
// The current OMP runtime accepts supportsTools; its public extension type omits it.
export type OmniRouteModel = ProviderModelConfig & {supportsTools?: boolean};
export type CatalogSkipReason = 'invalid' | 'duplicate' | 'include' | 'exclude' | 'unsupported-type' | 'tools-required' | 'unsupported-input';
export interface Catalog {
  models: OmniRouteModel[];
  metadata: Map<string, ModelMetadata>;
  skipped: number;
  rejections: Map<string, CatalogSkipReason[]>;
  diagnostics: {
    skippedByReason: Record<CatalogSkipReason, number>;
    fallbacks: Record<'chat' | 'embedding' | 'image', {contextWindow: number; maxTokens: number}>;
  };
}
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const list = (s?: string) => (s ?? '').split(',').map(x => x.trim()).filter(Boolean);
function booleanSetting(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}
function interval(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
}
export function readConfig(env: Record<string, string | undefined>): Config {
  if (!env.OMNIROUTE_BASE_URL) throw new Error('Set OMNIROUTE_BASE_URL to your OmniRoute public API root');
  let url: URL;
  try { url = new URL(env.OMNIROUTE_BASE_URL); } catch { throw new Error('OMNIROUTE_BASE_URL must be a valid URL'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('OMNIROUTE_BASE_URL must not contain credentials, a query, or a fragment');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const allowHttp = booleanSetting('OMNIROUTE_ALLOW_INSECURE_HTTP', env.OMNIROUTE_ALLOW_INSECURE_HTTP, false);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || allowHttp))) throw new Error('Use HTTPS, or explicitly allow insecure HTTP for your trusted network');
  let path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/v1')) path += '/v1';
  url.pathname = path;
  return {
    baseUrl: url.toString().replace(/\/$/, ''),
    refreshMs: interval('OMNIROUTE_REFRESH_MS', env.OMNIROUTE_REFRESH_MS, 300000, 30000, 86400000),
    timeoutMs: interval('OMNIROUTE_TIMEOUT_MS', env.OMNIROUTE_TIMEOUT_MS, 12000, 100, 14000),
    include: list(env.OMNIROUTE_INCLUDE), exclude: list(env.OMNIROUTE_EXCLUDE),
    variablePrice: ['auto/*', 'combo/*', ...list(env.OMNIROUTE_VARIABLE_PRICE)],
    requireTools: booleanSetting('OMNIROUTE_REQUIRE_TOOLS', env.OMNIROUTE_REQUIRE_TOOLS, true),
    reportedCost: booleanSetting('OMNIROUTE_REPORTED_COST', env.OMNIROUTE_REPORTED_COST, false),
    inspectRequests: booleanSetting('OMNIROUTE_INSPECT_REQUESTS', env.OMNIROUTE_INSPECT_REQUESTS, true),
    catalogAlerts: booleanSetting('OMNIROUTE_CATALOG_ALERTS', env.OMNIROUTE_CATALOG_ALERTS, true),
    stickySessions: booleanSetting('OMNIROUTE_STICKY_SESSIONS', env.OMNIROUTE_STICKY_SESSIONS, false),
    bypassCache: booleanSetting('OMNIROUTE_BYPASS_CACHE', env.OMNIROUTE_BYPASS_CACHE, false),
    bypassMemory: booleanSetting('OMNIROUTE_BYPASS_MEMORY', env.OMNIROUTE_BYPASS_MEMORY, false),
    ...(env.OMNIROUTE_OVERRIDES_FILE?{overridesFile:env.OMNIROUTE_OVERRIDES_FILE}:{}),
  };
}
export function usesChatAdapter(config:Config):boolean {
  return config.reportedCost || config.inspectRequests || config.stickySessions || config.bypassCache || config.bypassMemory;
}
function compileGlob(glob: string): RegExp {
  const pattern = glob.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${pattern}$`);
}
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function nonnegative(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value))) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function price(pricing: Record<string, unknown>, perMillion: string, perToken: string): number | undefined {
  const direct = nonnegative(pricing[perMillion]);
  if (direct !== undefined) return direct;
  const fallback = nonnegative(pricing[perToken]);
  const converted = fallback === undefined ? undefined : fallback * 1e6;
  return converted !== undefined && Number.isFinite(converted) ? converted : undefined;
}
export function mapCatalog(payload: unknown, config: Config, overrides:ModelOverrides = {}): Catalog {
  const envelope = record(payload);
  if (!envelope || !Array.isArray(envelope.data)) throw new Error('OmniRoute models response must contain a data array');
  const include=config.include.map(compileGlob), exclude=config.exclude.map(compileGlob), variablePrice=config.variablePrice.map(compileGlob);
  const models: OmniRouteModel[] = [];
  const metadata = new Map<string, ModelMetadata>();
  const rejections = new Map<string, CatalogSkipReason[]>();
  const diagnostics: Catalog['diagnostics'] = {
    skippedByReason: {invalid:0,duplicate:0,include:0,exclude:0,'unsupported-type':0,'tools-required':0,'unsupported-input':0},
    fallbacks: {
      chat: {contextWindow:0,maxTokens:0},
      embedding: {contextWindow:0,maxTokens:0},
      image: {contextWindow:0,maxTokens:0},
    },
  };
  let skipped = 0;
  const reject = (reason: CatalogSkipReason, id?: string) => {
    skipped++;
    diagnostics.skippedByReason[reason]++;
    if (id !== undefined) {
      const reasons = rejections.get(id);
      if (!reasons) rejections.set(id, [reason]);
      else if (!reasons.includes(reason)) reasons.push(reason);
    }
  };
  for (const candidate of envelope.data) {
    const original = record(candidate);
    const id = original?.id;
    const {effective:row,applied}=original?applyOverridesToRow(original,overrides):{effective:undefined,applied:undefined};
    if (!row || typeof id !== 'string' || !id || id.length > 512 || /[\x00-\x1f\x7f]/.test(id)) { reject('invalid'); continue; }
    if (metadata.has(id)) { reject('duplicate', id); continue; }
    if (include.length > 0 && !include.some(pattern => pattern.test(id))) { reject('include', id); continue; }
    if (exclude.some(pattern => pattern.test(id))) { reject('exclude', id); continue; }
    const type = typeof row.type === 'string' ? row.type.toLowerCase() : 'chat';
    const kind = type === 'embedding' ? 'embedding' : type === 'image' ? 'image' : type === 'chat' || type === 'text' || type === 'completion' ? 'chat' : undefined;
    if (!kind) { reject('unsupported-type', id); continue; }
    const caps = record(row.capabilities) ?? {};
    const tools = typeof caps.tool_calling === 'boolean' ? caps.tool_calling : null;
    if (kind === 'chat' && config.requireTools && tools === false) { reject('tools-required', id); continue; }
    const tiers = Array.isArray(caps.effort_tiers) ? caps.effort_tiers : Array.isArray(row.effort_tiers) ? row.effort_tiers : [];
    const efforts = EFFORTS.filter(e => tiers.includes(e)) as Effort[];
    const overrideCaps=applied?.capabilities;
    const explicitReasoning = [overrideCaps?.reasoning,overrideCaps?.thinking,overrideCaps?.supportsThinking,caps.reasoning, caps.thinking, caps.supportsThinking].find(x => typeof x === 'boolean');
    const reasoning = kind === 'chat' && (explicitReasoning === true || (explicitReasoning === undefined && efforts.length > 0));
    const modalities = Array.isArray(row.input_modalities) ? row.input_modalities : undefined;
    const input: ('text'|'image')[] = modalities ? ['text','image'].filter(x => modalities.includes(x)) as ('text'|'image')[] : caps.vision === true ? ['text','image'] : ['text'];
    if (!applied?.input_modalities && overrideCaps?.vision!==undefined) {
      if (overrideCaps.vision && !input.includes('image'))input.push('image');
      if (!overrideCaps.vision && input.includes('image'))input.splice(input.indexOf('image'),1);
    }
    // An audio-only input model cannot be driven by these OMP runners.
    if (input.length === 0) { reject('unsupported-input', id); continue; }
    const pricing = record(row.pricing) ?? {};
    const rates = {
      input: price(pricing, 'input', 'prompt'), output: price(pricing, 'output', 'completion'),
      cacheRead: price(pricing, 'cached', 'input_cache_read'), cacheWrite: price(pricing, 'cache_creation', 'input_cache_write'),
    };
    const missingPriceFields = Object.entries(rates).filter(([,value]) => value === undefined).map(([key]) => key);
    const variable = row.owned_by === 'combo' || row.type === 'combo' || pricing.variable === true || pricing.type === 'variable' || variablePrice.some(pattern => pattern.test(id));
    const pricingStatus = applied?.pricingStatus==='unknown' ? 'unknown' : applied?.pricingStatus==='variable' ? 'variable' :
      variable && applied?.pricingStatus!=='estimated' ? 'variable' : rates.input===undefined || rates.output===undefined ? 'unknown' : 'estimated';
    const unpriced=pricingStatus!=='estimated';
    const defaultsUsed: string[] = [];
    const contextWindow = positiveInt(row.context_length) ?? (defaultsUsed.push('context_length=8192'), diagnostics.fallbacks[kind].contextWindow++, 8192);
    const maxTokens = Math.min(positiveInt(row.max_output_tokens) ?? (defaultsUsed.push('max_output_tokens=2048'), diagnostics.fallbacks[kind].maxTokens++, 2048), contextWindow);
    const rawName = typeof row.name === 'string' && row.name.trim() ? row.name.replace(/[\x00-\x1f\x7f]/g,'').slice(0,240) : id;
    const name = pricingStatus === 'estimated' ? rawName : `${rawName} [price ${pricingStatus}]`;
    models.push({
      id, name, api: kind === 'embedding' ? 'openai-embeddings' : kind === 'image' ? 'openai-images' : usesChatAdapter(config) ? 'omniroute-chat' : 'openai-completions', kind,
      reasoning,
      ...(kind === 'chat' && tools !== null ? {supportsTools:tools} : {}),
      ...(reasoning && efforts.length > 0 ? {thinking: {mode:'effort' as const, efforts}} : {}),
      input, contextWindow, maxTokens,
      // OMP requires numeric costs. Zero for unknown fields is a schema placeholder,
      // NEVER an assertion that the route is free. Variable routes are all placeholders.
      cost: { input: unpriced ? 0 : rates.input ?? 0, output: unpriced ? 0 : rates.output ?? 0,
        cacheRead: unpriced ? 0 : rates.cacheRead ?? 0, cacheWrite: unpriced ? 0 : rates.cacheWrite ?? 0 },
      ...(kind === 'chat' ? {compat: {supportsReasoningEffort: reasoning && efforts.length > 0,
        trustExplicitThinkingOnly:true, supportsUsageInStreaming:true}} : {}),
    });
    metadata.set(id, {raw:structuredClone(original!),...(applied?{appliedOverrides:applied}:{}),tools,pricingStatus,missingPriceFields,defaultsUsed});
  }
  return {models, metadata, skipped, rejections, diagnostics};
}
export async function fetchCatalog(config: Config, key?: string, fetchImpl: typeof fetch = fetch): Promise<{data: unknown[]}> {
  if (!key || key === 'OMNIROUTE_API_KEY' || /[\r\n]/.test(key)) throw new Error('Set a valid OMNIROUTE_API_KEY before starting OMP');
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/models`, { method:'GET', redirect:'error',
      headers:{Authorization:`Bearer ${key}`, Accept:'application/json'}, signal:AbortSignal.timeout(config.timeoutMs) });
  } catch { throw new Error('OmniRoute models request failed (network, redirect, or timeout)'); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`OmniRoute models request failed (HTTP ${response.status})`); }
  if (Number(response.headers.get('content-length')) > MAX_BODY_BYTES) { await response.body?.cancel(); throw new Error('OmniRoute models response is too large'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('OmniRoute models response has no body');
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('OmniRoute models response is too large'); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'OmniRoute models response is too large') throw error;
    throw new Error('OmniRoute models response could not be read (network or timeout)');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk,offset); offset+=chunk.length;}
  let payload: unknown;
  try {payload=JSON.parse(new TextDecoder().decode(bytes));} catch {throw new Error('OmniRoute models response is not valid JSON');}
  const envelope=record(payload);
  if (!envelope || !Array.isArray(envelope.data)) throw new Error('OmniRoute models response must contain a data array');
  return envelope as {data:unknown[]};
}

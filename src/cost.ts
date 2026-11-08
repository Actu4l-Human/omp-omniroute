/** Read only the gateway's explicit USD total. Never synthesize a reported bill. */
export function readReportedCost(payload: unknown): number|undefined {
  if (!payload || typeof payload!=='object' || Array.isArray(payload)) return undefined;
  const usage=(payload as Record<string,unknown>).usage;
  if (!usage || typeof usage!=='object' || Array.isArray(usage)) return undefined;
  const cost=(usage as Record<string,unknown>).cost;
  return typeof cost==='number' && Number.isFinite(cost) && cost>=0 ? cost : undefined;
}
export function applyReportedCost(cost:{input:number;output:number;cacheRead:number;cacheWrite:number;total:number},reported:number):void {
  if (!Number.isFinite(reported) || reported<0) return;
  const estimate=cost.input+cost.output+cost.cacheRead+cost.cacheWrite;
  if (Number.isFinite(estimate) && estimate>0) {
    cost.input=(cost.input/estimate)*reported;cost.output=(cost.output/estimate)*reported;
    cost.cacheRead=(cost.cacheRead/estimate)*reported;cost.cacheWrite=(cost.cacheWrite/estimate)*reported;
  } else {
    // OMP also has component-only aggregators. This is an accounting allocation,
    // not a claim that the entire request was billed as input tokens.
    cost.input=reported;cost.output=0;cost.cacheRead=0;cost.cacheWrite=0;
  }
  cost.total=reported;
}

/** Read only the gateway's explicit USD total. Never synthesize a reported bill. */
export function readReportedCost(data: string): number|undefined {
  try {
    const cost=JSON.parse(data)?.usage?.cost;
    return typeof cost==='number' && Number.isFinite(cost) && cost>=0 ? cost : undefined;
  } catch {return undefined;}
}
export function applyReportedCost(cost:{input:number;output:number;cacheRead:number;cacheWrite:number;total:number},reported:number):void {
  if (!Number.isFinite(reported) || reported<0) return;
  const estimate=cost.input+cost.output+cost.cacheRead+cost.cacheWrite;
  if (Number.isFinite(estimate) && estimate>0) {
    const scale=reported/estimate;
    cost.input*=scale;cost.output*=scale;cost.cacheRead*=scale;cost.cacheWrite*=scale;
  } else {
    // OMP also has component-only aggregators. This is an accounting allocation,
    // not a claim that the entire request was billed as input tokens.
    cost.input=reported;cost.output=0;cost.cacheRead=0;cost.cacheWrite=0;
  }
  cost.total=reported;
}

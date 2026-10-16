import { useEffect, useRef, useState } from 'react';
import { E2B_RESOURCE_PRICING, estimateResourceCost, resourcePricingIsStale } from '../shared/resource-visibility';
import { api, type Session } from './api';
import { emptyResourceRead, resourceObservationStale, resourceReadAllowed, resourceReadScope, ResourceVisibilityClient, type ResourceReadState } from './resource-visibility';
import './resource-visibility.css';

const usd = (value: number) => `USD ${value.toFixed(4)}`;
const mib = (value: number | null | undefined) => value == null ? 'Unknown' : `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB`;
const bytes = (value: number | null | undefined) => value == null ? 'Pending' : `${(value / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB`;
const date = (value: string) => new Date(value).toLocaleString();
function PricingSource({ now }: { now: number }) {
  return <p className="resource-footnote"><a href={E2B_RESOURCE_PRICING.source} target="_blank" rel="noreferrer">E2B public compute rates</a> · verified {E2B_RESOURCE_PRICING.checkedAt}{resourcePricingIsStale(now) ? ' · Pricing reference is stale; verify current rates.' : ''}. CPU USD 0.000014/vCPU/s + RAM USD 0.0000045/GiB/s.</p>;
}
function EstimateLimits() {
  return <p className="resource-footnote">Compute estimate only. Excludes plan fees, tax, credits, discounts, model charges, template builds and other provider charges. <a href="https://console.e2b.dev" target="_blank" rel="noreferrer">Check actual billing in E2B</a>.</p>;
}
export function LaunchResourceCard({ previewMode, now, extensionsAvailable = false }: { previewMode: boolean; now: number; extensionsAvailable?: boolean }) {
  const hourly = (2 * E2B_RESOURCE_PRICING.cpuUsdPerVcpuSecond + 4 * E2B_RESOURCE_PRICING.memoryUsdPerGiBSecond) * 3600;
  return <section className="launch-resource-card" aria-label="Launch resources and estimated compute cost"><div className="resource-card-heading"><strong>{previewMode ? 'Simulated resources' : 'Resources & compute estimate'}</strong><span>REFERENCE CONFIGURATION</span></div><dl className="resource-reference-values"><div><dt>CPU</dt><dd>2 vCPU</dd></div><div><dt>RAM</dt><dd>4 GiB</dd></div><div><dt>Hourly reference</dt><dd>{usd(hourly)}/h</dd></div></dl><p>{previewMode ? 'Simulation creates no charged resources. These values and dollar estimates are illustrative.' : 'Reference configuration only; your custom template is unverified. Provider allocation is confirmed after launch.'}</p><p>Initial 1 hour: <strong>{usd(hourly)}</strong>{extensionsAvailable && <> · Each 30-minute extension: <strong>{usd(hourly / 2)}</strong></>}. Estimates assume this reference allocation for the whole period. A scheduled deadline is not a budget cap or price quote.</p><PricingSource now={now}/><EstimateLimits/></section>;
}

export function ResourceVisibility({ session, accountKey, previewMode, now, active }: { session: Session; accountKey: string; previewMode: boolean; now: number; active: boolean }) {
  const scope = resourceReadScope(accountKey, session, previewMode);
  const [read, setRead] = useState<{ scope: string; value: ResourceReadState }>({ scope, value: emptyResourceRead() });
  const client = useRef<ResourceVisibilityClient | null>(null);
  const allowed = resourceReadAllowed(session, active, now);
  useEffect(() => {
    setRead({ scope, value: emptyResourceRead() });
    if (!allowed) return;
    const current = new ResourceVisibilityClient(signal => api(`/sessions/${encodeURIComponent(session.id)}/resources`, undefined, { signal }), value => setRead({ scope, value }), previewMode);
    client.current = current;
    if (document.visibilityState !== 'hidden') void current.refresh();
    return () => { current.dispose(); if (client.current === current) client.current = null; };
  }, [scope, allowed]);
  const value = read.scope === scope && allowed ? read.value : emptyResourceRead();
  return <ResourceReadout session={session} now={now} previewMode={previewMode} read={value} allowed={allowed} onRefresh={() => { void client.current?.refresh(); }}/>;
}

export function ResourceReadout({ session, now, previewMode, read, allowed, onRefresh }: { session: Session; now: number; previewMode: boolean; read: ResourceReadState; allowed: boolean; onRefresh: () => void }) {
  const running = resourceReadAllowed(session, true, now);
  const snapshot = running && read.snapshot && (read.snapshot.state !== 'simulation' || previewMode) && (read.snapshot.state !== 'known' || !previewMode) ? read.snapshot : null;
  const allocation = snapshot && ['known', 'simulation'].includes(snapshot.state) ? snapshot.allocation : null;
  const checkedAt = snapshot ? Date.parse(snapshot.checkedAt) : NaN;
  // A just-arrived validated snapshot can be newer than the parent's one-second clock tick.
  const estimateNow = Number.isFinite(checkedAt) && checkedAt <= now + 5000 ? Math.max(now, checkedAt) : now;
  const estimate = snapshot && allocation ? estimateResourceCost(snapshot, { expiresAt: session.expiresAt, maxExpiresAt: session.maxExpiresAt }, estimateNow) : null;
  const cost = estimate && Date.parse(estimate.scheduledStopAt) > now ? estimate : null;
  const stale = snapshot ? resourceObservationStale(snapshot.checkedAt, now) : false;
  const metrics = snapshot?.metrics;
  const stateLabel = session.state === 'provisioning' ? 'Allocation pending' : session.state === 'cleanup_pending' ? 'Cleanup in progress' : !running ? 'Machine is no longer running' : read.busy ? 'Checking resources…' : read.error ? 'Resource check unavailable' : snapshot?.state === 'simulation' ? 'Simulation · no charged resources' : snapshot?.state === 'known' ? stale ? 'Stale observation' : 'Provider observation' : 'Resources unknown';
  return <section className="resource-panel" aria-label="Machine resources and cost"><div className="resource-panel-header"><div><strong>Resources & cost</strong><span className="resource-state" role="status">{stateLabel}</span></div><button type="button" className="button subtle small" disabled={!allowed || read.busy} aria-busy={read.busy} onClick={onRefresh}>{read.busy ? 'Checking resources…' : 'Refresh resources'}</button></div><div className="resource-summary"><span><b>{allocation ? `${allocation.cpuCount} vCPU` : 'CPU unknown'}</b> allocated</span><span><b>{allocation ? mib(allocation.memoryMiB) : 'RAM unknown'}</b> RAM</span><span><b>{cost ? `${usd(cost.usdPerHour)}/h` : 'Estimate unavailable'}</b>{cost ? ' compute reference' : ''}</span></div><p className="resource-checked-at">{snapshot ? <>As of <time dateTime={snapshot.checkedAt}>{date(snapshot.checkedAt)}</time> · fixed until refresh</> : 'Allocation and estimates require a current resource check.'}</p><p className="resource-compact-source"><a href={E2B_RESOURCE_PRICING.source} target="_blank" rel="noreferrer">Public compute rates</a> · verified {E2B_RESOURCE_PRICING.checkedAt}{resourcePricingIsStale(now) ? ' · Pricing reference is stale; verify current rates.' : ''}</p><details className="resource-details"><summary>Resource and estimate details</summary>{!running ? <p>Resources are not checked for {session.state === 'running' ? 'an expired' : `a ${session.state.replace('_', ' ')}`} machine. No final charge or cleanup receipt is inferred.</p> : <>{read.error && <p role="alert">{read.error}</p>}{snapshot?.reason && <p>{snapshot.reason}</p>}{!snapshot && !read.busy && !read.error && <p>Refresh resources to check provider allocation and the latest available metrics.</p>}{snapshot && <p className="resource-asof">{stale ? 'Stale snapshot' : 'Snapshot'} as of <time dateTime={snapshot.checkedAt}>{date(snapshot.checkedAt)}</time>. Values stay fixed until refresh.</p>}{snapshot?.state === 'simulation' && <p>Allocation is synthetic. No charged resources are created; dollar values are illustrative.</p>}{allocation && <dl className="resource-detail-values"><div><dt>Allocated CPU</dt><dd>{allocation.cpuCount} vCPU</dd></div><div><dt>Allocated RAM</dt><dd>{mib(allocation.memoryMiB)}</dd></div><div><dt>Allocated disk</dt><dd>{mib(allocation.diskMiB)}</dd></div><div><dt>CPU utilization</dt><dd>{metrics ? `${metrics.cpuUsedPercent.toFixed(1)}%` : 'Pending metrics'}</dd></div><div><dt>RAM used / metric total</dt><dd>{metrics ? `${bytes(metrics.memoryUsedBytes)} / ${bytes(metrics.memoryTotalBytes)}` : 'Pending metrics'}</dd></div><div><dt>Disk used / metric total</dt><dd>{metrics ? `${bytes(metrics.diskUsedBytes)} / ${bytes(metrics.diskTotalBytes)}` : 'Pending metrics'}</dd></div>{metrics && <div><dt>Metrics sampled</dt><dd><time dateTime={metrics.sampledAt}>{date(metrics.sampledAt)}</time></dd></div>}{cost && <><div><dt>Elapsed runtime at check</dt><dd>{Math.floor(cost.elapsedSeconds / 60)} min {Math.floor(cost.elapsedSeconds % 60)} sec</dd></div><div><dt>Elapsed compute estimate</dt><dd>{usd(cost.elapsedUsd)}</dd></div><div><dt>Scheduled deadline</dt><dd>{date(cost.scheduledStopAt)}</dd></div><div><dt>Estimate through deadline</dt><dd>{usd(cost.scheduledUsd)}</dd></div></>}</dl>}{allocation && !cost && <p>Runtime or deadline could not be verified. Cost estimates are unavailable.</p>}{cost && <p>Uses allocated CPU and RAM for the entire runtime, independent of utilization. Deadline estimate assumes unchanged allocation through the scheduled stop; extension changes it. A deadline is not a budget cap.</p>}</>}<PricingSource now={now}/><EstimateLimits/>{previewMode && <p className="resource-footnote">Preview mode · no account balance or invoice is represented.</p>}</details></section>;
}

/**
 * Hot-path counters for the Performance Probe modal. In production builds these
 * no-op unless the probe is open (`data-psy-perf-probe-open` on the root), so
 * normal playback does not pay for object churn. Dev builds always record.
 */
const ROOT_FLAG = 'psyPerfProbeOpen';

export function setPerfProbeTelemetryActive(active: boolean): void {
  if (typeof document === 'undefined') return;
  if (active) document.documentElement.dataset[ROOT_FLAG] = 'true';
  else delete document.documentElement.dataset[ROOT_FLAG];
}

function shouldRecordPerfCounters(): boolean {
  if (import.meta.env.DEV) return true;
  if (typeof document === 'undefined') return false;
  return document.documentElement.dataset[ROOT_FLAG] === 'true';
}

export function bumpPerfCounter(name: string): void {
  if (!shouldRecordPerfCounters()) return;
  const w = globalThis as unknown as { __psyPerfCounters?: Record<string, number> };
  const c = w.__psyPerfCounters ?? (w.__psyPerfCounters = Object.create(null) as Record<string, number>);
  c[name] = (c[name] ?? 0) + 1;
}

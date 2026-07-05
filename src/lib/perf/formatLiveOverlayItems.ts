import type { PerfLiveSnapshot } from '@/lib/perf/perfLiveStore';

export type LiveOverlayItemKind = 'cpu' | 'memory' | 'rate' | 'analysis' | 'cover';

export type LiveOverlayItem = {
  id: string;
  line: string;
  kind: LiveOverlayItemKind;
  sparkline: boolean;
};

export function buildLiveOverlayItems(
  pins: ReadonlySet<string>,
  live: PerfLiveSnapshot,
): LiveOverlayItem[] {
  const items: LiveOverlayItem[] = [];
  const cpu = live.cpu;

  for (const pin of pins) {
    if (pin === 'cpu:app' && cpu?.supported) {
      items.push({
        id: pin,
        line: `cpu psysonic ${cpu.app.toFixed(1)}%`,
        kind: 'cpu',
        sparkline: true,
      });
    } else if (pin === 'cpu:webkit' && cpu?.supported) {
      items.push({
        id: pin,
        line: `cpu webkit ${cpu.webkit.toFixed(1)}%`,
        kind: 'cpu',
        sparkline: true,
      });
    } else if (pin.startsWith('cpu:thread:') && cpu?.supported) {
      const label = pin.slice('cpu:thread:'.length);
      const row = cpu.threadCpu.find(t => t.label === label);
      if (row) {
        const suffix = row.threadCount > 1 ? ` (${row.threadCount})` : '';
        items.push({
          id: pin,
          line: `cpu ${label}${suffix} ${row.pct.toFixed(1)}%`,
          kind: 'cpu',
          sparkline: true,
        });
      }
    } else if (pin.startsWith('mem:') && cpu?.supported) {
      const label = pin.slice('mem:'.length);
      const row = cpu.memory.find(m => m.label === label);
      if (row) {
        items.push({
          id: pin,
          line: `mem ${label} ${(row.rss_kb / 1024).toFixed(1)} MB`,
          kind: 'memory',
          sparkline: true,
        });
      }
    } else if (pin === 'rate:progress' && live.diagRates) {
      items.push({
        id: pin,
        line: `progress ${live.diagRates.progress.toFixed(1)}/s`,
        kind: 'rate',
        sparkline: false,
      });
    } else if (pin === 'rate:waveform' && live.diagRates) {
      items.push({
        id: pin,
        line: `waveform ${live.diagRates.waveform.toFixed(1)}/s`,
        kind: 'rate',
        sparkline: false,
      });
    } else if (pin === 'rate:home' && live.diagRates) {
      items.push({
        id: pin,
        line: `home ${live.diagRates.home.toFixed(1)}/s`,
        kind: 'rate',
        sparkline: false,
      });
    } else if (pin === 'analysis:tpm' && live.analysis) {
      items.push({
        id: pin,
        line: `analysis ${live.analysis.tracksPerMinute.toFixed(1)} tpm`,
        kind: 'analysis',
        sparkline: false,
      });
    } else if (pin === 'analysis:last' && live.analysis?.lastTotalMs != null) {
      items.push({
        id: pin,
        line: `last track ${(live.analysis.lastTotalMs / 1000).toFixed(1)}s`,
        kind: 'analysis',
        sparkline: false,
      });
    } else if (pin === 'cover:cpm' && live.cover) {
      items.push({
        id: pin,
        line: `cover lib ${live.cover.cachedPerMinute.toFixed(1)} cpm`,
        kind: 'cover',
        sparkline: false,
      });
    } else if (pin === 'cover:cpm:ui' && live.cover) {
      items.push({
        id: pin,
        line: `cover ui ${live.cover.uiPerMinute.toFixed(1)} cpm`,
        kind: 'cover',
        sparkline: false,
      });
    }
  }

  return items;
}

/** Numeric sample for history recording (cpu % or memory MB). */
export function liveOverlayItemValue(
  pin: string,
  live: PerfLiveSnapshot,
): number | null {
  const cpu = live.cpu;
  if (!cpu?.supported) return null;

  if (pin === 'cpu:app') return cpu.app;
  if (pin === 'cpu:webkit') return cpu.webkit;
  if (pin.startsWith('cpu:thread:')) {
    const label = pin.slice('cpu:thread:'.length);
    return cpu.threadCpu.find(t => t.label === label)?.pct ?? null;
  }
  if (pin.startsWith('mem:')) {
    const label = pin.slice('mem:'.length);
    const row = cpu.memory.find(m => m.label === label);
    return row ? row.rss_kb / 1024 : null;
  }
  return null;
}

export function isLiveHistoryPin(pin: string): boolean {
  return pin === 'cpu:app'
    || pin === 'cpu:webkit'
    || pin.startsWith('cpu:thread:')
    || pin.startsWith('mem:');
}

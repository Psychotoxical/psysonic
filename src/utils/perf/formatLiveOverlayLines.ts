import type { PerfLiveSnapshot } from './perfLiveStore';

export function formatLiveOverlayLines(
  pins: ReadonlySet<string>,
  live: PerfLiveSnapshot,
): string[] {
  const lines: string[] = [];
  const cpu = live.cpu;
  const push = (line: string) => {
    if (line) lines.push(line);
  };

  for (const pin of pins) {
    if (pin === 'cpu:app' && cpu?.supported) {
      push(`cpu psysonic ${cpu.app.toFixed(1)}%`);
    } else if (pin === 'cpu:webkit' && cpu?.supported) {
      push(`cpu webkit ${cpu.webkit.toFixed(1)}%`);
    } else if (pin.startsWith('cpu:thread:') && cpu?.supported) {
      const label = pin.slice('cpu:thread:'.length);
      const row = cpu.threadCpu.find(t => t.label === label);
      if (row) {
        const suffix = row.threadCount > 1 ? ` (${row.threadCount})` : '';
        push(`cpu ${label}${suffix} ${row.pct.toFixed(1)}%`);
      }
    } else if (pin.startsWith('mem:') && cpu?.supported) {
      const label = pin.slice('mem:'.length);
      const row = cpu.memory.find(m => m.label === label);
      if (row) push(`mem ${label} ${(row.rss_kb / 1024).toFixed(1)} MB`);
    } else if (pin === 'rate:progress' && live.diagRates) {
      push(`progress ${live.diagRates.progress.toFixed(1)}/s`);
    } else if (pin === 'rate:waveform' && live.diagRates) {
      push(`waveform ${live.diagRates.waveform.toFixed(1)}/s`);
    } else if (pin === 'rate:home' && live.diagRates) {
      push(`home ${live.diagRates.home.toFixed(1)}/s`);
    } else if (pin === 'analysis:tpm' && live.analysis) {
      push(`analysis ${live.analysis.tracksPerMinute.toFixed(1)} tpm`);
    } else if (pin === 'analysis:last' && live.analysis?.lastTotalMs != null) {
      push(`last track ${(live.analysis.lastTotalMs / 1000).toFixed(1)}s`);
    }
  }

  return lines;
}

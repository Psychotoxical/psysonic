import { useMemo, useRef } from 'react';
import { usePerfLiveSnapshot } from '../../../utils/perf/perfLiveStore';
import { usePerfLiveIncludeThreadGroups } from '../../../utils/perf/perfLivePollSettings';
import {
  togglePerfLiveOverlayPin,
  togglePipelineOverlayPin,
  usePerfLiveOverlayPins,
  usePipelineOverlayPinned,
  type PerfLiveOverlayPinId,
} from '../../../utils/perf/perfOverlayPins';
import PerfProbeMetricCard, { PerfProbeMetricSection } from './PerfProbeMetricCard';
import PerfOverlayAppearanceControls from './PerfOverlayAppearanceControls';
import PerfOverlayModeControls from './PerfOverlayModeControls';
import PerfLivePollControls from './PerfLivePollControls';

function memoryBarPct(rssKb: number, maxKb: number): number {
  if (maxKb <= 0) return 0;
  return (rssKb / maxKb) * 100;
}

export default function SidebarPerfProbeMonitorTab() {
  const live = usePerfLiveSnapshot();
  const livePins = usePerfLiveOverlayPins();
  const fpsPinned = usePipelineOverlayPinned('pipeline:fps');
  const analysisPinned = usePipelineOverlayPinned('pipeline:analysis');
  const coverPinned = usePipelineOverlayPinned('pipeline:cover');
  const cpu = live.cpu;
  const collecting = live.collecting && cpu == null;
  const includeThreadGroups = usePerfLiveIncludeThreadGroups();
  const peakMemoryKbRef = useRef(1);
  const peakThreadCpuRef = useRef(1);

  const maxMemoryKb = useMemo(() => {
    const current = Math.max(1, ...(cpu?.memory.map(m => m.rss_kb) ?? [1]));
    if (current > peakMemoryKbRef.current) peakMemoryKbRef.current = current;
    return peakMemoryKbRef.current;
  }, [cpu?.memory]);

  const maxThreadCpu = useMemo(() => {
    const current = Math.max(1, ...(cpu?.threadCpu.map(t => t.pct) ?? [1]));
    if (current > peakThreadCpuRef.current) peakThreadCpuRef.current = current;
    return peakThreadCpuRef.current;
  }, [cpu?.threadCpu]);

  if (collecting) {
    return (
      <div className="perf-monitor-empty">
        <div className="spinner" style={{ width: 22, height: 22 }} />
        <span>Collecting live samples…</span>
      </div>
    );
  }

  if (cpu && !cpu.supported) {
    return (
      <div className="perf-monitor-empty">
        Live CPU/memory monitoring is unavailable on this platform or build.
      </div>
    );
  }

  const toggleLive = (id: PerfLiveOverlayPinId) => () => togglePerfLiveOverlayPin(id);
  const livePinned = (id: PerfLiveOverlayPinId) => livePins.has(id);

  return (
    <div className="perf-monitor">
      <PerfOverlayModeControls />
      <PerfOverlayAppearanceControls />
      <PerfLivePollControls />
      <PerfProbeMetricSection title="Pipeline overlays" hint="Rust / UI queues">
        <PerfProbeMetricCard
          label="FPS"
          value="—"
          detail="requestAnimationFrame rate"
          pinned={fpsPinned}
          pinKind="pipeline"
          onTogglePin={() => togglePipelineOverlayPin('pipeline:fps')}
        />
        <PerfProbeMetricCard
          label="Analysis"
          value="—"
          detail="Throughput + last track timings"
          pinned={analysisPinned}
          pinKind="pipeline"
          onTogglePin={() => togglePipelineOverlayPin('pipeline:analysis')}
        />
        <PerfProbeMetricCard
          label="Cover pipeline"
          value="—"
          detail="Ensure / HTTP / encode queues"
          pinned={coverPinned}
          pinKind="pipeline"
          onTogglePin={() => togglePipelineOverlayPin('pipeline:cover')}
        />
      </PerfProbeMetricSection>

      {cpu && (
        <>
          <PerfProbeMetricSection title="CPU — processes">
            <PerfProbeMetricCard
              label="psysonic"
              value={cpu.app.toFixed(1)}
              unit="%"
              barPct={cpu.app}
              barTone="cpu"
              pinned={livePinned('cpu:app')}
              onTogglePin={toggleLive('cpu:app')}
            />
            <PerfProbeMetricCard
              label="WebKit web"
              value={cpu.webkit.toFixed(1)}
              unit="%"
              barPct={cpu.webkit}
              barTone="cpu"
              pinned={livePinned('cpu:webkit')}
              onTogglePin={toggleLive('cpu:webkit')}
            />
          </PerfProbeMetricSection>

          {includeThreadGroups && (
            <PerfProbeMetricSection
              title="CPU — psysonic threads"
              defaultOpen
            >
              {cpu.threadCpu.length > 0 ? cpu.threadCpu.map(row => {
                const pinId = `cpu:thread:${row.label}` as PerfLiveOverlayPinId;
                return (
                  <PerfProbeMetricCard
                    key={row.label}
                    label={row.label}
                    value={row.pct.toFixed(1)}
                    unit="%"
                    detail={row.threadCount > 1 ? `${row.threadCount} threads` : undefined}
                    barPct={(row.pct / maxThreadCpu) * 100}
                    barTone="cpu"
                    pinned={livePinned(pinId)}
                    onTogglePin={toggleLive(pinId)}
                  />
                );
              }) : (
                <div className="perf-monitor-empty perf-monitor-empty--inline">
                  No named psysonic threads yet — wait for the next poll or load audio/analysis work.
                </div>
              )}
            </PerfProbeMetricSection>
          )}

          {cpu.memory.length > 0 && (
            <PerfProbeMetricSection title="Memory — RSS">
              {cpu.memory.map(row => {
                const pinId = `mem:${row.label}` as PerfLiveOverlayPinId;
                return (
                  <PerfProbeMetricCard
                    key={row.label}
                    label={row.label}
                    value={(row.rss_kb / 1024).toFixed(1)}
                    unit="MB"
                    barPct={memoryBarPct(row.rss_kb, maxMemoryKb)}
                    barTone="memory"
                    pinned={livePinned(pinId)}
                    onTogglePin={toggleLive(pinId)}
                  />
                );
              })}
            </PerfProbeMetricSection>
          )}
        </>
      )}

      {live.diagRates && (
        <PerfProbeMetricSection title="UI event rates" defaultOpen={false}>
          <PerfProbeMetricCard
            label="audio:progress"
            value={live.diagRates.progress.toFixed(1)}
            unit="/s"
            barPct={Math.min(100, live.diagRates.progress * 2)}
            barTone="rate"
            pinned={livePinned('rate:progress')}
            onTogglePin={toggleLive('rate:progress')}
          />
          <PerfProbeMetricCard
            label="waveform draws"
            value={live.diagRates.waveform.toFixed(1)}
            unit="/s"
            barPct={Math.min(100, live.diagRates.waveform * 2)}
            barTone="rate"
            pinned={livePinned('rate:waveform')}
            onTogglePin={toggleLive('rate:waveform')}
          />
          <PerfProbeMetricCard
            label="Home commits"
            value={live.diagRates.home.toFixed(1)}
            unit="/s"
            barPct={Math.min(100, live.diagRates.home * 5)}
            barTone="rate"
            pinned={livePinned('rate:home')}
            onTogglePin={toggleLive('rate:home')}
          />
        </PerfProbeMetricSection>
      )}

      {live.analysis && (
        <PerfProbeMetricSection title="Analysis" defaultOpen={false}>
          <PerfProbeMetricCard
            label="Throughput"
            value={live.analysis.tracksPerMinute.toFixed(1)}
            unit="tpm"
            pinned={livePinned('analysis:tpm')}
            onTogglePin={toggleLive('analysis:tpm')}
          />
          {live.analysis.lastTotalMs != null && (
            <PerfProbeMetricCard
              label="Last track"
              value={(live.analysis.lastTotalMs / 1000).toFixed(1)}
              unit="s"
              detail={`fetch ${((live.analysis.lastFetchMs ?? 0) / 1000).toFixed(1)}s · seed ${((live.analysis.lastSeedMs ?? 0) / 1000).toFixed(1)}s · bpm ${((live.analysis.lastBpmMs ?? 0) / 1000).toFixed(1)}s`}
              pinned={livePinned('analysis:last')}
              onTogglePin={toggleLive('analysis:last')}
            />
          )}
        </PerfProbeMetricSection>
      )}
    </div>
  );
}

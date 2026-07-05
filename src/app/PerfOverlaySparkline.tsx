import { useMemo, useRef } from 'react';
import type { PerfLiveSample } from '@/lib/perf/perfLiveHistory';
import { PERF_LIVE_HISTORY_MS } from '@/lib/perf/perfLiveHistory';

type SparklineKind = 'cpu' | 'memory';

interface Props {
  samples: readonly PerfLiveSample[];
  kind: SparklineKind;
  now: number;
  windowMs?: number;
  width?: number;
  height?: number;
}

function sampleX(at: number, now: number, windowMs: number, width: number): number {
  const age = now - at;
  const ratio = 1 - age / windowMs;
  return Math.max(0, Math.min(width, ratio * width));
}

function sparklinePaths(
  samples: readonly PerfLiveSample[],
  now: number,
  windowMs: number,
  width: number,
  height: number,
  min: number,
  max: number,
): { line: string; area: string } {
  if (samples.length === 0) return { line: '', area: '' };

  const range = Math.max(max - min, 1e-6);
  const toY = (value: number) => height - ((value - min) / range) * (height - 2) - 1;
  const sorted = [...samples].sort((a, b) => a.at - b.at);

  if (sorted.length === 1) {
    const x = sampleX(sorted[0].at, now, windowMs, width);
    const y = toY(sorted[0].value);
    const x0 = Math.max(0, x - 6);
    const line = `M${x0.toFixed(2)},${y.toFixed(2)} L${x.toFixed(2)},${y.toFixed(2)}`;
    const area = `${line} L${x.toFixed(2)},${height} L${x0.toFixed(2)},${height} Z`;
    return { line, area };
  }

  const points = sorted.map(sample => ({
    x: sampleX(sample.at, now, windowMs, width),
    y: toY(sample.value),
  }));
  const line = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  const area = `${line} L${last.x.toFixed(2)},${height} L${first.x.toFixed(2)},${height} Z`;
  return { line, area };
}

function scale(samples: readonly PerfLiveSample[], kind: SparklineKind): { min: number; max: number } {
  if (samples.length === 0) return { min: 0, max: 1 };
  const values = samples.map(sample => sample.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  if (kind === 'cpu') {
    return { min: 0, max: Math.max(5, maxVal * 1.25) };
  }
  const pad = Math.max((maxVal - minVal) * 0.08, maxVal * 0.02, 1);
  return { min: Math.max(0, minVal - pad), max: maxVal + pad };
}

function stableScale(
  samples: readonly PerfLiveSample[],
  kind: SparklineKind,
  peakRef: { current: number },
): { min: number; max: number } {
  const raw = scale(samples, kind);
  if (raw.max > peakRef.current) peakRef.current = raw.max;
  if (kind === 'cpu') {
    return { min: 0, max: Math.max(5, Math.max(peakRef.current, raw.max)) };
  }
  return { min: 0, max: Math.max(peakRef.current, raw.max) };
}

/** Compact 1-minute sparkline for perf overlay CPU / memory pins. */
export default function PerfOverlaySparkline({
  samples,
  kind,
  now,
  windowMs = PERF_LIVE_HISTORY_MS,
  width = 132,
  height = 22,
}: Props) {
  const peakRef = useRef(1);

  const { path, areaPath } = useMemo(() => {
    // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
    // eslint-disable-next-line react-hooks/refs
    const bounds = stableScale(samples, kind, peakRef);
    const paths = sparklinePaths(samples, now, windowMs, width, height, bounds.min, bounds.max);
    return { path: paths.line, areaPath: paths.area };
  }, [samples, kind, now, windowMs, width, height]);

  const latest = samples.length > 0 ? samples[samples.length - 1]?.value : null;

  return (
    <svg
      className={`perf-overlay-sparkline perf-overlay-sparkline--${kind}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <rect
        className="perf-overlay-sparkline__track"
        x={0}
        y={0}
        width={width}
        height={height}
        rx={3}
      />
      {areaPath && <path className="perf-overlay-sparkline__fill" d={areaPath} />}
      {path && (
        <path className="perf-overlay-sparkline__line" d={path} vectorEffect="non-scaling-stroke" />
      )}
      <title>
        {latest == null
          ? `${kind === 'cpu' ? 'CPU' : 'Memory'} (1 min)`
          : kind === 'cpu'
            ? `CPU ${latest.toFixed(1)}% (1 min)`
            : `Memory ${latest.toFixed(1)} MB (1 min)`}
      </title>
    </svg>
  );
}

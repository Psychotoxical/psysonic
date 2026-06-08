import type { ReactNode } from 'react';
import { ChevronRight, Pin, PinOff } from 'lucide-react';

type PinKind = 'live' | 'pipeline';

interface Props {
  label: string;
  value: string;
  unit?: string;
  detail?: string;
  barPct?: number;
  barTone?: 'cpu' | 'memory' | 'rate' | 'neutral';
  pinned?: boolean;
  pinKind?: PinKind;
  onTogglePin?: () => void;
  disabled?: boolean;
}

export default function PerfProbeMetricCard({
  label,
  value,
  unit,
  detail,
  barPct,
  barTone = 'neutral',
  pinned = false,
  pinKind,
  onTogglePin,
  disabled = false,
}: Props) {
  const showBar = barPct != null && Number.isFinite(barPct) && barPct > 0;

  return (
    <div className={`perf-metric-card${disabled ? ' perf-metric-card--disabled' : ''}`}>
      <div className="perf-metric-card__head">
        <div className="perf-metric-card__label">{label}</div>
        {onTogglePin && (
          <button
            type="button"
            className={`perf-metric-card__pin${pinned ? ' perf-metric-card__pin--active' : ''}`}
            onClick={onTogglePin}
            aria-pressed={pinned}
            title={pinned ? 'Remove from overlay' : 'Show in overlay'}
          >
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        )}
      </div>
      <div className="perf-metric-card__value-row">
        <span className="perf-metric-card__value">{value}</span>
        {unit && <span className="perf-metric-card__unit">{unit}</span>}
      </div>
      {showBar && (
        <div className="perf-metric-card__bar-track" aria-hidden="true">
          <div
            className={`perf-metric-card__bar-fill perf-metric-card__bar-fill--${barTone}`}
            style={{ width: `${Math.min(100, barPct)}%` }}
          />
        </div>
      )}
      {detail && <div className="perf-metric-card__detail">{detail}</div>}
      {pinKind === 'pipeline' && pinned && (
        <div className="perf-metric-card__badge">Pipeline overlay</div>
      )}
    </div>
  );
}

interface SectionProps {
  title: string;
  hint?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  layout?: 'grid' | 'stack';
  onOpenChange?: (open: boolean) => void;
}

export function PerfProbeMetricSection({
  title,
  hint,
  children,
  defaultOpen = true,
  layout = 'grid',
  onOpenChange,
}: SectionProps) {
  return (
    <details
      className="perf-metric-section"
      open={defaultOpen}
      onToggle={e => onOpenChange?.((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="perf-metric-section__title">
        <ChevronRight size={14} className="perf-metric-section__chevron" />
        <span>{title}</span>
        {hint && <span className="perf-metric-section__hint">{hint}</span>}
      </summary>
      <div className={layout === 'stack' ? 'perf-metric-section__body' : 'perf-metric-section__grid'}>
        {children}
      </div>
    </details>
  );
}

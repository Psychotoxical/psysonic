import type { ReactNode } from 'react';

export type PerfProbeBadgeTone = 'ok' | 'warn' | 'error' | 'neutral' | 'muted';

interface Props {
  tone: PerfProbeBadgeTone;
  children: ReactNode;
}

export default function PerfProbeStatusBadge({ tone, children }: Props) {
  return (
    <span className={`perf-status-badge perf-status-badge--${tone}`}>
      {children}
    </span>
  );
}

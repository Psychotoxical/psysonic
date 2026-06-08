import type { ReactNode } from 'react';

export interface PerfProbeDetailRow {
  label: string;
  value: ReactNode;
}

interface Props {
  rows: PerfProbeDetailRow[];
}

export default function PerfProbeDetailList({ rows }: Props) {
  return (
    <dl className="perf-server-dl">
      {rows.map(row => (
        <div key={row.label} className="perf-server-dl__row">
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

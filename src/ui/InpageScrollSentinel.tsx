import type { CSSProperties, RefCallback } from 'react';

const DEFAULT_STYLE: CSSProperties = {
  height: '20px',
  margin: '2rem 0',
  display: 'flex',
  justifyContent: 'center',
};

type InpageScrollSentinelProps = {
  bindSentinel: RefCallback<HTMLDivElement | null>;
  loading?: boolean;
  style?: CSSProperties;
};

/** Bottom-of-grid load-more sentinel + optional spinner (in-page scroll areas). */
export default function InpageScrollSentinel({
  bindSentinel,
  loading = false,
  style,
}: InpageScrollSentinelProps) {
  return (
    <div ref={bindSentinel} style={{ ...DEFAULT_STYLE, ...style }}>
      {loading && <div className="spinner" style={{ width: 20, height: 20 }} />}
    </div>
  );
}

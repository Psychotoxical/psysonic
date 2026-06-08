/**
 * Five-segment popularity bar, filled relative to the most-downloaded theme in
 * the catalogue (so the leader reads full and the rest scale against it). With
 * few downloads it sits near-empty and fills in organically as counts grow.
 * Decorative — the exact download number sits next to it as the real value.
 */
export function PopularityBar({ value, max }: { value: number; max: number }) {
  const filled = max > 0 ? Math.round((Math.max(0, value) / max) * 5) : 0;
  return (
    <span style={{ display: 'inline-flex', gap: 3 }} aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          style={{
            width: 16,
            height: 5,
            borderRadius: 2,
            background: i < filled ? 'var(--accent)' : 'var(--bg-hover)',
          }}
        />
      ))}
    </span>
  );
}

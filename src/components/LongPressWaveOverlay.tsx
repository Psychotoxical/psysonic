interface LongPressWaveOverlayProps {
  active: boolean;
  /** Smaller crest/fill tuned for dense album-card play buttons. */
  size?: 'default' | 'compact';
}

export function LongPressWaveOverlay({ active, size = 'default' }: LongPressWaveOverlayProps) {
  const compact = size === 'compact';
  return (
    <div
      className={`long-press-wave${active ? ' long-press-wave--active' : ''}${compact ? ' long-press-wave--compact' : ''}`}
      aria-hidden="true"
    >
      <svg className="long-press-wave__crest" viewBox="0 0 200 20" preserveAspectRatio="none">
        <path d="M0,10 Q25,18 50,10 T100,10 Q125,18 150,10 T200,10 L200,20 L0,20 Z" fill="currentColor" />
      </svg>
      <div className="long-press-wave__fill" />
    </div>
  );
}

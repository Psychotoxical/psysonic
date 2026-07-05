import { useRef, useCallback } from 'react';

// ─── Custom vertical fader (no native range input) ────────────────────────────

const GAIN_MIN = -12, GAIN_MAX = 12;

interface FaderProps {
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
}

export default function VerticalFader({ value, disabled, onChange }: FaderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const gainToPct = (g: number) => (GAIN_MAX - g) / (GAIN_MAX - GAIN_MIN); // 0=top, 1=bottom
  const pctToGain = (p: number) => GAIN_MAX - p * (GAIN_MAX - GAIN_MIN);

  const updateFromY = useCallback((clientY: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const gain = parseFloat((Math.round(pctToGain(pct) / 0.1) * 0.1).toFixed(1)); // snap to 0.1 dB
    onChange(Math.max(GAIN_MIN, Math.min(GAIN_MAX, gain)));
  }, [onChange]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    dragging.current = true;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    updateFromY(e.clientY);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current || disabled) return;
    updateFromY(e.clientY);
  };

  const onPointerUp = () => { dragging.current = false; };

  const thumbPct = gainToPct(value) * 100;

  return (
    <div
      ref={trackRef}
      className="eq-fader-custom"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ cursor: disabled ? 'default' : 'pointer' }}
    >
      <div className="eq-track-line" />
      <div className="eq-thumb" style={{ top: `${thumbPct}%`, opacity: disabled ? 0.3 : 1 }} />
    </div>
  );
}

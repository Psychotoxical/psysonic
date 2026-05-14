import { useEffect, useRef } from 'react';
import type { SeekbarStyle } from '../store/authStoreTypes';
import { makeAnimState, makeHeights } from '../utils/waveform/waveformSeekHelpers';
import { drawSeekbar } from '../utils/waveform/waveformSeekRenderers';

interface Props {
  style: SeekbarStyle;
  label: string;
  selected: boolean;
  onClick: () => void;
}

/** Animated preview tile for Settings — drives drawSeekbar via a rAF loop and
 *  parks itself when the window/tab is hidden. */
export function SeekbarPreview({ style, label, selected, onClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let heights: Float32Array | null = null;
    if (style === 'truewave' || style === 'pseudowave') {
      heights = makeHeights('seekbar-preview-demo');
    }
    const animState = makeAnimState();
    let t = 0;
    let rafId: number | null = null;
    let pollId: number | null = null;
    const stop = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (pollId !== null) {
        window.clearTimeout(pollId);
        pollId = null;
      }
    };
    const tick = () => {
      if (document.hidden || window.__psyHidden) {
        pollId = window.setTimeout(() => {
          pollId = null;
          tick();
        }, 400);
        return;
      }
      t += 0.016;
      animState.time = t;
      const progress = 0.15 + 0.65 * (0.5 + 0.5 * Math.sin(t));
      const buffered  = Math.min(1, progress + 0.18);
      drawSeekbar(canvas, style, heights, progress, buffered, animState);
      rafId = requestAnimationFrame(tick);
    };
    tick();
    return () => stop();
  }, [style]);

  return (
    <button
      onClick={onClick}
      style={{
        border: `2px solid ${selected ? 'var(--accent)' : 'var(--ctp-surface1)'}`,
        borderRadius: 8,
        background: selected
          ? 'color-mix(in srgb, var(--accent) 12%, transparent)'
          : 'var(--bg-card, var(--ctp-base))',
        padding: '10px 12px 8px',
        cursor: 'pointer',
        width: 130,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        alignItems: 'stretch',
        transition: 'border-color 0.15s, background 0.15s',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: 24, display: 'block' }}
      />
      <span style={{
        fontSize: 11,
        color: selected ? 'var(--accent)' : 'var(--text-secondary)',
        textAlign: 'center',
        fontWeight: selected ? 600 : 400,
      }}>
        {label}
      </span>
    </button>
  );
}

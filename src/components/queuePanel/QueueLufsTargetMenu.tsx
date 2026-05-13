import React from 'react';
import { createPortal } from 'react-dom';
import type { LoudnessLufsPreset } from '../../store/authStoreTypes';

interface Props {
  menuRef: React.RefObject<HTMLDivElement | null>;
  popStyle: React.CSSProperties;
  authLoudnessTargetLufs: LoudnessLufsPreset;
  setLoudnessTargetLufs: (v: LoudnessLufsPreset) => void;
  onClose: () => void;
}

const LUFS_TARGETS: readonly LoudnessLufsPreset[] = [-10, -12, -14, -16] as const;

export function QueueLufsTargetMenu({
  menuRef, popStyle, authLoudnessTargetLufs, setLoudnessTargetLufs, onClose,
}: Props) {
  return createPortal(
    <div
      ref={menuRef}
      className="queue-lufs-tgt-menu"
      style={{
        ...popStyle,
        background: 'var(--bg-card)',
        border: '1px solid var(--border, rgba(255,255,255,0.12))',
        borderRadius: 8,
        boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
        padding: 6,
        overflow: 'auto',
      }}
      role="listbox"
      aria-label="LUFS target"
      onClick={e => e.stopPropagation()}
    >
      {LUFS_TARGETS.map((v) => (
        <button
          key={v}
          type="button"
          onClick={e => {
            e.stopPropagation();
            if (v !== authLoudnessTargetLufs) {
              setLoudnessTargetLufs(v);
            }
            onClose();
          }}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '6px 8px',
            borderRadius: 6,
            border: 'none',
            background: v === authLoudnessTargetLufs ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          {v} LUFS
        </button>
      ))}
    </div>,
    document.body,
  );
}

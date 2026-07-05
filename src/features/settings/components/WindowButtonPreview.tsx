import React from 'react';
import { Minus, Square, X } from 'lucide-react';
import type { WindowButtonStyle } from '@/store/authStoreTypes';

interface Props {
  style: WindowButtonStyle;
  label: string;
  selected: boolean;
  onClick: () => void;
}

/**
 * Selection tile for the custom-title-bar window-button style picker. Renders
 * the real `.titlebar-controls` / `.titlebar-btn` classes inside a mini title
 * bar so the preview is exactly what the chosen style produces.
 */
export default function WindowButtonPreview({ style, label, selected, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={{
        border: `2px solid ${selected ? 'var(--accent)' : 'var(--bg-hover)'}`,
        borderRadius: 8,
        background: selected
          ? 'color-mix(in srgb, var(--accent) 12%, transparent)'
          : 'var(--bg-card, var(--bg-app))',
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          minHeight: 34,
          background: 'var(--bg-sidebar)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        <div className="titlebar-controls" data-btnstyle={style} aria-hidden>
          <span className="titlebar-btn titlebar-btn-minimize"><Minus size={10} strokeWidth={2.5} /></span>
          <span className="titlebar-btn titlebar-btn-maximize"><Square size={9} strokeWidth={2.5} /></span>
          <span className="titlebar-btn titlebar-btn-close"><X size={10} strokeWidth={2.5} /></span>
        </div>
      </div>
      <span
        style={{
          fontSize: 11,
          color: selected ? 'var(--accent)' : 'var(--text-secondary)',
          textAlign: 'center',
          fontWeight: selected ? 600 : 400,
        }}
      >
        {label}
      </span>
    </button>
  );
}

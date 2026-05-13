import React, { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../store/authStore';

interface Props {
  open: boolean;
  onClose: () => void;
  accentColor: string | null;
  triggerRef?: React.RefObject<HTMLElement | null>;
}

// Lyrics settings popover — shown above the mic button.
export const FsLyricsMenu = memo(function FsLyricsMenu({ open, onClose, accentColor, triggerRef }: Props) {
  const { t } = useTranslation();
  const showLyrics  = useAuthStore(s => s.showFullscreenLyrics);
  const lyricsStyle = useAuthStore(s => s.fsLyricsStyle);
  const setLyrics   = useAuthStore(s => s.setShowFullscreenLyrics);
  const setStyle    = useAuthStore(s => s.setFsLyricsStyle);
  const panelRef    = useRef<HTMLDivElement>(null);

  // Close on click outside the panel or on Escape.
  // Ignore clicks on the trigger button so re-clicking it toggles normally
  // instead of outside-handler closing + click re-opening.
  useEffect(() => {
    if (!open) return;
    const onKey   = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onMouse = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    const t = setTimeout(() => window.addEventListener('mousedown', onMouse), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouse);
    };
  }, [open, onClose, triggerRef]);

  if (!open) return null;

  const accent = accentColor ?? 'var(--accent)';

  return (
    <div className="fslm-panel" ref={panelRef}>
      <div className="fslm-row">
        <span className="fslm-label">{t('player.fsLyricsToggle')}</span>
        <label className="toggle-switch" aria-label={t('player.fsLyricsToggle')}>
          <input
            type="checkbox"
            checked={showLyrics}
            onChange={e => setLyrics(e.target.checked)}
          />
          <span className="toggle-track" />
        </label>
      </div>

      <div className={`fslm-style-row${showLyrics ? '' : ' fslm-disabled'}`}>
        {(['rail', 'apple'] as const).map(style => (
          <button
            key={style}
            className={`fslm-style-btn${lyricsStyle === style ? ' fslm-style-active' : ''}`}
            onClick={() => setStyle(style)}
            style={lyricsStyle === style ? { borderColor: accent, color: accent, background: `color-mix(in srgb, ${accent} 14%, transparent)` } : undefined}
          >
            <span className="fslm-style-name">{t(`settings.fsLyricsStyle${style.charAt(0).toUpperCase() + style.slice(1)}` as any)}</span>
            <span className="fslm-style-desc">{t(`settings.fsLyricsStyle${style.charAt(0).toUpperCase() + style.slice(1)}Desc` as any)}</span>
          </button>
        ))}
      </div>

      <div className="fslm-arrow" />
    </div>
  );
});

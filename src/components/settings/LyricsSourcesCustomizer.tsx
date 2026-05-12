import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical, Music2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useDragDrop, useDragSource } from '../../contexts/DragDropContext';
import { useAuthStore } from '../../store/authStore';
import type { LyricsSourceId } from '../../store/authStoreTypes';

const LYRICS_SOURCE_LABEL_KEYS: Record<LyricsSourceId, string> = {
  server:  'settings.lyricsSourceServer',
  lrclib:  'settings.lyricsSourceLrclib',
  netease: 'settings.lyricsSourceNetease',
};

type LyricsDropTarget = { idx: number; before: boolean } | null;

function LyricsSourceGripHandle({ idx, label }: { idx: number; label: string }) {
  const { t } = useTranslation();
  const { onMouseDown } = useDragSource(() => ({
    data: JSON.stringify({ type: 'lyrics_source_reorder', index: idx }),
    label,
  }));
  return (
    <span
      className="sidebar-customizer-grip"
      data-tooltip={t('settings.sidebarDrag')}
      data-tooltip-pos="right"
      onMouseDown={onMouseDown}
    >
      <GripVertical size={16} />
    </span>
  );
}

export function LyricsSourcesCustomizer() {
  const { t } = useTranslation();
  const lyricsSources = useAuthStore(useShallow(s => s.lyricsSources));
  const setLyricsSources = useAuthStore(s => s.setLyricsSources);
  const lyricsMode = useAuthStore(s => s.lyricsMode);
  const setLyricsMode = useAuthStore(s => s.setLyricsMode);
  const lyricsStaticOnly = useAuthStore(s => s.lyricsStaticOnly);
  const setLyricsStaticOnly = useAuthStore(s => s.setLyricsStaticOnly);
  const { isDragging: isPsyDragging } = useDragDrop();
  // useState (not useRef) so the listener-effect re-runs when the container
  // gets unmounted/remounted by the {lyricsMode === 'standard'} wrapper.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [dropTarget, setDropTarget] = useState<LyricsDropTarget>(null);
  const dropTargetRef = useRef<LyricsDropTarget>(null);
  const sourcesRef = useRef(lyricsSources);
  sourcesRef.current = lyricsSources;

  useEffect(() => {
    if (!isPsyDragging) { dropTargetRef.current = null; setDropTarget(null); }
  }, [isPsyDragging]);

  useEffect(() => {
    if (!containerEl) return;
    const onPsyDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;
      let parsed: { type?: string; index?: number };
      try { parsed = JSON.parse(detail.data as string); } catch { return; }
      if (parsed.type !== 'lyrics_source_reorder' || parsed.index == null) return;

      const fromIdx = parsed.index;
      const target = dropTargetRef.current;
      dropTargetRef.current = null; setDropTarget(null);
      if (!target) return;

      const insertBefore = target.before ? target.idx : target.idx + 1;
      if (insertBefore === fromIdx || insertBefore === fromIdx + 1) return;

      const next = [...sourcesRef.current];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(insertBefore > fromIdx ? insertBefore - 1 : insertBefore, 0, moved);
      setLyricsSources(next);
    };
    containerEl.addEventListener('psy-drop', onPsyDrop);
    return () => containerEl.removeEventListener('psy-drop', onPsyDrop);
  }, [containerEl, setLyricsSources]);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPsyDragging || !containerEl) return;
    const rows = containerEl.querySelectorAll<HTMLElement>('[data-lyrics-idx]');
    let target: LyricsDropTarget = null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const idx = Number(row.dataset.lyricsIdx);
      if (e.clientY < rect.top + rect.height / 2) { target = { idx, before: true }; break; }
      target = { idx, before: false };
    }
    dropTargetRef.current = target;
    setDropTarget(target);
  };

  const toggleSource = (id: LyricsSourceId) => {
    setLyricsSources(sourcesRef.current.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s));
  };

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <Music2 size={18} />
        <h2>{t('settings.lyricsSourcesTitle')}</h2>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
        {t('settings.lyricsSourcesDesc')}
      </p>

      {/* Mode switch — standard three-provider pipeline vs. YouLyPlus karaoke.
          YouLyPlus misses silently fall back to the standard pipeline. */}
      <div className="settings-card" style={{ marginBottom: '0.75rem' }}>
        <div className="settings-toggle-row">
          <div>
            <div style={{ fontWeight: 500 }}>{t('settings.lyricsModeLyricsplus')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.lyricsModeLyricsplusDesc')}</div>
          </div>
          <label className="toggle-switch" aria-label={t('settings.lyricsModeLyricsplus')}>
            <input
              type="checkbox"
              checked={lyricsMode === 'lyricsplus'}
              onChange={e => { if (e.target.checked) setLyricsMode('lyricsplus'); else setLyricsMode('standard'); }}
            />
            <span className="toggle-track" />
          </label>
        </div>
      </div>
      <div className="settings-card" style={{ marginBottom: '0.75rem' }}>
        <div className="settings-toggle-row">
          <div>
            <div style={{ fontWeight: 500 }}>{t('settings.lyricsModeStandard')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.lyricsModeStandardDesc')}</div>
          </div>
          <label className="toggle-switch" aria-label={t('settings.lyricsModeStandard')}>
            <input
              type="checkbox"
              checked={lyricsMode === 'standard'}
              onChange={e => { if (e.target.checked) setLyricsMode('standard'); else setLyricsMode('lyricsplus'); }}
            />
            <span className="toggle-track" />
          </label>
        </div>
      </div>

      {lyricsMode === 'standard' && (
        <div
          className="settings-card"
          style={{ padding: '4px 0', marginBottom: '0.75rem', marginLeft: '1rem' }}
          ref={setContainerEl}
          onMouseMove={handleMouseMove}
        >
          {lyricsSources.map((src, i) => {
            const label = t(LYRICS_SOURCE_LABEL_KEYS[src.id]);
            const isBefore = isPsyDragging && dropTarget?.idx === i && dropTarget.before;
            const isAfter  = isPsyDragging && dropTarget?.idx === i && !dropTarget.before;
            return (
              <div
                key={src.id}
                data-lyrics-idx={i}
                className="sidebar-customizer-row"
                style={{
                  borderTop:    isBefore ? '2px solid var(--accent)' : undefined,
                  borderBottom: isAfter  ? '2px solid var(--accent)' : undefined,
                }}
              >
                <LyricsSourceGripHandle idx={i} label={label} />
                <span style={{ flex: 1, fontSize: 14, opacity: src.enabled ? 1 : 0.45 }}>{label}</span>
                <label className="toggle-switch" aria-label={label}>
                  <input type="checkbox" checked={src.enabled} onChange={() => toggleSource(src.id)} />
                  <span className="toggle-track" />
                </label>
              </div>
            );
          })}
        </div>
      )}

      {/* Static-only toggle — suppresses line/word tracking in both modes. */}
      <div className="settings-card" style={{ marginBottom: '0.75rem' }}>
        <div className="settings-toggle-row">
          <div>
            <div style={{ fontWeight: 500 }}>{t('settings.lyricsStaticOnly')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.lyricsStaticOnlyDesc')}</div>
          </div>
          <label className="toggle-switch" aria-label={t('settings.lyricsStaticOnly')}>
            <input type="checkbox" checked={lyricsStaticOnly} onChange={e => setLyricsStaticOnly(e.target.checked)} />
            <span className="toggle-track" />
          </label>
        </div>
      </div>
    </section>
  );
}

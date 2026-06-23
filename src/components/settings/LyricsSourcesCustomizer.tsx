import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useDragDrop, useDragSource } from '../../contexts/DragDropContext';
import { useAuthStore } from '../../store/authStore';
import type { LyricsSourceId } from '../../store/authStoreTypes';
import { SettingsToggle } from './SettingsToggle';

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
  const youLyPlusEnabled = useAuthStore(s => s.youLyPlusEnabled);
  const setYouLyPlusEnabled = useAuthStore(s => s.setYouLyPlusEnabled);
  const lyricsStaticOnly = useAuthStore(s => s.lyricsStaticOnly);
  const setLyricsStaticOnly = useAuthStore(s => s.setLyricsStaticOnly);
  const { isDragging: isPsyDragging } = useDragDrop();
  // useState (not useRef) so the listener-effect re-binds if the container
  // element is ever remounted.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [dropTarget, setDropTarget] = useState<LyricsDropTarget>(null);
  const dropTargetRef = useRef<LyricsDropTarget>(null);
  const sourcesRef = useRef(lyricsSources);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  sourcesRef.current = lyricsSources;

  useEffect(() => {
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    <>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
        {t('settings.lyricsSourcesDesc')}
      </p>

      {/* YouLyPlus (karaoke) — independent toggle. When on it is tried first and
          the enabled sources below act as fallback; when off only those sources
          are used. YouLyPlus off + every source off = lyrics fully disabled. */}
      <div style={{ marginBottom: '0.75rem' }}>
        <SettingsToggle
          label={t('settings.lyricsYouLyPlus')}
          desc={t('settings.lyricsYouLyPlusDesc')}
          checked={youLyPlusEnabled}
          onChange={setYouLyPlusEnabled}
        />
      </div>

      <div className="playback-rate-derived" style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 0.4rem' }}>
        {youLyPlusEnabled ? t('settings.lyricsSourcesFallbackHint') : t('settings.lyricsSourcesPrimaryHint')}
      </div>
      <div
        style={{ padding: '4px 0', marginBottom: '0.75rem' }}
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

      {/* Static-only toggle — suppresses line/word tracking in both modes. */}
      <div style={{ marginBottom: '0.75rem' }}>
        <SettingsToggle
          label={t('settings.lyricsStaticOnly')}
          desc={t('settings.lyricsStaticOnlyDesc')}
          checked={lyricsStaticOnly}
          onChange={setLyricsStaticOnly}
        />
      </div>
    </>
  );
}

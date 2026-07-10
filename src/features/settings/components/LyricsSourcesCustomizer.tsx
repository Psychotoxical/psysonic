import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStore } from '@/store/authStore';
import type { LyricsSourceId } from '@/store/authStoreTypes';
import { useListReorderDnd } from '@/lib/hooks/useListReorderDnd';
import { applyListReorderById, type ListReorderDropTarget } from '@/lib/util/listReorder';
import { ReorderGripHandle } from '@/features/settings/components/ReorderGripHandle';
import { SettingsToggle } from '@/features/settings/components/SettingsToggle';
import { SettingsSubCard, SettingsField } from '@/features/settings/components/SettingsSubCard';

const LYRICS_SOURCE_LABEL_KEYS: Record<LyricsSourceId, string> = {
  server:  'settings.lyricsSourceServer',
  lrclib:  'settings.lyricsSourceLrclib',
  netease: 'settings.lyricsSourceNetease',
};

const REORDER_TYPE = 'lyrics_source_reorder';

export function LyricsSourcesCustomizer() {
  const { t } = useTranslation();
  const lyricsSources = useAuthStore(useShallow(s => s.lyricsSources));
  const setLyricsSources = useAuthStore(s => s.setLyricsSources);
  const youLyPlusEnabled = useAuthStore(s => s.youLyPlusEnabled);
  const setYouLyPlusEnabled = useAuthStore(s => s.setYouLyPlusEnabled);
  const lyricsStaticOnly = useAuthStore(s => s.lyricsStaticOnly);
  const setLyricsStaticOnly = useAuthStore(s => s.setLyricsStaticOnly);
  const sourcesRef = useRef(lyricsSources);
  // React Compiler refs rule: ref kept in sync with the latest value for use in handlers; not render data.
  // eslint-disable-next-line react-hooks/refs
  sourcesRef.current = lyricsSources;

  const apply = useCallback((draggedId: string, target: ListReorderDropTarget) => {
    const next = applyListReorderById(sourcesRef.current, draggedId, target);
    if (next) setLyricsSources(next);
  }, [setLyricsSources]);

  const { isDragging, setContainer, onMouseMove, dropEdge } = useListReorderDnd({ type: REORDER_TYPE, apply });

  const toggleSource = (id: LyricsSourceId) => {
    setLyricsSources(sourcesRef.current.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s));
  };

  return (
    <>
      {/* YouLyPlus (karaoke) — independent toggle. When on it is tried first and
          the enabled sources below act as fallback; when off only those sources
          are used. YouLyPlus off + every source off = lyrics fully disabled. */}
      <SettingsToggle
        label={t('settings.lyricsYouLyPlus')}
        desc={t('settings.lyricsYouLyPlusDesc')}
        checked={youLyPlusEnabled}
        onChange={setYouLyPlusEnabled}
      />

      <SettingsSubCard style={{ margin: '0.85rem 0' }}>
        <SettingsField
          desc={youLyPlusEnabled ? t('settings.lyricsSourcesFallbackHint') : t('settings.lyricsSourcesPrimaryHint')}
          note={t('settings.lyricsServerWordSyncHint')}
        >
          <div ref={setContainer} onMouseMove={onMouseMove}>
            {lyricsSources.map((src) => {
              const label = t(LYRICS_SOURCE_LABEL_KEYS[src.id]);
              const edge = isDragging ? dropEdge(src.id) : null;
              return (
                <div
                  key={src.id}
                  data-reorder-id={src.id}
                  className="sidebar-customizer-row"
                  style={{
                    borderTop:    edge === 'before' ? '2px solid var(--accent)' : undefined,
                    borderBottom: edge === 'after'  ? '2px solid var(--accent)' : undefined,
                  }}
                >
                  <ReorderGripHandle id={src.id} type={REORDER_TYPE} label={label} />
                  <span style={{ flex: 1, fontSize: 14, opacity: src.enabled ? 1 : 0.45 }}>{label}</span>
                  <label className="toggle-switch" aria-label={label}>
                    <input type="checkbox" checked={src.enabled} onChange={() => toggleSource(src.id)} />
                    <span className="toggle-track" />
                  </label>
                </div>
              );
            })}
          </div>
        </SettingsField>
      </SettingsSubCard>

      {/* Static-only toggle — suppresses line/word tracking in both modes. */}
      <SettingsToggle
        label={t('settings.lyricsStaticOnly')}
        desc={t('settings.lyricsStaticOnlyDesc')}
        checked={lyricsStaticOnly}
        onChange={setLyricsStaticOnly}
      />
    </>
  );
}

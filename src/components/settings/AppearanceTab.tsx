import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { LayoutGrid, Palette, Sliders, Type, ZoomIn } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import {
  LIBRARY_GRID_MAX_COLUMNS_MAX,
  LIBRARY_GRID_MAX_COLUMNS_MIN,
} from '../../store/authStoreDefaults';
import type { SeekbarStyle } from '../../store/authStoreTypes';
import { useFontStore, FontId } from '../../store/fontStore';
import { useThemeStore } from '../../store/themeStore';
import { IS_LINUX, IS_WINDOWS } from '../../utils/platform';
import SettingsSubSection from '../SettingsSubSection';
import { SeekbarPreview } from '../WaveformSeekPreview';

export function AppearanceTab() {
  const { t } = useTranslation();
  const auth = useAuthStore();
  const theme = useThemeStore();
  const fontStore = useFontStore();
  const [isTilingWm, setIsTilingWm] = useState(false);

  useEffect(() => {
    if (!IS_LINUX) return;
    invoke<boolean>('is_tiling_wm_cmd').then(setIsTilingWm).catch(() => {});
  }, []);

  return (
    <>
      <SettingsSubSection
        title={t('settings.libraryGridMaxColumnsTitle')}
        icon={<LayoutGrid size={16} />}
      >
        <div className="settings-card">
          <div className="settings-hint settings-hint-info" style={{ marginBottom: '0.75rem' }}>
            {t('settings.libraryGridMaxColumnsPerfHint')}
          </div>
          <div className="form-group">
            <label className="settings-label" htmlFor="library-grid-max-cols">
              {t('settings.libraryGridMaxColumnsRangeLabel', {
                min: LIBRARY_GRID_MAX_COLUMNS_MIN,
                max: LIBRARY_GRID_MAX_COLUMNS_MAX,
              })}
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: 8 }}>
              <input
                id="library-grid-max-cols"
                type="range"
                min={LIBRARY_GRID_MAX_COLUMNS_MIN}
                max={LIBRARY_GRID_MAX_COLUMNS_MAX}
                step={1}
                value={auth.libraryGridMaxColumns}
                onChange={e => auth.setLibraryGridMaxColumns(Number(e.target.value))}
                style={{ flex: 1, maxWidth: 360 }}
                aria-valuemin={LIBRARY_GRID_MAX_COLUMNS_MIN}
                aria-valuemax={LIBRARY_GRID_MAX_COLUMNS_MAX}
                aria-valuenow={auth.libraryGridMaxColumns}
              />
              <span style={{ minWidth: 28, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {auth.libraryGridMaxColumns}
              </span>
            </div>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: '0.75rem', lineHeight: 1.45 }}>
            {t('settings.libraryGridMaxColumnsDesc')}
          </p>
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.visualOptionsTitle')}
        icon={<Palette size={16} />}
      >
        <div className="settings-card">
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.coverArtBackground')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.coverArtBackgroundSub')}</div>
            </div>
            <label className="toggle-switch">
              <input type="checkbox" checked={theme.enableCoverArtBackground} onChange={e => theme.setEnableCoverArtBackground(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
          <div className="settings-section-divider" />
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.playlistCoverPhoto')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.playlistCoverPhotoSub')}</div>
            </div>
            <label className="toggle-switch">
              <input type="checkbox" checked={theme.enablePlaylistCoverPhoto} onChange={e => theme.setEnablePlaylistCoverPhoto(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
          <div className="settings-section-divider" />
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.showBitrate')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.showBitrateSub')}</div>
            </div>
            <label className="toggle-switch">
              <input type="checkbox" checked={theme.showBitrate} onChange={e => theme.setShowBitrate(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
          <div className="settings-section-divider" />
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.floatingPlayerBar')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.floatingPlayerBarSub')}</div>
            </div>
            <label className="toggle-switch">
              <input type="checkbox" checked={theme.floatingPlayerBar} onChange={e => theme.setFloatingPlayerBar(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
          <div className="settings-section-divider" />
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.showArtistImages')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.showArtistImagesDesc')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.showArtistImages')}>
              <input type="checkbox" checked={auth.showArtistImages} onChange={e => auth.setShowArtistImages(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
          <div className="settings-section-divider" />
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.showOrbitTrigger')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.showOrbitTriggerDesc')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.showOrbitTrigger')}>
              <input type="checkbox" checked={auth.showOrbitTrigger} onChange={e => auth.setShowOrbitTrigger(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
          {!IS_WINDOWS && (
            <>
              <div className="settings-section-divider" />
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.preloadMiniPlayer')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.preloadMiniPlayerDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.preloadMiniPlayer')}>
                  <input
                    type="checkbox"
                    checked={auth.preloadMiniPlayer}
                    onChange={e => auth.setPreloadMiniPlayer(e.target.checked)}
                  />
                  <span className="toggle-track" />
                </label>
              </div>
            </>
          )}
          {IS_LINUX && !isTilingWm && (
            <>
              <div className="settings-section-divider" />
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.useCustomTitlebar')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.useCustomTitlebarDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.useCustomTitlebar')}>
                  <input type="checkbox" checked={auth.useCustomTitlebar} onChange={e => auth.setUseCustomTitlebar(e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
            </>
          )}
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.uiScaleTitle')}
        icon={<ZoomIn size={16} />}
      >
        <div className="settings-card">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.uiScaleLabel')}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', minWidth: 40, textAlign: 'right' }}>
                {Math.round(fontStore.uiScale * 100)}%
              </span>
            </div>
            {(() => {
              const presets = [80, 90, 100, 110, 125, 150];
              const currentPct = Math.round(fontStore.uiScale * 100);
              let idx = presets.indexOf(currentPct);
              if (idx < 0) {
                // Snap legacy off-preset values to the closest preset.
                idx = presets.reduce((best, p, i) =>
                  Math.abs(p - currentPct) < Math.abs(presets[best] - currentPct) ? i : best, 0);
              }
              return (
                <>
                  <input
                    type="range"
                    min={0}
                    max={presets.length - 1}
                    step={1}
                    value={idx}
                    onChange={e => fontStore.setUiScale(presets[parseInt(e.target.value, 10)] / 100)}
                    className="ui-scale-slider"
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    {presets.map(p => {
                      const active = currentPct === p;
                      return (
                        <button
                          key={p}
                          className="btn btn-ghost"
                          style={{
                            fontSize: 11,
                            padding: '2px 6px',
                            opacity: active ? 1 : 0.5,
                            color: active ? 'var(--accent)' : undefined,
                          }}
                          onClick={() => fontStore.setUiScale(p / 100)}
                        >
                          {p}%
                        </button>
                      );
                    })}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.font')}
        icon={<Type size={16} />}
      >
        <div className="settings-card">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {(
              [
                // Accessibility-first: OpenDyslexic at the top so dyslexic
                // readers don't have to scroll past 14 sans-serifs to find it.
                { id: 'opendyslexic',      label: 'OpenDyslexic',      stack: "'OpenDyslexic', sans-serif", hint: t('settings.fontHintOpenDyslexic') },
                { id: 'inter',             label: 'Inter',             stack: "'Inter Variable', sans-serif" },
                { id: 'outfit',            label: 'Outfit',            stack: "'Outfit Variable', sans-serif" },
                { id: 'dm-sans',           label: 'DM Sans',           stack: "'DM Sans Variable', sans-serif" },
                { id: 'nunito',            label: 'Nunito',            stack: "'Nunito Variable', sans-serif" },
                { id: 'rubik',             label: 'Rubik',             stack: "'Rubik Variable', sans-serif" },
                { id: 'space-grotesk',     label: 'Space Grotesk',     stack: "'Space Grotesk Variable', sans-serif" },
                { id: 'figtree',           label: 'Figtree',           stack: "'Figtree Variable', sans-serif" },
                { id: 'manrope',           label: 'Manrope',           stack: "'Manrope Variable', sans-serif" },
                { id: 'plus-jakarta-sans', label: 'Plus Jakarta Sans', stack: "'Plus Jakarta Sans Variable', sans-serif" },
                { id: 'lexend',            label: 'Lexend',            stack: "'Lexend Variable', sans-serif" },
                { id: 'geist',             label: 'Geist',             stack: "'Geist Variable', sans-serif" },
                { id: 'jetbrains-mono',    label: 'JetBrains Mono',    stack: "'JetBrains Mono Variable', monospace" },
                { id: 'golos-text',        label: 'Golos Text',        stack: "'Golos Text Variable', sans-serif" },
                { id: 'unbounded',         label: 'Unbounded',         stack: "'Unbounded Variable', sans-serif" },
              ] as { id: FontId; label: string; stack: string; hint?: string }[]
            ).map(f => (
              <button
                key={f.id}
                className={`btn ${fontStore.font === f.id ? 'btn-primary' : 'btn-ghost'}`}
                style={{
                  justifyContent: 'flex-start',
                  fontFamily: f.stack,
                  ...(f.hint ? { flexDirection: 'column', alignItems: 'flex-start', gap: '2px', paddingTop: '8px', paddingBottom: '8px' } : null),
                }}
                onClick={() => fontStore.setFont(f.id)}
              >
                <span>{f.label}</span>
                {f.hint && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-sans)' }}>
                    {f.hint}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.seekbarStyle')}
        icon={<Sliders size={16} />}
      >
        <div className="settings-card">
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            {t('settings.seekbarStyleDesc')}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {(['truewave', 'pseudowave', 'linedot', 'bar', 'thick', 'segmented', 'neon', 'pulsewave', 'particletrail', 'liquidfill', 'retrotape'] as SeekbarStyle[]).map(style => (
              <SeekbarPreview
                key={style}
                style={style}
                label={t(`settings.seekbar${style.charAt(0).toUpperCase() + style.slice(1)}` as any)}
                selected={auth.seekbarStyle === style}
                onClick={() => auth.setSeekbarStyle(style)}
              />
            ))}
          </div>
        </div>
      </SettingsSubSection>
    </>
  );
}

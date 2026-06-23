import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { LayoutGrid, Palette, Sliders, Type, ZoomIn } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import {
  LIBRARY_GRID_MAX_COLUMNS_MAX,
  LIBRARY_GRID_MAX_COLUMNS_MIN,
} from '../../store/authStoreDefaults';
import type { SeekbarStyle, WindowButtonStyle } from '../../store/authStoreTypes';
import { useFontStore, FontId } from '../../store/fontStore';
import { useThemeStore } from '../../store/themeStore';
import { IS_LINUX, IS_WINDOWS } from '../../utils/platform';
import SettingsSubSection from '../SettingsSubSection';
import { SettingsGroup } from './SettingsGroup';
import { SettingsToggle } from './SettingsToggle';
import { SeekbarPreview } from '../WaveformSeekPreview';
import WindowButtonPreview from '../WindowButtonPreview';

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
          <SettingsGroup>
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
          </SettingsGroup>
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.visualOptionsTitle')}
        icon={<Palette size={16} />}
      >
        <div className="settings-card">
          <SettingsGroup title={t('settings.groupDisplay')}>
            <SettingsToggle
              label={t('settings.coverArtBackground')}
              desc={t('settings.coverArtBackgroundSub')}
              checked={theme.enableCoverArtBackground}
              onChange={theme.setEnableCoverArtBackground}
            />
            <div className="settings-section-divider" />
            <SettingsToggle
              label={t('settings.playlistCoverPhoto')}
              desc={t('settings.playlistCoverPhotoSub')}
              checked={theme.enablePlaylistCoverPhoto}
              onChange={theme.setEnablePlaylistCoverPhoto}
            />
            <div className="settings-section-divider" />
            <SettingsToggle
              label={t('settings.showBitrate')}
              desc={t('settings.showBitrateSub')}
              checked={theme.showBitrate}
              onChange={theme.setShowBitrate}
            />
            <div className="settings-section-divider" />
            <SettingsToggle
              label={t('settings.floatingPlayerBar')}
              desc={t('settings.floatingPlayerBarSub')}
              checked={theme.floatingPlayerBar}
              onChange={theme.setFloatingPlayerBar}
            />
            <div className="settings-section-divider" />
            <SettingsToggle
              label={t('settings.showArtistImages')}
              desc={t('settings.showArtistImagesDesc')}
              checked={auth.showArtistImages}
              onChange={auth.setShowArtistImages}
            />
            <div className="settings-section-divider" />
            <SettingsToggle
              label={t('settings.showOrbitTrigger')}
              desc={t('settings.showOrbitTriggerDesc')}
              checked={auth.showOrbitTrigger}
              onChange={auth.setShowOrbitTrigger}
            />
            {!IS_WINDOWS && (
              <>
                <div className="settings-section-divider" />
                <SettingsToggle
                  label={t('settings.preloadMiniPlayer')}
                  desc={t('settings.preloadMiniPlayerDesc')}
                  checked={auth.preloadMiniPlayer}
                  onChange={auth.setPreloadMiniPlayer}
                />
              </>
            )}
          </SettingsGroup>

          {IS_LINUX && !isTilingWm && (
            <SettingsGroup title={t('settings.groupWindow')}>
              <SettingsToggle
                label={t('settings.useCustomTitlebar')}
                desc={t('settings.useCustomTitlebarDesc')}
                checked={auth.useCustomTitlebar}
                onChange={auth.setUseCustomTitlebar}
              />
              {auth.useCustomTitlebar && (
                <>
                  <div className="settings-section-divider" />
                  <div>
                    <div style={{ fontWeight: 500 }}>{t('settings.windowButtonStyle')}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                      {t('settings.windowButtonStyleDesc')}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      {(['dots', 'dotsGlyph', 'flat', 'pill', 'outline', 'glyph'] as WindowButtonStyle[]).map(style => (
                        <WindowButtonPreview
                          key={style}
                          style={style}
                          label={t(`settings.windowButtons${style.charAt(0).toUpperCase() + style.slice(1)}`)}
                          selected={auth.windowButtonStyle === style}
                          onClick={() => auth.setWindowButtonStyle(style)}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="settings-section-divider" />
                  <SettingsToggle
                    label={t('settings.showMinimizeButton')}
                    desc={t('settings.showMinimizeButtonDesc')}
                    checked={auth.showMinimizeButton}
                    onChange={auth.setShowMinimizeButton}
                  />
                </>
              )}
            </SettingsGroup>
          )}
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.uiScaleTitle')}
        icon={<ZoomIn size={16} />}
      >
        <div className="settings-card">
          <SettingsGroup>
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
          </SettingsGroup>
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.font')}
        icon={<Type size={16} />}
      >
        <div className="settings-card">
          <SettingsGroup>
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
          </SettingsGroup>
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.seekbarStyle')}
        icon={<Sliders size={16} />}
      >
        <div className="settings-card">
          <SettingsGroup>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
              {t('settings.seekbarStyleDesc')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {(['truewave', 'pseudowave', 'linedot', 'bar', 'thick', 'segmented', 'neon', 'pulsewave', 'particletrail', 'liquidfill', 'retrotape'] as SeekbarStyle[]).map(style => (
                <SeekbarPreview
                  key={style}
                  style={style}
                  label={t(`settings.seekbar${style.charAt(0).toUpperCase() + style.slice(1)}`)}
                  selected={auth.seekbarStyle === style}
                  onClick={() => auth.setSeekbarStyle(style)}
                />
              ))}
            </div>
          </SettingsGroup>
        </div>
      </SettingsSubSection>
    </>
  );
}

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Clock, Maximize2, Palette, Sliders, Type, ZoomIn } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import type { SeekbarStyle } from '../../store/authStoreTypes';
import { useFontStore, FontId } from '../../store/fontStore';
import { useThemeStore } from '../../store/themeStore';
import { IS_LINUX, IS_WINDOWS } from '../../utils/platform';
import CustomSelect from '../CustomSelect';
import SettingsSubSection from '../SettingsSubSection';
import ThemePicker, { THEME_GROUPS } from '../ThemePicker';
import { SeekbarPreview } from '../WaveformSeek';

export function AppearanceTab() {
  const { t, i18n } = useTranslation();
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
        title={t('settings.theme')}
        icon={<Palette size={16} />}
      >
        <div className="settings-card">
          {theme.enableThemeScheduler && (
            <div className="settings-hint settings-hint-info" style={{ marginBottom: '0.75rem' }}>
              {t('settings.themeSchedulerActiveHint')}
            </div>
          )}
          <ThemePicker value={theme.theme} onChange={v => theme.setTheme(v as any)} />
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.themeSchedulerTitle')}
        icon={<Clock size={16} />}
      >
        <div className="settings-card">
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.themeSchedulerEnable')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.themeSchedulerEnableSub')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.themeSchedulerEnable')}>
              <input type="checkbox" checked={theme.enableThemeScheduler} onChange={e => theme.setEnableThemeScheduler(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
          {theme.enableThemeScheduler && (() => {
            const themeOptions = THEME_GROUPS.flatMap(g =>
              g.themes.map(th => ({
                value: th.id,
                label: th.family ? `${th.family} ${th.label}` : th.label,
                group: g.group,
              }))
            );
            const use12h = i18n.language === 'en';
            const hourOptions = Array.from({ length: 24 }, (_, i) => {
              const value = String(i).padStart(2, '0');
              const label = use12h
                ? `${i % 12 === 0 ? 12 : i % 12} ${i < 12 ? 'AM' : 'PM'}`
                : value;
              return { value, label };
            });
            const minuteOptions = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'].map(m => ({ value: m, label: m }));
            const dayH = theme.timeDayStart.split(':')[0];
            const dayM = theme.timeDayStart.split(':')[1];
            const nightH = theme.timeNightStart.split(':')[0];
            const nightM = theme.timeNightStart.split(':')[1];
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
                <div className="form-group">
                  <label className="settings-label" style={{ marginBottom: 6 }}>{t('settings.themeSchedulerDayTheme')}</label>
                  <CustomSelect value={theme.themeDay} onChange={theme.setThemeDay} options={themeOptions} />
                </div>
                <div className="form-group">
                  <label className="settings-label" style={{ marginBottom: 6 }}>{t('settings.themeSchedulerDayStart')}</label>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <CustomSelect value={dayH} onChange={v => theme.setTimeDayStart(`${v}:${dayM}`)} options={hourOptions} />
                    <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>:</span>
                    <CustomSelect value={dayM} onChange={v => theme.setTimeDayStart(`${dayH}:${v}`)} options={minuteOptions} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="settings-label" style={{ marginBottom: 6 }}>{t('settings.themeSchedulerNightTheme')}</label>
                  <CustomSelect value={theme.themeNight} onChange={theme.setThemeNight} options={themeOptions} />
                </div>
                <div className="form-group">
                  <label className="settings-label" style={{ marginBottom: 6 }}>{t('settings.themeSchedulerNightStart')}</label>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <CustomSelect value={nightH} onChange={v => theme.setTimeNightStart(`${v}:${nightM}`)} options={hourOptions} />
                    <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>:</span>
                    <CustomSelect value={nightM} onChange={v => theme.setTimeNightStart(`${nightH}:${v}`)} options={minuteOptions} />
                  </div>
                </div>
              </div>
            );
          })()}
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
        title={t('settings.fsPlayerSection')}
        icon={<Maximize2 size={16} />}
      >
        <div className="settings-card">
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.fsShowArtistPortrait')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.fsShowArtistPortraitDesc')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.fsShowArtistPortrait')}>
              <input type="checkbox" checked={auth.showFsArtistPortrait} onChange={e => auth.setShowFsArtistPortrait(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
          {auth.showFsArtistPortrait && (
            <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.fsPortraitDim')}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', minWidth: 36, textAlign: 'right' }}>{auth.fsPortraitDim}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={80}
                step={1}
                value={auth.fsPortraitDim}
                onChange={e => auth.setFsPortraitDim(parseInt(e.target.value, 10))}
                className="ui-scale-slider"
              />
            </div>
          )}
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

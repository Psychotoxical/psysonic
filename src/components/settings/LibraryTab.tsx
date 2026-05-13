import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Shuffle, Star } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { MIX_MIN_RATING_FILTER_MAX_STARS } from '../../store/authStoreDefaults';
import SettingsSubSection from '../SettingsSubSection';
import StarRating from '../StarRating';

const AUDIOBOOK_GENRES_DISPLAY = ['Hörbuch', 'Hoerbuch', 'Hörspiel', 'Hoerspiel', 'Audiobook', 'Audio Book', 'Spoken Word', 'Spokenword', 'Podcast', 'Kapitel', 'Thriller', 'Krimi', 'Speech', 'Fantasy', 'Comedy', 'Literature'];

export function LibraryTab() {
  const { t } = useTranslation();
  const auth = useAuthStore();
  const [newGenre, setNewGenre] = useState('');

  return (
    <>
      {/* Random Mix Blacklist */}
      <SettingsSubSection
        title={t('settings.randomMixTitle')}
        icon={<Shuffle size={16} />}
      >
        <div className="settings-card">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: '1rem', lineHeight: 1.5 }}>
            {t('settings.randomMixBlacklistDesc')}
          </p>

          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: '0.5rem' }}>{t('settings.randomMixBlacklistTitle')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.75rem', minHeight: 32 }}>
            {auth.customGenreBlacklist.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>{t('settings.randomMixBlacklistEmpty')}</span>
            ) : (
              auth.customGenreBlacklist.map(genre => (
                <span key={genre} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                  color: 'var(--accent)', borderRadius: 'var(--radius-sm)',
                  padding: '2px 8px', fontSize: 12, fontWeight: 500,
                }}>
                  {genre}
                  <button
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, lineHeight: 1, fontSize: 14 }}
                    onClick={() => auth.setCustomGenreBlacklist(auth.customGenreBlacklist.filter(g => g !== genre))}
                    aria-label={`Remove ${genre}`}
                  >×</button>
                </span>
              ))
            )}
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', maxWidth: 400 }}>
            <input
              className="input"
              type="text"
              value={newGenre}
              onChange={e => setNewGenre(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newGenre.trim()) {
                  const trimmed = newGenre.trim();
                  if (!auth.customGenreBlacklist.includes(trimmed)) {
                    auth.setCustomGenreBlacklist([...auth.customGenreBlacklist, trimmed]);
                  }
                  setNewGenre('');
                }
              }}
              placeholder={t('settings.randomMixBlacklistPlaceholder')}
              style={{ fontSize: 13 }}
            />
            <button
              className="btn btn-ghost"
              onClick={() => {
                const trimmed = newGenre.trim();
                if (trimmed && !auth.customGenreBlacklist.includes(trimmed)) {
                  auth.setCustomGenreBlacklist([...auth.customGenreBlacklist, trimmed]);
                }
                setNewGenre('');
              }}
              disabled={!newGenre.trim()}
            >
              {t('settings.randomMixBlacklistAdd')}
            </button>
          </div>

          <div className="divider" style={{ margin: '1rem 0' }} />

          <div className="settings-toggle-row" style={{ marginBottom: '1rem' }}>
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.luckyMixMenuTitle')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('settings.luckyMixMenuDesc')}
              </div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.luckyMixMenuTitle')}>
              <input
                type="checkbox"
                checked={auth.showLuckyMixMenu}
                onChange={e => auth.setShowLuckyMixMenu(e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>

          <div className="divider" style={{ margin: '1rem 0' }} />

          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: '0.5rem', color: 'var(--text-muted)' }}>{t('settings.randomMixHardcodedTitle')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {AUDIOBOOK_GENRES_DISPLAY.map(genre => (
              <span key={genre} className="genre-keyword-badge" style={{
                display: 'inline-flex', alignItems: 'center',
                background: 'var(--bg-hover)', color: 'var(--text-muted)',
                borderRadius: 'var(--radius-sm)', padding: '2px 8px', fontSize: 12,
              }}>
                {genre}
              </span>
            ))}
          </div>
        </div>
      </SettingsSubSection>

      {/* Ratings */}
      <SettingsSubSection
        title={t('settings.ratingsSectionTitle')}
        icon={<Star size={16} />}
      >
        <div className="settings-card">
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.ratingsSkipStarTitle')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.ratingsSkipStarDesc')}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
              {auth.skipStarOnManualSkipsEnabled && (
                <>
                  <label htmlFor="settings-skip-star-threshold" style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                    {t('settings.ratingsSkipStarThresholdLabel')}
                  </label>
                  <input
                    id="settings-skip-star-threshold"
                    className="input"
                    type="number"
                    min={1}
                    max={99}
                    value={auth.skipStarManualSkipThreshold}
                    onChange={e => auth.setSkipStarManualSkipThreshold(Number(e.target.value))}
                    style={{ width: 72, padding: '6px 10px', fontSize: 13 }}
                    aria-label={t('settings.ratingsSkipStarThresholdLabel')}
                  />
                </>
              )}
              <label className="toggle-switch" aria-label={t('settings.ratingsSkipStarTitle')}>
                <input
                  type="checkbox"
                  checked={auth.skipStarOnManualSkipsEnabled}
                  onChange={e => auth.setSkipStarOnManualSkipsEnabled(e.target.checked)}
                />
                <span className="toggle-track" />
              </label>
            </div>
          </div>

          <div className="settings-section-divider" />

          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.ratingsMixFilterTitle')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('settings.ratingsMixFilterDesc', {
                  mix: t('sidebar.randomMix'),
                  albums: t('sidebar.randomAlbums'),
                })}
              </div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.ratingsMixFilterTitle')}>
              <input
                type="checkbox"
                checked={auth.mixMinRatingFilterEnabled}
                onChange={e => auth.setMixMinRatingFilterEnabled(e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>
          {auth.mixMinRatingFilterEnabled && (
            <>
              <div className="settings-section-divider" />
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))',
                  gap: '1rem 0.75rem',
                  alignItems: 'start',
                }}
              >
                {([
                  { key: 'song', label: t('settings.ratingsMixMinSong'), value: auth.mixMinRatingSong, set: auth.setMixMinRatingSong },
                  { key: 'album', label: t('settings.ratingsMixMinAlbum'), value: auth.mixMinRatingAlbum, set: auth.setMixMinRatingAlbum },
                  { key: 'artist', label: t('settings.ratingsMixMinArtist'), value: auth.mixMinRatingArtist, set: auth.setMixMinRatingArtist },
                ] as const).map(row => (
                  <div
                    key={row.key}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 8,
                      minWidth: 0,
                      textAlign: 'center',
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)' }}>{row.label}</span>
                    <StarRating
                      maxSelectable={MIX_MIN_RATING_FILTER_MAX_STARS}
                      value={row.value}
                      onChange={row.set}
                      ariaLabel={t('settings.ratingsMixMinThresholdAria', { label: row.label })}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </SettingsSubSection>
    </>
  );
}

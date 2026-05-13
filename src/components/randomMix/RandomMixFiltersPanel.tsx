import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { RANDOM_MIX_SIZE_OPTIONS } from '../../store/authStoreDefaults';

interface Props {
  isMobile: boolean;
  filtersExpanded: boolean;
  setFiltersExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  randomMixSize: number;
  setRandomMixSize: (n: number) => void;
  selectedGenre: string | null;
  loadGenreMix: (genre: string, overrideSize?: number) => void;
  fetchSongs: (overrideSize?: number) => void;
  excludeAudiobooks: boolean;
  setExcludeAudiobooks: (v: boolean) => void;
  blacklistOpen: boolean;
  setBlacklistOpen: React.Dispatch<React.SetStateAction<boolean>>;
  customGenreBlacklist: string[];
  setCustomGenreBlacklist: (next: string[]) => void;
  newGenre: string;
  setNewGenre: React.Dispatch<React.SetStateAction<string>>;
}

export default function RandomMixFiltersPanel({
  isMobile, filtersExpanded, setFiltersExpanded,
  randomMixSize, setRandomMixSize, selectedGenre, loadGenreMix, fetchSongs,
  excludeAudiobooks, setExcludeAudiobooks,
  blacklistOpen, setBlacklistOpen,
  customGenreBlacklist, setCustomGenreBlacklist,
  newGenre, setNewGenre,
}: Props) {
  const { t } = useTranslation();

  const addCustomGenre = (trimmed: string) => {
    if (trimmed && !customGenreBlacklist.includes(trimmed)) {
      setCustomGenreBlacklist([...customGenreBlacklist, trimmed]);
    }
    setNewGenre('');
  };

  return (
    <div style={{ background: 'var(--bg-card)', padding: '1rem 1.25rem' }}>
      {isMobile ? (
        <button
          className="btn btn-ghost"
          style={{ width: '100%', justifyContent: 'space-between', fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', padding: '0' }}
          onClick={() => setFiltersExpanded(v => !v)}
        >
          {t('randomMix.filterPanelTitle')}
          {filtersExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      ) : (
        <div style={{ fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', marginBottom: '0.85rem' }}>
          {t('randomMix.filterPanelTitle')}
        </div>
      )}
      {(!isMobile || filtersExpanded) && (
        <div style={{ marginTop: isMobile ? '0.75rem' : 0 }}>
          <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
            {t('randomMix.mixSettingsHeader')}
          </div>

          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 0, marginBottom: '0.6rem', lineHeight: 1.45, fontStyle: 'italic' }}>
            {t('randomMix.filterPanelInexactSizeNote')}
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.25rem' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('randomMix.mixSize')}</span>
            {RANDOM_MIX_SIZE_OPTIONS.map(n => (
              <button
                key={n}
                className={`btn ${randomMixSize === n ? 'btn-primary' : 'btn-surface'}`}
                style={{ fontSize: 12, padding: '3px 10px' }}
                onClick={() => {
                  if (n === randomMixSize) return;
                  setRandomMixSize(n);
                  if (selectedGenre) loadGenreMix(selectedGenre, n);
                  else fetchSongs(n);
                }}
              >{n}</button>
            ))}
          </div>

          <div style={{ borderTop: '1px solid var(--border)', margin: '0.85rem 0' }} />

          <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
            {t('randomMix.exclusionsHeader')}
          </div>

          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: '0.6rem', lineHeight: 1.45 }}>
            {t('randomMix.filterPanelDesc')}
          </p>

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer', fontSize: 13, marginBottom: '0.6rem' }}>
            <input
              type="checkbox"
              checked={excludeAudiobooks}
              onChange={e => setExcludeAudiobooks(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <div>
              <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{t('randomMix.excludeAudiobooks')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{t('randomMix.excludeAudiobooksDesc')}</div>
            </div>
          </label>

          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: '3px 8px', marginBottom: blacklistOpen ? '0.5rem' : 0 }}
            onClick={() => setBlacklistOpen(v => !v)}
          >
            {blacklistOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {t('randomMix.blacklistToggle')} ({customGenreBlacklist.length})
          </button>

          {blacklistOpen && (
            <div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.5rem', minHeight: 24 }}>
                {customGenreBlacklist.length === 0 ? (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('settings.randomMixBlacklistEmpty')}</span>
                ) : (
                  customGenreBlacklist.map(genre => (
                    <span key={genre} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 3,
                      background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                      color: 'var(--accent)', borderRadius: 'var(--radius-sm)',
                      padding: '1px 7px', fontSize: 11, fontWeight: 500,
                    }}>
                      {genre}
                      <button
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, lineHeight: 1, fontSize: 13 }}
                        onClick={() => setCustomGenreBlacklist(customGenreBlacklist.filter(g => g !== genre))}
                      >×</button>
                    </span>
                  ))
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <input
                  className="input"
                  type="text"
                  value={newGenre}
                  onChange={e => setNewGenre(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newGenre.trim()) addCustomGenre(newGenre.trim());
                  }}
                  placeholder={t('settings.randomMixBlacklistPlaceholder')}
                  style={{ fontSize: 12 }}
                />
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 12, padding: '4px 10px', flexShrink: 0 }}
                  onClick={() => addCustomGenre(newGenre.trim())}
                  disabled={!newGenre.trim()}
                >{t('settings.randomMixBlacklistAdd')}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

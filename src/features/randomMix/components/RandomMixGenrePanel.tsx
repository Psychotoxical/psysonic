import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';

interface Props {
  isMobile: boolean;
  genreMixExpanded: boolean;
  setGenreMixExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  genresLoading: boolean;
  serverGenresLength: number;
  displayedGenres: string[];
  allAvailableGenresLength: number;
  selectedGenres: string[];
  genreMixLoading: boolean;
  onSelectAll: () => void;
  onToggleGenre: (genre: string) => void;
  onShuffle: () => void;
}

export default function RandomMixGenrePanel({
  isMobile, genreMixExpanded, setGenreMixExpanded,
  genresLoading, serverGenresLength, displayedGenres, allAvailableGenresLength,
  selectedGenres, genreMixLoading, onSelectAll, onToggleGenre, onShuffle,
}: Props) {
  const { t } = useTranslation();

  return (
    <div style={{ background: 'var(--bg-card)', padding: '1rem 1.25rem' }}>
      {isMobile ? (
        <button
          className="btn btn-ghost"
          style={{ width: '100%', justifyContent: 'space-between', fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', padding: '0' }}
          onClick={() => setGenreMixExpanded(v => !v)}
        >
          {t('randomMix.genreMixTitle')}
          {genreMixExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      ) : (
        <div style={{ fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', marginBottom: '0.85rem' }}>
          {t('randomMix.genreMixTitle')}
        </div>
      )}
      {(!isMobile || genreMixExpanded) && (
        <div style={{ marginTop: isMobile ? '0.75rem' : 0 }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>{t('randomMix.genreMixDesc')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
            {genresLoading ? (
              <div className="spinner" style={{ width: 14, height: 14 }} />
            ) : serverGenresLength === 0 || displayedGenres.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('randomMix.genreMixNoGenres')}</span>
            ) : (
              <>
                <button
                  type="button"
                  className={`btn ${selectedGenres.length === 0 ? 'btn-primary' : 'btn-surface'}`}
                  style={{ fontSize: 12, padding: '4px 12px' }}
                  onClick={onSelectAll}
                  aria-pressed={selectedGenres.length === 0}
                >
                  {t('randomMix.genreMixAll')}
                </button>
                {displayedGenres.map(genre => (
                  <button
                    key={genre}
                    type="button"
                    className={`btn ${selectedGenres.includes(genre) ? 'btn-primary' : 'btn-surface'}`}
                    style={{ fontSize: 12, padding: '4px 12px' }}
                    onClick={() => onToggleGenre(genre)}
                    aria-pressed={selectedGenres.includes(genre)}
                  >
                    {genre}
                  </button>
                ))}
                {allAvailableGenresLength > 20 && (
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 12, padding: '4px 10px', flexShrink: 0 }}
                    onClick={onShuffle}
                    disabled={genreMixLoading}
                    data-tooltip={t('randomMix.shuffleGenres')}
                  >
                    <RefreshCw size={12} />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

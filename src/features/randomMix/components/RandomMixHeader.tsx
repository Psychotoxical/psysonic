import React from 'react';
import { useTranslation } from 'react-i18next';
import { Play, RefreshCw } from 'lucide-react';

interface Props {
  hasSelectedGenres: boolean;
  selectedGenreLabel: string | null;
  loading: boolean;
  genreMixLoading: boolean;
  genreMixComplete: boolean;
  genreMixSongsLength: number;
  filteredSongsLength: number;
  randomMixSize: number;
  onRefresh: () => void;
  onPlayAll: () => void;
}

export default function RandomMixHeader({
  hasSelectedGenres, selectedGenreLabel, loading, genreMixLoading, genreMixComplete,
  genreMixSongsLength, filteredSongsLength, randomMixSize,
  onRefresh, onPlayAll,
}: Props) {
  const { t } = useTranslation();
  const isGenreLoading = hasSelectedGenres && !genreMixComplete;
  const isPlayDisabled = loading
    || (hasSelectedGenres ? !genreMixComplete || genreMixSongsLength === 0 : filteredSongsLength === 0);
  const remixLabel = selectedGenreLabel
    ? t('randomMix.remixGenre', { genre: selectedGenreLabel })
    : t('randomMix.remix');
  const remixTooltip = selectedGenreLabel
    ? t('randomMix.remixTooltipGenre', { genre: selectedGenreLabel })
    : t('randomMix.remixTooltip');

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
      <h1 className="page-title">{t('randomMix.title')}</h1>

      <div className="compact-action-bar" style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          className="btn btn-surface"
          onClick={onRefresh}
          disabled={hasSelectedGenres ? genreMixLoading : loading}
          aria-label={remixLabel}
          data-tooltip={remixTooltip}
        >
          <RefreshCw size={18} className={(hasSelectedGenres ? genreMixLoading : loading) ? 'spin' : ''} />
          <span className="compact-btn-label">{remixLabel}</span>
        </button>
        <button
          className={`btn ${isGenreLoading ? 'btn-surface' : 'btn-primary'}`}
          onClick={onPlayAll}
          disabled={isPlayDisabled}
          aria-label={t('randomMix.playAll')}
          data-tooltip={t('randomMix.playAll')}
        >
          {isGenreLoading ? (
            <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> <span className="compact-btn-label">{Math.min(genreMixSongsLength, randomMixSize)} / {randomMixSize}</span></>
          ) : (
            <><Play size={18} fill="currentColor" /> <span className="compact-btn-label">{t('randomMix.playAll')}</span></>
          )}
        </button>
      </div>
    </div>
  );
}

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Play, RefreshCw } from 'lucide-react';

interface Props {
  selectedGenre: string | null;
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
  selectedGenre, loading, genreMixLoading, genreMixComplete,
  genreMixSongsLength, filteredSongsLength, randomMixSize,
  onRefresh, onPlayAll,
}: Props) {
  const { t } = useTranslation();
  const isGenreLoading = selectedGenre && !genreMixComplete;
  const isPlayDisabled = loading
    || (selectedGenre ? !genreMixComplete || genreMixSongsLength === 0 : filteredSongsLength === 0);

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
      <h1 className="page-title">{t('randomMix.title')}</h1>

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          className="btn btn-surface"
          onClick={onRefresh}
          disabled={selectedGenre ? genreMixLoading : loading}
          data-tooltip={selectedGenre
            ? t('randomMix.remixTooltipGenre', { genre: selectedGenre })
            : t('randomMix.remixTooltip')
          }
        >
          <RefreshCw size={18} className={(selectedGenre ? genreMixLoading : loading) ? 'spin' : ''} />
          {selectedGenre ? t('randomMix.remixGenre', { genre: selectedGenre }) : t('randomMix.remix')}
        </button>
        <button
          className={`btn ${isGenreLoading ? 'btn-surface' : 'btn-primary'}`}
          onClick={onPlayAll}
          disabled={isPlayDisabled}
        >
          {isGenreLoading ? (
            <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> {Math.min(genreMixSongsLength, randomMixSize)} / {randomMixSize}</>
          ) : (
            <><Play size={18} fill="currentColor" /> {t('randomMix.playAll')}</>
          )}
        </button>
      </div>
    </div>
  );
}

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import StarRating from '@/ui/StarRating';
import CustomSelect from '@/ui/CustomSelect';
import {
  LIMIT_MAX, YEAR_MAX, YEAR_MIN, clampYear, type SmartFilters,
} from '@/features/playlist/utils/playlistsSmart';

interface Props {
  smartFilters: SmartFilters;
  setSmartFilters: React.Dispatch<React.SetStateAction<SmartFilters>>;
  availableGenres: string[];
  genreQuery: string;
  setGenreQuery: React.Dispatch<React.SetStateAction<string>>;
}

export default function PlaylistsSmartEditorBasic({
  smartFilters, setSmartFilters, availableGenres, genreQuery, setGenreQuery,
}: Props) {
  const { t } = useTranslation();

  const sortOptions = useMemo(() => ([
    { value: '', label: t('smartPlaylists.sortNone') },
    { value: '+random', label: t('smartPlaylists.sortRandom') },
    { value: '+title', label: t('smartPlaylists.sortTitleAsc') },
    { value: '-title', label: t('smartPlaylists.sortTitleDesc') },
    { value: '-year', label: t('smartPlaylists.sortYearDesc') },
    { value: '+year', label: t('smartPlaylists.sortYearAsc') },
    { value: '-playcount', label: t('smartPlaylists.sortPlayCountDesc') },
  ]), [t]);

  const selectedGenreChipClass =
    smartFilters.genreMode === 'include' ? 'btn btn-primary' : 'btn btn-danger';

  const addGenre = (genre: string) => {
    setSmartFilters(v => ({
      ...v,
      untaggedGenresOnly: false,
      selectedGenres: [...v.selectedGenres, genre],
    }));
  };

  const removeGenre = (genre: string) => {
    setSmartFilters(v => ({
      ...v,
      untaggedGenresOnly: false,
      selectedGenres: v.selectedGenres.filter(x => x !== genre),
    }));
  };

  return (
    <>
      <section style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 'var(--space-3)' }}>{t('smartPlaylists.sectionBasic')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <input className="input" type="number" min={1} max={LIMIT_MAX} placeholder={t('smartPlaylists.limit')} value={smartFilters.limit} onChange={e => setSmartFilters(v => ({ ...v, limit: e.target.value }))} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('smartPlaylists.limitHint', { max: LIMIT_MAX })}</span>
          </div>
          <CustomSelect
            value={smartFilters.sort}
            options={sortOptions}
            onChange={sort => setSmartFilters(v => ({ ...v, sort }))}
          />
        </div>
      </section>
      <section style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 'var(--space-3)' }}>{t('smartPlaylists.sectionGenres')}</div>
        <div className="smart-playlist-mode-toggle" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-3)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('smartPlaylists.genreMode')}</span>
          <button
            type="button"
            className={`btn ${smartFilters.genreMode === 'include' ? 'btn-primary' : 'btn-surface'}`}
            onClick={() => setSmartFilters(v => ({ ...v, genreMode: 'include', untaggedGenresOnly: false }))}
          >
            {t('smartPlaylists.genreModeInclude')}
          </button>
          <button
            type="button"
            className={`btn ${smartFilters.genreMode === 'exclude' ? 'btn-primary' : 'btn-surface'}`}
            onClick={() => setSmartFilters(v => ({ ...v, genreMode: 'exclude', untaggedGenresOnly: false }))}
          >
            {t('smartPlaylists.genreModeExclude')}
          </button>
        </div>
        <input className="input" placeholder={t('smartPlaylists.genreSearchPlaceholder')} value={genreQuery} onChange={e => setGenreQuery(e.target.value)} style={{ marginBottom: 'var(--space-3)' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-2)', minHeight: 120 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>{t('smartPlaylists.availableGenres')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
              {availableGenres.map(g => (
                <button
                  key={g}
                  type="button"
                  className="btn btn-surface"
                  style={{ fontSize: 12, padding: '2px 8px' }}
                  onClick={() => addGenre(g)}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-2)', minHeight: 120 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>{t('smartPlaylists.selectedGenres')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
              {smartFilters.selectedGenres.map(g => (
                <button
                  key={g}
                  type="button"
                  className={selectedGenreChipClass}
                  style={{ fontSize: 12, padding: '2px 8px' }}
                  onClick={() => removeGenre(g)}
                >
                  × {g}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
      <section style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 'var(--space-3)' }}>{t('smartPlaylists.sectionYearsAndFilters')}</div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
          <input
            type="checkbox"
            checked={smartFilters.yearEnabled}
            onChange={event => setSmartFilters(v => ({ ...v, yearEnabled: event.target.checked }))}
          />
          {t('smartPlaylists.yearEnabled')}
        </label>
        <div className="smart-playlist-mode-toggle" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-3)', flexWrap: 'wrap', opacity: smartFilters.yearEnabled ? 1 : 0.5 }} aria-disabled={!smartFilters.yearEnabled}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('smartPlaylists.yearMode')}</span>
          <button
            type="button"
            className={`btn ${smartFilters.yearMode === 'include' ? 'btn-primary' : 'btn-surface'}`}
            onClick={() => setSmartFilters(v => ({ ...v, yearEnabled: true, yearMode: 'include' }))}
          >
            {t('smartPlaylists.yearModeInclude')}
          </button>
          <button
            type="button"
            className={`btn ${smartFilters.yearMode === 'exclude' ? 'btn-primary' : 'btn-surface'}`}
            onClick={() => setSmartFilters(v => ({ ...v, yearEnabled: true, yearMode: 'exclude' }))}
          >
            {t('smartPlaylists.yearModeExclude')}
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted)' }}>
          <span>{t('smartPlaylists.fromYear')}: {smartFilters.yearFrom}</span>
          <span>{t('smartPlaylists.toYear')}: {smartFilters.yearTo}</span>
        </div>
        <div className="dual-year-range" style={{ opacity: smartFilters.yearEnabled ? 1 : 0.5 }}>
          <div className="dual-year-range__track" />
          <div className="dual-year-range__selected" style={{ left: `${((smartFilters.yearFrom - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}%`, right: `${100 - ((smartFilters.yearTo - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}%` }} />
          <input type="range" min={YEAR_MIN} max={YEAR_MAX} value={smartFilters.yearFrom} disabled={!smartFilters.yearEnabled} onChange={e => setSmartFilters(v => ({ ...v, yearEnabled: true, yearFrom: Math.min(clampYear(Number(e.target.value)), v.yearTo) }))} />
          <input type="range" min={YEAR_MIN} max={YEAR_MAX} value={smartFilters.yearTo} disabled={!smartFilters.yearEnabled} onChange={e => setSmartFilters(v => ({ ...v, yearEnabled: true, yearTo: Math.max(clampYear(Number(e.target.value)), v.yearFrom) }))} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
          <input className="input" placeholder={t('smartPlaylists.artistContains')} value={smartFilters.artistContains} onChange={e => setSmartFilters(v => ({ ...v, artistContains: e.target.value }))} />
          <input className="input" placeholder={t('smartPlaylists.albumContains')} value={smartFilters.albumContains} onChange={e => setSmartFilters(v => ({ ...v, albumContains: e.target.value }))} />
          <input className="input" placeholder={t('smartPlaylists.titleContains')} value={smartFilters.titleContains} onChange={e => setSmartFilters(v => ({ ...v, titleContains: e.target.value }))} />
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('smartPlaylists.minRating')}: {smartFilters.minRating}★</div>
          <StarRating value={smartFilters.minRating} onChange={rating => setSmartFilters(v => ({ ...v, minRating: rating }))} ariaLabel={t('smartPlaylists.minRatingAria')} />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('smartPlaylists.minRatingHint')}</span>
        </div>
        <div style={{ marginTop: 'var(--space-3)', display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <input type="checkbox" checked={smartFilters.excludeUnrated} onChange={e => setSmartFilters(v => ({ ...v, excludeUnrated: e.target.checked }))} />
            {t('smartPlaylists.excludeUnrated')}
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <input type="checkbox" checked={smartFilters.compilationOnly} onChange={e => setSmartFilters(v => ({ ...v, compilationOnly: e.target.checked }))} />
            {t('smartPlaylists.compilationOnly')}
          </label>
        </div>
      </section>
    </>
  );
}

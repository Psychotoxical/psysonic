import React, { useMemo, type Dispatch, type SetStateAction } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import CustomSelect from '@/ui/CustomSelect';
import StarFilterButton from '@/ui/StarFilterButton';
import { tooltipAttrs } from '@/ui/tooltipAttrs';
import { MOOD_GROUP_IDS } from '@/config/moodGroups';
import { OXIMEDIA_MOOD_SEARCH_ENABLED } from '@/lib/library/trackEnrichment';
import type { SubsonicGenre } from '@/lib/api/subsonicTypes';
import type { ResultType } from '@/features/search/searchBrowseTypes';

const MOOD_UI_ENABLED = OXIMEDIA_MOOD_SEARCH_ENABLED;

function parseBpmInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

interface AdvancedSearchFilterPanelProps {
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  genre: string;
  setGenre: Dispatch<SetStateAction<string>>;
  genres: SubsonicGenre[];
  yearFrom: string;
  setYearFrom: Dispatch<SetStateAction<string>>;
  yearTo: string;
  setYearTo: Dispatch<SetStateAction<string>>;
  bpmFrom: string;
  setBpmFrom: Dispatch<SetStateAction<string>>;
  bpmTo: string;
  setBpmTo: Dispatch<SetStateAction<string>>;
  moodGroup: string;
  setMoodGroup: Dispatch<SetStateAction<string>>;
  losslessOnly: boolean;
  setLosslessOnly: Dispatch<SetStateAction<boolean>>;
  resultType: ResultType;
  setResultType: Dispatch<SetStateAction<ResultType>>;
  starredOnly: boolean;
  setStarredOnly: Dispatch<SetStateAction<boolean>>;
  trackFilterActive: boolean;
  indexEnabled: boolean;
  loading: boolean;
  autoFocusQuery: boolean;
  onSubmit: (e?: React.FormEvent) => void;
}

/** The advanced-search filter form (term, genre, year, BPM, lossless, mood, result-scope). */
export default function AdvancedSearchFilterPanel({
  query,
  setQuery,
  genre,
  setGenre,
  genres,
  yearFrom,
  setYearFrom,
  yearTo,
  setYearTo,
  bpmFrom,
  setBpmFrom,
  bpmTo,
  setBpmTo,
  moodGroup,
  setMoodGroup,
  losslessOnly,
  setLosslessOnly,
  resultType,
  setResultType,
  starredOnly,
  setStarredOnly,
  trackFilterActive,
  indexEnabled,
  loading,
  autoFocusQuery,
  onSubmit,
}: AdvancedSearchFilterPanelProps) {
  const { t } = useTranslation();

  const bpmFilterDraftActive = !!(bpmFrom || bpmTo);

  const clearBpmFilter = () => {
    setBpmFrom('');
    setBpmTo('');
  };

  const typeOptions: { id: ResultType; label: string; tooltip: string }[] = [
    { id: 'all',     label: t('search.advancedAll'), tooltip: t('search.scopeAllTooltip') },
    { id: 'artists', label: t('search.artists'),     tooltip: t('search.scopeArtistsChipTooltip') },
    { id: 'albums',  label: t('search.albums'),      tooltip: t('search.scopeAlbumsChipTooltip') },
    { id: 'songs',   label: t('search.songs'),       tooltip: t('search.scopeSongsChipTooltip') },
  ];

  const genreSelectOptions = [
    { value: '', label: t('search.advancedAllGenres') },
    ...genres.map(g => ({ value: g.value, label: g.value })),
  ];

  const moodSelectOptions = useMemo(
    () => [
      { value: '', label: t('search.advancedAllMoods') },
      ...MOOD_GROUP_IDS.map(id => ({
        value: id,
        label: t(`search.moodGroups.${id}`),
      })),
    ],
    [t],
  );

  return (
    <form onSubmit={onSubmit}>
      <div className="settings-card" style={{ padding: '1.25rem', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>

          {/* Row 1: Search term */}
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 90, flexShrink: 0 }}>
              {t('search.advancedSearchTerm')}
            </span>
            <input
              className="input"
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('search.advancedSearchPlaceholder')}
              style={{ flex: 1 }}
              autoFocus={autoFocusQuery}
            />
          </div>

          {/* Row 2: Genre + Year */}
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 90, flexShrink: 0 }}>
              {t('search.advancedGenre')}
            </span>
            <div style={{ minWidth: 240, flex: '1 1 240px', maxWidth: 360 }}>
              <CustomSelect
                value={genre}
                options={genreSelectOptions}
                onChange={setGenre}
              />
            </div>

            <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: '0.75rem', flexShrink: 0 }}>
              {t('search.advancedYear')}
            </span>
            <input
              className="input"
              type="number"
              min={1900}
              max={new Date().getFullYear()}
              value={yearFrom}
              onChange={e => setYearFrom(e.target.value)}
              placeholder={t('search.advancedYearFrom')}
              style={{ width: 96 }}
            />
            <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>–</span>
            <input
              className="input"
              type="number"
              min={1900}
              max={new Date().getFullYear()}
              value={yearTo}
              onChange={e => setYearTo(e.target.value)}
              placeholder={t('search.advancedYearTo')}
              style={{ width: 96 }}
            />
          </div>

          {/* Row 3: BPM (tag + measured enrichment) */}
          {indexEnabled && (
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 90, flexShrink: 0 }}>
                {t('search.advancedBpm')}
              </span>
              <input
                className="input"
                type="number"
                min={20}
                max={999}
                value={bpmFrom}
                onChange={e => setBpmFrom(e.target.value)}
                onBlur={e => {
                  const from = parseBpmInput(e.target.value);
                  const to = parseBpmInput(bpmTo);
                  if (from != null && to != null && from > to) setBpmTo('');
                }}
                placeholder={t('search.advancedYearFrom')}
                style={{ width: 96 }}
              />
              <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>–</span>
              <input
                className="input"
                type="number"
                min={20}
                max={999}
                value={bpmTo}
                onChange={e => setBpmTo(e.target.value)}
                onBlur={e => {
                  const to = parseBpmInput(e.target.value);
                  const from = parseBpmInput(bpmFrom);
                  if (from != null && to != null && to < from) setBpmFrom('');
                }}
                placeholder={t('search.advancedYearTo')}
                style={{ width: 96 }}
              />
              {bpmFilterDraftActive && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={clearBpmFilter}
                  style={{
                    padding: '0.3rem 0.55rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    fontSize: '0.8rem',
                    flexShrink: 0,
                  }}
                >
                  <X size={13} />
                  {t('search.advancedBpmClear')}
                </button>
              )}
            </div>
          )}

          {/* Lossless — suffix allowlist (FLAC, WAV, …) */}
          {indexEnabled && (
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 90, flexShrink: 0 }}>
                {t('search.advancedLossless')}
              </span>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                  fontSize: 13,
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={losslessOnly}
                  onChange={e => setLosslessOnly(e.target.checked)}
                />
                {t('search.advancedLosslessOnly')}
              </label>
            </div>
          )}

          {/* Mood — hidden while oximedia mood analysis is disabled */}
          {indexEnabled && MOOD_UI_ENABLED && (
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--text-muted)', minWidth: 90, flexShrink: 0 }}>
                {t('search.advancedMoodGroup')}
              </span>
              <div style={{ minWidth: 240, flex: '1 1 240px', maxWidth: 360 }}>
                <CustomSelect
                  value={moodGroup}
                  options={moodSelectOptions}
                  onChange={setMoodGroup}
                />
              </div>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('search.advancedMoodLocalNote')}
              </span>
            </div>
          )}

          {/* Row 4: Result type + Search button */}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', alignItems: 'center' }}>
              {!trackFilterActive && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)', marginRight: '0.15rem' }}>
                  {t('search.scopeRowLabel')}
                </span>
              )}
              {!trackFilterActive && typeOptions.map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  className={`btn ${resultType === opt.id ? 'btn-primary' : 'btn-surface'}`}
                  style={{ fontSize: 12, padding: '4px 14px' }}
                  onClick={() => setResultType(opt.id)}
                  {...tooltipAttrs(opt.tooltip)}
                >
                  {opt.label}
                </button>
              ))}
              <StarFilterButton size="small" active={starredOnly} onChange={setStarredOnly} />
            </div>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={loading}
              style={{ minWidth: 100 }}
            >
              {loading
                ? <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                : t('search.advancedSearch')
              }
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import StarRating from '../StarRating';
import {
  LIMIT_MAX, YEAR_MAX, YEAR_MIN, clampYear, defaultSmartFilters,
  type SmartFilters,
} from '../../utils/playlist/playlistsSmart';

interface Props {
  smartFilters: SmartFilters;
  setSmartFilters: React.Dispatch<React.SetStateAction<SmartFilters>>;
  availableGenres: string[];
  genreQuery: string;
  setGenreQuery: React.Dispatch<React.SetStateAction<string>>;
  editingSmartId: string | null;
  creatingSmartBusy: boolean;
  setCreatingSmart: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingSmartId: React.Dispatch<React.SetStateAction<string | null>>;
  onSave: () => void;
}

export default function PlaylistsSmartEditor({
  smartFilters, setSmartFilters, availableGenres,
  genreQuery, setGenreQuery, editingSmartId, creatingSmartBusy,
  setCreatingSmart, setEditingSmartId, onSave,
}: Props) {
  const { t } = useTranslation();

  return (
    <div style={{ marginBottom: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '0.9rem', background: 'var(--bg-card)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <section style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.75rem' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: '0.65rem' }}>{t('smartPlaylists.sectionBasic')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            <input className="input" placeholder={t('smartPlaylists.name')} value={smartFilters.name} onChange={e => setSmartFilters(v => ({ ...v, name: e.target.value }))} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <input className="input" type="number" min={1} max={LIMIT_MAX} placeholder={t('smartPlaylists.limit')} value={smartFilters.limit} onChange={e => setSmartFilters(v => ({ ...v, limit: e.target.value }))} />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('smartPlaylists.limitHint', { max: LIMIT_MAX })}</span>
            </div>
            <select className="input" value={smartFilters.sort} onChange={e => setSmartFilters(v => ({ ...v, sort: e.target.value }))}>
              <option value="+random">{t('smartPlaylists.sortRandom')}</option>
              <option value="+title">{t('smartPlaylists.sortTitleAsc')}</option>
              <option value="-title">{t('smartPlaylists.sortTitleDesc')}</option>
              <option value="-year">{t('smartPlaylists.sortYearDesc')}</option>
              <option value="+year">{t('smartPlaylists.sortYearAsc')}</option>
              <option value="-playcount">{t('smartPlaylists.sortPlayCountDesc')}</option>
            </select>
          </div>
        </section>
        <section style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.75rem' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: '0.65rem' }}>{t('smartPlaylists.sectionGenres')}</div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('smartPlaylists.genreMode')}</span>
            <button className={`btn ${smartFilters.genreMode === 'include' ? 'btn-primary' : 'btn-surface'}`} onClick={() => setSmartFilters(v => ({ ...v, genreMode: 'include' }))}>{t('smartPlaylists.genreModeInclude')}</button>
            <button className={`btn ${smartFilters.genreMode === 'exclude' ? 'btn-primary' : 'btn-surface'}`} onClick={() => setSmartFilters(v => ({ ...v, genreMode: 'exclude' }))}>{t('smartPlaylists.genreModeExclude')}</button>
          </div>
          <input className="input" placeholder={t('smartPlaylists.genreSearchPlaceholder')} value={genreQuery} onChange={e => setGenreQuery(e.target.value)} style={{ marginBottom: '0.75rem' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.5rem', minHeight: 120 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>{t('smartPlaylists.availableGenres')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                {availableGenres.map(g => (
                  <button key={g} className="btn btn-surface" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => setSmartFilters(v => ({ ...v, selectedGenres: [...v.selectedGenres, g] }))}>{g}</button>
                ))}
              </div>
            </div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.5rem', minHeight: 120 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>{t('smartPlaylists.selectedGenres')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                {smartFilters.selectedGenres.map(g => (
                  <button key={g} className="btn btn-surface" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => setSmartFilters(v => ({ ...v, selectedGenres: v.selectedGenres.filter(x => x !== g) }))}>× {g}</button>
                ))}
              </div>
            </div>
          </div>
        </section>
        <section style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.75rem' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: '0.65rem' }}>{t('smartPlaylists.sectionYearsAndFilters')}</div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('smartPlaylists.yearMode')}</span>
            <button className={`btn ${smartFilters.yearMode === 'include' ? 'btn-primary' : 'btn-surface'}`} onClick={() => setSmartFilters(v => ({ ...v, yearMode: 'include' }))}>{t('smartPlaylists.yearModeInclude')}</button>
            <button className={`btn ${smartFilters.yearMode === 'exclude' ? 'btn-primary' : 'btn-surface'}`} onClick={() => setSmartFilters(v => ({ ...v, yearMode: 'exclude' }))}>{t('smartPlaylists.yearModeExclude')}</button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted)' }}>
            <span>{t('smartPlaylists.fromYear')}: {smartFilters.yearFrom}</span>
            <span>{t('smartPlaylists.toYear')}: {smartFilters.yearTo}</span>
          </div>
          <div className="dual-year-range">
            <div className="dual-year-range__track" />
            <div className="dual-year-range__selected" style={{ left: `${((smartFilters.yearFrom - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}%`, right: `${100 - ((smartFilters.yearTo - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}%` }} />
            <input type="range" min={YEAR_MIN} max={YEAR_MAX} value={smartFilters.yearFrom} onChange={e => setSmartFilters(v => ({ ...v, yearFrom: Math.min(clampYear(Number(e.target.value)), v.yearTo) }))} />
            <input type="range" min={YEAR_MIN} max={YEAR_MAX} value={smartFilters.yearTo} onChange={e => setSmartFilters(v => ({ ...v, yearTo: Math.max(clampYear(Number(e.target.value)), v.yearFrom) }))} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', marginTop: '0.75rem' }}>
            <input className="input" placeholder={t('smartPlaylists.artistContains')} value={smartFilters.artistContains} onChange={e => setSmartFilters(v => ({ ...v, artistContains: e.target.value }))} />
            <input className="input" placeholder={t('smartPlaylists.albumContains')} value={smartFilters.albumContains} onChange={e => setSmartFilters(v => ({ ...v, albumContains: e.target.value }))} />
            <input className="input" placeholder={t('smartPlaylists.titleContains')} value={smartFilters.titleContains} onChange={e => setSmartFilters(v => ({ ...v, titleContains: e.target.value }))} />
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('smartPlaylists.minRating')}: {smartFilters.minRating}★</div>
            <StarRating value={smartFilters.minRating} onChange={rating => setSmartFilters(v => ({ ...v, minRating: rating }))} ariaLabel={t('smartPlaylists.minRatingAria')} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('smartPlaylists.minRatingHint')}</span>
          </div>
          <div style={{ marginTop: '0.75rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
              <input type="checkbox" checked={smartFilters.excludeUnrated} onChange={e => setSmartFilters(v => ({ ...v, excludeUnrated: e.target.checked }))} />
              {t('smartPlaylists.excludeUnrated')}
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
              <input type="checkbox" checked={smartFilters.compilationOnly} onChange={e => setSmartFilters(v => ({ ...v, compilationOnly: e.target.checked }))} />
              {t('smartPlaylists.compilationOnly')}
            </label>
          </div>
        </section>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <button
            className="btn btn-surface"
            onClick={() => {
              setCreatingSmart(false);
              setEditingSmartId(null);
              setSmartFilters(defaultSmartFilters);
              setGenreQuery('');
            }}
          >
            {t('playlists.cancel')}
          </button>
          <button className="btn btn-primary" onClick={onSave} disabled={creatingSmartBusy}>
            <Plus size={15} /> {editingSmartId ? t('smartPlaylists.save') : t('smartPlaylists.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

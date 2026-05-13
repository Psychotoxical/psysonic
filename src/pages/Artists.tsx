import { getArtists } from '../api/subsonicArtists';
import type { SubsonicArtist } from '../api/subsonicTypes';
import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { LayoutGrid, List, Images, CheckSquare2 } from 'lucide-react';
import StarFilterButton from '../components/StarFilterButton';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { useElementClientHeightById } from '../hooks/useResizeClientHeight';
import { usePerfProbeFlags } from '../utils/perfFlags';
import {
  ALL_SENTINEL,
  ALPHABET,
  ARTIST_LIST_LAST_IN_LETTER_EST,
  ARTIST_LIST_LETTER_ROW_EST,
  ARTIST_LIST_ROW_EST,
} from '../utils/artistsHelpers';
import { useArtistsFiltering } from '../hooks/useArtistsFiltering';
import { useArtistsInfiniteScroll } from '../hooks/useArtistsInfiniteScroll';
import { ArtistsGridView } from '../components/artists/ArtistsGridView';
import { ArtistsListView } from '../components/artists/ArtistsListView';

export default function Artists() {
  const perfFlags = usePerfProbeFlags();
  const { t } = useTranslation();
  const [artists, setArtists] = useState<SubsonicArtist[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [letterFilter, setLetterFilter] = useState(ALL_SENTINEL);
  const [starredOnly, setStarredOnly] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  const showArtistImages = useAuthStore(s => s.showArtistImages);
  const PAGE_SIZE = showArtistImages ? 50 : 100; // Smaller with images to reduce I/O
  const {
    visibleCount,
    loadingMore,
    observerTarget,
  } = useArtistsInfiniteScroll({
    pageSize: PAGE_SIZE,
    resetDeps: [filter, letterFilter, starredOnly, viewMode],
  });
  const navigate = useNavigate();
  const openContextMenu = usePlayerStore(state => state.openContextMenu);
  const setShowArtistImages = useAuthStore(s => s.setShowArtistImages);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

  // ── Multi-selection ──────────────────────────────────────────────────────
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelectionMode = () => {
    setSelectionMode(v => !v);
    setSelectedIds(new Set());
  };

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const selectedArtists = artists.filter(a => selectedIds.has(a.id));

  useEffect(() => {
    getArtists().then(data => { setArtists(data); setLoading(false); }).catch(() => setLoading(false));
  }, [musicLibraryFilterVersion]);

  const {
    filtered, visible, hasMore, groups, letters, artistListFlatRows,
  } = useArtistsFiltering({ artists, filter, letterFilter, starredOnly, visibleCount, viewMode });

  const mainScrollViewportHeight = useElementClientHeightById(APP_MAIN_SCROLL_VIEWPORT_ID);
  /** Mixed row heights; smallest typical step ≈ artist row — one viewport of extra indices each side. */
  const artistListOverscan = Math.max(
    12,
    Math.ceil(mainScrollViewportHeight / ARTIST_LIST_ROW_EST),
  );

  const artistListVirtualizer = useVirtualizer({
    count:
      perfFlags.disableMainstageVirtualLists || viewMode !== 'list' ? 0 : artistListFlatRows.length,
    getScrollElement: () => document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID),
    estimateSize: index => {
      const row = artistListFlatRows[index];
      if (!row) return ARTIST_LIST_ROW_EST;
      if (row.kind === 'letter') return ARTIST_LIST_LETTER_ROW_EST;
      return row.isLastInLetter ? ARTIST_LIST_LAST_IN_LETTER_EST : ARTIST_LIST_ROW_EST;
    },
    /** Stable keys — avoids row DOM reuse glitches when the filtered slice changes. */
    getItemKey: index => {
      const row = artistListFlatRows[index];
      if (!row) return index;
      if (row.kind === 'letter') return `letter:${row.letter}`;
      return `artist:${row.artist.id}`;
    },
    overscan: artistListOverscan,
  });

  return (
    <div className="content-body animate-fade-in">
      <div className="page-sticky-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <h1 className="page-title" style={{ marginBottom: 0 }}>
              {selectionMode && selectedIds.size > 0
                ? t('artists.selectionCount', { count: selectedIds.size })
                : t('artists.title')}
            </h1>
            <input
              className="input"
              style={{ maxWidth: 220 }}
              placeholder={t('artists.search')}
              value={filter}
              onChange={e => setFilter(e.target.value)}
              id="artist-filter-input"
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {!(selectionMode && selectedIds.size > 0) && (<>
                <StarFilterButton size="compact" active={starredOnly} onChange={setStarredOnly} />
                <button
                  className={`btn btn-surface`}
                  onClick={() => setShowArtistImages(!showArtistImages)}
                  style={showArtistImages ? { background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '0.5rem' } : { padding: '0.5rem' }}
                  data-tooltip={showArtistImages ? t('artists.imagesOn') : t('artists.imagesOff')}
                  data-tooltip-wrap
                >
                  <Images size={20} />
                </button>
                <button
                  className={`btn btn-surface ${viewMode === 'grid' ? 'btn-sort-active' : ''}`}
                  onClick={() => setViewMode('grid')}
                  style={viewMode === 'grid' ? { background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '0.5rem' } : { padding: '0.5rem' }}
                  data-tooltip={t('artists.gridView')}
                >
                  <LayoutGrid size={20} />
                </button>
                <button
                  className={`btn btn-surface ${viewMode === 'list' ? 'btn-sort-active' : ''}`}
                  onClick={() => setViewMode('list')}
                  style={viewMode === 'list' ? { background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '0.5rem' } : { padding: '0.5rem' }}
                  data-tooltip={t('artists.listView')}
                >
                  <List size={20} />
                </button>
              </>
            )}
            <button
              className={`btn btn-surface${selectionMode ? ' btn-sort-active' : ''}`}
              onClick={toggleSelectionMode}
              data-tooltip={selectionMode ? t('artists.cancelSelect') : t('artists.startSelect')}
              data-tooltip-pos="bottom"
              style={selectionMode ? { background: 'var(--accent)', color: 'var(--ctp-crust)' } : {}}
            >
              <CheckSquare2 size={15} />
              {selectionMode ? t('artists.cancelSelect') : t('artists.select')}
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: 'var(--space-4)' }}>
          {ALPHABET.map(l => (
            <button
              key={l}
              onClick={() => setLetterFilter(l)}
              className={`artists-alpha-btn${letterFilter === l ? ' artists-alpha-btn--active' : ''}`}
            >
              {l === ALL_SENTINEL ? t('artists.all') : l}
            </button>
          ))}
        </div>
      </div>

      {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}><div className="spinner" /></div>}

      {!loading && viewMode === 'grid' && (
        <ArtistsGridView
          visible={visible}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          selectedArtists={selectedArtists}
          showArtistImages={showArtistImages}
          toggleSelect={toggleSelect}
          navigate={navigate}
          openContextMenu={openContextMenu}
          t={t}
        />
      )}

      {!loading && viewMode === 'list' && (
        <ArtistsListView
          virtualized={!perfFlags.disableMainstageVirtualLists}
          groups={groups}
          letters={letters}
          artistListFlatRows={artistListFlatRows}
          artistListVirtualizer={artistListVirtualizer}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          selectedArtists={selectedArtists}
          showArtistImages={showArtistImages}
          toggleSelect={toggleSelect}
          navigate={navigate}
          openContextMenu={openContextMenu}
          t={t}
        />
      )}

      {!loading && hasMore && (
        <div ref={observerTarget} style={{ height: '20px', margin: '2rem 0', display: 'flex', justifyContent: 'center' }}>
          {loadingMore && <div className="spinner" style={{ width: 20, height: 20 }} />}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
          {t('artists.notFound')}
        </div>
      )}
    </div>
  );
}

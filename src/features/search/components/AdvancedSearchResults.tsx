import { type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AlbumRow } from '@/features/album';
import { ArtistRow } from '@/features/artist';
import PagedSongList from '@/features/search/components/PagedSongList';
import { LOSSLESS_MODE_QUERY } from '@/lib/library/losslessMode';
import type { Results, SearchOpts } from '@/features/search/searchBrowseTypes';

interface AdvancedSearchResultsProps {
  showAdvancedPanel: boolean;
  hasSearched: boolean;
  loading: boolean;
  basicSearchMode: boolean;
  query: string;
  filteredResults: Results | null;
  activeSearch: SearchOpts | null;
  genreNote: boolean;
  songsHasMore: boolean;
  loadingMoreSongs: boolean;
  loadMoreSongs: () => void;
  artistRowScrollLeftRestoreRef: MutableRefObject<number>;
  artistRowScrollLeftRef: MutableRefObject<number>;
  albumRowScrollLeftRestoreRef: MutableRefObject<number>;
  albumRowScrollLeftRef: MutableRefObject<number>;
}

/** Results area for the search shell: empty/loading/no-results states + artist/album/song sections. */
export default function AdvancedSearchResults({
  showAdvancedPanel,
  hasSearched,
  loading,
  basicSearchMode,
  query,
  filteredResults,
  activeSearch,
  genreNote,
  songsHasMore,
  loadingMoreSongs,
  loadMoreSongs,
  artistRowScrollLeftRestoreRef,
  artistRowScrollLeftRef,
  albumRowScrollLeftRestoreRef,
  albumRowScrollLeftRef,
}: AdvancedSearchResultsProps) {
  const { t } = useTranslation();
  const total = filteredResults
    ? filteredResults.artists.length + filteredResults.albums.length + filteredResults.songs.length
    : 0;

  if (showAdvancedPanel && !hasSearched) {
    return (
      <div className="empty-state" style={{ opacity: 0.6 }}>
        {t('search.advancedEmpty')}
      </div>
    );
  }
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
        <div className="spinner" />
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className="empty-state">
        {basicSearchMode && query.trim()
          ? t('search.noResults', { query })
          : t('search.advancedNoResults')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>

      {filteredResults && filteredResults.artists.length > 0 && (
        <div data-advanced-search-artist-row>
        <ArtistRow
          title={
            basicSearchMode
              ? t('search.artists')
              : `${t('search.artists')} (${filteredResults.artists.length})`
          }
          artists={filteredResults.artists}
          artistLinkQuery={activeSearch?.losslessOnly ? LOSSLESS_MODE_QUERY : undefined}
          restoreScrollLeft={
            // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
            // eslint-disable-next-line react-hooks/refs
            artistRowScrollLeftRestoreRef.current > 0
              // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
              // eslint-disable-next-line react-hooks/refs
              ? artistRowScrollLeftRestoreRef.current
              : undefined
          }
          onScrollLeftSnapshot={(left) => {
            artistRowScrollLeftRef.current = left;
          }}
        />
        </div>
      )}

      {filteredResults && filteredResults.albums.length > 0 && (
        <div data-advanced-search-album-row>
        <AlbumRow
          title={
            basicSearchMode
              ? t('search.albums')
              : `${t('search.albums')} (${filteredResults.albums.length})`
          }
          albums={filteredResults.albums}
          albumLinkQuery={activeSearch?.losslessOnly ? LOSSLESS_MODE_QUERY : undefined}
          windowArtworkByViewport
          initialArtworkBudget={12}
          restoreScrollLeft={
            // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
            // eslint-disable-next-line react-hooks/refs
            albumRowScrollLeftRestoreRef.current > 0
              // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
              // eslint-disable-next-line react-hooks/refs
              ? albumRowScrollLeftRestoreRef.current
              : undefined
          }
          onScrollLeftSnapshot={(left) => {
            albumRowScrollLeftRef.current = left;
          }}
        />
        </div>
      )}

      {filteredResults && filteredResults.songs.length > 0 && (
        <section>
          <h2 className="section-title" style={{ marginBottom: '0.75rem' }}>
            {t('search.songs')}
            {genreNote && (
              <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: '0.75rem' }}>
                — {t('search.advancedGenreNote')}
              </span>
            )}
          </h2>
          <PagedSongList
            songs={filteredResults.songs}
            hasMore={songsHasMore}
            loadingMore={loadingMoreSongs}
            onLoadMore={loadMoreSongs}
            showBpm={!!(activeSearch?.bpmFrom || activeSearch?.bpmTo)}
          />
        </section>
      )}
    </div>
  );
}

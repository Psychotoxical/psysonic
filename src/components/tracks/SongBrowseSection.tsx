import type { SubsonicSong } from '../../api/subsonicTypes';
import React from 'react';
import { Search as SearchIcon, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import PagedSongList from '../PagedSongList';

interface Props {
  title?: string;
  emptyBrowseText?: string;
  query: string;
  onQueryChange: (value: string) => void;
  songs: SubsonicSong[];
  hasMore: boolean;
  loading: boolean;
  browseUnsupported: boolean;
  onLoadMore: () => void;
}

/** Tracks hub toolbar + paginated song list (shared chrome with Search song results). */
export default function SongBrowseSection({
  title,
  emptyBrowseText,
  query,
  onQueryChange,
  songs,
  hasMore,
  loading,
  browseUnsupported,
  onLoadMore,
}: Props) {
  const { t } = useTranslation();
  const showEmptyBrowse = !loading && songs.length === 0 && query.trim() === '' && (browseUnsupported || !hasMore);

  return (
    <section className="virtual-song-list-section">
      {title && <h2 className="section-title virtual-song-list-title">{title}</h2>}
      <div className="virtual-song-list-toolbar">
        <div className="virtual-song-list-search">
          <SearchIcon size={16} className="virtual-song-list-search-icon" />
          <input
            type="text"
            className="input virtual-song-list-search-input"
            placeholder={t('tracks.searchPlaceholder')}
            value={query}
            onChange={e => onQueryChange(e.target.value)}
          />
          {query && (
            <button
              className="virtual-song-list-search-clear"
              onClick={() => onQueryChange('')}
              aria-label={t('search.clearLabel')}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="virtual-song-list-meta">
          {songs.length > 0 && (
            <span>{t('tracks.count', { count: songs.length })}{hasMore ? '+' : ''}</span>
          )}
        </div>
      </div>

      {showEmptyBrowse ? (
        <div className="virtual-song-list-empty">
          {emptyBrowseText ?? t('tracks.browseUnsupported')}
        </div>
      ) : (
        <PagedSongList
          songs={songs}
          hasMore={hasMore}
          loadingMore={loading}
          onLoadMore={onLoadMore}
        />
      )}
    </section>
  );
}

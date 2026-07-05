import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import React from 'react';
import { useTranslation } from 'react-i18next';
import PagedSongList from '@/features/search/components/PagedSongList';

interface Props {
  title?: string;
  emptyBrowseText?: string;
  searchActive?: boolean;
  songs: SubsonicSong[];
  hasMore: boolean;
  loading: boolean;
  browseUnsupported: boolean;
  onLoadMore: () => void;
}

/** Tracks hub toolbar + paginated song list (search lives in the header live search field). */
export default function SongBrowseSection({
  title,
  emptyBrowseText,
  searchActive = false,
  songs,
  hasMore,
  loading,
  browseUnsupported,
  onLoadMore,
}: Props) {
  const { t } = useTranslation();
  const showEmptyBrowse =
    !loading && songs.length === 0 && !searchActive && (browseUnsupported || !hasMore);

  return (
    <section className="virtual-song-list-section">
      {title && !searchActive && (
        <h2 className="section-title virtual-song-list-title">{title}</h2>
      )}
      <div className="virtual-song-list-toolbar">
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

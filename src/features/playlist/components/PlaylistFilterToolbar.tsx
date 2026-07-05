import React from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import SortDropdown, { type SortOption } from '@/ui/SortDropdown';
import type { PlaylistSortKey, PlaylistSortDir } from '@/features/playlist/utils/playlistDisplayedSongs';

type PlaylistSortValue =
  | 'added-newest'
  | 'added-oldest'
  | 'title'
  | 'artist'
  | 'album'
  | 'duration'
  | 'favorite'
  | 'rating'
  | 'plays';

const SORT_MAP: Record<PlaylistSortValue, { key: PlaylistSortKey; dir: PlaylistSortDir }> = {
  'added-newest': { key: 'position', dir: 'desc' },
  'added-oldest': { key: 'position', dir: 'asc' },
  title: { key: 'title', dir: 'asc' },
  artist: { key: 'artist', dir: 'asc' },
  album: { key: 'album', dir: 'asc' },
  duration: { key: 'duration', dir: 'asc' },
  favorite: { key: 'favorite', dir: 'desc' },
  rating: { key: 'rating', dir: 'desc' },
  plays: { key: 'playCount', dir: 'desc' },
};

// Column keys whose dropdown value is the same string as the sort key.
const DIRECT_COLUMN_SORTS = new Set<PlaylistSortKey>([
  'title',
  'artist',
  'album',
  'duration',
  'favorite',
  'rating',
]);

interface Props {
  filterText: string;
  setFilterText: (v: string) => void;
  sortKey: PlaylistSortKey;
  sortDir: PlaylistSortDir;
  setSortKey: (k: PlaylistSortKey) => void;
  setSortDir: (d: PlaylistSortDir) => void;
  setSortClickCount: (n: number) => void;
}

export default function PlaylistFilterToolbar({
  filterText,
  setFilterText,
  sortKey,
  sortDir,
  setSortKey,
  setSortDir,
  setSortClickCount,
}: Props) {
  const { t } = useTranslation();

  // The dropdown and the column-header clicks drive the same (sortKey, sortDir)
  // state. Map the current state back to a dropdown value so the two stay in
  // sync; playlist load order (natural) shows as "date added (oldest)" since
  // they are the same ordering.
  const currentSortValue: PlaylistSortValue =
    sortKey === 'position'
      ? sortDir === 'desc'
        ? 'added-newest'
        : 'added-oldest'
      : sortKey === 'playCount'
        ? 'plays'
        : DIRECT_COLUMN_SORTS.has(sortKey)
          ? (sortKey as PlaylistSortValue)
          : 'added-oldest';

  const sortOptions: SortOption<PlaylistSortValue>[] = [
    { value: 'added-newest', label: t('playlists.sortDateAddedNewest') },
    { value: 'added-oldest', label: t('playlists.sortDateAddedOldest') },
    { value: 'title', label: t('albumDetail.trackTitle') },
    { value: 'artist', label: t('albumDetail.trackArtist') },
    { value: 'album', label: t('albumDetail.trackAlbum') },
    { value: 'duration', label: t('albumDetail.trackDuration') },
    { value: 'favorite', label: t('albumDetail.trackFavorite') },
    { value: 'rating', label: t('albumDetail.trackRating') },
    { value: 'plays', label: t('albumDetail.trackPlayCount') },
  ];

  const onSortChange = (v: PlaylistSortValue) => {
    const { key, dir } = SORT_MAP[v];
    setSortKey(key);
    setSortDir(dir);
    // Reset the column click cycle so a follow-up header click starts cleanly.
    setSortClickCount(1);
  };

  return (
    <div className="playlist-filter-toolbar" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 16px', flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', flex: '1 1 160px', maxWidth: 260 }}>
        <Search size={16} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
        <input
          className="input-search"
          style={{ width: '100%', paddingRight: filterText ? 28 : undefined }}
          placeholder={t('albumDetail.filterSongs')}
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
        />
        {filterText && (
          <button
            style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={() => setFilterText('')}
            aria-label="Clear filter"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div style={{ marginLeft: 'auto' }}>
        <SortDropdown
          value={currentSortValue}
          options={sortOptions}
          onChange={onSortChange}
          tooltip={t('playlists.sortTooltip')}
          ariaLabel={t('playlists.sortTooltip')}
          align="right"
        />
      </div>
    </div>
  );
}

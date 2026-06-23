import type { SubsonicSong } from '../api/subsonicTypes';
import React, { useRef } from 'react';
import SongRow, { SongListHeader } from './SongRow';
import { useInpageScrollSentinel } from '../hooks/useInpageScrollSentinel';
import InpageScrollSentinel from './InpageScrollSentinel';

interface Props {
  songs: SubsonicSong[];
  /** More pages available — renders the load-more sentinel. */
  hasMore: boolean;
  /** A page fetch is in flight — shows the sentinel spinner. */
  loadingMore: boolean;
  /** Fetch the next page. Called as the sentinel nears the viewport. */
  onLoadMore: () => void;
  /** Show a BPM column (Advanced Search when the BPM filter is active). */
  showBpm?: boolean;
}

/**
 * Shared song-list view: sticky column header + plain `SongRow`s in the page
 * flow, with an `IntersectionObserver` sentinel for pagination. Used by the
 * Tracks browse list, Search results, and Advanced Search so the three share
 * one chrome + paging path (no transform-positioned rows, so the sticky header
 * is never painted over — issue #841).
 */
export default function PagedSongList({ songs, hasMore, loadingMore, onLoadMore, showBpm }: Props) {
  const onLoadMoreRef = useRef(onLoadMore);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  onLoadMoreRef.current = onLoadMore;

  const bindSentinel = useInpageScrollSentinel({
    active: hasMore,
    onIntersect: () => onLoadMoreRef.current(),
    rootMargin: '600px',
  });

  return (
    <>
      <SongListHeader showBpm={showBpm} />
      {songs.map(song => (
        <SongRow key={song.id} song={song} showBpm={showBpm} />
      ))}
      {hasMore && (
        <InpageScrollSentinel
          bindSentinel={bindSentinel}
          loading={loadingMore}
          style={{ padding: '1rem', height: 'auto', margin: 0 }}
        />
      )}
    </>
  );
}

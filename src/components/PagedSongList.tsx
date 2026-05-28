import type { SubsonicSong } from '../api/subsonicTypes';
import React, { useRef } from 'react';
import SongRow, { SongListHeader } from './SongRow';
import { useInpageScrollSentinel } from '../hooks/useInpageScrollSentinel';

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
        <div ref={bindSentinel} style={{ display: 'flex', justifyContent: 'center', padding: '1rem' }}>
          {loadingMore && <div className="spinner" style={{ width: 20, height: 20 }} />}
        </div>
      )}
    </>
  );
}

import type { SubsonicSong } from '../api/subsonicTypes';
import React, { useEffect, useRef } from 'react';
import SongRow, { SongListHeader } from './SongRow';

interface Props {
  songs: SubsonicSong[];
  /** More pages available — renders the load-more sentinel. */
  hasMore: boolean;
  /** A page fetch is in flight — shows the sentinel spinner. */
  loadingMore: boolean;
  /** Fetch the next page. Called as the sentinel nears the viewport. */
  onLoadMore: () => void;
}

/**
 * Shared song-list view: sticky column header + plain `SongRow`s in the page
 * flow, with an `IntersectionObserver` sentinel for pagination. Used by the
 * Tracks browse list, Search results, and Advanced Search so the three share
 * one chrome + paging path (no transform-positioned rows, so the sticky header
 * is never painted over — issue #841).
 */
export default function PagedSongList({ songs, hasMore, loadingMore, onLoadMore }: Props) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Re-observe whenever `onLoadMore` changes identity (callers rebuild it after
  // each page), so a sentinel still in view keeps loading the next page.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) onLoadMore();
    }, { rootMargin: '600px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [onLoadMore]);

  return (
    <>
      <SongListHeader />
      {songs.map(song => (
        <SongRow key={song.id} song={song} />
      ))}
      {hasMore && (
        <div ref={sentinelRef} style={{ display: 'flex', justifyContent: 'center', padding: '1rem' }}>
          {loadingMore && <div className="spinner" style={{ width: 20, height: 20 }} />}
        </div>
      )}
    </>
  );
}

import React from 'react';
import { useSongBrowseList } from '../hooks/useSongBrowseList';
import SongBrowseSection from './tracks/SongBrowseSection';

interface Props {
  title?: string;
  emptyBrowseText?: string;
}

/** @deprecated Use SongBrowseSection via SearchBrowsePage (`/tracks`). */
export default function VirtualSongList({ title, emptyBrowseText }: Props) {
  const browse = useSongBrowseList({ enabled: true });

  return (
    <SongBrowseSection
      title={title}
      emptyBrowseText={emptyBrowseText}
      query={browse.query}
      onQueryChange={browse.setQuery}
      songs={browse.songs}
      hasMore={browse.hasMore}
      loading={browse.loading}
      browseUnsupported={browse.browseUnsupported}
      onLoadMore={() => { void browse.loadMore(); }}
    />
  );
}

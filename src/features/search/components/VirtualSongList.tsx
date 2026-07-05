import React, { useState } from 'react';
import { useSongBrowseList } from '@/features/search/hooks/useSongBrowseList';
import SongBrowseSection from '@/features/search/components/SongBrowseSection';

interface Props {
  title?: string;
  emptyBrowseText?: string;
}

/** @deprecated Use SongBrowseSection via SearchBrowsePage (`/tracks`). */
export default function VirtualSongList({ title, emptyBrowseText }: Props) {
  const [searchQuery] = useState('');
  const browse = useSongBrowseList({ enabled: true, searchQuery });

  return (
    <SongBrowseSection
      title={title}
      emptyBrowseText={emptyBrowseText}
      songs={browse.songs}
      hasMore={browse.hasMore}
      loading={browse.loading}
      browseUnsupported={browse.browseUnsupported}
      onLoadMore={() => { void browse.loadMore(); }}
    />
  );
}

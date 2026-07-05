import React from 'react';
import type { ContextMenuItemsProps } from '@/features/contextMenu/components/contextMenuItemTypes';
import SongContextItems from '@/features/contextMenu/components/SongContextItems';
import QueueItemContextItems from '@/features/contextMenu/components/QueueItemContextItems';
import AlbumContextItems from '@/features/contextMenu/components/AlbumContextItems';
import ArtistContextItems from '@/features/contextMenu/components/ArtistContextItems';
import PlaylistContextItems from '@/features/contextMenu/components/PlaylistContextItems';

export default function ContextMenuItems(props: ContextMenuItemsProps) {
  const { type } = props;
  switch (type) {
    case 'song':
    case 'album-song':
    case 'favorite-song':
      return <SongContextItems {...props} />;
    case 'queue-item':
      return <QueueItemContextItems {...props} />;
    case 'album':
    case 'multi-album':
      return <AlbumContextItems {...props} />;
    case 'artist':
    case 'multi-artist':
      return <ArtistContextItems {...props} />;
    case 'playlist':
    case 'multi-playlist':
      return <PlaylistContextItems {...props} />;
    default:
      return null;
  }
}

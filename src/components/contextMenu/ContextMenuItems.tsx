import React from 'react';
import type { ContextMenuItemsProps } from './contextMenuItemTypes';
import SongContextItems from './SongContextItems';
import QueueItemContextItems from './QueueItemContextItems';
import AlbumContextItems from './AlbumContextItems';
import ArtistContextItems from './ArtistContextItems';
import PlaylistContextItems from './PlaylistContextItems';

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

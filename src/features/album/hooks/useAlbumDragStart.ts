import type React from 'react';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { acquireUrl } from '@/cover';
import { useDragDrop } from '@/lib/dnd/DragDropContext';
import { useDragPress } from '@/lib/dnd/useDragPress';

/**
 * Album drag source shared by the card and the table row: a left-press that
 * travels far enough starts a drag carrying the album payload and its cached
 * cover, while a press that stays put remains a click.
 *
 * Returns a `mousedown` handler; pass the cover storage key so the drag ghost
 * can show artwork that is already in the cache (no fetch on drag start).
 */
export function useAlbumDragStart(
  album: Pick<SubsonicAlbum, 'id' | 'name' | 'serverId'>,
  coverStorageKey: string,
  disabled = false,
): (e: React.MouseEvent) => void {
  const psyDrag = useDragDrop();

  return useDragPress({
    disabled,
    onStart: (me) => {
      const coverUrl = coverStorageKey ? acquireUrl(coverStorageKey) ?? undefined : undefined;
      psyDrag.startDrag({
        data: JSON.stringify({
          type: 'album',
          id: album.id,
          name: album.name,
          serverId: album.serverId,
        }),
        label: album.name,
        coverUrl,
      }, me.clientX, me.clientY);
    },
  });
}

import { useCallback } from 'react';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { acquireUrl } from '@/cover';
import { useDragDrop } from '@/lib/dnd/DragDropContext';

/** Pointer travel before a press turns into a drag rather than a click. */
const DRAG_THRESHOLD_PX = 5;

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
  return useCallback((e: React.MouseEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (me: MouseEvent) => {
      if (
        Math.abs(me.clientX - sx) <= DRAG_THRESHOLD_PX
        && Math.abs(me.clientY - sy) <= DRAG_THRESHOLD_PX
      ) return;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
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
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [album.id, album.name, album.serverId, coverStorageKey, disabled, psyDrag]);
}

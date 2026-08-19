import { useCallback, useEffect, useRef } from 'react';
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
  /** Detaches the listeners of the press in flight, while one is unresolved. */
  const endPressRef = useRef<(() => void) | null>(null);

  // A press detaches its own listeners once it resolves — into a drag, or into a
  // release. Nothing resolves it when the source disappears mid-press, and rows
  // do disappear under a held button: they are virtualised, the view mode can
  // flip, and a refresh replaces the list. The listeners would then outlive the
  // component and turn the next pointer travel into a drag for an album that is
  // no longer on screen.
  // `disabled` is a dependency for the same reason: React runs this cleanup
  // before re-running on a change, so selection mode turning on resolves an
  // armed press instead of leaving a drag primed behind the new mode.
  useEffect(() => () => endPressRef.current?.(), [disabled]);

  return useCallback((e: React.MouseEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    // A second press supersedes one that never resolved.
    endPressRef.current?.();
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (me: MouseEvent) => {
      if (
        Math.abs(me.clientX - sx) <= DRAG_THRESHOLD_PX
        && Math.abs(me.clientY - sy) <= DRAG_THRESHOLD_PX
      ) return;
      endPress();
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
    const endPress = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', endPress);
      endPressRef.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', endPress);
    endPressRef.current = endPress;
  }, [album.id, album.name, album.serverId, coverStorageKey, disabled, psyDrag]);
}

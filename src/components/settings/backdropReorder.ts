import type { BackdropSourcePref } from '../../cover/artistBackdrop';

/**
 * Move the source at `from` so it lands at exactly index `to` — the ↑/↓ buttons,
 * i.e. a swap with the neighbour. Returns a new array, or `null` for an
 * out-of-range or no-op move (so the caller can skip a redundant update).
 */
export function moveSourceTo(
  sources: BackdropSourcePref[],
  from: number,
  to: number,
): BackdropSourcePref[] | null {
  if (from === to || from < 0 || to < 0 || from >= sources.length || to >= sources.length) return null;
  const next = sources.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Insert the source at `from` immediately before the row at `beforeIndex` — the
 * drag-drop case, matching the "line above this row" drop indicator. The -1 when
 * dragging downward accounts for the slot the dragged item vacated. Returns a
 * new array, or `null` for an out-of-range or no-op move.
 */
export function dropSourceBefore(
  sources: BackdropSourcePref[],
  from: number,
  beforeIndex: number,
): BackdropSourcePref[] | null {
  if (from === beforeIndex || from < 0 || from >= sources.length) return null;
  const next = sources.slice();
  const [item] = next.splice(from, 1);
  next.splice(from < beforeIndex ? beforeIndex - 1 : beforeIndex, 0, item);
  return next;
}

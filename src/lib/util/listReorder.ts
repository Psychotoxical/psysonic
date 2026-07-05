/**
 * Shared, id-based list reordering for the drag-to-reorder customizers
 * (sidebar, artist layout, lyrics sources, queue toolbar, servers).
 *
 * Reorders are resolved from stable item ids, never positional indices, so the
 * filter that decides which rows are *shown* can never share an index space
 * with the reorder and desync it (the #1164 class of bug). See
 * `useListReorderDnd` for the DnD wiring and `sidebarNavReorder` for the
 * section-aware sidebar variant that builds on this.
 */

export type ListReorderDropTarget = {
  /** Stable id of the row the cursor is over — never a positional index. */
  id: string;
  /** Insert above (`true`) or below (`false`) the target row. */
  before: boolean;
  /** Optional section discriminator for multi-section lists (e.g. sidebar). */
  section?: string;
};

/**
 * Moves `draggedId` next to `target.id` within `items`, identifying both rows
 * by id. Returns a new array, or `null` when nothing should change — unknown
 * id, dropping onto self, or a no-op edge.
 */
export function applyListReorderById<T extends { id: string }>(
  items: T[],
  draggedId: string,
  target: ListReorderDropTarget,
): T[] | null {
  if (draggedId === target.id) return null;

  const fromIdx = items.findIndex(i => i.id === draggedId);
  if (fromIdx < 0) return null;

  const next = [...items];
  const [moved] = next.splice(fromIdx, 1);
  const anchor = next.findIndex(i => i.id === target.id);
  if (anchor < 0) return null;
  next.splice(target.before ? anchor : anchor + 1, 0, moved);

  // No-op if the resulting order is identical (e.g. dropped on its own edge).
  if (next.every((c, i) => c.id === items[i].id)) return null;
  return next;
}

import React, { useCallback, useEffect, useMemo, useRef } from 'react';

/** Pointer travel before a press turns into a drag rather than a click. */
export const DRAG_THRESHOLD_PX = 5;

export interface ArmDragPressOptions {
  /**
   * Runs once the pointer has travelled past the threshold. The press has
   * already detached its listeners by then, so this is where the payload is
   * built and the drag begins.
   */
  onStart: (e: MouseEvent) => void;
  /**
   * Whether `mousedown` gets its default prevented. On by default: it stops the
   * browser from turning the threshold phase into a text selection. Sources
   * that sit on a `<button>` keep the default so the element still focuses.
   */
  preventDefault?: boolean;
  /**
   * Evaluated on `mousedown` — a falsy result leaves the press unarmed. Rows
   * use it to keep presses on their own buttons and inputs out of the drag.
   */
  canStart?: (e: React.MouseEvent) => boolean;
  /**
   * Runs once the press has resolved, whichever way it went. An owner holding
   * the returned resolver uses it to drop that reference — the resolver closes
   * over the row's payload and its DOM node, which would otherwise stay
   * reachable for as long as the owner lives.
   */
  onResolved?: () => void;
}

/**
 * Arms a press and owns everything that ends it. Returns the resolver, or
 * `null` when the press was not armed at all.
 *
 * A `mousedown` attaches `mousemove`/`mouseup` to `document` and detaches them
 * when the press resolves — into a drag, or into a release. Two things used to
 * leave those listeners behind, and every drag source in the app repeated both:
 *
 * - **The source disappears while the button is held.** Rows are virtualised, a
 *   view switch or a refresh replaces the list, and nothing then resolves the
 *   press. The listeners outlive their row and the next pointer travel drags an
 *   entry that is no longer on screen. The React wrappers below own that half.
 * - **The release never arrives.** `DragDropContext` documents this for Wayland
 *   ("webview may not get `mouseup` when the pointer leaves the surface") and
 *   guards an *in-flight drag* with `pointerup`, `pointercancel`, `blur` and
 *   `visibilitychange`. An *armed press* had none of them; it does now.
 *
 * Prefer `useDragPress` (one source per component) or `useDragPressHandle` (a
 * list that arms presses from a row callback) — both add the unmount teardown
 * this function cannot do on its own.
 */
export function armDragPress(
  e: React.MouseEvent,
  options: ArmDragPressOptions,
): (() => void) | null {
  const { onStart, preventDefault = true, canStart, onResolved } = options;
  if (e.button !== 0) return null;
  if (canStart && !canStart(e)) return null;
  if (preventDefault) e.preventDefault();

  // The element the press started on, read while the handler still owns the
  // event. A virtualised row can be recycled out of the DOM under a held button
  // while the list around it stays mounted — React's unmount teardown never
  // fires for that, so the element itself is the only thing that knows it left.
  const source = e.currentTarget;
  const sx = e.clientX;
  const sy = e.clientY;
  let resolved = false;

  const endPress = () => {
    if (resolved) return;
    resolved = true;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', endPress);
    document.removeEventListener('pointerup', endPress, true);
    document.removeEventListener('pointercancel', endPress, true);
    window.removeEventListener('blur', endPress);
    document.removeEventListener('visibilitychange', onVisibility);
    onResolved?.();
  };

  const onMove = (me: MouseEvent) => {
    if (!source.isConnected) {
      endPress();
      return;
    }
    if (
      Math.abs(me.clientX - sx) <= DRAG_THRESHOLD_PX
      && Math.abs(me.clientY - sy) <= DRAG_THRESHOLD_PX
    ) return;
    endPress();
    onStart(me);
  };

  const onVisibility = () => {
    if (document.hidden) endPress();
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', endPress);
  // The lost-release guards. `pointerup` fires ahead of `mouseup`, so a normal
  // release still resolves the press exactly once — `endPress` detaches both.
  document.addEventListener('pointerup', endPress, true);
  // `pointercancel` also covers the sources that leave the mousedown default in
  // place: pressing a row's cover image can start a *native* drag there, and the
  // spec fires `pointercancel` "as part of the drag operation initiation
  // algorithm" (w3c.github.io/pointerevents) while device input events "must be
  // suppressed" for the duration (html.spec.whatwg.org/multipage/dnd.html). No
  // `mousemove` reaches us after that, so this resolves a press that can no
  // longer become a drag — rather than one that still could.
  document.addEventListener('pointercancel', endPress, true);
  window.addEventListener('blur', endPress);
  document.addEventListener('visibilitychange', onVisibility);

  return endPress;
}

export interface DragPressHandle {
  /** Arms a press from a `mousedown`; supersedes one that never resolved. */
  arm: (e: React.MouseEvent, options: ArmDragPressOptions) => void;
  /** Resolves the press in flight, if there is one. */
  endPress: () => void;
}

/**
 * Owns the press of a list whose rows arm it from a callback rather than from
 * their own hook — a virtualised row, a shared row-handler object. The press is
 * resolved when the list unmounts, so a row that disappears under a held button
 * cannot leave listeners behind.
 */
export function useDragPressHandle(): DragPressHandle {
  /** Detaches the listeners of the press in flight, while one is unresolved. */
  const endPressRef = useRef<(() => void) | null>(null);

  useEffect(() => () => endPressRef.current?.(), []);

  return useMemo(() => ({
    arm: (e, options) => {
      // The slot lets the resolver identify itself once it fires: the ref is
      // dropped only while it still points at *this* press, so an owner outliving
      // a long list of clicks stops pinning the last row's payload and DOM node.
      const slot: { end: (() => void) | null } = { end: null };
      const end = armDragPress(e, {
        ...options,
        onResolved: () => {
          options.onResolved?.();
          if (endPressRef.current === slot.end) endPressRef.current = null;
        },
      });
      // A press that was not armed at all — a non-primary button, a guard that
      // said no — leaves an earlier one alone, exactly as the per-site copies did.
      if (!end) return;
      slot.end = end;
      // A second press supersedes one that never resolved.
      endPressRef.current?.();
      endPressRef.current = end;
    },
    endPress: () => {
      endPressRef.current?.();
      endPressRef.current = null;
    },
  }), []);
}

export interface DragPressOptions extends ArmDragPressOptions {
  /**
   * Leaves a press unarmed — and resolves one already in flight, because the
   * effect below re-runs on the change. Selection mode uses this so a held row
   * cannot drag itself once the mode the user switched to takes over.
   */
  disabled?: boolean;
}

/**
 * A component's own drag source: returns the `mousedown` handler and resolves
 * an armed press on unmount, on `disabled` flipping, and on a second press.
 */
export function useDragPress(options: DragPressOptions): (e: React.MouseEvent) => void {
  const { disabled = false } = options;
  const handle = useDragPressHandle();

  // React Compiler refs rule: latest-value box so the handler stays stable
  // across renders while still calling this render's callbacks; not render data.
  const latest = useRef(options);
  // eslint-disable-next-line react-hooks/refs
  latest.current = options;

  // React runs this cleanup before re-running on a `disabled` change, so a mode
  // turning on under a held button resolves the press instead of leaving a drag
  // primed behind it. Unmount is covered by the handle itself.
  useEffect(() => handle.endPress, [disabled, handle]);

  return useCallback((e: React.MouseEvent) => {
    if (disabled) return;
    handle.arm(e, {
      preventDefault: latest.current.preventDefault,
      canStart: (ev) => latest.current.canStart?.(ev) ?? true,
      onStart: (me) => latest.current.onStart(me),
      onResolved: () => latest.current.onResolved?.(),
    });
  }, [disabled, handle]);
}

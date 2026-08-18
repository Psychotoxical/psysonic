import { useCallback } from 'react';

export interface OverflowTooltipAttrs {
  onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
  'data-tooltip'?: string;
  'data-tooltip-wrap'?: string;
}

/**
 * Shows a hover tooltip with the full text, but only when the element actually
 * clips it. Spread the result onto a single-line truncating element:
 *
 *   <p className="album-card-title truncate" {...useOverflowTooltip(album.name)}>
 *
 * `anchorText` only has to be non-empty: it marks the element as a tooltip
 * anchor at render time, and the text that is actually shown is read from the
 * DOM on hover. That keeps the tooltip identical to what the user sees even
 * where the visible string is assembled by a child component (artist credits
 * are joined from resolved refs, so the parent has no single source string).
 *
 * Why the attribute is set up front and rewritten on enter, rather than added
 * on enter: `TooltipPortal` picks up anchors via a delegated `mouseover` on
 * `document`, so `data-tooltip` must already be present for the anchor to be
 * seen at all — but it reads the *value* only after its open delay. Rewriting
 * it on enter is therefore correct regardless of handler order:
 *
 *   - ours first  → attribute already gone, `closest()` finds nothing, no timer
 *   - ours second → the timer runs, then reads the corrected value (or bails
 *                   out on an empty one)
 *
 * Measuring on enter rather than at render also stays correct across resizes
 * and late font swaps, without a layout read per card. The one gap that leaves:
 * a layout change *during* the portal's open delay, while the pointer sits
 * still, is not re-measured — the worst case is a tooltip on text that just
 * stopped being clipped. Closing it would mean either re-measuring inside the
 * shared portal or a `mousemove` handler on every card, which costs more than
 * the cosmetic slip it prevents. Removing the attribute also puts it out of
 * sync with React's bookkeeping, so an unchanged `anchorText` will not restore
 * it on a later render — same shape of gap, same cure: the next enter measures
 * again.
 */
export function useOverflowTooltip(
  anchorText: string | null | undefined,
  enabled = true,
): OverflowTooltipAttrs {
  const onMouseEnter = useOverflowTooltipHandler();

  if (!enabled || !anchorText) return {};
  return { onMouseEnter, 'data-tooltip': anchorText, 'data-tooltip-wrap': '' };
}

/**
 * Same behaviour for components that render many anchors through a plain helper
 * function (`renderCard`, `renderItem`), where a hook per row is not allowed.
 * Call this once in the component, then apply the returned factory per row.
 *
 * One shared handler is enough because it keeps no per-anchor state — it reads
 * the text and the measurements off whichever element it fires on.
 */
export function useOverflowTooltipFactory(
  enabled = true,
): (anchorText: string | null | undefined) => OverflowTooltipAttrs {
  const onMouseEnter = useOverflowTooltipHandler();
  return useCallback(
    (anchorText) => (enabled && anchorText
      ? { onMouseEnter, 'data-tooltip': anchorText, 'data-tooltip-wrap': '' }
      : {}),
    [enabled, onMouseEnter],
  );
}

/**
 * Wrapping is not optional for these anchors: one only shows a tooltip when its
 * text is too wide for its card, so the long names this exists for are exactly
 * the ones that would overflow an unwrapped, unbounded box. `TooltipPortal`
 * clamps `left` to the viewport but never the width, so the tail would sit off
 * screen with no ellipsis and no way to reach it.
 */
function useOverflowTooltipHandler() {
  return useCallback((e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    // scrollWidth is the full content width, clientWidth the visible box. Both
    // are rounded to integers, so with fractional grid columns this can disagree
    // with the actual ellipsis by up to a pixel either way — close enough for a
    // convenience tooltip, and cheaper than a per-card range measurement.
    const text = el.textContent?.trim();
    if (text && el.scrollWidth > el.clientWidth) el.setAttribute('data-tooltip', text);
    else el.removeAttribute('data-tooltip');
  }, []);
}

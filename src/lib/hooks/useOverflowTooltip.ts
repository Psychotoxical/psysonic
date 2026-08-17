import { useCallback } from 'react';

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
 * and late font swaps, without a layout read per card.
 */
export function useOverflowTooltip(
  anchorText: string | null | undefined,
  enabled = true,
): {
  onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
  'data-tooltip'?: string;
  'data-tooltip-wrap'?: string;
} {
  const onMouseEnter = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    // scrollWidth is the full content width, clientWidth the visible box — they
    // differ exactly when `text-overflow: ellipsis` has something to cut.
    const text = el.textContent?.trim();
    if (text && el.scrollWidth > el.clientWidth) el.setAttribute('data-tooltip', text);
    else el.removeAttribute('data-tooltip');
  }, []);

  if (!enabled || !anchorText) return {};
  // Wrapping is not optional here: the anchor only shows a tooltip when its text
  // is too wide for the card, so the long titles this exists for are exactly the
  // ones that would overflow an unwrapped, unbounded tooltip box. `TooltipPortal`
  // clamps `left` to the viewport but never the width, so the tail would sit off
  // screen with no ellipsis and no way to reach it.
  return { onMouseEnter, 'data-tooltip': anchorText, 'data-tooltip-wrap': '' };
}

/**
 * Pairs a tooltip with its accessible label so the two never drift apart.
 *
 * Spread onto any element that should show a hover tooltip rendered by
 * `TooltipPortal`. The same already-translated string becomes both the
 * `data-tooltip` (visual hover label) and the `aria-label` (screen readers).
 *
 *   <button {...tooltipAttrs(t('albums.sortTooltip'))} onClick={…}>
 *
 * `pos: 'bottom'` is a viewport-edge escape hatch only (forces the tooltip
 * below the anchor instead of the default auto-flip) — do not use it on
 * ordinary toolbar buttons. `wrap` enables multi-line wrapping.
 */
export function tooltipAttrs(
  text: string,
  opts?: { pos?: 'bottom'; wrap?: boolean },
): Record<string, string> {
  return {
    'data-tooltip': text,
    'aria-label': text,
    ...(opts?.pos ? { 'data-tooltip-pos': opts.pos } : {}),
    ...(opts?.wrap ? { 'data-tooltip-wrap': '' } : {}),
  };
}

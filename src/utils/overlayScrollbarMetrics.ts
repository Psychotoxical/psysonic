export type OverlayScrollbarThumbMeta = {
  thumbH: number;
  thumbT: number;
  visible: boolean;
};

/**
 * @param trackHeight — pixel height of the overlay rail (inset top/bottom).
 *   When shorter than the viewport, thumb size/position must use this or the
 *   thumb’s bottom extends past the visible rail at max scroll.
 */
export function computeOverlayScrollbarThumbMeta(
  el: HTMLElement | null,
  trackHeight?: number,
): OverlayScrollbarThumbMeta {
  if (!el) return { thumbH: 0, thumbT: 0, visible: false };
  const { scrollTop, scrollHeight, clientHeight } = el;
  if (scrollHeight <= clientHeight + 1) {
    return { thumbH: 0, thumbT: 0, visible: false };
  }
  const th =
    trackHeight != null && trackHeight > 0 ? Math.min(trackHeight, clientHeight) : clientHeight;
  const ratio = clientHeight / scrollHeight;
  const rawH = Math.round(ratio * th);
  const thumbH = Math.min(th, Math.max(24, rawH));
  const range = Math.max(0, th - thumbH);
  const scrollRange = scrollHeight - clientHeight;
  const thumbT =
    scrollRange > 0
      ? Math.min(range, Math.max(0, Math.round((scrollTop / scrollRange) * range)))
      : 0;
  return { thumbH, thumbT, visible: true };
}

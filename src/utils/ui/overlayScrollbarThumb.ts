import type { PointerEvent as ReactPointerEvent } from 'react';
import { computeOverlayScrollbarThumbMeta } from './overlayScrollbarMetrics';

/**
 * Drag the overlay scrollbar thumb (native bar is hidden). Maps pointer delta
 * to scrollTop using the same thumb/range geometry as the visual thumb.
 */
export function bindOverlayScrollbarThumbDrag(
  e: ReactPointerEvent<HTMLElement>,
  scrollEl: HTMLDivElement | null,
): void {
  if (e.button !== 0 || !scrollEl) return;
  e.preventDefault();
  e.stopPropagation();

  const thumb = e.currentTarget;
  const rail = thumb.parentElement;
  const trackH =
    rail instanceof HTMLElement && rail.clientHeight > 0 ? rail.clientHeight : scrollEl.clientHeight;
  const meta = computeOverlayScrollbarThumbMeta(scrollEl, trackH);
  if (!meta.visible) return;

  const { scrollHeight, clientHeight } = scrollEl;
  const scrollRange = scrollHeight - clientHeight;
  const range = trackH - meta.thumbH;
  if (range <= 1) return;

  const startScroll = scrollEl.scrollTop;
  const startY = e.clientY;
  const pointerId = e.pointerId;

  thumb.classList.add('is-thumb-dragging');
  document.body.classList.add('is-overlay-scrollbar-thumb-drag');
  try {
    thumb.setPointerCapture(pointerId);
  } catch {
    thumb.classList.remove('is-thumb-dragging');
    document.body.classList.remove('is-overlay-scrollbar-thumb-drag');
    return;
  }

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    const dy = ev.clientY - startY;
    const next = startScroll + (dy / range) * scrollRange;
    scrollEl.scrollTop = Math.max(0, Math.min(scrollRange, next));
  };

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    thumb.classList.remove('is-thumb-dragging');
    document.body.classList.remove('is-overlay-scrollbar-thumb-drag');
    try {
      thumb.releasePointerCapture(pointerId);
    } catch {
      /* ignore */
    }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

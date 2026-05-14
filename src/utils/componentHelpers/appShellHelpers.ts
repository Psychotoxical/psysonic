import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../../constants/appScroll';

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'psysonic_sidebar_collapsed';

export function readInitialSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function persistSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Ignore storage failures and keep in-memory UI state.
  }
}

/**
 * Avoid grabbing the queue resizer when aiming at the main overlay scrollbar.
 * Uses the real main viewport edge (not innerWidth − queueWidth — sidebar/zoom skew that).
 * Only the main-route thumb counts (not queue/mini/sidebar thumbs — selector is scoped).
 *
 * The queue resizer is 6px and sits on the main|queue seam with ~3px overlapping the main
 * column (layout.css `.resizer-queue`). Treating `clientX <= mainRight` as "main" suppressed
 * that overlap and felt like a dead resize strip at certain widths. Thumb hit slop must not
 * extend past `mainRight` or it steals grabs on the resizer.
 */
export function shouldSuppressQueueResizerMouseDown(clientX: number, clientY: number, queueWidth: number): boolean {
  const vp = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID) as HTMLElement | null;
  const mainRight = vp ? vp.getBoundingClientRect().right : window.innerWidth - queueWidth;
  /** Pixels of the resizer that lie left of the main column's right edge (see `.resizer-queue`). */
  const RESIZER_BLEED_INTO_MAIN = 4;

  if (clientX <= mainRight - RESIZER_BLEED_INTO_MAIN) return true;

  const thumbs = document.querySelectorAll<HTMLElement>('.app-shell-route-scroll .overlay-scroll__thumb');
  const xSlop = 22;
  const vPad = 40;
  for (let i = 0; i < thumbs.length; i++) {
    const thumb = thumbs[i];
    const style = window.getComputedStyle(thumb);
    const pointerActive = style.pointerEvents !== 'none';
    const visible = Number.parseFloat(style.opacity || '0') > 0.01;
    if (!pointerActive && !visible) continue;

    const r = thumb.getBoundingClientRect();
    if (r.height < 4 || r.width < 1) continue;
    if (clientY < r.top - vPad || clientY > r.bottom + vPad) continue;
    const thumbHitRight = Math.min(r.right + xSlop, mainRight);
    if (clientX >= r.left - 6 && clientX <= thumbHitRight) return true;
  }
  return false;
}

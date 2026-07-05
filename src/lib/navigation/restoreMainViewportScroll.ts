import { APP_MAIN_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';

const SAFETY_TIMEOUT_MS = 3000;

function clampScrollTop(el: HTMLElement, scrollTop: number): number {
  const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
  return Math.min(Math.max(0, scrollTop), maxScroll);
}

function scrollRestoreMatches(el: HTMLElement, targetScrollTop: number): boolean {
  const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
  if (targetScrollTop > maxScroll + 1) return false;
  const desired = clampScrollTop(el, targetScrollTop);
  return Math.abs(el.scrollTop - desired) <= 1;
}

/** Apply main viewport scroll after route content is ready; retry until layout can reach target. */
export function restoreMainViewportScroll(
  targetScrollTop: number,
  onComplete: () => void,
): () => void {
  let cancelled = false;
  let ro: ResizeObserver | null = null;
  let safetyTimeoutId = 0;

  const finish = () => {
    if (cancelled) return;
    cancelled = true;
    ro?.disconnect();
    ro = null;
    if (safetyTimeoutId) window.clearTimeout(safetyTimeoutId);
    onComplete();
  };

  const apply = () => {
    if (cancelled) return;
    const el = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
    if (!el) return;

    const desired = clampScrollTop(el, targetScrollTop);
    el.scrollTop = desired;
    el.dispatchEvent(new Event('scroll', { bubbles: false }));

    if (scrollRestoreMatches(el, targetScrollTop)) finish();
  };

  const scheduleApply = () => {
    requestAnimationFrame(apply);
  };

  const el = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
  if (el && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(scheduleApply);
    ro.observe(el);
  }

  apply();
  scheduleApply();
  safetyTimeoutId = window.setTimeout(finish, SAFETY_TIMEOUT_MS);

  return finish;
}

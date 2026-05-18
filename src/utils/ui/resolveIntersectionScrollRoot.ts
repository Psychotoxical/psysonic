import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../../constants/appScroll';

/**
 * Scroll container for `IntersectionObserver` priority scoring on cover art.
 * Prefer the nearest scrolling ancestor (in-page browse, queue, route viewport);
 * fall back to known viewport class hooks, then the main route scroll element.
 */
export function resolveIntersectionScrollRoot(node: HTMLElement): Element | null {
  let parent = node.parentElement;
  while (parent) {
    const { overflowY } = window.getComputedStyle(parent);
    if (
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
      && parent.scrollHeight > parent.clientHeight + 2
    ) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return (
    (node.closest('.mainstage-inpage-scroll__viewport') as HTMLElement | null)
    ?? (node.closest('.app-shell-route-scroll__viewport') as HTMLElement | null)
    ?? (document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID) as HTMLElement | null)
  );
}

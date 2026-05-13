import { useEffect, useState } from 'react';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../constants/appScroll';

const SCROLL_IDLE_MS = 180;

/**
 * `true` while the main route viewport or the Now Playing viewport is
 * actively scrolling, falling back to `false` after `SCROLL_IDLE_MS` of
 * silence. Used to fade out the queue handle (and similar floating
 * controls) while the user is scrolling, so they don't sit on top of the
 * overlay scrollbar thumb.
 *
 * Re-binds on `pathname` change because Now Playing's viewport mounts
 * lazily and isn't in the DOM on every route.
 */
export function useMainScrollingIndicator(pathname: string): boolean {
  const [isMainScrolling, setIsMainScrolling] = useState(false);

  useEffect(() => {
    const viewports = new Set<HTMLElement>();
    const appViewport = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
    if (appViewport) viewports.add(appViewport);
    const nowPlayingViewport = document.querySelector<HTMLElement>('.np-main__viewport');
    if (nowPlayingViewport) viewports.add(nowPlayingViewport);
    if (viewports.size === 0) return;

    let scrollHideTimer: number | null = null;

    const onScroll = () => {
      setIsMainScrolling(true);
      if (scrollHideTimer != null) window.clearTimeout(scrollHideTimer);
      scrollHideTimer = window.setTimeout(() => {
        setIsMainScrolling(false);
        scrollHideTimer = null;
      }, SCROLL_IDLE_MS);
    };

    viewports.forEach(viewport => {
      viewport.addEventListener('scroll', onScroll, { passive: true });
    });
    return () => {
      viewports.forEach(viewport => {
        viewport.removeEventListener('scroll', onScroll);
      });
      if (scrollHideTimer != null) window.clearTimeout(scrollHideTimer);
      setIsMainScrolling(false);
    };
  }, [pathname]);

  return isMainScrolling;
}

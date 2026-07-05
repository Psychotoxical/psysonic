import { useEffect, useState } from 'react';
import {
  APP_MAIN_SCROLL_VIEWPORT_ID,
  mainRouteInpageScrollViewportId,
} from '@/constants/appScroll';

const SCROLL_IDLE_MS = 180;

/**
 * `true` while a tracked viewport is actively scrolling, then `false` after
 * `SCROLL_IDLE_MS` of silence. Used to fade out the queue handle (and similar
 * floating controls) while the user is scrolling, so they don't sit on top of
 * the overlay scrollbar thumb.
 *
 * Tracks `#app-main-scroll-viewport`, and on browse routes with a locked main
 * scroll also the matching in-page overlay viewport. Re-binds on `pathname`
 * because Now Playing's viewport mounts lazily.
 */
export function useMainScrollingIndicator(pathname: string): boolean {
  const [isMainScrolling, setIsMainScrolling] = useState(false);

  useEffect(() => {
    const viewports = new Set<HTMLElement>();
    const appViewport = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
    if (appViewport) viewports.add(appViewport);
    const nowPlayingViewport = document.querySelector<HTMLElement>('.np-main__viewport');
    if (nowPlayingViewport) viewports.add(nowPlayingViewport);
    const inpageId = mainRouteInpageScrollViewportId(pathname);
    if (inpageId) {
      const inpageVp = document.getElementById(inpageId);
      if (inpageVp) viewports.add(inpageVp);
    }
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

import { useEffect, useState } from 'react';

/** Adds .is-scrolling-on-scroll cue to the sidebar viewport for 180ms. */
export function useSidebarScrollVisible(sidebarViewportEl: HTMLDivElement | null): boolean {
  const [isSidebarScrolling, setIsSidebarScrolling] = useState(false);

  useEffect(() => {
    if (!sidebarViewportEl) return;
    let hideTimer: number | null = null;

    const onScroll = () => {
      setIsSidebarScrolling(true);
      if (hideTimer != null) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        setIsSidebarScrolling(false);
        hideTimer = null;
      }, 180);
    };

    sidebarViewportEl.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      sidebarViewportEl.removeEventListener('scroll', onScroll);
      if (hideTimer != null) window.clearTimeout(hideTimer);
    };
  }, [sidebarViewportEl]);

  return isSidebarScrolling;
}

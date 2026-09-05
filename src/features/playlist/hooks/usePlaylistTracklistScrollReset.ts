import { useEffect, useRef } from 'react';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';

interface PlaylistTracklistScrollResetInputs {
  id: string | undefined;
  hasActiveFilter: boolean;
  scrollMargin: number;
}

/** Scroll to the tracklist only when the playlist or active filter actually changes. */
export function usePlaylistTracklistScrollReset({
  id,
  hasActiveFilter,
  scrollMargin,
}: PlaylistTracklistScrollResetInputs): void {
  const previousInputsRef = useRef({ id, hasActiveFilter });

  useEffect(() => {
    const previous = previousInputsRef.current;
    previousInputsRef.current = { id, hasActiveFilter };
    if (previous.id === id && previous.hasActiveFilter === hasActiveFilter) return;

    const viewport = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
    if (viewport) viewport.scrollTop = scrollMargin;
  }, [id, hasActiveFilter, scrollMargin]);
}

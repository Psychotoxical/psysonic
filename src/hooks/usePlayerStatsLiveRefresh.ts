import { useEffect, useRef } from 'react';
import { onPlaySessionRecorded } from '../store/playSessionRecorded';

/** Refresh player stats when a listen is persisted or the tab becomes visible again. */
export function usePlayerStatsLiveRefresh(onRefresh: () => void) {
  const onRefreshRef = useRef(onRefresh);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') {
        onRefreshRef.current();
      }
    };

    const unsubRecorded = onPlaySessionRecorded(() => {
      refreshIfVisible();
    });

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        onRefreshRef.current();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      unsubRecorded();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}

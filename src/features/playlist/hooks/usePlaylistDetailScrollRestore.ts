import { useLayoutEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { readPlaylistDetailScrollTop } from '@/lib/navigation/albumDetailNavigation';
import { restoreMainViewportScroll } from '@/lib/navigation/restoreMainViewportScroll';

/** Restore Playlist Detail's main viewport after its virtual track list is ready. */
export function usePlaylistDetailScrollRestore(contentReady: boolean): void {
  const location = useLocation();
  const navigate = useNavigate();
  const scrollTop = readPlaylistDetailScrollTop(location.state);

  useLayoutEffect(() => {
    if (!contentReady || scrollTop === null) return;
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    let active = true;
    const finish = () => {
      if (active) navigate(returnTo, { replace: true, state: null });
    };
    if (scrollTop <= 0) {
      finish();
      return;
    }
    const cancel = restoreMainViewportScroll(scrollTop, finish);
    return () => {
      active = false;
      cancel();
    };
  }, [contentReady, location.pathname, location.search, location.hash, navigate, scrollTop]);
}

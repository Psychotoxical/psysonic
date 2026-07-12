import { useEffect, useState } from 'react';
import { fetchNavidromePublicShare } from '@/lib/share/fetchNavidromePublicShare';
import type { FetchNavidromePublicShareError, NavidromePublicShareInfo } from '@/lib/share/navidromePublicShareTypes';
import type { NavidromePublicShareRef } from '@/lib/share/navidromePublicShareUrl';

export type NavidromePublicSharePreviewState = {
  navidromeShareInfo: NavidromePublicShareInfo | null;
  navidromeShareResolving: boolean;
  navidromeShareError: FetchNavidromePublicShareError | null;
};

const EMPTY: NavidromePublicSharePreviewState = {
  navidromeShareInfo: null,
  navidromeShareResolving: false,
  navidromeShareError: null,
};

export function useNavidromePublicSharePreview(
  ref: NavidromePublicShareRef | null,
  enabled = true,
): NavidromePublicSharePreviewState {
  const [state, setState] = useState<NavidromePublicSharePreviewState>(EMPTY);

  useEffect(() => {
    if (!enabled || !ref) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(EMPTY);
      return;
    }

    let cancelled = false;
    setState({ ...EMPTY, navidromeShareResolving: true });

    void fetchNavidromePublicShare(ref)
      .then(result => {
        if (cancelled) return;
        if (result.type === 'ok') {
          setState({
            navidromeShareInfo: result.info,
            navidromeShareResolving: false,
            navidromeShareError: null,
          });
          return;
        }
        setState({
          navidromeShareInfo: null,
          navidromeShareResolving: false,
          navidromeShareError: result.reason,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            navidromeShareInfo: null,
            navidromeShareResolving: false,
            navidromeShareError: 'unreachable',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, ref]);

  return state;
}

import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrbitStore } from '../store/orbitStore';
import {
  suggestOrbitTrack,
  hostEnqueueToOrbit,
  evaluateOrbitSuggestGate,
  OrbitSuggestBlockedError,
} from '../utils/orbit';
import { showToast } from '../utils/ui/toast';

/**
 * Shared behaviour for song rows that in "normal mode" swallow a full list
 * into the queue on single-click (AlbumDetail, PlaylistDetail, Favorites,
 * ArtistDetail top-songs, SearchResults, RandomMix, AdvancedSearch).
 *
 * In an active Orbit session this is too destructive — the list would
 * propagate to every guest's player. Instead:
 *
 *   - `queueHint()`   — show a toast telling the user to double-click.
 *                       Safe to call on every single-click; 220 ms debounce
 *                       suppresses the pileup that browsers emit before a
 *                       dblclick fires.
 *   - `addTrackToOrbit(songId)` — cancel any pending hint and add just that
 *                       one track: suggestOrbitTrack for guests,
 *                       hostEnqueueToOrbit for the host.
 *
 * `orbitActive` is the gate — when false, callers should skip the hint and
 * run their original bulk-play path unchanged.
 */
export function useOrbitSongRowBehavior() {
  const { t } = useTranslation();
  const orbitRole = useOrbitStore(s => s.role);
  const orbitActive = orbitRole === 'host' || orbitRole === 'guest';
  const clickTimerRef = useRef<number | null>(null);

  const queueHint = useCallback(() => {
    if (clickTimerRef.current !== null) return;
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      showToast(t('albumDetail.orbitDoubleClickHint'), 2400, 'info');
    }, 220);
  }, [t]);

  const addTrackToOrbit = useCallback((songId: string) => {
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (orbitRole === 'guest') {
      const gate = evaluateOrbitSuggestGate();
      if (!gate.allowed && gate.reason === 'muted') {
        showToast(t('orbit.suggestBlockedMuted'), 3500, 'error');
        return;
      }
      suggestOrbitTrack(songId)
        .then(() => showToast(t('orbit.ctxSuggestedToast'), 2200, 'info'))
        .catch(err => {
          if (err instanceof OrbitSuggestBlockedError && err.reason === 'muted') {
            showToast(t('orbit.suggestBlockedMuted'), 3500, 'error');
          } else {
            showToast(t('orbit.ctxSuggestFailed'), 3000, 'error');
          }
        });
    } else if (orbitRole === 'host') {
      hostEnqueueToOrbit(songId)
        .then(() => showToast(t('orbit.ctxAddedHostToast'), 2200, 'info'))
        .catch(() => showToast(t('orbit.ctxAddHostFailed'), 3000, 'error'));
    }
  }, [orbitRole, t]);

  return { orbitActive, queueHint, addTrackToOrbit };
}

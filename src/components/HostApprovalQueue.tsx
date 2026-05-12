import { getSong } from '../api/subsonicLibrary';
import type { SubsonicSong } from '../api/subsonicTypes';
import { useEffect, useMemo, useState } from 'react';
import { Check, X, Inbox } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOrbitStore } from '../store/orbitStore';
import {
  approveOrbitSuggestion,
  declineOrbitSuggestion,
  suggestionKey,
} from '../utils/orbit';
import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonic';
import CachedImage from './CachedImage';
import { ORBIT_DEFAULT_SETTINGS } from '../api/orbit';

/**
 * Host-only approval strip. Renders directly below the OrbitQueueHead
 * when `autoApprove === false` and at least one guest suggestion is
 * waiting. Shows each pending track with Approve / Decline controls.
 *
 * Only rendered by the host-side render path (QueuePanel); guests never
 * see this section — they watch their own pending list.
 */
export default function HostApprovalQueue() {
  const { t } = useTranslation();
  const role = useOrbitStore(s => s.role);
  const state = useOrbitStore(s => s.state);
  const mergedKeys = useOrbitStore(s => s.mergedSuggestionKeys);
  const declinedKeys = useOrbitStore(s => s.declinedSuggestionKeys);

  const settings = state?.settings ?? ORBIT_DEFAULT_SETTINGS;
  const autoApproveOff = settings.autoApprove === false;

  // Pending = everything in the session's suggestion history that isn't
  // host-authored, isn't already merged, and hasn't been declined.
  const pendingItems = useMemo(() => {
    if (!state) return [];
    const mergedSet = new Set(mergedKeys);
    const declinedSet = new Set(declinedKeys);
    return state.queue.filter(q =>
      q.addedBy !== state.host
      && !mergedSet.has(suggestionKey(q))
      && !declinedSet.has(suggestionKey(q))
    );
  }, [state, mergedKeys, declinedKeys]);

  // Track-metadata cache (title/artist/cover) for the pending items.
  const [songs, setSongs] = useState<Record<string, SubsonicSong>>({});
  const wantedKey = useMemo(
    () => Array.from(new Set(pendingItems.map(q => q.trackId))).sort().join('|'),
    [pendingItems],
  );
  useEffect(() => {
    const wanted = wantedKey ? wantedKey.split('|') : [];
    const missing = wanted.filter(id => id && !songs[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(missing.map(id => getSong(id).catch(() => null)))
      .then(results => {
        if (cancelled) return;
        setSongs(prev => {
          const next = { ...prev };
          results.forEach((s, i) => { if (s) next[missing[i]] = s; });
          return next;
        });
      });
    return () => { cancelled = true; };
  }, [wantedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (role !== 'host' || !state || !autoApproveOff || pendingItems.length === 0) {
    return null;
  }

  return (
    <div className="host-approval">
      <div className="host-approval__head">
        <Inbox size={12} />
        <span>{t('orbit.approvalTitle')}</span>
        <span className="host-approval__count">{pendingItems.length}</span>
      </div>
      <div className="host-approval__list">
        {pendingItems.map(q => {
          const song = songs[q.trackId];
          const key = suggestionKey(q);
          return (
            <div key={key} className="host-approval__item">
              {song?.coverArt ? (
                <CachedImage
                  src={buildCoverArtUrl(song.coverArt, 48)}
                  cacheKey={coverArtCacheKey(song.coverArt, 48)}
                  alt=""
                  className="host-approval__cover"
                />
              ) : (
                <div className="host-approval__cover host-approval__cover--ph" />
              )}
              <div className="host-approval__info">
                <div className="host-approval__title">{song?.title ?? '…'}</div>
                <div className="host-approval__artist">{song?.artist ?? ''}</div>
                <div className="host-approval__submitter">
                  {t('orbit.approvalFrom', { user: q.addedBy })}
                </div>
              </div>
              <div className="host-approval__actions">
                <button
                  type="button"
                  className="host-approval__btn host-approval__btn--approve"
                  onClick={() => { void approveOrbitSuggestion(q); }}
                  data-tooltip={t('orbit.approvalAccept')}
                  aria-label={t('orbit.approvalAccept')}
                >
                  <Check size={13} />
                </button>
                <button
                  type="button"
                  className="host-approval__btn host-approval__btn--decline"
                  onClick={() => { declineOrbitSuggestion(q); }}
                  data-tooltip={t('orbit.approvalDecline')}
                  aria-label={t('orbit.approvalDecline')}
                >
                  <X size={13} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

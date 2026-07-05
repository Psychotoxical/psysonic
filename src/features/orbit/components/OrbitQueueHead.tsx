import { useEffect, useState } from 'react';
import { Users, Wifi, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOrbitStore } from '@/features/orbit/store/orbitStore';
import type { OrbitState } from '@/features/orbit/api/orbit';

interface Props {
  state: OrbitState;
}

/** Host's state hasn't updated for this long → guest treats them as offline. */
const HOST_AWAY_THRESHOLD_MS = 15_000;

/**
 * Shared Orbit head strip rendered at the top of the queue for both host
 * and guest. Shows the session name and a comma-separated list of every
 * participant (host first, then guests in join order).
 *
 * Guest view additionally surfaces host-presence: when the host's tick
 * hasn't been seen for 15 s we render a subtle "host offline" badge so
 * the guest knows the stalled playback isn't a local problem.
 */
export default function OrbitQueueHead({ state }: Props) {
  const { t } = useTranslation();
  const role = useOrbitStore(s => s.role);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Guest-only clock tick — React wouldn't re-render a stale state blob
  // on its own, and the presence threshold is time-based.
  useEffect(() => {
    if (role !== 'guest') return;
    const id = window.setInterval(() => setNowMs(Date.now()), 2000);
    return () => window.clearInterval(id);
  }, [role]);

  const names = [state.host, ...state.participants.map(p => p.user)];
  const showPresence = role === 'guest' && state.positionAt > 0;
  const hostAway = showPresence && (nowMs - state.positionAt) > HOST_AWAY_THRESHOLD_MS;

  return (
    <div className="orbit-queue-head">
      <div className="orbit-queue-head__title-row">
        <h2 className="orbit-queue-head__title">{state.name}</h2>
        {showPresence && (
          <span
            className={`orbit-queue-head__presence orbit-queue-head__presence--${hostAway ? 'away' : 'online'}`}
            role="status"
          >
            {hostAway ? <WifiOff size={11} /> : <Wifi size={11} />}
            <span>{t(hostAway ? 'orbit.hostAway' : 'orbit.hostOnline')}</span>
          </span>
        )}
      </div>
      <div className="orbit-queue-head__meta">
        <Users size={11} />
        <span className="orbit-queue-head__names">{names.join(', ')}</span>
      </div>
    </div>
  );
}

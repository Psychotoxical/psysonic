import { useEffect, useRef, useState } from 'react';
import { X, RefreshCw, Shuffle, Settings2, Share2, HelpCircle, Activity } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOrbitStore } from '../store/orbitStore';
import { useHelpModalStore } from '../store/helpModalStore';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import { getSong } from '../api/subsonic';
import {
  endOrbitSession,
  leaveOrbitSession,
  computeOrbitDriftMs,
  effectiveShuffleIntervalMs,
} from '../utils/orbit';
import { estimateLivePosition } from '../api/orbit';
import OrbitParticipantsPopover from './OrbitParticipantsPopover';
import OrbitExitModal from './OrbitExitModal';
import OrbitSettingsPopover from './OrbitSettingsPopover';
import OrbitSharePopover from './OrbitSharePopover';
import OrbitDiagnosticsPopover from './OrbitDiagnosticsPopover';
import ConfirmModal from './ConfirmModal';

/**
 * Orbit — top-strip session indicator.
 *
 * Visible whenever the local store reports an active (or just-ended)
 * session. Shows session name, host, participant count, shuffle countdown,
 * and role-appropriate action buttons (catch-up for guests, exit for
 * everyone).
 *
 * Deliberately low-chrome: sits above the rest of the app without
 * reshaping the layout.
 */

const CATCH_UP_DRIFT_THRESHOLD_MS = 3_000;

function formatCountdown(ms: number): string {
  const clamped = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function OrbitSessionBar() {
  const { t } = useTranslation();
  const state              = useOrbitStore(s => s.state);
  const role               = useOrbitStore(s => s.role);
  const phase              = useOrbitStore(s => s.phase);
  const errorMessage       = useOrbitStore(s => s.errorMessage);
  const [nowMs, setNowMs]  = useState(() => Date.now());
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const peopleBtnRef = useRef<HTMLButtonElement>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const shareBtnRef = useRef<HTMLButtonElement>(null);
  const diagBtnRef = useRef<HTMLButtonElement>(null);

  // Second-level tick just for the shuffle countdown + drift readout —
  // the store itself only ticks at 2.5 s which is too coarse for a smooth
  // countdown.
  useEffect(() => {
    if (!state || phase !== 'active') return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [state, phase]);

  // Bar is visible while active, ended (pre-ack), or explicitly kicked / soft-removed.
  const shouldShowBar = !!state && (
    phase === 'active'
    || phase === 'ended'
    || (phase === 'error' && (errorMessage === 'kicked' || errorMessage === 'removed'))
  );
  if (!shouldShowBar || !state) return (
    <OrbitExitModal />
  );

  const untilShuffle = Math.max(0, (state.lastShuffle + effectiveShuffleIntervalMs(state)) - nowMs);

  // Guest-only: detect drift from the host's estimated live position.
  const guestPlayback = usePlayerStore.getState();
  const localPositionMs = Math.round((guestPlayback.currentTime ?? 0) * 1000);
  const driftMs = role === 'guest' && state.currentTrack && guestPlayback.currentTrack?.id === state.currentTrack.trackId
    ? computeOrbitDriftMs(state, localPositionMs, nowMs)
    : null;
  const showCatchUp = role === 'guest'
    && state.isPlaying
    && state.currentTrack
    && (driftMs == null || Math.abs(driftMs) > CATCH_UP_DRIFT_THRESHOLD_MS);

  const performExit = async () => {
    try {
      if (role === 'host') await endOrbitSession();
      else if (role === 'guest') await leaveOrbitSession();
      else useOrbitStore.getState().reset();
    } catch {
      useOrbitStore.getState().reset();
    }
  };

  const onExit = () => {
    // Active-session exits get a confirm — guests don't want to drop out on
    // a fat-finger, and the host's X ends the session for everyone, so
    // accidentally clicking it is even worse. Post-end/kicked dismissals
    // skip the confirm (the session is already over there).
    if (phase === 'active' && (role === 'guest' || role === 'host')) {
      setConfirmLeave(true);
      return;
    }
    void performExit();
  };

  const onCatchUp = async () => {
    if (!state.currentTrack) return;
    const trackId = state.currentTrack.trackId;
    const targetMs = estimateLivePosition(state, Date.now());
    const targetSec = Math.max(0, targetMs / 1000);
    const hostPlaying = state.isPlaying;
    try {
      const song = await getSong(trackId);
      if (!song) return;
      const track = songToTrack(song);
      const player = usePlayerStore.getState();
      const fraction = targetSec / Math.max(1, track.duration);
      if (player.currentTrack?.id === trackId) {
        player.seek(fraction);
        if (hostPlaying && !player.isPlaying) player.resume();
        else if (!hostPlaying && player.isPlaying) player.pause();
      } else {
        // Different track: play + seek on next tick once engine is ready.
        player.playTrack(track, [track]);
        window.setTimeout(() => {
          const p = usePlayerStore.getState();
          if (p.currentTrack?.id !== trackId) return;
          p.seek(fraction);
          if (!hostPlaying && p.isPlaying) p.pause();
        }, 400);
      }
    } catch {
      // silent — if the track is gone from the host's library, nothing we can do.
    }
  };

  const participantCount = state.participants.length + 1; // +1 for the host

  return (
    <div className="orbit-bar">
      <div className="orbit-bar__left">
        <span className="orbit-bar__dot" aria-hidden="true" />
        <span className="orbit-bar__name">{state.name}</span>
        <span className="orbit-bar__sep">·</span>
        <button
          ref={peopleBtnRef}
          type="button"
          className="orbit-bar__count"
          onClick={() => setPeopleOpen(v => !v)}
          data-tooltip={t('orbit.participantsTooltip')}
          aria-haspopup="menu"
          aria-expanded={peopleOpen || undefined}
        >
          {participantCount}/{state.maxUsers}
        </button>
        <span className="orbit-bar__sep">·</span>
        <span className="orbit-bar__host">{t('orbit.hostLabel', { name: state.host })}</span>
      </div>

      <div className="orbit-bar__center">
        <span className="orbit-bar__shuffle">
          <Shuffle size={13} className="orbit-bar__shuffle-icon" />
          <span>{t('orbit.shuffleLabel')}</span>
          <strong className="orbit-bar__shuffle-time">{formatCountdown(untilShuffle)}</strong>
        </span>
      </div>

      <div className="orbit-bar__right">
        {role === 'host' && (
          <button
            ref={settingsBtnRef}
            type="button"
            className="orbit-bar__settings"
            onClick={() => setSettingsOpen(v => !v)}
            data-tooltip={t('orbit.settingsTooltip')}
            aria-haspopup="menu"
            aria-expanded={settingsOpen || undefined}
          >
            <Settings2 size={14} />
          </button>
        )}
        {role === 'host' && (
          <button
            ref={shareBtnRef}
            type="button"
            className="orbit-bar__settings"
            onClick={() => setShareOpen(v => !v)}
            data-tooltip={t('orbit.shareTooltip')}
            aria-haspopup="menu"
            aria-expanded={shareOpen || undefined}
            aria-label={t('orbit.shareTooltip')}
          >
            <Share2 size={14} />
          </button>
        )}
        {showCatchUp && (
          <button
            type="button"
            className="orbit-bar__catchup"
            onClick={onCatchUp}
            data-tooltip={t('orbit.catchUpTooltip')}
          >
            <RefreshCw size={13} />
            <span>{t('orbit.catchUpLabel')}</span>
          </button>
        )}
        <button
          ref={diagBtnRef}
          type="button"
          className="orbit-bar__settings"
          onClick={() => setDiagOpen(v => !v)}
          data-tooltip={t('orbit.diag.openTooltip')}
          aria-haspopup="dialog"
          aria-expanded={diagOpen || undefined}
          aria-label={t('orbit.diag.openTooltip')}
        >
          <Activity size={14} />
        </button>
        <button
          type="button"
          className="orbit-bar__settings"
          onClick={() => useHelpModalStore.getState().open()}
          data-tooltip={t('orbit.helpTooltip')}
          aria-label={t('orbit.helpTooltip')}
        >
          <HelpCircle size={14} />
        </button>
        <button
          type="button"
          className="orbit-bar__exit"
          onClick={onExit}
          data-tooltip={role === 'host' ? t('orbit.endTooltip') : t('orbit.leaveTooltip')}
          aria-label={role === 'host' ? t('orbit.endTooltip') : t('orbit.leaveTooltip')}
        >
          <X size={15} />
        </button>
      </div>

      {peopleOpen && (
        <OrbitParticipantsPopover
          anchorRef={peopleBtnRef}
          onClose={() => setPeopleOpen(false)}
        />
      )}
      {settingsOpen && (
        <OrbitSettingsPopover
          anchorRef={settingsBtnRef}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {shareOpen && (
        <OrbitSharePopover
          anchorRef={shareBtnRef}
          onClose={() => setShareOpen(false)}
        />
      )}
      {diagOpen && (
        <OrbitDiagnosticsPopover
          anchorRef={diagBtnRef}
          onClose={() => setDiagOpen(false)}
        />
      )}
      <OrbitExitModal />
      <ConfirmModal
        open={confirmLeave}
        title={role === 'host'
          ? t('orbit.confirmEndTitle')
          : t('orbit.confirmLeaveTitle')}
        message={role === 'host'
          ? t('orbit.confirmEndBody', { name: state.name })
          : t('orbit.confirmLeaveBody', { name: state.name, host: state.host })}
        confirmLabel={role === 'host'
          ? t('orbit.confirmEndConfirm')
          : t('orbit.confirmLeaveConfirm')}
        cancelLabel={t('orbit.confirmCancel')}
        danger={role === 'host'}
        onConfirm={() => { setConfirmLeave(false); void performExit(); }}
        onCancel={() => setConfirmLeave(false)}
      />
    </div>
  );
}

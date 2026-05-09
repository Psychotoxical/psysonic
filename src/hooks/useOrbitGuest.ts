import { useEffect, useRef } from 'react';
import { useOrbitStore } from '../store/orbitStore';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import { getSong } from '../api/subsonic';
import {
  readOrbitState,
  writeOrbitHeartbeat,
} from '../utils/orbit';
import { orbitOutboxPlaylistName, estimateLivePosition, type OrbitState } from '../api/orbit';
import { pushOrbitEvent } from '../utils/orbitDiag';

/**
 * Orbit — guest-side tick hook.
 *
 * Mounted at the app shell; only does work when the local store says we're
 * a guest in an active session. Two independent timers:
 *
 *   - **State read** (2.5 s): pull the canonical state from the session
 *     playlist's comment and mirror it into the store. Detect session end
 *     or own kick and tear down.
 *   - **Heartbeat** (10 s): refresh the guest's own outbox playlist
 *     comment so the host's participant sweep sees the user as alive.
 *
 * Reads are best-effort; a transient Navidrome outage just delays state
 * updates by a tick or two. The session continues locally as long as the
 * playback engine has the current track loaded.
 */

const STATE_READ_TICK_MS = 2_500;
const HEARTBEAT_TICK_MS  = 10_000;
/**
 * Host must be quiet (no state writes) for this long before we treat the
 * session as dead and auto-leave. Well above any normal network blip —
 * reconnects inside this window are silent. Tuned per user decision:
 * manual exits have priority, short reconnects never trigger auto-close.
 */
const HOST_TIMEOUT_MS = 5 * 60_000;

export function useOrbitGuest(): void {
  const role              = useOrbitStore(s => s.role);
  const phase             = useOrbitStore(s => s.phase);
  const sessionPlaylistId = useOrbitStore(s => s.sessionPlaylistId);
  const outboxPlaylistId  = useOrbitStore(s => s.outboxPlaylistId);
  const sessionId         = useOrbitStore(s => s.sessionId);

  const active = role === 'guest' && phase === 'active' && !!sessionPlaylistId;

  /**
   * Last host playback state we *applied* to the local player. Compared
   * against the new tick to detect host-side flips (track change /
   * play-pause toggle) and against the local player's current state to
   * detect guest-side divergence (the guest paused or skipped on their own).
   *
   * Reset to null on (re-)activation so a fresh session re-syncs from scratch.
   */
  const lastAppliedRef = useRef<{ trackId: string | null; isPlaying: boolean } | null>(null);

  // ── State read + end/kick detection + auto-sync to host ──────────────
  useEffect(() => {
    if (!active || !sessionPlaylistId) return;

    let cancelled = false;
    lastAppliedRef.current = null;

    /**
     * Load `trackId` into the local player and seek to the host's live
     * position. Mirrors the host's `isPlaying` state — a guest joining a
     * paused host doesn't auto-start, a guest joining a playing host must
     * start. Best-effort; silent on miss.
     *
     * Seek + state-mirror is applied once the engine reports the target
     * track as `isPlaying` (polled up to 2 s), with a final fallback apply
     * past the deadline so a loading error doesn't leave the guest stuck
     * on a silent pause.
     */
    const syncToHost = async (trackId: string, hostState: OrbitState): Promise<boolean> => {
      try {
        const song = await getSong(trackId);
        if (!song || cancelled) return false;
        const track = songToTrack(song);
        // Clamp fraction to [0, 0.99] — if the host's positionAt is unusually
        // stale, estimateLivePosition can overshoot the track duration and a
        // seek past the end would immediately trigger audio:ended.
        const calcFraction = () => {
          const targetMs = estimateLivePosition(hostState, Date.now());
          const targetSec = Math.max(0, targetMs / 1000);
          return Math.max(0, Math.min(0.99, targetSec / Math.max(1, track.duration)));
        };
        const applyMirror = (): boolean => {
          const p = usePlayerStore.getState();
          if (cancelled || p.currentTrack?.id !== trackId) return false;
          p.seek(calcFraction());
          if (hostState.isPlaying && !p.isPlaying) p.resume();
          else if (!hostState.isPlaying && p.isPlaying) p.pause();
          return true;
        };

        const player = usePlayerStore.getState();
        const sameTrack = player.currentTrack?.id === trackId;
        // Take the cheap path only when the engine is actually in the
        // state the host expects. If the track is loaded but the engine
        // never reported `isPlaying === true` (slow cold-start, audio-
        // device warmup), this branch used to fire `seek` + `resume`
        // into a stuck engine — the seek silently no-oped and `resume`
        // can't restart a track that never started. Result: guest sees
        // "synced" but hears nothing until the next host-driven track
        // change kicks a fresh `playTrack`. Falling through to a fresh
        // `playTrack` here re-initialises the engine instead.
        if (sameTrack && player.isPlaying === hostState.isPlaying) {
          return applyMirror();
        }
        if (sameTrack && player.isPlaying && !hostState.isPlaying) {
          // We're playing but host is paused — pause locally without
          // re-loading the track.
          return applyMirror();
        }

        player.playTrack(track, [track]);

        // Poll until the engine actually reports the track playing — the
        // earlier "blind apply at deadline" path could fire a seek into a
        // not-yet-ready engine, where the seek silently no-ops and the
        // guest plays from 0 while believing they're synced (the visible
        // 50 % jump-on-Catch-Up symptom). Wait for `p.isPlaying === true`
        // up to 5 s, then give up and let the outer pull tick retry —
        // the syncToHost-failed path keeps `lastAppliedRef` null so the
        // 500 ms fast-poll in `tick` will try again immediately.
        return await new Promise<boolean>(resolve => {
          const deadline = Date.now() + 5000;
          const poll = () => {
            if (cancelled) { resolve(false); return; }
            const p = usePlayerStore.getState();
            const trackReady = p.currentTrack?.id === trackId;
            if (trackReady && p.isPlaying) { resolve(applyMirror()); return; }
            if (Date.now() >= deadline) { resolve(false); return; }
            window.setTimeout(poll, 100);
          };
          window.setTimeout(poll, 100);
        });
      } catch { return false; }
    };

    const pull = async () => {
      const state = await readOrbitState(sessionPlaylistId);
      if (cancelled) return;

      if (!state) {
        // Session playlist is gone — almost always means the host ended the
        // session and the `ended:true` write was missed because we polled
        // after the subsequent playlist delete. Surface the same modal the
        // explicit `state.ended` branch does; the store still holds the last
        // known state so the modal can render the host + session name copy.
        // Outbox cleanup runs from the modal's OK handler via leaveOrbitSession.
        pushOrbitEvent('pull', 'state read returned null — playlist gone, ending session');
        useOrbitStore.getState().setPhase('ended');
        return;
      }

      useOrbitStore.getState().setState(state);

      // Auto-leave after prolonged host silence. We keep polling as long as
      // state reads succeed (short reconnects are silent), but if the host
      // hasn't written a fresh state blob for > HOST_TIMEOUT_MS we treat the
      // session as effectively dead and surface the exit modal. Manual exit
      // still works instantly — the bar's X button short-circuits this path.
      if (state.positionAt > 0 && (Date.now() - state.positionAt) > HOST_TIMEOUT_MS) {
        useOrbitStore.getState().setError('host-timeout');
        return;
      }

      // Reconcile pending guest suggestions against the host's *playable*
      // queue — NOT `state.queue`, which is the suggestion history (every
      // submission lands there immediately, even under manual-approval mode
      // where the host hasn't actually accepted the track yet).
      // `state.playQueue` is the host's real upcoming queue, so a trackId
      // appearing there (or as `currentTrack`) means the host has merged it.
      if (useOrbitStore.getState().pendingSuggestions.length > 0) {
        const landed = new Set<string>();
        for (const q of (state.playQueue ?? [])) landed.add(q.trackId);
        if (state.currentTrack) landed.add(state.currentTrack.trackId);
        useOrbitStore.getState().reconcilePendingSuggestions(landed);
      }

      // Host signalled session end: surface via `phase`, let the UI handle
      // the modal. Outbox cleanup still happens via leaveOrbitSession().
      if (state.ended) {
        useOrbitStore.getState().setPhase('ended');
        return;
      }

      // Kicked / soft-removed: transition into the error phase with a
      // matching errorMessage so the UI can pick the right copy.
      const me = useAuthStore.getState().getActiveServer()?.username;
      if (me && state.kicked.includes(me)) {
        useOrbitStore.getState().setError('kicked');
        return;
      }
      // Soft-remove: only react to markers strictly newer than our own join
      // time, otherwise a stale marker from a prior session-life would
      // immediately bounce us out on rejoin.
      if (me && state.removed && state.removed.length > 0) {
        const joinedAt = useOrbitStore.getState().joinedAt ?? 0;
        const hit = state.removed.find(r => r.user === me && r.at > joinedAt);
        if (hit) {
          useOrbitStore.getState().setError('removed');
          return;
        }
      }

      // ── Auto-sync host playback into local player ──
      // Rules:
      //   1. First tick after activation → mirror host (initial join sync,
      //      no need for the guest to click catch-up to get started).
      //   2. Track changed at host → guest follows ONLY if they haven't
      //      locally diverged. A guest who hit pause should stay paused
      //      even when the host moves to the next song; otherwise their
      //      pause button silently un-does itself. If diverged, we just
      //      advance the anchor so Catch Up stays the opt-in path.
      //   3. Same track, host flipped play/pause → mirror only if the local
      //      player still matches our last-applied host state. If the guest
      //      paused/resumed locally, we leave them alone — they have to
      //      click catch-up to opt back in.
      const player = usePlayerStore.getState();
      const hostTrackId  = state.currentTrack?.trackId ?? null;
      const hostPlaying  = state.isPlaying;
      const last = lastAppliedRef.current;

      pushOrbitEvent('pull', JSON.stringify({
        host: { track: hostTrackId, playing: hostPlaying, posMs: state.positionMs, posAt: state.positionAt },
        guest: { track: player.currentTrack?.id ?? null, playing: player.isPlaying, posSec: Math.round(player.currentTime ?? 0) },
        last,
      }));

      // Engine-recovery: detect a silent `audio_play` failure after our
      // optimistic `isPlaying: true` mark. `playTrack` flips the store
      // flag synchronously before the Tauri call resolves, so the
      // post-playTrack poll sees `isPlaying === true` even when the
      // engine never actually started; if `audio_play` later rejects,
      // the catch handler sets `isPlaying: false`. Without this check
      // the divergence-detection branches all pass (last/host both
      // think we're playing) and the guest stays stuck silent. Reset
      // `lastAppliedRef` so the next iteration re-runs initial-sync.
      if (
        last
        && last.isPlaying
        && !player.isPlaying
        && hostPlaying
        && last.trackId === hostTrackId
        && last.trackId === player.currentTrack?.id
      ) {
        pushOrbitEvent('engine-recovery', 'engine fell back to paused while host plays — re-syncing');
        lastAppliedRef.current = null;
      }

      // Re-read after the recovery check above may have reset it.
      const currentLast = lastAppliedRef.current;
      if (!currentLast) {
        // Initial sync: only record `last` *after* syncToHost actually
        // landed. If the first attempt loses the race (engine not ready,
        // stale audio state, network blip), a retry ticker below will try
        // again every 500 ms until it succeeds. Without this, the first
        // failed sync set `last` anyway and the guest was stuck on their
        // pre-join state until they clicked Catch Up.
        if (hostTrackId) {
          pushOrbitEvent('initial-sync', `attempting initial sync to ${hostTrackId} (hostPlaying=${hostPlaying})`);
          const ok = await syncToHost(hostTrackId, state);
          pushOrbitEvent('initial-sync', `result: ${ok ? 'success' : 'failed (will retry)'}`);
          if (ok) lastAppliedRef.current = { trackId: hostTrackId, isPlaying: hostPlaying };
        } else {
          pushOrbitEvent('initial-sync', 'host has no current track yet, anchor only');
          lastAppliedRef.current = { trackId: null, isPlaying: hostPlaying };
        }
      } else if (currentLast.trackId !== hostTrackId) {
        // Distinguish "user manually paused" (true divergence) from "track
        // ended naturally" (NOT divergence — guest just needs the host's
        // next track loaded). Both leave `player.isPlaying === false`, but
        // `handleAudioEnded` keeps `currentTrack` pinned to the just-ended
        // track and resets `currentTime` to 0; a manual pause leaves
        // `currentTime` somewhere mid-track. The 0-position discriminator
        // separates them.
        const naturalEnd = !player.isPlaying
          && player.currentTrack?.id === currentLast.trackId
          && (player.currentTime ?? 0) < 0.5;
        const diverged = !naturalEnd && player.isPlaying !== currentLast.isPlaying;
        if (diverged) {
          // Guest is running their own show (typically: paused while host
          // kept going). Do not load/start the host's new track — just
          // track the host state so the catch-up prompt stays accurate.
          pushOrbitEvent('track-change',
            `host: ${currentLast.trackId} → ${hostTrackId} BUT guest diverged (player.isPlaying=${player.isPlaying} ≠ last.isPlaying=${currentLast.isPlaying}) — NOT loading new track`);
          lastAppliedRef.current = { trackId: hostTrackId, isPlaying: hostPlaying };
        } else if (hostTrackId) {
          pushOrbitEvent('track-change', `host: ${currentLast.trackId} → ${hostTrackId}, guest in sync, following`);
          void syncToHost(hostTrackId, state);
          lastAppliedRef.current = { trackId: hostTrackId, isPlaying: hostPlaying };
        } else {
          pushOrbitEvent('track-change', `host cleared current track, pausing guest`);
          if (player.isPlaying) player.pause();
          lastAppliedRef.current = { trackId: hostTrackId, isPlaying: hostPlaying };
        }
      } else if (currentLast.isPlaying !== hostPlaying) {
        // Only mirror when the guest hasn't diverged. We compare against the
        // *last applied* host state, not the new one — divergence means the
        // local player no longer matches what we last pushed in.
        const localMatchesLast = player.isPlaying === currentLast.isPlaying;
        pushOrbitEvent('play-pause-flip',
          `host: ${currentLast.isPlaying} → ${hostPlaying}, guest matches last=${localMatchesLast} (will ${localMatchesLast ? 'mirror' : 'skip'})`);
        if (localMatchesLast) {
          if (hostPlaying) player.resume();
          else             player.pause();
        }
        // Either way, advance the anchor so we don't keep retrying the same
        // flip every tick.
        lastAppliedRef.current = { trackId: currentLast.trackId, isPlaying: hostPlaying };
      }
    };

    // Self-scheduling tick: fast-poll (500 ms) while we haven't locked in an
    // initial sync yet, fall back to the steady cadence once we're anchored.
    // Lets a failed first attempt retry quickly without spamming the network
    // for the lifetime of the session.
    let timer: number | null = null;
    const tick = async () => {
      timer = null;
      await pull();
      if (cancelled) return;
      const delay = lastAppliedRef.current === null ? 500 : STATE_READ_TICK_MS;
      timer = window.setTimeout(tick, delay);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active, sessionPlaylistId]);

  // ── Heartbeat ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active || !outboxPlaylistId || !sessionId) return;
    const me = useAuthStore.getState().getActiveServer()?.username;
    if (!me) return;
    const outboxName = orbitOutboxPlaylistName(sessionId, me);

    const beat = async () => {
      try { await writeOrbitHeartbeat(outboxPlaylistId, outboxName); }
      catch { /* best-effort */ }
    };
    void beat();

    const id = window.setInterval(() => { void beat(); }, HEARTBEAT_TICK_MS);
    return () => window.clearInterval(id);
  }, [active, outboxPlaylistId, sessionId]);
}

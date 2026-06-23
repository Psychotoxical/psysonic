import { Play } from 'lucide-react';
import { updatePlaylist } from '../api/subsonicPlaylists';
import { resolvePlaylist, resolveMediaServerId } from '../utils/offline/offlineMediaResolve';
import { songToTrack } from '../utils/playback/songToTrack';
import type { Track } from '../store/playerStoreTypes';
import { useState, useRef, useMemo } from 'react';
import { usePlayerStore } from '../store/playerStore';
import { useOrbitStore } from '../store/orbitStore';
import OrbitGuestQueue from './OrbitGuestQueue';
import OrbitQueueHead from './OrbitQueueHead';
import HostApprovalQueue from './HostApprovalQueue';
import { usePlaylistStore } from '../store/playlistStore';
import { useTranslation } from 'react-i18next';
import { usePlaybackLibraryNavigate } from '../hooks/usePlaybackLibraryNavigate';
import { useAuthStore } from '../store/authStore';
import { encodeSharePayload } from '../utils/share/shareLink';
import { serverShareBaseUrl } from '../utils/server/serverEndpoint';
import { copyTextToClipboard } from '../utils/server/serverMagicString';
import { showToast } from '../utils/ui/toast';
import { useThemeStore } from '../store/themeStore';
import { useLyricsStore } from '../store/lyricsStore';
import LyricsPane from './LyricsPane';
import NowPlayingInfo from './NowPlayingInfo';
import { useLuckyMixStore } from '../store/luckyMixStore';
import { useQueueToolbarStore } from '../store/queueToolbarStore';
import { SavePlaylistModal } from './queuePanel/SavePlaylistModal';
import { LoadPlaylistModal } from './queuePanel/LoadPlaylistModal';
import { QueueHeader } from './queuePanel/QueueHeader';
import { QueueCurrentTrack } from './queuePanel/QueueCurrentTrack';
import { useQueuePanelDrag } from '../hooks/useQueuePanelDrag';
import { useQueueLufsTgtPopover } from '../hooks/useQueueLufsTgtPopover';
import { QueueToolbar } from './queuePanel/QueueToolbar';
import { QueueList } from './queuePanel/QueueList';
import { QueueTabBar } from './queuePanel/QueueTabBar';
import { useQueueAutoScroll } from '../hooks/useQueueAutoScroll';
import { activeServerQueueTrackIds } from '../utils/playback/trackServerScope';

export default function QueuePanel() {
  const orbitRole = useOrbitStore(s => s.role);
  if (orbitRole === 'guest') {
    return (
      <aside className="queue-panel queue-panel--orbit-guest">
        <OrbitGuestQueue />
      </aside>
    );
  }
  return <QueuePanelHostOrSolo />;
}

function QueuePanelHostOrSolo() {
  const { t } = useTranslation();
  const navigatePlaybackLibrary = usePlaybackLibraryNavigate();
  const orbitRole = useOrbitStore(s => s.role);
  const orbitState = useOrbitStore(s => s.state);
  /** trackId → addedBy (host username or guest username) — only populated while
   *  hosting an Orbit session, so the queue rows can surface attribution. */
  const orbitAddedByByTrack = useMemo(() => {
    const map = new Map<string, string>();
    if (orbitRole !== 'host' || !orbitState) return map;
    if (orbitState.currentTrack) {
      map.set(orbitState.currentTrack.trackId, orbitState.currentTrack.addedBy);
    }
    for (const q of orbitState.queue) map.set(q.trackId, q.addedBy);
    return map;
  }, [orbitRole, orbitState]);
  const orbitHostUsername = orbitState?.host ?? '';
  /** Attribution label for a queue row / current track while hosting. Null when
   *  not in a hosted session. Bulk-adds (album / playlist enqueue) bypass
   *  `hostEnqueueToOrbit` and therefore never land in `state.queue`, so we
   *  default those to "Added by you" rather than showing nothing. */
  const orbitAttributionLabel = (trackId: string): string | null => {
    if (orbitRole !== 'host' || !orbitState) return null;
    const addedBy = orbitAddedByByTrack.get(trackId);
    if (!addedBy || addedBy === orbitHostUsername) return t('orbit.queueAddedByYou');
    return t('orbit.queueAddedByUser', { user: addedBy });
  };
  // Thin-state: the queue is the canonical `QueueItemRef[]`; rows resolve their
  // Track from the resolver. List, header, toolbar and id/length reads (save /
  // share / playlist) all read off the refs.
  const queueItems = usePlayerStore(s => s.queueItems);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const userRatingOverrides = usePlayerStore(s => s.userRatingOverrides);
  const isQueueVisible = usePlayerStore(s => s.isQueueVisible);
  const playTrack = usePlayerStore(s => s.playTrack);
  const clearQueue = usePlayerStore(s => s.clearQueue);

  const reorderQueue = usePlayerStore(s => s.reorderQueue);
  const removeTrack = usePlayerStore(s => s.removeTrack);
  const shuffleQueue = usePlayerStore(s => s.shuffleQueue);
  const enqueue = usePlayerStore(s => s.enqueue);
  const enqueueAt = usePlayerStore(s => s.enqueueAt);
  const contextMenu = usePlayerStore(s => s.contextMenu);

  // When the user picks a track *from* the queue list, suppress the
  // upcoming auto-scroll so their click target stays in view instead of
  // the list rebasing onto the next track. Auto-advance (natural playback)
  // never sets this flag, so it keeps its original "show what's next" behavior.
  const suppressNextAutoScrollRef = useRef(false);

  const playbackSource = usePlayerStore(s => s.currentPlaybackSource);
  const normalizationNowDb = usePlayerStore(s => s.normalizationNowDb);
  const normalizationTargetLufs = usePlayerStore(s => s.normalizationTargetLufs);
  const normalizationEngineLive = usePlayerStore(s => s.normalizationEngineLive);

  const crossfadeEnabled = useAuthStore(s => s.crossfadeEnabled);
  const crossfadeSecs = useAuthStore(s => s.crossfadeSecs);
  const crossfadeTrimSilence = useAuthStore(s => s.crossfadeTrimSilence);
  const gaplessEnabled = useAuthStore(s => s.gaplessEnabled);
  const infiniteQueueEnabled = useAuthStore(s => s.infiniteQueueEnabled);
  const setCrossfadeSecs = useAuthStore(s => s.setCrossfadeSecs);
  const setInfiniteQueueEnabled = useAuthStore(s => s.setInfiniteQueueEnabled);
  const normalizationEngine = useAuthStore(s => s.normalizationEngine);

  const activeTab  = useLyricsStore(s => s.activeTab);
  const setTab     = useLyricsStore(s => s.setTab);
  const luckyRolling = useLuckyMixStore(s => s.isRolling);

  const isNowPlayingCollapsed = useAuthStore(s => s.queueNowPlayingCollapsed);
  const setIsNowPlayingCollapsed = useAuthStore(s => s.setQueueNowPlayingCollapsed);
  const queueDisplayMode = useAuthStore(s => s.queueDisplayMode);
  const setQueueDisplayMode = useAuthStore(s => s.setQueueDisplayMode);
  const toolbarButtons = useQueueToolbarStore(s => s.buttons);
  const durationMode = useAuthStore(s => s.queueDurationDisplayMode);
  const setDurationMode = useAuthStore(s => s.setQueueDurationDisplayMode);
  const expandReplayGain = useThemeStore(s => s.expandReplayGain);
  const setExpandReplayGain = useThemeStore(s => s.setExpandReplayGain);
  const reanalyzeLoudnessForTrack = usePlayerStore(s => s.reanalyzeLoudnessForTrack);
  const authLoudnessTargetLufs = useAuthStore(s => s.loudnessTargetLufs);
  const setLoudnessTargetLufs = useAuthStore(s => s.setLoudnessTargetLufs);
  const loudnessPreAnalysisAttenuationDb = useAuthStore(s => s.loudnessPreAnalysisAttenuationDb);

  const {
    lufsTgtOpen,
    setLufsTgtOpen,
    lufsTgtPopStyle,
    lufsTgtBtnRef,
    lufsTgtMenuRef,
  } = useQueueLufsTgtPopover(expandReplayGain);

  const queueListRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);

  const {
    psyDragFromIdxRef,
    externalDropTarget,
    externalDropTargetRef,
    setExternalDropTarget,
    isQueueDrag,
    startDrag,
  } = useQueuePanelDrag({
    asideRef,
    isQueueVisible,
    reorderQueue,
    enqueueAt,
    removeTrack,
  });

  useQueueAutoScroll({
    queue: queueItems,
    queueIndex,
    currentTrack,
    queueListRef,
    suppressNextAutoScrollRef,
  });

  const [activePlaylist, setActivePlaylist] = useState<{ id: string; name: string } | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [loadModalOpen, setLoadModalOpen] = useState(false);

  const handleSave = async () => {
    const exportTrackIds = activeServerQueueTrackIds(queueItems);
    if (exportTrackIds.length === 0) return;
    if (activePlaylist) {
      setSaveState('saving');
      try {
        await updatePlaylist(activePlaylist.id, exportTrackIds);
        setSaveState('saved');
        setTimeout(() => setSaveState('idle'), 1500);
      } catch (e) {
        console.error('Failed to update playlist', e);
        setSaveState('idle');
      }
    } else {
      setSaveModalOpen(true);
    }
  };

  const handleLoad = () => {
    setLoadModalOpen(true);
  };

  const handleClear = () => {
    clearQueue();
    setActivePlaylist(null);
  };

  const handleCopyQueueShare = async () => {
    const ids = activeServerQueueTrackIds(queueItems);
    if (ids.length === 0) {
      showToast(t('queue.shareQueueEmpty'), 3000, 'info');
      return;
    }
    // Queue share goes to remote recipients — use the share URL, not the
    // connect URL the active app is currently bound to (would leak the LAN
    // host on a dual-address profile).
    const active = useAuthStore.getState().getActiveServer();
    if (!active) return;
    const srv = serverShareBaseUrl(active);
    if (!srv) return;
    const ok = await copyTextToClipboard(encodeSharePayload({ srv, k: 'queue', ids }));
    if (ok) showToast(t('contextMenu.shareCopied'));
    else showToast(t('contextMenu.shareCopyFailed'), 4000, 'error');
  };

  // Queue mode shows upcoming tracks only — the current track lives in the
  // header and drops out of the list once played. Playlist mode keeps the full
  // timeline. `queueItems` stays the canonical list either way; the slice is a
  // view. `displayBaseIndex` maps a displayed row back to its absolute queue
  // index for every index-based handler (play / remove / reorder / drag).
  const displayBaseIndex = queueDisplayMode === 'queue' ? Math.max(0, queueIndex + 1) : 0;
  const displayItems = displayBaseIndex > 0 ? queueItems.slice(displayBaseIndex) : queueItems;
  // In queue mode the list can be empty while the queue still holds the
  // now-playing (last) track — say "no upcoming" rather than "queue is empty".
  const queueEmptyLabel = queueDisplayMode === 'queue' && queueItems.length > 0
    ? t('queue.noUpcoming')
    : t('queue.emptyQueue');

  return (
    <aside
      ref={asideRef}
      className={`queue-panel${isQueueDrag ? ' queue-drop-active' : ''}`}
      onMouseMove={e => {
        if (!isQueueDrag || !queueListRef.current) return;
        const items = queueListRef.current.querySelectorAll<HTMLElement>('[data-queue-idx]');
        let found = false;
        for (let i = 0; i < items.length; i++) {
          const rect = items[i].getBoundingClientRect();
          if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
            const before = e.clientY < rect.top + rect.height / 2;
            const idx = parseInt(items[i].dataset.queueIdx!);
            const target = { idx, before };
            externalDropTargetRef.current = target;
            setExternalDropTarget(target);
            found = true;
            break;
          }
        }
        if (!found) {
          externalDropTargetRef.current = null;
          setExternalDropTarget(null);
        }
      }}
      style={{
        borderLeftWidth: isQueueVisible ? 1 : 0,
      }}
    >
      {orbitRole === 'host' && orbitState && (
        <>
          <OrbitQueueHead state={orbitState} />
          <HostApprovalQueue />
        </>
      )}
      <QueueHeader
        queue={queueItems}
        queueIndex={queueIndex}
        activePlaylist={activePlaylist}
        isNowPlayingCollapsed={isNowPlayingCollapsed}
        setIsNowPlayingCollapsed={setIsNowPlayingCollapsed}
        durationMode={durationMode}
        setDurationMode={setDurationMode}
        queueDisplayMode={queueDisplayMode}
        setQueueDisplayMode={setQueueDisplayMode}
        t={t}
      />

      {currentTrack && !isNowPlayingCollapsed && (
        <QueueCurrentTrack
          currentTrack={currentTrack}
          userRatingOverrides={userRatingOverrides}
          orbitAttributionLabel={orbitAttributionLabel}
          navigate={navigatePlaybackLibrary}
          playbackSource={playbackSource}
          normalizationEngine={normalizationEngine}
          normalizationEngineLive={normalizationEngineLive}
          normalizationNowDb={normalizationNowDb}
          normalizationTargetLufs={normalizationTargetLufs}
          authLoudnessTargetLufs={authLoudnessTargetLufs}
          loudnessPreAnalysisAttenuationDb={loudnessPreAnalysisAttenuationDb}
          expandReplayGain={expandReplayGain}
          setExpandReplayGain={setExpandReplayGain}
          reanalyzeLoudnessForTrack={reanalyzeLoudnessForTrack}
          setLoudnessTargetLufs={setLoudnessTargetLufs}
          lufsTgtOpen={lufsTgtOpen}
          setLufsTgtOpen={setLufsTgtOpen}
          lufsTgtBtnRef={lufsTgtBtnRef}
          lufsTgtMenuRef={lufsTgtMenuRef}
          lufsTgtPopStyle={lufsTgtPopStyle}
          t={t}
        />
      )}

      {/* Queue mode hides the current track from the list, so a collapsed
          now-playing card would leave nothing showing what's playing. This
          slim strip fills that gap; clicking it re-expands the full card. */}
      {currentTrack && isNowPlayingCollapsed && queueDisplayMode === 'queue' && (
        <button
          type="button"
          className="queue-now-playing-mini"
          onClick={() => setIsNowPlayingCollapsed(false)}
          data-tooltip={t('queue.showNowPlaying')}
          aria-label={t('queue.showNowPlaying')}
        >
          <Play size={11} fill="currentColor" style={{ flexShrink: 0 }} />
          <span className="truncate" style={{ minWidth: 0 }}>
            <span style={{ fontWeight: 600 }}>{currentTrack.title}</span>
            <span style={{ color: 'var(--text-muted)' }}> · {currentTrack.artist}</span>
          </span>
        </button>
      )}

      {activeTab === 'queue' ? (<>
        {!isNowPlayingCollapsed && toolbarButtons.some(b => b.visible && b.id !== 'separator') && (
          <QueueToolbar
            queue={queueItems}
            activePlaylist={activePlaylist}
            saveState={saveState}
            toolbarButtons={toolbarButtons}
            shuffleQueue={shuffleQueue}
            handleSave={handleSave}
            handleLoad={handleLoad}
            handleCopyQueueShare={handleCopyQueueShare}
            handleClear={handleClear}
            gaplessEnabled={gaplessEnabled}
            crossfadeEnabled={crossfadeEnabled}
            crossfadeTrimSilence={crossfadeTrimSilence}
            crossfadeSecs={crossfadeSecs}
            setCrossfadeSecs={setCrossfadeSecs}
            infiniteQueueEnabled={infiniteQueueEnabled}
            setInfiniteQueueEnabled={setInfiniteQueueEnabled}
            t={t}
          />
        )}

      {/* "Next Tracks" only labels the upcoming-only list in queue mode. In
          playlist mode the list also holds the current + played rows, so the
          divider would be misleading — hide it. */}
      {queueDisplayMode === 'queue' && displayItems.length > 0 && <div className="queue-divider"><span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>{t('queue.nextTracks')}</span></div>}

      <QueueList
        queue={displayItems}
        queueIndex={queueIndex}
        displayBaseIndex={displayBaseIndex}
        queueDisplayMode={queueDisplayMode}
        emptyLabel={queueEmptyLabel}
        contextMenu={contextMenu}
        playTrack={playTrack}
        activeTab={activeTab}
        queueListRef={queueListRef}
        suppressNextAutoScrollRef={suppressNextAutoScrollRef}
        isQueueDrag={isQueueDrag}
        psyDragFromIdxRef={psyDragFromIdxRef}
        externalDropTarget={externalDropTarget}
        startDrag={startDrag}
        orbitAttributionLabel={orbitAttributionLabel}
        luckyRolling={luckyRolling}
        t={t}
      />
      </>) : activeTab === 'lyrics' ? (
        <LyricsPane currentTrack={currentTrack} />
      ) : (
        <NowPlayingInfo />
      )}

      <QueueTabBar activeTab={activeTab} setTab={setTab} t={t} />

      {saveModalOpen && (
        <SavePlaylistModal
          onClose={() => setSaveModalOpen(false)}
          onSave={async (name) => {
            try {
              const createPlaylist = usePlaylistStore.getState().createPlaylist;
              const pl = await createPlaylist(name, activeServerQueueTrackIds(queueItems));
              if (pl) setActivePlaylist({ id: pl.id, name: pl.name });
              setSaveModalOpen(false);
            } catch (e) {
              console.error('Failed to save playlist', e);
            }
          }}
        />
      )}

      {loadModalOpen && (
        <LoadPlaylistModal
          onClose={() => setLoadModalOpen(false)}
          onLoad={async (id, name, mode) => {
            try {
              const serverId = resolveMediaServerId();
              if (!serverId) return;
              const data = await resolvePlaylist(serverId, id);
              if (!data) return;
              const tracks: Track[] = data.songs.map(songToTrack);
              if (tracks.length > 0) {
                if (mode === 'append') {
                  enqueue(tracks);
                } else {
                  clearQueue();
                  playTrack(tracks[0], tracks);
                }
              }
              setActivePlaylist({ id, name });
              setLoadModalOpen(false);
            } catch (e) {
              console.error('Failed to load playlist', e);
            }
          }}
        />
      )}
    </aside>
  );
}

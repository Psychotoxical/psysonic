import { create } from 'zustand';
import i18n from '@/lib/i18n';
import {
  libraryGetTrack,
  libraryResolveEntitySources,
  type LibraryEntitySourceDto,
} from '@/lib/api/library';
import { trackToSong } from '@/lib/library/trackDtoMapping';
import { buildConfiguredLibraryScopePairs } from '@/lib/library/libraryBrowseScope';
import { songToTrack } from '@/lib/media/songToTrack';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { canonicalQueueServerKey, serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { showToast } from '@/lib/dom/toast';
import { hasLocalPlaybackUrl } from '@/store/localPlaybackResolve';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { seedQueueResolver } from '@/features/playback/store/queueTrackResolver';

export interface PlaybackAlternative {
  source: LibraryEntitySourceDto;
  serverName: string;
  local: boolean;
}

interface FailedQueueSlot {
  index: number;
  ref: QueueItemRef;
  track: Track;
  resumeNormalSkip: () => void;
}

interface PlaybackAlternativeState {
  isOpen: boolean;
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
  detail: string;
  failed: FailedQueueSlot | null;
  alternatives: PlaybackAlternative[];
  close: () => void;
  choose: (alternative: PlaybackAlternative) => Promise<void>;
}

let resolutionGeneration = 0;

function sameRef(a: QueueItemRef | undefined, b: QueueItemRef): boolean {
  return !!a
    && canonicalQueueServerKey(a.serverId) === canonicalQueueServerKey(b.serverId)
    && a.trackId === b.trackId;
}

function failedCurrentQueueSlot(): FailedQueueSlot | null {
  const player = usePlayerStore.getState();
  const ref = player.queueItems[player.queueIndex];
  if (!player.currentTrack || !ref || ref.trackId !== player.currentTrack.id) return null;
  return {
    index: player.queueIndex,
    ref: { ...ref },
    track: player.currentTrack,
    resumeNormalSkip: () => {},
  };
}

export function playbackFailureCanOfferAlternatives(): boolean {
  const failed = failedCurrentQueueSlot();
  if (!failed || failed.track.directStreamUrl) return false;
  const auth = useAuthStore.getState();
  if (auth.musicLibraryServerIds.length < 2) return false;
  const profileId = resolveServerIdForIndexKey(failed.ref.serverId) || failed.ref.serverId;
  return auth.musicLibraryServerIds.includes(profileId);
}

async function resolveAlternatives(failed: FailedQueueSlot): Promise<PlaybackAlternative[]> {
  const auth = useAuthStore.getState();
  const scopes = buildConfiguredLibraryScopePairs(auth);
  const anchorServerId = resolveServerIdForIndexKey(failed.ref.serverId) || failed.ref.serverId;
  const sources = await libraryResolveEntitySources(anchorServerId, {
    entityType: 'track',
    anchorServerId,
    anchorId: failed.ref.trackId,
    scopes,
  });
  const connections = useLibraryIndexStore.getState().connectionByServer;
  return sources.flatMap<PlaybackAlternative>(source => {
    const sourceProfile = auth.servers.find(server => server.id === source.serverId);
    const sourceKey = sourceProfile ? serverIndexKeyForProfile(sourceProfile) : source.serverId;
    const isCurrent = source.id === failed.ref.trackId
      && canonicalQueueServerKey(source.serverId) === canonicalQueueServerKey(failed.ref.serverId);
    if (isCurrent) return [];
    const local = hasLocalPlaybackUrl(source.id, source.serverId);
    if (!local && connections[sourceKey] !== 'online') return [];
    const serverName = sourceProfile?.name ?? source.serverId;
    return [{ source, serverName, local }];
  });
}

export function beginPlaybackAlternativeResolution(
  detail: string,
  resumeNormalSkip: () => void = () => {},
): boolean {
  if (!playbackFailureCanOfferAlternatives()) return false;
  const failed = failedCurrentQueueSlot();
  if (!failed) return false;

  let fallbackPending = true;
  const resumeOnce = () => {
    if (!fallbackPending) return;
    fallbackPending = false;
    resumeNormalSkip();
  };
  failed.resumeNormalSkip = resumeOnce;
  const generation = ++resolutionGeneration;
  usePlaybackAlternativeStore.setState({
    isOpen: true,
    status: 'loading',
    detail,
    failed,
    alternatives: [],
  });
  void resolveAlternatives(failed).then(alternatives => {
    if (generation !== resolutionGeneration) return;
    usePlaybackAlternativeStore.setState({
      status: alternatives.length > 0 ? 'ready' : 'empty',
      alternatives,
    });
    if (alternatives.length === 0) resumeOnce();
  }).catch(error => {
    console.error('[psysonic] Failed to resolve playback alternatives:', error);
    if (generation !== resolutionGeneration) return;
    usePlaybackAlternativeStore.setState({ status: 'error', alternatives: [] });
    resumeOnce();
  });
  return true;
}

async function choosePlaybackAlternative(alternative: PlaybackAlternative): Promise<void> {
  const state = usePlaybackAlternativeStore.getState();
  const failed = state.failed;
  if (!failed) return;
  const player = usePlayerStore.getState();
  if (player.queueIndex !== failed.index || !sameRef(player.queueItems[failed.index], failed.ref)) {
    state.close();
    showToast(i18n.t('player.playbackAlternativeStale'), 4500, 'error');
    return;
  }

  const dto = await libraryGetTrack(alternative.source.serverId, alternative.source.id);
  if (!dto) {
    showToast(i18n.t('player.playbackAlternativeUnavailable'), 4500, 'error');
    return;
  }
  const selectedTrack: Track = {
    ...songToTrack(trackToSong(dto)),
    serverId: alternative.source.serverId,
    autoAdded: failed.ref.autoAdded,
    radioAdded: failed.ref.radioAdded,
    playNextAdded: failed.ref.playNextAdded,
  };
  const selectedRef: QueueItemRef = {
    serverId: canonicalQueueServerKey(alternative.source.serverId),
    trackId: alternative.source.id,
    autoAdded: failed.ref.autoAdded,
    radioAdded: failed.ref.radioAdded,
    playNextAdded: failed.ref.playNextAdded,
  };
  const queueItems = [...player.queueItems];
  queueItems[failed.index] = selectedRef;
  seedQueueResolver(alternative.source.serverId, [selectedTrack]);
  usePlayerStore.setState({ queueItems });
  failed.resumeNormalSkip = () => {};
  state.close();
  usePlayerStore.getState().playTrack(selectedTrack, undefined, false, false, failed.index);
}

export const usePlaybackAlternativeStore = create<PlaybackAlternativeState>((set) => ({
  isOpen: false,
  status: 'idle',
  detail: '',
  failed: null,
  alternatives: [],
  close: () => {
    const failed = usePlaybackAlternativeStore.getState().failed;
    resolutionGeneration++;
    set({ isOpen: false, status: 'idle', detail: '', failed: null, alternatives: [] });
    failed?.resumeNormalSkip();
  },
  choose: choosePlaybackAlternative,
}));

export function _resetPlaybackAlternativeStoreForTest(): void {
  resolutionGeneration++;
  usePlaybackAlternativeStore.setState({
    isOpen: false,
    status: 'idle',
    detail: '',
    failed: null,
    alternatives: [],
  });
}

import type { AuthState } from './authStoreTypes';
import {
  emitMultiServerDebug,
  summarizeMultiServerProfiles,
  summarizeMusicFoldersByServer,
} from '@/lib/library/multiServerDebug';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;
type GetState = () => AuthState;

/**
 * Persistent plumbing settings that don't fit a more specific domain:
 * runtime logging level, Navidrome `getNowPlaying` toggle, audiobook
 * exclusion, genre blacklist.
 */
export function createPlumbingSettingsActions(set: SetState, get: GetState): Pick<
  AuthState,
  | 'setLoggingMode'
  | 'setDebugLoggingDepth'
  | 'setNowPlayingEnabled'
  | 'setExcludeAudiobooks'
  | 'setCustomGenreBlacklist'
> {
  return {
    setLoggingMode: (v) => {
      set({ loggingMode: v });
      const state = get();
      emitMultiServerDebug('debug_logging_mode_changed', {
        loggingMode: v,
        activeServerId: state.activeServerId,
        isLoggedIn: state.isLoggedIn,
        configuredServerIds: state.libraryBrowseServerIds,
        servers: summarizeMultiServerProfiles(state.servers),
        foldersByServer: summarizeMusicFoldersByServer(state.musicFoldersByServer),
        selectionByServer: state.libraryBrowseSelectionByServer,
        libraryBrowseScopeVersion: state.libraryBrowseScopeVersion,
      });
    },
    setDebugLoggingDepth: (v) => {
      set({ debugLoggingDepth: v });
      const state = get();
      emitMultiServerDebug('debug_logging_depth_changed', {
        debugLoggingDepth: v,
        activeServerId: state.activeServerId,
        isLoggedIn: state.isLoggedIn,
        configuredServerIds: state.libraryBrowseServerIds,
        servers: summarizeMultiServerProfiles(state.servers),
        foldersByServer: summarizeMusicFoldersByServer(state.musicFoldersByServer),
        selectionByServer: state.libraryBrowseSelectionByServer,
        libraryBrowseScopeVersion: state.libraryBrowseScopeVersion,
      });
    },
    setNowPlayingEnabled: (v) => set({ nowPlayingEnabled: v }),
    setExcludeAudiobooks: (v) => set({ excludeAudiobooks: v }),
    setCustomGenreBlacklist: (v) => set({ customGenreBlacklist: v }),
  };
}

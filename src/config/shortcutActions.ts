import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import i18n from '../i18n';
import { getSong, setRating, star, unstar } from '../api/subsonic';
import { songToTrack, usePlayerStore } from '../store/playerStore';
import { usePreviewStore } from '../store/previewStore';
import { useLyricsStore } from '../store/lyricsStore';
import { showToast } from '../utils/toast';
import { playByOpaqueId } from '../utils/playByOpaqueId';

export type TranslateLike = (key: string, options?: any) => string;

type ShortcutSlot = { defaultBinding: string | null; hidden?: boolean };

type ActionContext = {
  navigate: (to: string, options?: any) => void;
  previewPolicy: 'stop' | 'ignore';
};

type CliContext = {
  navigate: (to: string, options?: any) => void;
  payload: any;
};

let cliPremuteVolume: number | null = null;

type ShortcutActionMeta = {
  getLabel: (t: TranslateLike) => string;
  inApp?: ShortcutSlot;
  global?: ShortcutSlot;
  runInMiniWindow: boolean;
  run: (ctx: ActionContext) => void;
  cli?: { verb: string; description: string; command?: string };
};

const withPreviewPolicy = (
  action: 'play' | 'pause' | 'stop' | 'play-pause' | 'next' | 'prev',
  options: ActionContext,
  fn: () => void
) => {
  const previewing = usePreviewStore.getState().previewingId !== null;
  if (previewing && options.previewPolicy === 'ignore') return;
  if (previewing && options.previewPolicy === 'stop') {
    usePreviewStore.getState().stopPreview();
  }
  fn();
};

function focusLiveSearchInput(): boolean {
  const input = document.getElementById('live-search-input') as HTMLInputElement | null;
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}


export const SHORTCUT_ACTION_REGISTRY = {
  'play': {
    getLabel: t => t('settings.shortcutPlayPause'),
    runInMiniWindow: false,
    run: ({ previewPolicy }) => withPreviewPolicy('play', { navigate: () => {}, previewPolicy }, () => {
      const state = usePlayerStore.getState();
      if (!state.isPlaying) state.resume();
    }),
    cli: { verb: 'play', description: 'play' },
  },
  'pause': {
    getLabel: t => t('settings.shortcutPlayPause'),
    runInMiniWindow: false,
    run: ({ previewPolicy }) => withPreviewPolicy('pause', { navigate: () => {}, previewPolicy }, () => {
      const state = usePlayerStore.getState();
      if (state.isPlaying) state.pause();
    }),
    cli: { verb: 'pause', description: 'pause' },
  },
  'stop': {
    getLabel: t => t('settings.shortcutPlayPause'),
    runInMiniWindow: false,
    run: ({ previewPolicy }) => withPreviewPolicy('stop', { navigate: () => {}, previewPolicy }, () => {
      usePlayerStore.getState().stop();
    }),
    cli: { verb: 'stop', description: 'stop' },
  },
  'play-pause': {
    getLabel: t => t('settings.shortcutPlayPause'),
    inApp: { defaultBinding: 'Space' },
    global: { defaultBinding: null },
    runInMiniWindow: true,
    run: ({ previewPolicy }) => withPreviewPolicy('play-pause', { navigate: () => {}, previewPolicy }, () => {
      usePlayerStore.getState().togglePlay();
    }),
  },
  next: {
    getLabel: t => t('settings.shortcutNext'),
    inApp: { defaultBinding: null },
    global: { defaultBinding: null },
    runInMiniWindow: true,
    run: ({ previewPolicy }) => withPreviewPolicy('next', { navigate: () => {}, previewPolicy }, () => {
      usePlayerStore.getState().next();
    }),
    cli: { verb: 'next', description: 'next track' },
  },
  prev: {
    getLabel: t => t('settings.shortcutPrev'),
    inApp: { defaultBinding: null },
    global: { defaultBinding: null },
    runInMiniWindow: true,
    run: ({ previewPolicy }) => withPreviewPolicy('prev', { navigate: () => {}, previewPolicy }, () => {
      usePlayerStore.getState().previous();
    }),
    cli: { verb: 'prev', description: 'previous track' },
  },
  'volume-up': {
    getLabel: t => t('settings.shortcutVolumeUp'),
    inApp: { defaultBinding: null },
    global: { defaultBinding: null },
    runInMiniWindow: false,
    run: () => {
      const state = usePlayerStore.getState();
      state.setVolume(Math.min(1, state.volume + 0.05));
    },
  },
  'volume-down': {
    getLabel: t => t('settings.shortcutVolumeDown'),
    inApp: { defaultBinding: null },
    global: { defaultBinding: null },
    runInMiniWindow: false,
    run: () => {
      const state = usePlayerStore.getState();
      state.setVolume(Math.max(0, state.volume - 0.05));
    },
  },
  'seek-forward': {
    getLabel: t => t('settings.shortcutSeekForward'),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
    run: () => {
      const state = usePlayerStore.getState();
      const duration = state.currentTrack?.duration ?? 0;
      if (!duration) return;
      state.seek(Math.min(1, (state.currentTime + 10) / duration));
    },
  },
  'seek-backward': {
    getLabel: t => t('settings.shortcutSeekBackward'),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
    run: () => {
      const state = usePlayerStore.getState();
      const duration = state.currentTrack?.duration ?? 0;
      if (!duration) return;
      state.seek(Math.max(0, (state.currentTime - 10) / duration));
    },
  },
  'toggle-queue': {
    getLabel: t => t('settings.shortcutToggleQueue'),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
    run: () => {
      usePlayerStore.getState().toggleQueue();
    },
  },
  'open-folder-browser': {
    getLabel: t => t('settings.shortcutOpenFolderBrowser', { folderBrowser: t('sidebar.folderBrowser') }),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
    run: ({ navigate }) => {
      navigate('/folders', { state: { folderBrowserRevealTs: Date.now() } });
    },
  },
  'fullscreen-player': {
    getLabel: t => t('settings.shortcutFullscreenPlayer'),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
    run: () => {
      usePlayerStore.getState().toggleFullscreen();
    },
  },
  'native-fullscreen': {
    getLabel: t => t('settings.shortcutNativeFullscreen'),
    inApp: { defaultBinding: 'F11' },
    runInMiniWindow: false,
    run: () => {
      const win = getCurrentWindow();
      win.isFullscreen().then(fs => win.setFullscreen(!fs));
    },
  },
  'open-mini-player': {
    getLabel: t => t('settings.shortcutOpenMiniPlayer'),
    inApp: { defaultBinding: null },
    runInMiniWindow: true,
    run: () => {
      invoke('open_mini_player').catch(() => {});
    },
  },
  'start-search': {
    getLabel: t => t('settings.shortcutStartSearch', { defaultValue: 'Start a search' }),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
    run: ({ navigate }) => {
      if (focusLiveSearchInput()) return;
      navigate('/');
      requestAnimationFrame(() => {
        window.setTimeout(() => { focusLiveSearchInput(); }, 80);
      });
    },
  },
  'start-advanced-search': {
    getLabel: t => t('settings.shortcutStartAdvancedSearch', { defaultValue: 'Start an advanced search' }),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
    run: ({ navigate }) => {
      navigate('/search/advanced');
    },
  },
  'toggle-sidebar': {
    getLabel: t => t('settings.shortcutToggleSidebar', { defaultValue: 'Toggle sidebar' }),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
    run: () => {
      window.dispatchEvent(new Event('psy:toggle-sidebar'));
    },
  },
  'mute-sound': {
    getLabel: t => t('settings.shortcutMuteSound', { defaultValue: 'Mute sound' }),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
    run: () => {
      const state = usePlayerStore.getState();
      if (state.volume <= 0) {
        const restore = cliPremuteVolume ?? 0.8;
        cliPremuteVolume = null;
        state.setVolume(restore);
        return;
      }
      cliPremuteVolume = state.volume;
      state.setVolume(0);
    },
  },
  'toggle-equalizer': {
    getLabel: t => t('settings.shortcutToggleEqualizer', { defaultValue: 'Open / Toggle Equalizer' }),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
    run: () => {
      window.dispatchEvent(new Event('psy:toggle-equalizer'));
    },
  },
  'toggle-repeat': {
    getLabel: t => t('settings.shortcutToggleRepeat', { defaultValue: 'Toggle repeat' }),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
    run: () => {
      usePlayerStore.getState().toggleRepeat();
    },
  },
  'open-now-playing': {
    getLabel: t => t('settings.shortcutOpenNowPlaying', { defaultValue: 'Open "Now Playing"' }),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
    run: ({ navigate }) => {
      navigate('/now-playing');
    },
  },
  'show-lyrics': {
    getLabel: t => t('settings.shortcutShowLyrics', { defaultValue: 'Show lyrics' }),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
    run: () => {
      const player = usePlayerStore.getState();
      player.setQueueVisible(true);
      useLyricsStore.getState().showLyrics();
    },
  },
  'favorite-current-track': {
    getLabel: t => t('settings.shortcutFavoriteCurrentTrack', { defaultValue: 'Add current track to favorites' }),
    inApp: { defaultBinding: null },
    runInMiniWindow: false,
    run: () => {
      const track = usePlayerStore.getState().currentTrack;
      if (!track) {
        showToast(i18n.t('contextMenu.cliMixNeedsTrack', { defaultValue: 'Load a track first.' }), 5000, 'error');
        return;
      }
      star(track.id, 'song')
        .then(() => usePlayerStore.getState().setStarredOverride(track.id, true))
        .catch(err => {
          console.error('Favorite current track failed', err);
          showToast(i18n.t('contextMenu.cliStarFailed', { defaultValue: 'Could not add the track to favorites.' }), 5000, 'error');
        });
    },
  },
  'open-help': {
    getLabel: t => t('settings.shortcutOpenHelp', { defaultValue: 'Help' }),
    inApp: { defaultBinding: 'F1', hidden: true },
    runInMiniWindow: false,
    run: ({ navigate }) => {
      navigate('/help');
    },
  },
  'shuffle': {
    getLabel: t => t('settings.shortcutNext'),
    runInMiniWindow: false,
    run: () => {
      usePlayerStore.getState().shuffleQueue();
    },
    cli: { verb: 'shuffle', description: 'shuffle' },
  },
  'mute': {
    getLabel: t => t('settings.shortcutVolumeDown'),
    runInMiniWindow: false,
    run: () => {
      const state = usePlayerStore.getState();
      if (state.volume > 0) cliPremuteVolume = state.volume;
      state.setVolume(0);
    },
    cli: { verb: 'mute', description: 'mute' },
  },
  'unmute': {
    getLabel: t => t('settings.shortcutVolumeUp'),
    runInMiniWindow: false,
    run: () => {
      const restore = cliPremuteVolume ?? 0.8;
      cliPremuteVolume = null;
      usePlayerStore.getState().setVolume(restore);
    },
    cli: { verb: 'unmute', description: 'unmute' },
  },
  'star': {
    getLabel: t => t('settings.shortcutPlayPause'),
    runInMiniWindow: false,
    run: () => {
      const track = usePlayerStore.getState().currentTrack;
      if (!track) {
        showToast(i18n.t('contextMenu.cliMixNeedsTrack'), 5000, 'error');
        return;
      }
      star(track.id, 'song')
        .then(() => usePlayerStore.getState().setStarredOverride(track.id, true))
        .catch(err => {
          console.error('CLI star failed', err);
          showToast(i18n.t('contextMenu.cliStarFailed', { defaultValue: 'Star/unstar failed.' }), 5000, 'error');
        });
    },
    cli: { verb: 'star', description: 'star' },
  },
  'unstar': {
    getLabel: t => t('settings.shortcutPlayPause'),
    runInMiniWindow: false,
    run: () => {
      const track = usePlayerStore.getState().currentTrack;
      if (!track) {
        showToast(i18n.t('contextMenu.cliMixNeedsTrack'), 5000, 'error');
        return;
      }
      unstar(track.id, 'song')
        .then(() => usePlayerStore.getState().setStarredOverride(track.id, false))
        .catch(err => {
          console.error('CLI star failed', err);
          showToast(i18n.t('contextMenu.cliStarFailed', { defaultValue: 'Star/unstar failed.' }), 5000, 'error');
        });
    },
    cli: { verb: 'unstar', description: 'unstar' },
  },
  'reload': {
    getLabel: t => t('settings.shortcutPlayPause'),
    runInMiniWindow: false,
    run: () => {
      const store = usePlayerStore.getState();
      const { currentTrack, queue, stop, resetAudioPause, playTrack, initializeFromServerQueue } = store;
      stop();
      resetAudioPause();
      invoke('audio_stop')
        .catch(() => {})
        .then(async () => {
          if (currentTrack) {
            try {
              const fresh = await getSong(currentTrack.id);
              const t = fresh ? songToTrack(fresh) : currentTrack;
              playTrack(t, queue, true);
            } catch {
              playTrack(currentTrack, queue, true);
            }
          } else {
            await initializeFromServerQueue();
          }
        });
    },
    cli: { verb: 'reload', description: 'reload' },
  },
} as const satisfies Record<string, ShortcutActionMeta>;

export type ShortcutAction = keyof typeof SHORTCUT_ACTION_REGISTRY;
export type KeyAction = {
  [Action in ShortcutAction]: (typeof SHORTCUT_ACTION_REGISTRY)[Action] extends { inApp: ShortcutSlot } ? Action : never
}[ShortcutAction];
export type GlobalAction = {
  [Action in ShortcutAction]: (typeof SHORTCUT_ACTION_REGISTRY)[Action] extends { global: ShortcutSlot } ? Action : never
}[ShortcutAction];

export function isShortcutAction(action: string): action is ShortcutAction {
  return action in SHORTCUT_ACTION_REGISTRY;
}

export function isGlobalShortcutActionId(action: string): action is GlobalAction {
  return isShortcutAction(action) && 'global' in SHORTCUT_ACTION_REGISTRY[action];
}

export function canRunShortcutActionInMiniWindow(action: ShortcutAction): boolean {
  return SHORTCUT_ACTION_REGISTRY[action].runInMiniWindow;
}

export type RuntimeAction = ShortcutAction;

export function executeRuntimeAction(action: RuntimeAction, ctx: ActionContext): void {
  SHORTCUT_ACTION_REGISTRY[action].run(ctx);
}

const CLI_NO_ARG_ACTIONS = Object.entries(SHORTCUT_ACTION_REGISTRY)
  .flatMap(([id, def]) => {
    if (!('cli' in def)) return [];
    const cli = def.cli as { command?: string };
    return [{ command: cli.command ?? id, action: id as ShortcutAction }];
  });

export function executeCliPlayerCommand(ctx: CliContext): void | Promise<void> {
  const command = typeof ctx.payload?.command === 'string' ? ctx.payload.command : '';
  if (!command) return;

  const mapped = CLI_NO_ARG_ACTIONS.find(it => it.command === command);
  if (mapped) {
    executeRuntimeAction(mapped.action, { navigate: ctx.navigate, previewPolicy: 'ignore' });
    return;
  }
  if (command === 'play-id') {
    const id = typeof ctx.payload.id === 'string' ? ctx.payload.id.trim() : '';
    if (!id) return;
    return playByOpaqueId(id).catch(err => {
      console.error('CLI play failed', err);
      const notFound = err instanceof Error && err.message === 'play_by_id_not_found';
      showToast(
        i18n.t('contextMenu.cliPlayIdNotFound', {
          defaultValue: notFound
            ? 'No song, album, or artist matches this id.'
            : 'Could not start playback.',
        }),
        5000,
        'error',
      );
    });
  }
  if (command === 'seek-relative') {
    const delta = Number(ctx.payload.deltaSecs);
    if (!Number.isFinite(delta)) return;
    const state = usePlayerStore.getState();
    const duration = state.currentTrack?.duration;
    if (!duration) return;
    state.seek(Math.max(0, state.currentTime + delta) / duration);
    return;
  }
  if (command === 'set-volume') {
    const p = Number(ctx.payload.percent);
    if (!Number.isFinite(p)) return;
    usePlayerStore.getState().setVolume(Math.min(1, Math.max(0, p / 100)));
    return;
  }
  if (command === 'set-repeat') {
    const modeRaw = typeof ctx.payload.mode === 'string' ? ctx.payload.mode : '';
    const mode = modeRaw === 'all' ? 'all' : modeRaw === 'one' ? 'one' : 'off';
    usePlayerStore.setState({ repeatMode: mode });
    return;
  }
  if (command === 'set-rating-current') {
    const stars = Number(ctx.payload.stars);
    if (!Number.isFinite(stars) || stars < 0 || stars > 5) return;
    const track = usePlayerStore.getState().currentTrack;
    if (!track) {
      showToast(i18n.t('contextMenu.cliMixNeedsTrack'), 5000, 'error');
      return;
    }
    return setRating(track.id, stars)
      .then(() => {
        usePlayerStore.getState().setUserRatingOverride(track.id, stars);
      })
      .catch(err => console.error('CLI set rating failed', err));
  }
  // no-op for unknown command
}

const ALL_IN_APP_SHORTCUT_ACTIONS = (Object.keys(SHORTCUT_ACTION_REGISTRY) as ShortcutAction[])
  .filter((action): action is KeyAction => 'inApp' in SHORTCUT_ACTION_REGISTRY[action])
  .map(action => {
    const inApp = SHORTCUT_ACTION_REGISTRY[action].inApp as ShortcutSlot;
    return {
      id: action,
      getLabel: SHORTCUT_ACTION_REGISTRY[action].getLabel,
      defaultBinding: inApp.defaultBinding,
      hidden: inApp.hidden === true,
    };
  });

export const IN_APP_SHORTCUT_ACTIONS = ALL_IN_APP_SHORTCUT_ACTIONS.filter(action => !action.hidden);

export const GLOBAL_SHORTCUT_ACTIONS = (Object.keys(SHORTCUT_ACTION_REGISTRY) as ShortcutAction[])
  .filter((action): action is GlobalAction => 'global' in SHORTCUT_ACTION_REGISTRY[action])
  .map(action => ({
    id: action,
    getLabel: SHORTCUT_ACTION_REGISTRY[action].getLabel,
    defaultBinding: SHORTCUT_ACTION_REGISTRY[action].global.defaultBinding,
  }));

export const DEFAULT_IN_APP_BINDINGS = Object.fromEntries(
  ALL_IN_APP_SHORTCUT_ACTIONS.map(action => [action.id, action.defaultBinding])
) as Record<KeyAction, string | null>;

export const DEFAULT_GLOBAL_SHORTCUTS: Partial<Record<GlobalAction, string>> = {};
for (const action of GLOBAL_SHORTCUT_ACTIONS) {
  if (action.defaultBinding !== null) {
    DEFAULT_GLOBAL_SHORTCUTS[action.id] = action.defaultBinding;
  }
}

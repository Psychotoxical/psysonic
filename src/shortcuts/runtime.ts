import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { matchInAppBinding, type Bindings } from '../store/keybindingsStore';
import { usePlayerStore } from '../store/playerStore';
import { usePreviewStore } from '../store/previewStore';
import type { KeyAction, ShortcutAction } from '../config/shortcutActions';

type NavigateLike = (to: string, options?: any) => void;
export type RuntimeAction = ShortcutAction | 'play' | 'pause' | 'stop';

export function matchInAppShortcutAction(
  event: KeyboardEvent,
  bindings: Bindings
): KeyAction | null {
  return (Object.entries(bindings) as [KeyAction, string | null][])
    .find(([, binding]) => matchInAppBinding(event, binding))?.[0] ?? null;
}

export function runShortcutAction(
  action: RuntimeAction,
  options: {
    navigate: NavigateLike;
    previewPolicy: 'stop' | 'ignore';
  }
): void {
  const {
    togglePlay,
    resume,
    pause,
    stop,
    next,
    previous,
    setVolume,
    seek,
    toggleQueue,
    toggleFullscreen,
  } = usePlayerStore.getState();
  const previewing = usePreviewStore.getState().previewingId !== null;

  const shouldSkipBecausePreview =
    previewing &&
    options.previewPolicy === 'ignore' &&
    (action === 'play' ||
      action === 'pause' ||
      action === 'stop' ||
      action === 'play-pause' ||
      action === 'next' ||
      action === 'prev');
  if (shouldSkipBecausePreview) return;

  if (
    previewing &&
    options.previewPolicy === 'stop' &&
    (action === 'play' ||
      action === 'pause' ||
      action === 'stop' ||
      action === 'play-pause' ||
      action === 'next' ||
      action === 'prev')
  ) {
    usePreviewStore.getState().stopPreview();
  }

  switch (action) {
    case 'play':
      if (!usePlayerStore.getState().isPlaying) resume();
      break;
    case 'pause':
      if (usePlayerStore.getState().isPlaying) pause();
      break;
    case 'stop':
      stop();
      break;
    case 'play-pause':
      if (!previewing || options.previewPolicy !== 'stop') togglePlay();
      break;
    case 'next':
      next();
      break;
    case 'prev':
      previous();
      break;
    case 'volume-up':
      setVolume(Math.min(1, usePlayerStore.getState().volume + 0.05));
      break;
    case 'volume-down':
      setVolume(Math.max(0, usePlayerStore.getState().volume - 0.05));
      break;
    case 'seek-forward': {
      const state = usePlayerStore.getState();
      const duration = state.currentTrack?.duration ?? 0;
      if (!duration) break;
      seek(Math.min(1, (state.currentTime + 10) / duration));
      break;
    }
    case 'seek-backward': {
      const state = usePlayerStore.getState();
      const duration = state.currentTrack?.duration ?? 0;
      if (!duration) break;
      seek(Math.max(0, (state.currentTime - 10) / duration));
      break;
    }
    case 'toggle-queue':
      toggleQueue();
      break;
    case 'open-folder-browser':
      options.navigate('/folders', { state: { folderBrowserRevealTs: Date.now() } });
      break;
    case 'fullscreen-player':
      toggleFullscreen();
      break;
    case 'native-fullscreen': {
      const win = getCurrentWindow();
      win.isFullscreen().then(fullscreen => win.setFullscreen(!fullscreen));
      break;
    }
    case 'open-mini-player':
      invoke('open_mini_player').catch(() => {});
      break;
  }
}

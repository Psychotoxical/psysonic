import { queueSongRating } from '@/features/playback/store/pendingStarSync';
import i18n from '@/lib/i18n';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { showToast } from '@/lib/dom/toast';
import { playByOpaqueId } from '@/features/playback/utils/playback/playByOpaqueId';
import type { ActionContext, CliContext } from '@/config/shortcutTypes';
import {
  SHORTCUT_ACTION_REGISTRY,
  type ShortcutAction,
  type GlobalAction,
} from './shortcutActionRegistry';

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
  if (command === 'volume-relative') {
    const delta = Number(ctx.payload.deltaPercent);
    if (!Number.isFinite(delta)) return;
    const state = usePlayerStore.getState();
    state.setVolume(Math.min(1, Math.max(0, state.volume + delta / 100)));
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
    queueSongRating(track.id, stars);
    return;
  }
  // no-op for unknown command
}

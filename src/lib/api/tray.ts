/**
 * Typed facade over the generated tray commands. All are Result-wrapped; the
 * facade re-throws on error so the callers' `.catch()` handlers (which log or
 * silently ignore) fire exactly as they did with the raw `invoke` calls.
 */
import { commands } from '@/generated/bindings';

export async function setTrayTooltip(args: {
  tooltip: string;
  playbackState: string | null;
}): Promise<void> {
  const res = await commands.setTrayTooltip(args.tooltip, args.playbackState);
  if (res.status === 'error') throw new Error(res.error);
}

export async function toggleTrayIcon(args: { show: boolean }): Promise<void> {
  const res = await commands.toggleTrayIcon(args.show);
  if (res.status === 'error') throw new Error(res.error);
}

export async function setTrayMenuLabels(args: {
  playPause: string;
  next: string;
  previous: string;
  showHide: string;
  quit: string;
  nothingPlaying: string;
}): Promise<void> {
  const res = await commands.setTrayMenuLabels(
    args.playPause,
    args.next,
    args.previous,
    args.showHide,
    args.quit,
    args.nothingPlaying,
  );
  if (res.status === 'error') throw new Error(res.error);
}

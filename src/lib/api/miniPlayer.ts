/**
 * Typed facade over the generated mini-player window commands. All are
 * Result-wrapped; the facade re-throws on error so the callers' best-effort
 * `.catch()` / `try` semantics stay unchanged.
 */
import { commands } from '@/generated/bindings';

export async function openMiniPlayer(): Promise<void> {
  const res = await commands.openMiniPlayer();
  if (res.status === 'error') throw new Error(res.error);
}

export async function preloadMiniPlayer(): Promise<void> {
  const res = await commands.preloadMiniPlayer();
  if (res.status === 'error') throw new Error(res.error);
}

export async function closeMiniPlayer(): Promise<void> {
  const res = await commands.closeMiniPlayer();
  if (res.status === 'error') throw new Error(res.error);
}

export async function showMainWindow(): Promise<void> {
  const res = await commands.showMainWindow();
  if (res.status === 'error') throw new Error(res.error);
}

export async function setMiniPlayerAlwaysOnTop(args: { onTop: boolean }): Promise<void> {
  const res = await commands.setMiniPlayerAlwaysOnTop(args.onTop);
  if (res.status === 'error') throw new Error(res.error);
}

export async function resizeMiniPlayer(args: {
  width: number | null;
  height: number | null;
  minWidth: number | null;
  minHeight: number | null;
}): Promise<void> {
  const res = await commands.resizeMiniPlayer(args.width, args.height, args.minWidth, args.minHeight);
  if (res.status === 'error') throw new Error(res.error);
}

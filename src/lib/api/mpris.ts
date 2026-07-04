/**
 * Typed facade over the generated MPRIS commands (Linux desktop media controls
 * + souvlaki bridge). Both commands are Result-wrapped: the facade re-throws on
 * error so the callers' `.catch()` fire-and-forget semantics stay unchanged.
 */
import { commands } from '@/generated/bindings';

export async function mprisSetMetadata(args: {
  title: string | null;
  artist: string | null;
  album: string | null;
  coverUrl?: string | null;
  durationSecs: number | null;
}): Promise<void> {
  const res = await commands.mprisSetMetadata(
    args.title,
    args.artist,
    args.album,
    args.coverUrl ?? null,
    args.durationSecs,
  );
  if (res.status === 'error') throw new Error(res.error);
}

export async function mprisSetPlayback(args: {
  playing: boolean;
  positionSecs: number | null;
}): Promise<void> {
  const res = await commands.mprisSetPlayback(args.playing, args.positionSecs);
  if (res.status === 'error') throw new Error(res.error);
}

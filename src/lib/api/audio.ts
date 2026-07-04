/**
 * Typed facade over the generated `commands.audio*` bindings — the single place
 * the frontend talks to the Rust audio engine (playback hot path).
 *
 * Two categories of generated command, kept behaviourally identical to the old
 * raw `invoke('audio_…')` calls the call sites used before:
 *  - **plain** commands return `Promise<T>` and reject on a Rust error, exactly
 *    like `invoke` did → thin passthrough.
 *  - **`Result`-wrapped** commands (`audioResume/Seek/Preload/PreviewPlay/
 *    SetDevice/PlayRadio`) resolve `{ status: 'error' }` instead of rejecting.
 *    A naive inline swap would silently swallow errors in the hot path, so the
 *    facade re-throws on `status === 'error'` to preserve the callers' reject
 *    semantics (their `.catch()` / `try` blocks keep working unchanged).
 *
 * `audio_play` / `audio_chain_preload` stay on `invoke` at their call sites:
 * they exceed specta's 10-arg cap and are not collected into the typed bindings.
 */
import { commands } from '@/generated/bindings';

/** 10-band EQ gains; the generated binding types this as a fixed 10-tuple. */
type EqGains = Parameters<typeof commands.audioSetEq>[0];

// ── plain passthrough (reject on Rust error, like invoke) ────────────────────

export function audioPause(): Promise<void> {
  return commands.audioPause();
}

export function audioStop(): Promise<void> {
  return commands.audioStop();
}

export function audioSetVolume(args: { volume: number | null }): Promise<void> {
  return commands.audioSetVolume(args.volume);
}

export function audioUpdateReplayGain(args: {
  volume: number | null;
  replayGainDb: number | null;
  replayGainPeak: number | null;
  loudnessGainDb: number | null;
  preGainDb: number | null;
  fallbackDb: number | null;
}): Promise<void> {
  return commands.audioUpdateReplayGain(
    args.volume,
    args.replayGainDb,
    args.replayGainPeak,
    args.loudnessGainDb,
    args.preGainDb,
    args.fallbackDb,
  );
}

export function audioSetEq(args: {
  gains: number[];
  enabled: boolean;
  preGain: number | null;
}): Promise<void> {
  return commands.audioSetEq(args.gains as EqGains, args.enabled, args.preGain);
}

export function audioSetPlaybackRate(args: {
  enabled: boolean;
  strategy: string;
  speed: number | null;
  pitchSemitones: number | null;
}): Promise<void> {
  return commands.audioSetPlaybackRate(args.enabled, args.strategy, args.speed, args.pitchSemitones);
}

export function audioSetCrossfade(args: { enabled: boolean; secs: number | null }): Promise<void> {
  return commands.audioSetCrossfade(args.enabled, args.secs);
}

export function audioSetGapless(args: { enabled: boolean }): Promise<void> {
  return commands.audioSetGapless(args.enabled);
}

export function audioBeginOutgoingFade(args: { fadeSecs: number | null }): Promise<void> {
  return commands.audioBeginOutgoingFade(args.fadeSecs);
}

export function audioSetAutodjSuppress(args: { enabled: boolean }): Promise<void> {
  return commands.audioSetAutodjSuppress(args.enabled);
}

export function audioSetNormalization(args: {
  engine: string;
  targetLufs: number | null;
  preAnalysisAttenuationDb: number | null;
}): Promise<void> {
  return commands.audioSetNormalization(args.engine, args.targetLufs, args.preAnalysisAttenuationDb);
}

export function audioPreviewStop(): Promise<void> {
  return commands.audioPreviewStop();
}

export function audioPreviewStopSilent(): Promise<void> {
  return commands.audioPreviewStopSilent();
}

export function audioPreviewSetVolume(args: { volume: number | null }): Promise<void> {
  return commands.audioPreviewSetVolume(args.volume);
}

export function audioListDevices(): Promise<string[]> {
  return commands.audioListDevices();
}

export function audioDefaultOutputDeviceName(): Promise<string | null> {
  return commands.audioDefaultOutputDeviceName();
}

export function audioCanonicalizeSelectedDevice(): Promise<string | null> {
  return commands.audioCanonicalizeSelectedDevice();
}

// ── Result-wrapped (facade re-throws so callers keep reject semantics) ────────

export async function audioResume(): Promise<void> {
  const res = await commands.audioResume();
  if (res.status === 'error') throw new Error(res.error);
}

export async function audioSeek(args: { seconds: number | null }): Promise<void> {
  const res = await commands.audioSeek(args.seconds);
  if (res.status === 'error') throw new Error(res.error);
}

export async function audioSetDevice(args: { deviceName: string | null }): Promise<void> {
  const res = await commands.audioSetDevice(args.deviceName);
  if (res.status === 'error') throw new Error(res.error);
}

export async function audioPreload(args: {
  url: string;
  durationHint: number | null;
  analysisTrackId: string | null;
  serverId: string | null;
  eager?: boolean | null;
}): Promise<void> {
  const res = await commands.audioPreload(
    args.url,
    args.durationHint,
    args.analysisTrackId,
    args.serverId,
    args.eager ?? null,
  );
  if (res.status === 'error') throw new Error(res.error);
}

export async function audioPreviewPlay(args: {
  id: string;
  url: string;
  startSec: number | null;
  durationSec: number | null;
  volume: number | null;
  formatSuffix: string | null;
}): Promise<void> {
  const res = await commands.audioPreviewPlay(
    args.id,
    args.url,
    args.startSec,
    args.durationSec,
    args.volume,
    args.formatSuffix,
  );
  if (res.status === 'error') throw new Error(res.error);
}

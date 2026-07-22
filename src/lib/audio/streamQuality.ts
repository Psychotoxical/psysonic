/**
 * Streaming transcode quality — an optional cap sent to the Subsonic server as
 * `maxBitRate` on `stream.view`. `0` means "Original" (no cap, no client-
 * requested transcode). Any other value asks the server to transcode the live
 * stream down to at most that bitrate (kbps); the server picks its configured
 * transcoder/format. Sources already at or below the cap are streamed as-is.
 *
 * This only governs the *live playback* stream — hot-cache prefetch, offline
 * downloads, and loudness/waveform analysis always pull the original file (see
 * `resolvePlaybackUrl`).
 */
export const STREAM_MAX_BITRATE_OPTIONS = [0, 320, 256, 192, 128, 96, 64] as const;

export type StreamMaxBitRateKbps = (typeof STREAM_MAX_BITRATE_OPTIONS)[number];

export const DEFAULT_STREAM_MAX_BITRATE_KBPS: StreamMaxBitRateKbps = 0;

/** Clamp any persisted/user value to a supported option; unknown → Original. */
export function sanitizeStreamMaxBitRateKbps(value: unknown): StreamMaxBitRateKbps {
  return (STREAM_MAX_BITRATE_OPTIONS as readonly number[]).includes(value as number)
    ? (value as StreamMaxBitRateKbps)
    : DEFAULT_STREAM_MAX_BITRATE_KBPS;
}

/**
 * Streaming transcode quality — an optional cap sent to the Subsonic server as
 * `maxBitRate` on `stream.view`. `0` means "Original" (no cap, no client-
 * requested transcode). Any other value asks the server to transcode the live
 * stream down to at most that bitrate (kbps); the server picks its configured
 * transcoder/format. Sources already at or below the cap are streamed as-is.
 *
 * This only governs the *live playback* stream. Original-byte producers use
 * the shared original-stream URL path: confirmed Navidrome profiles request
 * `format=raw`; unknown and non-Navidrome profiles keep the ordinary uncapped
 * stream request.
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

/**
 * Transcode target format sent to the server as `format` on `stream.view`.
 * `auto` = omit the param (server picks its configured transcoder when a
 * bitrate cap forces a transcode; streams untouched otherwise).
 */
export const STREAM_FORMAT_OPTIONS = ['auto', 'mp3', 'opus', 'aac'] as const;

export type StreamRequestFormat = (typeof STREAM_FORMAT_OPTIONS)[number];

export const DEFAULT_STREAM_FORMAT: StreamRequestFormat = 'auto';

export function sanitizeStreamRequestFormat(value: unknown): StreamRequestFormat {
  return (STREAM_FORMAT_OPTIONS as readonly string[]).includes(value as string)
    ? (value as StreamRequestFormat)
    : DEFAULT_STREAM_FORMAT;
}

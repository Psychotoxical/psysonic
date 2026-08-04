import type { Track } from '@/lib/media/trackTypes';

export type StreamProvenance = 'original' | 'transcoded' | 'unknown';

/**
 * The format the Rust audio engine actually decoded for the live stream,
 * delivered by the `audio:format` event. This reflects what the server is
 * *transmitting right now* — which can differ from the track's stored library
 * metadata when the server transcodes on the fly (e.g. Navidrome forced
 * transcoding, or a client-requested `maxBitRate` cap).
 *
 * `trackId` stamps the currently-playing track at the moment the event
 * arrived, so a stale format from a previous track is never shown against a
 * new one (see `handleAudioFormat`).
 */
export interface ResolvedStreamFormat {
  trackId: string;
  /** Canonical playback server key carried by the native format event. */
  serverId?: string;
  /** Decoder codec short name, e.g. `mp3`, `flac`, `aac`, `opus`, `pcm_s16le`. */
  codec: string;
  /** Decoded sample rate in Hz. */
  sampleRate?: number;
  /** Bit depth — only meaningful (and only sent) for lossless codecs. */
  bitsPerSample?: number;
  channels?: number;
  lossless: boolean;
  /**
   * Streaming bitrate cap (kbps) in effect when this stream was opened; 0 =
   * Original. Captured at resolve time so the badge shows the cap the current
   * stream actually used, not a setting the user changed mid-playback.
   */
  streamCapKbps?: number;
  /**
   * Playback generation the format belongs to — used to reject out-of-order
   * events from a superseded stream of the same track (replay, rapid restart).
   */
  generation?: number;
  /** Trusted raw-prefix comparison for the captured HTTP stream. */
  provenance?: StreamProvenance;
}

/**
 * Canonical codec family for a symphonia codec short-name. Collapses the
 * decoder's specific name (`pcm_s16le`, `pcm_f32le`, …) onto the family we can
 * compare against a file suffix.
 */
function codecFamily(codec: string): string {
  const c = codec.trim().toLowerCase();
  if (c.startsWith('pcm')) return 'pcm';
  return c;
}

/**
 * Codec families each file suffix can legitimately contain *without* a
 * transcode. Containers that carry more than one codec (`m4a` → AAC or ALAC,
 * `ogg` → Vorbis or Opus) list every acceptable family so an original file is
 * never mislabelled as transcoded.
 */
const SUFFIX_CODECS: Record<string, readonly string[]> = {
  mp3: ['mp3'],
  flac: ['flac'],
  m4a: ['aac', 'alac'],
  m4b: ['aac', 'alac'],
  mp4: ['aac', 'alac'],
  aac: ['aac'],
  ogg: ['vorbis', 'opus'],
  oga: ['vorbis', 'opus'],
  opus: ['opus'],
  wav: ['pcm'],
  wave: ['pcm'],
  aiff: ['pcm'],
  aif: ['pcm'],
  wv: ['wavpack'],
  wavpack: ['wavpack'],
  ape: ['monkeys-audio'],
  tta: ['tta'],
  wma: ['wma'],
};

/**
 * Whether the live-decoded codec differs from what the track's suffix implies —
 * i.e. the server transcoded the stream. Conservative: an unknown suffix, a
 * missing codec, or a suffix whose codec set includes the decoded family is
 * treated as NOT transcoded, so we never show a spurious badge.
 */
export function isStreamTranscoded(suffix: string | undefined, codec: string): boolean {
  if (!suffix || !codec) return false;
  const accepted = SUFFIX_CODECS[suffix.trim().toLowerCase()];
  if (!accepted) return false;
  return !accepted.includes(codecFamily(codec));
}

/** Effective audio-format fields for the now-playing badges. */
export interface EffectiveAudioFormat {
  /** Uppercased format label — decoded codec when transcoded, else file suffix. */
  formatLabel?: string;
  /** kbps to display, or undefined when unknown (server-forced transcode, no cap). */
  bitRate?: number;
  /** `true` when {@link bitRate} is an upper bound (a client-requested cap), not exact. */
  bitRateIsCap: boolean;
  sampleRate?: number;
  bitDepth?: number;
  /** The stream is being transcoded by the server relative to the stored file. */
  transcoded: boolean;
}

/**
 * Merge the track's stored metadata with the live-resolved stream format into
 * the fields the badges should display.
 *
 * - No resolved format, or not the current track, or no transcode detected →
 *   the stored metadata is accurate; return it unchanged.
 * - Transcode proven by raw-prefix provenance, or by a definite codec-family
 *   mismatch → show the decoded codec/sample-rate. The exact transmitted
 *   bitrate is not knowable, so show the requested cap only as a ceiling.
 */
export function effectiveAudioFormat(
  track: Pick<Track, 'id' | 'suffix' | 'bitRate' | 'samplingRate' | 'bitDepth'>,
  resolved: ResolvedStreamFormat | null | undefined,
): EffectiveAudioFormat {
  // The cap the stream was opened at travels on the resolved format, so the
  // badge reflects the actual stream — not a setting changed mid-playback.
  const streamCapKbps = resolved?.streamCapKbps ?? 0;
  const base: EffectiveAudioFormat = {
    formatLabel: track.suffix ? track.suffix.toUpperCase() : undefined,
    bitRate: track.bitRate && track.bitRate > 0 ? track.bitRate : undefined,
    bitRateIsCap: false,
    sampleRate: track.samplingRate,
    bitDepth: track.bitDepth,
    transcoded: false,
  };

  if (!resolved || resolved.trackId !== track.id) return base;

  const codecTranscoded = isStreamTranscoded(track.suffix, resolved.codec);
  // A trusted ORIGINAL verdict wins over request heuristics: a cap is only a
  // request ceiling, not proof the server changed the bytes. UNKNOWN/legacy
  // events may still use a definite codec-family mismatch as evidence.
  const transcoded = resolved.provenance === 'transcoded'
    || (resolved.provenance !== 'original' && codecTranscoded);
  if (!transcoded) {
    // Not transcoded: the live decode confirms the stored metadata. Prefer the
    // decoded sample rate / bit depth when the server reported them.
    return {
      ...base,
      sampleRate: resolved.sampleRate ?? base.sampleRate,
      bitDepth: resolved.lossless ? (resolved.bitsPerSample ?? base.bitDepth) : base.bitDepth,
    };
  }

  const cap = streamCapKbps > 0 ? streamCapKbps : undefined;
  return {
    formatLabel: resolved.codec.toUpperCase(),
    bitRate: cap,
    bitRateIsCap: cap != null,
    sampleRate: resolved.sampleRate ?? track.samplingRate,
    bitDepth: resolved.lossless ? resolved.bitsPerSample : undefined,
    transcoded: true,
  };
}

/** Human-readable "SUFFIX · 320 kbps · 24-bit" parts for a joined badge line. */
export function effectiveAudioFormatParts(fmt: EffectiveAudioFormat): string[] {
  const parts: string[] = [];
  if (fmt.formatLabel) parts.push(fmt.formatLabel);
  if (fmt.bitRate) parts.push(`${fmt.bitRateIsCap ? '≤' : ''}${fmt.bitRate} kbps`);
  if (fmt.bitDepth && fmt.sampleRate) {
    parts.push(`${fmt.bitDepth}/${fmt.sampleRate / 1000} kHz`);
  } else if (fmt.bitDepth) {
    parts.push(`${fmt.bitDepth}-bit`);
  } else if (fmt.sampleRate) {
    parts.push(`${fmt.sampleRate / 1000} kHz`);
  }
  return parts;
}

import { describe, expect, it } from 'vitest';
import {
  effectiveAudioFormat,
  effectiveAudioFormatParts,
  isStreamTranscoded,
  type ResolvedStreamFormat,
} from '@/lib/media/streamFormat';

function resolved(partial: Partial<ResolvedStreamFormat> & { codec: string }): ResolvedStreamFormat {
  return { trackId: 't1', lossless: false, ...partial };
}

describe('isStreamTranscoded', () => {
  it('is false when the decoded codec matches the file suffix', () => {
    expect(isStreamTranscoded('flac', 'flac')).toBe(false);
    expect(isStreamTranscoded('mp3', 'mp3')).toBe(false);
  });

  it('is true when the server transcoded to a different codec', () => {
    expect(isStreamTranscoded('flac', 'mp3')).toBe(true);
    expect(isStreamTranscoded('flac', 'aac')).toBe(true);
  });

  it('treats multi-codec containers leniently (no false positive)', () => {
    // m4a can hold AAC or ALAC; ogg can hold Vorbis or Opus.
    expect(isStreamTranscoded('m4a', 'aac')).toBe(false);
    expect(isStreamTranscoded('m4a', 'alac')).toBe(false);
    expect(isStreamTranscoded('ogg', 'vorbis')).toBe(false);
    expect(isStreamTranscoded('ogg', 'opus')).toBe(false);
  });

  it('normalizes pcm_* decoder names against PCM containers', () => {
    expect(isStreamTranscoded('wav', 'pcm_s16le')).toBe(false);
    expect(isStreamTranscoded('wav', 'pcm_f32le')).toBe(false);
    expect(isStreamTranscoded('aifc', 'pcm_alaw')).toBe(false);
  });

  it('is conservative for unknown suffix / missing codec', () => {
    expect(isStreamTranscoded('xyz', 'mp3')).toBe(false);
    expect(isStreamTranscoded(undefined, 'mp3')).toBe(false);
    expect(isStreamTranscoded('flac', '')).toBe(false);
  });
});

describe('effectiveAudioFormat', () => {
  const track = { id: 't1', suffix: 'flac', bitRate: 3149, samplingRate: 96000, bitDepth: 24 };

  it('returns stored metadata when no resolved format is present', () => {
    const fmt = effectiveAudioFormat(track, null);
    expect(fmt).toMatchObject({
      formatLabel: 'FLAC', bitRate: 3149, sampleRate: 96000, bitDepth: 24, transcoded: false,
    });
  });

  it('ignores a resolved format stamped for a different track', () => {
    const fmt = effectiveAudioFormat(track, resolved({ trackId: 'other', codec: 'mp3' }));
    expect(fmt.formatLabel).toBe('FLAC');
    expect(fmt.transcoded).toBe(false);
  });

  it('shows the real codec and drops stale bitrate/depth on a server transcode', () => {
    const fmt = effectiveAudioFormat(
      track,
      resolved({ codec: 'mp3', sampleRate: 44100, lossless: false }),
    );
    expect(fmt.transcoded).toBe(true);
    expect(fmt.formatLabel).toBe('MP3');
    expect(fmt.bitRate).toBeUndefined();      // exact transmitted bitrate unknown, no cap set
    expect(fmt.bitDepth).toBeUndefined();     // no bit depth for lossy output
    expect(fmt.sampleRate).toBe(44100);
  });

  it('shows the requested cap as an upper bound when the user set one', () => {
    const fmt = effectiveAudioFormat(
      track,
      resolved({ codec: 'mp3', sampleRate: 44100, streamCapKbps: 320 }),
    );
    expect(fmt.bitRate).toBe(320);
    expect(fmt.bitRateIsCap).toBe(true);
    expect(effectiveAudioFormatParts(fmt)).toContain('≤320 kbps');
  });

  it('keeps lossless bit depth when transcoding to another lossless codec', () => {
    const fmt = effectiveAudioFormat(
      { id: 't1', suffix: 'flac', bitRate: 3149, samplingRate: 96000, bitDepth: 24 },
      resolved({ codec: 'alac', sampleRate: 96000, bitsPerSample: 24, lossless: true }),
    );
    expect(fmt.transcoded).toBe(true);
    expect(fmt.formatLabel).toBe('ALAC');
    expect(fmt.bitDepth).toBe(24);
  });

  it('shows a forced same-codec transcode when native provenance proves it', () => {
    const mp3 = { id: 't1', suffix: 'mp3', bitRate: 320, samplingRate: 44100, bitDepth: undefined };
    const fmt = effectiveAudioFormat(mp3, resolved({
      codec: 'mp3', sampleRate: 44100, streamCapKbps: 128, provenance: 'transcoded',
    }));
    expect(fmt.transcoded).toBe(true);
    expect(fmt.formatLabel).toBe('MP3');
    expect(fmt.bitRate).toBe(128);
    expect(fmt.bitRateIsCap).toBe(true);
  });

  it('uses provenance for same-family M4A/AAC and OGG/Opus transcodes', () => {
    const m4a = effectiveAudioFormat(
      { id: 't1', suffix: 'm4a', bitRate: 900, samplingRate: 48000, bitDepth: 24 },
      resolved({ codec: 'aac', streamCapKbps: 192, provenance: 'transcoded' }),
    );
    const ogg = effectiveAudioFormat(
      { id: 't1', suffix: 'ogg', bitRate: 320, samplingRate: 48000, bitDepth: undefined },
      resolved({ codec: 'opus', streamCapKbps: 128, provenance: 'transcoded' }),
    );
    expect(m4a).toMatchObject({ transcoded: true, formatLabel: 'AAC', bitRate: 192 });
    expect(ogg).toMatchObject({ transcoded: true, formatLabel: 'OPUS', bitRate: 128 });
  });

  it('keeps matching-format direct play original even when a cap was requested', () => {
    const mp3 = { id: 't1', suffix: 'mp3', bitRate: 320, samplingRate: 44100, bitDepth: undefined };
    const fmt = effectiveAudioFormat(mp3, resolved({
      codec: 'mp3', sampleRate: 44100, streamCapKbps: 128, provenance: 'original',
    }));
    expect(fmt.transcoded).toBe(false);
    expect(fmt.bitRate).toBe(320);
    expect(fmt.bitRateIsCap).toBe(false);
  });

  it('does not use an unknown or absent provenance cap as proof of transcode', () => {
    const mp3 = { id: 't1', suffix: 'mp3', bitRate: 320, samplingRate: 44100, bitDepth: undefined };
    const unknown = effectiveAudioFormat(mp3, resolved({
      codec: 'mp3', sampleRate: 44100, streamCapKbps: 128, provenance: 'unknown',
    }));
    const absent = effectiveAudioFormat(mp3, resolved({
      codec: 'mp3', sampleRate: 44100, streamCapKbps: 128,
    }));
    expect(unknown).toMatchObject({ transcoded: false, bitRate: 320, bitRateIsCap: false });
    expect(absent).toMatchObject({ transcoded: false, bitRate: 320, bitRateIsCap: false });
  });

  it('prefers the decoded sample rate when the codec is unchanged', () => {
    const fmt = effectiveAudioFormat(
      { id: 't1', suffix: 'flac', bitRate: 900, samplingRate: 44100, bitDepth: 16 },
      resolved({ codec: 'flac', sampleRate: 48000, bitsPerSample: 24, lossless: true }),
    );
    expect(fmt.transcoded).toBe(false);
    expect(fmt.sampleRate).toBe(48000);
    expect(fmt.bitDepth).toBe(24);
    expect(fmt.bitRate).toBe(900);            // stored bitrate kept (no transcode)
  });
});

describe('effectiveAudioFormatParts', () => {
  it('joins into the "FLAC · 3149 kbps · 24/96 kHz" shape', () => {
    const parts = effectiveAudioFormatParts(
      effectiveAudioFormat(
        { id: 't1', suffix: 'flac', bitRate: 3149, samplingRate: 96000, bitDepth: 24 },
        null,
      ),
    );
    expect(parts).toEqual(['FLAC', '3149 kbps', '24/96 kHz']);
  });
});

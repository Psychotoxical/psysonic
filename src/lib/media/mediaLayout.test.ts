import { describe, expect, it } from 'vitest';
import { layoutFingerprintFromLibraryTrack, sanitizeAndTruncateSegment } from '@/lib/media/mediaLayout';

// Keep in sync with `short_hash` in `src-tauri/crates/psysonic-core/src/media_layout.rs`.
function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

describe('mediaLayout', () => {
  it('shortHash parity anchor matches Rust imul-31 UTF-16', () => {
    expect(shortHash('Radiohead')).toBe('3da68c3b');
  });

  it('does not truncate Cyrillic segments under 120 code points (byte length may exceed 120)', () => {
    const segment = 'а'.repeat(100);
    expect([...segment].length).toBe(100);
    expect(Buffer.byteLength(segment, 'utf8')).toBeGreaterThan(120);
    expect(sanitizeAndTruncateSegment(segment)).toBe(segment);
  });

  it('truncates long Cyrillic segments with the same hash suffix as Rust', () => {
    const segment = 'а'.repeat(130);
    expect(sanitizeAndTruncateSegment(segment)).toBe(
      `${'а'.repeat(111)}_eef20600`,
    );
  });

  it('layout fingerprint uses truncated hash for very long segments', () => {
    const longName = 'A'.repeat(200);
    const track = {
      serverId: 'srv',
      id: 't1',
      title: 'Song',
      artist: longName,
      album: 'Album',
      albumArtist: null,
      trackNumber: 1,
      discNumber: 1,
      durationSec: 180,
      suffix: 'mp3',
      rawJson: null,
      syncedAt: 0,
    };
    const fp = layoutFingerprintFromLibraryTrack(track);
    expect(fp).toContain('_');
    expect(fp.length).toBeLessThan(600);
  });
});

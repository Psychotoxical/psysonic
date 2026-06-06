import { describe, expect, it } from 'vitest';
import { layoutFingerprintFromLibraryTrack } from './mediaLayout';

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

  it('layout fingerprint uses truncated hash for very long segments', () => {
    const longName = 'A'.repeat(200);
    const track = {
      id: 't1',
      title: 'Song',
      artist: longName,
      album: 'Album',
      album_artist: null,
      track_number: 1,
      disc_number: 1,
      suffix: 'mp3',
      raw_json: null,
    };
    const fp = layoutFingerprintFromLibraryTrack(track as never);
    expect(fp).toContain('_');
    expect(fp.length).toBeLessThan(600);
  });
});

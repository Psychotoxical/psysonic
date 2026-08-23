import { describe, expect, it } from 'vitest';
import { formatSmartPreviewTrackLabel } from './formatSmartPreviewTrack';

describe('formatSmartPreviewTrackLabel', () => {
  it('joins album artist, album, and title', () => {
    expect(formatSmartPreviewTrackLabel({
      albumArtist: 'Massive Attack',
      album: 'Mezzanine',
      title: 'Teardrop',
    })).toBe('Massive Attack - Mezzanine - Teardrop');
  });

  it('falls back to artist and name and skips blanks', () => {
    expect(formatSmartPreviewTrackLabel({
      artist: 'Portishead',
      album: '',
      name: 'Glory Box',
    })).toBe('Portishead - Glory Box');
  });
});

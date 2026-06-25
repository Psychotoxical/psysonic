import { describe, it, expect } from 'vitest';
import { pickArtistBackdrop } from './artistBackdrop';

const img = (src: string, pending = false) => ({ src, pending });

describe('pickArtistBackdrop', () => {
  it('prefers the banner and keeps it centered', () => {
    expect(pickArtistBackdrop(img('banner.webp'), img('fanart.webp'), 'nd.webp')).toEqual({
      url: 'banner.webp',
      position: undefined,
    });
  });

  it('holds empty while the banner is still resolving (no lower-priority flash)', () => {
    // position only goes undefined on a *resolved* banner src; while pending the
    // url is '' so the position is moot, but it carries the portrait default.
    expect(pickArtistBackdrop(img('', true), img('fanart.webp'), 'nd.webp')).toEqual({
      url: '',
      position: 'center 30%',
    });
  });

  it('falls to the 16:9 fanart on a banner miss, raising the focal point', () => {
    expect(pickArtistBackdrop(img('', false), img('fanart.webp'), 'nd.webp')).toEqual({
      url: 'fanart.webp',
      position: 'center 30%',
    });
  });

  it('holds empty while the fanart is still resolving after a banner miss', () => {
    expect(pickArtistBackdrop(img('', false), img('', true), 'nd.webp')).toEqual({
      url: '',
      position: 'center 30%',
    });
  });

  it('falls back to the Navidrome artist cover when neither external surface exists', () => {
    expect(pickArtistBackdrop(img('', false), img('', false), 'nd.webp')).toEqual({
      url: 'nd.webp',
      position: 'center 30%',
    });
  });

  it('yields no backdrop when nothing resolves', () => {
    expect(pickArtistBackdrop(img('', false), img('', false), '')).toEqual({
      url: '',
      position: 'center 30%',
    });
  });
});

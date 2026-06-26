import { describe, it, expect } from 'vitest';
import {
  resolveBackdrop,
  backdropFromConfig,
  type BackdropSourcePref,
} from './artistBackdrop';

const img = (src: string, pending = false) => ({ src, pending });

// Default full priority: banner → fanart → navidrome, all enabled.
const order: BackdropSourcePref[] = [
  { source: 'banner', enabled: true },
  { source: 'fanart', enabled: true },
  { source: 'navidrome', enabled: true },
];

describe('resolveBackdrop', () => {
  it('takes the first resolved candidate and respects its framing', () => {
    expect(
      resolveBackdrop([
        { src: 'banner.webp', centered: true },
        { src: 'fanart.webp', centered: false },
      ]),
    ).toEqual({ url: 'banner.webp', position: undefined });
  });

  it('holds empty while a higher-priority candidate is still resolving', () => {
    expect(
      resolveBackdrop([
        { src: '', pending: true, centered: true },
        { src: 'fanart.webp', centered: false },
      ]),
    ).toEqual({ url: '', position: 'center 30%' });
  });

  it('steps past a confirmed miss to the next candidate', () => {
    expect(
      resolveBackdrop([
        { src: '', pending: false, centered: true },
        { src: 'fanart.webp', centered: false },
      ]),
    ).toEqual({ url: 'fanart.webp', position: 'center 30%' });
  });

  it('yields no backdrop when nothing resolves', () => {
    expect(resolveBackdrop([{ src: '', centered: false }])).toEqual({
      url: '',
      position: 'center 30%',
    });
  });
});

describe('backdropFromConfig', () => {
  it('reproduces the legacy banner → fanart → navidrome priority', () => {
    expect(backdropFromConfig(order, { banner: img('b.webp'), fanart: img('f.webp'), navidrome: 'nd.webp' })).toEqual({
      url: 'b.webp',
      position: undefined,
    });
    expect(backdropFromConfig(order, { banner: img('', false), fanart: img('f.webp'), navidrome: 'nd.webp' })).toEqual({
      url: 'f.webp',
      position: 'center 30%',
    });
    expect(backdropFromConfig(order, { banner: img('', false), fanart: img('', false), navidrome: 'nd.webp' })).toEqual({
      url: 'nd.webp',
      position: 'center 30%',
    });
  });

  it('holds empty while a still-pending source is highest priority', () => {
    expect(backdropFromConfig(order, { banner: img('', true), fanart: img('f.webp'), navidrome: 'nd.webp' })).toEqual({
      url: '',
      position: 'center 30%',
    });
  });

  it('honours a reordered priority (navidrome first)', () => {
    const navFirst: BackdropSourcePref[] = [
      { source: 'navidrome', enabled: true },
      { source: 'fanart', enabled: true },
      { source: 'banner', enabled: true },
    ];
    expect(backdropFromConfig(navFirst, { banner: img('b.webp'), fanart: img('f.webp'), navidrome: 'nd.webp' })).toEqual({
      url: 'nd.webp',
      position: 'center 30%',
    });
  });

  it('skips a disabled source', () => {
    const noBanner: BackdropSourcePref[] = [
      { source: 'banner', enabled: false },
      { source: 'fanart', enabled: true },
      { source: 'navidrome', enabled: true },
    ];
    expect(backdropFromConfig(noBanner, { banner: img('b.webp'), fanart: img('f.webp'), navidrome: 'nd.webp' })).toEqual({
      url: 'f.webp',
      position: 'center 30%',
    });
  });

  it('skips a source the caller does not supply (fullscreen has no banner)', () => {
    const fsOrder: BackdropSourcePref[] = [
      { source: 'fanart', enabled: true },
      { source: 'navidrome', enabled: true },
    ];
    expect(backdropFromConfig(fsOrder, { fanart: img('', false), navidrome: 'nd.webp' })).toEqual({
      url: 'nd.webp',
      position: 'center 30%',
    });
  });

  it('yields no backdrop when every source is disabled', () => {
    const allOff: BackdropSourcePref[] = order.map((s) => ({ ...s, enabled: false }));
    expect(backdropFromConfig(allOff, { banner: img('b.webp'), fanart: img('f.webp'), navidrome: 'nd.webp' })).toEqual({
      url: '',
      position: 'center 30%',
    });
  });
});

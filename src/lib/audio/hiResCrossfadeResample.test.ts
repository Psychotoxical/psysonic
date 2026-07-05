import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HI_RES_CROSSFADE_RESAMPLE_HZ,
  audioPlayHiResBlendArgs,
  sanitizeHiResCrossfadeResampleHz,
} from '@/lib/audio/hiResCrossfadeResample';

describe('hiResCrossfadeResample', () => {
  it('defaults unknown values to 44.1 kHz', () => {
    expect(sanitizeHiResCrossfadeResampleHz(undefined)).toBe(44_100);
    expect(sanitizeHiResCrossfadeResampleHz(48_000)).toBe(44_100);
  });

  it('keeps allowed blend rates', () => {
    expect(sanitizeHiResCrossfadeResampleHz(88_200)).toBe(88_200);
    expect(sanitizeHiResCrossfadeResampleHz(96_000)).toBe(96_000);
  });

  it('omits blend rate when hi-res is off', () => {
    expect(
      audioPlayHiResBlendArgs({
        enableHiRes: false,
        hiResCrossfadeResampleHz: DEFAULT_HI_RES_CROSSFADE_RESAMPLE_HZ,
      }),
    ).toEqual({ hiResEnabled: false, hiResCrossfadeResampleHz: null });
  });

  it('forwards blend rate when hi-res is on', () => {
    expect(
      audioPlayHiResBlendArgs({ enableHiRes: true, hiResCrossfadeResampleHz: 96_000 }),
    ).toEqual({ hiResEnabled: true, hiResCrossfadeResampleHz: 96_000 });
  });
});

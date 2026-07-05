/** Hi-Res transition blend output rates (Hz) for crossfade, AutoDJ, and gapless. */
export const HI_RES_CROSSFADE_RESAMPLE_OPTIONS = [44_100, 88_200, 96_000] as const;

export type HiResCrossfadeResampleHz = (typeof HI_RES_CROSSFADE_RESAMPLE_OPTIONS)[number];

export const DEFAULT_HI_RES_CROSSFADE_RESAMPLE_HZ: HiResCrossfadeResampleHz = 44_100;

export function sanitizeHiResCrossfadeResampleHz(value: unknown): HiResCrossfadeResampleHz {
  if (value === 88_200 || value === 96_000) return value;
  return DEFAULT_HI_RES_CROSSFADE_RESAMPLE_HZ;
}

/** Args forwarded to `audio_play` for hi-res + crossfade blend rate. */
export function audioPlayHiResBlendArgs(auth: {
  enableHiRes: boolean;
  hiResCrossfadeResampleHz: HiResCrossfadeResampleHz;
}): {
  hiResEnabled: boolean;
  hiResCrossfadeResampleHz: number | null;
} {
  return {
    hiResEnabled: auth.enableHiRes,
    hiResCrossfadeResampleHz: auth.enableHiRes ? auth.hiResCrossfadeResampleHz : null,
  };
}

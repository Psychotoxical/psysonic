import { allNormalizedAddresses } from '@/lib/server/serverAddress';

type ProbeProfile = {
  url: string;
  alternateUrl?: string;
  username: string;
  password: string;
  customHeaders?: Array<{ name: string; value: string }>;
  customHeadersApplyTo?: 'local' | 'public' | 'both';
};

/** Stable probe identity without importing API or Zustand runtime modules. */
export function profileProbeFingerprint(profile: ProbeProfile): string {
  return JSON.stringify([
    ...allNormalizedAddresses(profile),
    profile.username,
    profile.password,
    profile.customHeaders ?? [],
    profile.customHeadersApplyTo ?? '',
  ]);
}

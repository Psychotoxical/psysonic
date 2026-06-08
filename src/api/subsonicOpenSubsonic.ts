import type { AudiomusePluginProbeResult } from '../utils/server/subsonicServerIdentity';
import { apiWithCredentials } from './subsonicClient';

export interface OpenSubsonicExtension {
  name: string;
  versions: number[];
}

export function parseOpenSubsonicExtensions(raw: unknown): OpenSubsonicExtension[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(entry => ({
      name: typeof entry.name === 'string' ? entry.name : '',
      versions: Array.isArray(entry.versions)
        ? entry.versions.filter((v): v is number => typeof v === 'number')
        : [],
    }))
    .filter(entry => entry.name.length > 0);
}

export function hasOpenSubsonicExtension(extensions: readonly OpenSubsonicExtension[], name: string): boolean {
  return extensions.some(ext => ext.name === name);
}

/**
 * Fetch the list of OpenSubsonic extension names advertised by the server, or
 * `null` when the request fails. Shared probe for any extension-gated feature.
 */
export async function fetchOpenSubsonicExtensionsWithCredentials(
  serverUrl: string,
  username: string,
  password: string,
): Promise<string[] | null> {
  try {
    const data = await apiWithCredentials<{ openSubsonicExtensions?: unknown }>(
      serverUrl,
      username,
      password,
      'getOpenSubsonicExtensions.view',
      {},
      12000,
    );
    return parseOpenSubsonicExtensions(data.openSubsonicExtensions).map(ext => ext.name);
  } catch {
    return null;
  }
}

/**
 * Navidrome ≥ 0.62: `sonicSimilarity` in `getOpenSubsonicExtensions` means an audio-similarity
 * plugin (typically AudioMuse-AI) is active on the server.
 */
export async function probeAudiomusePluginWithCredentials(
  serverUrl: string,
  username: string,
  password: string,
): Promise<Exclude<AudiomusePluginProbeResult, 'probing' | 'unsupported'>> {
  try {
    const data = await apiWithCredentials<{ openSubsonicExtensions?: unknown }>(
      serverUrl,
      username,
      password,
      'getOpenSubsonicExtensions.view',
      {},
      12000,
    );
    const extensions = parseOpenSubsonicExtensions(data.openSubsonicExtensions);
    return hasOpenSubsonicExtension(extensions, 'sonicSimilarity') ? 'present' : 'absent';
  } catch {
    return 'error';
  }
}

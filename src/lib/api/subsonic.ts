import axios from 'axios';
import md5 from 'md5';
import { useAuthStore } from '@/store/authStore';
import type { ServerProfile } from '@/store/authStoreTypes';
import { headersForServerRequest } from '@/lib/server/serverHttpHeaders';
import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';
import {
  type InstantMixProbeResult,
  type SubsonicServerIdentity,
} from '@/lib/server/subsonicServerIdentity';
import { fetchOpenSubsonicExtensionsWithCredentials } from '@/lib/api/subsonicOpenSubsonic';
import { buildCapabilityContext } from '@/lib/serverCapabilities/context';
import {
  PROBE_LEGACY_INSTANT_MIX,
  PROBE_OPENSUBSONIC_EXTENSIONS,
  SERVER_CAPABILITY_CATALOG,
  SONIC_SIMILARITY_EXTENSION,
} from '@/lib/serverCapabilities/catalog';
import { neededProbeIds } from '@/lib/serverCapabilities/resolve';
import {
  SUBSONIC_CLIENT,
  api,
  apiWithCredentials,
  secureRandomSalt,
  type ServerHttpHeaderProfile,
} from '@/lib/api/subsonicClient';
import type { PingWithCredentialsResult, SubsonicSong } from '@/lib/api/subsonicTypes';

export async function ping(): Promise<boolean> {
  try {
    await api('ping.view');
    return true;
  } catch {
    return false;
  }
}


/** Test a connection with explicit credentials — does NOT depend on store state. */
export async function pingWithCredentials(
  serverUrl: string,
  username: string,
  password: string,
): Promise<PingWithCredentialsResult> {
  try {
    const base = serverUrl.startsWith('http') ? serverUrl.replace(/\/$/, '') : `http://${serverUrl.replace(/\/$/, '')}`;
    const salt = secureRandomSalt();
    const token = md5(password + salt);
    const resp = await axios.get(`${base}/rest/ping.view`, {
      params: { u: username, t: token, s: salt, v: '1.16.1', c: SUBSONIC_CLIENT, f: 'json' },
      paramsSerializer: { indexes: null },
      timeout: 15000,
    });
    const data = resp.data?.['subsonic-response'];
    const ok = data?.status === 'ok';
    return {
      ok,
      type: typeof data?.type === 'string' ? data.type : undefined,
      serverVersion: typeof data?.serverVersion === 'string' ? data.serverVersion : undefined,
      openSubsonic: data?.openSubsonic === true,
    };
  } catch (err) {
    console.warn('[psysonic] pingWithCredentials failed:', serverUrl, err);
    return { ok: false };
  }
}

/** Profile-aware ping for connect probe — attaches custom headers per endpoint. */
export async function pingWithCredentialsForProfile(
  profile: Pick<
    ServerProfile,
    'url' | 'alternateUrl' | 'username' | 'password' | 'customHeaders' | 'customHeadersApplyTo'
  >,
  endpointBaseUrl: string,
): Promise<PingWithCredentialsResult> {
  try {
    const base = endpointBaseUrl.startsWith('http')
      ? endpointBaseUrl.replace(/\/$/, '')
      : `http://${endpointBaseUrl.replace(/\/$/, '')}`;
    const salt = secureRandomSalt();
    const token = md5(profile.password + salt);
    const resp = await axios.get(`${base}/rest/ping.view`, {
      params: {
        u: profile.username,
        t: token,
        s: salt,
        v: '1.16.1',
        c: SUBSONIC_CLIENT,
        f: 'json',
      },
      headers: headersForServerRequest(profile, endpointBaseUrl),
      paramsSerializer: { indexes: null },
      timeout: 15000,
    });
    const data = resp.data?.['subsonic-response'];
    const ok = data?.status === 'ok';
    return {
      ok,
      type: typeof data?.type === 'string' ? data.type : undefined,
      serverVersion: typeof data?.serverVersion === 'string' ? data.serverVersion : undefined,
      openSubsonic: data?.openSubsonic === true,
    };
  } catch (err) {
    console.warn('[psysonic] pingWithCredentialsForProfile failed:', endpointBaseUrl, err);
    return { ok: false };
  }
}

const INSTANT_MIX_PROBE_RANDOM_SIZE = 8;
const INSTANT_MIX_PROBE_SIMILAR_COUNT = 12;
const INSTANT_MIX_PROBE_MAX_TRACKS = 4;

/**
 * Probes whether `getSimilarSongs` returns any tracks (Instant Mix / Navidrome agent chain).
 * Does not pass `musicFolderId` — probes the whole library as seen by the account.
 * Note: if `ND_AGENTS` includes Last.fm, a positive result does not prove AudioMuse alone.
 */
export async function probeInstantMixWithCredentials(
  serverUrl: string,
  username: string,
  password: string,
  headerProfile?: ServerHttpHeaderProfile,
): Promise<InstantMixProbeResult> {
  try {
    const data = await apiWithCredentials<{ randomSongs: { song: SubsonicSong | SubsonicSong[] } }>(
      serverUrl,
      username,
      password,
      'getRandomSongs.view',
      { size: INSTANT_MIX_PROBE_RANDOM_SIZE, _t: Date.now() },
      12000,
      headerProfile,
    );
    const raw = data.randomSongs?.song;
    const songs: SubsonicSong[] = !raw ? [] : Array.isArray(raw) ? raw : [raw];
    if (songs.length === 0) return 'skipped';

    let anyError = false;
    for (const song of songs.slice(0, INSTANT_MIX_PROBE_MAX_TRACKS)) {
      try {
        const simData = await apiWithCredentials<{ similarSongs: { song: SubsonicSong | SubsonicSong[] } }>(
          serverUrl,
          username,
          password,
          'getSimilarSongs.view',
          { id: song.id, count: INSTANT_MIX_PROBE_SIMILAR_COUNT },
          12000,
          headerProfile,
        );
        const sRaw = simData.similarSongs?.song;
        const list: SubsonicSong[] = !sRaw ? [] : Array.isArray(sRaw) ? sRaw : [sRaw];
        if (list.some(s => s.id !== song.id)) return 'ok';
      } catch {
        anyError = true;
      }
    }
    return anyError ? 'error' : 'empty';
  } catch {
    return 'error';
  }
}

/**
 * After a successful ping, run the server-capability probes needed by the catalog
 * (`serverCapabilities/`). Which probes run is decided by the strategies eligible
 * for this server generation — not by inline version checks here.
 *
 * Currently: Navidrome ≥ 0.62 → `getOpenSubsonicExtensions` (sonicSimilarity);
 * Navidrome 0.60–0.61 → legacy `getSimilarSongs` Instant Mix probe.
 *
 * Idempotent: a server's advertised capabilities are static within a session, so
 * once a definitive result is cached the probe is skipped. This is called on every
 * 120 s connection poll, so re-fetching each time would be wasteful and would flip
 * the resolved status (and the routed endpoint) through a `probing` window. Pass
 * `force` for user-initiated refreshes (add/edit/test server); a server version or
 * type change clears the cache (see `setSubsonicServerIdentity`), forcing a re-probe.
 */
export function scheduleInstantMixProbeForServer(
  serverId: string,
  serverUrl: string,
  username: string,
  password: string,
  identity: SubsonicServerIdentity,
  force = false,
): void {
  const ctx = buildCapabilityContext(identity);
  const probeIds = neededProbeIds(SERVER_CAPABILITY_CATALOG, ctx);
  const store = useAuthStore.getState();
  const headerProfile = findServerByIdOrIndexKey(serverId);

  if (probeIds.has(PROBE_OPENSUBSONIC_EXTENSIONS)) {
    // One `getOpenSubsonicExtensions` fetch answers every extension-gated feature.
    // The AudioMuse `sonicSimilarity` lifecycle (with its opt-in side effects) is
    // only driven on Navidrome ≥ 0.62, so broadening the probe to all OpenSubsonic
    // servers for `playbackReport` does not disturb the legacy Instant Mix opt-in.
    const audiomuseEligible = ctx.isNavidrome && ctx.semverGte([0, 62, 0]);
    const cached = store.audiomusePluginProbeByServer[serverId];
    const listMissing = store.openSubsonicExtensionsByServer[serverId] === undefined;
    // Re-probe without a definitive cached result, on force / prior error, or when
    // the extension list is missing (self-heal for state persisted before it was
    // captured). `probing` means an in-flight fetch — skip to avoid a duplicate.
    const audiomuseStale = audiomuseEligible && (cached === undefined || cached === 'error');
    if (force || listMissing || audiomuseStale) {
      if (audiomuseEligible) store.setAudiomusePluginProbe(serverId, 'probing');
      void fetchOpenSubsonicExtensionsWithCredentials(
        serverUrl,
        username,
        password,
        headerProfile,
      ).then(extensions => {
        const st = useAuthStore.getState();
        if (extensions === null) {
          if (audiomuseEligible) st.setAudiomusePluginProbe(serverId, 'error');
          return;
        }
        st.setOpenSubsonicExtensions(serverId, extensions);
        if (audiomuseEligible) {
          st.setAudiomusePluginProbe(serverId, extensions.includes(SONIC_SIMILARITY_EXTENSION) ? 'present' : 'absent');
        }
      });
    }
  }

  if (probeIds.has(PROBE_LEGACY_INSTANT_MIX)) {
    const cached = store.instantMixProbeByServer[serverId];
    if (force || cached === undefined || cached === 'error') {
      void probeInstantMixWithCredentials(serverUrl, username, password, headerProfile).then(result =>
        useAuthStore.getState().setInstantMixProbe(serverId, result),
      );
    }
  }
}

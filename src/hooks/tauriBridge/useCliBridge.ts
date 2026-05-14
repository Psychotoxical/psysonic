import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { NavigateFunction } from 'react-router-dom';
import { getSimilarSongs } from '../../api/subsonicArtists';
import { getMusicFolders } from '../../api/subsonicLibrary';
import { search as subsonicSearch } from '../../api/subsonicSearch';
import { shuffleArray } from '../../utils/shuffleArray';
import { songToTrack } from '../../utils/songToTrack';
import { showToast } from '../../utils/toast';
import { switchActiveServer } from '../../utils/switchActiveServer';
import i18n from '../../i18n';
import { usePlayerStore } from '../../store/playerStore';
import { useAuthStore } from '../../store/authStore';
import { executeCliPlayerCommand } from '../../config/shortcutActions';

/** The full `cli:*` listener surface forwarded from the Rust single-instance
 * handler: audio-device, instant-mix, library / server resolution, search and
 * player commands. */
export function useCliBridge(navigate: NavigateFunction) {
  // CLI: `--player audio-device set …` (forwarded on Linux via single-instance).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('cli:audio-device-set', async e => {
      const raw = typeof e.payload === 'string' ? e.payload : '';
      const deviceName = raw.length > 0 ? raw : null;
      try {
        await invoke('audio_set_device', { deviceName });
        useAuthStore.getState().setAudioOutputDevice(deviceName);
      } catch {
        /* device open failed — do not persist (same as Settings) */
      }
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // CLI: `--player mix append|new` from the currently playing track.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('cli:instant-mix', async e => {
      const mode = e.payload === 'append' ? 'append' : 'new';
      const state = usePlayerStore.getState();
      const song = state.currentTrack;
      if (!song) {
        showToast(i18n.t('contextMenu.cliMixNeedsTrack'), 5000, 'error');
        return;
      }
      const serverId = useAuthStore.getState().activeServerId;
      try {
        const similar = await getSimilarSongs(song.id, 50);
        if (serverId) useAuthStore.getState().setAudiomuseNavidromeIssue(serverId, false);
        const base = similar.filter(s => s.id !== song.id).map(s => songToTrack(s));
        if (mode === 'append') {
          const toAdd = shuffleArray(base.map(t => ({ ...t, autoAdded: true as const })));
          if (toAdd.length > 0) usePlayerStore.getState().enqueue(toAdd);
        } else {
          // New queue from seed: collapse to [song] first, then radio tail (not append onto old queue).
          usePlayerStore.getState().reseedQueueForInstantMix(song);
          const shuffled = shuffleArray(
            base.map(t => ({ ...t, radioAdded: true as const })),
          );
          if (shuffled.length > 0) {
            const aid = song.artistId?.trim() || undefined;
            usePlayerStore.getState().enqueueRadio(shuffled, aid);
          }
        }
      } catch (err) {
        console.error('CLI instant mix failed', err);
        if (serverId) useAuthStore.getState().setAudiomuseNavidromeIssue(serverId, true);
        showToast(i18n.t('contextMenu.instantMixFailed'), 5000, 'error');
      }
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // CLI: `--player library list` (Rust polls the JSON file) / `library set`.
  useEffect(() => {
    let u1: (() => void) | undefined;
    let u2: (() => void) | undefined;
    listen('cli:library-list', async () => {
      try {
        const folders = await getMusicFolders();
        const auth = useAuthStore.getState();
        const sid = auth.activeServerId;
        const selected = sid ? (auth.musicLibraryFilterByServer[sid] ?? 'all') : 'all';
        await invoke('cli_publish_library_list', {
          payload: {
            folders: folders.map(f => ({ id: f.id, name: f.name })),
            selected,
            active_server_id: sid,
          },
        });
      } catch (e) {
        console.error('CLI library list failed', e);
        await invoke('cli_publish_library_list', {
          payload: { folders: [], selected: 'all', active_server_id: null },
        }).catch(() => {});
      }
    }).then(u => { u1 = u; });
    listen<string>('cli:library-set', e => {
      const raw = typeof e.payload === 'string' ? e.payload : '';
      if (raw === 'all') useAuthStore.getState().setMusicLibraryFilter('all');
      else if (raw.length > 0) useAuthStore.getState().setMusicLibraryFilter(raw);
    }).then(u => { u2 = u; });
    return () => {
      u1?.();
      u2?.();
    };
  }, []);

  // CLI: servers, search, transport extras, mute, star, rating, play-by-id, reload.
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    listen('cli:server-list', async () => {
      const auth = useAuthStore.getState();
      await invoke('cli_publish_server_list', {
        payload: {
          active_server_id: auth.activeServerId,
          servers: auth.servers.map(s => ({ id: s.id, name: s.name })),
        },
      });
    }).then(u => unsubs.push(u));
    listen<string>('cli:server-set', async e => {
      const raw = typeof e.payload === 'string' ? e.payload : '';
      const id = raw.trim();
      if (!id) return;
      const server = useAuthStore.getState().servers.find(s => s.id === id);
      if (!server) {
        showToast(i18n.t('contextMenu.cliServerNotFound', { defaultValue: 'Server id not found.' }), 4000, 'error');
        return;
      }
      const ok = await switchActiveServer(server);
      if (!ok) {
        showToast(i18n.t('contextMenu.cliServerSwitchFailed', { defaultValue: 'Could not switch server (ping failed).' }), 5000, 'error');
      }
    }).then(u => unsubs.push(u));
    listen<{ scope: string; query: string }>('cli:search', async e => {
      const { scope, query } = e.payload;
      const base = { scope, query, ready: false };
      try {
        const r = await subsonicSearch(query, { songCount: 50, albumCount: 30, artistCount: 30 });
        const payload =
          scope === 'track'
            ? {
                ...base,
                songs: r.songs.map(s => ({ id: s.id, title: s.title, artist: s.artist })),
                albums: [] as { id: string; name: string; artist: string }[],
                artists: [] as { id: string; name: string }[],
                ready: true,
              }
            : scope === 'album'
              ? {
                  ...base,
                  songs: [] as { id: string; title: string; artist: string }[],
                  albums: r.albums.map(a => ({ id: a.id, name: a.name, artist: a.artist })),
                  artists: [] as { id: string; name: string }[],
                  ready: true,
                }
              : {
                  ...base,
                  songs: [] as { id: string; title: string; artist: string }[],
                  albums: [] as { id: string; name: string; artist: string }[],
                  artists: r.artists.map(a => ({ id: a.id, name: a.name })),
                  ready: true,
                };
        await invoke('cli_publish_search_results', { payload });
      } catch (err) {
        console.error('CLI search failed', err);
        await invoke('cli_publish_search_results', {
          payload: {
            ...base,
            songs: [],
            albums: [],
            artists: [],
            ready: true,
            error: err instanceof Error ? err.message : 'search failed',
          },
        }).catch(() => {});
      }
    }).then(u => unsubs.push(u));
    listen<any>('cli:player-command', async e => {
      await executeCliPlayerCommand({ payload: e.payload ?? {}, navigate });
    }).then(u => unsubs.push(u));
    return () => {
      unsubs.forEach(u => u());
    };
  }, []);
}

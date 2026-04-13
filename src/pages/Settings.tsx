import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { version as appVersion } from '../../package.json';
import changelogRaw from '../../CHANGELOG.md?raw';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Wifi, WifiOff, Globe, Music2, Sliders, LogOut, CheckCircle2, FolderOpen,
  Palette, Server, Plus, Trash2, Eye, EyeOff, Info, ExternalLink, Shuffle, X, Play, Type, Keyboard, ChevronDown,
  GripVertical, PanelLeft, RotateCcw, LayoutGrid, AppWindow, HardDrive, Upload, Download, Waves, Star, Clock, ZoomIn, Sparkles, AlertTriangle, Maximize2, AudioLines
} from 'lucide-react';
import i18n from '../i18n';
import { exportBackup, importBackup } from '../utils/backup';
import { showToast } from '../utils/toast';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { getImageCacheSize, clearImageCache } from '../utils/imageCache';
import { useOfflineStore } from '../store/offlineStore';
import { useHotCacheStore } from '../store/hotCacheStore';
import { lastfmGetToken, lastfmAuthUrl, lastfmGetSession, lastfmGetUserInfo, LastfmUserInfo } from '../api/lastfm';
import LastfmIcon from '../components/LastfmIcon';
import CustomSelect from '../components/CustomSelect';
import ThemePicker, { THEME_GROUPS } from '../components/ThemePicker';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStore, ServerProfile, MIX_MIN_RATING_FILTER_MAX_STARS, type SeekbarStyle, type LyricsSourceId, type LyricsSourceConfig } from '../store/authStore';
import { SeekbarPreview } from '../components/WaveformSeek';
import { IS_LINUX } from '../utils/platform';
import { useThemeStore } from '../store/themeStore';
import { useFontStore, FontId } from '../store/fontStore';
import { useKeybindingsStore, KeyAction, formatBinding, buildInAppBinding } from '../store/keybindingsStore';
import { useGlobalShortcutsStore, GlobalAction, buildGlobalShortcut, formatGlobalShortcut } from '../store/globalShortcutsStore';
import { useSidebarStore, DEFAULT_SIDEBAR_ITEMS, SidebarItemConfig } from '../store/sidebarStore';
import { useHomeStore, HomeSectionId } from '../store/homeStore';
import { useDragDrop, useDragSource } from '../contexts/DragDropContext';
import { ALL_NAV_ITEMS } from '../components/Sidebar';
import { pingWithCredentials, scheduleInstantMixProbeForServer } from '../api/subsonic';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Trans, useTranslation } from 'react-i18next';
import Equalizer from '../components/Equalizer';
import StarRating from '../components/StarRating';
import { showAudiomuseNavidromeServerSetting } from '../utils/subsonicServerIdentity';

const AUDIOBOOK_GENRES_DISPLAY = ['Hörbuch', 'Hoerbuch', 'Hörspiel', 'Hoerspiel', 'Audiobook', 'Audio Book', 'Spoken Word', 'Spokenword', 'Podcast', 'Kapitel', 'Thriller', 'Krimi', 'Speech', 'Fantasy', 'Comedy', 'Literature'];

const AUDIOMUSE_NV_PLUGIN_URL = 'https://github.com/NeptuneHub/AudioMuse-AI-NV-plugin';

const CONTRIBUTORS = [
  {
    github: 'jiezhuo',
    since: '1.21',
    contributions: [
      'Chinese (Simplified) translation',
    ],
  },
  {
    github: 'nullobject',
    since: '1.22.0',
    contributions: [
      'Seek debounce & race condition fix (PR #7)',
      'Waveform seekbar stability on position update (PR #8)',
    ],
  },
  {
    github: 'trbn1',
    since: '1.22.0',
    contributions: [
      'Replay Gain metadata propagation (PR #9)',
      'songToTrack() — unified track construction across all sources',
    ],
  },
  {
    github: 'nisarg-78',
    since: '1.29.0',
    contributions: [
      'Click-to-seek in synced lyrics (PR #38)',
      'Volume scroll wheel on volume slider (PR #38)',
      'Lyrics line visual states: active / completed / upcoming (PR #38)',
      'Queue auto-scroll to keep upcoming tracks in view; fixed re-renders from currentTime in QueuePanel (PR #115)',
    ],
  },
  {
    github: 'JulianNymark',
    since: '1.29.0',
    contributions: [
      'OGG/Vorbis container support via symphonia-format-ogg (PR #42)',
      'Themed toast notifications for audio playback errors (PR #43)',
      'Human-readable audio error messages (PR #44)',
    ],
  },
  {
    github: 'zz5zz',
    since: '1.32.0',
    contributions: [
      'Norwegian (Bokmål) translation (PR #101)',
    ],
  },
  {
    github: 'cucadmuh',
    since: '1.33.0',
    contributions: [
      'Russian translation & i18n locale split (PR #106)',
      'Russian locale refinements using phrasing from ru2 (PR #113)',
      'Gapless manual skip: honor user-initiated play over pre-chained track (PR #119)',
      'Hot playback cache — queue prefetch (PR #123)',
      'Per-server music folder filter and sidebar library picker (PR #124, PR #125)',
      'Richer star ratings, skip threshold, and library filtering (PR #130)',
      'Statistics: scope album and song totals to selected music library (PR #138)',
      'AudioMuse-AI discovery integration for Navidrome (PR #147)',
      'Hot playback cache — eviction budgeting, grace period, and live Audio settings readout (PR #153)',
      'Folder Browser: keyboard navigation, context menus, now-playing path emphasis, and adaptive column layout (PR #158)',
      'Infinite queue: artist-driven candidates via Top Songs + Similar Songs with random fallback (PR #163)',
      'Folder Browser: per-column filter with keyboard flow and Shift+Enter queue append (PR #165)',
      'Keybindings: modifier + key chords for in-app shortcuts; fixed seek ±10s units (PR #167)',
      'Statistics: genre insights scoped to music library, cached Subsonic fetches, localized duration formatting (PR #144)',
      'Audio output device picker: clearer ALSA labels, duplicate disambiguation, system-default mark, live refresh (PR #173)',
      'Folder Browser: arrow navigation blocked when modifier keys are held (PR #174)',
    ],
  },
  {
    github: 'kilyabin',
    since: '1.34.0',
    contributions: [
      'Russian locale improvements (PR #107, PR #120)',
      'Auto-install script for Debian / RHEL (PR #121)',
      'Album cover art in Discord Rich Presence via iTunes API (PR #111)',
      'Tiling WM detection: hide custom TitleBar on Hyprland/Sway/i3/etc. (PR #134)',
      'Russian translation: lyricsServerFirst settings strings (PR #140)',
      'Russian translation refinements (PR #148)',
      'Merge Random Mix & Albums into a single Build a Mix hub (PR #155)',
      'Fullscreen player: software-rendering performance fixes + portrait toggle & dimming setting (PR #156)',
      'Fullscreen player: stop mesh blob and portrait animations in no-compositing mode; remove seekbar box-shadow repaint (PR #175)',
    ],
  },
  {
    github: 'kveld9',
    since: '1.34.4',
    contributions: [
      'Spanish (es) translation — 964 strings (PR #159)',
      'Column-header sorting for albums & playlists (PR #160)',
      'Multi-select for albums, artists & playlists with bulk "Add to Playlist"; collapsible sidebar playlist section; infinite scroll on Artists page; "Remove from Playlist" in context menu (PR #168)',
    ],
  },
  {
    github: 'nisrael',
    since: '1.34.0',
    contributions: [
      'Nightfox.nvim theme group in Open Source Classics (PR #114)',
      'Switch reqwest to rustls-tls for cross-platform TLS (PR #112)',
      'ICY stream metadata & AzuraCast Now Playing support (PR #146)',
    ],
  },
] as const;

const SPECIAL_THANKS = [
  {
    github: 'netherguy4',
    reason: 'Countless constructive feature ideas and thoughtful feedback',
  },
] as const;

type Tab = 'general' | 'server' | 'audio' | 'storage' | 'appearance' | 'input' | 'system';

function AddServerForm({ onSave, onCancel }: { onSave: (data: Omit<ServerProfile, 'id'>) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', url: '', username: '', password: '' });
  const [showPass, setShowPass] = useState(false);

  const update = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div className="settings-card" style={{ marginTop: '1rem' }}>
      <h3 style={{ fontWeight: 600, marginBottom: '1rem', fontSize: '14px' }}>{t('settings.addServerTitle')}</h3>
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <label style={{ fontSize: 13 }}>{t('settings.serverName')}</label>
        <input className="input" type="text" value={form.name} onChange={update('name')} placeholder="My Navidrome" autoComplete="off" />
      </div>
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <label style={{ fontSize: 13 }}>{t('settings.serverUrl')}</label>
        <input className="input" type="text" value={form.url} onChange={update('url')} placeholder={t('settings.serverUrlPlaceholder')} autoComplete="off" />
      </div>
      <div className="form-row" style={{ marginBottom: '0.75rem' }}>
        <div className="form-group">
          <label style={{ fontSize: 13 }}>{t('settings.serverUsername')}</label>
          <input className="input" type="text" value={form.username} onChange={update('username')} placeholder="admin" autoComplete="off" />
        </div>
        <div className="form-group">
          <label style={{ fontSize: 13 }}>{t('settings.serverPassword')}</label>
          <div style={{ position: 'relative' }}>
            <input
              className="input"
              type={showPass ? 'text' : 'password'}
              value={form.password}
              onChange={update('password')}
              placeholder="••••••••"
              style={{ paddingRight: '2.5rem' }}
            />
            <button
              type="button"
              style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}
              onClick={() => setShowPass(v => !v)}
            >
              {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onCancel}>{t('common.cancel')}</button>
        <button
          className="btn btn-primary"
          onClick={() => form.url.trim() && onSave({ name: form.name.trim() || form.url.trim(), url: form.url.trim(), username: form.username.trim(), password: form.password })}
        >
          {t('common.add')}
        </button>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Align hot-cache size slider (step 32 MB) to valid values. */
function snapHotCacheMb(v: number): number {
  const x = Math.min(20000, Math.max(32, Math.round(v)));
  return Math.round((x - 32) / 32) * 32 + 32;
}

/** Makes raw ALSA device names more readable on Linux.
 *  Values are kept as-is (rodio needs the ALSA name); only the displayed label is cleaned.
 *  e.g. "sysdefault:CARD=U192k" → "U192k"
 *       "hw:CARD=U192k,DEV=0"   → "U192k (hw · PCM 0)"
 *       "hdmi:CARD=NVidia,DEV=1" → "NVidia (HDMI · DEV 1)"  (same DEV as in ALSA string)
 *       "iec958:CARD=PCH,DEV=0" → "PCH (S/PDIF)"
 *  Names without ALSA prefix (pipewire, pulse, default…) are returned unchanged. */
function formatAudioDeviceLabel(name: string): string {
  const cardMatch = name.match(/CARD=([^,]+)/);
  if (!cardMatch) return name;
  const card = cardMatch[1];
  const devM = name.match(/DEV=(\d+)/);
  const devNum = devM ? parseInt(devM[1], 10) : null;
  const subM = name.match(/SUBDEV=(\d+)/);
  const subNum = subM ? parseInt(subM[1], 10) : null;

  if (name.startsWith('iec958:')) return `${card} (S/PDIF)`;
  if (name.startsWith('hdmi:')) {
    const d = devNum !== null ? devNum : 0;
    return `${card} (HDMI · DEV ${d})`;
  }
  if (name.startsWith('sysdefault:')) {
    if (devNum !== null && devNum > 0) return `${card} (default · PCM ${devNum})`;
    return card;
  }
  if (name.startsWith('plughw:')) {
    if (devNum !== null) {
      const sub = subNum !== null ? ` · sub ${subNum}` : '';
      return `${card} (plug · PCM ${devNum}${sub})`;
    }
    return card;
  }
  if (name.startsWith('hw:')) {
    if (devNum !== null) {
      const sub = subNum !== null ? ` · sub ${subNum}` : '';
      return `${card} (hw · PCM ${devNum}${sub})`;
    }
    return `${card} (hw)`;
  }
  if (name.startsWith('front:')) return `${card} (Front)`;
  if (name.startsWith('surround')) return `${card} (${name.split(':')[0]})`;
  // Other ALSA iface:card,dev — show plugin + PCM so identical cards differ
  const iface = name.split(':')[0];
  if (iface && !['default', 'pulse', 'pipewire'].includes(iface)) {
    if (devNum !== null) return `${card} (${iface} · PCM ${devNum})`;
    return `${card} (${iface})`;
  }
  return card;
}

/** Readable tail when two devices still share the same label (rare after formatAudioDeviceLabel). */
function audioDeviceDuplicateHint(raw: string): string {
  const cardM = raw.match(/CARD=([^,]+)/);
  const devM = raw.match(/DEV=(\d+)/);
  const subM = raw.match(/SUBDEV=(\d+)/);
  const iface = raw.split(':')[0] || '';
  const parts: string[] = [];
  if (iface) parts.push(iface);
  if (cardM) parts.push(cardM[1]);
  if (devM) parts.push(`PCM ${devM[1]}`);
  if (subM) parts.push(`sub ${subM[1]}`);
  if (parts.length > 1) return parts.join(' · ');
  return raw.length > 56 ? `…${raw.slice(-53)}` : raw;
}

/** When several devices share the same display label, append a disambiguator. */
function disambiguatedAudioDeviceLabel(raw: string, baseLabel: string, duplicateBase: boolean): string {
  if (!duplicateBase) return baseLabel;
  return `${baseLabel} · ${audioDeviceDuplicateHint(raw)}`;
}

/** cpal order is arbitrary; sort by readable label, current OS default first. */
function sortAudioDeviceIds(devices: string[], osDefaultDeviceId: string | null): string[] {
  return [...devices].sort((a, b) => {
    const aDef = osDefaultDeviceId && a === osDefaultDeviceId;
    const bDef = osDefaultDeviceId && b === osDefaultDeviceId;
    if (aDef !== bDef) return aDef ? -1 : 1;
    const la = formatAudioDeviceLabel(a);
    const lb = formatAudioDeviceLabel(b);
    const byLabel = la.localeCompare(lb, undefined, { sensitivity: 'base' });
    if (byLabel !== 0) return byLabel;
    return a.localeCompare(b);
  });
}

function buildAudioDeviceSelectOptions(
  devices: string[],
  defaultLabel: string,
  osDefaultDeviceId: string | null,
  osDefaultMark: string,
  pinnedDevice: string | null,
  notInListSuffix: string,
): { value: string; label: string }[] {
  const baseLabels = devices.map(formatAudioDeviceLabel);
  const countByBase = new Map<string, number>();
  for (const b of baseLabels) countByBase.set(b, (countByBase.get(b) ?? 0) + 1);
  const pinned = pinnedDevice?.trim() || null;
  const pinnedNotListed = !!(pinned && !devices.includes(pinned));
  const ghost: { value: string; label: string }[] = pinnedNotListed
    ? (() => {
        const base = formatAudioDeviceLabel(pinned);
        let label = `${base} · ${notInListSuffix}`;
        if (osDefaultDeviceId && pinned === osDefaultDeviceId) label = `${label} · ${osDefaultMark}`;
        return [{ value: pinned, label }];
      })()
    : [];
  return [
    { value: '', label: defaultLabel },
    ...ghost,
    ...devices.map((d, i) => {
      const base = baseLabels[i];
      const dup = (countByBase.get(base) ?? 0) > 1;
      let label = disambiguatedAudioDeviceLabel(d, base, dup);
      if (osDefaultDeviceId && d === osDefaultDeviceId) label = `${label} · ${osDefaultMark}`;
      return { value: d, label };
    }),
  ];
}

export default function Settings() {
  const auth = useAuthStore();
  const theme = useThemeStore();
  const fontStore = useFontStore();
  const kb = useKeybindingsStore();
  const gs = useGlobalShortcutsStore();
  const serverId = auth.activeServerId ?? '';
  const clearAllOffline = useOfflineStore(s => s.clearAll);
  const clearHotCacheDisk = useHotCacheStore(s => s.clearAllDisk);
  const hotCacheEntries = useHotCacheStore(s => s.entries);
  const [isTilingWm, setIsTilingWm] = useState(false);

  useEffect(() => {
    if (!IS_LINUX) return;
    invoke<boolean>('is_tiling_wm_cmd').then(setIsTilingWm).catch(() => {});
  }, []);

  const hotCacheTrackCount = useMemo(() => {
    if (!serverId) return 0;
    const prefix = `${serverId}:`;
    return Object.keys(hotCacheEntries).filter(k => k.startsWith(prefix)).length;
  }, [hotCacheEntries, serverId]);
  const [listeningFor, setListeningFor] = useState<KeyAction | null>(null);
  const [listeningForGlobal, setListeningForGlobal] = useState<GlobalAction | null>(null);
  const navigate = useNavigate();
  const { state: routeState } = useLocation();
  const { t, i18n } = useTranslation();

  const [activeTab, setActiveTab] = useState<Tab>((routeState as { tab?: Tab } | null)?.tab ?? 'general');
  const [connStatus, setConnStatus] = useState<Record<string, 'idle' | 'testing' | 'ok' | 'error'>>({});
  const [showAddForm, setShowAddForm] = useState(false);
  const [newGenre, setNewGenre] = useState('');
  const [lfmState, setLfmState] = useState<'idle' | 'waiting' | 'error'>('idle');
  const [lfmPendingToken, setLfmPendingToken] = useState<string | null>(null);
  const [lfmError, setLfmError] = useState<string | null>(null);
  const [lfmUserInfo, setLfmUserInfo] = useState<LastfmUserInfo | null>(null);
  const [imageCacheBytes, setImageCacheBytes] = useState<number | null>(null);
  const [offlineCacheBytes, setOfflineCacheBytes] = useState<number | null>(null);
  const [hotCacheBytes, setHotCacheBytes] = useState<number | null>(null);
  const [audioDevices, setAudioDevices] = useState<string[]>([]);
  const [osDefaultAudioDeviceId, setOsDefaultAudioDeviceId] = useState<string | null>(null);
  const [deviceSwitching, setDeviceSwitching] = useState(false);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [contributorsOpen, setContributorsOpen] = useState(false);

  useEffect(() => {
    if (!auth.lastfmSessionKey || !auth.lastfmUsername) { setLfmUserInfo(null); return; }
    lastfmGetUserInfo(auth.lastfmUsername, auth.lastfmSessionKey).then(setLfmUserInfo).catch(() => {});
  }, [auth.lastfmSessionKey, auth.lastfmUsername]);

  useEffect(() => {
    if (activeTab !== 'storage') return;
    getImageCacheSize().then(setImageCacheBytes);
    invoke<number>('get_offline_cache_size', { customDir: auth.offlineDownloadDir || null }).then(setOfflineCacheBytes).catch(() => setOfflineCacheBytes(0));
    invoke<number>('get_hot_cache_size', { customDir: auth.hotCacheDownloadDir || null }).then(setHotCacheBytes).catch(() => setHotCacheBytes(0));
  }, [activeTab, auth.offlineDownloadDir, auth.hotCacheDownloadDir]);

  const refreshAudioDevices = useCallback((opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    if (!silent) setDevicesLoading(true);
    const listP = invoke<string[]>('audio_list_devices').catch((e) => {
      console.error(e);
      showToast(t('settings.audioOutputDeviceListError'), 5000, 'error');
      return [] as string[];
    });
    const defP = invoke<string | null>('audio_default_output_device_name').catch(() => null);
    Promise.all([listP, defP])
      .then(async ([devices, osDefault]) => {
        let canon: string | null = null;
        try {
          canon = await invoke<string | null>('audio_canonicalize_selected_device');
          if (canon) useAuthStore.getState().setAudioOutputDevice(canon);
        } catch {
          /* ignore */
        }
        const finalList = canon
          ? await invoke<string[]>('audio_list_devices').catch(() => devices)
          : devices;
        const defId = osDefault ?? null;
        setAudioDevices(sortAudioDeviceIds(finalList, defId));
        setOsDefaultAudioDeviceId(defId);
      })
      .finally(() => {
        if (!silent) setDevicesLoading(false);
      });
  }, [t]);

  // Load available audio output devices when Audio tab opens.
  useEffect(() => {
    if (activeTab !== 'audio') return;
    refreshAudioDevices();
  }, [activeTab, refreshAudioDevices]);

  // Keep device list + "current system output" mark in sync when the backend reopens the stream.
  useEffect(() => {
    if (activeTab !== 'audio') return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    (async () => {
      for (const ev of ['audio:device-changed', 'audio:device-reset'] as const) {
        const u = await listen(ev, () => {
          if (!cancelled) refreshAudioDevices({ silent: true });
        });
        if (cancelled) {
          u();
          return;
        }
        unlisteners.push(u);
      }
    })();
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, [activeTab, refreshAudioDevices]);

  /** Live disk usage for hot cache while Audio settings are open (interval + refresh when index changes). */
  useEffect(() => {
    if (activeTab !== 'audio') return;
    const customDir = auth.hotCacheDownloadDir || null;
    const refresh = () => {
      invoke<number>('get_hot_cache_size', { customDir })
        .then(setHotCacheBytes)
        .catch(() => setHotCacheBytes(0));
    };
    refresh();
    if (!auth.hotCacheEnabled) return;
    const interval = window.setInterval(refresh, 2000);
    return () => window.clearInterval(interval);
  }, [activeTab, auth.hotCacheEnabled, auth.hotCacheDownloadDir]);

  useEffect(() => {
    if (activeTab !== 'audio' || !auth.hotCacheEnabled) return;
    const t = window.setTimeout(() => {
      invoke<number>('get_hot_cache_size', { customDir: auth.hotCacheDownloadDir || null })
        .then(setHotCacheBytes)
        .catch(() => setHotCacheBytes(0));
    }, 400);
    return () => window.clearTimeout(t);
  }, [hotCacheEntries, activeTab, auth.hotCacheEnabled, auth.hotCacheDownloadDir]);

  const handleClearCache = useCallback(async () => {
    setClearing(true);
    await clearImageCache();
    await clearAllOffline(serverId);
    const [imgBytes, offBytes] = await Promise.all([
      getImageCacheSize(),
      invoke<number>('get_offline_cache_size', { customDir: auth.offlineDownloadDir || null }).catch(() => 0),
    ]);
    setImageCacheBytes(imgBytes);
    setOfflineCacheBytes(offBytes);
    setShowClearConfirm(false);
    setClearing(false);
  }, [clearAllOffline, serverId]);

  const startLastfmConnect = useCallback(async () => {
    setLfmError(null);
    let token: string;
    try {
      token = await lastfmGetToken();
      setLfmPendingToken(token);
      setLfmState('waiting');
      await openUrl(lastfmAuthUrl(token));
    } catch (e: any) {
      setLfmError(e.message ?? 'Unknown error');
      setLfmState('error');
      return;
    }

    // Poll every 2 s until the user authorises or we time out (2 min)
    const deadline = Date.now() + 120_000;
    const poll = async () => {
      if (Date.now() > deadline) {
        setLfmState('error');
        setLfmError('Timed out — please try again.');
        setLfmPendingToken(null);
        return;
      }
      try {
        const { key, name } = await lastfmGetSession(token);
        auth.connectLastfm(key, name);
        setLfmState('idle');
        setLfmPendingToken(null);
      } catch (e: any) {
        // Error 14 = not yet authorised, keep polling
        if (e.message?.includes('14')) {
          setTimeout(poll, 2000);
        } else {
          setLfmState('error');
          setLfmError(e.message ?? 'Unknown error');
          setLfmPendingToken(null);
        }
      }
    };
    setTimeout(poll, 2000);
  }, [auth]);

  const testConnection = async (server: ServerProfile) => {
    setConnStatus(s => ({ ...s, [server.id]: 'testing' }));
    try {
      const ping = await pingWithCredentials(server.url, server.username, server.password);
      if (ping.ok) {
        const identity = {
          type: ping.type,
          serverVersion: ping.serverVersion,
          openSubsonic: ping.openSubsonic,
        };
        auth.setSubsonicServerIdentity(server.id, identity);
        scheduleInstantMixProbeForServer(server.id, server.url, server.username, server.password, identity);
      }
      setConnStatus(s => ({ ...s, [server.id]: ping.ok ? 'ok' : 'error' }));
    } catch {
      setConnStatus(s => ({ ...s, [server.id]: 'error' }));
    }
  };

  const switchToServer = async (server: ServerProfile) => {
    setConnStatus(s => ({ ...s, [server.id]: 'testing' }));
    try {
      const ping = await pingWithCredentials(server.url, server.username, server.password);
      if (ping.ok) {
        const identity = {
          type: ping.type,
          serverVersion: ping.serverVersion,
          openSubsonic: ping.openSubsonic,
        };
        auth.setSubsonicServerIdentity(server.id, identity);
        scheduleInstantMixProbeForServer(server.id, server.url, server.username, server.password, identity);
        auth.setActiveServer(server.id);
        auth.setLoggedIn(true);
        navigate('/');
      } else {
        setConnStatus(s => ({ ...s, [server.id]: 'error' }));
      }
    } catch {
      setConnStatus(s => ({ ...s, [server.id]: 'error' }));
    }
  };

  const deleteServer = (server: ServerProfile) => {
    if (confirm(t('settings.confirmDeleteServer', { name: server.name || server.url }))) {
      auth.removeServer(server.id);
    }
  };

  const handleAddServer = async (data: Omit<ServerProfile, 'id'>) => {
    setShowAddForm(false);
    const tempId = '_new';
    setConnStatus(s => ({ ...s, [tempId]: 'testing' }));
    try {
      const ping = await pingWithCredentials(data.url, data.username, data.password);
      if (ping.ok) {
        const id = auth.addServer(data);
        const identity = {
          type: ping.type,
          serverVersion: ping.serverVersion,
          openSubsonic: ping.openSubsonic,
        };
        auth.setSubsonicServerIdentity(id, identity);
        scheduleInstantMixProbeForServer(id, data.url, data.username, data.password, identity);
        auth.setActiveServer(id);
        auth.setLoggedIn(true);
        setConnStatus(s => ({ ...s, [id]: 'ok' }));
      } else {
        setConnStatus(s => ({ ...s, [tempId]: 'error' }));
      }
    } catch {
      setConnStatus(s => ({ ...s, [tempId]: 'error' }));
    }
  };

  const handleLogout = () => {
    auth.logout();
    navigate('/login');
  };

  const pickOfflineDir = async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: t('settings.offlineDirChange') });
    if (selected && typeof selected === 'string') {
      auth.setOfflineDownloadDir(selected);
    }
  };

  const pickHotCacheDir = async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: t('settings.hotCacheDirChange') });
    if (selected && typeof selected === 'string') {
      auth.setHotCacheDownloadDir(selected);
      useHotCacheStore.setState({ entries: {} });
      invoke<number>('get_hot_cache_size', { customDir: selected }).then(setHotCacheBytes).catch(() => setHotCacheBytes(0));
    }
  };

  const pickDownloadFolder = async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: t('settings.pickFolderTitle') });
    if (selected && typeof selected === 'string') {
      auth.setDownloadFolder(selected);
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'general',    label: t('settings.tabGeneral'),    icon: <AppWindow size={15} /> },
    { id: 'server',     label: t('settings.tabServer'),     icon: <Server size={15} /> },
    { id: 'audio',      label: t('settings.tabAudio'),      icon: <Music2 size={15} /> },
    { id: 'storage',    label: t('settings.tabStorage'),    icon: <HardDrive size={15} /> },
    { id: 'appearance', label: t('settings.tabAppearance'), icon: <Palette size={15} /> },
    { id: 'input',      label: t('settings.tabInput'),      icon: <Keyboard size={15} /> },
    { id: 'system',     label: t('settings.tabSystem'),     icon: <Info size={15} /> },
  ];

  return (
    <div className="content-body animate-fade-in">
      <h1 className="page-title" style={{ marginBottom: '1.5rem' }}>{t('settings.title')}</h1>

      {/* Tab navigation */}
      <nav className="settings-tabs" aria-label="Settings navigation">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </nav>

      {/* ── Audio ────────────────────────────────────────────────────────────── */}
      {activeTab === 'audio' && (
        <>
          {/* Audio Output Device */}
          <section className="settings-section">
            <div className="settings-section-header">
              <AudioLines size={18} />
              <h2>{t('settings.audioOutputDevice')}</h2>
            </div>
            <div className="settings-card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                {t('settings.audioOutputDeviceDesc')}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <CustomSelect
                  style={{ flex: 1 }}
                  value={auth.audioOutputDevice ?? ''}
                  disabled={deviceSwitching || devicesLoading}
                  onChange={async (val) => {
                    const device = val || null;
                    setDeviceSwitching(true);
                    try {
                      await invoke('audio_set_device', { deviceName: device });
                      auth.setAudioOutputDevice(device);
                    } catch { /* device open failed — don't persist */ }
                    setDeviceSwitching(false);
                  }}
                  options={buildAudioDeviceSelectOptions(
                    audioDevices,
                    t('settings.audioOutputDeviceDefault'),
                    osDefaultAudioDeviceId,
                    t('settings.audioOutputDeviceOsDefaultNow'),
                    auth.audioOutputDevice,
                    t('settings.audioOutputDeviceNotInCurrentList'),
                  )}
                />
                <button
                  className="icon-btn"
                  onClick={() => refreshAudioDevices()}
                  disabled={devicesLoading || deviceSwitching}
                  data-tooltip={t('settings.audioOutputDeviceRefresh')}
                >
                  <RotateCcw size={15} className={devicesLoading ? 'spin' : ''} />
                </button>
              </div>
            </div>
          </section>

          {/* Native Hi-Res Playback */}
          <section className="settings-section">
            <div className="settings-section-header">
              <Waves size={18} />
              <h2>{t('settings.hiResTitle')}</h2>
            </div>
            <div className="settings-card">
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.hiResEnabled')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.hiResDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.hiResEnabled')}>
                  <input
                    type="checkbox"
                    checked={auth.enableHiRes}
                    onChange={e => auth.setEnableHiRes(e.target.checked)}
                    id="hires-enabled-toggle"
                  />
                  <span className="toggle-track" />
                </label>
              </div>
            </div>
          </section>

          {/* Equalizer */}
          <section className="settings-section">
            <div className="settings-section-header">
              <Sliders size={18} />
              <h2>{t('settings.eqTitle')}</h2>
            </div>
            <div className="settings-card">
              <Equalizer />
            </div>
          </section>

          {/* Replay Gain + Crossfade + Gapless */}
          <section className="settings-section">
            <div className="settings-section-header">
              <Music2 size={18} />
              <h2>{t('settings.playbackTitle')}</h2>
            </div>
            <div className="settings-card">
              {/* Replay Gain */}
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.replayGain')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.replayGainDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.replayGain')}>
                  <input type="checkbox" checked={auth.replayGainEnabled} onChange={e => auth.setReplayGainEnabled(e.target.checked)} id="replay-gain-toggle" />
                  <span className="toggle-track" />
                </label>
              </div>
              {auth.replayGainEnabled && (
                <div style={{ paddingLeft: '1rem', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.replayGainMode')}:</span>
                  <button
                    className={`btn ${auth.replayGainMode === 'track' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ fontSize: 12, padding: '3px 12px' }}
                    onClick={() => auth.setReplayGainMode('track')}
                  >
                    {t('settings.replayGainTrack')}
                  </button>
                  <button
                    className={`btn ${auth.replayGainMode === 'album' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ fontSize: 12, padding: '3px 12px' }}
                    onClick={() => auth.setReplayGainMode('album')}
                  >
                    {t('settings.replayGainAlbum')}
                  </button>
                </div>
              )}
              {auth.replayGainEnabled && (
                <div style={{ paddingLeft: '1rem', marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 160 }}>
                      {t('settings.replayGainPreGain')}
                    </span>
                    <input
                      type="range" min={0} max={6} step={0.5}
                      value={auth.replayGainPreGainDb}
                      onChange={e => auth.setReplayGainPreGainDb(Number(e.target.value))}
                      style={{ flex: 1, maxWidth: 160 }}
                    />
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 40, textAlign: 'right' }}>
                      {auth.replayGainPreGainDb > 0 ? `+${auth.replayGainPreGainDb}` : auth.replayGainPreGainDb} dB
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 160 }}>
                      {t('settings.replayGainFallback')}
                    </span>
                    <input
                      type="range" min={-6} max={0} step={0.5}
                      value={auth.replayGainFallbackDb}
                      onChange={e => auth.setReplayGainFallbackDb(Number(e.target.value))}
                      style={{ flex: 1, maxWidth: 160 }}
                    />
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 40, textAlign: 'right' }}>
                      {auth.replayGainFallbackDb > 0 ? `+${auth.replayGainFallbackDb}` : auth.replayGainFallbackDb} dB
                    </span>
                  </div>
                </div>
              )}

              <div className="divider" />

              {/* Crossfade */}
              <div className="settings-toggle-row" style={auth.gaplessEnabled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
                <div>
                  <div style={{ fontWeight: 500 }}>
                    {t('settings.crossfade')}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {auth.gaplessEnabled ? t('settings.notWithGapless') : t('settings.crossfadeDesc')}
                  </div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.crossfade')}>
                  <input type="checkbox" checked={auth.crossfadeEnabled} disabled={auth.gaplessEnabled}
                    onChange={e => { auth.setGaplessEnabled(false); auth.setCrossfadeEnabled(e.target.checked); }} id="crossfade-toggle" />
                  <span className="toggle-track" />
                </label>
              </div>
              {auth.crossfadeEnabled && !auth.gaplessEnabled && (
                <div style={{ paddingLeft: '1rem', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <input
                    type="range"
                    min={0.1}
                    max={10}
                    step={0.1}
                    value={auth.crossfadeSecs}
                    onChange={e => auth.setCrossfadeSecs(parseFloat(e.target.value))}
                    style={{ width: 120 }}
                    id="crossfade-secs-slider"
                  />
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 36 }}>
                    {t('settings.crossfadeSecs', { n: auth.crossfadeSecs.toFixed(1) })}
                  </span>
                </div>
              )}

              <div className="divider" />

              {/* Gapless */}
              <div className="settings-toggle-row" style={auth.crossfadeEnabled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
                <div>
                  <div style={{ fontWeight: 500 }}>
                    {t('settings.gapless')}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {auth.crossfadeEnabled ? t('settings.notWithCrossfade') : t('settings.gaplessDesc')}
                  </div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.gapless')}>
                  <input type="checkbox" checked={auth.gaplessEnabled} disabled={auth.crossfadeEnabled}
                    onChange={e => { auth.setCrossfadeEnabled(false); auth.setGaplessEnabled(e.target.checked); }} id="gapless-toggle" />
                  <span className="toggle-track" />
                </label>
              </div>
            </div>
          </section>

          {/* Next Track Buffering */}
          <section className="settings-section">
            <div className="settings-section-header">
              <Download size={18} />
              <h2>{t('settings.nextTrackBufferingTitle')}</h2>
            </div>
            <div className="settings-card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '0.75rem' }}>
                {t('settings.preloadHotCacheMutualExclusive')}
              </div>

              {/* Preload mode */}
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.preloadMode')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.preloadModeDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.preloadMode')}>
                  <input
                    type="checkbox"
                    checked={auth.preloadMode !== 'off'}
                    onChange={e => {
                      if (e.target.checked) {
                        auth.setPreloadMode('balanced');
                        if (auth.hotCacheEnabled) auth.setHotCacheEnabled(false);
                      } else {
                        auth.setPreloadMode('off');
                      }
                    }}
                  />
                  <span className="toggle-track" />
                </label>
              </div>
              {auth.preloadMode !== 'off' && (
                <>
                  <div style={{ paddingLeft: '1rem', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    {(['balanced', 'early', 'custom'] as const).map(mode => (
                      <button
                        key={mode}
                        className={`btn ${auth.preloadMode === mode ? 'btn-primary' : 'btn-surface'}`}
                        style={{ fontSize: 12, padding: '3px 12px' }}
                        onClick={() => auth.setPreloadMode(mode)}
                      >
                        {t(`settings.preload${mode.charAt(0).toUpperCase() + mode.slice(1)}` as any)}
                      </button>
                    ))}
                  </div>
                  {auth.preloadMode === 'custom' && (
                    <div style={{ paddingLeft: '1rem', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <input
                        type="range"
                        min={5} max={120} step={5}
                        value={auth.preloadCustomSeconds}
                        onChange={e => auth.setPreloadCustomSeconds(parseInt(e.target.value))}
                        style={{ width: 120 }}
                      />
                      <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 36 }}>
                        {t('settings.preloadCustomSeconds', { n: auth.preloadCustomSeconds })}
                      </span>
                    </div>
                  )}
                </>
              )}

              <div className="divider" />

              {/* Hot Cache */}
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.hotCacheTitle')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.hotCacheDisclaimer')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.hotCacheEnabled')}>
                  <input
                    type="checkbox"
                    checked={auth.hotCacheEnabled}
                    onChange={async e => {
                      const enabled = e.target.checked;
                      if (!enabled) {
                        await clearHotCacheDisk(auth.hotCacheDownloadDir || null);
                        setHotCacheBytes(0);
                        auth.setHotCacheEnabled(false);
                      } else {
                        auth.setHotCacheEnabled(true);
                        if (auth.preloadMode !== 'off') auth.setPreloadMode('off');
                        invoke<number>('get_hot_cache_size', { customDir: auth.hotCacheDownloadDir || null })
                          .then(setHotCacheBytes)
                          .catch(() => setHotCacheBytes(0));
                      }
                    }}
                    id="hot-cache-enabled-toggle"
                  />
                  <span className="toggle-track" />
                </label>
              </div>

              {auth.hotCacheEnabled && (
                <div style={{ marginTop: '1.25rem' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      className="input"
                      type="text"
                      readOnly
                      value={auth.hotCacheDownloadDir || t('settings.hotCacheDirDefault')}
                      style={{ flex: 1, fontSize: 13, color: auth.hotCacheDownloadDir ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'default' }}
                    />
                    {auth.hotCacheDownloadDir && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => {
                          auth.setHotCacheDownloadDir('');
                          useHotCacheStore.setState({ entries: {} });
                          invoke<number>('get_hot_cache_size', { customDir: null }).then(setHotCacheBytes).catch(() => setHotCacheBytes(0));
                        }}
                        data-tooltip={t('settings.hotCacheDirClear')}
                        style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                      >
                        <X size={16} />
                      </button>
                    )}
                    <button type="button" className="btn btn-surface" onClick={pickHotCacheDir} style={{ flexShrink: 0 }}>
                      <FolderOpen size={16} /> {t('settings.hotCacheDirChange')}
                    </button>
                  </div>
                  {auth.hotCacheDownloadDir && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.4 }}>
                      {t('settings.hotCacheDirHint')}
                    </div>
                  )}

                  <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0' }} />

                  <div style={{ fontSize: 12, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ color: 'var(--text-secondary)' }}>
                      <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>{t('settings.cacheUsedHot')}</span>
                      {hotCacheBytes !== null ? formatBytes(hotCacheBytes) : '…'}
                    </div>
                    <div style={{ color: 'var(--text-secondary)' }}>
                      <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>{t('settings.hotCacheTrackCount')}</span>
                      {hotCacheTrackCount}
                    </div>
                  </div>

                  <div>
                    <div style={{ fontWeight: 500, marginBottom: 6 }}>{t('settings.hotCacheMaxMb')}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <input type="range" min={32} max={20000} step={32} value={snapHotCacheMb(auth.hotCacheMaxMb)} onChange={e => auth.setHotCacheMaxMb(parseInt(e.target.value, 10))} style={{ width: 140 }} id="hot-cache-max-mb-slider" />
                      <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 72 }}>{snapHotCacheMb(auth.hotCacheMaxMb)} MB</span>
                    </div>
                  </div>
                  <div style={{ marginTop: '0.75rem' }}>
                    <div style={{ fontWeight: 500, marginBottom: 6 }}>{t('settings.hotCacheDebounce')}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <input type="range" min={0} max={600} step={1} value={Math.min(600, Math.max(0, auth.hotCacheDebounceSec))} onChange={e => auth.setHotCacheDebounceSec(parseInt(e.target.value, 10))} style={{ width: 140 }} id="hot-cache-debounce-slider" />
                      <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 100 }}>
                        {Math.min(600, Math.max(0, auth.hotCacheDebounceSec)) === 0
                          ? t('settings.hotCacheDebounceImmediate')
                          : t('settings.hotCacheDebounceSeconds', { n: Math.min(600, Math.max(0, auth.hotCacheDebounceSec)) })}
                      </span>
                    </div>
                  </div>

                  <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0' }} />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ fontSize: 13 }}
                    onClick={async () => {
                      await clearHotCacheDisk(auth.hotCacheDownloadDir || null);
                      const b = await invoke<number>('get_hot_cache_size', { customDir: auth.hotCacheDownloadDir || null }).catch(() => 0);
                      setHotCacheBytes(b);
                    }}
                  >
                    <Trash2 size={14} /> {t('settings.hotCacheClearBtn')}
                  </button>
                </div>
              )}

            </div>
          </section>

        </>
      )}

      {/* ── General ──────────────────────────────────────────────────────────── */}
      {activeTab === 'general' && (
        <>
          {/* App behaviour */}
          <section className="settings-section">
            <div className="settings-section-header">
              <AppWindow size={18} />
              <h2>{t('settings.behavior')}</h2>
            </div>
            <div className="settings-card">
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.showTrayIcon')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.showTrayIconDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.showTrayIcon')}>
                  <input type="checkbox" checked={auth.showTrayIcon} onChange={e => auth.setShowTrayIcon(e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
              <div className="settings-section-divider" />
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.minimizeToTray')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.minimizeToTrayDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.minimizeToTray')}>
                  <input type="checkbox" checked={auth.minimizeToTray} onChange={e => auth.setMinimizeToTray(e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
              {IS_LINUX && !isTilingWm && (
                <>
                  <div className="settings-section-divider" />
                  <div className="settings-toggle-row">
                    <div>
                      <div style={{ fontWeight: 500 }}>{t('settings.useCustomTitlebar')}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.useCustomTitlebarDesc')}</div>
                    </div>
                    <label className="toggle-switch" aria-label={t('settings.useCustomTitlebar')}>
                      <input type="checkbox" checked={auth.useCustomTitlebar} onChange={e => auth.setUseCustomTitlebar(e.target.checked)} />
                      <span className="toggle-track" />
                    </label>
                  </div>
                </>
              )}
              <div className="settings-section-divider" />
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.showArtistImages')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.showArtistImagesDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.showArtistImages')}>
                  <input type="checkbox" checked={auth.showArtistImages} onChange={e => auth.setShowArtistImages(e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
              <div className="settings-section-divider" />
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.discordRichPresence')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.discordRichPresenceDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.discordRichPresence')}>
                  <input type="checkbox" checked={auth.discordRichPresence} onChange={e => auth.setDiscordRichPresence(e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
              {auth.discordRichPresence && (
                <>
                  <div className="settings-section-divider" />
                  <div className="settings-toggle-row" style={{ paddingLeft: 16 }}>
                    <div>
                      <div style={{ fontWeight: 500 }}>{t('settings.discordAppleCovers')}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.discordAppleCoversDesc')}</div>
                    </div>
                    <label className="toggle-switch" aria-label={t('settings.discordAppleCovers')}>
                      <input type="checkbox" checked={auth.enableAppleMusicCoversDiscord} onChange={e => auth.setEnableAppleMusicCoversDiscord(e.target.checked)} />
                      <span className="toggle-track" />
                    </label>
                  </div>
                </>
              )}
              <div className="settings-section-divider" />
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.nowPlayingEnabled')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.nowPlayingEnabledDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.nowPlayingEnabled')}>
                  <input type="checkbox" checked={auth.nowPlayingEnabled} onChange={e => auth.setNowPlayingEnabled(e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
            </div>
          </section>

          {/* Lyrics Sources */}
          <LyricsSourcesCustomizer />

          {/* Random Mix */}
          <section className="settings-section">
            <div className="settings-section-header">
              <Shuffle size={18} />
              <h2>{t('settings.randomMixTitle')}</h2>
            </div>
            <div className="settings-card">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: '1rem', lineHeight: 1.5 }}>
                {t('settings.randomMixBlacklistDesc')}
              </p>

              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: '0.5rem' }}>{t('settings.randomMixBlacklistTitle')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.75rem', minHeight: 32 }}>
                {auth.customGenreBlacklist.length === 0 ? (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>{t('settings.randomMixBlacklistEmpty')}</span>
                ) : (
                  auth.customGenreBlacklist.map(genre => (
                    <span key={genre} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                      color: 'var(--accent)', borderRadius: 'var(--radius-sm)',
                      padding: '2px 8px', fontSize: 12, fontWeight: 500,
                    }}>
                      {genre}
                      <button
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, lineHeight: 1, fontSize: 14 }}
                        onClick={() => auth.setCustomGenreBlacklist(auth.customGenreBlacklist.filter(g => g !== genre))}
                        aria-label={`Remove ${genre}`}
                      >×</button>
                    </span>
                  ))
                )}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', maxWidth: 400 }}>
                <input
                  className="input"
                  type="text"
                  value={newGenre}
                  onChange={e => setNewGenre(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newGenre.trim()) {
                      const trimmed = newGenre.trim();
                      if (!auth.customGenreBlacklist.includes(trimmed)) {
                        auth.setCustomGenreBlacklist([...auth.customGenreBlacklist, trimmed]);
                      }
                      setNewGenre('');
                    }
                  }}
                  placeholder={t('settings.randomMixBlacklistPlaceholder')}
                  style={{ fontSize: 13 }}
                />
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    const trimmed = newGenre.trim();
                    if (trimmed && !auth.customGenreBlacklist.includes(trimmed)) {
                      auth.setCustomGenreBlacklist([...auth.customGenreBlacklist, trimmed]);
                    }
                    setNewGenre('');
                  }}
                  disabled={!newGenre.trim()}
                >
                  {t('settings.randomMixBlacklistAdd')}
                </button>
              </div>

              <div className="divider" style={{ margin: '1rem 0' }} />

              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: '0.5rem', color: 'var(--text-muted)' }}>{t('settings.randomMixHardcodedTitle')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {AUDIOBOOK_GENRES_DISPLAY.map(genre => (
                  <span key={genre} className="genre-keyword-badge" style={{
                    display: 'inline-flex', alignItems: 'center',
                    background: 'var(--bg-hover)', color: 'var(--text-muted)',
                    borderRadius: 'var(--radius-sm)', padding: '2px 8px', fontSize: 12,
                  }}>
                    {genre}
                  </span>
                ))}
              </div>
            </div>
          </section>

          {/* Ratings (single block under Random Mix) */}
          <section className="settings-section">
            <div className="settings-section-header">
              <Star size={18} />
              <h2>{t('settings.ratingsSectionTitle')}</h2>
            </div>
            <div className="settings-card">
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.ratingsSkipStarTitle')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.ratingsSkipStarDesc')}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                  {auth.skipStarOnManualSkipsEnabled && (
                    <>
                      <label htmlFor="settings-skip-star-threshold" style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {t('settings.ratingsSkipStarThresholdLabel')}
                      </label>
                      <input
                        id="settings-skip-star-threshold"
                        className="input"
                        type="number"
                        min={1}
                        max={99}
                        value={auth.skipStarManualSkipThreshold}
                        onChange={e => auth.setSkipStarManualSkipThreshold(Number(e.target.value))}
                        style={{ width: 72, padding: '6px 10px', fontSize: 13 }}
                        aria-label={t('settings.ratingsSkipStarThresholdLabel')}
                      />
                    </>
                  )}
                  <label className="toggle-switch" aria-label={t('settings.ratingsSkipStarTitle')}>
                    <input
                      type="checkbox"
                      checked={auth.skipStarOnManualSkipsEnabled}
                      onChange={e => auth.setSkipStarOnManualSkipsEnabled(e.target.checked)}
                    />
                    <span className="toggle-track" />
                  </label>
                </div>
              </div>

              <div className="settings-section-divider" />

              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.ratingsMixFilterTitle')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {t('settings.ratingsMixFilterDesc', {
                      mix: t('sidebar.randomMix'),
                      albums: t('sidebar.randomAlbums'),
                    })}
                  </div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.ratingsMixFilterTitle')}>
                  <input
                    type="checkbox"
                    checked={auth.mixMinRatingFilterEnabled}
                    onChange={e => auth.setMixMinRatingFilterEnabled(e.target.checked)}
                  />
                  <span className="toggle-track" />
                </label>
              </div>
              {auth.mixMinRatingFilterEnabled && (
                <>
                  <div className="settings-section-divider" />
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                      gap: '1rem 0.75rem',
                      alignItems: 'start',
                    }}
                  >
                    {([
                      { key: 'song', label: t('settings.ratingsMixMinSong'), value: auth.mixMinRatingSong, set: auth.setMixMinRatingSong },
                      { key: 'album', label: t('settings.ratingsMixMinAlbum'), value: auth.mixMinRatingAlbum, set: auth.setMixMinRatingAlbum },
                      { key: 'artist', label: t('settings.ratingsMixMinArtist'), value: auth.mixMinRatingArtist, set: auth.setMixMinRatingArtist },
                    ] as const).map(row => (
                      <div
                        key={row.key}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 8,
                          minWidth: 0,
                          textAlign: 'center',
                        }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)' }}>{row.label}</span>
                        <StarRating
                          maxSelectable={MIX_MIN_RATING_FILTER_MAX_STARS}
                          value={row.value}
                          onChange={row.set}
                          ariaLabel={t('settings.ratingsMixMinThresholdAria', { label: row.label })}
                        />
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </section>

          <HomeCustomizer />
        </>
      )}

      {/* ── Storage & Downloads ───────────────────────────────────────────────── */}
      {activeTab === 'storage' && (
        <>
          {/* Offline Library (In-App) — includes cache settings */}
          <section className="settings-section">
            <div className="settings-section-header">
              <Download size={18} />
              <h2>{t('settings.offlineDirTitle')}</h2>
            </div>
            <div className="settings-card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
                {t('settings.offlineDirDesc')}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="input"
                  type="text"
                  readOnly
                  value={auth.offlineDownloadDir || t('settings.offlineDirDefault')}
                  style={{ flex: 1, fontSize: 13, color: auth.offlineDownloadDir ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'default' }}
                />
                {auth.offlineDownloadDir && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => auth.setOfflineDownloadDir('')}
                    data-tooltip={t('settings.offlineDirClear')}
                    style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                  >
                    <X size={16} />
                  </button>
                )}
                <button className="btn btn-surface" onClick={pickOfflineDir} style={{ flexShrink: 0 }} id="settings-offline-dir-btn">
                  <FolderOpen size={16} /> {t('settings.offlineDirChange')}
                </button>
              </div>
              {auth.offlineDownloadDir && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.4 }}>
                  {t('settings.offlineDirHint')}
                </div>
              )}

              <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0' }} />

              {(imageCacheBytes !== null || offlineCacheBytes !== null) && (
                <div style={{ fontSize: 12, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ color: 'var(--text-secondary)' }}>
                    <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>{t('settings.cacheUsedImages')}</span>
                    {imageCacheBytes !== null ? formatBytes(imageCacheBytes) : '…'}
                  </div>
                  <div style={{ color: 'var(--text-secondary)' }}>
                    <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>{t('settings.cacheUsedOffline')}</span>
                    {offlineCacheBytes !== null ? formatBytes(offlineCacheBytes) : '…'}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.cacheMaxLabel')}</span>
                <input
                  className="input"
                  type="number"
                  min={100}
                  max={50000}
                  step={100}
                  value={auth.maxCacheMb}
                  onChange={e => {
                    const v = Number(e.target.value);
                    if (v >= 100) auth.setMaxCacheMb(v);
                  }}
                  style={{ width: 80, padding: '4px 8px', fontSize: 13 }}
                  id="cache-size-input"
                />
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>MB</span>
              </div>
              {showClearConfirm ? (
                <div style={{ background: 'color-mix(in srgb, var(--color-danger, #e53935) 10%, transparent)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', fontSize: 13, lineHeight: 1.5 }}>
                  <div style={{ marginBottom: 8, color: 'var(--text-primary)' }}>{t('settings.cacheClearWarning')}</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn btn-primary"
                      style={{ background: 'var(--color-danger, #e53935)', fontSize: 13 }}
                      onClick={handleClearCache}
                      disabled={clearing}
                    >
                      {t('settings.cacheClearConfirm')}
                    </button>
                    <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => setShowClearConfirm(false)} disabled={clearing}>
                      {t('settings.cacheClearCancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => setShowClearConfirm(true)}>
                  <Trash2 size={14} /> {t('settings.cacheClearBtn')}
                </button>
              )}
            </div>
          </section>

          {/* ZIP Export & Archiving */}
          <section className="settings-section">
            <div className="settings-section-header">
              <FolderOpen size={18} />
              <h2>{t('settings.downloadsTitle')}</h2>
            </div>
            <div className="settings-card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
                {t('settings.downloadsFolderDesc')}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="input"
                  type="text"
                  readOnly
                  value={auth.downloadFolder || t('settings.downloadsDefault')}
                  style={{ flex: 1, fontSize: 13, color: auth.downloadFolder ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'default' }}
                />
                {auth.downloadFolder && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => auth.setDownloadFolder('')}
                    aria-label={t('settings.clearFolder')}
                    data-tooltip={t('settings.clearFolder')}
                    style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                  >
                    <X size={16} />
                  </button>
                )}
                <button className="btn btn-surface" onClick={pickDownloadFolder} style={{ flexShrink: 0 }} id="settings-download-folder-btn">
                  <FolderOpen size={16} /> {t('settings.pickFolder')}
                </button>
              </div>
            </div>
          </section>
        </>
      )}

      {/* ── Appearance ───────────────────────────────────────────────────────── */}
      {activeTab === 'appearance' && (
        <>
          <section className="settings-section">
            <div className="settings-section-header">
              <Globe size={18} />
              <h2>{t('settings.language')}</h2>
            </div>
            <div className="settings-card">
              <div className="form-group" style={{ maxWidth: '300px' }}>
                <CustomSelect
                  value={i18n.language}
                  onChange={v => i18n.changeLanguage(v)}
                  options={[
                    { value: 'en', label: t('settings.languageEn') },
                    { value: 'de', label: t('settings.languageDe') },
                    { value: 'es', label: t('settings.languageEs') },
                    { value: 'fr', label: t('settings.languageFr') },
                    { value: 'nl', label: t('settings.languageNl') },
                    { value: 'nb', label: t('settings.languageNb') },
                    { value: 'ru', label: t('settings.languageRu') },
                    { value: 'zh', label: t('settings.languageZh') },
                  ]}
                />
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-header">
              <Palette size={18} />
              <h2>{t('settings.theme')}</h2>
            </div>
            <div className="settings-card">
              {theme.enableThemeScheduler && (
                <div className="settings-hint settings-hint-info" style={{ marginBottom: '0.75rem' }}>
                  {t('settings.themeSchedulerActiveHint')}
                </div>
              )}
              <ThemePicker value={theme.theme} onChange={v => theme.setTheme(v as any)} />
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-header">
              <Clock size={18} />
              <h2>{t('settings.themeSchedulerTitle')}</h2>
            </div>
            <div className="settings-card">
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.themeSchedulerEnable')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.themeSchedulerEnableSub')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.themeSchedulerEnable')}>
                  <input type="checkbox" checked={theme.enableThemeScheduler} onChange={e => theme.setEnableThemeScheduler(e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
              {theme.enableThemeScheduler && (() => {
                const themeOptions = THEME_GROUPS.flatMap(g =>
                  g.themes.map(th => ({ value: th.id, label: th.label, group: g.group }))
                );
                const use12h = i18n.language === 'en';
                const hourOptions = Array.from({ length: 24 }, (_, i) => {
                  const value = String(i).padStart(2, '0');
                  const label = use12h
                    ? `${i % 12 === 0 ? 12 : i % 12} ${i < 12 ? 'AM' : 'PM'}`
                    : value;
                  return { value, label };
                });
                const minuteOptions = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'].map(m => ({ value: m, label: m }));
                const dayH = theme.timeDayStart.split(':')[0];
                const dayM = theme.timeDayStart.split(':')[1];
                const nightH = theme.timeNightStart.split(':')[0];
                const nightM = theme.timeNightStart.split(':')[1];
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
                    <div className="form-group">
                      <label className="settings-label" style={{ marginBottom: 6 }}>{t('settings.themeSchedulerDayTheme')}</label>
                      <CustomSelect value={theme.themeDay} onChange={theme.setThemeDay} options={themeOptions} />
                    </div>
                    <div className="form-group">
                      <label className="settings-label" style={{ marginBottom: 6 }}>{t('settings.themeSchedulerDayStart')}</label>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <CustomSelect value={dayH} onChange={v => theme.setTimeDayStart(`${v}:${dayM}`)} options={hourOptions} />
                        <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>:</span>
                        <CustomSelect value={dayM} onChange={v => theme.setTimeDayStart(`${dayH}:${v}`)} options={minuteOptions} />
                      </div>
                    </div>
                    <div className="form-group">
                      <label className="settings-label" style={{ marginBottom: 6 }}>{t('settings.themeSchedulerNightTheme')}</label>
                      <CustomSelect value={theme.themeNight} onChange={theme.setThemeNight} options={themeOptions} />
                    </div>
                    <div className="form-group">
                      <label className="settings-label" style={{ marginBottom: 6 }}>{t('settings.themeSchedulerNightStart')}</label>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <CustomSelect value={nightH} onChange={v => theme.setTimeNightStart(`${v}:${nightM}`)} options={hourOptions} />
                        <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>:</span>
                        <CustomSelect value={nightM} onChange={v => theme.setTimeNightStart(`${nightH}:${v}`)} options={minuteOptions} />
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-header">
              <ZoomIn size={18} />
              <h2>{t('settings.uiScaleTitle')}</h2>
            </div>
            <div className="settings-card">
              {/* TODO: UI scaling is being reworked — disabled until fixed */}
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                Interface scaling is currently being reworked and will be available in a future update.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', opacity: 0.4, pointerEvents: 'none', marginTop: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.uiScaleLabel')}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', minWidth: 40, textAlign: 'right' }}>
                    {Math.round(fontStore.uiScale * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.8}
                  max={1.5}
                  step={0.05}
                  value={fontStore.uiScale}
                  onChange={e => fontStore.setUiScale(parseFloat(e.target.value))}
                  className="ui-scale-slider"
                />
                <div style={{ position: 'relative', height: 24 }}>
                  {[80, 90, 100, 110, 125, 150].map(p => {
                    const pct = ((p / 100) - 0.8) / (1.5 - 0.8) * 100;
                    const active = Math.round(fontStore.uiScale * 100) === p;
                    return (
                      <button
                        key={p}
                        className="btn btn-ghost"
                        style={{
                          position: 'absolute',
                          left: `${pct}%`,
                          transform: 'translateX(-50%)',
                          fontSize: 11,
                          padding: '2px 6px',
                          opacity: active ? 1 : 0.5,
                          color: active ? 'var(--accent)' : undefined,
                        }}
                        onClick={() => fontStore.setUiScale(p / 100)}
                      >
                        {p}%
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-header">
              <Type size={18} />
              <h2>{t('settings.font')}</h2>
            </div>
            <div className="settings-card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {(
                  [
                    { id: 'inter',             label: 'Inter',             stack: "'Inter', sans-serif" },
                    { id: 'outfit',            label: 'Outfit',            stack: "'Outfit', sans-serif" },
                    { id: 'dm-sans',           label: 'DM Sans',           stack: "'DM Sans', sans-serif" },
                    { id: 'nunito',            label: 'Nunito',            stack: "'Nunito', sans-serif" },
                    { id: 'rubik',             label: 'Rubik',             stack: "'Rubik', sans-serif" },
                    { id: 'space-grotesk',     label: 'Space Grotesk',     stack: "'Space Grotesk', sans-serif" },
                    { id: 'figtree',           label: 'Figtree',           stack: "'Figtree', sans-serif" },
                    { id: 'manrope',           label: 'Manrope',           stack: "'Manrope', sans-serif" },
                    { id: 'plus-jakarta-sans', label: 'Plus Jakarta Sans', stack: "'Plus Jakarta Sans', sans-serif" },
                    { id: 'lexend',            label: 'Lexend',            stack: "'Lexend', sans-serif" },
                  ] as { id: FontId; label: string; stack: string }[]
                ).map(f => (
                  <button
                    key={f.id}
                    className={`btn ${fontStore.font === f.id ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ justifyContent: 'flex-start', fontFamily: f.stack }}
                    onClick={() => fontStore.setFont(f.id)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-header">
              <Maximize2 size={18} />
              <h2>{t('settings.fsPlayerSection')}</h2>
            </div>
            <div className="settings-card">
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.fsShowArtistPortrait')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.fsShowArtistPortraitDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.fsShowArtistPortrait')}>
                  <input type="checkbox" checked={auth.showFsArtistPortrait} onChange={e => auth.setShowFsArtistPortrait(e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
              {auth.showFsArtistPortrait && (
                <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.fsPortraitDim')}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', minWidth: 36, textAlign: 'right' }}>{auth.fsPortraitDim}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={80}
                    step={1}
                    value={auth.fsPortraitDim}
                    onChange={e => auth.setFsPortraitDim(parseInt(e.target.value, 10))}
                    className="ui-scale-slider"
                  />
                </div>
              )}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-header">
              <Sliders size={18} />
              <h2>{t('settings.seekbarStyle')}</h2>
            </div>
            <div className="settings-card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                {t('settings.seekbarStyleDesc')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {(['waveform', 'linedot', 'bar', 'thick', 'segmented', 'neon', 'pulsewave', 'particletrail', 'liquidfill', 'retrotape'] as SeekbarStyle[]).map(style => (
                  <SeekbarPreview
                    key={style}
                    style={style}
                    label={t(`settings.seekbar${style.charAt(0).toUpperCase() + style.slice(1)}` as any)}
                    selected={auth.seekbarStyle === style}
                    onClick={() => auth.setSeekbarStyle(style)}
                  />
                ))}
              </div>
            </div>
          </section>

          <SidebarCustomizer />
        </>
      )}

      {/* ── Input ────────────────────────────────────────────────────────────── */}
      {activeTab === 'input' && (
        <>
        <section className="settings-section">
          <div className="settings-section-header">
            <Keyboard size={18} />
            <h2>{t('settings.tabInput')}</h2>
          </div>
          <div style={{ position: 'relative' }}>
            <button
              className="btn btn-ghost"
              style={{ position: 'absolute', top: -22, right: 0, fontSize: 12, color: 'var(--text-muted)', padding: '2px 4px' }}
              onClick={() => { kb.resetToDefaults(); setListeningFor(null); }}
              data-tooltip={t('settings.shortcutsReset')}
            >
              <RotateCcw size={14} />
            </button>
          <div className="settings-card">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {([
                ['play-pause',        t('settings.shortcutPlayPause')],
                ['next',              t('settings.shortcutNext')],
                ['prev',              t('settings.shortcutPrev')],
                ['volume-up',         t('settings.shortcutVolumeUp')],
                ['volume-down',       t('settings.shortcutVolumeDown')],
                ['seek-forward',      t('settings.shortcutSeekForward')],
                ['seek-backward',     t('settings.shortcutSeekBackward')],
                ['toggle-queue',      t('settings.shortcutToggleQueue')],
                ['open-folder-browser', t('settings.shortcutOpenFolderBrowser', { folderBrowser: t('sidebar.folderBrowser') })],
                ['fullscreen-player', t('settings.shortcutFullscreenPlayer')],
                ['native-fullscreen', t('settings.shortcutNativeFullscreen')],
              ] as [KeyAction, string][]).map(([action, label]) => {
                const bound = kb.bindings[action];
                const isListening = listeningFor === action;
                return (
                  <div key={action} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                    background: isListening ? 'var(--accent-dim)' : 'transparent',
                    transition: 'background 0.15s',
                  }}>
                    <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{label}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <button
                        onClick={() => {
                          if (isListening) { setListeningFor(null); return; }
                          setListeningFor(action);
                          const handler = (e: KeyboardEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (e.code === 'Escape') {
                              setListeningFor(null);
                              window.removeEventListener('keydown', handler, true);
                              return;
                            }
                            const chord = buildInAppBinding(e);
                            if (!chord) return;
                            const existing = (Object.entries(kb.bindings) as [KeyAction, string | null][])
                              .find(([, c]) => c === chord)?.[0];
                            if (existing && existing !== action) kb.setBinding(existing, null);
                            kb.setBinding(action, chord);
                            setListeningFor(null);
                            window.removeEventListener('keydown', handler, true);
                          };
                          window.addEventListener('keydown', handler, true);
                        }}
                        className="keybind-badge"
                        style={{
                          minWidth: 72, padding: '3px 10px', borderRadius: 'var(--radius-sm)',
                          fontSize: 12, fontWeight: 600, fontFamily: 'monospace',
                          background: isListening ? 'var(--accent)' : bound ? 'var(--bg-hover)' : 'var(--bg-card)',
                          color: isListening ? 'var(--ctp-base)' : bound ? 'var(--text-primary)' : 'var(--text-muted)',
                          border: `1px solid ${isListening ? 'var(--accent)' : 'var(--border-subtle)'}`,
                          cursor: 'pointer',
                        }}
                      >
                        {isListening ? t('settings.shortcutListening') : bound ? formatBinding(bound) : t('settings.shortcutUnbound')}
                      </button>
                      {bound && !isListening && (
                        <button
                          onClick={() => kb.setBinding(action, null)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '2px 4px', lineHeight: 1 }}
                          data-tooltip={t('settings.shortcutClear')}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-header">
            <Keyboard size={18} />
            <h2>{t('settings.globalShortcutsTitle')}</h2>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.5 }}>
            {t('settings.globalShortcutsNote')}
          </p>
          <div style={{ position: 'relative' }}>
            <button
              className="btn btn-ghost"
              style={{ position: 'absolute', top: -22, right: 0, fontSize: 12, color: 'var(--text-muted)', padding: '2px 4px' }}
              onClick={() => { gs.resetAll(); setListeningForGlobal(null); }}
              data-tooltip={t('settings.shortcutsReset')}
            >
              <RotateCcw size={14} />
            </button>
          <div className="settings-card">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {([
                ['play-pause',  t('settings.shortcutPlayPause')],
                ['next',        t('settings.shortcutNext')],
                ['prev',        t('settings.shortcutPrev')],
                ['volume-up',   t('settings.shortcutVolumeUp')],
                ['volume-down', t('settings.shortcutVolumeDown')],
              ] as [GlobalAction, string][]).map(([action, label]) => {
                const bound = gs.shortcuts[action] ?? null;
                const isListening = listeningForGlobal === action;
                return (
                  <div key={action} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                    background: isListening ? 'var(--accent-dim)' : 'transparent',
                    transition: 'background 0.15s',
                  }}>
                    <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{label}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <button
                        onClick={() => {
                          if (isListening) { setListeningForGlobal(null); return; }
                          setListeningForGlobal(action);
                          const handler = (e: KeyboardEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (e.code === 'Escape') {
                              setListeningForGlobal(null);
                              window.removeEventListener('keydown', handler, true);
                              return;
                            }
                            const shortcut = buildGlobalShortcut(e);
                            if (shortcut) {
                              gs.setShortcut(action, shortcut);
                              setListeningForGlobal(null);
                              window.removeEventListener('keydown', handler, true);
                            }
                          };
                          window.addEventListener('keydown', handler, true);
                        }}
                        className="keybind-badge"
                        style={{
                          minWidth: 120, padding: '3px 10px', borderRadius: 'var(--radius-sm)',
                          fontSize: 12, fontWeight: 600, fontFamily: 'monospace',
                          background: isListening ? 'var(--accent)' : bound ? 'var(--bg-hover)' : 'var(--bg-card)',
                          color: isListening ? 'var(--ctp-base)' : bound ? 'var(--text-primary)' : 'var(--text-muted)',
                          border: `1px solid ${isListening ? 'var(--accent)' : 'var(--border-subtle)'}`,
                          cursor: 'pointer',
                        }}
                      >
                        {isListening ? t('settings.shortcutListening') : bound ? formatGlobalShortcut(bound) : t('settings.shortcutUnbound')}
                      </button>
                      {bound && !isListening && (
                        <button
                          onClick={() => gs.setShortcut(action, null)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '2px 4px', lineHeight: 1 }}
                          data-tooltip={t('settings.shortcutClear')}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          </div>
        </section>
        </>
      )}

      {/* ── Server ───────────────────────────────────────────────────────────── */}
      {activeTab === 'server' && (
        <>
          <section className="settings-section">
            <div className="settings-section-header">
              <Server size={18} />
              <h2>{t('settings.servers')}</h2>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
              {t('settings.serverCompatible')}
            </div>

            {auth.servers.length === 0 && !showAddForm ? (
              <div className="settings-card" style={{ color: 'var(--text-muted)', fontSize: 14 }}>
                {t('settings.noServers')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {auth.servers.map(srv => {
                  const isActive = srv.id === auth.activeServerId;
                  const status = connStatus[srv.id];
                  return (
                    <div key={srv.id} className="settings-card" style={{ border: isActive ? '1px solid var(--accent)' : undefined }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '2px' }}>
                            <span style={{ fontWeight: 600 }}>{srv.name || srv.url}</span>
                            {isActive && (
                              <span style={{ fontSize: 11, background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '1px 6px', borderRadius: '10px', fontWeight: 600 }}>
                                {t('settings.serverActive')}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{srv.username}@{srv.url}</div>
                        </div>
                        <div style={{ display: 'flex', gap: '6px', flexShrink: 0, alignItems: 'center' }}>
                          {status === 'ok' && <CheckCircle2 size={16} style={{ color: 'var(--positive)' }} />}
                          {status === 'error' && <WifiOff size={16} style={{ color: 'var(--danger)' }} />}
                          {status === 'testing' && <div className="spinner" style={{ width: 16, height: 16 }} />}
                          <button
                            className="btn btn-surface"
                            style={{ fontSize: 12, padding: '4px 10px' }}
                            onClick={() => testConnection(srv)}
                            disabled={status === 'testing'}
                          >
                            <Wifi size={13} />
                            {t('settings.testBtn')}
                          </button>
                          {!isActive && (
                            <button
                              className="btn btn-primary"
                              style={{ fontSize: 12, padding: '4px 10px' }}
                              onClick={() => switchToServer(srv)}
                              disabled={status === 'testing'}
                              id={`settings-use-server-${srv.id}`}
                            >
                              {t('settings.useServer')}
                            </button>
                          )}
                          <button
                            className="btn btn-ghost"
                            style={{ color: 'var(--danger)', padding: '4px 8px' }}
                            onClick={() => deleteServer(srv)}
                            data-tooltip={t('settings.deleteServer')}
                            id={`settings-delete-server-${srv.id}`}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      {showAudiomuseNavidromeServerSetting(
                        auth.subsonicServerIdentityByServer[srv.id],
                        auth.instantMixProbeByServer[srv.id],
                      ) && (
                        <div
                          className="settings-toggle-row"
                          style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid color-mix(in srgb, var(--text-muted) 18%, transparent)' }}
                        >
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', minWidth: 0 }}>
                            <Sparkles size={16} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
                            <div>
                              <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                {t('settings.audiomuseTitle')}
                                <span
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 600,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.04em',
                                    padding: '2px 6px',
                                    borderRadius: 4,
                                    background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 22%, transparent)',
                                    color: 'var(--text-primary)',
                                  }}
                                >
                                  {t('settings.hotCacheAlphaBadge')}
                                </span>
                                {!!auth.audiomuseNavidromeByServer[srv.id] && auth.audiomuseNavidromeIssueByServer[srv.id] && (
                                  <AlertTriangle
                                    size={16}
                                    style={{ color: 'var(--color-warning, #f59e0b)', flexShrink: 0 }}
                                    data-tooltip={t('settings.audiomuseIssueHint')}
                                    aria-label={t('settings.audiomuseIssueHint')}
                                  />
                                )}
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                                <Trans
                                  i18nKey="settings.audiomuseDesc"
                                  components={{
                                    pluginLink: (
                                      <a
                                        href={AUDIOMUSE_NV_PLUGIN_URL}
                                        onClick={e => {
                                          e.preventDefault();
                                          void openUrl(AUDIOMUSE_NV_PLUGIN_URL);
                                        }}
                                        style={{ color: 'var(--accent)', textDecoration: 'underline' }}
                                      />
                                    ),
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                          <label className="toggle-switch" aria-label={t('settings.audiomuseTitle')}>
                            <input
                              type="checkbox"
                              checked={!!auth.audiomuseNavidromeByServer[srv.id]}
                              onChange={e => auth.setAudiomuseNavidromeEnabled(srv.id, e.target.checked)}
                            />
                            <span className="toggle-track" />
                          </label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {showAddForm ? (
              <AddServerForm onSave={handleAddServer} onCancel={() => setShowAddForm(false)} />
            ) : (
              <button className="btn btn-surface" style={{ marginTop: '0.75rem' }} onClick={() => setShowAddForm(true)} id="settings-add-server-btn">
                <Plus size={16} /> {t('settings.addServer')}
              </button>
            )}
          </section>

          {/* Last.fm */}
          <section className="settings-section">
            <div className="settings-section-header">
              <LastfmIcon size={18} />
              <h2>{t('settings.lfmTitle')}</h2>
            </div>
            <div className="settings-card">
              {auth.lastfmSessionKey ? (
                /* ── Connected state ── */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem', borderRadius: '10px', background: 'color-mix(in srgb, var(--accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)' }}>
                    <div style={{ flexShrink: 0, color: '#e31c23' }}><LastfmIcon size={20} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>@{auth.lastfmUsername}</div>
                      {lfmUserInfo && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: '0.75rem' }}>
                          <span>{t('settings.lfmScrobbles', { n: lfmUserInfo.playcount.toLocaleString() })}</span>
                          <span>{t('settings.lfmMemberSince', { year: new Date(lfmUserInfo.registeredAt * 1000).getFullYear() })}</span>
                        </div>
                      )}
                    </div>
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 12, padding: '4px 10px', flexShrink: 0 }}
                      onClick={() => auth.disconnectLastfm()}
                    >
                      {t('settings.lfmDisconnect')}
                    </button>
                  </div>
                  <div className="settings-toggle-row">
                    <div>
                      <div style={{ fontWeight: 500 }}>{t('settings.scrobbleEnabled')}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.scrobbleDesc')}</div>
                    </div>
                    <label className="toggle-switch" aria-label={t('settings.scrobbleEnabled')}>
                      <input type="checkbox" checked={auth.scrobblingEnabled} onChange={e => auth.setScrobblingEnabled(e.target.checked)} id="scrobbling-toggle" />
                      <span className="toggle-track" />
                    </label>
                  </div>
                </div>
              ) : lfmState === 'waiting' ? (
                /* ── Waiting for browser auth — auto-polling ── */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: 13, color: 'var(--text-secondary)' }}>
                    <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                    {t('settings.lfmConnecting')}
                  </div>
                  <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 12 }}
                    onClick={() => { setLfmState('idle'); setLfmPendingToken(null); }}>
                    {t('common.cancel')}
                  </button>
                </div>
              ) : (
                /* ── Not connected ── */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    {t('settings.lfmConnectDesc')}
                  </p>
                  {lfmState === 'error' && (
                    <p style={{ fontSize: 12, color: 'var(--danger)' }}>{lfmError}</p>
                  )}
                  <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={startLastfmConnect}>
                    {t('settings.lfmConnect')}
                  </button>
                </div>
              )}
            </div>
          </section>

          <section className="settings-section">
            <button className="btn btn-danger" onClick={handleLogout} id="settings-logout-btn">
              <LogOut size={16} /> {t('settings.logout')}
            </button>
          </section>

        </>
      )}

      {/* ── System ───────────────────────────────────────────────────────────── */}
      {activeTab === 'system' && (
        <>
        <BackupSection />
          <section className="settings-section">
            <div className="settings-section-header">
              <Info size={18} />
              <h2>{t('settings.aboutTitle')}</h2>
            </div>
            <div className="settings-card settings-about">
              <div className="settings-about-header">
                <img src="/logo-psysonic.png" width={52} height={52} alt="Psysonic" style={{ borderRadius: 14 }} />
                <div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                    Psysonic
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    {t('settings.aboutVersion')} {appVersion}
                  </div>
                </div>
              </div>

              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '1rem 0 0.5rem' }}>
                {t('settings.aboutDesc')}
              </p>

              <div className="divider" style={{ margin: '1rem 0' }} />

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontSize: 13 }}>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <span style={{ color: 'var(--text-muted)', minWidth: 56 }}>{t('settings.aboutLicense')}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{t('settings.aboutLicenseText')}</span>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <span style={{ color: 'var(--text-muted)', minWidth: 56 }}>Stack</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{t('settings.aboutBuiltWith')}</span>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <span style={{ color: 'var(--text-muted)', minWidth: 56 }}>AI</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{t('settings.aboutAiCredit')}</span>
                </div>
                <div>
                  <button
                    style={{ display: 'flex', width: '100%', alignItems: 'center', gap: '0.5rem', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
                    onClick={() => setContributorsOpen(o => !o)}
                  >
                    <span style={{ color: 'var(--text-muted)', minWidth: 56, flexShrink: 0 }}>{t('settings.aboutContributorsLabel')}</span>
                    <span style={{ color: 'var(--text-secondary)', flex: 1 }}>{CONTRIBUTORS.length}</span>
                    <ChevronDown size={13} style={{ color: 'var(--text-muted)', transform: contributorsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
                  </button>

                  {contributorsOpen && (
                    <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {CONTRIBUTORS.map(c => (
                        <div key={c.github} style={{
                          display: 'flex', gap: '0.75rem', alignItems: 'flex-start',
                          background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)',
                          padding: '0.65rem 0.75rem',
                          boxShadow: 'inset 0 0 0 1px var(--border-subtle)',
                        }}>
                          <img
                            src={`https://github.com/${c.github}.png?size=48`}
                            width={36} height={36}
                            style={{ borderRadius: '50%', flexShrink: 0, marginTop: 2 }}
                            alt={c.github}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
                              <button
                                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--accent)', fontWeight: 600, fontSize: 13 }}
                                onClick={() => openUrl(`https://github.com/${c.github}`)}
                              >
                                @{c.github}
                              </button>
                              <span style={{ fontSize: 10, background: 'var(--accent-dim)', color: 'var(--accent)', padding: '1px 6px', borderRadius: 99, fontWeight: 600 }}>
                                v{c.since}
                              </span>
                            </div>
                            <ul style={{ margin: 0, padding: '0 0 0 1rem', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
                              {c.contributions.map(item => <li key={item}>{item}</li>)}
                            </ul>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <span style={{ color: 'var(--text-muted)', minWidth: 56, flexShrink: 0, paddingTop: 2, fontSize: 13 }}>{t('settings.aboutSpecialThanksLabel')}</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1 }}>
                    {SPECIAL_THANKS.map(s => (
                      <div key={s.github} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <img
                          src={`https://github.com/${s.github}.png?size=32`}
                          width={22} height={22}
                          style={{ borderRadius: '50%', flexShrink: 0 }}
                          alt={s.github}
                        />
                        <button
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--accent)', fontWeight: 600, fontSize: 13 }}
                          onClick={() => openUrl(`https://github.com/${s.github}`)}
                        >
                          @{s.github}
                        </button>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>— {s.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem', flexWrap: 'wrap' }}>
                <button
                  className="btn btn-ghost"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => openUrl('https://github.com/Psychotoxical/psysonic')}
                >
                  <ExternalLink size={14} />
                  {t('settings.aboutRepo')}
                </button>
              </div>
            </div>
          </section>

          <ChangelogSection />
        </>
      )}
    </div>
  );
}

// ─── Changelog renderer ───────────────────────────────────────────────────────

function renderInline(text: string): React.ReactNode[] {
  // Splits on **bold**, *italic*, `code` and renders each part.
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*'))
      return <em key={i}>{part.slice(1, -1)}</em>;
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="changelog-code">{part.slice(1, -1)}</code>;
    return part;
  });
}

function HomeCustomizer() {
  const { t } = useTranslation();
  const { sections, toggleSection, reset } = useHomeStore();

  const SECTION_LABELS: Record<HomeSectionId, string> = {
    hero:            t('home.hero'),
    recent:          t('home.recent'),
    discover:        t('home.discover'),
    discoverArtists: t('home.discoverArtists'),
    recentlyPlayed:  t('home.recentlyPlayed'),
    starred:         t('home.starred'),
    mostPlayed:      t('home.mostPlayed'),
  };

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <LayoutGrid size={18} />
        <h2>{t('settings.homeCustomizerTitle')}</h2>
      </div>
      <div style={{ position: 'relative' }}>
        <button
          className="btn btn-ghost"
          style={{ position: 'absolute', top: -22, right: 0, fontSize: 12, color: 'var(--text-muted)', padding: '2px 4px' }}
          onClick={reset}
          data-tooltip={t('settings.sidebarReset')}
        >
          <RotateCcw size={14} />
        </button>
        <div className="settings-card" style={{ padding: '4px 0' }}>
          {sections.map(sec => (
            <div key={sec.id} className="settings-toggle-row" style={{ padding: '8px 16px' }}>
              <span style={{ fontSize: 14 }}>{SECTION_LABELS[sec.id]}</span>
              <label className="toggle-switch" aria-label={SECTION_LABELS[sec.id]}>
                <input type="checkbox" checked={sec.visible} onChange={() => toggleSection(sec.id)} />
                <span className="toggle-track" />
              </label>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SidebarGripHandle({ idx, section, label }: { idx: number; section: 'library' | 'system'; label: string }) {
  const { t } = useTranslation();
  const { onMouseDown } = useDragSource(() => ({
    data: JSON.stringify({ type: 'sidebar_reorder', index: idx, section }),
    label,
  }));
  return (
    <span
      className="sidebar-customizer-grip"
      data-tooltip={t('settings.sidebarDrag')}
      data-tooltip-pos="right"
      onMouseDown={onMouseDown}
    >
      <GripVertical size={16} />
    </span>
  );
}

// ── Lyrics Sources Customizer ──────────────────────────────────────────────

const LYRICS_SOURCE_LABEL_KEYS: Record<LyricsSourceId, string> = {
  server:  'settings.lyricsSourceServer',
  lrclib:  'settings.lyricsSourceLrclib',
  netease: 'settings.lyricsSourceNetease',
};

type LyricsDropTarget = { idx: number; before: boolean } | null;

function LyricsSourceGripHandle({ idx, label }: { idx: number; label: string }) {
  const { t } = useTranslation();
  const { onMouseDown } = useDragSource(() => ({
    data: JSON.stringify({ type: 'lyrics_source_reorder', index: idx }),
    label,
  }));
  return (
    <span
      className="sidebar-customizer-grip"
      data-tooltip={t('settings.sidebarDrag')}
      data-tooltip-pos="right"
      onMouseDown={onMouseDown}
    >
      <GripVertical size={16} />
    </span>
  );
}

function LyricsSourcesCustomizer() {
  const { t } = useTranslation();
  const lyricsSources = useAuthStore(useShallow(s => s.lyricsSources));
  const setLyricsSources = useAuthStore(s => s.setLyricsSources);
  const { isDragging: isPsyDragging } = useDragDrop();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<LyricsDropTarget>(null);
  const dropTargetRef = useRef<LyricsDropTarget>(null);
  const sourcesRef = useRef(lyricsSources);
  sourcesRef.current = lyricsSources;

  useEffect(() => {
    if (!isPsyDragging) { dropTargetRef.current = null; setDropTarget(null); }
  }, [isPsyDragging]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onPsyDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;
      let parsed: { type?: string; index?: number };
      try { parsed = JSON.parse(detail.data as string); } catch { return; }
      if (parsed.type !== 'lyrics_source_reorder' || parsed.index == null) return;

      const fromIdx = parsed.index;
      const target = dropTargetRef.current;
      dropTargetRef.current = null; setDropTarget(null);
      if (!target) return;

      const insertBefore = target.before ? target.idx : target.idx + 1;
      if (insertBefore === fromIdx || insertBefore === fromIdx + 1) return;

      const next = [...sourcesRef.current];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(insertBefore > fromIdx ? insertBefore - 1 : insertBefore, 0, moved);
      setLyricsSources(next);
    };
    el.addEventListener('psy-drop', onPsyDrop);
    return () => el.removeEventListener('psy-drop', onPsyDrop);
  }, [setLyricsSources]);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPsyDragging || !containerRef.current) return;
    const rows = containerRef.current.querySelectorAll<HTMLElement>('[data-lyrics-idx]');
    let target: LyricsDropTarget = null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const idx = Number(row.dataset.lyricsIdx);
      if (e.clientY < rect.top + rect.height / 2) { target = { idx, before: true }; break; }
      target = { idx, before: false };
    }
    dropTargetRef.current = target;
    setDropTarget(target);
  };

  const toggleSource = (id: LyricsSourceId) => {
    setLyricsSources(sourcesRef.current.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s));
  };

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <Music2 size={18} />
        <h2>{t('settings.lyricsSourcesTitle')}</h2>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
        {t('settings.lyricsSourcesDesc')}
      </p>
      <div className="settings-card" style={{ padding: '4px 0' }} ref={containerRef} onMouseMove={handleMouseMove}>
        {lyricsSources.map((src, i) => {
          const label = t(LYRICS_SOURCE_LABEL_KEYS[src.id]);
          const isBefore = isPsyDragging && dropTarget?.idx === i && dropTarget.before;
          const isAfter  = isPsyDragging && dropTarget?.idx === i && !dropTarget.before;
          return (
            <div
              key={src.id}
              data-lyrics-idx={i}
              className="sidebar-customizer-row"
              style={{
                borderTop:    isBefore ? '2px solid var(--accent)' : undefined,
                borderBottom: isAfter  ? '2px solid var(--accent)' : undefined,
              }}
            >
              <LyricsSourceGripHandle idx={i} label={label} />
              <span style={{ flex: 1, fontSize: 14, opacity: src.enabled ? 1 : 0.45 }}>{label}</span>
              <label className="toggle-switch" aria-label={label}>
                <input type="checkbox" checked={src.enabled} onChange={() => toggleSource(src.id)} />
                <span className="toggle-track" />
              </label>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Sidebar Customizer ──────────────────────────────────────────────────────

type DropTarget = { idx: number; before: boolean; section: 'library' | 'system' } | null;

function SidebarCustomizer() {
  const { t } = useTranslation();
  const { items, setItems, toggleItem, reset } = useSidebarStore();
  const { isDragging: isPsyDragging } = useDragDrop();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const dropTargetRef = useRef<DropTarget>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const libraryItems = items.filter(cfg => ALL_NAV_ITEMS[cfg.id]?.section === 'library');
  const systemItems  = items.filter(cfg => ALL_NAV_ITEMS[cfg.id]?.section === 'system');

  useEffect(() => {
    if (!isPsyDragging) { dropTargetRef.current = null; setDropTarget(null); }
  }, [isPsyDragging]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onPsyDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;
      let parsed: { type?: string; index?: number; section?: string };
      try { parsed = JSON.parse(detail.data); } catch { return; }
      if (parsed.type !== 'sidebar_reorder' || parsed.index == null || !parsed.section) return;

      const fromIdx = parsed.index;
      const fromSection = parsed.section as 'library' | 'system';
      const target = dropTargetRef.current;
      dropTargetRef.current = null; setDropTarget(null);
      if (!target || target.section !== fromSection) return;

      const sectionItems = fromSection === 'library' ? [...libraryItems] : [...systemItems];
      const insertBefore = target.before ? target.idx : target.idx + 1;
      if (insertBefore === fromIdx || insertBefore === fromIdx + 1) return;

      const [moved] = sectionItems.splice(fromIdx, 1);
      sectionItems.splice(insertBefore > fromIdx ? insertBefore - 1 : insertBefore, 0, moved);

      // Merge reordered section back into flat items array
      const all = [...itemsRef.current];
      const positions = all.map((cfg, i) => ({ cfg, i }))
        .filter(({ cfg }) => ALL_NAV_ITEMS[cfg.id]?.section === fromSection)
        .map(({ i }) => i);
      positions.forEach((pos, i) => { all[pos] = sectionItems[i]; });
      setItems(all);
    };
    el.addEventListener('psy-drop', onPsyDrop);
    return () => el.removeEventListener('psy-drop', onPsyDrop);
  }, [libraryItems, systemItems, setItems]);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPsyDragging || !containerRef.current) return;
    const rows = containerRef.current.querySelectorAll<HTMLElement>('[data-sidebar-idx]');
    let target: DropTarget = null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const idx = Number(row.dataset.sidebarIdx);
      const section = row.dataset.sidebarSection as 'library' | 'system';
      if (e.clientY < rect.top + rect.height / 2) { target = { idx, before: true, section }; break; }
      target = { idx, before: false, section };
    }
    dropTargetRef.current = target;
    setDropTarget(target);
  };

  const renderRow = (cfg: SidebarItemConfig, localIdx: number, section: 'library' | 'system') => {
    const meta = ALL_NAV_ITEMS[cfg.id];
    if (!meta) return null;
    const Icon = meta.icon;
    const isBefore = isPsyDragging && dropTarget?.section === section && dropTarget.idx === localIdx && dropTarget.before;
    const isAfter  = isPsyDragging && dropTarget?.section === section && dropTarget.idx === localIdx && !dropTarget.before;
    return (
      <div
        key={cfg.id}
        data-sidebar-idx={localIdx}
        data-sidebar-section={section}
        className="sidebar-customizer-row"
        style={{
          borderTop:    isBefore ? '2px solid var(--accent)' : undefined,
          borderBottom: isAfter  ? '2px solid var(--accent)' : undefined,
        }}
      >
        <SidebarGripHandle idx={localIdx} section={section} label={t(meta.labelKey)} />
        <Icon size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 14 }}>{t(meta.labelKey)}</span>
        <label className="toggle-switch" aria-label={t(meta.labelKey)}>
          <input type="checkbox" checked={cfg.visible} onChange={() => toggleItem(cfg.id)} />
          <span className="toggle-track" />
        </label>
      </div>
    );
  };

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <PanelLeft size={18} />
        <h2>{t('settings.sidebarTitle')}</h2>
        <button
          className="btn btn-ghost"
          style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}
          onClick={reset}
          data-tooltip={t('settings.sidebarReset')}
        >
          <RotateCcw size={14} />
        </button>
      </div>
      <div ref={containerRef} onMouseMove={handleMouseMove} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {/* Library block */}
        <div className="settings-card" style={{ padding: '4px 0' }}>
          <div className="sidebar-customizer-block-label">{t('sidebar.library')}</div>
          {libraryItems.map((cfg, i) => renderRow(cfg, i, 'library'))}
        </div>
        {/* System block */}
        <div className="settings-card" style={{ padding: '4px 0' }}>
          <div className="sidebar-customizer-block-label">{t('sidebar.system')}</div>
          {systemItems.map((cfg, i) => renderRow(cfg, i, 'system'))}
          <div className="sidebar-customizer-fixed-hint">
            <span>{t('settings.sidebarFixed')}: {t('sidebar.nowPlaying')}, {t('sidebar.settings')}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function BackupSection() {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const path = await exportBackup();
      if (path) showToast(t('settings.backupSuccess'), 3000, 'info');
    } catch (e) {
      console.error('Export failed', e);
      showToast(t('settings.backupImportError'), 4000, 'error');
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    if (!window.confirm(t('settings.backupImportConfirm'))) return;
    setImporting(true);
    try {
      await importBackup();
      // importBackup reloads the page — this toast will briefly show before reload
      showToast(t('settings.backupImportSuccess'), 3000, 'info');
    } catch (e) {
      console.error('Import failed', e);
      showToast(t('settings.backupImportError'), 4000, 'error');
      setImporting(false);
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <HardDrive size={18} />
        <h2>{t('settings.backupTitle')}</h2>
      </div>

      {/* Export */}
      <div className="settings-card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
          <div>
            <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{t('settings.backupExport')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{t('settings.backupExportDesc')}</div>
          </div>
          <button
            className="btn btn-primary"
            onClick={handleExport}
            disabled={exporting}
            style={{ flexShrink: 0 }}
          >
            <Upload size={14} />
            {exporting ? '…' : t('settings.backupExport')}
          </button>
        </div>
      </div>

      {/* Import */}
      <div className="settings-card">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
          <div>
            <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{t('settings.backupImport')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{t('settings.backupImportDesc')}</div>
          </div>
          <button
            className="btn btn-surface"
            onClick={handleImport}
            disabled={importing}
            style={{ flexShrink: 0 }}
          >
            <Download size={14} />
            {importing ? '…' : t('settings.backupImport')}
          </button>
        </div>
      </div>
    </section>
  );
}

function ChangelogSection() {
  const { t } = useTranslation();
  const showChangelogOnUpdate = useAuthStore(s => s.showChangelogOnUpdate);
  const setShowChangelogOnUpdate = useAuthStore(s => s.setShowChangelogOnUpdate);

  const versions = useMemo(() => {
    const blocks = changelogRaw.split(/\n(?=## \[)/).filter(b => b.startsWith('## ['));
    return blocks.map(block => {
      const lines = block.split('\n');
      const headerLine = lines[0]; // e.g. "## [1.5.0] - 2026-03-18"
      const versionMatch = headerLine.match(/## \[([^\]]+)\]/);
      const dateMatch = headerLine.match(/- (\d{4}-\d{2}-\d{2})/);
      const version = versionMatch?.[1] ?? '';
      const date = dateMatch?.[1] ?? '';

      // Parse the rest into rendered lines
      const body = lines.slice(1).join('\n').trim();
      return { version, date, body };
    });
  }, []);

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <Info size={18} />
        <h2>{t('settings.changelog')}</h2>
      </div>
      <div className="settings-toggle-row" style={{ marginBottom: '1rem' }}>
        <div>
          <div style={{ fontWeight: 500 }}>{t('settings.showChangelogOnUpdate')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.showChangelogOnUpdateDesc')}</div>
        </div>
        <label className="toggle-switch" aria-label={t('settings.showChangelogOnUpdate')}>
          <input type="checkbox" checked={showChangelogOnUpdate} onChange={e => setShowChangelogOnUpdate(e.target.checked)} />
          <span className="toggle-track" />
        </label>
      </div>
      <div className="changelog-list">
        {versions.slice(0, 3).map(({ version, date, body }) => (
          <details key={version} className="changelog-entry" open={version === appVersion}>
            <summary className="changelog-summary">
              <span className="changelog-version">v{version}</span>
              <span className="changelog-date">{date}</span>
            </summary>
            <div className="changelog-body">
              {body.split('\n').map((line, i) => {
                if (line.startsWith('### ')) {
                  return <div key={i} className="changelog-h3">{renderInline(line.slice(4))}</div>;
                }
                if (line.startsWith('#### ')) {
                  return <div key={i} className="changelog-h4">{renderInline(line.slice(5))}</div>;
                }
                if (line.startsWith('- ')) {
                  return <div key={i} className="changelog-item">{renderInline(line.slice(2))}</div>;
                }
                if (line.trim() === '') return null;
                return <div key={i} className="changelog-text">{renderInline(line)}</div>;
              })}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

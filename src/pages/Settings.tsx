import React, { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { version as appVersion } from '../../package.json';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Wifi, WifiOff, Globe, Music2, Sliders, LogOut, CheckCircle2, FolderOpen,
  Palette, Server, Plus, Trash2, Eye, EyeOff, Info, ExternalLink, Shuffle, X, Play, Type, Keyboard, ChevronDown,
  GripVertical, PanelLeft, RotateCcw, LayoutGrid, AppWindow, HardDrive, Upload, Download, Waves, Star, Clock, ZoomIn, Sparkles, AlertTriangle, Maximize2, AudioLines, User, Lock,
  Users, UserPlus, Shield, Wand2, Search
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
import { usePlayerStore } from '../store/playerStore';
import { lastfmGetToken, lastfmAuthUrl, lastfmGetSession, lastfmGetUserInfo, LastfmUserInfo } from '../api/lastfm';
import LastfmIcon from '../components/LastfmIcon';
import CustomSelect from '../components/CustomSelect';
import SettingsSubSection from '../components/SettingsSubSection';
import { AboutPsysonicBrandHeader } from '../components/AboutPsysonicLol';
import { useLuckyMixAvailable } from '../hooks/useLuckyMixAvailable';
import ThemePicker, { THEME_GROUPS } from '../components/ThemePicker';
import { useShallow } from 'zustand/react/shallow';
import {
  useAuthStore,
  DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB,
  ServerProfile,
  MIX_MIN_RATING_FILTER_MAX_STARS,
  type SeekbarStyle,
  type LyricsSourceId,
  type LyricsSourceConfig,
  type LoggingMode,
  type LoudnessLufsPreset,
} from '../store/authStore';
import { SeekbarPreview } from '../components/WaveformSeek';
import { IS_LINUX, IS_MACOS, IS_WINDOWS } from '../utils/platform';
import { useThemeStore } from '../store/themeStore';
import { useFontStore, FontId } from '../store/fontStore';
import { useKeybindingsStore, KeyAction, formatBinding, buildInAppBinding } from '../store/keybindingsStore';
import { useGlobalShortcutsStore, GlobalAction, buildGlobalShortcut, formatGlobalShortcut } from '../store/globalShortcutsStore';
import { useSidebarStore, DEFAULT_SIDEBAR_ITEMS, SidebarItemConfig } from '../store/sidebarStore';
import { useArtistLayoutStore, type ArtistSectionId, type ArtistSectionConfig } from '../store/artistLayoutStore';
import { useHomeStore, HomeSectionId } from '../store/homeStore';
import { useDragDrop, useDragSource } from '../contexts/DragDropContext';
import { ALL_NAV_ITEMS } from '../config/navItems';
import { applySidebarDropReorder } from '../utils/sidebarNavReorder';
import { pingWithCredentials, scheduleInstantMixProbeForServer } from '../api/subsonic';
import {
  ndLogin, ndListUsers, ndCreateUser, ndUpdateUser, ndDeleteUser,
  ndListLibraries, ndSetUserLibraries,
  type NdUser, type NdLibrary,
} from '../api/navidromeAdmin';
import { switchActiveServer } from '../utils/switchActiveServer';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import ConfirmModal from '../components/ConfirmModal';
import { Trans, useTranslation } from 'react-i18next';
import Equalizer from '../components/Equalizer';
import StarRating from '../components/StarRating';
import { showAudiomuseNavidromeServerSetting } from '../utils/subsonicServerIdentity';
import {
  decodeServerMagicString,
  encodeServerMagicString,
  copyTextToClipboard,
  DECODED_PASSWORD_VISUAL_MASK,
  type ServerMagicPayload,
} from '../utils/serverMagicString';
import { shortHostFromServerUrl, serverListDisplayLabel } from '../utils/serverDisplayName';

const AUDIOBOOK_GENRES_DISPLAY = ['Hörbuch', 'Hoerbuch', 'Hörspiel', 'Hoerspiel', 'Audiobook', 'Audio Book', 'Spoken Word', 'Spokenword', 'Podcast', 'Kapitel', 'Thriller', 'Krimi', 'Speech', 'Fantasy', 'Comedy', 'Literature'];

const AUDIOMUSE_NV_PLUGIN_URL = 'https://github.com/NeptuneHub/AudioMuse-AI-NV-plugin';

const LOUDNESS_LUFS_BUTTON_ORDER: LoudnessLufsPreset[] = [-10, -12, -14, -16];

function LoudnessLufsButtonGroup(props: {
  value: LoudnessLufsPreset;
  onSelect: (v: LoudnessLufsPreset) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
      {LOUDNESS_LUFS_BUTTON_ORDER.map(v => (
        <button
          key={v}
          type="button"
          className={`btn ${props.value === v ? 'btn-primary' : 'btn-ghost'}`}
          style={{ fontSize: 12, padding: '3px 12px' }}
          onClick={() => props.onSelect(v)}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

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
      'Linux audio output device picker: stable watcher (disable false enumeration-miss resets), canonicalize ALSA name drift, ghost entry for unlisted device (PR #176)',
      'Opus audio playback via symphonia-adapter-libopus with bundled libopus (PR #183)',
      'CLI player controls with D-Bus forwarding, shell completions for bash/zsh, library/audio-device/instant-mix CLI commands, active server switcher in header (PR #187)',
      'Streaming playback stability: stream-first start, seek recovery, crossfade/gapless backup preload, hot-cache promotion (PR #200)',
      'ReplayGain values in Queue tech strip (PR #196)',
      'Playback source badge (offline / cache / stream) in Queue tech strip (PR #201)',
      'WebKitGTK wheel scroll mode: smooth (kinetic) default with optional linear toggle (PR #207)',
      'ArtistCardLocal i18n: use plural-aware artists.albumCount key instead of hardcoded German',
      'NixOS / flake install guide with Cachix setup (PR #209)',
      'Subsonic: align Rust HTTP UA with main WebView UA (PR #235)',
      'UI: overlay scrollbars, resizer hit-test, and Linux mini-wheel (PR #255)',
      'Server invites: magic-string paste, Navidrome admin share, add-user validation (PR #258)',
      'Linux: stop Wayland GTK drag proxy and PsyDnD ghost (PR #268)',
      'Sidebar: long-press drag to reorder and hide nav items (PR #269)',
      'Lucky Mix — instant queue from listening history, ratings, and AudioMuse similar tracks (PR #278)',
      'UI perf: fix spike when medulla-perch lines up with hair-fan gestures (PR #283)',
      'Navidrome smart playlists workflow in the Playlists page (PR #289)',
      'Loudness normalization — LUFS / EBU R128 analysis cache + persistent waveform store (PR #315)',
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
      'Apple Music-style scrolling lyrics with spring-physics scroll for fullscreen player and sidebar; per-style controls (PR #205)',
      'Golos Text and Unbounded fonts with Cyrillic support (PR #206)',
      'Fullscreen & sidebar lyrics: duration-based ease-out scroll animator replacing spring physics; bottom fade for plain lyrics (PR #214)',
      'Sidebar lyrics: YouLy+ source strings render in a single line (PR #215)',
    ],
  },
  {
    github: 'kveld9',
    since: '1.34.4',
    contributions: [
      'Spanish (es) translation — 964 strings (PR #159)',
      'Column-header sorting for albums & playlists (PR #160)',
      'Multi-select for albums, artists & playlists with bulk "Add to Playlist"; collapsible sidebar playlist section; infinite scroll on Artists page; "Remove from Playlist" in context menu (PR #168)',
      '3 visual toggles: cover art background, playlist cover photo, show bitrate badge (PR #181)',
      '8 community themes (AMOLED Black, Monochrome Dark, Amber Night, Phosphor Green, Midnight Blue, Rose Dark, Sepia Dark, Ice Blue) + waveform live theme update (PR #182)',
      'Favorites redesign: sortable columns, genre filter, age range filter, new columns (PR #184)',
      'Albums and playlist headers redesign with improved layout and theme integration (PR #186)',
      'Tracklist column picker overflow fix in AlbumTrackList (PR #188)',
      'Spotify CSV playlist import (PR #190)',
      'Context menu for songs in AdvancedSearch and SearchResults (PR #191)',
      'Tracklist column picker alignment and toggle fix across Favorites and PlaylistDetail (PR #192)',
      'CSV import: dynamic match threshold, cleaned title search, score display in report (PR #199)',
      'Discord Rich Presence: configurable text templates for details, state and album tooltip (PR #198)',
      'Click-to-toggle duration / remaining time in player bar with persisted preference (PR #212)',
      'Opt-in floating player bar with themed background, accent-colored border, rounded album art, and centered volume section (PR #216)',
      'Linux GPU-vendor auto-detection to configure the WebKitGTK DMA-BUF renderer (disabled on NVIDIA proprietary) (PR #217)',
      'Artist page: continue playback when starting top songs (PR #220)',
      'Floating player bar: scroll-padding fix (PR #221)',
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
  {
    github: 'peri4ko',
    since: '1.43.0',
    contributions: [
      'WebView2 idle hooks when Tauri windows are hidden — Windows GPU and compositor mitigation (PR #273)',
    ],
  },
  {
    github: 'Psychotoxical',
    since: '1.0.0',
    contributions: [
      'Initial app scaffold — Tauri v2 + React + Zustand + Subsonic protocol, multi-server auth (v1.0)',
      'Rust/rodio audio engine replacing Howler.js (v1.2)',
      'Waveform seekbar, MilkDrop visualizer, EQ bars (v1.3)',
      '10-band parametric equalizer with per-theme UI (v1.5)',
      'Replay Gain, Crossfade, Download Folder Modal (v1.6)',
      'Last.fm scrobbling, Similar Artists, Statistics page (v1.7)',
      'TooltipPortal + CustomSelect portal-based UI primitives (v1.7)',
      'Keybindings system + font picker (v1.9)',
      'Lyrics system with LRCLIB integration (v1.12)',
      'Queue management overhaul + DnD (v1.22)',
      'Advanced Search + Genre Mix overhaul (v1.23)',
      'Playlist Management — create/edit/cover upload, drag reorder (v1.24)',
      'Functional tray icon, Minimize to Tray, Sidebar customization (v1.25)',
      'Bulk Select, Song Info modal, Recently Played (v1.26)',
      'In-App Auto-Update + Configurable Home (v1.27)',
      'Infinite Queue + Start Radio + single-click play (v1.28)',
      'Internet Radio with fast-start, ICY metadata support (v1.29)',
      'Discord Rich Presence, offline bulk download, artist images, lazy loading (v1.30)',
      'AutoEQ integration, resizable tracklist columns (v1.31)',
      'Genre browser with filter + FLAC seek fix (v1.20)',
      'Fullscreen Player with dynamic accent color + mesh blobs (v1.34)',
      'Bit-perfect hi-res playback + underrun hardening (v1.34)',
      'Fullscreen lyrics overlay with FsArt crossfade (v1.34.1)',
      'Offline Mode (beta) + MPRIS seek (v1.18)',
      'NSIS Windows installer (v1.19)',
      'WCAG contrast audits across 60+ themes (v1.17-v1.34)',
      'Custom Linux title bar with now-playing display (v1.34)',
      'Device Sync — fixed cross-OS naming scheme + playlist folders (v1.40)',
      'macOS signing + notarization + Tauri auto-updater (v1.40)',
      'Mini player — floating window, custom titlebar, queue DnD, persistent geometry, keyboard shortcut, WebView2 lifecycle fix (PR #162, v1.42.x)',
      '67 themes across 8 groups (Mediaplayer, OS, Games, Movies, Series, Social Media, OSS Classics, Psysonic)',
      'Admin-gated User Management tab with per-user library assignment (PR #222)',
      'Comprehensive mobile UI overhaul (PR #238)',
      'Runtime log levels and debug log export (PR #241)',
      'ReplayGain Auto mode — picks track vs album gain from queue context (PR #242)',
      'Now-Playing Info tab with artist bio, song credits, Bandsintown tour dates (PR #244)',
      'Performance suite — search cover cache, DeviceSync N+1, Albums prefetch, Lyrics IDB, bundle splitting, Artists memo, Genres pagination (PRs #245-#251)',
      'Artist page — user-configurable section visibility and order (PR #254)',
      'Album enqueue via cover hover, context menu, multi-select toolbar (PR #256)',
      'Settings refactor — thematic tab regroup, accordion sub-sections, in-page search (PR #259)',
      'Navidrome admin API hardening (PR #260)',
      'Library deep links (psysonic2 scheme) — paste track/album/artist/queue (PR #261)',
      'Now-Playing redesign as info dashboard + draggable widget cards (PRs #266, #267)',
      'Sleep timer — circular ring + in-button countdown (PR #272)',
      'Streaming seek UI freeze + snapback fix (PR #236)',
      'Windows: tighten WebView2 idle hooks (follow-up to #273) (PR #276)',
      'Audio: defer chained-track volume to gapless transition (PR #277)',
      'Mini-player: portal volume popover so it cannot get clipped (PR #279)',
      'Mini-player: drop saved position when its monitor is gone (PR #280)',
      'Toolbar: swap Gapless / Infinite Queue icons (closes #274) (PR #284)',
      'Linux audio: prefer PipeWire / Pulse aliases over raw ALSA default (PR #288)',
      'Playlists: bulk-delete button in selection-mode header (PR #290)',
      'Home: refresh Mainstage when active server changes (PR #291)',
      'Search: enqueue on live-search click + reposition context menu on right-click (PR #298)',
      'Tracks library hub page (closes #299) (PR #300)',
      'Home: Discover Songs rail in Mainstage (PR #301)',
      'Search: right-click context menu on artist and album rows (PR #302)',
      'Unified SongRow + paginated song results in search pages (PR #303)',
      'Orbit — Multi-User Listen-Together merged to main (PR #304)',
      'Genres: tag-cloud refactor — log-scaled colour-tinted pills replace icon cards (PR #311)',
      'imageCache: per-component object URLs to fix the blob: load flood (PR #313)',
      'Queue: preserve scroll context on manual click (PR #314)',
      'Seekbar: split waveform style into truewave (analysed) + pseudowave (deterministic) (PR #316)',
      'Settings: restructure Normalization section for clarity (PR #317)',
      'Cross-device resume: flush play-queue position on pause + all exit paths (PR #318)',
    ],
  },
] as const;

const MAINTAINERS = [
  { github: 'Psychotoxical' },
  { github: 'cucadmuh' },
] as const;

type Tab =
  | 'library'
  | 'servers'
  | 'audio'
  | 'lyrics'
  | 'appearance'
  | 'personalisation'
  | 'integrations'
  | 'input'
  | 'storage'
  | 'system'
  | 'users';

// Legacy Tab-IDs die via Route-State oder persisted State noch aufschlagen koennen
// auf die neue Struktur mappen. Gibt es keinen Match, faellt die Settings-Page
// einfach auf 'library' zurueck.
const LEGACY_TAB_ALIAS: Record<string, Tab> = {
  general: 'library',
  server: 'servers',
};

function resolveTab(input: string | undefined | null): Tab {
  if (!input) return 'servers';
  const aliased = LEGACY_TAB_ALIAS[input];
  if (aliased) return aliased;
  const known: Tab[] = ['library', 'servers', 'audio', 'lyrics', 'appearance', 'personalisation', 'integrations', 'input', 'storage', 'system', 'users'];
  return (known as string[]).includes(input) ? (input as Tab) : 'servers';
}

// Statischer Suchindex ueber alle Sub-Sections aller Tabs. Mitpflegen, wenn eine
// neue SettingsSubSection hinzukommt — sonst taucht sie nicht in der Suche auf.
type SearchIndexEntry = { tab: Tab; titleKey: string; keywords?: string };
const SETTINGS_INDEX: SearchIndexEntry[] = [
  { tab: 'audio',          titleKey: 'settings.audioOutputDevice',        keywords: 'output device speakers headphones alsa wasapi coreaudio' },
  { tab: 'audio',          titleKey: 'settings.hiResTitle',               keywords: 'hi-res hires resampling bit depth sample rate dsd 24bit' },
  { tab: 'audio',          titleKey: 'settings.eqTitle',                  keywords: 'equalizer eq bass treble autoeq filter pre-gain' },
  { tab: 'audio',          titleKey: 'settings.playbackTitle',            keywords: 'playback crossfade gapless replaygain replay gain volume' },
  { tab: 'lyrics',         titleKey: 'settings.lyricsSourcesTitle',       keywords: 'lyrics sources providers lrclib netease server youlyplus karaoke standard static' },
  { tab: 'lyrics',         titleKey: 'settings.sidebarLyricsStyle',       keywords: 'lyrics scroll style classic apple music' },
  { tab: 'integrations',   titleKey: 'settings.lfmTitle',                 keywords: 'last.fm lastfm scrobble' },
  { tab: 'integrations',   titleKey: 'settings.discordRichPresence',      keywords: 'discord rich presence rpc' },
  { tab: 'integrations',   titleKey: 'settings.enableBandsintown',        keywords: 'bandsintown concerts tours events' },
  { tab: 'integrations',   titleKey: 'settings.nowPlayingEnabled',        keywords: 'now playing share dropdown presence' },
  { tab: 'personalisation',titleKey: 'settings.sidebarTitle',             keywords: 'sidebar nav navigation items reorder customize' },
  { tab: 'personalisation',titleKey: 'settings.artistLayoutTitle',        keywords: 'artist page layout sections order' },
  { tab: 'personalisation',titleKey: 'settings.homeCustomizerTitle',      keywords: 'home page customize sections' },
  { tab: 'library',        titleKey: 'settings.randomMixTitle',           keywords: 'random mix blacklist genre keywords filter audiobook' },
  { tab: 'library',        titleKey: 'settings.ratingsSectionTitle',      keywords: 'ratings stars skip threshold manual' },
  { tab: 'storage',        titleKey: 'settings.offlineDirTitle',          keywords: 'offline library download directory folder cache' },
  { tab: 'storage',        titleKey: 'settings.nextTrackBufferingTitle',  keywords: 'next track buffering preload hot cache streaming' },
  { tab: 'storage',        titleKey: 'settings.downloadsTitle',           keywords: 'downloads zip export archive folder' },
  { tab: 'appearance',     titleKey: 'settings.theme',                    keywords: 'theme color palette dark light' },
  { tab: 'appearance',     titleKey: 'settings.themeSchedulerTitle',      keywords: 'theme scheduler auto time dark mode sunset' },
  { tab: 'appearance',     titleKey: 'settings.visualOptionsTitle',       keywords: 'visual options animations effects titlebar mini player' },
  { tab: 'appearance',     titleKey: 'settings.uiScaleTitle',             keywords: 'ui scale zoom dpi size' },
  { tab: 'appearance',     titleKey: 'settings.font',                     keywords: 'font typography typeface' },
  { tab: 'appearance',     titleKey: 'settings.fsPlayerSection',          keywords: 'fullscreen player mesh blob' },
  { tab: 'appearance',     titleKey: 'settings.seekbarStyle',             keywords: 'seekbar progress bar waveform' },
  { tab: 'input',          titleKey: 'settings.inputKeybindingsTitle',    keywords: 'keybindings shortcuts hotkeys keyboard' },
  { tab: 'input',          titleKey: 'settings.globalShortcutsTitle',     keywords: 'global shortcuts hotkeys system-wide media keys' },
  { tab: 'system',         titleKey: 'settings.language',                 keywords: 'language locale translation i18n' },
  { tab: 'system',         titleKey: 'settings.behavior',                 keywords: 'behavior tray minimize close start smooth scroll linux' },
  { tab: 'system',         titleKey: 'settings.backupTitle',              keywords: 'backup export import settings restore' },
  { tab: 'system',         titleKey: 'settings.loggingTitle',             keywords: 'log logs diagnostic debug verbose' },
  { tab: 'system',         titleKey: 'settings.aboutTitle',               keywords: 'about version update changelog release notes' },
  { tab: 'system',         titleKey: 'settings.aboutContributorsLabel',   keywords: 'contributors credits maintainers' },
];

// Substring-first, Fuzzy-Fallback (alle Query-Zeichen in Reihenfolge im
// Haystack). Rueckgabe 0 = kein Match. Hoeher = besser.
function matchScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const idx = h.indexOf(n);
  if (idx >= 0) return 1000 - Math.min(999, idx);
  let hi = 0;
  for (const ch of n) {
    const j = h.indexOf(ch, hi);
    if (j < 0) return 0;
    hi = j + 1;
  }
  return Math.max(1, 100 - Math.min(99, hi - n.length));
}

function AddServerForm({
  onSave,
  onCancel,
  initialInvite = null,
}: {
  onSave: (data: Omit<ServerProfile, 'id'>) => void;
  onCancel: () => void;
  initialInvite?: ServerMagicPayload | null;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', url: '', username: '', password: '' });
  const [magicString, setMagicString] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [blockPasswordReveal, setBlockPasswordReveal] = useState(false);

  useEffect(() => {
    if (!initialInvite) return;
    setShowPass(false);
    setBlockPasswordReveal(true);
    setForm({
      name: (initialInvite.name && initialInvite.name.trim()) || shortHostFromServerUrl(initialInvite.url),
      url: initialInvite.url,
      username: initialInvite.username,
      password: initialInvite.password,
    });
    setMagicString(encodeServerMagicString(initialInvite));
  }, [initialInvite]);

  const update = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const handleMagicStringChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setMagicString(v);
    const trimmed = v.trim();
    const decoded = decodeServerMagicString(trimmed);
    if (decoded) {
      setShowPass(false);
      setBlockPasswordReveal(true);
      setForm({
        name: (decoded.name && decoded.name.trim()) || shortHostFromServerUrl(decoded.url),
        url: decoded.url,
        username: decoded.username,
        password: decoded.password,
      });
    }
  };

  const submit = () => {
    const ms = magicString.trim();
    if (ms) {
      const decoded = decodeServerMagicString(ms);
      if (!decoded) {
        showToast(t('login.magicStringInvalid'), 4000, 'error');
        return;
      }
      onSave({
        name: form.name.trim() || (decoded.name && decoded.name.trim()) || shortHostFromServerUrl(decoded.url),
        url: decoded.url,
        username: decoded.username,
        password: decoded.password,
      });
      return;
    }
    if (!form.url.trim()) return;
    onSave({
      name: form.name.trim() || form.url.trim(),
      url: form.url.trim(),
      username: form.username.trim(),
      password: form.password,
    });
  };

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
          <input
            className="input"
            type="text"
            value={form.username}
            onChange={update('username')}
            placeholder="admin"
            autoComplete="off"
            readOnly={blockPasswordReveal}
            style={blockPasswordReveal ? { cursor: 'default' } : undefined}
          />
        </div>
        <div className="form-group">
          <label style={{ fontSize: 13 }}>{t('settings.serverPassword')}</label>
          {blockPasswordReveal ? (
            <input
              className="input"
              type="text"
              readOnly
              value={DECODED_PASSWORD_VISUAL_MASK}
              autoComplete="off"
              aria-label={t('settings.serverPassword')}
              style={{ letterSpacing: '0.12em', cursor: 'default' }}
            />
          ) : (
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
          )}
        </div>
      </div>
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <label style={{ fontSize: 13 }}>{t('login.orMagicString')}</label>
        <input
          className="input"
          type="text"
          value={magicString}
          onChange={handleMagicStringChange}
          placeholder={t('login.magicStringPlaceholder')}
          autoComplete="off"
        />
      </div>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onCancel}>{t('common.cancel')}</button>
        <button
          className="btn btn-primary"
          onClick={submit}
        >
          {t('common.add')}
        </button>
      </div>
    </div>
  );
}

interface UserFormState {
  userName: string;
  name: string;
  email: string;
  password: string;
  isAdmin: boolean;
  libraryIds: number[];
}

function initialUserFormState(u: NdUser | undefined, allLibraries: NdLibrary[]): UserFormState {
  const defaultIds = allLibraries.map(l => l.id);
  return {
    userName: u?.userName ?? '',
    name: u?.name ?? '',
    email: u?.email ?? '',
    password: '',
    isAdmin: !!u?.isAdmin,
    libraryIds: u ? [...u.libraryIds] : defaultIds,
  };
}

function UserForm({
  initial,
  libraries,
  shareServerUrl,
  ndToken,
  onUsersDirty,
  onSave,
  onSaveAndGetMagic,
  onCancel,
  busy,
}: {
  initial: NdUser | null;
  libraries: NdLibrary[];
  shareServerUrl: string;
  ndToken: string;
  onUsersDirty?: () => void | Promise<void>;
  onSave: (form: UserFormState) => void;
  /** New user only: create on Navidrome then copy magic string to clipboard. */
  onSaveAndGetMagic?: (form: UserFormState) => void | Promise<void>;
  onCancel: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<UserFormState>(() => initialUserFormState(initial ?? undefined, libraries));
  const [showPass, setShowPass] = useState(false);
  const [magicGenBusy, setMagicGenBusy] = useState(false);
  const [showNewUserRequiredErrors, setShowNewUserRequiredErrors] = useState(false);
  const isEdit = !!initial;

  useEffect(() => {
    setShowNewUserRequiredErrors(false);
  }, [initial?.id]);

  useEffect(() => {
    if (!isEdit && form.userName.trim() && form.name.trim() && form.password.trim()) {
      setShowNewUserRequiredErrors(false);
    }
  }, [isEdit, form.userName, form.name, form.password]);

  const set = <K extends keyof UserFormState>(k: K, v: UserFormState[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const toggleLib = (id: number) =>
    setForm(f => ({
      ...f,
      libraryIds: f.libraryIds.includes(id)
        ? f.libraryIds.filter(x => x !== id)
        : [...f.libraryIds, id],
    }));

  const newUserPasswordOk = form.password.trim().length > 0;
  const canSave =
    form.userName.trim().length > 0 &&
    form.name.trim().length > 0 &&
    (isEdit || newUserPasswordOk) &&
    (form.isAdmin || form.libraryIds.length > 0);

  const generateMagicString = async () => {
    if (!shareServerUrl.trim() || !form.password.trim() || !initial || !ndToken.trim()) return;
    setMagicGenBusy(true);
    try {
      await ndUpdateUser(shareServerUrl.trim(), ndToken, initial.id, {
        userName: form.userName.trim(),
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        isAdmin: form.isAdmin,
      });
    } catch (e) {
      const msg = (e instanceof Error && e.message) ? e.message : (typeof e === 'string' ? e : null);
      showToast(msg ?? t('settings.userMgmtUpdateError'), 5000, 'error');
      return;
    } finally {
      setMagicGenBusy(false);
    }
    const str = encodeServerMagicString({
      url: shareServerUrl.trim(),
      username: form.userName.trim(),
      password: form.password,
      name: shortHostFromServerUrl(shareServerUrl),
    });
    const ok = await copyTextToClipboard(str);
    showToast(
      ok ? t('settings.userMgmtMagicStringCopied') : t('settings.userMgmtMagicStringCopyFailed'),
      ok ? 3000 : 5000,
      ok ? 'info' : 'error',
    );
    if (ok) void onUsersDirty?.();
  };

  const runSaveAndGetMagic = async () => {
    if (!onSaveAndGetMagic) return;
    if (!form.userName.trim() || !form.name.trim() || !form.password.trim()) {
      setShowNewUserRequiredErrors(true);
      showToast(t('settings.userMgmtValidationMissing'), 4000, 'error');
      return;
    }
    if (!form.isAdmin && form.libraryIds.length === 0 && libraries.length > 0) {
      showToast(t('settings.userMgmtLibrariesValidation'), 4000, 'error');
      return;
    }
    setMagicGenBusy(true);
    try {
      await onSaveAndGetMagic(form);
    } finally {
      setMagicGenBusy(false);
    }
  };

  const invalidNewUserCore =
    !isEdit && (!form.userName.trim() || !form.name.trim() || !form.password.trim());

  const trySave = () => {
    if (invalidNewUserCore) {
      setShowNewUserRequiredErrors(true);
      showToast(t('settings.userMgmtValidationMissing'), 4000, 'error');
      return;
    }
    onSave(form);
  };

  const markInvalid = showNewUserRequiredErrors && !isEdit;

  return (
    <div className="settings-card" style={{ marginBottom: '1.25rem' }}>
      <h3 style={{ fontWeight: 600, marginBottom: '1rem', fontSize: '14px' }}>
        {isEdit ? t('settings.userMgmtEditUserTitle') : t('settings.userMgmtAddUserTitle')}
      </h3>
      <div className="form-row" style={{ marginBottom: '0.75rem' }}>
        <div className="form-group">
          <label style={{ fontSize: 13 }}>
            {t('settings.userMgmtUsername')}
            {!isEdit && <span style={{ color: 'var(--text-muted)' }}> *</span>}
          </label>
          <input
            className="input"
            type="text"
            value={form.userName}
            onChange={e => set('userName', e.target.value)}
            disabled={isEdit}
            autoComplete="off"
            aria-invalid={markInvalid && !form.userName.trim()}
            style={markInvalid && !form.userName.trim() ? { borderColor: 'var(--danger)' } : undefined}
          />
        </div>
        <div className="form-group">
          <label style={{ fontSize: 13 }}>
            {t('settings.userMgmtName')}
            {!isEdit && <span style={{ color: 'var(--text-muted)' }}> *</span>}
          </label>
          <input
            className="input"
            type="text"
            value={form.name}
            onChange={e => set('name', e.target.value)}
            autoComplete="off"
            aria-invalid={markInvalid && !form.name.trim()}
            style={markInvalid && !form.name.trim() ? { borderColor: 'var(--danger)' } : undefined}
          />
        </div>
      </div>
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <label style={{ fontSize: 13 }}>{t('settings.userMgmtEmail')}</label>
        <input
          className="input"
          type="email"
          value={form.email}
          onChange={e => set('email', e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <label style={{ fontSize: 13 }}>
          {t('settings.userMgmtPassword')}
          {!isEdit && <span style={{ color: 'var(--text-muted)' }}> *</span>}
        </label>
        <div style={{ position: 'relative' }}>
          <input
            className="input"
            type={showPass ? 'text' : 'password'}
            value={form.password}
            onChange={e => set('password', e.target.value)}
            placeholder="••••••••"
            autoComplete="new-password"
            aria-invalid={markInvalid && !form.password.trim()}
            style={{
              paddingRight: '2.5rem',
              ...(markInvalid && !form.password.trim() ? { borderColor: 'var(--danger)' } : {}),
            }}
          />
          <button
            type="button"
            style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}
            onClick={() => setShowPass(v => !v)}
          >
            {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        {isEdit && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            {t('settings.userMgmtPasswordEditHint')}
          </div>
        )}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: '1rem' }}>
        <input
          type="checkbox"
          checked={form.isAdmin}
          onChange={e => set('isAdmin', e.target.checked)}
        />
        <Shield size={14} />
        {t('settings.userMgmtRoleAdmin')}
      </label>
      <div className="form-group" style={{ marginBottom: '1rem' }}>
        <label style={{ fontSize: 13, marginBottom: 6, display: 'block' }}>
          {t('settings.userMgmtLibraries')}
        </label>
        {form.isAdmin ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {t('settings.userMgmtLibrariesAdminHint')}
          </div>
        ) : libraries.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {t('settings.userMgmtLibrariesEmpty')}
          </div>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                maxHeight: 180,
                overflowY: 'auto',
                padding: '6px 8px',
                border: `1px solid ${form.libraryIds.length === 0 ? 'var(--danger)' : 'var(--border)'}`,
                borderRadius: 6,
              }}
            >
              {libraries.map(lib => (
                <label
                  key={lib.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', padding: '2px 0' }}
                >
                  <input
                    type="checkbox"
                    checked={form.libraryIds.includes(lib.id)}
                    onChange={() => toggleLib(lib.id)}
                  />
                  {lib.name}
                </label>
              ))}
            </div>
            {form.libraryIds.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>
                {t('settings.userMgmtLibrariesValidation')}
              </div>
            )}
          </>
        )}
      </div>
      {!form.isAdmin && !isEdit && onSaveAndGetMagic && shareServerUrl.trim() && ndToken.trim() && (
        <div style={{ marginBottom: '1rem' }}>
          <div
            role="note"
            style={{
              fontSize: 11,
              lineHeight: 1.45,
              marginBottom: 10,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 35%, transparent)',
              background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 10%, transparent)',
              color: 'var(--text-primary)',
            }}
          >
            {t('settings.userMgmtMagicStringPlaintextWarning')}
          </div>
          <button
            type="button"
            className="btn btn-surface"
            onClick={() => void runSaveAndGetMagic()}
            disabled={busy || magicGenBusy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <Wand2 size={16} />
            {t('settings.userMgmtSaveAndMagicString')}
          </button>
        </div>
      )}
      {!form.isAdmin && isEdit && shareServerUrl.trim() && form.password.trim().length > 0 && ndToken.trim() && (
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.45 }}>
            {t('settings.userMgmtMagicStringPasswordNavHint')}
          </div>
          <div
            role="note"
            style={{
              fontSize: 11,
              lineHeight: 1.45,
              marginBottom: 10,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 35%, transparent)',
              background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 10%, transparent)',
              color: 'var(--text-primary)',
            }}
          >
            {t('settings.userMgmtMagicStringPlaintextWarning')}
          </div>
          <button
            type="button"
            className="btn btn-surface"
            onClick={() => void generateMagicString()}
            disabled={busy || magicGenBusy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <Wand2 size={16} />
            {t('settings.userMgmtMagicStringGenerate')}
          </button>
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          {t('settings.userMgmtCancel')}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => trySave()}
          disabled={busy || (isEdit && !canSave)}
        >
          {t('settings.userMgmtSave')}
        </button>
      </div>
    </div>
  );
}

function formatLastSeen(iso: string | null | undefined, locale: string, neverLabel: string): string {
  if (!iso) return neverLabel;
  const t = new Date(iso).getTime();
  // Navidrome returns "0001-01-01T00:00:00Z" for never-accessed users → guard against bogus epochs.
  if (!Number.isFinite(t) || t < 1_000_000_000_000) return neverLabel;
  const diffSec = (t - Date.now()) / 1000;
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diffSec), 'second');
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 604800) return rtf.format(Math.round(diffSec / 86400), 'day');
  if (abs < 2592000) return rtf.format(Math.round(diffSec / 604800), 'week');
  if (abs < 31536000) return rtf.format(Math.round(diffSec / 2592000), 'month');
  return rtf.format(Math.round(diffSec / 31536000), 'year');
}

function UserManagementSection({
  serverUrl,
  token,
  currentUsername,
}: {
  serverUrl: string;
  token: string;
  currentUsername: string;
}) {
  const { t, i18n } = useTranslation();
  const [users, setUsers] = useState<NdUser[]>([]);
  const [libraries, setLibraries] = useState<NdLibrary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<NdUser | 'new' | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<NdUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [magicRowUser, setMagicRowUser] = useState<NdUser | null>(null);
  const [magicRowPassword, setMagicRowPassword] = useState('');
  const [magicRowSubmitting, setMagicRowSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Sequential, not parallel: nginx setups with churning upstream
      // keep-alive drop one of the two parallel TLS connections. Doing
      // users first then libraries keeps us on one connection at a time
      // and pairs cleanly with the nd_retry backoff on the Rust side.
      const list = await ndListUsers(serverUrl, token);
      const libs = await ndListLibraries(serverUrl, token).catch(() => [] as NdLibrary[]);
      setUsers([...list].sort((a, b) => a.userName.localeCompare(b.userName)));
      setLibraries([...libs].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e) {
      // Tauri invoke rejects with a plain string (our Rust returns Err(String)),
      // not an Error instance. Normalise so the surfaced message is the real
      // cause (e.g. "tls handshake eof") rather than the generic i18n fallback.
      const raw = typeof e === 'string'
        ? e
        : (e instanceof Error && e.message)
          ? e.message
          : '';
      const prefix = t('settings.userMgmtLoadError');
      setLoadError(raw ? `${prefix} ${raw}` : prefix);
    } finally {
      setLoading(false);
    }
  }, [serverUrl, token, t]);

  useEffect(() => { void load(); }, [load]);

  const handleSave = async (form: UserFormState) => {
    const userName = form.userName.trim();
    const name = form.name.trim();
    const email = form.email.trim();
    if (editing === 'new') {
      if (!userName || !name || !form.password.trim()) {
        showToast(t('settings.userMgmtValidationMissing'), 4000, 'error');
        return;
      }
    } else if (editing) {
      if (!userName || !name) {
        showToast(t('settings.userMgmtValidationMissingIdentity'), 4000, 'error');
        return;
      }
    }
    if (!form.isAdmin && form.libraryIds.length === 0 && libraries.length > 0) {
      showToast(t('settings.userMgmtLibrariesValidation'), 4000, 'error');
      return;
    }
    if (!token) return;
    setBusy(true);
    try {
      let targetId: string;
      if (editing === 'new') {
        const created = await ndCreateUser(serverUrl, token, {
          userName, name, email, password: form.password, isAdmin: form.isAdmin,
        });
        targetId = created.id;
        showToast(t('settings.userMgmtCreated'), 3000, 'info');
      } else if (editing) {
        await ndUpdateUser(serverUrl, token, editing.id, {
          userName, name, email, password: form.password, isAdmin: form.isAdmin,
        });
        targetId = editing.id;
        showToast(t('settings.userMgmtUpdated'), 3000, 'info');
      } else {
        return;
      }
      if (!form.isAdmin && form.libraryIds.length > 0) {
        try {
          await ndSetUserLibraries(serverUrl, token, targetId, form.libraryIds);
        } catch (e) {
          const msg = (e instanceof Error && e.message) ? e.message : String(e);
          showToast(`${t('settings.userMgmtLibrariesUpdateError')}: ${msg}`, 5000, 'error');
        }
      }
      setEditing(null);
      await load();
    } catch (e) {
      const msg = (e instanceof Error && e.message) ? e.message : (typeof e === 'string' ? e : null);
      const fallback = editing === 'new'
        ? t('settings.userMgmtCreateError')
        : t('settings.userMgmtUpdateError');
      showToast(msg ?? fallback, 5000, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveAndGetMagic = async (form: UserFormState) => {
    if (editing !== 'new' || form.isAdmin) return;
    const userName = form.userName.trim();
    const name = form.name.trim();
    const email = form.email.trim();
    if (!userName || !name || !form.password.trim()) {
      showToast(t('settings.userMgmtValidationMissing'), 4000, 'error');
      return;
    }
    if (!form.isAdmin && form.libraryIds.length === 0 && libraries.length > 0) {
      showToast(t('settings.userMgmtLibrariesValidation'), 4000, 'error');
      return;
    }
    if (!token) return;
    setBusy(true);
    try {
      const created = await ndCreateUser(serverUrl, token, {
        userName, name, email, password: form.password, isAdmin: form.isAdmin,
      });
      const targetId = created.id;
      showToast(t('settings.userMgmtCreated'), 3000, 'info');
      if (!form.isAdmin && form.libraryIds.length > 0) {
        try {
          await ndSetUserLibraries(serverUrl, token, targetId, form.libraryIds);
        } catch (e) {
          const msg = (e instanceof Error && e.message) ? e.message : String(e);
          showToast(`${t('settings.userMgmtLibrariesUpdateError')}: ${msg}`, 5000, 'error');
        }
      }
      const str = encodeServerMagicString({
        url: serverUrl.trim(),
        username: userName,
        password: form.password,
        name: shortHostFromServerUrl(serverUrl),
      });
      const ok = await copyTextToClipboard(str);
      showToast(
        ok ? t('settings.userMgmtMagicStringCopied') : t('settings.userMgmtMagicStringCopyFailed'),
        ok ? 3000 : 5000,
        ok ? 'info' : 'error',
      );
      setEditing(null);
      await load();
    } catch (e) {
      const msg = (e instanceof Error && e.message) ? e.message : (typeof e === 'string' ? e : null);
      showToast(msg ?? t('settings.userMgmtCreateError'), 5000, 'error');
    } finally {
      setBusy(false);
    }
  };

  const performDelete = async (u: NdUser) => {
    if (!token) return;
    setConfirmingDelete(null);
    setBusy(true);
    try {
      await ndDeleteUser(serverUrl, token, u.id);
      showToast(t('settings.userMgmtDeleted'), 3000, 'info');
      await load();
    } catch (e) {
      const msg = (e instanceof Error && e.message) ? e.message : (typeof e === 'string' ? e : t('settings.userMgmtDeleteError'));
      showToast(msg, 5000, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <Users size={18} />
        <h2>{t('settings.userMgmtTitle')}</h2>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
        {t('settings.userMgmtDesc')}
      </div>

      {loading && (
        <div className="settings-card" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="spinner" style={{ width: 14, height: 14 }} />
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>…</span>
        </div>
      )}

      {!loading && loadError && (
        <div
          className="settings-card"
          style={{
            color: 'var(--danger)',
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('settings.userMgmtLoadFriendly')}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', wordBreak: 'break-word' }}>{loadError}</div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void load()}
            style={{ flexShrink: 0 }}
          >
            <RotateCcw size={14} /> {t('settings.userMgmtRetry')}
          </button>
        </div>
      )}

      {!loading && !loadError && (
        <>
          {editing ? (
            <UserForm
              initial={editing === 'new' ? null : editing}
              libraries={libraries}
              shareServerUrl={serverUrl}
              ndToken={token}
              onUsersDirty={load}
              onSave={handleSave}
              onSaveAndGetMagic={editing === 'new' ? handleSaveAndGetMagic : undefined}
              onCancel={() => setEditing(null)}
              busy={busy}
            />
          ) : (
            <button
              className="btn btn-surface"
              style={{ marginBottom: '0.75rem' }}
              onClick={() => setEditing('new')}
              disabled={busy}
            >
              <UserPlus size={16} /> {t('settings.userMgmtAddUser')}
            </button>
          )}

          {users.length === 0 ? (
            <div className="settings-card" style={{ color: 'var(--text-muted)', fontSize: 14 }}>
              {t('settings.userMgmtEmpty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {users.map(u => {
                const isSelf = u.userName === currentUsername;
                const libNames = u.isAdmin
                  ? null
                  : u.libraryIds.length === 0
                    ? t('settings.userMgmtNoLibraries')
                    : libraries.filter(l => u.libraryIds.includes(l.id)).map(l => l.name).join(', ');
                const lastSeen = formatLastSeen(u.lastAccessAt, i18n.language, t('settings.userMgmtNeverSeen'));
                const lastSeenAbsolute = u.lastAccessAt
                  ? new Date(u.lastAccessAt).toLocaleString(i18n.language)
                  : '';
                return (
                  <div
                    key={u.id}
                    className="settings-card user-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => { if (!busy) setEditing(u); }}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && !busy) {
                        e.preventDefault();
                        setEditing(u);
                      }
                    }}
                    style={{
                      padding: '6px 10px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      cursor: busy ? 'default' : 'pointer',
                    }}
                  >
                    <User size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, fontSize: 13, flexShrink: 0 }}>{u.userName}</span>
                    {u.name && u.name !== u.userName && (
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>· {u.name}</span>
                    )}
                    {isSelf && (
                      <span style={{ fontSize: 10, background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '1px 6px', borderRadius: 10, fontWeight: 600, flexShrink: 0 }}>
                        {t('settings.userMgmtYouBadge')}
                      </span>
                    )}
                    {u.isAdmin && (
                      <span
                        style={{ fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px', borderRadius: 10, fontWeight: 600, background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 22%, transparent)', color: 'var(--text-primary)', flexShrink: 0 }}
                        data-tooltip={t('settings.userMgmtRoleAdmin')}
                      >
                        <Shield size={10} />
                        {t('settings.userMgmtAdminBadge')}
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
                      {libNames || ''}
                    </span>
                    {!u.isAdmin && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ padding: '2px 6px', flexShrink: 0 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setMagicRowUser(u);
                          setMagicRowPassword('');
                        }}
                        disabled={busy}
                        data-tooltip={t('settings.userMgmtMagicStringGenerate')}
                      >
                        <Wand2 size={14} />
                      </button>
                    )}
                    <span
                      style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}
                      data-tooltip={lastSeenAbsolute || undefined}
                    >
                      {lastSeen}
                    </span>
                    <button
                      className="btn btn-ghost"
                      style={{ color: 'var(--danger)', padding: '2px 6px', flexShrink: 0 }}
                      onClick={(e) => { e.stopPropagation(); setConfirmingDelete(u); }}
                      disabled={busy || isSelf}
                      data-tooltip={t('settings.userMgmtDelete')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      <ConfirmModal
        open={!!confirmingDelete}
        title={t('settings.userMgmtDelete')}
        message={confirmingDelete
          ? t('settings.userMgmtConfirmDelete', { username: confirmingDelete.userName })
          : ''}
        confirmLabel={t('settings.userMgmtDelete')}
        cancelLabel={t('settings.userMgmtCancel')}
        danger
        onConfirm={() => { if (confirmingDelete) void performDelete(confirmingDelete); }}
        onCancel={() => setConfirmingDelete(null)}
      />
      {magicRowUser && createPortal(
        <div
          className="modal-overlay"
          onClick={() => !magicRowSubmitting && setMagicRowUser(null)}
          role="dialog"
          aria-modal="true"
          style={{ alignItems: 'center', paddingTop: 0 }}
        >
          <div
            className="modal-content"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: '400px' }}
          >
            <button
              type="button"
              className="modal-close"
              onClick={() => !magicRowSubmitting && setMagicRowUser(null)}
              aria-label={t('settings.userMgmtCancel')}
            >
              <X size={18} />
            </button>
            <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-display)' }}>
              {t('settings.userMgmtMagicStringModalTitle')}
            </h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '0.75rem', lineHeight: 1.5, fontSize: 13 }}>
              {t('settings.userMgmtMagicStringModalDesc', { username: magicRowUser.userName })}
            </p>
            <p style={{ color: 'var(--text-muted)', marginBottom: '0.75rem', lineHeight: 1.45, fontSize: 12 }}>
              {t('settings.userMgmtMagicStringPasswordNavHint')}
            </p>
            <div
              role="note"
              style={{
                fontSize: 11,
                lineHeight: 1.45,
                marginBottom: '1rem',
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 35%, transparent)',
                background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 10%, transparent)',
                color: 'var(--text-primary)',
              }}
            >
              {t('settings.userMgmtMagicStringPlaintextWarning')}
            </div>
            <div className="form-group" style={{ marginBottom: '1.25rem' }}>
              <label style={{ fontSize: 13 }}>{t('settings.userMgmtPassword')}</label>
              <input
                className="input"
                type="password"
                value={magicRowPassword}
                onChange={e => setMagicRowPassword(e.target.value)}
                autoComplete="off"
                disabled={magicRowSubmitting}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => !magicRowSubmitting && setMagicRowUser(null)}
                disabled={magicRowSubmitting}
              >
                {t('settings.userMgmtCancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!magicRowPassword.trim() || magicRowSubmitting}
                onClick={() => {
                  if (!magicRowUser || !magicRowPassword.trim() || !token) return;
                  void (async () => {
                    setMagicRowSubmitting(true);
                    try {
                      await ndUpdateUser(serverUrl, token, magicRowUser.id, {
                        userName: magicRowUser.userName,
                        name: magicRowUser.name,
                        email: magicRowUser.email,
                        password: magicRowPassword.trim(),
                        isAdmin: magicRowUser.isAdmin,
                      });
                    } catch (e) {
                      const msg = (e instanceof Error && e.message) ? e.message : (typeof e === 'string' ? e : null);
                      showToast(msg ?? t('settings.userMgmtUpdateError'), 5000, 'error');
                      return;
                    } finally {
                      setMagicRowSubmitting(false);
                    }
                    const str = encodeServerMagicString({
                      url: serverUrl,
                      username: magicRowUser.userName,
                      password: magicRowPassword.trim(),
                      name: shortHostFromServerUrl(serverUrl),
                    });
                    const ok = await copyTextToClipboard(str);
                    showToast(
                      ok ? t('settings.userMgmtMagicStringCopied') : t('settings.userMgmtMagicStringCopyFailed'),
                      ok ? 3000 : 5000,
                      ok ? 'info' : 'error',
                    );
                    if (ok) {
                      setMagicRowUser(null);
                      setMagicRowPassword('');
                      await load();
                    }
                  })();
                }}
              >
                {t('settings.userMgmtMagicStringModalConfirm')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </section>
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
  const location = useLocation();
  const routeState = location.state;
  const { t, i18n } = useTranslation();

  const [activeTab, setActiveTab] = useState<Tab>(resolveTab((routeState as { tab?: string } | null)?.tab));
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<{ tab: Tab; titleKey: string; title: string; score: number }>>([]);
  const [selectedResultIdx, setSelectedResultIdx] = useState(0);
  const [pendingFocusTitle, setPendingFocusTitle] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResultsListRef = useRef<HTMLUListElement>(null);

  // Server-Liste DnD
  const psyDragState = useDragDrop();
  const [serverContainerEl, setServerContainerEl] = useState<HTMLDivElement | null>(null);
  const [serverDropTarget, setServerDropTarget] = useState<ServerDropTarget>(null);
  const serverDropTargetRef = useRef<ServerDropTarget>(null);
  const serversRef = useRef(auth.servers);
  serversRef.current = auth.servers;
  const [connStatus, setConnStatus] = useState<Record<string, 'idle' | 'testing' | 'ok' | 'error'>>({});
  const [showAddForm, setShowAddForm] = useState(false);
  const [pastedServerInvite, setPastedServerInvite] = useState<ServerMagicPayload | null>(null);
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
  const [fontPickerOpen, setFontPickerOpen] = useState(false);
  const [ndAdminAuth, setNdAdminAuth] = useState<{ token: string; serverUrl: string; username: string } | null>(null);
  const [ndAuthChecked, setNdAuthChecked] = useState(false);
  const addServerInviteAnchorRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!showAddForm || !pastedServerInvite) return;
    addServerInviteAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [showAddForm, pastedServerInvite]);

  useEffect(() => {
    const st = routeState as { openAddServerInvite?: ServerMagicPayload; tab?: Tab } | null;
    const inv = st?.openAddServerInvite;
    if (inv) {
      setPastedServerInvite(inv);
      setShowAddForm(true);
      setActiveTab('servers');
      navigate(
        { pathname: location.pathname, search: location.search, hash: location.hash },
        { replace: true, state: { tab: 'servers' as Tab } },
      );
      return;
    }
    if (st?.tab) setActiveTab(st.tab);
  }, [routeState, location.pathname, location.search, location.hash, navigate]);

  // Settings-Suche: matcht SETTINGS_INDEX gegen den Query (Substring + Fuzzy).
  // Ergebnis ist eine flache Liste; aktueller Tab zuerst, dann nach Score. Wenn
  // eine Query aktiv ist, wird der Tab-Content gerendert-nicht und stattdessen
  // die Ergebnisliste angezeigt.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    const scored = SETTINGS_INDEX.map(entry => {
      const title = t(entry.titleKey as any);
      const hay = entry.keywords ? `${title} ${entry.keywords}` : title;
      return { ...entry, title, score: matchScore(hay, q) };
    }).filter(e => e.score > 0);
    scored.sort((a, b) => {
      const aCurrent = a.tab === activeTab ? 1 : 0;
      const bCurrent = b.tab === activeTab ? 1 : 0;
      if (aCurrent !== bCurrent) return bCurrent - aCurrent;
      return b.score - a.score;
    });
    setSearchResults(scored);
    setSelectedResultIdx(0);
  }, [searchQuery, activeTab, t]);

  // Selektion ins Blickfeld scrollen (nur wenn das Item out-of-view ist).
  useEffect(() => {
    if (!searchQuery || searchResults.length === 0) return;
    const list = searchResultsListRef.current;
    if (!list) return;
    const item = list.children[selectedResultIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedResultIdx, searchQuery, searchResults.length]);

  // Ctrl/Cmd+F oeffnet die Settings-Suche (nur auf der Settings-Seite — dieser
  // Effect ist ja an Settings gebunden). Fokussiert das Feld auch wenn's schon
  // offen ist. preventDefault blockt die native WebKit-Find-Bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'f' && e.key !== 'F') return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.altKey || e.shiftKey) return;
      e.preventDefault();
      setSearchOpen(true);
      window.setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Nach Klick auf ein Ergebnis: Ziel-Sub-Section oeffnen, scrollen und kurz
  // highlighten, damit der User auf dem neuen Tab sofort weiss welcher Eintrag
  // gemeint war.
  useEffect(() => {
    if (!pendingFocusTitle) return;
    const el = document.querySelector<HTMLElement>(
      `[data-settings-search="${CSS.escape(pendingFocusTitle)}"]`,
    );
    if (!el) return;
    if (el instanceof HTMLDetailsElement) el.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('settings-sub-section--flash');
    // reflow, damit die Animation bei wiederholtem Klick auf dasselbe Ziel
    // erneut abspielt.
    void el.offsetWidth;
    el.classList.add('settings-sub-section--flash');
    const timer = window.setTimeout(() => {
      el.classList.remove('settings-sub-section--flash');
    }, 1500);
    setPendingFocusTitle(null);
    return () => window.clearTimeout(timer);
  }, [pendingFocusTitle, activeTab]);

  useEffect(() => {
    const server = auth.getActiveServer();
    setNdAuthChecked(false);
    if (!server) { setNdAdminAuth(null); setNdAuthChecked(true); return; }
    const serverUrl = (server.url.startsWith('http') ? server.url : `http://${server.url}`).replace(/\/$/, '');
    let cancelled = false;
    ndLogin(serverUrl, server.username, server.password)
      .then(res => {
        if (cancelled) return;
        setNdAdminAuth(res.isAdmin ? { token: res.token, serverUrl, username: server.username } : null);
      })
      .catch(() => { if (!cancelled) setNdAdminAuth(null); })
      .finally(() => { if (!cancelled) setNdAuthChecked(true); });
    return () => { cancelled = true; };
  }, [auth.activeServerId]);

  useEffect(() => {
    if (activeTab === 'users' && ndAuthChecked && ndAdminAuth === null) setActiveTab('servers');
  }, [activeTab, ndAdminAuth, ndAuthChecked]);

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
  // Skipped on macOS — the stream is pinned to the system default (see
  // audioOutputDeviceMacNotice) so there is no picker to populate.
  useEffect(() => {
    if (activeTab !== 'audio' || IS_MACOS) return;
    refreshAudioDevices();
  }, [activeTab, refreshAudioDevices]);

  // Keep device list + "current system output" mark in sync when the backend reopens the stream.
  useEffect(() => {
    if (activeTab !== 'audio' || IS_MACOS) return;
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

  const handleClearWaveformCache = useCallback(async () => {
    setClearing(true);
    try {
      const deleted = await invoke<number>('analysis_delete_all_waveforms');
      usePlayerStore.setState({
        waveformBins: null,
      });
      showToast(
        t('settings.waveformCacheCleared', { count: deleted }),
        3500,
        'success',
      );
    } catch (e) {
      console.error(e);
      showToast(t('settings.waveformCacheClearFailed'), 4500, 'error');
    } finally {
      setClearing(false);
    }
  }, [t]);

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

  // Clear drop target when drag ends
  useEffect(() => {
    if (!psyDragState.isDragging) {
      serverDropTargetRef.current = null;
      setServerDropTarget(null);
    }
  }, [psyDragState.isDragging]);

  // psy-drop listener for server reorder
  useEffect(() => {
    if (!serverContainerEl) return;
    const onPsyDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;
      let parsed: { type?: string; index?: number };
      try { parsed = JSON.parse(detail.data as string); } catch { return; }
      if (parsed.type !== 'server_reorder' || parsed.index == null) return;

      const fromIdx = parsed.index;
      const target = serverDropTargetRef.current;
      serverDropTargetRef.current = null; setServerDropTarget(null);
      if (!target) return;

      const insertBefore = target.before ? target.idx : target.idx + 1;
      if (insertBefore === fromIdx || insertBefore === fromIdx + 1) return;

      const next = [...serversRef.current];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(insertBefore > fromIdx ? insertBefore - 1 : insertBefore, 0, moved);
      auth.setServers(next);
    };
    serverContainerEl.addEventListener('psy-drop', onPsyDrop);
    return () => serverContainerEl.removeEventListener('psy-drop', onPsyDrop);
  }, [serverContainerEl, auth]);

  const handleServerDragMove = (e: React.MouseEvent) => {
    if (!psyDragState.isDragging || !serverContainerEl) return;
    const rows = serverContainerEl.querySelectorAll<HTMLElement>('[data-server-idx]');
    let target: ServerDropTarget = null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const idx = Number(row.dataset.serverIdx);
      if (e.clientY < rect.top + rect.height / 2) { target = { idx, before: true }; break; }
      target = { idx, before: false };
    }
    serverDropTargetRef.current = target;
    setServerDropTarget(target);
  };

  const switchToServer = async (server: ServerProfile) => {
    setConnStatus(s => ({ ...s, [server.id]: 'testing' }));
    const ok = await switchActiveServer(server);
    if (ok) {
      setConnStatus(s => ({ ...s, [server.id]: 'ok' }));
      // Auf der Servers-Seite bleiben, damit der User seinen Switch hier
      // sofort visuell bestaetigt sieht (gruener Check, aktiv-Badge).
    } else {
      setConnStatus(s => ({ ...s, [server.id]: 'error' }));
    }
  };

  const deleteServer = (server: ServerProfile) => {
    if (confirm(t('settings.confirmDeleteServer', { name: serverListDisplayLabel(server, auth.servers) }))) {
      auth.removeServer(server.id);
    }
  };

  const closeAddServerForm = () => {
    setShowAddForm(false);
    setPastedServerInvite(null);
  };

  const handleAddServer = async (data: Omit<ServerProfile, 'id'>) => {
    setShowAddForm(false);
    setPastedServerInvite(null);
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

  const exportRuntimeLogs = async () => {
    const suggestedName = `psysonic-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    const selected = await saveDialog({
      defaultPath: suggestedName,
      filters: [{ name: 'Log files', extensions: ['log', 'txt'] }],
      title: t('settings.loggingExport'),
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      const lines = await invoke<number>('export_runtime_logs', { path: selected });
      showToast(t('settings.loggingExportSuccess', { count: lines }), 3500, 'info');
    } catch (e) {
      console.error(e);
      showToast(t('settings.loggingExportError'), 4500, 'error');
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'servers',         label: t('settings.tabServers'),         icon: <Server size={15} /> },
    { id: 'library',         label: t('settings.tabLibrary'),         icon: <Music2 size={15} /> },
    { id: 'audio',           label: t('settings.tabAudio'),           icon: <AudioLines size={15} /> },
    { id: 'lyrics',          label: t('settings.tabLyrics'),          icon: <Music2 size={15} /> },
    { id: 'appearance',      label: t('settings.tabAppearance'),      icon: <Palette size={15} /> },
    { id: 'personalisation', label: t('settings.tabPersonalisation'), icon: <LayoutGrid size={15} /> },
    { id: 'integrations',    label: t('settings.tabIntegrations'),    icon: <Sparkles size={15} /> },
    { id: 'input',           label: t('settings.tabInput'),           icon: <Keyboard size={15} /> },
    { id: 'storage',         label: t('settings.tabStorage'),         icon: <HardDrive size={15} /> },
    { id: 'system',          label: t('settings.tabSystem'),          icon: <Info size={15} /> },
    ...(ndAdminAuth ? [{ id: 'users' as Tab, label: t('settings.tabUsers'), icon: <Users size={15} /> }] : []),
  ];

  return (
    <div className="content-body animate-fade-in">
      <div className="settings-header">
        <h1 className="page-title">{t('settings.title')}</h1>
        <div className="settings-search">
          {!searchOpen ? (
            <button
              type="button"
              className="icon-btn"
              onClick={() => setSearchOpen(true)}
              aria-label={t('settings.searchPlaceholder')}
              data-tooltip={t('settings.searchPlaceholder')}
              data-tooltip-pos="left"
            >
              <Search size={16} />
            </button>
          ) : (
            <div className="settings-search-wrap">
              <Search size={14} className="settings-search-icon" aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="search"
                className="input settings-search-input"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={`${t('settings.searchPlaceholder')} (${IS_MACOS ? '⌘F' : 'Ctrl+F'})`}
                aria-label={t('settings.searchPlaceholder')}
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Escape') {
                    setSearchQuery('');
                    setSearchOpen(false);
                    return;
                  }
                  if (searchResults.length === 0) return;
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSelectedResultIdx(i => Math.min(i + 1, searchResults.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSelectedResultIdx(i => Math.max(i - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const hit = searchResults[selectedResultIdx];
                    if (!hit) return;
                    setSearchQuery('');
                    setSearchOpen(false);
                    setPendingFocusTitle(hit.title);
                    setActiveTab(hit.tab);
                  }
                }}
              />
              <button
                type="button"
                className="settings-search-clear"
                onClick={() => { setSearchQuery(''); setSearchOpen(false); }}
                aria-label={t('common.clear')}
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

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

      {searchQuery && searchResults.length === 0 && (
        <div className="settings-search-empty" role="status">
          {t('settings.searchNoResults')}
        </div>
      )}

      {searchQuery && searchResults.length > 0 && (
        <ul ref={searchResultsListRef} className="settings-search-results">
          {searchResults.map((hit, idx) => {
            const tabLabelKey = TAB_LABEL_KEY[hit.tab];
            const selected = idx === selectedResultIdx;
            return (
              <li key={`${hit.tab}:${hit.titleKey}`}>
                <button
                  type="button"
                  className="settings-search-result-item"
                  data-selected={selected ? 'true' : undefined}
                  onMouseEnter={() => setSelectedResultIdx(idx)}
                  onClick={() => {
                    setSearchQuery('');
                    setSearchOpen(false);
                    setPendingFocusTitle(hit.title);
                    setActiveTab(hit.tab);
                  }}
                >
                  <span className="settings-search-result-badge">{t(tabLabelKey as any)}</span>
                  <span className="settings-search-result-title">{hit.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!searchQuery && <>
      {/* ── Audio ────────────────────────────────────────────────────────────── */}
      {activeTab === 'audio' && (
        <>
          {/* Audio Output Device */}
          <SettingsSubSection
            title={t('settings.audioOutputDevice')}
            icon={<AudioLines size={16} />}
            defaultOpen
          >
            <div className="settings-card">
              {IS_MACOS ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
                  {t('settings.audioOutputDeviceMacNotice')}
                </div>
              ) : (
                <>
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
                </>
              )}
            </div>
          </SettingsSubSection>

          {/* Native Hi-Res Playback */}
          <SettingsSubSection
            title={t('settings.hiResTitle')}
            icon={<Waves size={16} />}
          >
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
          </SettingsSubSection>

          {/* Equalizer */}
          <SettingsSubSection
            title={t('settings.eqTitle')}
            icon={<Sliders size={16} />}
          >
            <div className="settings-card">
              <Equalizer />
            </div>
          </SettingsSubSection>

          {/* Replay Gain + Crossfade + Gapless */}
          <SettingsSubSection
            title={t('settings.playbackTitle')}
            icon={<Music2 size={16} />}
          >
            <div className="settings-card">
              {/* Normalization */}
              <div style={{ marginBottom: '0.6rem' }}>
                <div style={{ fontWeight: 500 }}>{t('settings.normalization', { defaultValue: 'Normalization' })}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  {t('settings.normalizationDesc')}
                </div>
              </div>
              <div className="settings-segmented" style={{ marginBottom: auth.normalizationEngine === 'off' ? 0 : '0.85rem' }}>
                <button
                  type="button"
                  className={`btn ${auth.normalizationEngine === 'off' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => {
                    auth.setReplayGainEnabled(false);
                    auth.setNormalizationEngine('off');
                  }}
                >
                  {t('settings.normalizationOff')}
                </button>
                <button
                  type="button"
                  className={`btn ${auth.normalizationEngine === 'replaygain' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => {
                    auth.setReplayGainEnabled(true);
                    auth.setNormalizationEngine('replaygain');
                  }}
                >
                  {t('settings.normalizationReplayGain')}
                </button>
                <button
                  type="button"
                  className={`btn ${auth.normalizationEngine === 'loudness' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => {
                    auth.setReplayGainEnabled(false);
                    if (auth.normalizationEngine !== 'loudness') auth.setLoudnessTargetLufs(-12);
                    auth.setNormalizationEngine('loudness');
                  }}
                >
                  {t('settings.normalizationLufs')}
                </button>
              </div>
              {auth.normalizationEngine === 'replaygain' && (
                <div className="settings-norm-block">
                  <div className="settings-norm-field">
                    <div className="settings-norm-row">
                      <span className="settings-norm-label">{t('settings.replayGainMode')}</span>
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        <button
                          className={`btn ${auth.replayGainMode === 'auto' ? 'btn-primary' : 'btn-ghost'}`}
                          style={{ fontSize: 12, padding: '4px 14px' }}
                          onClick={() => auth.setReplayGainMode('auto')}
                        >
                          {t('settings.replayGainAuto')}
                        </button>
                        <button
                          className={`btn ${auth.replayGainMode === 'track' ? 'btn-primary' : 'btn-ghost'}`}
                          style={{ fontSize: 12, padding: '4px 14px' }}
                          onClick={() => auth.setReplayGainMode('track')}
                        >
                          {t('settings.replayGainTrack')}
                        </button>
                        <button
                          className={`btn ${auth.replayGainMode === 'album' ? 'btn-primary' : 'btn-ghost'}`}
                          style={{ fontSize: 12, padding: '4px 14px' }}
                          onClick={() => auth.setReplayGainMode('album')}
                        >
                          {t('settings.replayGainAlbum')}
                        </button>
                      </div>
                    </div>
                    {auth.replayGainMode === 'auto' && (
                      <div className="settings-norm-help">{t('settings.replayGainAutoDesc')}</div>
                    )}
                  </div>
                  <div className="settings-norm-field">
                    <div className="settings-norm-row">
                      <span className="settings-norm-label">{t('settings.replayGainPreGain')}</span>
                      <input
                        type="range" min={0} max={6} step={0.5}
                        value={auth.replayGainPreGainDb}
                        onChange={e => auth.setReplayGainPreGainDb(Number(e.target.value))}
                      />
                      <span className="settings-norm-value">
                        {auth.replayGainPreGainDb > 0 ? `+${auth.replayGainPreGainDb}` : auth.replayGainPreGainDb} dB
                      </span>
                    </div>
                    <div className="settings-norm-help">{t('settings.replayGainPreGainDesc')}</div>
                  </div>
                  <div className="settings-norm-field">
                    <div className="settings-norm-row">
                      <span className="settings-norm-label">{t('settings.replayGainFallback')}</span>
                      <input
                        type="range" min={-6} max={0} step={0.5}
                        value={auth.replayGainFallbackDb}
                        onChange={e => auth.setReplayGainFallbackDb(Number(e.target.value))}
                      />
                      <span className="settings-norm-value">
                        {auth.replayGainFallbackDb > 0 ? `+${auth.replayGainFallbackDb}` : auth.replayGainFallbackDb} dB
                      </span>
                    </div>
                    <div className="settings-norm-help">{t('settings.replayGainFallbackDesc')}</div>
                  </div>
                </div>
              )}
              {auth.normalizationEngine === 'loudness' && (
                <div className="settings-norm-block">
                  <div className="settings-norm-field">
                    <div className="settings-norm-row">
                      <span className="settings-norm-label">{t('settings.loudnessTargetLufs')}</span>
                      <LoudnessLufsButtonGroup value={auth.loudnessTargetLufs} onSelect={auth.setLoudnessTargetLufs} />
                    </div>
                    <div className="settings-norm-help">{t('settings.loudnessTargetLufsDesc')}</div>
                  </div>
                  <div className="settings-norm-field">
                    <div className="settings-norm-row">
                      <span className="settings-norm-label">{t('settings.loudnessPreAnalysisAttenuation')}</span>
                      <input
                        type="range"
                        min={-24}
                        max={0}
                        step={0.5}
                        value={auth.loudnessPreAnalysisAttenuationDb}
                        onChange={e => auth.setLoudnessPreAnalysisAttenuationDb(Number(e.target.value))}
                      />
                      <span className="settings-norm-value">
                        {auth.loudnessPreAnalysisAttenuationDb} dB
                      </span>
                      <button
                        type="button"
                        className="icon-btn"
                        style={{ flexShrink: 0 }}
                        disabled={
                          auth.loudnessPreAnalysisAttenuationDb === DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB
                        }
                        onClick={() => auth.resetLoudnessPreAnalysisAttenuationDbDefault()}
                        data-tooltip={t('settings.loudnessPreAnalysisAttenuationReset')}
                        aria-label={t('settings.loudnessPreAnalysisAttenuationReset')}
                      >
                        <RotateCcw size={15} />
                      </button>
                    </div>
                    <div className="settings-norm-help">{t('settings.loudnessPreAnalysisAttenuationDesc')}</div>
                  </div>
                  <div className="settings-norm-note">{t('settings.loudnessFirstPlayNote')}</div>
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
                <div style={{ paddingLeft: '1rem', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <input
                    type="range"
                    min={0.1}
                    max={10}
                    step={0.1}
                    value={auth.crossfadeSecs}
                    onChange={e => auth.setCrossfadeSecs(parseFloat(e.target.value))}
                    style={{ flex: 1, minWidth: 80, maxWidth: 200 }}
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
          </SettingsSubSection>

        </>
      )}

      {/* ── Lyrics ───────────────────────────────────────────────────────────── */}
      {activeTab === 'lyrics' && (
        <>
          <SettingsSubSection
            title={t('settings.lyricsSourcesTitle')}
            icon={<Music2 size={16} />}
            defaultOpen
          >
            <LyricsSourcesCustomizer />
          </SettingsSubSection>

          <SettingsSubSection
            title={t('settings.sidebarLyricsStyle')}
            icon={<AudioLines size={16} />}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {(['classic', 'apple'] as const).map(style => {
                const key = style === 'classic' ? 'Classic' : 'Apple';
                const other = style === 'classic' ? 'apple' : 'classic';
                return (
                  <div key={style} className="settings-card">
                    <div className="settings-toggle-row">
                      <div>
                        <div style={{ fontWeight: 500 }}>{t(`settings.sidebarLyricsStyle${key}` as any)}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t(`settings.sidebarLyricsStyle${key}Desc` as any)}</div>
                      </div>
                      <label className="toggle-switch" aria-label={t(`settings.sidebarLyricsStyle${key}` as any)}>
                        <input
                          type="checkbox"
                          checked={auth.sidebarLyricsStyle === style}
                          onChange={e => auth.setSidebarLyricsStyle(e.target.checked ? style : other)}
                        />
                        <span className="toggle-track" />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </SettingsSubSection>
        </>
      )}

      {/* ── Integrations ─────────────────────────────────────────────────────── */}
      {activeTab === 'integrations' && (
        <>
          <div
            className="settings-privacy-notice"
            role="note"
            aria-label={t('settings.integrationsPrivacyTitle')}
          >
            <AlertTriangle size={16} className="settings-privacy-notice-icon" aria-hidden="true" />
            <div>
              <div className="settings-privacy-notice-title">{t('settings.integrationsPrivacyTitle')}</div>
              <div
                className="settings-privacy-notice-body"
                // Enthaelt <strong> aus dem i18n-String — der Inhalt ist statisch
                // und kommt nur aus unseren Locales, kein User-Input.
                dangerouslySetInnerHTML={{ __html: t('settings.integrationsPrivacyBody') }}
              />
            </div>
          </div>

          {/* Last.fm */}
          <SettingsSubSection
            title={t('settings.lfmTitle')}
            icon={<LastfmIcon size={16} />}
            defaultOpen
          >
            <div className="settings-card">
              {auth.lastfmSessionKey ? (
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
          </SettingsSubSection>

          {/* Discord Rich Presence */}
          <SettingsSubSection
            title={t('settings.discordRichPresence')}
            icon={<Sparkles size={16} />}
          >
            <div className="settings-card">
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
                  <div className="settings-toggle-row">
                    <div>
                      <div style={{ fontWeight: 500 }}>{t('settings.discordAppleCovers')}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.discordAppleCoversDesc')}</div>
                    </div>
                    <label className="toggle-switch" aria-label={t('settings.discordAppleCovers')}>
                      <input type="checkbox" checked={auth.enableAppleMusicCoversDiscord} onChange={e => auth.setEnableAppleMusicCoversDiscord(e.target.checked)} />
                      <span className="toggle-track" />
                    </label>
                  </div>
                  <div className="settings-section-divider" />
                  <div style={{ paddingTop: 8 }}>
                    <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 8 }}>{t('settings.discordTemplates')}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>{t('settings.discordTemplatesDesc')}</div>
                    <div className="form-group" style={{ marginBottom: '0.75rem' }}>
                      <label style={{ fontSize: 12 }}>{t('settings.discordTemplateDetails')}</label>
                      <input
                        className="input"
                        type="text"
                        value={auth.discordTemplateDetails}
                        onChange={e => auth.setDiscordTemplateDetails(e.target.value)}
                        placeholder="{artist} - {title}"
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: '0.75rem' }}>
                      <label style={{ fontSize: 12 }}>{t('settings.discordTemplateState')}</label>
                      <input
                        className="input"
                        type="text"
                        value={auth.discordTemplateState}
                        onChange={e => auth.setDiscordTemplateState(e.target.value)}
                        placeholder="{album}"
                      />
                    </div>
                    <div className="form-group">
                      <label style={{ fontSize: 12 }}>{t('settings.discordTemplateLargeText')}</label>
                      <input
                        className="input"
                        type="text"
                        value={auth.discordTemplateLargeText}
                        onChange={e => auth.setDiscordTemplateLargeText(e.target.value)}
                        placeholder="{album}"
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </SettingsSubSection>

          {/* Bandsintown */}
          <SettingsSubSection
            title={t('settings.enableBandsintown')}
            icon={<Info size={16} />}
          >
            <div className="settings-card">
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.enableBandsintown')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.enableBandsintownDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.enableBandsintown')}>
                  <input type="checkbox" checked={auth.enableBandsintown} onChange={e => auth.setEnableBandsintown(e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
            </div>
          </SettingsSubSection>

          {/* Now-Playing Share (Navidrome) */}
          <SettingsSubSection
            title={t('settings.nowPlayingEnabled')}
            icon={<Wifi size={16} />}
          >
            <div className="settings-card">
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
          </SettingsSubSection>
        </>
      )}

      {/* ── Personalisation ──────────────────────────────────────────────────── */}
      {activeTab === 'personalisation' && (
        <>
          <SettingsSubSection
            title={t('settings.sidebarTitle')}
            icon={<PanelLeft size={16} />}
            defaultOpen
            action={
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px' }}
                onClick={() => useSidebarStore.getState().reset()}
                data-tooltip={t('settings.sidebarReset')}
                aria-label={t('settings.sidebarReset')}
              >
                <RotateCcw size={14} />
              </button>
            }
          >
            <SidebarCustomizer />
          </SettingsSubSection>

          <SettingsSubSection
            title={t('settings.artistLayoutTitle')}
            icon={<Users size={16} />}
            action={
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px' }}
                onClick={() => useArtistLayoutStore.getState().reset()}
                data-tooltip={t('settings.artistLayoutReset')}
                aria-label={t('settings.artistLayoutReset')}
              >
                <RotateCcw size={14} />
              </button>
            }
          >
            <ArtistLayoutCustomizer />
          </SettingsSubSection>

          <SettingsSubSection
            title={t('settings.homeCustomizerTitle')}
            icon={<LayoutGrid size={16} />}
            action={
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px' }}
                onClick={() => useHomeStore.getState().reset()}
                data-tooltip={t('settings.sidebarReset')}
                aria-label={t('settings.sidebarReset')}
              >
                <RotateCcw size={14} />
              </button>
            }
          >
            <HomeCustomizer />
          </SettingsSubSection>
        </>
      )}

      {/* ── Library (legacy 'general' + 'server') ────────────────────────────── */}
      {activeTab === 'library' && (
        <>
          {/* Random Mix Blacklist */}
          <SettingsSubSection
            title={t('settings.randomMixTitle')}
            icon={<Shuffle size={16} />}
            defaultOpen
          >
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

              <div className="settings-toggle-row" style={{ marginBottom: '1rem' }}>
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.luckyMixMenuTitle')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {t('settings.luckyMixMenuDesc')}
                  </div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.luckyMixMenuTitle')}>
                  <input
                    type="checkbox"
                    checked={auth.showLuckyMixMenu}
                    onChange={e => auth.setShowLuckyMixMenu(e.target.checked)}
                  />
                  <span className="toggle-track" />
                </label>
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
          </SettingsSubSection>

          {/* Ratings */}
          <SettingsSubSection
            title={t('settings.ratingsSectionTitle')}
            icon={<Star size={16} />}
          >
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
                      gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))',
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
          </SettingsSubSection>

        </>
      )}

      {/* ── Offline & Cache ──────────────────────────────────────────────────── */}
      {activeTab === 'storage' && (
        <>
          {/* Offline Library (In-App) — includes cache settings */}
          <SettingsSubSection
            title={t('settings.offlineDirTitle')}
            icon={<Download size={16} />}
            defaultOpen
          >
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
              <div style={{ marginTop: 8 }}>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 13 }}
                  onClick={handleClearWaveformCache}
                  disabled={clearing}
                >
                  <Trash2 size={14} /> {t('settings.waveformCacheClearBtn')}
                </button>
              </div>
            </div>
          </SettingsSubSection>

          {/* Buffering */}
          <SettingsSubSection
            title={t('settings.nextTrackBufferingTitle')}
            icon={<Download size={16} />}
          >
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
                  <div style={{ paddingLeft: '1rem', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
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
                    <div style={{ paddingLeft: '1rem', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                      <input
                        type="range"
                        min={5} max={120} step={5}
                        value={auth.preloadCustomSeconds}
                        onChange={e => auth.setPreloadCustomSeconds(parseInt(e.target.value))}
                        style={{ flex: 1, minWidth: 80, maxWidth: 200 }}
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
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      className="input"
                      type="text"
                      readOnly
                      value={auth.hotCacheDownloadDir || t('settings.hotCacheDirDefault')}
                      style={{ flex: 1, minWidth: 0, fontSize: 13, color: auth.hotCacheDownloadDir ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'default' }}
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
                      <input type="range" min={32} max={20000} step={32} value={snapHotCacheMb(auth.hotCacheMaxMb)} onChange={e => auth.setHotCacheMaxMb(parseInt(e.target.value, 10))} style={{ flex: 1, minWidth: 80, maxWidth: 200 }} id="hot-cache-max-mb-slider" />
                      <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 60 }}>{snapHotCacheMb(auth.hotCacheMaxMb)} MB</span>
                    </div>
                  </div>
                  <div style={{ marginTop: '0.75rem' }}>
                    <div style={{ fontWeight: 500, marginBottom: 6 }}>{t('settings.hotCacheDebounce')}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <input type="range" min={0} max={600} step={1} value={Math.min(600, Math.max(0, auth.hotCacheDebounceSec))} onChange={e => auth.setHotCacheDebounceSec(parseInt(e.target.value, 10))} style={{ flex: 1, minWidth: 80, maxWidth: 200 }} id="hot-cache-debounce-slider" />
                      <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 80 }}>
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
          </SettingsSubSection>

          {/* ZIP Export & Archiving */}
          <SettingsSubSection
            title={t('settings.downloadsTitle')}
            icon={<FolderOpen size={16} />}
          >
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
          </SettingsSubSection>
        </>
      )}

      {/* ── Appearance ───────────────────────────────────────────────────────── */}
      {activeTab === 'appearance' && (
        <>
          <SettingsSubSection
            title={t('settings.theme')}
            icon={<Palette size={16} />}
            defaultOpen
          >
            <div className="settings-card">
              {theme.enableThemeScheduler && (
                <div className="settings-hint settings-hint-info" style={{ marginBottom: '0.75rem' }}>
                  {t('settings.themeSchedulerActiveHint')}
                </div>
              )}
              <ThemePicker value={theme.theme} onChange={v => theme.setTheme(v as any)} />
            </div>
          </SettingsSubSection>

          <SettingsSubSection
            title={t('settings.themeSchedulerTitle')}
            icon={<Clock size={16} />}
          >
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
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
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
          </SettingsSubSection>

          <SettingsSubSection
            title={t('settings.visualOptionsTitle')}
            icon={<Palette size={16} />}
          >
            <div className="settings-card">
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.coverArtBackground')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.coverArtBackgroundSub')}</div>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={theme.enableCoverArtBackground} onChange={e => theme.setEnableCoverArtBackground(e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
              <div className="settings-section-divider" />
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.playlistCoverPhoto')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.playlistCoverPhotoSub')}</div>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={theme.enablePlaylistCoverPhoto} onChange={e => theme.setEnablePlaylistCoverPhoto(e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
              <div className="settings-section-divider" />
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.showBitrate')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.showBitrateSub')}</div>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={theme.showBitrate} onChange={e => theme.setShowBitrate(e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
              <div className="settings-section-divider" />
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.floatingPlayerBar')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.floatingPlayerBarSub')}</div>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={theme.floatingPlayerBar} onChange={e => theme.setFloatingPlayerBar(e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
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
                  <div style={{ fontWeight: 500 }}>{t('settings.showOrbitTrigger')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.showOrbitTriggerDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.showOrbitTrigger')}>
                  <input type="checkbox" checked={auth.showOrbitTrigger} onChange={e => auth.setShowOrbitTrigger(e.target.checked)} />
                  <span className="toggle-track" />
                </label>
              </div>
              {!IS_WINDOWS && (
                <>
                  <div className="settings-section-divider" />
                  <div className="settings-toggle-row">
                    <div>
                      <div style={{ fontWeight: 500 }}>{t('settings.preloadMiniPlayer')}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.preloadMiniPlayerDesc')}</div>
                    </div>
                    <label className="toggle-switch" aria-label={t('settings.preloadMiniPlayer')}>
                      <input
                        type="checkbox"
                        checked={auth.preloadMiniPlayer}
                        onChange={e => auth.setPreloadMiniPlayer(e.target.checked)}
                      />
                      <span className="toggle-track" />
                    </label>
                  </div>
                </>
              )}
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
            </div>
          </SettingsSubSection>

          <SettingsSubSection
            title={t('settings.uiScaleTitle')}
            icon={<ZoomIn size={16} />}
          >
            <div className="settings-card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.uiScaleLabel')}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', minWidth: 40, textAlign: 'right' }}>
                    {Math.round(fontStore.uiScale * 100)}%
                  </span>
                </div>
                {(() => {
                  const presets = [80, 90, 100, 110, 125, 150];
                  const currentPct = Math.round(fontStore.uiScale * 100);
                  let idx = presets.indexOf(currentPct);
                  if (idx < 0) {
                    // Snap legacy off-preset values to the closest preset.
                    idx = presets.reduce((best, p, i) =>
                      Math.abs(p - currentPct) < Math.abs(presets[best] - currentPct) ? i : best, 0);
                  }
                  return (
                    <>
                      <input
                        type="range"
                        min={0}
                        max={presets.length - 1}
                        step={1}
                        value={idx}
                        onChange={e => fontStore.setUiScale(presets[parseInt(e.target.value, 10)] / 100)}
                        className="ui-scale-slider"
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        {presets.map(p => {
                          const active = currentPct === p;
                          return (
                            <button
                              key={p}
                              className="btn btn-ghost"
                              style={{
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
                    </>
                  );
                })()}
              </div>
            </div>
          </SettingsSubSection>

          <SettingsSubSection
            title={t('settings.font')}
            icon={<Type size={16} />}
          >
            <div className="settings-card">
              <button
                className="btn btn-ghost"
                style={{ justifyContent: 'space-between', width: '100%', fontFamily: 'var(--font-sans)' }}
                onClick={() => setFontPickerOpen(o => !o)}
              >
                <span>{
                  ([
                    { id: 'inter',             label: 'Inter' },
                    { id: 'outfit',            label: 'Outfit' },
                    { id: 'dm-sans',           label: 'DM Sans' },
                    { id: 'nunito',            label: 'Nunito' },
                    { id: 'rubik',             label: 'Rubik' },
                    { id: 'space-grotesk',     label: 'Space Grotesk' },
                    { id: 'figtree',           label: 'Figtree' },
                    { id: 'manrope',           label: 'Manrope' },
                    { id: 'plus-jakarta-sans', label: 'Plus Jakarta Sans' },
                    { id: 'lexend',            label: 'Lexend' },
                    { id: 'geist',             label: 'Geist' },
                    { id: 'jetbrains-mono',    label: 'JetBrains Mono' },
                    { id: 'golos-text',        label: 'Golos Text' },
                    { id: 'unbounded',         label: 'Unbounded' },
                  ] as { id: FontId; label: string }[]).find(f => f.id === fontStore.font)?.label ?? fontStore.font
                }</span>
                <ChevronDown size={14} style={{ color: 'var(--text-muted)', transform: fontPickerOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
              </button>
              {fontPickerOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                  {(
                    [
                      { id: 'inter',             label: 'Inter',             stack: "'Inter Variable', sans-serif" },
                      { id: 'outfit',            label: 'Outfit',            stack: "'Outfit Variable', sans-serif" },
                      { id: 'dm-sans',           label: 'DM Sans',           stack: "'DM Sans Variable', sans-serif" },
                      { id: 'nunito',            label: 'Nunito',            stack: "'Nunito Variable', sans-serif" },
                      { id: 'rubik',             label: 'Rubik',             stack: "'Rubik Variable', sans-serif" },
                      { id: 'space-grotesk',     label: 'Space Grotesk',     stack: "'Space Grotesk Variable', sans-serif" },
                      { id: 'figtree',           label: 'Figtree',           stack: "'Figtree Variable', sans-serif" },
                      { id: 'manrope',           label: 'Manrope',           stack: "'Manrope Variable', sans-serif" },
                      { id: 'plus-jakarta-sans', label: 'Plus Jakarta Sans', stack: "'Plus Jakarta Sans Variable', sans-serif" },
                      { id: 'lexend',            label: 'Lexend',            stack: "'Lexend Variable', sans-serif" },
                      { id: 'geist',             label: 'Geist',             stack: "'Geist Variable', sans-serif" },
                      { id: 'jetbrains-mono',    label: 'JetBrains Mono',    stack: "'JetBrains Mono Variable', monospace" },
                      { id: 'golos-text',        label: 'Golos Text',        stack: "'Golos Text Variable', sans-serif" },
                      { id: 'unbounded',         label: 'Unbounded',         stack: "'Unbounded Variable', sans-serif" },
                    ] as { id: FontId; label: string; stack: string }[]
                  ).map(f => (
                    <button
                      key={f.id}
                      className={`btn ${fontStore.font === f.id ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ justifyContent: 'flex-start', fontFamily: f.stack }}
                      onClick={() => { fontStore.setFont(f.id); setFontPickerOpen(false); }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </SettingsSubSection>

          <SettingsSubSection
            title={t('settings.fsPlayerSection')}
            icon={<Maximize2 size={16} />}
          >
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
          </SettingsSubSection>

          <SettingsSubSection
            title={t('settings.seekbarStyle')}
            icon={<Sliders size={16} />}
          >
            <div className="settings-card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                {t('settings.seekbarStyleDesc')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {(['truewave', 'pseudowave', 'linedot', 'bar', 'thick', 'segmented', 'neon', 'pulsewave', 'particletrail', 'liquidfill', 'retrotape'] as SeekbarStyle[]).map(style => (
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
          </SettingsSubSection>

        </>
      )}

      {/* ── Input ────────────────────────────────────────────────────────────── */}
      {activeTab === 'input' && (
        <>
        <SettingsSubSection
          title={t('settings.inputKeybindingsTitle')}
          icon={<Keyboard size={16} />}
          defaultOpen
          action={
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px' }}
              onClick={() => { kb.resetToDefaults(); setListeningFor(null); }}
              data-tooltip={t('settings.shortcutsReset')}
              aria-label={t('settings.shortcutsReset')}
            >
              <RotateCcw size={14} />
            </button>
          }
        >
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
                ['open-mini-player',  t('settings.shortcutOpenMiniPlayer')],
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
        </SettingsSubSection>

        <SettingsSubSection
          title={t('settings.globalShortcutsTitle')}
          icon={<Keyboard size={16} />}
          description={t('settings.globalShortcutsNote')}
          action={
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px' }}
              onClick={() => { gs.resetAll(); setListeningForGlobal(null); }}
              data-tooltip={t('settings.shortcutsReset')}
              aria-label={t('settings.shortcutsReset')}
            >
              <RotateCcw size={14} />
            </button>
          }
        >
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
        </SettingsSubSection>
        </>
      )}

      {/* ── Server ───────────────────────────────────────────────────────────── */}
      {activeTab === 'servers' && (
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
              <div
                ref={setServerContainerEl}
                onMouseMove={handleServerDragMove}
                style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
              >
                {auth.servers.map((srv, srvIdx) => {
                  const isActive = srv.id === auth.activeServerId;
                  const status = connStatus[srv.id];
                  const isBefore = psyDragState.isDragging && serverDropTarget?.idx === srvIdx && serverDropTarget.before;
                  const isAfter  = psyDragState.isDragging && serverDropTarget?.idx === srvIdx && !serverDropTarget.before;
                  return (
                    <div
                      key={srv.id}
                      data-server-idx={srvIdx}
                      className="settings-card"
                      style={{
                        border: isActive ? '1px solid var(--accent)' : undefined,
                        background: isActive ? 'color-mix(in srgb, var(--accent) 10%, var(--bg-card))' : undefined,
                        borderTop:    isBefore ? '2px solid var(--accent)' : undefined,
                        borderBottom: isAfter  ? '2px solid var(--accent)' : undefined,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'stretch', gap: '0.75rem' }}>
                        <ServerGripHandle idx={srvIdx} label={serverListDisplayLabel(srv, auth.servers)} />
                        <div style={{ flex: 1, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '2px' }}>
                            <span style={{ fontWeight: 600 }}>{serverListDisplayLabel(srv, auth.servers)}</span>
                            {isActive && (
                              <span style={{ fontSize: 11, background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '1px 6px', borderRadius: '10px', fontWeight: 600 }}>
                                {t('settings.serverActive')}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
                            {srv.url.startsWith('https://') && (
                              <Lock size={11} style={{ color: 'var(--positive)', flexShrink: 0 }} />
                            )}
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {srv.url.replace(/^https?:\/\//, '')}
                            </span>
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 1 }}>
                            <User size={11} />
                            {srv.username}
                          </div>
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

            <div
              ref={addServerInviteAnchorRef}
              id="settings-add-server-anchor"
              style={{ scrollMarginTop: '12px' }}
            >
              {showAddForm ? (
                <AddServerForm
                  initialInvite={pastedServerInvite}
                  onSave={handleAddServer}
                  onCancel={closeAddServerForm}
                />
              ) : (
                <button
                  className="btn btn-surface"
                  style={{ marginTop: '0.75rem' }}
                  onClick={() => {
                    setPastedServerInvite(null);
                    setShowAddForm(true);
                  }}
                  id="settings-add-server-btn"
                >
                  <Plus size={16} /> {t('settings.addServer')}
                </button>
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
      {activeTab === 'users' && ndAdminAuth && (
        <UserManagementSection
          serverUrl={ndAdminAuth.serverUrl}
          token={ndAdminAuth.token}
          currentUsername={ndAdminAuth.username}
        />
      )}

      {activeTab === 'system' && (
        <>
          <SettingsSubSection
            title={t('settings.language')}
            icon={<Globe size={16} />}
            defaultOpen
          >
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
          </SettingsSubSection>

          {/* App-Verhalten (aus altem library/general Behavior-Block) */}
          <SettingsSubSection
            title={t('settings.behavior')}
            icon={<AppWindow size={16} />}
          >
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
              {IS_LINUX && (
                <>
                  <div className="settings-section-divider" />
                  <div className="settings-toggle-row">
                    <div>
                      <div style={{ fontWeight: 500 }}>{t('settings.linuxWebkitSmoothScroll')}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.linuxWebkitSmoothScrollDesc')}</div>
                    </div>
                    <label className="toggle-switch" aria-label={t('settings.linuxWebkitSmoothScroll')}>
                      <input
                        type="checkbox"
                        checked={auth.linuxWebkitKineticScroll}
                        onChange={e => auth.setLinuxWebkitKineticScroll(e.target.checked)}
                      />
                      <span className="toggle-track" />
                    </label>
                  </div>
                </>
              )}
            </div>
          </SettingsSubSection>

          <SettingsSubSection
            title={t('settings.backupTitle')}
            icon={<HardDrive size={16} />}
          >
            <BackupSection />
          </SettingsSubSection>

          <SettingsSubSection
            title={t('settings.loggingTitle')}
            icon={<Sliders size={16} />}
          >
            <div className="settings-card">
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                {t('settings.loggingModeDesc')}
              </div>
              <CustomSelect
                value={auth.loggingMode}
                onChange={(v) => auth.setLoggingMode(v as LoggingMode)}
                options={[
                  { value: 'off', label: t('settings.loggingModeOff') },
                  { value: 'normal', label: t('settings.loggingModeNormal') },
                  { value: 'debug', label: t('settings.loggingModeDebug') },
                ]}
              />
              {auth.loggingMode === 'debug' && (
                <div style={{ marginTop: '0.75rem' }}>
                  <button className="btn btn-surface" onClick={exportRuntimeLogs}>
                    <Download size={14} />
                    {t('settings.loggingExport')}
                  </button>
                </div>
              )}
            </div>
          </SettingsSubSection>

          <SettingsSubSection
            title={t('settings.aboutTitle')}
            icon={<Info size={16} />}
          >
            <div className="settings-card settings-about">
              <AboutPsysonicBrandHeader appVersion={appVersion} aboutVersionLabel={t('settings.aboutVersion')} />

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
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-muted)', minWidth: 56, flexShrink: 0 }}>{t('settings.aboutMaintainersLabel')}</span>
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                    {MAINTAINERS.map(m => (
                      <div key={m.github} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <img
                          src={`https://github.com/${m.github}.png?size=32`}
                          width={20} height={20}
                          style={{ borderRadius: '50%', flexShrink: 0 }}
                          alt={m.github}
                        />
                        <button
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--accent)', fontWeight: 600, fontSize: 13 }}
                          onClick={() => openUrl(`https://github.com/${m.github}`)}
                        >
                          @{m.github}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <span style={{ color: 'var(--text-muted)', minWidth: 56 }}>{t('settings.aboutReleaseNotesLabel')}</span>
                  <button
                    onClick={() => {
                      useAuthStore.getState().setLastSeenChangelogVersion('');
                      navigate('/whats-new');
                    }}
                    style={{ color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                  >
                    {t('settings.aboutReleaseNotesLink')}
                  </button>
                </div>
              </div>

              <div className="settings-section-divider" style={{ marginTop: '1.25rem' }} />
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.showChangelogOnUpdate')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.showChangelogOnUpdateDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.showChangelogOnUpdate')}>
                  <input
                    type="checkbox"
                    checked={auth.showChangelogOnUpdate}
                    onChange={e => auth.setShowChangelogOnUpdate(e.target.checked)}
                  />
                  <span className="toggle-track" />
                </label>
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
          </SettingsSubSection>

          <SettingsSubSection
            title={t('settings.aboutContributorsLabel')}
            icon={<Users size={16} />}
          >
            <div className="contributors-grid">
              {[...CONTRIBUTORS].sort((a, b) => b.contributions.length - a.contributions.length).map(c => (
                <details key={c.github} className="contributor-card">
                  <summary className="contributor-card-summary">
                    <img
                      src={`https://github.com/${c.github}.png?size=48`}
                      width={32}
                      height={32}
                      className="contributor-card-avatar"
                      alt={c.github}
                    />
                    <div className="contributor-card-meta">
                      <span
                        className="contributor-card-name"
                        role="button"
                        tabIndex={0}
                        onClick={e => { e.stopPropagation(); openUrl(`https://github.com/${c.github}`); }}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.stopPropagation();
                            e.preventDefault();
                            openUrl(`https://github.com/${c.github}`);
                          }
                        }}
                      >
                        @{c.github}
                      </span>
                      <span className="contributor-card-sub">
                        <span className="contributor-card-since">v{c.since}</span>
                        <span>·</span>
                        <span>{t('settings.aboutContributorsCount', { count: c.contributions.length })}</span>
                      </span>
                    </div>
                    <ChevronDown size={14} className="contributor-card-chevron" aria-hidden />
                  </summary>
                  <ul className="contributor-card-list">
                    {c.contributions.map(item => <li key={item}>{item}</li>)}
                  </ul>
                </details>
              ))}
            </div>
          </SettingsSubSection>

        </>
      )}
      </>}
    </div>
  );
}

const TAB_LABEL_KEY: Record<Tab, string> = {
  library:         'settings.tabLibrary',
  servers:         'settings.tabServers',
  audio:           'settings.tabAudio',
  lyrics:          'settings.tabLyrics',
  appearance:      'settings.tabAppearance',
  personalisation: 'settings.tabPersonalisation',
  integrations:    'settings.tabIntegrations',
  input:           'settings.tabInput',
  storage:         'settings.tabStorage',
  system:          'settings.tabSystem',
  users:           'settings.tabUsers',
};

function HomeCustomizer() {
  const { t } = useTranslation();
  const { sections, toggleSection } = useHomeStore();

  const SECTION_LABELS: Record<HomeSectionId, string> = {
    hero:            t('home.hero'),
    recent:          t('home.recent'),
    discover:        t('home.discover'),
    discoverSongs:   t('home.discoverSongs'),
    discoverArtists: t('home.discoverArtists'),
    recentlyPlayed:  t('home.recentlyPlayed'),
    starred:         t('home.starred'),
    mostPlayed:      t('home.mostPlayed'),
  };

  return (
    <div className="settings-card" style={{ padding: '4px 0' }}>
      {sections.map(sec => (
        <div key={sec.id} className="sidebar-customizer-row">
          <span style={{ flex: 1, fontSize: 14 }}>{SECTION_LABELS[sec.id]}</span>
          <label className="toggle-switch" aria-label={SECTION_LABELS[sec.id]}>
            <input type="checkbox" checked={sec.visible} onChange={() => toggleSection(sec.id)} />
            <span className="toggle-track" />
          </label>
        </div>
      ))}
    </div>
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

type ServerDropTarget = { idx: number; before: boolean } | null;

function ServerGripHandle({ idx, label }: { idx: number; label: string }) {
  const { t } = useTranslation();
  const { onMouseDown } = useDragSource(() => ({
    data: JSON.stringify({ type: 'server_reorder', index: idx }),
    label,
  }));
  return (
    <span
      className="sidebar-customizer-grip"
      data-tooltip={t('settings.sidebarDrag')}
      data-tooltip-pos="right"
      onMouseDown={onMouseDown}
      onClick={e => e.stopPropagation()}
    >
      <GripVertical size={16} />
    </span>
  );
}

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
  const lyricsMode = useAuthStore(s => s.lyricsMode);
  const setLyricsMode = useAuthStore(s => s.setLyricsMode);
  const lyricsStaticOnly = useAuthStore(s => s.lyricsStaticOnly);
  const setLyricsStaticOnly = useAuthStore(s => s.setLyricsStaticOnly);
  const { isDragging: isPsyDragging } = useDragDrop();
  // useState (not useRef) so the listener-effect re-runs when the container
  // gets unmounted/remounted by the {lyricsMode === 'standard'} wrapper.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [dropTarget, setDropTarget] = useState<LyricsDropTarget>(null);
  const dropTargetRef = useRef<LyricsDropTarget>(null);
  const sourcesRef = useRef(lyricsSources);
  sourcesRef.current = lyricsSources;

  useEffect(() => {
    if (!isPsyDragging) { dropTargetRef.current = null; setDropTarget(null); }
  }, [isPsyDragging]);

  useEffect(() => {
    if (!containerEl) return;
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
    containerEl.addEventListener('psy-drop', onPsyDrop);
    return () => containerEl.removeEventListener('psy-drop', onPsyDrop);
  }, [containerEl, setLyricsSources]);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPsyDragging || !containerEl) return;
    const rows = containerEl.querySelectorAll<HTMLElement>('[data-lyrics-idx]');
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

      {/* Mode switch — standard three-provider pipeline vs. YouLyPlus karaoke.
          YouLyPlus misses silently fall back to the standard pipeline. */}
      <div className="settings-card" style={{ marginBottom: '0.75rem' }}>
        <div className="settings-toggle-row">
          <div>
            <div style={{ fontWeight: 500 }}>{t('settings.lyricsModeLyricsplus')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.lyricsModeLyricsplusDesc')}</div>
          </div>
          <label className="toggle-switch" aria-label={t('settings.lyricsModeLyricsplus')}>
            <input
              type="checkbox"
              checked={lyricsMode === 'lyricsplus'}
              onChange={e => { if (e.target.checked) setLyricsMode('lyricsplus'); else setLyricsMode('standard'); }}
            />
            <span className="toggle-track" />
          </label>
        </div>
      </div>
      <div className="settings-card" style={{ marginBottom: '0.75rem' }}>
        <div className="settings-toggle-row">
          <div>
            <div style={{ fontWeight: 500 }}>{t('settings.lyricsModeStandard')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.lyricsModeStandardDesc')}</div>
          </div>
          <label className="toggle-switch" aria-label={t('settings.lyricsModeStandard')}>
            <input
              type="checkbox"
              checked={lyricsMode === 'standard'}
              onChange={e => { if (e.target.checked) setLyricsMode('standard'); else setLyricsMode('lyricsplus'); }}
            />
            <span className="toggle-track" />
          </label>
        </div>
      </div>

      {lyricsMode === 'standard' && (
        <div
          className="settings-card"
          style={{ padding: '4px 0', marginBottom: '0.75rem', marginLeft: '1rem' }}
          ref={setContainerEl}
          onMouseMove={handleMouseMove}
        >
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
      )}

      {/* Static-only toggle — suppresses line/word tracking in both modes. */}
      <div className="settings-card" style={{ marginBottom: '0.75rem' }}>
        <div className="settings-toggle-row">
          <div>
            <div style={{ fontWeight: 500 }}>{t('settings.lyricsStaticOnly')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.lyricsStaticOnlyDesc')}</div>
          </div>
          <label className="toggle-switch" aria-label={t('settings.lyricsStaticOnly')}>
            <input type="checkbox" checked={lyricsStaticOnly} onChange={e => setLyricsStaticOnly(e.target.checked)} />
            <span className="toggle-track" />
          </label>
        </div>
      </div>
    </section>
  );
}

// ── Sidebar Customizer ──────────────────────────────────────────────────────

type DropTarget = { idx: number; before: boolean; section: 'library' | 'system' } | null;

function SidebarCustomizer() {
  const { t } = useTranslation();
  const { items, setItems, toggleItem } = useSidebarStore();
  const { isDragging: isPsyDragging } = useDragDrop();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const dropTargetRef = useRef<DropTarget>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const randomNavMode = useAuthStore(s => s.randomNavMode);
  const setRandomNavMode = useAuthStore(s => s.setRandomNavMode);
  const luckyMixBase = useLuckyMixAvailable();
  const luckyMixAvailable = luckyMixBase && randomNavMode === 'separate';

  const libraryItems = items.filter(cfg => {
    if (!ALL_NAV_ITEMS[cfg.id] || ALL_NAV_ITEMS[cfg.id].section !== 'library') return false;
    if (randomNavMode === 'hub' && (cfg.id === 'randomMix' || cfg.id === 'randomAlbums' || cfg.id === 'luckyMix')) return false;
    if (randomNavMode === 'separate' && cfg.id === 'randomPicker') return false;
    if (cfg.id === 'luckyMix' && !luckyMixAvailable) return false;
    return true;
  });
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

      const next = applySidebarDropReorder(itemsRef.current, fromSection, fromIdx, target, randomNavMode);
      if (next) setItems(next);
    };
    el.addEventListener('psy-drop', onPsyDrop);
    return () => el.removeEventListener('psy-drop', onPsyDrop);
  }, [libraryItems, systemItems, setItems, randomNavMode]);

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
    <>
      <div className="settings-card" style={{ marginBottom: '1rem' }}>
        <div className="settings-toggle-row">
          <div>
            <div style={{ fontWeight: 500 }}>{t('settings.randomNavSplitTitle')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.randomNavSplitDesc')}</div>
          </div>
          <label className="toggle-switch" aria-label={t('settings.randomNavSplitTitle')}>
            <input
              type="checkbox"
              checked={randomNavMode === 'separate'}
              onChange={e => setRandomNavMode(e.target.checked ? 'separate' : 'hub')}
            />
            <span className="toggle-track" />
          </label>
        </div>
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
    </>
  );
}

// ── Artist Page Sections Customizer ────────────────────────────────────────

const ARTIST_SECTION_LABEL_KEYS: Record<ArtistSectionId, string> = {
  bio:       'settings.artistLayoutBio',
  topTracks: 'settings.artistLayoutTopTracks',
  similar:   'settings.artistLayoutSimilar',
  albums:    'settings.artistLayoutAlbums',
  featured:  'settings.artistLayoutFeatured',
};

type ArtistDropTarget = { idx: number; before: boolean } | null;

function ArtistSectionGripHandle({ idx, label }: { idx: number; label: string }) {
  const { t } = useTranslation();
  const { onMouseDown } = useDragSource(() => ({
    data: JSON.stringify({ type: 'artist_section_reorder', index: idx }),
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

function ArtistLayoutCustomizer() {
  const { t } = useTranslation();
  const sections = useArtistLayoutStore(s => s.sections);
  const setSections = useArtistLayoutStore(s => s.setSections);
  const toggleSection = useArtistLayoutStore(s => s.toggleSection);
  const { isDragging: isPsyDragging } = useDragDrop();
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [dropTarget, setDropTarget] = useState<ArtistDropTarget>(null);
  const dropTargetRef = useRef<ArtistDropTarget>(null);
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  useEffect(() => {
    if (!isPsyDragging) { dropTargetRef.current = null; setDropTarget(null); }
  }, [isPsyDragging]);

  useEffect(() => {
    if (!containerEl) return;
    const onPsyDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;
      let parsed: { type?: string; index?: number };
      try { parsed = JSON.parse(detail.data as string); } catch { return; }
      if (parsed.type !== 'artist_section_reorder' || parsed.index == null) return;

      const fromIdx = parsed.index;
      const target = dropTargetRef.current;
      dropTargetRef.current = null; setDropTarget(null);
      if (!target) return;

      const insertBefore = target.before ? target.idx : target.idx + 1;
      if (insertBefore === fromIdx || insertBefore === fromIdx + 1) return;

      const next = [...sectionsRef.current];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(insertBefore > fromIdx ? insertBefore - 1 : insertBefore, 0, moved);
      setSections(next);
    };
    containerEl.addEventListener('psy-drop', onPsyDrop);
    return () => containerEl.removeEventListener('psy-drop', onPsyDrop);
  }, [containerEl, setSections]);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPsyDragging || !containerEl) return;
    const rows = containerEl.querySelectorAll<HTMLElement>('[data-artist-idx]');
    let target: ArtistDropTarget = null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const idx = Number(row.dataset.artistIdx);
      if (e.clientY < rect.top + rect.height / 2) { target = { idx, before: true }; break; }
      target = { idx, before: false };
    }
    dropTargetRef.current = target;
    setDropTarget(target);
  };

  return (
    <>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
        {t('settings.artistLayoutDesc')}
      </p>
      <div
        className="settings-card"
        style={{ padding: '4px 0' }}
        ref={setContainerEl}
        onMouseMove={handleMouseMove}
      >
        {sections.map((section: ArtistSectionConfig, i) => {
          const label = t(ARTIST_SECTION_LABEL_KEYS[section.id]);
          const isBefore = isPsyDragging && dropTarget?.idx === i && dropTarget.before;
          const isAfter  = isPsyDragging && dropTarget?.idx === i && !dropTarget.before;
          return (
            <div
              key={section.id}
              data-artist-idx={i}
              className="sidebar-customizer-row"
              style={{
                borderTop:    isBefore ? '2px solid var(--accent)' : undefined,
                borderBottom: isAfter  ? '2px solid var(--accent)' : undefined,
              }}
            >
              <ArtistSectionGripHandle idx={i} label={label} />
              <span style={{ flex: 1, fontSize: 14, opacity: section.visible ? 1 : 0.45 }}>{label}</span>
              <label className="toggle-switch" aria-label={label}>
                <input type="checkbox" checked={section.visible} onChange={() => toggleSection(section.id)} />
                <span className="toggle-track" />
              </label>
            </div>
          );
        })}
      </div>
    </>
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


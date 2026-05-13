import type { ServerProfile, SeekbarStyle, LoggingMode, LoudnessLufsPreset } from '../store/authStoreTypes';
import React, { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { version as appVersion } from '../../package.json';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Wifi, WifiOff, Globe, Music2, Sliders, LogOut, CheckCircle2, FolderOpen,
  Palette, Server, Plus, Trash2, Eye, EyeOff, Info, ExternalLink, X, Type, Keyboard, ChevronDown,
  RotateCcw, LayoutGrid, AppWindow, HardDrive, Download, Clock, ZoomIn, Sparkles, AlertTriangle, Maximize2, AudioLines, User, Lock,
  Users, Search, Scale
} from 'lucide-react';
import i18n from '../i18n';
import { showToast } from '../utils/toast';
import { invoke } from '@tauri-apps/api/core';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { getImageCacheSize, clearImageCache } from '../utils/imageCache';
import { useOfflineStore } from '../store/offlineStore';
import { useHotCacheStore } from '../store/hotCacheStore';
import { usePlayerStore } from '../store/playerStore';
import CustomSelect from '../components/CustomSelect';
import SettingsSubSection from '../components/SettingsSubSection';
import LicensesPanel from '../components/LicensesPanel';
import { AboutPsysonicBrandHeader } from '../components/AboutPsysonicLol';
import ThemePicker, { THEME_GROUPS } from '../components/ThemePicker';
import { useAuthStore } from '../store/authStore';
import { SeekbarPreview } from '../components/WaveformSeek';
import { IS_LINUX, IS_MACOS, IS_WINDOWS } from '../utils/platform';
import { useThemeStore } from '../store/themeStore';
import { useFontStore, FontId } from '../store/fontStore';
import { useDragDrop } from '../contexts/DragDropContext';
import { AddServerForm } from '../components/settings/AddServerForm';
import { AudioTab } from '../components/settings/AudioTab';
import { BackupSection } from '../components/settings/BackupSection';
import { InputTab } from '../components/settings/InputTab';
import { IntegrationsTab } from '../components/settings/IntegrationsTab';
import { LibraryTab } from '../components/settings/LibraryTab';
import { LyricsTab } from '../components/settings/LyricsTab';
import { PersonalisationTab } from '../components/settings/PersonalisationTab';
import { ServerGripHandle } from '../components/settings/ServerGripHandle';
import { SETTINGS_INDEX, type Tab, matchScore, resolveTab } from '../components/settings/settingsTabs';
import { UserManagementSection } from '../components/settings/UserManagementSection';
import { CONTRIBUTORS, MAINTAINERS } from '../config/settingsCredits';
import { formatBytes, snapHotCacheMb } from '../utils/formatBytes';
import { pingWithCredentials, scheduleInstantMixProbeForServer } from '../api/subsonic';
import { ndLogin } from '../api/navidromeAdmin';
import { switchActiveServer } from '../utils/switchActiveServer';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { Trans, useTranslation } from 'react-i18next';
import { showAudiomuseNavidromeServerSetting } from '../utils/subsonicServerIdentity';
import { type ServerMagicPayload } from '../utils/serverMagicString';
import { shortHostFromServerUrl, serverListDisplayLabel } from '../utils/serverDisplayName';

const AUDIOMUSE_NV_PLUGIN_URL = 'https://github.com/NeptuneHub/AudioMuse-AI-NV-plugin';


export default function Settings() {
  const auth = useAuthStore();
  const theme = useThemeStore();
  const fontStore = useFontStore();
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
  type ServerDropTarget = { idx: number; before: boolean } | null;
  const psyDragState = useDragDrop();
  const [serverContainerEl, setServerContainerEl] = useState<HTMLDivElement | null>(null);
  const [serverDropTarget, setServerDropTarget] = useState<ServerDropTarget>(null);
  const serverDropTargetRef = useRef<ServerDropTarget>(null);
  const serversRef = useRef(auth.servers);
  serversRef.current = auth.servers;
  const [connStatus, setConnStatus] = useState<Record<string, 'idle' | 'testing' | 'ok' | 'error'>>({});
  const [showAddForm, setShowAddForm] = useState(false);
  const [pastedServerInvite, setPastedServerInvite] = useState<ServerMagicPayload | null>(null);
  const [imageCacheBytes, setImageCacheBytes] = useState<number | null>(null);
  const [offlineCacheBytes, setOfflineCacheBytes] = useState<number | null>(null);
  const [hotCacheBytes, setHotCacheBytes] = useState<number | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
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
    if (activeTab !== 'storage') return;
    getImageCacheSize().then(setImageCacheBytes);
    invoke<number>('get_offline_cache_size', { customDir: auth.offlineDownloadDir || null }).then(setOfflineCacheBytes).catch(() => setOfflineCacheBytes(0));
    invoke<number>('get_hot_cache_size', { customDir: auth.hotCacheDownloadDir || null }).then(setHotCacheBytes).catch(() => setHotCacheBytes(0));
  }, [activeTab, auth.offlineDownloadDir, auth.hotCacheDownloadDir]);

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
      {activeTab === 'audio' && <AudioTab />}

      {/* ── Lyrics ───────────────────────────────────────────────────────────── */}
      {activeTab === 'lyrics' && <LyricsTab />}

      {/* ── Integrations ─────────────────────────────────────────────────────── */}
      {activeTab === 'integrations' && <IntegrationsTab />}


      {/* ── Personalisation ──────────────────────────────────────────────────── */}
      {activeTab === 'personalisation' && <PersonalisationTab />}

      {/* ── Library (legacy 'general' + 'server') ────────────────────────────── */}
      {activeTab === 'library' && <LibraryTab />}


      {/* ── Offline & Cache ──────────────────────────────────────────────────── */}
      {activeTab === 'storage' && (
        <>
          {/* Offline Library (In-App) — includes cache settings */}
          <SettingsSubSection
            title={t('settings.offlineDirTitle')}
            icon={<Download size={16} />}
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
                  g.themes.map(th => ({
                    value: th.id,
                    label: th.family ? `${th.family} ${th.label}` : th.label,
                    group: g.group,
                  }))
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {(
                  [
                    // Accessibility-first: OpenDyslexic at the top so dyslexic
                    // readers don't have to scroll past 14 sans-serifs to find it.
                    { id: 'opendyslexic',      label: 'OpenDyslexic',      stack: "'OpenDyslexic', sans-serif", hint: t('settings.fontHintOpenDyslexic') },
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
                  ] as { id: FontId; label: string; stack: string; hint?: string }[]
                ).map(f => (
                  <button
                    key={f.id}
                    className={`btn ${fontStore.font === f.id ? 'btn-primary' : 'btn-ghost'}`}
                    style={{
                      justifyContent: 'flex-start',
                      fontFamily: f.stack,
                      ...(f.hint ? { flexDirection: 'column', alignItems: 'flex-start', gap: '2px', paddingTop: '8px', paddingBottom: '8px' } : null),
                    }}
                    onClick={() => fontStore.setFont(f.id)}
                  >
                    <span>{f.label}</span>
                    {f.hint && (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-sans)' }}>
                        {f.hint}
                      </span>
                    )}
                  </button>
                ))}
              </div>
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
      {activeTab === 'input' && <InputTab />}


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

          <SettingsSubSection
            title={t('licenses.title')}
            icon={<Scale size={16} />}
          >
            <LicensesPanel />
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


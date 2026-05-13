import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AudioLines, HardDrive, Info, Keyboard, LayoutGrid, Music2, Palette, Search, Server, Sparkles, Users, X,
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { IS_MACOS } from '../utils/platform';
import { AppearanceTab } from '../components/settings/AppearanceTab';
import { AudioTab } from '../components/settings/AudioTab';
import { InputTab } from '../components/settings/InputTab';
import { IntegrationsTab } from '../components/settings/IntegrationsTab';
import { LibraryTab } from '../components/settings/LibraryTab';
import { LyricsTab } from '../components/settings/LyricsTab';
import { PersonalisationTab } from '../components/settings/PersonalisationTab';
import { ServersTab } from '../components/settings/ServersTab';
import { StorageTab } from '../components/settings/StorageTab';
import { SystemTab } from '../components/settings/SystemTab';
import { SETTINGS_INDEX, type Tab, matchScore, resolveTab } from '../components/settings/settingsTabs';
import { UserManagementSection } from '../components/settings/UserManagementSection';
import { ndLogin } from '../api/navidromeAdmin';
import { type ServerMagicPayload } from '../utils/serverMagicString';


export default function Settings() {
  const auth = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = location.state;
  const { t } = useTranslation();

  const [activeTab, setActiveTab] = useState<Tab>(resolveTab((routeState as { tab?: string } | null)?.tab));
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<{ tab: Tab; titleKey: string; title: string; score: number }>>([]);
  const [selectedResultIdx, setSelectedResultIdx] = useState(0);
  const [pendingFocusTitle, setPendingFocusTitle] = useState<string | null>(null);
  const [pendingServerInvite, setPendingServerInvite] = useState<ServerMagicPayload | null>(null);
  const [ndAdminAuth, setNdAdminAuth] = useState<{ token: string; serverUrl: string; username: string } | null>(null);
  const [ndAuthChecked, setNdAuthChecked] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResultsListRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const st = routeState as { openAddServerInvite?: ServerMagicPayload; tab?: Tab } | null;
    const inv = st?.openAddServerInvite;
    if (inv) {
      setPendingServerInvite(inv);
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
      {activeTab === 'storage' && <StorageTab />}

      {/* ── Appearance ───────────────────────────────────────────────────────── */}
      {activeTab === 'appearance' && <AppearanceTab />}

      {/* ── Input ────────────────────────────────────────────────────────────── */}
      {activeTab === 'input' && <InputTab />}


      {/* ── Server ───────────────────────────────────────────────────────────── */}
      {activeTab === 'servers' && (
        <ServersTab initialInvite={pendingServerInvite} />
      )}

      {/* ── Users ────────────────────────────────────────────────────────────── */}
      {activeTab === 'users' && ndAdminAuth && (
        <UserManagementSection
          serverUrl={ndAdminAuth.serverUrl}
          token={ndAdminAuth.token}
          currentUsername={ndAdminAuth.username}
        />
      )}

      {/* ── System ───────────────────────────────────────────────────────────── */}
      {activeTab === 'system' && <SystemTab />}

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


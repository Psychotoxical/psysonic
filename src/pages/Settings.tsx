import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { version as appVersion } from '../../package.json';
import changelogRaw from '../../CHANGELOG.md?raw';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Wifi, WifiOff, Globe, Music2, Sliders, LogOut, CheckCircle2, FolderOpen,
  Palette, Server, Plus, Trash2, Eye, EyeOff, Info, ExternalLink, Shuffle, X, Play, Type, Keyboard
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { getImageCacheSize, clearImageCache } from '../utils/imageCache';
import { useOfflineStore } from '../store/offlineStore';
import { lastfmGetToken, lastfmAuthUrl, lastfmGetSession, lastfmGetUserInfo, LastfmUserInfo } from '../api/lastfm';
import LastfmIcon from '../components/LastfmIcon';
import CustomSelect from '../components/CustomSelect';
import ThemePicker from '../components/ThemePicker';
import { useAuthStore, ServerProfile } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import { useFontStore, FontId } from '../store/fontStore';
import { useKeybindingsStore, KeyAction, formatKeyCode, DEFAULT_BINDINGS } from '../store/keybindingsStore';
import { useGlobalShortcutsStore, GlobalAction, buildGlobalShortcut, formatGlobalShortcut } from '../store/globalShortcutsStore';
import { pingWithCredentials } from '../api/subsonic';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import Equalizer from '../components/Equalizer';

const AUDIOBOOK_GENRES_DISPLAY = ['Hörbuch', 'Hoerbuch', 'Hörspiel', 'Hoerspiel', 'Audiobook', 'Audio Book', 'Spoken Word', 'Spokenword', 'Podcast', 'Kapitel', 'Thriller', 'Krimi', 'Speech', 'Fantasy', 'Comedy', 'Literature'];

type Tab = 'playback' | 'library' | 'appearance' | 'shortcuts' | 'server' | 'about';

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
        <input className="input" type="text" value={form.url} onChange={update('url')} placeholder="192.168.1.100:4533" autoComplete="off" />
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

export default function Settings() {
  const auth = useAuthStore();
  const theme = useThemeStore();
  const fontStore = useFontStore();
  const kb = useKeybindingsStore();
  const gs = useGlobalShortcutsStore();
  const serverId = auth.activeServerId ?? '';
  const clearAllOffline = useOfflineStore(s => s.clearAll);
  const [listeningFor, setListeningFor] = useState<KeyAction | null>(null);
  const [listeningForGlobal, setListeningForGlobal] = useState<GlobalAction | null>(null);
  const navigate = useNavigate();
  const { state: routeState } = useLocation();
  const { t, i18n } = useTranslation();

  const [activeTab, setActiveTab] = useState<Tab>((routeState as { tab?: Tab } | null)?.tab ?? 'server');
  const [connStatus, setConnStatus] = useState<Record<string, 'idle' | 'testing' | 'ok' | 'error'>>({});
  const [showAddForm, setShowAddForm] = useState(false);
  const [newGenre, setNewGenre] = useState('');
  const [lfmState, setLfmState] = useState<'idle' | 'waiting' | 'error'>('idle');
  const [lfmPendingToken, setLfmPendingToken] = useState<string | null>(null);
  const [lfmError, setLfmError] = useState<string | null>(null);
  const [lfmUserInfo, setLfmUserInfo] = useState<LastfmUserInfo | null>(null);
  const [imageCacheBytes, setImageCacheBytes] = useState<number | null>(null);
  const [offlineCacheBytes, setOfflineCacheBytes] = useState<number | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!auth.lastfmSessionKey || !auth.lastfmUsername) { setLfmUserInfo(null); return; }
    lastfmGetUserInfo(auth.lastfmUsername, auth.lastfmSessionKey).then(setLfmUserInfo).catch(() => {});
  }, [auth.lastfmSessionKey, auth.lastfmUsername]);

  useEffect(() => {
    if (activeTab !== 'library') return;
    getImageCacheSize().then(setImageCacheBytes);
    invoke<number>('get_offline_cache_size').then(setOfflineCacheBytes).catch(() => setOfflineCacheBytes(0));
  }, [activeTab]);

  const handleClearCache = useCallback(async () => {
    setClearing(true);
    await clearImageCache();
    await clearAllOffline(serverId);
    const [imgBytes, offBytes] = await Promise.all([
      getImageCacheSize(),
      invoke<number>('get_offline_cache_size').catch(() => 0),
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
      const ok = await pingWithCredentials(server.url, server.username, server.password);
      setConnStatus(s => ({ ...s, [server.id]: ok ? 'ok' : 'error' }));
    } catch {
      setConnStatus(s => ({ ...s, [server.id]: 'error' }));
    }
  };

  const switchToServer = async (server: ServerProfile) => {
    setConnStatus(s => ({ ...s, [server.id]: 'testing' }));
    try {
      const ok = await pingWithCredentials(server.url, server.username, server.password);
      if (ok) {
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
      const ok = await pingWithCredentials(data.url, data.username, data.password);
      if (ok) {
        const id = auth.addServer(data);
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

  const pickDownloadFolder = async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: t('settings.pickFolderTitle') });
    if (selected && typeof selected === 'string') {
      auth.setDownloadFolder(selected);
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'server',      label: t('settings.tabServer'),      icon: <Server size={15} /> },
    { id: 'appearance',  label: t('settings.tabAppearance'),  icon: <Palette size={15} /> },
    { id: 'playback',    label: t('settings.tabPlayback'),    icon: <Play size={15} /> },
    { id: 'library',     label: t('settings.tabLibrary'),     icon: <Shuffle size={15} /> },
    { id: 'shortcuts',   label: t('settings.tabShortcuts'),   icon: <Keyboard size={15} /> },
    { id: 'about',       label: t('settings.tabAbout'),       icon: <Info size={15} /> },
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

      {/* ── Playback ─────────────────────────────────────────────────────────── */}
      {activeTab === 'playback' && (
        <>
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
                    min={1}
                    max={10}
                    step={0.5}
                    value={auth.crossfadeSecs}
                    onChange={e => auth.setCrossfadeSecs(Number(e.target.value))}
                    style={{ width: 120 }}
                    id="crossfade-secs-slider"
                  />
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 28 }}>
                    {t('settings.crossfadeSecs', { n: auth.crossfadeSecs })}
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

        </>
      )}

      {/* ── Library ──────────────────────────────────────────────────────────── */}
      {activeTab === 'library' && (
        <>
          {/* Cache */}
          <section className="settings-section">
            <div className="settings-section-header">
              <Sliders size={18} />
              <h2>{t('settings.behavior')}</h2>
            </div>
            <div className="settings-card">
              <div style={{ fontWeight: 500, marginBottom: 4 }}>{t('settings.cacheTitle')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
                {t('settings.cacheDesc')}
                {(imageCacheBytes !== null || offlineCacheBytes !== null) && (
                  <span style={{ marginLeft: 6, color: 'var(--text-secondary)' }}>
                    — {t('settings.cacheUsed', {
                      images: imageCacheBytes !== null ? formatBytes(imageCacheBytes) : '…',
                      offline: offlineCacheBytes !== null ? formatBytes(offlineCacheBytes) : '…',
                    })}
                  </span>
                )}
              </div>
              <div className="settings-toggle-row" style={{ marginBottom: 12 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{auth.maxCacheMb} MB</span>
                <input
                  type="range"
                  min={100}
                  max={5000}
                  step={100}
                  value={auth.maxCacheMb}
                  onChange={e => auth.setMaxCacheMb(Number(e.target.value))}
                  style={{ width: 120 }}
                  id="cache-size-slider"
                />
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
                    { value: 'nl', label: t('settings.languageNl') },
                    { value: 'en', label: t('settings.languageEn') },
                    { value: 'fr', label: t('settings.languageFr') },
                    { value: 'de', label: t('settings.languageDe') },
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
              <ThemePicker value={theme.theme} onChange={v => theme.setTheme(v as any)} />
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-header">
              <Type size={18} />
              <h2>{t('settings.font')}</h2>
            </div>
            <div className="settings-card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {([
                  { id: 'inter',   label: 'Inter',            sample: 'The quick brown fox' },
                  { id: 'outfit',  label: 'Outfit',           sample: 'The quick brown fox' },
                  { id: 'dm-sans', label: 'DM Sans',          sample: 'The quick brown fox' },
                  { id: 'nunito',  label: 'Nunito',           sample: 'The quick brown fox' },
                  { id: 'rubik',             label: 'Rubik',             sample: 'The quick brown fox' },
                  { id: 'space-grotesk',     label: 'Space Grotesk',     sample: 'The quick brown fox' },
                  { id: 'figtree',           label: 'Figtree',           sample: 'The quick brown fox' },
                  { id: 'manrope',           label: 'Manrope',           sample: 'The quick brown fox' },
                  { id: 'plus-jakarta-sans', label: 'Plus Jakarta Sans',  sample: 'The quick brown fox' },
                  { id: 'lexend',            label: 'Lexend',            sample: 'The quick brown fox' },
                ] as { id: FontId; label: string; sample: string }[]).map(f => (
                  <button
                    key={f.id}
                    onClick={() => fontStore.setFont(f.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '12px',
                      background: fontStore.font === f.id ? 'var(--accent-dim)' : 'transparent',
                      border: `1px solid ${fontStore.font === f.id ? 'var(--accent)' : 'var(--border-subtle)'}`,
                      borderRadius: 'var(--radius-md)', padding: '10px 14px',
                      cursor: 'pointer', textAlign: 'left', width: '100%',
                    }}
                  >
                    <div style={{
                      width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                      border: `2px solid ${fontStore.font === f.id ? 'var(--accent)' : 'var(--border)'}`,
                      background: fontStore.font === f.id ? 'var(--accent)' : 'transparent',
                    }} />
                    <div>
                      <div style={{ fontFamily: `'${f.label}', sans-serif`, fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>{f.label}</div>
                      <div style={{ fontFamily: `'${f.label}', sans-serif`, fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{f.sample}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </section>
        </>
      )}

      {/* ── Shortcuts ────────────────────────────────────────────────────────── */}
      {activeTab === 'shortcuts' && (
        <>
        <section className="settings-section">
          <div className="settings-section-header">
            <Keyboard size={18} />
            <h2>{t('settings.tabShortcuts')}</h2>
          </div>
          <div className="settings-card">
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { kb.resetToDefaults(); setListeningFor(null); }}>
                {t('settings.shortcutsReset')}
              </button>
            </div>
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
                            if (e.code !== 'Escape') {
                              // unbind any existing action with this key first
                              const existing = (Object.entries(kb.bindings) as [KeyAction, string | null][])
                                .find(([, c]) => c === e.code)?.[0];
                              if (existing && existing !== action) kb.setBinding(existing, null);
                              kb.setBinding(action, e.code);
                            }
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
                        {isListening ? t('settings.shortcutListening') : bound ? formatKeyCode(bound) : t('settings.shortcutUnbound')}
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
        </section>

        <section className="settings-section">
          <div className="settings-section-header">
            <Keyboard size={18} />
            <h2>{t('settings.globalShortcutsTitle')}</h2>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.5 }}>
            {t('settings.globalShortcutsNote')}
          </p>
          <div className="settings-card">
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '12px' }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { gs.resetAll(); setListeningForGlobal(null); }}>
                {t('settings.shortcutsReset')}
              </button>
            </div>
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
                            className="btn btn-ghost"
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
                  );
                })}
              </div>
            )}

            {showAddForm ? (
              <AddServerForm onSave={handleAddServer} onCancel={() => setShowAddForm(false)} />
            ) : (
              <button className="btn btn-ghost" style={{ marginTop: '0.75rem' }} onClick={() => setShowAddForm(true)} id="settings-add-server-btn">
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

          {/* Downloads + Tray */}
          <section className="settings-section">
            <div className="settings-section-header">
              <Sliders size={18} />
              <h2>{t('settings.behavior')}</h2>
            </div>
            <div className="settings-card">
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.downloadsTitle')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, wordBreak: 'break-all' }}>
                    {auth.downloadFolder || t('settings.downloadsDefault')}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  {auth.downloadFolder && (
                    <button
                      className="btn btn-ghost"
                      onClick={() => auth.setDownloadFolder('')}
                      aria-label={t('settings.clearFolder')}
                      data-tooltip={t('settings.clearFolder')}
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <X size={16} />
                    </button>
                  )}
                  <button className="btn btn-ghost" onClick={pickDownloadFolder} id="settings-download-folder-btn">
                    <FolderOpen size={16} /> {t('settings.pickFolder')}
                  </button>
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      {/* ── About ────────────────────────────────────────────────────────────── */}
      {activeTab === 'about' && (
        <>
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
              <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0.5rem 0' }}>
                {t('settings.aboutFeatures')}
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
              </div>

              <button
                className="btn btn-ghost"
                style={{ marginTop: '1.25rem', alignSelf: 'flex-start' }}
                onClick={() => openUrl('https://github.com/Psychotoxical/psysonic')}
              >
                <ExternalLink size={14} />
                {t('settings.aboutRepo')}
              </button>
            </div>
          </section>

          <ChangelogSection />

          <section className="settings-section">
            <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={handleLogout} id="settings-logout-btn">
              <LogOut size={16} /> {t('settings.logout')}
            </button>
          </section>
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

function ChangelogSection() {
  const { t } = useTranslation();

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
      <div className="changelog-list">
        {versions.map(({ version, date, body }) => (
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

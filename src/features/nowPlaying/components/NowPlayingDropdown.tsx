import { CoverArtImage } from '@/cover/CoverArtImage';
import { usePresenceCoverRef } from '@/cover/useLibraryCoverRef';
import { coverServerScopeForServerId } from '@/cover/serverScope';
import { getNowPlayingForServers } from '@/lib/api/subsonicScrobble';
import type { SubsonicNowPlaying } from '@/lib/api/subsonicTypes';
import React, { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { PlayCircle, Pause, User, Radio, RefreshCw } from 'lucide-react';
import { nowPlayingPresence } from '@/features/nowPlaying/api/nowPlayingPresence';
import { useAuthStore } from '@/store/authStore';
import { deriveEffectiveLibraryBrowseServerIds } from '@/lib/library/libraryBrowseScope';
import { useUnavailableServerIds } from '@/lib/network/serverReachability';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { appendServerQuery } from '@/lib/navigation/detailServerScope';
import { serverListDisplayLabel } from '@/lib/server/serverDisplayName';
import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';

/**
 * Cover thumb for a presence row. Resolves via {@link usePresenceCoverRef} so a
 * multi-disc Navidrome album shows the disc the person is actually playing
 * (`dc-<albumId>:<disc>`), and single-disc / other servers show the shared album
 * cover — never the track's own `mf-*` art forced into the album cache slot.
 */
function PresenceCover({ stream }: { stream: SubsonicNowPlaying }) {
  const serverScope = useMemo(
    () => coverServerScopeForServerId(stream.serverId),
    [stream.serverId],
  );
  const coverRef = usePresenceCoverRef(
    { albumId: stream.albumId, discNumber: stream.discNumber, serverId: stream.serverId },
    serverScope,
  );
  if (!coverRef) {
    return <PlayCircle size={24} style={{ margin: '12px', color: 'var(--text-muted)' }} />;
  }
  return (
    <CoverArtImage
      coverRef={coverRef}
      displayCssPx={50}
      surface="sparse"
      alt="Cover"
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
    />
  );
}

export default function NowPlayingDropdown() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<SubsonicNowPlaying[]>([]);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const playbackServerKey = usePlayerStore(s => s.queueItems[s.queueIndex]?.serverId ?? s.queueServerId ?? '');
  const servers = useAuthStore(s => s.servers);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const libraryBrowseServerIds = useAuthStore(s => s.libraryBrowseServerIds);
  const unavailableServerIds = useUnavailableServerIds();
  const effectiveLibraryServerIds = useMemo(() => deriveEffectiveLibraryBrowseServerIds({
    servers,
    activeServerId,
    libraryBrowseServerIds,
  }, unavailableServerIds), [activeServerId, libraryBrowseServerIds, servers, unavailableServerIds]);
  const [loading, setLoading] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const triggerWrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  // Wall-clock baseline for the last poll: between polls we extrapolate the
  // position of `playing` entries locally so the progress bar glides instead
  // of snapping. The server already extrapolates positionMs at fetch time.
  const fetchedAtRef = useRef(0);
  const requestSeqRef = useRef(0);
  const [, forceTick] = useState(0);
  const PANEL_WIDTH = 340;
  const LIVE_POLL_OPEN_MS = 10_000;
  const LIVE_POLL_BACKGROUND_MS = 30_000;

  const formatClock = (totalSec: number) => {
    const s = Math.max(0, Math.floor(totalSec));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  };

  // Live position in seconds: advance `playing` entries by elapsed × playbackRate
  // since the last poll; freeze everything else at the reported position.
  const livePositionSec = (entry: SubsonicNowPlaying): number | undefined => {
    if (typeof entry.positionMs !== 'number') return undefined;
    let ms = entry.positionMs;
    if (entry.state === 'playing') {
      const rate = entry.playbackRate && entry.playbackRate > 0 ? entry.playbackRate : 1;
      // React Compiler purity rule: intentional live-timestamp read at render (Date.now()); the value is allowed to differ between renders.
      // eslint-disable-next-line react-hooks/purity
      ms += (Date.now() - fetchedAtRef.current) * rate;
    }
    const maxMs = entry.duration > 0 ? entry.duration * 1000 : ms;
    return Math.min(ms, maxMs) / 1000;
  };

  const updatePanelPos = useCallback(() => {
    const el = triggerWrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    const top = r.bottom + 10;
    const maxLeft = window.innerWidth - PANEL_WIDTH - margin;
    const left = Math.max(margin, Math.min(r.right - PANEL_WIDTH, maxLeft));
    setPanelPos({ top, left });
  }, []);

  const fetchNowPlaying = useCallback(async (opts?: { silent?: boolean }) => {
    const requestSeq = ++requestSeqRef.current;
    if (!opts?.silent) setLoading(true);
    try {
      const data = await getNowPlayingForServers(effectiveLibraryServerIds);
      if (requestSeq !== requestSeqRef.current) return;
      fetchedAtRef.current = Date.now();
      setNowPlaying(data);
    } catch (e) {
      console.error('Failed to load Now Playing', e);
    } finally {
      if (!opts?.silent && requestSeq === requestSeqRef.current) setLoading(false);
    }
  }, [effectiveLibraryServerIds]);

  const handleRefresh = () => {
    setSpinning(true);
    fetchNowPlaying().finally(() => {
      setTimeout(() => setSpinning(false), 600);
    });
  };

  // Poll while the page is visible: every 30 s for the header badge, every 10 s
  // while the popover is open so the list stays fresher.
  useEffect(() => {
    const poll = (silent: boolean) => {
      if (document.visibilityState === 'visible') void fetchNowPlaying({ silent });
    };

    poll(!isOpen);
    const intervalMs = isOpen ? LIVE_POLL_OPEN_MS : LIVE_POLL_BACKGROUND_MS;
    const id = setInterval(() => poll(true), intervalMs);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') poll(true);
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isOpen, fetchNowPlaying]);

  // Re-render once per second while a `playing` entry exposes a position, so the
  // locally-extrapolated bar advances smoothly between polls.
  const hasLivePosition = nowPlaying.some(
    e => e.state === 'playing' && typeof e.positionMs === 'number',
  );
  useEffect(() => {
    if (!isOpen || !hasLivePosition) return;
    const id = setInterval(() => forceTick(v => v + 1), 1000);
    return () => clearInterval(id);
  }, [isOpen, hasLivePosition]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePanelPos();
    const onWin = () => updatePanelPos();
    window.addEventListener('resize', onWin);
    window.addEventListener('scroll', onWin, true);
    return () => {
      window.removeEventListener('resize', onWin);
      window.removeEventListener('scroll', onWin, true);
    };
  }, [isOpen, updatePanelPos]);

  // Click outside to close
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerWrapRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setIsOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // For the current user, trust the local player state — the server keeps stale
  // "now playing" entries for minutes after playback stops.
  const playbackServerId = findServerByIdOrIndexKey(playbackServerKey)?.id ?? playbackServerKey;
  const ownUsernameByServer = new Map(servers.map(server => [server.id, server.username]));
  const serverLabelById = new Map(servers.map(server => [server.id, serverListDisplayLabel(server, servers)]));
  const multiServerScope = effectiveLibraryServerIds.length > 1;
  const visible = nowPlaying.filter(entry => {
    if (entry.state === 'stopped') return false;
    const entryServerId = entry.serverId ?? '';
    const ownUsername = ownUsernameByServer.get(entryServerId);
    if (!ownUsername || entry.username !== ownUsername) return true;
    return entryServerId === playbackServerId && isPlaying;
  });
  const visibleByServer = new Map<string, SubsonicNowPlaying[]>();
  for (const entry of visible) {
    const serverId = entry.serverId ?? '';
    const rows = visibleByServer.get(serverId);
    if (rows) rows.push(entry);
    else visibleByServer.set(serverId, [entry]);
  }
  const visibleGroups = effectiveLibraryServerIds
    .map(serverId => ({
      serverId,
      serverLabel: serverLabelById.get(serverId) ?? serverId,
      rows: visibleByServer.get(serverId) ?? [],
    }))
    .filter(group => group.rows.length > 0);

  return (
    <div className="now-playing-dropdown" ref={triggerWrapRef} style={{ position: 'relative' }}>
      <button
        className="btn btn-surface now-playing-dropdown__trigger"
        onClick={() => setIsOpen(!isOpen)}
        data-tooltip={t('nowPlaying.tooltip')}
        data-tooltip-pos="bottom"
        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem' }}
      >
        <span
          className={`now-playing-dropdown__live-icon${visible.length > 0 ? ' now-playing-dropdown__live-icon--active' : ''}`}
        >
          <Radio size={18} />
        </span>
        <span className="now-playing-dropdown__label">Live</span>
        {visible.length > 0 && (
          <span style={{
            background: 'var(--accent)',
            color: 'var(--text-on-accent)',
            fontSize: '10px',
            fontWeight: 'bold',
            padding: '2px 6px',
            borderRadius: '10px'
          }}>
            {visible.length}
          </span>
        )}
      </button>

      {isOpen && createPortal(
        <div
          ref={panelRef}
          className="nav-library-dropdown-panel animate-fade-in"
          style={{
            position: 'fixed',
            top: panelPos.top,
            left: panelPos.left,
            width: `${PANEL_WIDTH}px`,
            maxHeight: '400px',
            overflowY: 'auto',
            padding: '1rem',
            gap: '1rem',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.5rem' }}>
            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>{t('nowPlaying.title')}</h3>
            <button
              onClick={handleRefresh}
              className="btn btn-ghost"
              style={{ width: '28px', height: '28px', padding: 0, justifyContent: 'center' }}
            >
              <RefreshCw size={14} className={spinning ? 'animate-spin' : ''} />
            </button>
          </div>

          {loading && visible.length === 0 ? (
            <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              {t('nowPlaying.loading')}
            </div>
          ) : visible.length === 0 ? (
            <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              {t('nowPlaying.nobody')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {/* React Compiler refs rule: nested row rendering reads fetchedAtRef for live position extrapolation. */}
              {/* eslint-disable-next-line react-hooks/refs */}
              {visibleGroups.map(group => (
                <section key={group.serverId} className="nav-library-server-group" aria-label={group.serverLabel}>
                  {multiServerScope ? (
                    <div className="nav-library-server-group-heading">{group.serverLabel}</div>
                  ) : null}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {group.rows.map((stream, idx) => {
                const presence = nowPlayingPresence(stream);
                const presenceLabel = t(`nowPlaying.presence.${presence}`);
                return (
                <div
                   key={`${stream.serverId ?? 'unknown'}:${stream.username}:${stream.playerId}:${stream.id}:${idx}`}
                   onClick={() => {
                     if (!stream.albumId) return;
                     setIsOpen(false);
                     const search = appendServerQuery(undefined, stream.serverId);
                     navigate(`/album/${stream.albumId}${search ? `?${search}` : ''}`);
                   }}
                  style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', background: 'var(--bg-hover)', padding: '0.5rem', borderRadius: '8px', cursor: stream.albumId ? 'pointer' : 'default' }}
                >
                  <div style={{ width: '48px', height: '48px', flexShrink: 0, borderRadius: '6px', overflow: 'hidden', background: 'var(--card-placeholder-bg)' }}>
                    {stream.albumId ? (
                      <PresenceCover stream={stream} />
                    ) : (
                      <PlayCircle size={24} style={{ margin: '12px', color: 'var(--text-muted)' }} />
                    )}
                  </div>
                  <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                      <span
                        className={`now-playing-led now-playing-led--${presence}`}
                        role="img"
                        aria-label={presenceLabel}
                        data-tooltip={presenceLabel}
                        data-tooltip-pos="bottom"
                      />
                      <span className="truncate" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{stream.title}</span>
                    </div>
                    <div className="truncate" style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{stream.artist}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '2px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
                        <User size={10} style={{ flexShrink: 0 }} />
                        <span className="truncate">{stream.username} ({stream.playerName || 'Web'})</span>
                      </div>
                      {(() => {
                        const posSec = livePositionSec(stream);
                        if (posSec === undefined || stream.duration <= 0) return null;
                        const playing = stream.state === 'playing';
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, marginTop: '1px' }}>
                            {stream.state === 'paused' && <Pause size={10} style={{ flexShrink: 0 }} />}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ height: '3px', borderRadius: '2px', background: 'var(--border-subtle)', overflow: 'hidden' }}>
                                <div style={{
                                  width: `${Math.min(100, Math.max(0, (posSec / stream.duration) * 100))}%`,
                                  height: '100%',
                                  background: playing ? 'var(--accent)' : 'var(--text-muted)',
                                  transition: playing ? 'width 1s linear' : 'none',
                                }} />
                              </div>
                            </div>
                            <span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                              {/* ~2ch reserve inside the current-time box (9:59→10:00), not empty gap before the bar. */}
                              <span style={{ display: 'inline-block', minWidth: '6ch', textAlign: 'right' }}>
                                {formatClock(posSec)}
                              </span>
                              {' / '}
                              {formatClock(stream.duration)}
                            </span>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
                );
              })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

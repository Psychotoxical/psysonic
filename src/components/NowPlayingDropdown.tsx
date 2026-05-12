import type { SubsonicNowPlaying } from '../api/subsonicTypes';
import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { PlayCircle, User, Radio, RefreshCw } from 'lucide-react';
import { getNowPlaying, buildCoverArtUrl } from '../api/subsonic';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

export default function NowPlayingDropdown() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<SubsonicNowPlaying[]>([]);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const ownUsername = useAuthStore(s => s.getActiveServer()?.username ?? '');
  const [loading, setLoading] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const triggerWrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const PANEL_WIDTH = 340;

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

  const fetchNowPlaying = async () => {
    setLoading(true);
    try {
      const data = await getNowPlaying();
      setNowPlaying(data);
    } catch (e) {
      console.error('Failed to load Now Playing', e);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = () => {
    setSpinning(true);
    fetchNowPlaying().finally(() => {
      setTimeout(() => setSpinning(false), 600);
    });
  };

  // Poll only while the dropdown is open AND the page is visible.
  useEffect(() => {
    if (!isOpen) return;
    fetchNowPlaying();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fetchNowPlaying();
    }, 10000);
    return () => clearInterval(id);
  }, [isOpen]);

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
  const visible = nowPlaying.filter(entry =>
    entry.username === ownUsername ? isPlaying : true
  );

  return (
    <div className="now-playing-dropdown" ref={triggerWrapRef} style={{ position: 'relative' }}>
      <button
        className="btn btn-surface now-playing-dropdown__trigger"
        onClick={() => setIsOpen(!isOpen)}
        data-tooltip={t('nowPlaying.tooltip')}
        data-tooltip-pos="bottom"
        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem' }}
      >
        <Radio size={18} className={visible.length > 0 ? 'animate-pulse' : ''} style={{ color: visible.length > 0 ? 'var(--accent)' : 'inherit' }} />
        <span className="now-playing-dropdown__label">Live</span>
        {visible.length > 0 && (
          <span style={{
            background: 'var(--accent)',
            color: 'var(--ctp-crust)',
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
          className="glass animate-fade-in"
          style={{
            position: 'fixed',
            top: panelPos.top,
            left: panelPos.left,
            width: `${PANEL_WIDTH}px`,
            maxHeight: '400px',
            overflowY: 'auto',
            borderRadius: '12px',
            boxShadow: 'var(--shadow-lg)',
            padding: '1rem',
            zIndex: 10050,
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem'
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {visible.map((stream, idx) => (
                <div
                  key={`${stream.id}-${idx}`}
                  onClick={() => { if (stream.albumId) { setIsOpen(false); navigate(`/album/${stream.albumId}`); } }}
                  style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', background: 'var(--bg-hover)', padding: '0.5rem', borderRadius: '8px', cursor: stream.albumId ? 'pointer' : 'default' }}
                >
                  <div style={{ width: '48px', height: '48px', flexShrink: 0, borderRadius: '6px', overflow: 'hidden', background: 'var(--bg-surface)' }}>
                    {stream.coverArt ? (
                      <img src={buildCoverArtUrl(stream.coverArt, 100)} alt="Cover" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <PlayCircle size={24} style={{ margin: '12px', color: 'var(--text-muted)' }} />
                    )}
                  </div>
                  <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <div className="truncate" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{stream.title}</div>
                    <div className="truncate" style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{stream.artist}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                      <User size={10} />
                      <span className="truncate">{stream.username} ({stream.playerName || 'Web'})</span>
                      {stream.minutesAgo > 0 && <span>• {t('nowPlaying.minutesAgo', { n: stream.minutesAgo })}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Cast, Check, Loader2, Plus, X } from 'lucide-react';
import {
  createInternetRadioStation, fetchUrlBytes, getInternetRadioStations,
  getTopRadioStations, searchRadioBrowser, uploadRadioCoverArtBytes,
} from '../../api/subsonicRadio';
import {
  type InternetRadioStation, type RadioBrowserStation, RADIO_PAGE_SIZE,
} from '../../api/subsonicTypes';
import { showToast } from '../../utils/ui/toast';

interface RadioDirectoryModalProps {
  onClose: () => void;
  onAdded: () => void;
}

export default function RadioDirectoryModal({ onClose, onAdded }: RadioDirectoryModalProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RadioBrowserStation[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const queryRef = useRef(query);
  useEffect(() => { queryRef.current = query; }, [query]);

  const fetchPage = useCallback(async (q: string, off: number, append: boolean) => {
    if (append) setLoadingMore(true); else setSearching(true);
    try {
      const page = q.trim()
        ? await searchRadioBrowser(q.trim(), off)
        : await getTopRadioStations(off);
      if (append) setResults(prev => [...prev, ...page]);
      else setResults(page);
      setHasMore(page.length >= RADIO_PAGE_SIZE);
      setOffset(off + page.length);
    } catch {
      if (!append) setResults([]);
      setHasMore(false);
    } finally {
      if (append) setLoadingMore(false); else setSearching(false);
    }
  }, []);

  // Load top stations on open
  useEffect(() => {
    fetchPage('', 0, false);
  }, [fetchPage]);

  // Debounced search; reset pagination on new query
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setOffset(0);
      setHasMore(true);
      fetchPage(query, 0, false);
    }, query.trim() ? 400 : 0);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, fetchPage]);

  // Callback ref: re-creates the IntersectionObserver whenever hasMore/loadingMore/offset change,
  // so the closure always captures current state — no stale refs needed.
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) { observerRef.current.disconnect(); observerRef.current = null; }
    if (!node) return;
    const root = scrollContainerRef.current ?? null;
    observerRef.current = new IntersectionObserver(entries => {
      const entry = entries[0];
      console.log('[RadioDir] Observer fired:', entry.isIntersecting, '| hasMore:', hasMore, '| loading:', loadingMore);
      if (entry.isIntersecting && hasMore && !loadingMore) {
        fetchPage(queryRef.current, offset, true);
      }
    }, { root, rootMargin: '200px', threshold: 0 });
    observerRef.current.observe(node);
  }, [hasMore, loadingMore, offset, fetchPage]);

  const handleAdd = async (s: RadioBrowserStation) => {
    if (addedIds.has(s.stationuuid) || addingId !== null) return;
    setAddingId(s.stationuuid);
    try {
      await createInternetRadioStation(s.name, s.url);
      if (s.favicon) {
        const list = await getInternetRadioStations().catch(() => [] as InternetRadioStation[]);
        const created = list.find(r => r.streamUrl === s.url);
        if (created) {
          try {
            const [fileBytes, mimeType] = await fetchUrlBytes(s.favicon);
            await uploadRadioCoverArtBytes(created.id, fileBytes, mimeType);
          } catch { /* favicon optional */ }
        }
      }
      onAdded();
      setAddedIds(prev => new Set(prev).add(s.stationuuid));
      showToast(`${t('radio.stationAdded')}: ${s.name}`, 3000);
    } catch (err) {
      const msg = typeof err === 'string' ? err : (err instanceof Error ? err.message : '');
      if (msg.toLowerCase().includes('unique constraint') || msg.toLowerCase().includes('radio.name')) {
        showToast('Ein Sender mit diesem Namen existiert bereits.', 4000, 'error');
      } else {
        showToast(msg || 'Failed', 3000, 'error');
      }
    } finally {
      setAddingId(null);
    }
  };

  return createPortal(
    // ── 1. Backdrop ──────────────────────────────────────────────
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(17,17,27,0.85)',
        backdropFilter: 'blur(8px)',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* ── 2. Content Box ─────────────────────────────────────── */}
      <div
        style={{
          width: '80vw',
          maxWidth: 800,
          height: '80vh',
          background: 'var(--ctp-surface0)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── 3. Header ──────────────────────────────────────────── */}
        <div
          style={{
            flexShrink: 0,
            padding: 20,
            background: 'var(--ctp-surface0)',
            zIndex: 10,
            position: 'relative',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <button
            className="btn btn-ghost"
            style={{ position: 'absolute', top: 16, right: 16, color: 'var(--text-muted)' }}
            onClick={onClose}
          >
            <X size={18} />
          </button>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 14, color: 'var(--text-primary)', fontFamily: 'var(--font-display)' }}>
            {t('radio.browseDirectory')}
          </h2>
          <input
            className="input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('radio.directoryPlaceholder')}
            autoFocus
            style={{ width: '100%' }}
          />
        </div>

        {/* ── 4. Body / Results ──────────────────────────────────── */}
        <div ref={scrollContainerRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 20px 20px' }}>
          {searching ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
              <div className="spinner" />
            </div>
          ) : results.length === 0 ? (
            <div className="empty-state" style={{ padding: '2rem 0' }}>{t('radio.noResults')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 8 }}>
              {results.map(s => {
                const isAdded = addedIds.has(s.stationuuid);
                const isLoading = addingId === s.stationuuid;
                const isDisabled = isAdded || addingId !== null;
                return (
                  <div
                    key={s.stationuuid}
                    className={`radio-browser-result${isAdded ? ' added' : ''}${isDisabled ? '' : ' clickable'}`}
                    onClick={() => handleAdd(s)}
                  >
                    {s.favicon ? (
                      <img
                        src={s.favicon}
                        alt=""
                        className="radio-browser-favicon"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div className="radio-browser-favicon radio-browser-favicon--placeholder">
                        <Cast size={16} strokeWidth={1.5} />
                      </div>
                    )}
                    <div className="radio-browser-info">
                      <div className="radio-browser-name">{s.name}</div>
                      {s.tags && (
                        <div className="radio-browser-tags">
                          {s.tags.split(',').slice(0, 4).map(tag => tag.trim()).filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </div>
                    <div className="radio-browser-action" aria-hidden>
                      {isLoading
                        ? <Loader2 size={14} className="spin-slow" style={{ color: 'var(--accent)' }} />
                        : isAdded
                          ? <Check size={14} style={{ color: 'var(--accent)' }} />
                          : <Plus size={14} style={{ color: 'var(--text-muted)' }} />}
                    </div>
                  </div>
                );
              })}
              {/* Sentinel for IntersectionObserver */}
              <div ref={sentinelRef} style={{ height: 20, width: '100%', flexShrink: 0 }} />
              {loadingMore && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0' }}>
                  <div className="spinner" style={{ width: 20, height: 20 }} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

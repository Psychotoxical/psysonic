import { getInternetRadioStations, createInternetRadioStation, updateInternetRadioStation, deleteInternetRadioStation, uploadRadioCoverArt, deleteRadioCoverArt, uploadRadioCoverArtBytes, searchRadioBrowser, getTopRadioStations, fetchUrlBytes } from '../api/subsonicRadio';
import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import { type InternetRadioStation, type RadioBrowserStation, RADIO_PAGE_SIZE } from '../api/subsonicTypes';
import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Cast, Plus, Trash2, X, Globe, Camera, Loader2, Search, Heart, Check } from 'lucide-react';
import { useDragSource, useDragDrop } from '../contexts/DragDropContext';
import { usePlayerStore } from '../store/playerStore';
import CachedImage from '../components/CachedImage';
import { invalidateCoverArt } from '../utils/imageCache';
import CustomSelect from '../components/CustomSelect';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-shell';
import { showToast } from '../utils/toast';
import RadioToolbar, { type RadioSortBy } from '../components/internetRadio/RadioToolbar';
import AlphabetFilterBar from '../components/internetRadio/AlphabetFilterBar';
import RadioCard from '../components/internetRadio/RadioCard';
import RadioEditModal from '../components/internetRadio/RadioEditModal';
import RadioDirectoryModal from '../components/internetRadio/RadioDirectoryModal';

export default function InternetRadio() {
  const { t } = useTranslation();
  const playRadio = usePlayerStore(s => s.playRadio);
  const stop = usePlayerStore(s => s.stop);
  const currentRadio = usePlayerStore(s => s.currentRadio);
  const isPlaying = usePlayerStore(s => s.isPlaying);

  const [stations, setStations] = useState<InternetRadioStation[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  // null = closed, 'new' = create modal, InternetRadioStation = edit modal
  const [modalStation, setModalStation] = useState<InternetRadioStation | 'new' | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);

  const [sortBy, setSortBy] = useState<'manual' | 'az' | 'za' | 'newest'>('manual');
  const [activeFilter, setActiveFilter] = useState('all');
  const [activeLetter, setActiveLetter] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem('psysonic_radio_favorites') ?? '[]')); }
    catch { return new Set<string>(); }
  });
  const [manualOrder, setManualOrder] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState<{ id: string; side: 'before' | 'after' } | null>(null);

  useEffect(() => {
    getInternetRadioStations()
      .then(setStations)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const reload = async () => {
    const list = await getInternetRadioStations().catch(() => [] as InternetRadioStation[]);
    setStations(list);
  };

  // Merge saved manual order with current stations when stations change
  useEffect(() => {
    if (!stations.length) return;
    const saved: string[] = (() => {
      try { return JSON.parse(localStorage.getItem('psysonic_radio_order') ?? '[]'); }
      catch { return []; }
    })();
    const currentIds = new Set(stations.map(s => s.id));
    const merged = saved.filter((id: string) => currentIds.has(id));
    stations.forEach(s => { if (!merged.includes(s.id)) merged.push(s.id); });
    setManualOrder(merged);
  }, [stations]);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem('psysonic_radio_favorites', JSON.stringify([...next]));
      return next;
    });
  }, []);

  const handleReorder = useCallback((srcId: string, tgtId: string, side: 'before' | 'after') => {
    setManualOrder(prev => {
      const order = [...prev];
      const si = order.indexOf(srcId);
      if (si === -1) return prev;
      order.splice(si, 1);                         // remove from original position
      const ti = order.indexOf(tgtId);             // recalculate after removal
      if (ti === -1) return prev;
      const insertAt = side === 'before' ? ti : ti + 1;
      order.splice(insertAt, 0, srcId);
      localStorage.setItem('psysonic_radio_order', JSON.stringify(order));
      return order;
    });
  }, []);

  // After chip-filter + sort, but before alphabet filter — used to compute available letters
  const sortedFilteredStations = useMemo(() => {
    let list = [...stations];
    if (activeFilter === 'favorites') list = list.filter(s => favorites.has(s.id));
    if (sortBy === 'az') list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'za') list.sort((a, b) => b.name.localeCompare(a.name));
    else if (sortBy === 'newest') list.reverse();
    else {
      const orderMap = new Map(manualOrder.map((id, i) => [id, i]));
      list.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
    }
    return list;
  }, [stations, activeFilter, favorites, sortBy, manualOrder]);

  const availableLetters = useMemo(() => {
    const set = new Set<string>();
    for (const s of sortedFilteredStations) {
      const ch = s.name.trim()[0]?.toUpperCase() ?? '';
      if (ch >= 'A' && ch <= 'Z') set.add(ch);
      else if (ch) set.add('#');
    }
    return set;
  }, [sortedFilteredStations]);

  const displayedStations = useMemo(() => {
    if (!activeLetter) return sortedFilteredStations;
    return sortedFilteredStations.filter(s => {
      const ch = s.name.trim()[0]?.toUpperCase() ?? '';
      if (activeLetter === '#') return !(ch >= 'A' && ch <= 'Z');
      return ch === activeLetter;
    });
  }, [sortedFilteredStations, activeLetter]);

  const handleSave = async (opts: {
    name: string;
    streamUrl: string;
    homepageUrl: string;
    coverFile: File | null;
    coverRemoved: boolean;
  }) => {
    if (modalStation === 'new') {
      await createInternetRadioStation(
        opts.name.trim(),
        opts.streamUrl.trim(),
        opts.homepageUrl.trim() || undefined
      );
      if (opts.coverFile) {
        // Reload first to get the new station's ID, then upload cover
        const updated = await getInternetRadioStations().catch(() => [] as InternetRadioStation[]);
        const created = updated.find(
          s => s.name === opts.name.trim() && s.streamUrl === opts.streamUrl.trim()
        );
        if (created) {
          try {
            await uploadRadioCoverArt(created.id, opts.coverFile);
            await invalidateCoverArt(`ra-${created.id}`);
          } catch (err) {
            showToast(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Cover upload failed', 4000, 'error');
          }
          // Reload again so coverArt field is picked up
          await reload();
        } else {
          setStations(updated);
        }
      } else {
        await reload();
      }
    } else {
      const id = (modalStation as InternetRadioStation).id;
      await updateInternetRadioStation(
        id,
        opts.name.trim(),
        opts.streamUrl.trim(),
        opts.homepageUrl.trim() || undefined
      );
      if (opts.coverFile) {
        try {
          await uploadRadioCoverArt(id, opts.coverFile);
          await invalidateCoverArt(`ra-${id}`);
        } catch (err) {
          showToast(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Cover upload failed', 4000, 'error');
        }
      } else if (opts.coverRemoved) {
        await deleteRadioCoverArt(id).catch(() => {});
        await invalidateCoverArt(`ra-${id}`);
      }
      await reload();
    }
    setModalStation(null);
  };

  const handleDelete = async (e: React.MouseEvent, s: InternetRadioStation) => {
    e.stopPropagation();
    if (deleteConfirmId !== s.id) {
      setDeleteConfirmId(s.id);
      return;
    }
    if (currentRadio?.id === s.id) stop();
    try {
      await deleteInternetRadioStation(s.id);
      setStations(prev => prev.filter(st => st.id !== s.id));
    } catch {}
    setDeleteConfirmId(null);
  };

  const handlePlay = (e: React.MouseEvent, s: InternetRadioStation) => {
    e.stopPropagation();
    if (currentRadio?.id === s.id && isPlaying) {
      stop();
    } else {
      playRadio(s);
    }
  };

  if (loading) {
    return (
      <div className="content-body" style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="content-body animate-fade-in">

      {/* ── Header ── */}
      <div className="playlists-header">
        <h1 className="page-title" style={{ marginBottom: 0 }}>{t('radio.title')}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={() => setBrowseOpen(true)}>
            <Search size={14} /> {t('radio.browseDirectory')}
          </button>
          <button className="btn btn-primary" onClick={() => setModalStation('new')}>
            <Plus size={15} /> {t('radio.addStation')}
          </button>
        </div>
      </div>

      {/* ── Toolbar + Grid ── */}
      {stations.length === 0 ? (
        <div className="empty-state">{t('radio.empty')}</div>
      ) : (
        <>
          <RadioToolbar
            sortBy={sortBy}
            activeFilter={activeFilter}
            onSortChange={setSortBy}
            onFilterChange={f => { setActiveFilter(f); setActiveLetter(null); }}
          />
          <AlphabetFilterBar
            activeLetter={activeLetter}
            availableLetters={availableLetters}
            onSelect={l => setActiveLetter(prev => prev === l ? null : l)}
          />
          {displayedStations.length === 0 ? (
            <div className="empty-state">{t('radio.noFavorites')}</div>
          ) : (
            <div className="album-grid-wrap">
              {displayedStations.map(s => (
                <RadioCard
                  key={s.id}
                  s={s}
                  isActive={currentRadio?.id === s.id}
                  isPlaying={isPlaying}
                  deleteConfirmId={deleteConfirmId}
                  isFavorite={favorites.has(s.id)}
                  isManual={sortBy === 'manual'}
                  dropIndicator={dragOver?.id === s.id ? dragOver.side : null}
                  onPlay={e => handlePlay(e, s)}
                  onDelete={e => handleDelete(e, s)}
                  onEdit={() => setModalStation(s)}
                  onFavoriteToggle={() => toggleFavorite(s.id)}
                  onDragEnter={side => setDragOver({ id: s.id, side })}
                  onDragLeave={() => setDragOver(prev => prev?.id === s.id ? null : prev)}
                  onDropOnto={(srcId, side) => handleReorder(srcId, s.id, side)}
                  onCardMouseLeave={() => { if (deleteConfirmId === s.id) setDeleteConfirmId(null); }}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Edit/Create Modal ── */}
      {modalStation !== null && (
        <RadioEditModal
          station={modalStation === 'new' ? null : modalStation}
          onClose={() => setModalStation(null)}
          onSave={handleSave}
        />
      )}

      {/* ── Directory Modal ── */}
      {browseOpen && (
        <RadioDirectoryModal
          onClose={() => setBrowseOpen(false)}
          onAdded={reload}
        />
      )}
    </div>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────────────




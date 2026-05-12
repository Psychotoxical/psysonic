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

interface RadioToolbarProps {
  sortBy: 'manual' | 'az' | 'za' | 'newest';
  activeFilter: string;
  onSortChange: (s: 'manual' | 'az' | 'za' | 'newest') => void;
  onFilterChange: (f: string) => void;
}

function RadioToolbar({ sortBy, activeFilter, onSortChange, onFilterChange }: RadioToolbarProps) {
  const { t } = useTranslation();
  const sortOptions = [
    { value: 'manual', label: t('radio.sortManual') },
    { value: 'az',     label: t('radio.sortAZ') },
    { value: 'za',     label: t('radio.sortZA') },
    { value: 'newest', label: t('radio.sortNewest') },
  ];
  return (
    <div className="radio-toolbar">
      <div className="radio-toolbar-chips">
        {(['all', 'favorites'] as const).map(f => (
          <button
            key={f}
            className={`radio-filter-chip${activeFilter === f ? ' active' : ''}`}
            onClick={() => onFilterChange(f)}
          >
            {f === 'all' ? t('radio.filterAll') : t('radio.filterFavorites')}
          </button>
        ))}
      </div>
      <CustomSelect
        value={sortBy}
        options={sortOptions}
        onChange={v => onSortChange(v as RadioToolbarProps['sortBy'])}
        style={{ width: 'max-content', minWidth: 130, maxWidth: 220, flexShrink: 0 }}
      />
    </div>
  );
}

// ── Alphabet Filter Bar ────────────────────────────────────────────────────────

const ALPHABET_KEYS = ['#', ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))];

interface AlphabetFilterBarProps {
  activeLetter: string | null;
  availableLetters: Set<string>;
  onSelect: (l: string) => void;
}

function AlphabetFilterBar({ activeLetter, availableLetters, onSelect }: AlphabetFilterBarProps) {
  return (
    <div className="alphabet-filter-bar">
      {ALPHABET_KEYS.map(l => {
        const available = availableLetters.has(l);
        const active = activeLetter === l;
        return (
          <button
            key={l}
            className={`alphabet-filter-btn${active ? ' active' : ''}${!available ? ' empty' : ''}`}
            onClick={() => { if (available) onSelect(l); }}
            tabIndex={available ? 0 : -1}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

// ── Radio Card ────────────────────────────────────────────────────────────────

interface RadioCardProps {
  s: InternetRadioStation;
  isActive: boolean;
  isPlaying: boolean;
  deleteConfirmId: string | null;
  isFavorite: boolean;
  isManual: boolean;
  dropIndicator: 'before' | 'after' | null;
  onPlay: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  onEdit: () => void;
  onFavoriteToggle: () => void;
  onDragEnter: (side: 'before' | 'after') => void;
  onDragLeave: () => void;
  onDropOnto: (srcId: string, side: 'before' | 'after') => void;
  onCardMouseLeave: () => void;
}

function RadioCard({
  s, isActive, isPlaying, deleteConfirmId, isFavorite, isManual, dropIndicator,
  onPlay, onDelete, onEdit, onFavoriteToggle, onDragEnter, onDragLeave,
  onDropOnto, onCardMouseLeave,
}: RadioCardProps) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const lastSideRef = useRef<'before' | 'after'>('after');
  const { isDragging, payload } = useDragDrop();
  const isBeingDragged = isDragging && !!payload && (() => {
    try { return JSON.parse(payload.data).id === s.id; } catch { return false; }
  })();

  const dragHandlers = useDragSource(() => ({
    data: JSON.stringify({ type: 'radio', id: s.id }),
    label: s.name,
  }));

  // Calculate which half of the card the cursor is on
  const getSide = (e: React.MouseEvent): 'before' | 'after' => {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return 'after';
    return e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  };

  // psy-drop listener: fires when a drag is released over this card
  useEffect(() => {
    if (!isManual) return;
    const el = cardRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const data = JSON.parse((e as CustomEvent).detail?.data ?? '{}');
      if (data.type === 'radio' && data.id !== s.id) onDropOnto(data.id, lastSideRef.current);
    };
    el.addEventListener('psy-drop', handler);
    return () => el.removeEventListener('psy-drop', handler);
  }, [isManual, s.id, onDropOnto]);

  return (
    <div
      ref={cardRef}
      className={[
        'album-card radio-card',
        isActive ? 'radio-card-active' : '',
        dropIndicator === 'before' ? 'radio-card-drop-before' : '',
        dropIndicator === 'after' ? 'radio-card-drop-after' : '',
      ].filter(Boolean).join(' ')}
      style={{ cursor: isManual ? 'grab' : 'default', opacity: isBeingDragged ? 0.4 : 1 }}
      {...(isManual ? dragHandlers : {})}
      onMouseMove={e => {
        if (!isDragging || !isManual) return;
        const side = getSide(e);
        lastSideRef.current = side;
        onDragEnter(side);
      }}
      onMouseLeave={() => { onDragLeave(); onCardMouseLeave(); }}
    >
      {/* Cover */}
      <div className="album-card-cover">
        {s.coverArt ? (
          <CachedImage
            src={buildCoverArtUrl(`ra-${s.id}`, 256)}
            cacheKey={coverArtCacheKey(`ra-${s.id}`, 256)}
            alt={s.name}
            className="album-card-cover-img"
          />
        ) : (
          <div className="album-card-cover-placeholder playlist-card-icon">
            <Cast size={48} strokeWidth={1.2} />
          </div>
        )}

        {isActive && isPlaying && (
          <div className="radio-live-overlay">
            <span className="radio-live-badge">{t('radio.live')}</span>
          </div>
        )}

        <div className="album-card-play-overlay">
          <button className="album-card-details-btn" onClick={onPlay}>
            {isActive && isPlaying ? <X size={15} /> : <Cast size={14} />}
          </button>
        </div>

        <button
          className={`playlist-card-delete ${deleteConfirmId === s.id ? 'playlist-card-delete--confirm' : ''}`}
          onClick={onDelete}
          data-tooltip={deleteConfirmId === s.id ? t('radio.confirmDelete') : t('radio.deleteStation')}
          data-tooltip-pos="bottom"
        >
          {deleteConfirmId === s.id ? <Trash2 size={12} /> : <X size={12} />}
        </button>
      </div>

      {/* Info */}
      <div className="album-card-info">
        <div className="album-card-title">{s.name}</div>
        <div className="album-card-artist" style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
          <button className="radio-card-chip" onClick={onEdit}>
            {t('radio.editStation')}
          </button>
          <button
            className={`player-btn player-btn-sm radio-favorite-btn${isFavorite ? ' active' : ''}`}
            onClick={e => { e.stopPropagation(); onFavoriteToggle(); }}
            data-tooltip={t(isFavorite ? 'radio.unfavorite' : 'radio.favorite')}
          >
            <Heart size={11} fill={isFavorite ? 'currentColor' : 'none'} />
          </button>
          {s.homepageUrl && (
            <button
              className="player-btn player-btn-sm"
              style={{ opacity: 0.6 }}
              onClick={() => open(s.homepageUrl!)}
              data-tooltip={t('radio.openHomepage')}
            >
              <Globe size={11} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Radio Edit Modal ──────────────────────────────────────────────────────────

interface RadioEditModalProps {
  station: InternetRadioStation | null; // null = create new
  onClose: () => void;
  onSave: (opts: {
    name: string;
    streamUrl: string;
    homepageUrl: string;
    coverFile: File | null;
    coverRemoved: boolean;
  }) => Promise<void>;
}

function RadioEditModal({ station, onClose, onSave }: RadioEditModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(station?.name ?? '');
  const [streamUrl, setStreamUrl] = useState(station?.streamUrl ?? '');
  const [homepageUrl, setHomepageUrl] = useState(station?.homepageUrl ?? '');
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [coverRemoved, setCoverRemoved] = useState(false);
  const [saving, setSaving] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const hasExistingCover = !coverRemoved && (coverPreview || station?.coverArt);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCoverFile(file);
    setCoverRemoved(false);
    const reader = new FileReader();
    reader.onload = ev => setCoverPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleRemoveCover = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCoverFile(null);
    setCoverPreview(null);
    setCoverRemoved(true);
  };

  const handleSave = async () => {
    if (!name.trim() || !streamUrl.trim()) return;
    setSaving(true);
    try {
      await onSave({ name, streamUrl, homepageUrl, coverFile, coverRemoved });
    } finally {
      setSaving(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="modal-overlay" style={{ alignItems: 'center', paddingTop: 0, overflowY: 'auto' }} onClick={handleOverlayClick}>
      <div
        className="modal-content"
        style={{ maxWidth: 440, width: '90%', maxHeight: 'none', overflow: 'visible' }}
        onClick={e => e.stopPropagation()}
      >
        <button className="btn btn-ghost modal-close" onClick={onClose} style={{ top: 16, right: 16 }}>
          <X size={18} />
        </button>

        <h2 className="modal-title" style={{ fontSize: 20 }}>
          {station ? t('radio.editStation') : t('radio.addStation')}
        </h2>

        {/* Cover + fields side by side */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 20 }}>
          {/* Cover */}
          <div
            className="playlist-edit-cover-wrap"
            style={{ width: 140, height: 140 }}
            onClick={() => coverInputRef.current?.click()}
          >
            {coverPreview ? (
              <img src={coverPreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            ) : !coverRemoved && station?.coverArt ? (
              <CachedImage
                src={buildCoverArtUrl(`ra-${station.id}`, 256)}
                cacheKey={coverArtCacheKey(`ra-${station.id}`, 256)}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            ) : (
              <div className="album-card-cover-placeholder playlist-card-icon" style={{ width: '100%', height: '100%', borderRadius: 0 }}>
                <Cast size={36} strokeWidth={1.2} />
              </div>
            )}
            <div className="playlist-edit-cover-overlay">
              <div className="playlist-edit-cover-menu">
                <button
                  className="playlist-edit-cover-menu-item"
                  onClick={e => { e.stopPropagation(); coverInputRef.current?.click(); }}
                >
                  <Camera size={13} />
                  {t('radio.changeCoverLabel')}
                </button>
                {hasExistingCover && (
                  <button
                    className="playlist-edit-cover-menu-item playlist-edit-cover-menu-item--danger"
                    onClick={handleRemoveCover}
                  >
                    {t('radio.removeCover')}
                  </button>
                )}
              </div>
            </div>
            <input ref={coverInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
          </div>

          {/* Fields */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              className="input"
              style={{ fontSize: 15, fontWeight: 600 }}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('radio.stationName')}
              autoFocus
            />
            <input
              className="input"
              value={streamUrl}
              onChange={e => setStreamUrl(e.target.value)}
              placeholder={t('radio.streamUrl')}
            />
            <input
              className="input"
              value={homepageUrl}
              onChange={e => setHomepageUrl(e.target.value)}
              placeholder={t('radio.homepageUrl')}
            />
          </div>
        </div>

        <div className="playlist-edit-footer">
          <div />
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || !name.trim() || !streamUrl.trim()}
          >
            {saving ? <Loader2 size={14} className="spin-slow" /> : null}
            {t('radio.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Radio Directory Modal ─────────────────────────────────────────────────────

interface RadioDirectoryModalProps {
  onClose: () => void;
  onAdded: () => void;
}

function RadioDirectoryModal({ onClose, onAdded }: RadioDirectoryModalProps) {
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

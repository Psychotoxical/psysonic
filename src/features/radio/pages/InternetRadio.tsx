import {
  createInternetRadioStationForServer,
  deleteInternetRadioStationForServer,
  deleteRadioCoverArtForServer,
  getInternetRadioStationsForServer,
  updateInternetRadioStationForServer,
  uploadRadioCoverArtForServer,
} from '@/lib/api/subsonicRadio';
import { type InternetRadioStation } from '@/lib/api/subsonicTypes';
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { Plus, Search } from 'lucide-react';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { setRadioVolume } from '@/features/playback/store/radioPlayer';
import { fadeOut } from '@/features/playback/utils/playback/fadeOut';
import { invalidateCoverArt } from '@/cover';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/lib/dom/toast';
import RadioToolbar from '@/features/radio/components/RadioToolbar';
import AlphabetFilterBar from '@/features/radio/components/AlphabetFilterBar';
import RadioCard from '@/features/radio/components/RadioCard';
import RadioEditModal from '@/features/radio/components/RadioEditModal';
import RadioDirectoryModal from '@/features/radio/components/RadioDirectoryModal';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import { VirtualCardGrid } from '@/ui/VirtualCardGrid';
import { canManageNavidromeRadio, useNavidromeAdminRoles } from '@/lib/hooks/useNavidromeAdminRole';
import { useReachableLibrarySources } from '@/store/useReachableLibrarySources';
import { libraryEntityKey } from '@/lib/library/libraryEntityKey';
import { useAuthStore } from '@/store/authStore';
import { serverListDisplayLabel } from '@/lib/server/serverDisplayName';
import { qualifyStoredRadioIds } from '@/features/radio/utils/radioStationIdentity';

export default function InternetRadio() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const playRadio = usePlayerStore(s => s.playRadio);
  const stop = usePlayerStore(s => s.stop);
  const currentRadio = usePlayerStore(s => s.currentRadio);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const sources = useReachableLibrarySources();
  const servers = useAuthStore(s => s.servers);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const rolesByServer = useNavidromeAdminRoles(sources.map(source => source.serverId));
  const sourceOptions = useMemo(() => sources.flatMap(source => {
    const server = servers.find(candidate => candidate.id === source.serverId);
    return server ? [{ serverId: source.serverId, label: serverListDisplayLabel(server, servers) }] : [];
  }), [sources, servers]);
  const sourceLabelByServer = useMemo(
    () => Object.fromEntries(sourceOptions.map(source => [source.serverId, source.label])),
    [sourceOptions],
  );
  const canManageServer = useCallback(
    (serverId?: string) => !!serverId && canManageNavidromeRadio(rolesByServer[serverId] ?? 'checking'),
    [rolesByServer],
  );
  const manageableSources = useMemo(
    () => sourceOptions.filter(source => canManageServer(source.serverId)),
    [sourceOptions, canManageServer],
  );
  const canCreate = manageableSources.length > 0;

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
    Promise.all(sources.map(source => getInternetRadioStationsForServer(source.serverId)))
      .then(groups => setStations(groups.flat()))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sources]);

  const reload = async (serverId?: string) => {
    if (!serverId) {
      const groups = await Promise.all(sources.map(source => getInternetRadioStationsForServer(source.serverId)));
      setStations(groups.flat());
      return;
    }
    const list = await getInternetRadioStationsForServer(serverId);
    setStations(prev => [...prev.filter(station => station.serverId !== serverId), ...list]);
  };

  // Merge saved manual order with current stations when stations change
  useEffect(() => {
    if (!stations.length) return;
    const saved: string[] = (() => {
      try { return JSON.parse(localStorage.getItem('psysonic_radio_order') ?? '[]'); }
      catch { return []; }
    })();
    const merged = qualifyStoredRadioIds(saved, stations, activeServerId);
    stations.forEach(s => { const key = libraryEntityKey(s); if (!merged.includes(key)) merged.push(key); });
    localStorage.setItem('psysonic_radio_order', JSON.stringify(merged));
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setManualOrder(merged);
    setFavorites(previous => {
      const qualified = qualifyStoredRadioIds([...previous], stations, activeServerId);
      const next = new Set(qualified);
      localStorage.setItem('psysonic_radio_favorites', JSON.stringify(qualified));
      return next;
    });
  }, [stations, activeServerId]);

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
    if (activeFilter === 'favorites') list = list.filter(s => favorites.has(libraryEntityKey(s)));
    if (sortBy === 'az') list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'za') list.sort((a, b) => b.name.localeCompare(a.name));
    else if (sortBy === 'newest') list.reverse();
    else {
      const orderMap = new Map(manualOrder.map((id, i) => [id, i]));
      list.sort((a, b) => (orderMap.get(libraryEntityKey(a)) ?? 999) - (orderMap.get(libraryEntityKey(b)) ?? 999));
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
    serverId: string;
    name: string;
    streamUrl: string;
    homepageUrl: string;
    coverFile: File | null;
    coverRemoved: boolean;
  }) => {
    const serverId = modalStation === 'new' ? opts.serverId : modalStation?.serverId;
    if (!serverId) return;
    if (modalStation === 'new') {
      await createInternetRadioStationForServer(
        serverId,
        opts.name.trim(),
        opts.streamUrl.trim(),
        opts.homepageUrl.trim() || undefined
      );
      if (opts.coverFile) {
        // Reload first to get the new station's ID, then upload cover
        const updated = await getInternetRadioStationsForServer(serverId);
        const created = updated.find(
          s => s.name === opts.name.trim() && s.streamUrl === opts.streamUrl.trim()
        );
        if (created) {
          try {
            await uploadRadioCoverArtForServer(serverId, created.id, opts.coverFile);
            await invalidateCoverArt(`ra-${created.id}`);
          } catch (err) {
            showToast(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Cover upload failed', 4000, 'error');
          }
          // Reload again so coverArt field is picked up
          await reload(serverId);
        } else {
          setStations(updated);
        }
      } else {
        await reload(serverId);
      }
    } else {
      const id = (modalStation as InternetRadioStation).id;
      await updateInternetRadioStationForServer(
        serverId,
        id,
        opts.name.trim(),
        opts.streamUrl.trim(),
        opts.homepageUrl.trim() || undefined
      );
      if (opts.coverFile) {
        try {
          await uploadRadioCoverArtForServer(serverId, id, opts.coverFile);
          await invalidateCoverArt(`ra-${id}`);
        } catch (err) {
          showToast(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Cover upload failed', 4000, 'error');
        }
      } else if (opts.coverRemoved) {
        await deleteRadioCoverArtForServer(serverId, id).catch(() => {});
        await invalidateCoverArt(`ra-${id}`);
      }
      await reload(serverId);
    }
    setModalStation(null);
  };

  const handleDelete = async (e: React.MouseEvent, s: InternetRadioStation) => {
    e.stopPropagation();
    const stationKey = libraryEntityKey(s);
    if (deleteConfirmId !== stationKey) {
      setDeleteConfirmId(stationKey);
      return;
    }
    if (currentRadio && libraryEntityKey(currentRadio) === stationKey) {
      if (isPlaying) {
        const vol = usePlayerStore.getState().volume;
        await fadeOut(setRadioVolume, vol, 700);
      }
      stop();
    }
    try {
      if (!s.serverId) throw new Error('Station owner unavailable');
      await deleteInternetRadioStationForServer(s.serverId, s.id);
      setStations(prev => prev.filter(st => libraryEntityKey(st) !== stationKey));
    } catch { /* ignore: best-effort */ }
    setDeleteConfirmId(null);
  };

  const handlePlay = (e: React.MouseEvent, s: InternetRadioStation) => {
    e.stopPropagation();
    if (currentRadio && libraryEntityKey(currentRadio) === libraryEntityKey(s) && isPlaying) {
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
        {canCreate && (
          <div className="compact-action-bar" style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={() => setBrowseOpen(true)} aria-label={t('radio.browseDirectory')} data-tooltip={t('radio.browseDirectory')}>
              <Search size={14} /> <span className="compact-btn-label">{t('radio.browseDirectory')}</span>
            </button>
            <button className="btn btn-primary" onClick={() => setModalStation('new')} aria-label={t('radio.addStation')} data-tooltip={t('radio.addStation')}>
              <Plus size={15} /> <span className="compact-btn-label">{t('radio.addStation')}</span>
            </button>
          </div>
        )}
      </div>

      {sources.length > 1 && (
        <div className="source-group-list" aria-label={t('radio.sources')}>
          {sourceOptions.map(source => <span key={source.serverId} className="source-group-label">{source.label}</span>)}
        </div>
      )}

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
            <VirtualCardGrid
              items={displayedStations}
              itemKey={(s, _i) => libraryEntityKey(s)}
              rowVariant="album"
              disableVirtualization={perfFlags.disableMainstageVirtualLists}
              layoutSignal={displayedStations.length}
              renderItem={s => (
                <RadioCard
                  s={s}
                  isActive={!!currentRadio && libraryEntityKey(currentRadio) === libraryEntityKey(s)}
                  isPlaying={isPlaying}
                  deleteConfirmId={deleteConfirmId}
                  isFavorite={favorites.has(libraryEntityKey(s))}
                  isManual={sortBy === 'manual'}
                  canManage={canManageServer(s.serverId)}
                  sourceLabel={sources.length > 1 && s.serverId ? sourceLabelByServer[s.serverId] : undefined}
                  dropIndicator={dragOver?.id === libraryEntityKey(s) ? dragOver.side : null}
                  onPlay={e => handlePlay(e, s)}
                  onDelete={e => handleDelete(e, s)}
                  onEdit={() => setModalStation(s)}
                  onFavoriteToggle={() => toggleFavorite(libraryEntityKey(s))}
                  onDragEnter={side => setDragOver({ id: libraryEntityKey(s), side })}
                  onDragLeave={() => setDragOver(prev => prev?.id === libraryEntityKey(s) ? null : prev)}
                  onDropOnto={(srcId, side) => handleReorder(srcId, libraryEntityKey(s), side)}
                  onCardMouseLeave={() => { if (deleteConfirmId === libraryEntityKey(s)) setDeleteConfirmId(null); }}
                />
              )}
            />
          )}
        </>
      )}

      {/* ── Edit/Create Modal ── */}
      {modalStation !== null && (modalStation === 'new' ? canCreate : canManageServer(modalStation.serverId)) && (
        <RadioEditModal
          station={modalStation === 'new' ? null : modalStation}
          sources={manageableSources}
          requireSourceSelection={sources.length > 1}
          onClose={() => setModalStation(null)}
          onSave={handleSave}
        />
      )}

      {/* ── Directory Modal ── */}
      {canCreate && browseOpen && (
        <RadioDirectoryModal
          sources={manageableSources}
          requireSourceSelection={sources.length > 1}
          onClose={() => setBrowseOpen(false)}
          onAdded={reload}
        />
      )}
    </div>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

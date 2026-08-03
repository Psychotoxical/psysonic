import {
  createInternetRadioStationForServer,
  deleteInternetRadioStationForServer,
  deleteRadioCoverArtForServer,
  getInternetRadioStationsForServer,
  getInternetRadioStationsForServersSettled,
  updateInternetRadioStationForServer,
  uploadRadioCoverArtForServer,
} from '@/lib/api/subsonicRadio';
import { type InternetRadioStation } from '@/lib/api/subsonicTypes';
import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Plus, Search } from 'lucide-react';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { setRadioVolume } from '@/features/playback/store/radioPlayer';
import { fadeOut } from '@/features/playback/utils/playback/fadeOut';
import { invalidateRadioCoverArtCache } from '@/cover/radioCoverInvalidation';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/lib/dom/toast';
import RadioToolbar, { type RadioSortBy } from '@/features/radio/components/RadioToolbar';
import CustomSelect from '@/ui/CustomSelect';
import AlphabetFilterBar from '@/features/radio/components/AlphabetFilterBar';
import RadioCard from '@/features/radio/components/RadioCard';
import RadioEditModal from '@/features/radio/components/RadioEditModal';
import RadioDirectoryModal from '@/features/radio/components/RadioDirectoryModal';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import { VirtualCardGrid } from '@/ui/VirtualCardGrid';
import { canManageNavidromeRadio, useNavidromeAdminRoles } from '@/lib/hooks/useNavidromeAdminRole';
import { useAuthStore } from '@/store/authStore';
import { deriveEffectiveLibraryBrowseServerIds } from '@/lib/library/libraryBrowseScope';
import { getUnavailableServerIds, useUnavailableServerIds } from '@/lib/network/serverReachability';
import { serverListDisplayLabel } from '@/lib/server/serverDisplayName';
import {
  migrateRadioStationKeys,
  radioStationKey,
  sameRadioStation,
} from '@/features/radio/utils/radioStationIdentity';

export default function InternetRadio() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const playRadio = usePlayerStore(s => s.playRadio);
  const stop = usePlayerStore(s => s.stop);
  const currentRadio = usePlayerStore(s => s.currentRadio);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const servers = useAuthStore(s => s.servers);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const libraryBrowseServerIds = useAuthStore(s => s.libraryBrowseServerIds);
  const unavailableServerIds = useUnavailableServerIds();
  const effectiveServerIds = useMemo(() => deriveEffectiveLibraryBrowseServerIds({
    servers,
    activeServerId,
    libraryBrowseServerIds,
  }, unavailableServerIds), [activeServerId, libraryBrowseServerIds, servers, unavailableServerIds]);
  const adminRoles = useNavidromeAdminRoles(effectiveServerIds);
  const serverLabelById = useMemo(() => new Map(
    servers.map(server => [server.id, serverListDisplayLabel(server, servers)]),
  ), [servers]);
  const manageableServerOptions = useMemo(() => effectiveServerIds
    .filter(serverId => canManageNavidromeRadio(adminRoles[serverId] ?? 'checking'))
    .map(serverId => ({
      id: serverId,
      label: serverLabelById.get(serverId) ?? serverId,
    })), [adminRoles, effectiveServerIds, serverLabelById]);

  const [stations, setStations] = useState<InternetRadioStation[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [modalStation, setModalStation] = useState<
    InternetRadioStation | { kind: 'new' } | null
  >(null);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const loadGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const reloadGenerationByServerRef = useRef(new Map<string, number>());

  const [sortBy, setSortBy] = useState<RadioSortBy>('manual');
  const sortOptions = [
    { value: 'manual', label: t('radio.sortManual') },
    { value: 'az', label: t('radio.sortAZ') },
    { value: 'za', label: t('radio.sortZA') },
    { value: 'newest', label: t('radio.sortNewest') },
  ];
  const [activeFilter, setActiveFilter] = useState('all');
  const [activeLetter, setActiveLetter] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem('psysonic_radio_favorites') ?? '[]')); }
    catch { return new Set<string>(); }
  });
  const [manualOrder, setManualOrder] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState<{ id: string; side: 'before' | 'after' } | null>(null);

  const targetServerId = activeServerId && manageableServerOptions.some(server => server.id === activeServerId)
      ? activeServerId
      : manageableServerOptions[0]?.id ?? '';

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    const mutationGeneration = mutationGenerationRef.current;
    // React Compiler set-state-in-effect rule: reset loading before the scoped async read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    void getInternetRadioStationsForServersSettled(effectiveServerIds)
      .then(({ stations: loaded, failedServerIds }) => {
        if (
          generation !== loadGenerationRef.current
          || mutationGeneration !== mutationGenerationRef.current
        ) return;
        const failed = new Set(failedServerIds);
        setStations(previous => effectiveServerIds.flatMap(serverId => failed.has(serverId)
          ? previous.filter(station => station.serverId === serverId)
          : loaded.filter(station => station.serverId === serverId)));
      })
      .finally(() => {
        if (generation === loadGenerationRef.current) setLoading(false);
      });
    return () => {
      if (loadGenerationRef.current === generation) loadGenerationRef.current += 1;
    };
  }, [effectiveServerIds]);

  const reloadServer = useCallback(async (serverId: string) => {
    if (!serverId) return;
    const generation = (reloadGenerationByServerRef.current.get(serverId) ?? 0) + 1;
    reloadGenerationByServerRef.current.set(serverId, generation);
    try {
      const loaded = await getInternetRadioStationsForServer(serverId);
      if (reloadGenerationByServerRef.current.get(serverId) !== generation) return;
      const currentServerIds = deriveEffectiveLibraryBrowseServerIds(
        useAuthStore.getState(),
        getUnavailableServerIds(),
      );
      if (!currentServerIds.includes(serverId)) return;
      setStations(previous => [
        ...previous.filter(station => station.serverId !== serverId),
        ...loaded,
      ]);
    } catch {
      // Keep the previous owner slice when its refresh fails.
    }
  }, []);

  const beginMutation = useCallback((serverId: string) => {
    mutationGenerationRef.current += 1;
    reloadGenerationByServerRef.current.set(
      serverId,
      (reloadGenerationByServerRef.current.get(serverId) ?? 0) + 1,
    );
  }, []);

  const completeMutation = useCallback(() => {
    mutationGenerationRef.current += 1;
  }, []);

  // Merge saved manual order with current stations when stations change
  useEffect(() => {
    if (!stations.length) return;
    const saved: string[] = (() => {
      try { return JSON.parse(localStorage.getItem('psysonic_radio_order') ?? '[]'); }
      catch { return []; }
    })();
    const merged = migrateRadioStationKeys(saved, stations);
    stations.forEach(s => {
      const key = radioStationKey(s);
      if (!merged.includes(key)) merged.push(key);
    });
    localStorage.setItem('psysonic_radio_order', JSON.stringify(merged));
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setManualOrder(merged);
  }, [stations, activeServerId]);

  useEffect(() => {
    if (!stations.length) return;
    // React Compiler set-state-in-effect rule: migrate persisted raw ids after owners load.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFavorites(previous => {
      const migrated = new Set(migrateRadioStationKeys([...previous], stations));
      localStorage.setItem('psysonic_radio_favorites', JSON.stringify([...migrated]));
      return migrated;
    });
  }, [stations, activeServerId]);

  const toggleFavorite = useCallback((station: InternetRadioStation) => {
    const id = radioStationKey(station);
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
    if (activeFilter === 'favorites') list = list.filter(s => favorites.has(radioStationKey(s)));
    if (sortBy === 'az') list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'za') list.sort((a, b) => b.name.localeCompare(a.name));
    else if (sortBy === 'newest') list.reverse();
    else {
      const orderMap = new Map(manualOrder.map((id, i) => [id, i]));
      list.sort((a, b) => (orderMap.get(radioStationKey(a)) ?? 999) - (orderMap.get(radioStationKey(b)) ?? 999));
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
    if (modalStation && 'kind' in modalStation) {
      const ownerServerId = opts.serverId;
      if (!ownerServerId) return;
      beginMutation(ownerServerId);
      await createInternetRadioStationForServer(
        ownerServerId,
        opts.name.trim(),
        opts.streamUrl.trim(),
        opts.homepageUrl.trim() || undefined
      );
      if (opts.coverFile) {
        // Reload first to get the new station's ID, then upload cover
        const updated = await getInternetRadioStationsForServer(ownerServerId)
          .catch(() => [] as InternetRadioStation[]);
        const created = updated.find(
          s => s.name === opts.name.trim() && s.streamUrl === opts.streamUrl.trim()
        );
        if (created) {
          try {
            await uploadRadioCoverArtForServer(ownerServerId, created.id, opts.coverFile);
            await invalidateRadioCoverArtCache(created);
          } catch (err) {
            showToast(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Cover upload failed', 4000, 'error');
          }
        }
        completeMutation();
        // Reload again so coverArt and the concrete owner slice are current.
        await reloadServer(ownerServerId);
      } else {
        completeMutation();
        await reloadServer(ownerServerId);
      }
    } else {
      const station = modalStation as InternetRadioStation;
      const id = station.id;
      const ownerServerId = station.serverId;
      if (!ownerServerId) return;
      beginMutation(ownerServerId);
      await updateInternetRadioStationForServer(
        ownerServerId,
        id,
        opts.name.trim(),
        opts.streamUrl.trim(),
        opts.homepageUrl.trim() || undefined
      );
      if (opts.coverFile) {
        try {
          await uploadRadioCoverArtForServer(ownerServerId, id, opts.coverFile);
          await invalidateRadioCoverArtCache(station);
        } catch (err) {
          showToast(typeof err === 'string' ? err : err instanceof Error ? err.message : 'Cover upload failed', 4000, 'error');
        }
      } else if (opts.coverRemoved) {
        await deleteRadioCoverArtForServer(ownerServerId, id).catch(() => {});
        await invalidateRadioCoverArtCache(station);
      }
      completeMutation();
      await reloadServer(ownerServerId);
    }
    setModalStation(null);
  };

  const handleDelete = async (e: React.MouseEvent, s: InternetRadioStation) => {
    e.stopPropagation();
    const stationKey = radioStationKey(s);
    if (deleteConfirmId !== stationKey) {
      setDeleteConfirmId(stationKey);
      return;
    }
    if (sameRadioStation(currentRadio, s)) {
      if (isPlaying) {
        const vol = usePlayerStore.getState().volume;
        await fadeOut(setRadioVolume, vol, 700);
      }
      stop();
    }
    try {
      if (!s.serverId) throw new Error('Radio station owner unavailable');
      beginMutation(s.serverId);
      await deleteInternetRadioStationForServer(s.serverId, s.id);
      completeMutation();
      setStations(prev => prev.filter(st => radioStationKey(st) !== stationKey));
    } catch { /* ignore: best-effort */ }
    setDeleteConfirmId(null);
  };

  const handlePlay = (e: React.MouseEvent, s: InternetRadioStation) => {
    e.stopPropagation();
    if (sameRadioStation(currentRadio, s) && isPlaying) {
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
        <div className="compact-action-bar" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {stations.length > 0 && (
            <CustomSelect
              value={sortBy}
              options={sortOptions}
              onChange={v => setSortBy(v as RadioSortBy)}
              style={{ width: 'max-content', minWidth: 130, maxWidth: 220, flexShrink: 0 }}
            />
          )}
          {targetServerId && (<>
              <button className="btn btn-primary" onClick={() => setDirectoryOpen(true)} aria-label={t('radio.browseDirectory')} data-tooltip={t('radio.browseDirectory')}>
                <Search size={14} /> <span className="compact-btn-label">{t('radio.browseDirectory')}</span>
              </button>
              <button className="btn btn-primary" onClick={() => setModalStation({ kind: 'new' })} aria-label={t('radio.addStation')} data-tooltip={t('radio.addStation')}>
                <Plus size={15} /> <span className="compact-btn-label">{t('radio.addStation')}</span>
              </button>
            </>)}
        </div>
      </div>

      {/* ── Toolbar + Grid ── */}
      {stations.length === 0 ? (
        <div className="empty-state">{t('radio.empty')}</div>
      ) : (
        <>
          <RadioToolbar
            activeFilter={activeFilter}
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
              itemKey={(s, _i) => radioStationKey(s)}
              rowVariant="album"
              disableVirtualization={perfFlags.disableMainstageVirtualLists}
              layoutSignal={displayedStations.length}
              renderItem={s => (
                <RadioCard
                  s={s}
                  isActive={sameRadioStation(currentRadio, s)}
                  isPlaying={isPlaying}
                  deleteConfirmId={deleteConfirmId}
                  isFavorite={favorites.has(radioStationKey(s))}
                  isManual={sortBy === 'manual'}
                  canManage={Boolean(
                    s.serverId && canManageNavidromeRadio(adminRoles[s.serverId] ?? 'checking'),
                  )}
                  serverLabel={effectiveServerIds.length > 1 && s.serverId
                    ? serverLabelById.get(s.serverId)
                    : undefined}
                  dropIndicator={dragOver?.id === radioStationKey(s) ? dragOver.side : null}
                  onPlay={e => handlePlay(e, s)}
                  onDelete={e => handleDelete(e, s)}
                  onEdit={() => setModalStation(s)}
                  onFavoriteToggle={() => toggleFavorite(s)}
                  onDragEnter={side => setDragOver({ id: radioStationKey(s), side })}
                  onDragLeave={() => setDragOver(prev => prev?.id === radioStationKey(s) ? null : prev)}
                  onDropOnto={(srcId, side) => handleReorder(srcId, radioStationKey(s), side)}
                  onCardMouseLeave={() => {
                    if (deleteConfirmId === radioStationKey(s)) setDeleteConfirmId(null);
                  }}
                />
              )}
            />
          )}
        </>
      )}

      {/* ── Edit/Create Modal ── */}
      {modalStation !== null && (
        <RadioEditModal
          station={'kind' in modalStation ? null : modalStation}
          initialServerId={'kind' in modalStation ? targetServerId : modalStation.serverId ?? ''}
          serverOptions={manageableServerOptions}
          onClose={() => setModalStation(null)}
          onSave={handleSave}
        />
      )}

      {/* ── Directory Modal ── */}
      {directoryOpen && (
        <RadioDirectoryModal
          initialServerId={targetServerId}
          serverOptions={manageableServerOptions}
          onMutationStart={beginMutation}
          onClose={() => setDirectoryOpen(false)}
          onAdded={serverId => {
            completeMutation();
            return reloadServer(serverId);
          }}
        />
      )}
    </div>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

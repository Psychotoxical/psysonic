import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListMusic, Plus } from 'lucide-react';
import { getPlaylist, updatePlaylist } from '../../api/subsonicPlaylists';
import type { SubsonicPlaylist } from '../../api/subsonicTypes';
import { usePlaylistStore } from '../../store/playlistStore';
import { showToast } from '../../utils/ui/toast';
import {
  confirmAddAllDuplicates,
  isSmartPlaylistName,
} from '../../utils/componentHelpers/contextMenuHelpers';

interface Props {
  songIds: string[];
  onDone: () => void;
  dropDown?: boolean;
  triggerId?: string;
}

export function AddToPlaylistSubmenu({ songIds, onDone, dropDown, triggerId }: Props) {
  const { t } = useTranslation();
  const subRef = useRef<HTMLDivElement>(null);
  const newNameRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [flipLeft, setFlipLeft] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const storePlaylists = usePlaylistStore((s) => s.playlists);
  const recentIds = usePlaylistStore((s) => s.recentIds);
  const createPlaylist = usePlaylistStore((s) => s.createPlaylist);
  const touchPlaylist = usePlaylistStore((s) => s.touchPlaylist);
  const fetchPlaylists = usePlaylistStore((s) => s.fetchPlaylists);

  useEffect(() => {
    if (storePlaylists.length === 0) fetchPlaylists();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const playlists = useMemo(() => {
    return [...storePlaylists]
      .filter(p => !isSmartPlaylistName(p.name))
      .sort((a, b) => {
        const ai = recentIds.indexOf(a.id);
        const bi = recentIds.indexOf(b.id);
        if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
  }, [storePlaylists, recentIds]);

  useLayoutEffect(() => {
    if (subRef.current) {
      const rect = subRef.current.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) setFlipLeft(true);
      if (rect.bottom > window.innerHeight - 8) setFlipUp(true);
    }
  }, []);

  useEffect(() => {
    if (creating) newNameRef.current?.focus();
  }, [creating]);

  const handleAdd = async (pl: SubsonicPlaylist) => {
    setAdding(pl.id);
    try {
      const { songs } = await getPlaylist(pl.id);
      const existingIds = new Set(songs.map((s) => s.id));
      const newIds = songIds.filter((id) => !existingIds.has(id));
      if (newIds.length > 0) {
        await updatePlaylist(pl.id, [...songs.map((s) => s.id), ...newIds]);
        showToast(t('playlists.addSuccess', { count: newIds.length, playlist: pl.name }));
        touchPlaylist(pl.id);
      } else {
        const accepted = await confirmAddAllDuplicates(pl.name, songIds.length, t);
        if (accepted) {
          await updatePlaylist(pl.id, [...songs.map((s) => s.id), ...songIds]);
          showToast(t('playlists.addedAsDuplicates', { count: songIds.length, playlist: pl.name }), 3000, 'info');
          touchPlaylist(pl.id);
        } else {
          showToast(t('playlists.addAllSkipped', { count: songIds.length, playlist: pl.name }), 3000, 'info');
        }
      }
    } catch {
      showToast(t('playlists.addError'), 3000, 'error');
    }
    setAdding(null);
    onDone();
  };

  const handleCreate = async () => {
    const name = newName.trim() || t('playlists.unnamed');
    try {
      const pl = await createPlaylist(name, songIds);
      if (pl?.id) {
        showToast(t('playlists.createAndAddSuccess', { count: songIds.length, playlist: pl.name || name }));
      }
    } catch {
      showToast(t('playlists.createError'), 3000, 'error');
    }
    onDone();
  };

  // Flush to the parent edge (left/right/top 100%). Actual “hole” cases are handled
  // in ContextMenu via a short delayed mouseleave + :hover check on the trigger row.
  const subStyle: React.CSSProperties = dropDown
    ? { top: '100%', left: 0, right: 'auto' }
    : flipLeft
      ? { right: '100%', left: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' }
      : { left: '100%', right: 'auto', top: flipUp ? 'auto' : -4, bottom: flipUp ? 0 : 'auto' };

  return (
    <div className="context-submenu" data-parent-trigger-id={triggerId ?? ''} ref={subRef} style={subStyle}>
      {!creating ? (
        <div
          className="context-menu-item context-submenu-new"
          onClick={e => { e.stopPropagation(); setCreating(true); }}
        >
          <Plus size={13} /> {t('playlists.newPlaylist')}
        </div>
      ) : (
        <div className="context-submenu-create" onClick={e => e.stopPropagation()}>
          <input
            ref={newNameRef}
            className="context-submenu-input"
            placeholder={t('playlists.createName')}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreate();
              if (e.key === 'Escape') { setCreating(false); setNewName(''); }
            }}
          />
          <button className="context-submenu-create-btn" onClick={handleCreate}>
            <Plus size={13} />
          </button>
        </div>
      )}

      <div className="context-menu-divider" />

      {playlists.length === 0 && (
        <div className="context-submenu-empty">{t('playlists.empty')}</div>
      )}
      {playlists.map((pl: SubsonicPlaylist) => (
        <div
          key={pl.id}
          className="context-menu-item"
          onClick={() => handleAdd(pl)}
          style={{ opacity: adding === pl.id ? 0.5 : 1, pointerEvents: adding ? 'none' : undefined }}
        >
          <ListMusic size={13} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pl.name}</span>
        </div>
      ))}
    </div>
  );
}

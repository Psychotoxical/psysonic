import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, Pencil, Trash2 } from 'lucide-react';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { usePlaylistFolderStore } from '@/features/playlist/store/playlistFolderStore';
import type { PlaylistFolder } from '@/features/playlist/utils/playlistFolders';
import { useDragDrop } from '@/lib/dnd/DragDropContext';
import { VirtualCardGrid } from '@/ui/VirtualCardGrid';

interface Props {
  serverId: string;
  /** The folder this section renders, or null for the ungrouped remainder. */
  folder: PlaylistFolder | null;
  items: SubsonicPlaylist[];
  renderCard: (pl: SubsonicPlaylist) => React.ReactNode;
  disableVirtualization: boolean;
}

/**
 * One folder section (header + card grid), or the ungrouped remainder when
 * `folder` is null. The header is a `psy-drop` target: dropping a dragged
 * playlist card here assigns it to this folder (or unfiles it for ungrouped).
 * Uses the shared mouse-based DnD system (HTML5 DnD is unusable in WebKitGTK).
 */
export default function PlaylistFolderSection({
  serverId, folder, items, renderCard, disableVirtualization,
}: Props) {
  const { t } = useTranslation();
  const { isDragging } = useDragDrop();
  const renameFolder = usePlaylistFolderStore(s => s.renameFolder);
  const deleteFolder = usePlaylistFolderStore(s => s.deleteFolder);
  const toggleFolderCollapsed = usePlaylistFolderStore(s => s.toggleFolderCollapsed);
  const setPlaylistFolder = usePlaylistFolderStore(s => s.setPlaylistFolder);

  const sectionRef = useRef<HTMLElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isOver, setIsOver] = useState(false);

  const targetId = folder ? folder.id : null;

  // The whole section is the drop zone: a `psy-drop` released anywhere inside it
  // (header or a card in the grid — events bubble up) files the playlist here.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      setIsOver(false);
      try {
        const data = JSON.parse((e as CustomEvent).detail?.data ?? '{}');
        if (data.type === 'playlist' && data.id) setPlaylistFolder(serverId, data.id, targetId);
      } catch { /* ignore non-playlist drops */ }
    };
    el.addEventListener('psy-drop', handler);
    return () => el.removeEventListener('psy-drop', handler);
  }, [serverId, targetId, setPlaylistFolder]);

  // Highlight while a drag hovers the section (mouse events still fire during the
  // custom drag, unlike native HTML5 DnD).
  const hoverProps = {
    onMouseMove: () => { if (isDragging && !isOver) setIsOver(true); },
    onMouseLeave: () => setIsOver(false),
  };

  const grid = items.length > 0 && (
    <VirtualCardGrid
      items={items}
      itemKey={pl => pl.id}
      rowVariant="playlist"
      disableVirtualization={disableVirtualization}
      layoutSignal={items.length}
      renderItem={renderCard}
    />
  );

  if (!folder) {
    return (
      <section
        ref={sectionRef}
        className={`playlist-folder playlist-folder--ungrouped${isOver ? ' drag-over' : ''}`}
        {...hoverProps}
      >
        <div className="playlist-folder-header playlist-folder-header--static">
          <Folder size={16} className="playlist-folder-icon" />
          <span className="playlist-folder-name playlist-folder-name--static">
            {t('playlists.folders.ungrouped')}
          </span>
          <span className="playlist-folder-count">{t('playlists.folders.count', { count: items.length })}</span>
        </div>
        {items.length > 0 ? grid : (
          <div className="playlist-folder-dropzone">{t('playlists.folders.removeFromFolder')}</div>
        )}
      </section>
    );
  }

  const commitRename = () => {
    if (draft.trim()) renameFolder(serverId, folder.id, draft.trim());
    setRenaming(false);
    setDraft('');
  };

  return (
    <section
      ref={sectionRef}
      className={`playlist-folder${isOver ? ' drag-over' : ''}`}
      {...hoverProps}
    >
      <div className="playlist-folder-header">
        <button
          className={`playlist-folder-toggle${folder.collapsed ? '' : ' expanded'}`}
          onClick={() => toggleFolderCollapsed(serverId, folder.id)}
          aria-expanded={!folder.collapsed}
          aria-label={folder.collapsed ? t('playlists.folders.expandFolder') : t('playlists.folders.collapseFolder')}
        >
          <ChevronRight size={16} />
        </button>
        <Folder size={16} className="playlist-folder-icon" />
        {renaming ? (
          <input
            autoFocus
            className="playlist-folder-rename-input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setRenaming(false); setDraft(''); }
            }}
          />
        ) : (
          <button className="playlist-folder-name" onClick={() => toggleFolderCollapsed(serverId, folder.id)}>
            {folder.name}
          </button>
        )}
        <span className="playlist-folder-count">{t('playlists.folders.count', { count: items.length })}</span>
        <div className="playlist-folder-actions">
          <button
            className="playlist-folder-action"
            data-tooltip={t('playlists.folders.rename')}
            aria-label={t('playlists.folders.rename')}
            onClick={() => { setRenaming(true); setDraft(folder.name); }}
          >
            <Pencil size={14} />
          </button>
          <button
            className={`playlist-folder-action playlist-folder-action--delete${confirmDelete ? ' is-confirm' : ''}`}
            data-tooltip={confirmDelete ? t('playlists.confirmDelete') : t('playlists.folders.delete')}
            aria-label={t('playlists.folders.delete')}
            onClick={() => {
              if (confirmDelete) { deleteFolder(serverId, folder.id); setConfirmDelete(false); }
              else setConfirmDelete(true);
            }}
            onMouseLeave={() => setConfirmDelete(false)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {!folder.collapsed && (
        items.length === 0 ? (
          <div className="playlist-folder-empty">{t('playlists.empty')}</div>
        ) : (
          grid
        )
      )}
    </section>
  );
}

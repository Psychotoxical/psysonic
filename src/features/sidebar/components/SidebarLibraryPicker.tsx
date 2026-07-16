import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Music2,
} from 'lucide-react';
import type { SyncStateDto } from '@/lib/api/library/dto';
import { useDragSource } from '@/lib/dnd/DragDropContext';
import { useListReorderDnd } from '@/lib/hooks/useListReorderDnd';
import { useModalFocus } from '@/lib/hooks/useModalFocus';
import { libraryStatusIsReady } from '@/lib/library/libraryReady';
import type { BrowseScopeExcludedReason } from '@/lib/library/libraryBrowseScope';
import type { LibraryServerConnection } from '@/lib/network/libraryServerReachability';
import { applyListReorderById } from '@/lib/util/listReorder';

interface MusicFolder { id: string; name: string }

export interface SidebarLibraryServer {
  id: string;
  label: string;
  selected: boolean;
  folders: MusicFolder[];
  selectedLibraryIds: string[];
  status: SyncStateDto | null;
  connection: LibraryServerConnection;
  excludedReasons: BrowseScopeExcludedReason[];
}

interface Props {
  selectedLibraryIds: string[];
  selectionSummary: string | null;
  libraryDropdownOpen: boolean;
  setLibraryDropdownOpen: (open: boolean) => void;
  dropdownRect: { top: number; left: number; width: number };
  libraryTriggerRef: React.RefObject<HTMLButtonElement | null>;
  musicFolders: MusicFolder[];
  onSelectionChange: (libraryIds: string[]) => void;
  servers?: SidebarLibraryServer[];
  onServerSelectionChange?: (serverId: string, selected: boolean) => void;
  onServerLibrarySelectionChange?: (serverId: string, libraryIds: string[]) => void;
  onServersReorder?: (serverIds: string[]) => void;
}

type ServerStatus = 'online' | 'offline' | 'indexing' | 'notReady';

function statusForServer(server: SidebarLibraryServer): ServerStatus {
  if (server.connection === 'offline') return 'offline';
  if (server.connection === 'online' && server.status && libraryStatusIsReady(server.status)) {
    return 'online';
  }
  if (server.status?.syncPhase === 'initial_sync' || server.status?.syncPhase === 'probing') {
    return 'indexing';
  }
  return 'notReady';
}

function ServerReorderGrip({ id, label }: { id: string; label: string }) {
  const { t } = useTranslation();
  const { onMouseDown } = useDragSource(() => ({
    data: JSON.stringify({ type: 'library_server_reorder', id }),
    label,
  }));

  return (
    <span
      className="nav-library-server-grip"
      data-tooltip={t('sidebar.serverReorder')}
      data-tooltip-pos="right"
      onMouseDown={onMouseDown}
      aria-hidden
    >
      <GripVertical size={16} />
    </span>
  );
}

export default function SidebarLibraryPicker({
  selectedLibraryIds,
  selectionSummary,
  libraryDropdownOpen,
  setLibraryDropdownOpen,
  dropdownRect,
  libraryTriggerRef,
  musicFolders,
  onSelectionChange,
  servers = [],
  onServerSelectionChange,
  onServerLibrarySelectionChange,
  onServersReorder,
}: Props) {
  const { t } = useTranslation();
  const multiServer = servers.length > 1;
  const allLibrariesSelected = selectedLibraryIds.length === 0;
  const libraryTriggerPlain = !multiServer && allLibrariesSelected;
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [expandedServerIds, setExpandedServerIds] = useState<Set<string>>(
    () => new Set(servers.filter(server => server.selected).slice(0, 1).map(server => server.id)),
  );
  const allLibrariesLabel = t('sidebar.allLibraries');
  const selectedServers = servers.filter(server => server.selected);
  const multiServerSummary = selectedServers.length === 1
    ? `${selectedServers[0].label} · ${selectedServers[0].selectedLibraryIds.length === 0
      ? allLibrariesLabel
      : selectedServers[0].selectedLibraryIds.length === 1
        ? selectedServers[0].folders.find(folder => folder.id === selectedServers[0].selectedLibraryIds[0])?.name
          ?? t('sidebar.librarySelectionCount', { count: 1 })
        : t('sidebar.librarySelectionCount', { count: selectedServers[0].selectedLibraryIds.length })}`
    : t('sidebar.serverSelectionCount', { count: selectedServers.length });

  const applyServerReorder = useCallback((draggedId: string, target: { id: string; before: boolean }) => {
    const next = applyListReorderById(servers, draggedId, target);
    if (next) onServersReorder?.(next.map(server => server.id));
  }, [servers, onServersReorder]);
  const { isDragging, setContainer, onMouseMove, dropEdge } = useListReorderDnd({
    type: 'library_server_reorder',
    apply: applyServerReorder,
  });
  const setPanelContainer = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    setContainer(node);
  }, [setContainer]);
  const closePicker = useCallback(() => setLibraryDropdownOpen(false), [setLibraryDropdownOpen]);

  useModalFocus({
    open: libraryDropdownOpen && multiServer,
    containerRef: panelRef,
    onEscape: closePicker,
    restoreFocusRef: libraryTriggerRef,
  });

  useLayoutEffect(() => {
    if (!libraryDropdownOpen) {
      // React Compiler set-state-in-effect rule: panel width is measured from layout after open.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPanelWidth(null);
      return;
    }
    const measure = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const minW = dropdownRect.width;
      const maxW = Math.max(minW, window.innerWidth - dropdownRect.left - 8);
      panel.dataset.measure = 'true';
      panel.style.width = 'max-content';
      panel.style.minWidth = `${minW}px`;
      const measured = panel.offsetWidth;
      delete panel.dataset.measure;
      panel.style.width = '';
      panel.style.minWidth = '';
      setPanelWidth(Math.min(Math.max(minW, measured), maxW));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [
    libraryDropdownOpen,
    dropdownRect.left,
    dropdownRect.width,
    musicFolders,
    servers,
    allLibrariesLabel,
  ]);

  const selectAllLibraries = () => {
    setLibraryDropdownOpen(false);
    requestAnimationFrame(() => onSelectionChange([]));
  };

  const exclusiveSelect = (id: string) => {
    setLibraryDropdownOpen(false);
    requestAnimationFrame(() => onSelectionChange([id]));
  };

  const toggleFolder = (id: string) => {
    if (allLibrariesSelected) {
      onSelectionChange([id]);
      return;
    }
    if (selectedLibraryIds.includes(id)) {
      onSelectionChange(selectedLibraryIds.filter(x => x !== id));
      return;
    }
    onSelectionChange([...selectedLibraryIds, id]);
  };

  const toggleServerExpanded = (serverId: string) => {
    setExpandedServerIds(current => {
      const next = new Set(current);
      if (next.has(serverId)) next.delete(serverId);
      else next.add(serverId);
      return next;
    });
  };

  const toggleServerFolder = (server: SidebarLibraryServer, folderId: string) => {
    const selected = server.selectedLibraryIds;
    const next = selected.length === 0
      ? [folderId]
      : selected.includes(folderId)
        ? selected.filter(id => id !== folderId)
        : [...selected, folderId];
    onServerLibrarySelectionChange?.(server.id, next);
  };

  const moveServer = (serverId: string, direction: -1 | 1) => {
    const index = servers.findIndex(server => server.id === serverId);
    const target = servers[index + direction];
    if (!target) return;
    const next = applyListReorderById(servers, serverId, {
      id: target.id,
      before: direction < 0,
    });
    if (next) onServersReorder?.(next.map(server => server.id));
  };

  const excludedReasonLabel = (reason: BrowseScopeExcludedReason) => {
    if (reason === 'offline') return t('sidebar.serverExcludedOffline');
    if (reason === 'connection_unknown') return t('sidebar.serverExcludedUnknown');
    return t('sidebar.serverExcludedIndexNotReady');
  };

  return (
    <>
      <button
        ref={libraryTriggerRef}
        type="button"
        className={`nav-library-scope-trigger ${libraryTriggerPlain ? 'nav-library-scope-trigger--plain' : ''} ${libraryDropdownOpen ? 'nav-library-scope-trigger--open' : ''}`}
        onClick={() => setLibraryDropdownOpen(!libraryDropdownOpen)}
        aria-label={t('sidebar.libraryScope')}
        aria-expanded={libraryDropdownOpen}
        aria-haspopup={multiServer ? 'dialog' : 'listbox'}
        data-tooltip={libraryDropdownOpen ? undefined : t('sidebar.libraryScope')}
        data-tooltip-pos="bottom"
      >
        {!libraryTriggerPlain ? (
          <Music2 size={16} className="nav-library-scope-icon" strokeWidth={2} aria-hidden />
        ) : null}
        <div className="nav-library-scope-text">
          <span className="nav-library-scope-title">{t('sidebar.library')}</span>
          {(multiServer ? multiServerSummary : selectionSummary) ? (
            <span
              className="nav-library-scope-subtitle"
              data-tooltip={multiServer ? multiServerSummary : selectionSummary ?? undefined}
              data-tooltip-pos="right"
            >
              {multiServer ? multiServerSummary : selectionSummary}
            </span>
          ) : null}
        </div>
        <ChevronDown size={16} strokeWidth={2.25} className="nav-library-scope-chevron" aria-hidden />
      </button>
      {libraryDropdownOpen && createPortal(
        multiServer ? (
          <div
            ref={setPanelContainer}
            className="nav-library-dropdown-panel nav-library-server-panel"
            role="dialog"
            aria-modal="true"
            aria-label={t('sidebar.libraryScope')}
            tabIndex={-1}
            onMouseMove={onMouseMove}
            style={{
              position: 'fixed',
              top: dropdownRect.top,
              left: dropdownRect.left,
              minWidth: dropdownRect.width,
              width: panelWidth ?? 'max-content',
              boxSizing: 'border-box',
            }}
          >
            <div className="nav-library-server-panel-heading">
              <span>{t('sidebar.servers')}</span>
              <span>{t('sidebar.serverPriorityHint')}</span>
            </div>
            {servers.map((server, index) => {
              const expanded = expandedServerIds.has(server.id);
              const finalSelected = server.selected && selectedServers.length === 1;
              const status = statusForServer(server);
              const edge = isDragging ? dropEdge(server.id) : null;
              const reasonId = server.excludedReasons.length > 0
                ? `sidebar-server-excluded-${server.id}`
                : undefined;
              return (
                <section
                  key={server.id}
                  data-reorder-id={server.id}
                  className={`nav-library-server ${edge ? `nav-library-server--drop-${edge}` : ''}`}
                  aria-labelledby={`sidebar-server-label-${server.id}`}
                >
                  <div className="nav-library-server-row">
                    <ServerReorderGrip id={server.id} label={server.label} />
                    <label className="nav-library-server-check">
                      <input
                        type="checkbox"
                        checked={server.selected}
                        disabled={finalSelected}
                        aria-describedby={reasonId}
                        onChange={event => {
                          if (finalSelected && !event.target.checked) return;
                          onServerSelectionChange?.(server.id, event.target.checked);
                          if (event.target.checked) {
                            setExpandedServerIds(current => new Set(current).add(server.id));
                          }
                        }}
                      />
                      <span id={`sidebar-server-label-${server.id}`}>{server.label}</span>
                    </label>
                    <span
                      className={`nav-library-server-status nav-library-server-status--${status}`}
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      {t(`sidebar.serverStatus${status[0].toUpperCase()}${status.slice(1)}`)}
                    </span>
                    <div className="nav-library-server-actions">
                      <button
                        type="button"
                        onClick={() => moveServer(server.id, -1)}
                        disabled={index === 0}
                        aria-label={t('sidebar.serverMoveUp', { name: server.label })}
                      >
                        <ChevronUp size={14} aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveServer(server.id, 1)}
                        disabled={index === servers.length - 1}
                        aria-label={t('sidebar.serverMoveDown', { name: server.label })}
                      >
                        <ChevronDown size={14} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className={expanded ? 'is-expanded' : ''}
                        onClick={() => toggleServerExpanded(server.id)}
                        aria-expanded={expanded}
                        aria-controls={`sidebar-server-libraries-${server.id}`}
                        aria-label={expanded
                          ? t('sidebar.serverLibrariesCollapse', { name: server.label })
                          : t('sidebar.serverLibrariesExpand', { name: server.label })}
                      >
                        <ChevronDown size={15} aria-hidden />
                      </button>
                    </div>
                  </div>
                  {server.excludedReasons.length > 0 ? (
                    <p id={reasonId} className="nav-library-server-excluded">
                      {t('sidebar.serverExcluded', {
                        reasons: server.excludedReasons.map(excludedReasonLabel).join(', '),
                      })}
                    </p>
                  ) : null}
                  {expanded ? (
                    <fieldset
                      id={`sidebar-server-libraries-${server.id}`}
                      className="nav-library-server-libraries"
                      disabled={!server.selected}
                    >
                      <legend className="sr-only">
                        {t('sidebar.serverLibrariesLegend', { name: server.label })}
                      </legend>
                      <label className="nav-library-server-library">
                        <input
                          type="checkbox"
                          checked={server.selectedLibraryIds.length === 0}
                          onChange={() => onServerLibrarySelectionChange?.(server.id, [])}
                        />
                        <span>{allLibrariesLabel}</span>
                      </label>
                      {server.folders.map(folder => (
                        <label key={folder.id} className="nav-library-server-library">
                          <input
                            type="checkbox"
                            checked={server.selectedLibraryIds.includes(folder.id)}
                            onChange={() => toggleServerFolder(server, folder.id)}
                          />
                          <span>{folder.name}</span>
                        </label>
                      ))}
                      {server.folders.length === 0 ? (
                        <p className="nav-library-server-no-folders">{t('sidebar.serverNoLibraries')}</p>
                      ) : null}
                    </fieldset>
                  ) : null}
                </section>
              );
            })}
          </div>
        ) : (
          <div
            ref={panelRef}
            className={`nav-library-dropdown-panel${musicFolders.length > 10 ? ' nav-library-dropdown-panel--many-libraries' : ''}`}
            role="listbox"
            aria-label={t('sidebar.libraryScope')}
            style={{
              position: 'fixed',
              top: dropdownRect.top,
              left: dropdownRect.left,
              minWidth: dropdownRect.width,
              width: panelWidth ?? 'max-content',
              boxSizing: 'border-box',
            }}
          >
            <div
              role="option"
              aria-selected={allLibrariesSelected}
              className={`nav-library-dropdown-item ${allLibrariesSelected ? 'nav-library-dropdown-item--selected' : ''}`}
            >
              <button type="button" className="nav-library-dropdown-item-main" onClick={selectAllLibraries}>
                <span className="nav-library-dropdown-item-label">{allLibrariesLabel}</span>
              </button>
              <span
                className={`nav-library-dropdown-item-toggle ${allLibrariesSelected ? 'nav-library-dropdown-item-toggle--on' : 'nav-library-dropdown-item-toggle--align-only'}`}
                aria-hidden
              >
                {allLibrariesSelected ? <Check size={16} strokeWidth={2.5} /> : null}
              </span>
            </div>
            {musicFolders.map(folder => {
              const selected = selectedLibraryIds.includes(folder.id);
              return (
                <div
                  key={folder.id}
                  role="option"
                  aria-selected={selected}
                  className={`nav-library-dropdown-item ${selected ? 'nav-library-dropdown-item--selected' : ''}`}
                >
                  <button type="button" className="nav-library-dropdown-item-main" onClick={() => exclusiveSelect(folder.id)}>
                    <span className="nav-library-dropdown-item-label">{folder.name}</span>
                  </button>
                  <button
                    type="button"
                    className={`nav-library-dropdown-item-toggle ${selected ? 'nav-library-dropdown-item-toggle--on' : ''}`}
                    aria-label={selected
                      ? t('sidebar.libraryDeselect', { name: folder.name })
                      : t('sidebar.librarySelect', { name: folder.name })}
                    aria-pressed={selected}
                    onClick={event => {
                      event.stopPropagation();
                      toggleFolder(folder.id);
                    }}
                  >
                    {selected ? <Check size={16} strokeWidth={2.5} /> : (
                      <span className="nav-library-dropdown-item-toggle-box" aria-hidden />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ),
        document.body,
      )}
    </>
  );
}

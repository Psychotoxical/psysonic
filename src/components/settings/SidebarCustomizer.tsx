import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical } from 'lucide-react';
import { useDragDrop, useDragSource } from '../../contexts/DragDropContext';
import { useAuthStore } from '../../store/authStore';
import { useSidebarStore, SidebarItemConfig, CONSERVED_SIDEBAR_NAV_IDS } from '../../store/sidebarStore';
import { useLuckyMixAvailable } from '../../hooks/useLuckyMixAvailable';
import { ALL_NAV_ITEMS } from '../../config/navItems';
import { applySidebarReorderById } from '../../utils/componentHelpers/sidebarNavReorder';
import { SettingsGroup } from './SettingsGroup';
import { SettingsToggle } from './SettingsToggle';

type DropTarget = { id: string; before: boolean; section: 'library' | 'system' } | null;

function SidebarGripHandle({ id, section, label }: { id: string; section: 'library' | 'system'; label: string }) {
  const { t } = useTranslation();
  const { onMouseDown } = useDragSource(() => ({
    data: JSON.stringify({ type: 'sidebar_reorder', id, section }),
    label,
  }));
  return (
    <span
      className="sidebar-customizer-grip"
      data-tooltip={t('settings.sidebarDrag')}
      data-tooltip-pos="right"
      onMouseDown={onMouseDown}
    >
      <GripVertical size={16} />
    </span>
  );
}

export function SidebarCustomizer() {
  const { t } = useTranslation();
  const { items, setItems, toggleItem } = useSidebarStore();
  const { isDragging: isPsyDragging } = useDragDrop();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const dropTargetRef = useRef<DropTarget>(null);
  const itemsRef = useRef(items);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  itemsRef.current = items;
  const randomNavMode = useAuthStore(s => s.randomNavMode);
  const setRandomNavMode = useAuthStore(s => s.setRandomNavMode);
  const nowPlayingAtTop = useAuthStore(s => s.nowPlayingAtTop);
  const setNowPlayingAtTop = useAuthStore(s => s.setNowPlayingAtTop);
  const showLuckyMixMenu = useAuthStore(s => s.showLuckyMixMenu);
  const setShowLuckyMixMenu = useAuthStore(s => s.setShowLuckyMixMenu);
  const luckyMixBase = useLuckyMixAvailable();
  const luckyMixAvailable = luckyMixBase && randomNavMode === 'separate';

  const libraryItems = items.filter(cfg => {
    if (CONSERVED_SIDEBAR_NAV_IDS.has(cfg.id)) return false;
    if (!ALL_NAV_ITEMS[cfg.id] || ALL_NAV_ITEMS[cfg.id].section !== 'library') return false;
    if (randomNavMode === 'hub' && (cfg.id === 'randomMix' || cfg.id === 'randomAlbums' || cfg.id === 'luckyMix')) return false;
    if (randomNavMode === 'separate' && cfg.id === 'randomPicker') return false;
    if (cfg.id === 'luckyMix' && !luckyMixAvailable) return false;
    return true;
  });
  const systemItems  = items.filter(cfg => ALL_NAV_ITEMS[cfg.id]?.section === 'system');

  useEffect(() => {
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!isPsyDragging) { dropTargetRef.current = null; setDropTarget(null); }
  }, [isPsyDragging]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onPsyDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;
      let parsed: { type?: string; id?: string; section?: string };
      try { parsed = JSON.parse(detail.data); } catch { return; }
      if (parsed.type !== 'sidebar_reorder' || !parsed.id || !parsed.section) return;

      const draggedId = parsed.id;
      const fromSection = parsed.section as 'library' | 'system';
      const target = dropTargetRef.current;
      dropTargetRef.current = null; setDropTarget(null);

      const next = applySidebarReorderById(itemsRef.current, fromSection, draggedId, target);
      if (next) setItems(next);
    };
    el.addEventListener('psy-drop', onPsyDrop);
    return () => el.removeEventListener('psy-drop', onPsyDrop);
  }, [setItems]);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPsyDragging || !containerRef.current) return;
    const rows = containerRef.current.querySelectorAll<HTMLElement>('[data-sidebar-id]');
    let target: DropTarget = null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const id = row.dataset.sidebarId;
      const section = row.dataset.sidebarSection as 'library' | 'system';
      if (!id) continue;
      if (e.clientY < rect.top + rect.height / 2) { target = { id, before: true, section }; break; }
      target = { id, before: false, section };
    }
    dropTargetRef.current = target;
    setDropTarget(target);
  };

  const renderRow = (cfg: SidebarItemConfig, section: 'library' | 'system') => {
    const meta = ALL_NAV_ITEMS[cfg.id];
    if (!meta) return null;
    const Icon = meta.icon;
    const isBefore = isPsyDragging && dropTarget?.section === section && dropTarget.id === cfg.id && dropTarget.before;
    const isAfter  = isPsyDragging && dropTarget?.section === section && dropTarget.id === cfg.id && !dropTarget.before;
    return (
      <div
        key={cfg.id}
        data-sidebar-id={cfg.id}
        data-sidebar-section={section}
        className="sidebar-customizer-row"
        style={{
          borderTop:    isBefore ? '2px solid var(--accent)' : undefined,
          borderBottom: isAfter  ? '2px solid var(--accent)' : undefined,
        }}
      >
        <SidebarGripHandle id={cfg.id} section={section} label={t(meta.labelKey)} />
        <Icon size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 14 }}>{t(meta.labelKey)}</span>
        <label className="toggle-switch" aria-label={t(meta.labelKey)}>
          <input type="checkbox" checked={cfg.visible} onChange={() => toggleItem(cfg.id)} />
          <span className="toggle-track" />
        </label>
      </div>
    );
  };

  return (
    <>
      <SettingsGroup>
        <SettingsToggle
          label={t('settings.randomNavSplitTitle')}
          desc={t('settings.randomNavSplitDesc')}
          checked={randomNavMode === 'separate'}
          onChange={c => setRandomNavMode(c ? 'separate' : 'hub')}
        />
        <SettingsToggle
          label={t('settings.nowPlayingTopTitle')}
          desc={t('settings.nowPlayingTopDesc')}
          searchText={t('settings.nowPlayingTopTitle')}
          checked={nowPlayingAtTop}
          onChange={setNowPlayingAtTop}
        />
        <SettingsToggle
          label={t('settings.luckyMixMenuTitle')}
          desc={t('settings.luckyMixMenuDesc')}
          checked={showLuckyMixMenu}
          onChange={setShowLuckyMixMenu}
        />
      </SettingsGroup>

      <SettingsGroup>
        <div ref={containerRef} onMouseMove={handleMouseMove} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/* Library block */}
          <div style={{ padding: '4px 0' }}>
            <div className="sidebar-customizer-block-label">{t('sidebar.library')}</div>
            {libraryItems.map(cfg => renderRow(cfg, 'library'))}
          </div>
          {/* System block */}
          <div style={{ padding: '4px 0' }}>
            <div className="sidebar-customizer-block-label">{t('sidebar.system')}</div>
            {systemItems.map(cfg => renderRow(cfg, 'system'))}
            <div className="sidebar-customizer-fixed-hint">
              <span>{t('settings.sidebarFixed')}: {t('sidebar.nowPlaying')}, {t('sidebar.settings')}</span>
            </div>
          </div>
        </div>
      </SettingsGroup>
    </>
  );
}

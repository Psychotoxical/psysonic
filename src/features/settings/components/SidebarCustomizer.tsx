import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { useSidebarStore, SidebarItemConfig, CONSERVED_SIDEBAR_NAV_IDS } from '@/features/sidebar';
import { useLuckyMixAvailable } from '@/features/randomMix';
import { ALL_NAV_ITEMS } from '@/config/navItems';
import { applySidebarReorderById } from '@/features/sidebar';
import { useListReorderDnd } from '@/lib/hooks/useListReorderDnd';
import type { ListReorderDropTarget } from '@/lib/util/listReorder';
import { ReorderGripHandle } from '@/features/settings/components/ReorderGripHandle';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsToggle } from '@/features/settings/components/SettingsToggle';

const REORDER_TYPE = 'sidebar_reorder';

export function SidebarCustomizer() {
  const { t } = useTranslation();
  const { items, setItems, toggleItem } = useSidebarStore();
  const itemsRef = useRef(items);
  // React Compiler refs rule: ref kept in sync with the latest value for use in handlers; not render data.
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

  const apply = useCallback((draggedId: string, target: ListReorderDropTarget) => {
    const section = ALL_NAV_ITEMS[draggedId]?.section;
    if (section !== 'library' && section !== 'system') return;
    const next = applySidebarReorderById(itemsRef.current, section, draggedId, target);
    if (next) setItems(next);
  }, [setItems]);

  const { isDragging, setContainer, onMouseMove, dropEdge } = useListReorderDnd({ type: REORDER_TYPE, apply });

  const renderRow = (cfg: SidebarItemConfig, section: 'library' | 'system') => {
    const meta = ALL_NAV_ITEMS[cfg.id];
    if (!meta) return null;
    const Icon = meta.icon;
    const edge = isDragging ? dropEdge(cfg.id) : null;
    return (
      <div
        key={cfg.id}
        data-reorder-id={cfg.id}
        data-reorder-section={section}
        className="sidebar-customizer-row"
        style={{
          borderTop:    edge === 'before' ? '2px solid var(--accent)' : undefined,
          borderBottom: edge === 'after'  ? '2px solid var(--accent)' : undefined,
        }}
      >
        <ReorderGripHandle id={cfg.id} type={REORDER_TYPE} section={section} label={t(meta.labelKey)} />
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
        <div ref={setContainer} onMouseMove={onMouseMove} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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

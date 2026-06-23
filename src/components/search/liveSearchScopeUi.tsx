import { useTranslation } from 'react-i18next';
import { ALL_NAV_ITEMS } from '../../config/navItems';
import type { LiveSearchScope } from '../../store/liveSearchScopeStore';
import {
  SCOPE_NAV_ITEM,
  handleLiveSearchScopeBadgeClick,
  handleLiveSearchScopeGhostClick,
  liveSearchScopeBadgeTooltipKey,
  liveSearchScopeGhostTooltipKey,
} from './liveSearchScope';

type LiveSearchScopeIconProps = {
  scope: LiveSearchScope;
  size?: number;
};

/** Sidebar nav icon for the scoped browse page (e.g. Users for Artists). */
export function LiveSearchScopeIcon({ scope, size = 14 }: LiveSearchScopeIconProps) {
  const Icon = ALL_NAV_ITEMS[SCOPE_NAV_ITEM[scope]].icon;
  return <Icon size={size} aria-hidden />;
}

type LiveSearchScopeBadgeProps = {
  scope: LiveSearchScope;
  className: string;
  clearScope: (options?: { recordUndo?: boolean }) => void;
};

export function LiveSearchScopeBadge({ scope, className, clearScope }: LiveSearchScopeBadgeProps) {
  const { t } = useTranslation();
  const tooltip = t(liveSearchScopeBadgeTooltipKey(scope));
  return (
    <span
      className={className}
      role="button"
      tabIndex={-1}
      data-tooltip={tooltip}
      data-tooltip-pos="bottom"
      aria-label={tooltip}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => handleLiveSearchScopeBadgeClick(e, clearScope)}
    >
      <LiveSearchScopeIcon scope={scope} size={14} />
    </span>
  );
}

type LiveSearchScopeGhostBadgeProps = {
  scope: LiveSearchScope;
  className: string;
  setScope: (scope: LiveSearchScope, options?: { recordUndo?: boolean }) => void;
};

export function LiveSearchScopeGhostBadge({ scope, className, setScope }: LiveSearchScopeGhostBadgeProps) {
  const { t } = useTranslation();
  const tooltip = t(liveSearchScopeGhostTooltipKey(scope));
  return (
    <span
      className={className}
      role="button"
      tabIndex={-1}
      data-tooltip={tooltip}
      data-tooltip-pos="bottom"
      aria-label={tooltip}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => handleLiveSearchScopeGhostClick(e, scope, setScope)}
    >
      <LiveSearchScopeIcon scope={scope} size={14} />
    </span>
  );
}

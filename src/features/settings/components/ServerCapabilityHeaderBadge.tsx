import { useTranslation } from 'react-i18next';
import { getCapabilityDefinition } from '@/lib/serverCapabilities/catalog';
import { isFeatureActiveForServer, resolveFeatureForServer } from '@/lib/serverCapabilities/storeView';

/** Inline badge for auto-managed server capabilities (Settings → Servers header row). */
export function ServerCapabilityHeaderBadge({
  serverId,
  feature,
}: {
  serverId: string;
  feature: string;
}) {
  const { t } = useTranslation();
  const resolved = resolveFeatureForServer(serverId, feature);
  if (!resolved || resolved.activation !== 'auto') return null;
  if (!isFeatureActiveForServer(serverId, feature)) return null;

  const def = getCapabilityDefinition(feature);
  const labelKey = def?.badgeLabelKey ?? def?.labelKey;
  if (!labelKey) return null;

  return (
    <span className="settings-server-inline-badge settings-server-inline-badge--positive">{t(labelKey)}</span>
  );
}

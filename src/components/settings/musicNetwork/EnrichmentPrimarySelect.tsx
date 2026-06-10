import { useTranslation } from 'react-i18next';
import CustomSelect from '../../CustomSelect';
import type { Account } from '../../../music-network';

/**
 * Picks the single enrichment primary (love / similar / stats source). Only
 * enrichment-eligible accounts are offered; Maloja / ListenBrainz never appear.
 * Hidden when there are no eligible accounts.
 */
export function EnrichmentPrimarySelect({
  accounts,
  primaryId,
  onChange,
}: {
  accounts: Account[];
  primaryId: string | null;
  onChange: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const candidates = accounts.filter(a => a.roles.enrichmentEligible);
  if (candidates.length === 0) return null;

  const options = [
    { value: '', label: t('musicNetwork.primaryNone') },
    ...candidates.map(a => ({ value: a.id, label: a.label })),
  ];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        flexWrap: 'wrap',
        padding: '0.75rem 1rem',
        borderRadius: '10px',
        border: '1px solid var(--border)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>{t('musicNetwork.primaryLabel')}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('musicNetwork.primaryDesc')}</div>
      </div>
      <CustomSelect
        value={primaryId ?? ''}
        options={options}
        onChange={v => onChange(v || null)}
        style={{ minWidth: 180 }}
      />
    </div>
  );
}

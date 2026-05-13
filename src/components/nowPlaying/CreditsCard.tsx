import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContributorRow } from '../../utils/nowPlayingHelpers';

interface CreditsCardProps { rows: ContributorRow[]; }

const CreditsCard = memo(function CreditsCard({ rows }: CreditsCardProps) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  return (
    <div className="np-info-card np-dash-card">
      <div className="np-card-header">
        <h3 className="np-card-title">{t('nowPlayingInfo.songInfo', 'Song info')}</h3>
      </div>
      <ul className="np-info-credits">
        {rows.map(row => (
          <li key={row.role} className="np-info-credit-row">
            <span className="np-info-credit-role">{t(`nowPlayingInfo.role.${row.role}`, row.role)}</span>
            <span className="np-info-credit-names">{row.names.join(', ')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
});

export default CreditsCard;

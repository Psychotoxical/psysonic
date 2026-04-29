import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { version } from '../../package.json';
import changelogRaw from '../../CHANGELOG.md?raw';
import { useAuthStore } from '../store/authStore';
import { findChangelogReleaseEntry } from '../utils/changelogReleaseMatch';

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*'))
      return <em key={i}>{part.slice(1, -1)}</em>;
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="changelog-code">{part.slice(1, -1)}</code>;
    return part;
  });
}

interface Props {
  onClose: () => void;
}

export default function ChangelogModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [dontShow, setDontShow] = useState(false);
  const setShowChangelogOnUpdate = useAuthStore(s => s.setShowChangelogOnUpdate);
  const setLastSeenChangelogVersion = useAuthStore(s => s.setLastSeenChangelogVersion);

  const currentVersionData = useMemo(() => findChangelogReleaseEntry(changelogRaw, version), []);

  const handleClose = () => {
    if (dontShow) setShowChangelogOnUpdate(false);
    setLastSeenChangelogVersion(version);
    onClose();
  };

  if (!currentVersionData) return null;

  return createPortal(
    <>
      <div className="eq-popup-backdrop" onClick={handleClose} style={{ zIndex: 300 }} />
      <div
        className="eq-popup"
        style={{ zIndex: 301, width: 'min(580px, 92vw)', gap: 0, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="eq-popup-header" style={{ flexShrink: 0 }}>
          <span className="eq-popup-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Sparkles size={16} style={{ color: 'var(--accent)' }} />
            {t('changelog.modalTitle')} — v{version}
          </span>
          {currentVersionData.date && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
              {currentVersionData.date}
            </span>
          )}
        </div>

        <div style={{ overflowY: 'auto', padding: '12px 20px', flex: 1 }}>
          {currentVersionData.body.split('\n').map((line, i) => {
            if (line.startsWith('### '))
              return <div key={i} className="changelog-h3">{renderInline(line.slice(4))}</div>;
            if (line.startsWith('#### '))
              return <div key={i} className="changelog-h4">{renderInline(line.slice(5))}</div>;
            if (line.startsWith('- '))
              return <div key={i} className="changelog-item">{renderInline(line.slice(2))}</div>;
            if (line.trim() === '') return null;
            return <div key={i} className="changelog-text">{renderInline(line)}</div>;
          })}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 20px',
            borderTop: '1px solid var(--border-subtle)',
            flexShrink: 0,
            gap: '1rem',
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={dontShow} onChange={e => setDontShow(e.target.checked)} />
            {t('changelog.dontShowAgain')}
          </label>
          <button className="btn btn-primary" onClick={handleClose}>
            {t('changelog.close')}
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}

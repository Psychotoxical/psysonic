import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import type { LicenseEntry } from '../utils/licensesData';

interface Props {
  entry: LicenseEntry | null;
  onClose: () => void;
}

export default function LicenseTextModal({ entry, onClose }: Props) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!entry) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entry, onClose]);

  if (!entry) return null;

  const repoLink = entry.repository || entry.homepage;

  return createPortal(
    <div
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{ alignItems: 'center', paddingTop: 0 }}
    >
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '760px',
          width: '92vw',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>
          <X size={18} />
        </button>
        <div style={{ marginBottom: '0.5rem', paddingRight: '2rem' }}>
          <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: '1.05rem' }}>
            {entry.name} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{entry.version}</span>
          </h3>
          <div
            style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              flexWrap: 'wrap',
              marginTop: '0.4rem',
              fontSize: '0.78rem',
            }}
          >
            {entry.licenses.map((lid) => (
              <span
                key={lid}
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: '10px',
                  padding: '1px 8px',
                  color: 'var(--text-primary)',
                }}
              >
                {lid}
              </span>
            ))}
            <span
              style={{
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                fontSize: '0.7rem',
                letterSpacing: '0.04em',
              }}
            >
              {entry.source}
            </span>
            {repoLink && (
              <button
                onClick={() => openExternal(repoLink)}
                className="btn btn-ghost"
                style={{
                  padding: '2px 8px',
                  fontSize: '0.78rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <ExternalLink size={12} /> {t('licenses.viewSource')}
              </button>
            )}
          </div>
          {entry.description && (
            <p style={{ color: 'var(--text-muted)', marginTop: '0.6rem', marginBottom: 0, fontSize: '0.85rem' }}>
              {entry.description}
            </p>
          )}
        </div>
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '12px 14px',
            overflow: 'auto',
            flex: 1,
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            fontSize: '0.78rem',
            whiteSpace: 'pre-wrap',
            color: 'var(--text-primary)',
            lineHeight: 1.5,
          }}
        >
          {entry.licenseText || t('licenses.noLicenseText')}
        </div>
      </div>
    </div>,
    document.body,
  );
}

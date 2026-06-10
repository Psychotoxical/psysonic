import React from 'react';
import { Sparkles, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { version } from '../../package.json';
import { useReleaseNotes } from '../hooks/useReleaseNotes';
import { renderChangelogBody } from '../utils/changelog/changelogMarkdown';

export default function WhatsNew() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { loading, entry } = useReleaseNotes(version);

  const close = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/');
  };

  return (
    <div className="whats-new">
      <header className="whats-new__header">
        <div className="whats-new__title-row">
          <Sparkles size={20} className="whats-new__icon" />
          <div>
            <h1 className="whats-new__title">{t('whatsNew.title')}</h1>
            <div className="whats-new__subtitle">
              v{version}
              {entry?.date && <span className="whats-new__date"> · {entry.date}</span>}
            </div>
          </div>
          <button
            type="button"
            className="whats-new__close"
            onClick={close}
            aria-label={t('whatsNew.close')}
            data-tooltip={t('whatsNew.close')}
            data-tooltip-pos="bottom"
          >
            <X size={18} />
          </button>
        </div>
      </header>

      <div className="whats-new__body">
        {loading ? (
          <p className="whats-new__empty">{t('common.loading')}</p>
        ) : entry ? (
          renderChangelogBody(entry.body)
        ) : (
          <p className="whats-new__empty">{t('whatsNew.empty')}</p>
        )}
      </div>
    </div>
  );
}

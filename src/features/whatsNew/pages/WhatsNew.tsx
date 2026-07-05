import React, { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { version } from '@/../package.json';
import { useReleaseNotes } from '@/features/whatsNew/hooks/useReleaseNotes';
import { renderChangelogBody } from '@/features/whatsNew/utils/changelogMarkdown';

type WhatsNewView = 'highlights' | 'changelog';

export default function WhatsNew() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { loading, whatsNewEntry, changelogEntry } = useReleaseNotes(version);
  const [view, setView] = useState<WhatsNewView>('highlights');

  const close = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/');
  };

  const activeEntry = view === 'highlights' ? whatsNewEntry : changelogEntry;

  return (
    <div className="whats-new">
      <header className="whats-new__header">
        <div className="whats-new__title-row">
          <Sparkles size={20} className="whats-new__icon" />
          <div>
            <h1 className="whats-new__title">
              {view === 'changelog' ? t('whatsNew.changelogTitle') : t('whatsNew.title')}
            </h1>
            <div className="whats-new__subtitle">
              v{version}
              {activeEntry?.date && <span className="whats-new__date"> · {activeEntry.date}</span>}
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

        {changelogEntry && (
          <div className="whats-new__view-tabs" role="tablist" aria-label={t('whatsNew.viewTabsLabel')}>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'highlights'}
              className={`whats-new__view-tab${view === 'highlights' ? ' whats-new__view-tab--active' : ''}`}
              onClick={() => setView('highlights')}
            >
              {t('whatsNew.viewHighlights')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'changelog'}
              className={`whats-new__view-tab${view === 'changelog' ? ' whats-new__view-tab--active' : ''}`}
              onClick={() => setView('changelog')}
            >
              {t('whatsNew.viewChangelog')}
            </button>
          </div>
        )}
      </header>

      <div className="whats-new__body" role="tabpanel">
        {loading ? (
          <p className="whats-new__empty">{t('common.loading')}</p>
        ) : activeEntry ? (
          renderChangelogBody(activeEntry.body)
        ) : (
          <p className="whats-new__empty">{t('whatsNew.empty')}</p>
        )}
      </div>
    </div>
  );
}

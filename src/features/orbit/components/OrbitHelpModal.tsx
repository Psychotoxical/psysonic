import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Sparkles, Users, Share2, LogIn, MousePointerClick,
  ListMusic, Inbox, Sliders, LogOut,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useHelpModalStore } from '@/features/orbit/store/helpModalStore';
import { SettingsSubSection } from '@/features/settings';

/**
 * Orbit help modal. Rendered once at the app root; triggered from the
 * launch popover ("How does this work?") and the in-session bar's help
 * button. 9 accordion sections built on SettingsSubSection; all default
 * closed so the modal opens compact. Does not touch playback.
 */
export default function OrbitHelpModal() {
  const { t } = useTranslation();
  const { isOpen, close } = useHelpModalStore();
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    // Focus the first accordion summary so arrow keys work immediately.
    // Uses a short setTimeout because the browser re-focuses the clicked
    // trigger button after the click handler returns — our focus call has
    // to happen *after* that, otherwise the browser silently overrides it
    // and the user only gets keyboard nav after pressing Tab first.
    const id = window.setTimeout(() => {
      const first = bodyRef.current?.querySelector<HTMLElement>('summary');
      first?.focus();
    }, 60);
    return () => window.clearTimeout(id);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const summaries = Array.from(
        bodyRef.current?.querySelectorAll<HTMLElement>('summary') ?? [],
      );
      if (summaries.length === 0) return;
      const current = document.activeElement as HTMLElement | null;
      const idx = summaries.indexOf(current as HTMLElement);
      e.preventDefault();
      const next = e.key === 'ArrowDown'
        ? summaries[(idx + 1 + summaries.length) % summaries.length]
        : summaries[(idx - 1 + summaries.length) % summaries.length];
      next?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  if (!isOpen) return null;

  const hostOnlyLabel = t('orbit.helpHostOnly');

  return createPortal(
    <div
      className="modal-overlay"
      onClick={e => { if (e.target === e.currentTarget) close(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="orbit-help-title"
      style={{ alignItems: 'center', paddingTop: 0 }}
    >
      <div className="modal-content orbit-help-modal">
        <button type="button" className="modal-close" onClick={close} aria-label={t('orbit.closeAria')}>
          <X size={18} />
        </button>

        <h3 id="orbit-help-title" className="orbit-help-modal__title">
          {t('orbit.helpTitle')}
        </h3>
        <p className="orbit-help-modal__intro">{t('orbit.helpIntro')}</p>

        <div className="orbit-help-modal__body" ref={bodyRef}>
          <SettingsSubSection title={t('orbit.helpSec1Title')} icon={<Sparkles size={16} />}>
            <p>{t('orbit.helpSec1Body')}</p>
          </SettingsSubSection>

          <SettingsSubSection title={t('orbit.helpSec2Title')} icon={<Users size={16} />}>
            <p>{t('orbit.helpSec2Body')}</p>
            <div className="orbit-help-modal__warn">
              <strong>{t('orbit.helpSec2WarnHead')}</strong>
              <span>{t('orbit.helpSec2WarnBody')}</span>
            </div>
          </SettingsSubSection>

          <SettingsSubSection title={t('orbit.helpSec3Title')} icon={<Share2 size={16} />}>
            <p>{t('orbit.helpSec3Body')}</p>
          </SettingsSubSection>

          <SettingsSubSection title={t('orbit.helpSec4Title')} icon={<LogIn size={16} />}>
            <p>{t('orbit.helpSec4Body')}</p>
          </SettingsSubSection>

          <SettingsSubSection title={t('orbit.helpSec5Title')} icon={<MousePointerClick size={16} />}>
            <p>{t('orbit.helpSec5Body')}</p>
          </SettingsSubSection>

          <SettingsSubSection title={t('orbit.helpSec6Title')} icon={<ListMusic size={16} />}>
            <p>{t('orbit.helpSec6Body')}</p>
          </SettingsSubSection>

          <SettingsSubSection
            title={`${t('orbit.helpSec7Title')} ${hostOnlyLabel}`}
            icon={<Inbox size={16} />}
          >
            <p>{t('orbit.helpSec7Body')}</p>
          </SettingsSubSection>

          <SettingsSubSection
            title={`${t('orbit.helpSec8Title')} ${hostOnlyLabel}`}
            icon={<Sliders size={16} />}
          >
            <p>{t('orbit.helpSec8Body')}</p>
          </SettingsSubSection>

          <SettingsSubSection title={t('orbit.helpSec9Title')} icon={<LogOut size={16} />}>
            <p>{t('orbit.helpSec9Body')}</p>
          </SettingsSubSection>
        </div>
      </div>
    </div>,
    document.body,
  );
}

import React, { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import PsysonicLogo from './PsysonicLogo';

const TAPS_TO_REVEAL_HINT = 10;
const TARGET_CLICKS_IN_WINDOW = 100;
const WINDOW_MS = 60_000;

/** Hardcoded About lol copy — intentionally not in locale files. */
const MSG_HINT =
  'To become a developer, you need to click the Psysonic logo 100 times within one minute.';

const MSG_CONGRATS_TITLE = 'Congratulations.';
const MSG_CONGRATS_SIGN_OFF = 'Sincerely, your maintainers.';
const MSG_CONGRATS_PS = "PS: Don't forget to star the repo! ★";

/**
 * About page brand row + Settings → System → About lol (logo taps + modal).
 * Modal copy is English and hardcoded by design.
 */
export function AboutPsysonicBrandHeader({
  appVersion,
  aboutVersionLabel,
}: {
  appVersion: string;
  aboutVersionLabel: string;
}) {
  const modalWordmarkGradSuffix = useId().replace(/:/g, '');
  const [phase, setPhase] = useState<'idle' | 'hint' | 'done'>('idle');
  const [idleTaps, setIdleTaps] = useState(0);
  const [hintTimestamps, setHintTimestamps] = useState<number[]>([]);
  const [overlayOpen, setOverlayOpen] = useState(false);

  const onLogoClick = useCallback(() => {
    if (phase === 'done') return;

    if (phase === 'idle') {
      setIdleTaps(prev => {
        const next = prev + 1;
        if (next >= TAPS_TO_REVEAL_HINT) queueMicrotask(() => setPhase('hint'));
        return next;
      });
      return;
    }

    if (phase === 'hint') {
      const now = Date.now();
      setHintTimestamps(prev => {
        const inWindow = prev.filter(t => t > now - WINDOW_MS);
        const nextTimes = [...inWindow, now];
        if (nextTimes.length >= TARGET_CLICKS_IN_WINDOW) {
          queueMicrotask(() => {
            setPhase('done');
            setOverlayOpen(true);
          });
        }
        return nextTimes;
      });
    }
  }, [phase]);

  const closeOverlay = useCallback(() => setOverlayOpen(false), []);

  useEffect(() => {
    if (!overlayOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [overlayOpen]);

  return (
    <>
      <div className="settings-about-header">
        <button
          type="button"
          onClick={onLogoClick}
          className="about-psysonic-logo-lol-hit"
          aria-label="Psysonic"
        >
          <img src="/logo-psysonic.png" width={52} height={52} alt="" decoding="async" style={{ borderRadius: 14, display: 'block' }} />
        </button>
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            Psysonic
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            {aboutVersionLabel} {appVersion}
          </div>
        </div>
      </div>

      {phase === 'hint' && !overlayOpen && (
        <p
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            marginTop: '0.5rem',
            lineHeight: 1.5,
          }}
        >
          {MSG_HINT}
        </p>
      )}

      {overlayOpen &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-psysonic-lol-title"
            className="about-psysonic-lol-overlay"
          >
            <button
              type="button"
              className="about-psysonic-lol-close"
              aria-label="Close"
              onClick={closeOverlay}
            >
              <X size={26} strokeWidth={2.25} aria-hidden />
            </button>
            <div className="about-psysonic-lol-panel">
              <div className="about-psysonic-lol-logo-slot">
                <PsysonicLogo
                  gradientIdSuffix={modalWordmarkGradSuffix}
                  className="about-psysonic-lol-logo-mark"
                  style={{
                    height: 'clamp(3.25rem, 14vw, 5.75rem)',
                    width: 'auto',
                    maxWidth: 'min(100%, 420px)',
                    display: 'block',
                  }}
                />
              </div>
              <div className="about-psysonic-lol-copy">
                <h2 id="about-psysonic-lol-title" className="about-psysonic-lol-title">
                  {MSG_CONGRATS_TITLE}
                </h2>
                <p className="about-psysonic-lol-lede">
                  {"We're very much looking forward to you as a developer — join us on "}
                  <button
                    type="button"
                    className="about-psysonic-lol-inline-link"
                    onClick={() => void openUrl('https://github.com/Psychotoxical/psysonic')}
                  >
                    GitHub
                  </button>
                  {' and build great features!'}
                </p>
                <p className="about-psysonic-lol-signoff">{MSG_CONGRATS_SIGN_OFF}</p>
                <p className="about-psysonic-lol-ps">{MSG_CONGRATS_PS}</p>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

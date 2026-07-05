import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOrbitAccountPickerStore } from '@/features/orbit/store/orbitAccountPickerStore';

/**
 * Modal shown when joining an Orbit session and the user has more than
 * one account for the target server URL. Lets them pick which account
 * to switch to before the join flow continues. Mount once in App.tsx —
 * any caller can invoke it via `useOrbitAccountPickerStore.request(...)`.
 */
export default function OrbitAccountPicker() {
  const { t } = useTranslation();
  const { isOpen, accounts, pick, cancel } = useOrbitAccountPickerStore();
  const [selected, setSelected] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Reset + focus first item each time the picker re-opens.
  useEffect(() => {
    if (!isOpen) return;
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(0);
    // Defer focus to the next tick so the DOM has actually mounted.
    queueMicrotask(() => itemRefs.current[0]?.focus());
  }, [isOpen]);

  // Move DOM focus with the arrow-key selection so the browser's focus
  // ring follows, and the currently active button is readable to AT.
  useEffect(() => {
    if (!isOpen) return;
    itemRefs.current[selected]?.focus();
  }, [selected, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { cancel(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected(s => (s + 1) % Math.max(1, accounts.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected(s => (s - 1 + accounts.length) % Math.max(1, accounts.length));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = accounts[selected];
        if (target) pick(target);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, accounts, selected, pick, cancel]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="modal-overlay"
      onClick={e => { if (e.target === e.currentTarget) cancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="orbit-account-picker-title"
      style={{ alignItems: 'center', paddingTop: 0 }}
    >
      <div className="modal-content orbit-account-picker">
        <button type="button" className="modal-close" onClick={cancel} aria-label={t('orbit.btnCancel')}>
          <X size={18} />
        </button>
        <h3 id="orbit-account-picker-title" className="orbit-account-picker__title">
          {t('orbit.accountPickerTitle')}
        </h3>
        <p className="orbit-account-picker__sub">
          {t('orbit.accountPickerSub', { url: accounts[0]?.url ?? '' })}
        </p>
        <ul className="orbit-account-picker__list" role="listbox">
          {accounts.map((a, i) => (
            <li key={a.id} role="option" aria-selected={i === selected}>
              <button
                ref={el => { itemRefs.current[i] = el; }}
                type="button"
                className={`orbit-account-picker__item${i === selected ? ' is-active' : ''}`}
                onClick={() => pick(a)}
                onMouseEnter={() => setSelected(i)}
              >
                <User size={14} />
                <span className="orbit-account-picker__user">{a.username}</span>
                {a.name && <span className="orbit-account-picker__name">· {a.name}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="orbit-account-picker__actions">
          <button type="button" className="btn btn-ghost" onClick={cancel}>
            {t('orbit.btnCancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface Props {
  label: string;
  /** Muted one-line description under the label. */
  desc?: string;
  /** Bold secondary note under the description (e.g. a requirement hint). */
  note?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Dims the row and blocks interaction (e.g. mutually-exclusive options). */
  disabled?: boolean;
  /** Overrides the toggle's accessible name when it should differ from the label. */
  ariaLabel?: string;
}

/**
 * Standard settings toggle row — a label/description on the left and a switch
 * on the right. Centralises the markup repeated across every settings tab so
 * sections only describe what they toggle, not how a toggle row looks.
 */
export function SettingsToggle({ label, desc, note, checked, onChange, disabled, ariaLabel }: Props) {
  return (
    <div className="settings-toggle-row" style={disabled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
      <div>
        <div style={{ fontWeight: 500 }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{desc}</div>}
        {note && <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginTop: 4 }}>{note}</div>}
      </div>
      <label className="toggle-switch" aria-label={ariaLabel ?? label}>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
        <span className="toggle-track" />
      </label>
    </div>
  );
}

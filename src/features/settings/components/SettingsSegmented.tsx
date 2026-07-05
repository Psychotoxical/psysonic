import type { CSSProperties } from 'react';

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  /** Disables this single option while leaving the rest selectable. */
  disabled?: boolean;
}

interface Props<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Disables the whole control (e.g. an Orbit guest mirroring the host). */
  disabled?: boolean;
  /** Extra class appended to the `settings-segmented` wrapper. */
  className?: string;
  /** Inline style on the wrapper (e.g. the dimmed host-controlled state). */
  style?: CSSProperties;
}

/**
 * Shared `settings-segmented` picker: a row of mutually-exclusive pill buttons
 * where exactly one is active (`btn-primary`) and the rest are `btn-ghost`. The
 * canonical replacement for stacks of mutually-exclusive toggles, which falsely
 * read as "you can turn several on" — see the Track-transitions section for the
 * reference look.
 *
 * Scope is the segmented control only; callers render any per-option detail
 * (sliders, descriptions, sub-cards) below it themselves.
 */
export function SettingsSegmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
  className,
  style,
}: Props<T>) {
  return (
    <div className={className ? `settings-segmented ${className}` : 'settings-segmented'} style={style}>
      {options.map(opt => (
        <button
          key={opt.id}
          type="button"
          className={`btn ${value === opt.id ? 'btn-primary' : 'btn-ghost'}`}
          disabled={disabled || opt.disabled}
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

import type { CSSProperties, KeyboardEvent } from 'react';

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
  /** Programmatic name for the mutually-exclusive option group. */
  ariaLabel: string;
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
  ariaLabel,
  disabled,
  className,
  style,
}: Props<T>) {
  const selectedIsEnabled = options.some(
    option => option.id === value && !disabled && !option.disabled,
  );
  const tabStop = selectedIsEnabled
    ? value
    : options.find(option => !disabled && !option.disabled)?.id;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : 0;
    if (direction === 0 && event.key !== 'Home' && event.key !== 'End') return;

    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="radio"]:not(:disabled)',
    )];
    if (buttons.length === 0) return;
    event.preventDefault();

    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (current + direction + buttons.length) % buttons.length;
    const next = buttons[nextIndex];
    next?.focus();
    next?.click();
  };

  return (
    <div
      className={className ? `settings-segmented ${className}` : 'settings-segmented'}
      style={style}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
    >
      {options.map(opt => (
        <button
          key={opt.id}
          type="button"
          className={`btn ${value === opt.id ? 'btn-primary' : 'btn-ghost'}`}
          disabled={disabled || opt.disabled}
          onClick={() => onChange(opt.id)}
          role="radio"
          aria-checked={value === opt.id}
          tabIndex={tabStop === opt.id ? 0 : -1}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

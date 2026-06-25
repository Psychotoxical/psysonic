import { CheckSquare2 } from 'lucide-react';

interface Props {
  /** Whether selection mode is currently active. */
  active: boolean;
  onToggle: () => void;
  /** Label when not selecting (e.g. "Multi-select"). */
  selectLabel: string;
  /** Label while selecting (e.g. "Cancel selection"). */
  cancelLabel: string;
  /** Tooltip when inactive — defaults to `selectLabel`. */
  startTooltip?: string;
  iconSize?: number;
}

/**
 * Shared multi-select toggle for browse-page toolbars (Albums, Artists,
 * New Releases, Random Albums, Lossless Albums). The label sits in a
 * `toolbar-btn-label` span so the existing mobile / compact-mode rule can
 * collapse it to icon-only while keeping the icon + tooltip + aria-label.
 */
export default function SelectionToggleButton({
  active,
  onToggle,
  selectLabel,
  cancelLabel,
  startTooltip,
  iconSize = 15,
}: Props) {
  const label = active ? cancelLabel : selectLabel;
  return (
    <button
      className={`btn btn-surface${active ? ' btn-sort-active' : ''}`}
      onClick={onToggle}
      aria-label={label}
      data-tooltip={active ? cancelLabel : (startTooltip ?? selectLabel)}
      data-tooltip-pos="bottom"
      style={active ? { background: 'var(--accent)', color: 'var(--text-on-accent)' } : undefined}
    >
      <CheckSquare2 size={iconSize} />
      <span className="toolbar-btn-label">{label}</span>
    </button>
  );
}

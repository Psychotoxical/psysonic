import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  group?: string; // group label — shown as non-selectable header when it changes
  disabled?: boolean;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}

export default function CustomSelect({ value, options, onChange, className = '', style, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dropStyle, setDropStyle] = useState<React.CSSProperties>({});

  const selected = options.find(o => o.value === value);

  const updateDropStyle = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const MARGIN = 6;
    const maxH = 320;
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    const useAbove = spaceBelow < 80 && spaceAbove > spaceBelow;
    const viewportCap = Math.min(maxH, useAbove ? spaceAbove : spaceBelow);
    const contentH = listRef.current?.scrollHeight ?? 0;
    const needsScroll = contentH > viewportCap;
    setDropStyle({
      position: 'fixed',
      left: rect.left,
      width: rect.width,
      ...(useAbove
        ? { bottom: window.innerHeight - rect.top + MARGIN }
        : { top: rect.bottom + MARGIN }),
      maxHeight: needsScroll ? viewportCap : contentH || viewportCap,
      overflowY: needsScroll ? 'auto' : 'hidden',
      zIndex: 99998,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updateDropStyle();
    // Re-measure after layout so short lists (e.g. mood groups) don't get a spurious scrollbar.
    const id = requestAnimationFrame(updateDropStyle);
    return () => cancelAnimationFrame(id);
  }, [open, options]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', updateDropStyle, true);
    return () => window.removeEventListener('scroll', updateDropStyle, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        !triggerRef.current?.contains(e.target as Node) &&
        !listRef.current?.contains(e.target as Node)
      ) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`custom-select-trigger ${className}`}
        style={style}
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen(v => !v); }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="custom-select-label">{selected?.label ?? value}</span>
        <ChevronDown size={14} className={`custom-select-chevron ${open ? 'open' : ''}`} />
      </button>

      {open && createPortal(
        <div
          ref={listRef}
          className="custom-select-dropdown"
          style={dropStyle}
          role="listbox"
        >
          {options.reduce<React.ReactNode[]>((acc, opt, i) => {
            const prevGroup = i > 0 ? options[i - 1].group : undefined;
            if (opt.group && opt.group !== prevGroup) {
              acc.push(
                <div key={`group-${opt.group}`} className="custom-select-group-label">
                  {opt.group}
                </div>
              );
            }
            acc.push(
              <div
                key={opt.value}
                className={`custom-select-option ${opt.value === value ? 'selected' : ''} ${opt.disabled ? 'disabled' : ''}`}
                role="option"
                aria-selected={opt.value === value}
                onMouseDown={() => { if (!opt.disabled) { onChange(opt.value); setOpen(false); } }}
              >
                {opt.label}
              </div>
            );
            return acc;
          }, [])}
        </div>,
        document.body
      )}
    </>
  );
}

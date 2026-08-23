import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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
  ariaLabel?: string;
  ariaInvalid?: boolean;
}

export default function CustomSelect({
  value,
  options,
  onChange,
  className = '',
  style,
  disabled,
  ariaLabel,
  ariaInvalid,
}: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dropStyle, setDropStyle] = useState<React.CSSProperties>({});
  // Keyboard navigation: index of the highlighted option while the list is open.
  const [activeIndex, setActiveIndex] = useState(-1);
  // Stable, render-pure ids for the combobox/listbox relationship.
  const baseId = `custom-select-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const triggerId = `${baseId}-trigger`;
  const listboxId = `${baseId}-listbox`;

  const selected = options.find(o => o.value === value);

  const openList = () => {
    if (disabled) return;
    const selectedIdx = options.findIndex(o => o.value === value && !o.disabled);
    setActiveIndex(selectedIdx >= 0 ? selectedIdx : options.findIndex(o => !o.disabled));
    setOpen(true);
  };

  const moveActive = (delta: 1 | -1) => {
    setActiveIndex(prev => {
      let i = prev;
      for (let step = 0; step < options.length; step++) {
        i = (i + delta + options.length) % options.length;
        if (!options[i]?.disabled) return i;
      }
      return prev;
    });
  };

  const commitActive = () => {
    const opt = options[activeIndex];
    if (opt && !opt.disabled) {
      onChange(opt.value);
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        if (!open) openList();
        else moveActive(e.key === 'ArrowDown' ? 1 : -1);
        break;
      case 'Home':
      case 'End': {
        if (!open) break;
        e.preventDefault();
        const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter(i => i >= 0);
        if (enabled.length) setActiveIndex(e.key === 'Home' ? enabled[0] : enabled[enabled.length - 1]);
        break;
      }
      case 'Enter':
      case ' ':
        // Closed: the native button click toggles. Open: select the highlight.
        if (open) {
          e.preventDefault();
          commitActive();
        }
        break;
      case 'Tab':
        if (open) {
          const opt = options[activeIndex];
          if (opt && !opt.disabled) onChange(opt.value);
          setOpen(false);
        }
        break;
      default:
        break;
    }
  };

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

  // Keep the keyboard-highlighted option visible in long lists.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${listboxId}-opt-${activeIndex}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, listboxId]);

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
        id={triggerId}
        ref={triggerRef}
        type="button"
        role="combobox"
        className={`custom-select-trigger ${className}`}
        style={style}
        disabled={disabled}
        aria-invalid={ariaInvalid || undefined}
        onClick={() => { if (!disabled) { if (open) setOpen(false); else openList(); } }}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
      >
        <span className="custom-select-label">{selected?.label ?? value}</span>
        <ChevronDown size={14} className={`custom-select-chevron ${open ? 'open' : ''}`} />
      </button>

      {open && createPortal(
        <div
          ref={listRef}
          id={listboxId}
          className="custom-select-dropdown"
          style={dropStyle}
          role="listbox"
          aria-labelledby={triggerId}
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
                id={`${listboxId}-opt-${i}`}
                className={`custom-select-option ${opt.value === value ? 'selected' : ''} ${i === activeIndex ? 'active' : ''} ${opt.disabled ? 'disabled' : ''}`}
                role="option"
                aria-disabled={opt.disabled || undefined}
                aria-selected={i === activeIndex}
                onMouseEnter={() => { if (!opt.disabled) setActiveIndex(i); }}
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

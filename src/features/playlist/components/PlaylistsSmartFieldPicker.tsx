import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  findSmartRuleField,
  searchSmartRuleFields,
  type SmartPlaylistCapabilities,
  type SmartRuleFieldDefinition,
} from '@/features/playlist/utils/smartPlaylistFields';

interface Props {
  value: string;
  capabilities: SmartPlaylistCapabilities;
  customFields: readonly SmartRuleFieldDefinition[];
  onChange: (field: SmartRuleFieldDefinition) => void;
  sortableOnly?: boolean;
  className?: string;
  ariaInvalid?: boolean;
}

function fieldLabel(field: SmartRuleFieldDefinition): string {
  return field.label;
}

export default function PlaylistsSmartFieldPicker({
  value, capabilities, customFields, onChange, sortableOnly = false,
  className = '', ariaInvalid,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dropStyle, setDropStyle] = useState<React.CSSProperties>({});
  const baseId = `smart-field-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const listboxId = `${baseId}-listbox`;

  const matches = useMemo(
    () => searchSmartRuleFields(open ? query : '', capabilities, customFields)
      .filter(field => (sortableOnly ? field.sortable !== false : field.filterable !== false)),
    [capabilities, customFields, open, query, sortableOnly],
  );
  const selected = findSmartRuleField(value, customFields)
    ?? matches.find(field => field.name === value);
  const display = selected ? fieldLabel(selected) : value;

  const commit = (field: SmartRuleFieldDefinition) => {
    onChange(field);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  const updateDropStyle = () => {
    if (!inputRef.current) return;
    const rect = inputRef.current.getBoundingClientRect();
    const MARGIN = 6;
    const maxH = 320;
    const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    const useAbove = spaceBelow < 80 && spaceAbove > spaceBelow;
    const viewportCap = Math.min(maxH, useAbove ? spaceAbove : spaceBelow);
    setDropStyle({
      position: 'fixed',
      left: rect.left,
      width: Math.max(rect.width, 220),
      ...(useAbove
        ? { bottom: window.innerHeight - rect.top + MARGIN }
        : { top: rect.bottom + MARGIN }),
      maxHeight: viewportCap,
      overflowY: 'auto',
      zIndex: 99998,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updateDropStyle();
    const id = requestAnimationFrame(updateDropStyle);
    return () => cancelAnimationFrame(id);
  }, [open, matches.length]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', updateDropStyle, true);
    return () => window.removeEventListener('scroll', updateDropStyle, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (
        !inputRef.current?.contains(event.target as Node)
        && !listRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listboxId}-opt-${activeIndex}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listboxId, open]);

  return (
    <div className="smart-field-picker">
      <input
        ref={inputRef}
        className={`input ${className}`}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && matches[activeIndex] ? `${listboxId}-opt-${activeIndex}` : undefined}
        aria-label={t('smartPlaylists.field')}
        aria-invalid={ariaInvalid || undefined}
        placeholder={display || t('smartPlaylists.fieldSearchPlaceholder')}
        value={open ? query : display}
        onFocus={() => {
          setQuery('');
          setActiveIndex(0);
          setOpen(true);
        }}
        onChange={event => {
          setQuery(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActiveIndex(index => Math.min(index + 1, Math.max(matches.length - 1, 0)));
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex(index => Math.max(index - 1, 0));
            return;
          }
          if (event.key === 'Enter' && matches[activeIndex]) {
            event.preventDefault();
            commit(matches[activeIndex]);
            return;
          }
          if (event.key === 'Escape') {
            setOpen(false);
            setQuery('');
            inputRef.current?.blur();
          }
        }}
      />
      {open && createPortal(
        <div
          ref={listRef}
          id={listboxId}
          className="custom-select-dropdown"
          style={dropStyle}
          role="listbox"
          aria-label={t('smartPlaylists.field')}
        >
          {matches.length === 0 ? (
            <div className="custom-select-option disabled">{t('smartPlaylists.fieldSearchEmpty')}</div>
          ) : matches.map((field, index) => (
            <div
              key={field.name}
              id={`${listboxId}-opt-${index}`}
              className={`custom-select-option ${field.name === value ? 'selected' : ''} ${index === activeIndex ? 'active' : ''}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={event => {
                event.preventDefault();
                commit(field);
              }}
            >
              {fieldLabel(field)}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

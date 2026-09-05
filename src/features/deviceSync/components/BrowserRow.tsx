import React from 'react';
import { CheckCircle2 } from 'lucide-react';

interface Props {
  name: string;
  meta?: string;
  selected: boolean;
  onToggle: () => void;
  indent?: boolean;
  disabled?: boolean;
}

export default function BrowserRow({ name, meta, selected, onToggle, indent, disabled }: Props) {
  return (
    <button className={`device-sync-browser-row${selected ? ' selected' : ''}${indent ? ' indent' : ''}`} onClick={onToggle} disabled={disabled}>
      <span className="device-sync-row-check">
        {selected ? <CheckCircle2 size={14} /> : <span className="device-sync-row-circle" />}
      </span>
      <span className="device-sync-row-name">
        {name}
        {meta && <span className="device-sync-row-artist"> · {meta}</span>}
      </span>
    </button>
  );
}

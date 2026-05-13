import React from 'react';

const ALPHABET_KEYS = ['#', ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))];

interface AlphabetFilterBarProps {
  activeLetter: string | null;
  availableLetters: Set<string>;
  onSelect: (l: string) => void;
}

export default function AlphabetFilterBar({ activeLetter, availableLetters, onSelect }: AlphabetFilterBarProps) {
  return (
    <div className="alphabet-filter-bar">
      {ALPHABET_KEYS.map(l => {
        const available = availableLetters.has(l);
        const active = activeLetter === l;
        return (
          <button
            key={l}
            className={`alphabet-filter-btn${active ? ' active' : ''}${!available ? ' empty' : ''}`}
            onClick={() => { if (available) onSelect(l); }}
            tabIndex={available ? 0 : -1}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

import { useState } from 'react';
import { X, Download } from 'lucide-react';

interface Props {
  onConfirm: (since: number) => void;
  onClose: () => void;
}

export default function ExportPickerModal({ onConfirm, onClose }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);

  const handleConfirm = () => {
    const since = new Date(date + 'T00:00:00').getTime();
    onConfirm(since);
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 99998,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '14px',
        padding: '28px 32px',
        width: '340px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
            Alben exportieren
          </h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '4px', display: 'flex' }}
          >
            <X size={18} />
          </button>
        </div>

        <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          Alle Alben exportieren, die seit diesem Datum hinzugekommen sind:
        </p>

        <input
          type="date"
          value={date}
          max={today}
          onChange={e => {
            setDate(e.target.value);
            e.target.blur();
          }}
          style={{
            width: '100%',
            padding: '9px 12px',
            borderRadius: '8px',
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-app)',
            color: 'var(--text-primary)',
            fontSize: '14px',
            boxSizing: 'border-box',
            outline: 'none',
            colorScheme: 'dark',
          }}
        />

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button className="btn btn-surface" onClick={onClose} style={{ flex: 1 }}>
            Abbrechen
          </button>
          <button
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={!date}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
          >
            <Download size={15} />
            Exportieren
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import {
  HIGHLIGHTED_DEPENDENCIES,
  loadLicensesData,
  type LicenseEntry,
  type LicensesData,
} from '../utils/licensesData';
import LicenseTextModal from './LicenseTextModal';

const ROW_HEIGHT = 56;

function formatDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function entryKey(e: LicenseEntry): string {
  return `${e.source}:${e.name}@${e.version}`;
}

function LicenseRow({
  entry,
  onSelect,
  onOpenRepo,
}: {
  entry: LicenseEntry;
  onSelect: (e: LicenseEntry) => void;
  onOpenRepo: (url: string) => void;
}) {
  const repo = entry.repository || entry.homepage;
  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      className="licenses-row"
      style={{
        width: '100%',
        height: ROW_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '8px 12px',
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: 'var(--radius-sm)',
        textAlign: 'left',
        color: 'var(--text-primary)',
        cursor: 'pointer',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: '6px',
            fontSize: '0.9rem',
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <span>{entry.name}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem', fontWeight: 400 }}>
            {entry.version}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            gap: '6px',
            alignItems: 'center',
            marginTop: '2px',
            fontSize: '0.72rem',
            color: 'var(--text-muted)',
          }}
        >
          <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>{entry.source}</span>
          <span>·</span>
          <span style={{ color: 'var(--text-secondary)' }}>{entry.licenses.join(', ') || '—'}</span>
        </div>
      </div>
      {repo && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onOpenRepo(repo);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onOpenRepo(repo);
            }
          }}
          aria-label="Open repository"
          style={{
            color: 'var(--text-muted)',
            padding: '6px',
            borderRadius: 'var(--radius-sm)',
            display: 'inline-flex',
            cursor: 'pointer',
          }}
        >
          <ExternalLink size={14} />
        </span>
      )}
    </button>
  );
}

export default function LicensesPanel() {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<LicensesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<LicenseEntry | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadLicensesData()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const highlights = useMemo(() => {
    if (!data) return [];
    const byKey = new Map<string, LicenseEntry>();
    for (const e of data.entries) {
      byKey.set(`${e.source}:${e.name}`, e);
    }
    return HIGHLIGHTED_DEPENDENCIES.map((h) => byKey.get(`${h.source}:${h.name}`)).filter(
      (e): e is LicenseEntry => e != null,
    );
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.entries;
    return data.entries.filter((e) => {
      if (e.name.toLowerCase().includes(q)) return true;
      if (e.version.toLowerCase().includes(q)) return true;
      for (const lid of e.licenses) {
        if (lid.toLowerCase().includes(q)) return true;
      }
      if (e.source.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [data, query]);

  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const openRepo = (url: string) => {
    openExternal(url).catch(() => {});
  };

  if (error) {
    return (
      <div style={{ padding: '12px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
        {t('licenses.loadError')} <span style={{ color: 'var(--danger)' }}>{error}</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: '12px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
        {t('licenses.loading')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem', lineHeight: 1.55 }}>
        {t('licenses.intro')}
      </div>

      {/* Highlight block */}
      {highlights.length > 0 && (
        <div>
          <div
            style={{
              fontSize: '0.78rem',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              marginBottom: '6px',
            }}
          >
            {t('licenses.highlights')}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: '6px',
            }}
          >
            {highlights.map((e) => (
              <LicenseRow key={entryKey(e)} entry={e} onSelect={setSelected} onOpenRepo={openRepo} />
            ))}
          </div>
        </div>
      )}

      {/* Search */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 10px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <Search size={14} style={{ color: 'var(--text-muted)' }} />
        <input
          type="text"
          className="input"
          placeholder={t('licenses.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            padding: '2px 0',
            color: 'var(--text-primary)',
            fontSize: '0.85rem',
          }}
        />
      </div>

      {/* Virtual list */}
      <div
        ref={scrollParentRef}
        style={{
          height: '420px',
          overflow: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-secondary, var(--bg))',
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ padding: '14px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {t('licenses.noResults')}
          </div>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const entry = filtered[vi.index];
              return (
                <div
                  key={vi.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                    height: vi.size,
                  }}
                >
                  <LicenseRow entry={entry} onSelect={setSelected} onOpenRepo={openRepo} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div
        style={{
          fontSize: '0.72rem',
          color: 'var(--text-muted)',
          display: 'flex',
          gap: '8px',
          flexWrap: 'wrap',
        }}
      >
        <span>
          {t('licenses.totalLine', {
            total: data.stats.total,
            cargo: data.stats.cargo,
            npm: data.stats.npm,
          })}
        </span>
        <span>·</span>
        <span>{t('licenses.generatedAt', { date: formatDate(data.generatedAt, i18n.language) })}</span>
      </div>

      <LicenseTextModal entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

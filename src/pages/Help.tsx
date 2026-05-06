import React, { useMemo, useState } from 'react';
import {
  ChevronDown, Search, Rocket, Play, Sliders, LibraryBig, Mic2, Share2,
  Palette, Wrench, WifiOff, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface FaqItem { id: string; q: string; a: string; }
interface FaqSection { id: string; icon: React.ReactNode; title: string; items: FaqItem[]; }

function AccordionItem({ q, a, open, onToggle }: { q: string; a: string; open: boolean; onToggle: () => void }) {
  return (
    <div className={`help-item${open ? ' help-item-open' : ''}`}>
      <button className="help-question" onClick={onToggle} aria-expanded={open}>
        <span>{q}</span>
        <ChevronDown size={16} className="help-chevron" />
      </button>
      {open && <div className="help-answer">{a}</div>}
    </div>
  );
}

export default function Help() {
  const { t } = useTranslation();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const toggle = (key: string) => setOpenKey(prev => prev === key ? null : key);

  const sections: FaqSection[] = useMemo(() => [
    {
      id: 's1',
      icon: <Rocket size={18} />,
      title: t('help.s1'),
      items: [
        { id: 'q1', q: t('help.q1'), a: t('help.a1') },
        { id: 'q2', q: t('help.q2'), a: t('help.a2') },
        { id: 'q3', q: t('help.q3'), a: t('help.a3') },
      ],
    },
    {
      id: 's2',
      icon: <Play size={18} />,
      title: t('help.s2'),
      items: [
        { id: 'q4', q: t('help.q4'), a: t('help.a4') },
        { id: 'q5', q: t('help.q5'), a: t('help.a5') },
        { id: 'q6', q: t('help.q6'), a: t('help.a6') },
        { id: 'q7', q: t('help.q7'), a: t('help.a7') },
        { id: 'q8', q: t('help.q8'), a: t('help.a8') },
      ],
    },
    {
      id: 's3',
      icon: <Sliders size={18} />,
      title: t('help.s3'),
      items: [
        { id: 'q9',  q: t('help.q9'),  a: t('help.a9') },
        { id: 'q10', q: t('help.q10'), a: t('help.a10') },
        { id: 'q11', q: t('help.q11'), a: t('help.a11') },
        { id: 'q12', q: t('help.q12'), a: t('help.a12') },
        { id: 'q13', q: t('help.q13'), a: t('help.a13') },
      ],
    },
    {
      id: 's4',
      icon: <LibraryBig size={18} />,
      title: t('help.s4'),
      items: [
        { id: 'q14', q: t('help.q14'), a: t('help.a14') },
        { id: 'q15', q: t('help.q15'), a: t('help.a15') },
        { id: 'q16', q: t('help.q16'), a: t('help.a16') },
        { id: 'q17', q: t('help.q17'), a: t('help.a17') },
        { id: 'q18', q: t('help.q18'), a: t('help.a18') },
        { id: 'q19', q: t('help.q19'), a: t('help.a19') },
      ],
    },
    {
      id: 's5',
      icon: <Mic2 size={18} />,
      title: t('help.s5'),
      items: [
        { id: 'q20', q: t('help.q20'), a: t('help.a20') },
        { id: 'q21', q: t('help.q21'), a: t('help.a21') },
      ],
    },
    {
      id: 's6',
      icon: <Share2 size={18} />,
      title: t('help.s6'),
      items: [
        { id: 'q22', q: t('help.q22'), a: t('help.a22') },
        { id: 'q23', q: t('help.q23'), a: t('help.a23') },
        { id: 'q24', q: t('help.q24'), a: t('help.a24') },
      ],
    },
    {
      id: 's7',
      icon: <Palette size={18} />,
      title: t('help.s7'),
      items: [
        { id: 'q25', q: t('help.q25'), a: t('help.a25') },
        { id: 'q26', q: t('help.q26'), a: t('help.a26') },
        { id: 'q27', q: t('help.q27'), a: t('help.a27') },
        { id: 'q28', q: t('help.q28'), a: t('help.a28') },
        { id: 'q29', q: t('help.q29'), a: t('help.a29') },
        { id: 'q30', q: t('help.q30'), a: t('help.a30') },
        { id: 'q31', q: t('help.q31'), a: t('help.a31') },
      ],
    },
    {
      id: 's8',
      icon: <Wrench size={18} />,
      title: t('help.s8'),
      items: [
        { id: 'q32', q: t('help.q32'), a: t('help.a32') },
        { id: 'q33', q: t('help.q33'), a: t('help.a33') },
        { id: 'q34', q: t('help.q34'), a: t('help.a34') },
        { id: 'q35', q: t('help.q35'), a: t('help.a35') },
      ],
    },
    {
      id: 's9',
      icon: <WifiOff size={18} />,
      title: t('help.s9'),
      items: [
        { id: 'q36', q: t('help.q36'), a: t('help.a36') },
        { id: 'q37', q: t('help.q37'), a: t('help.a37') },
        { id: 'q38', q: t('help.q38'), a: t('help.a38') },
      ],
    },
    {
      id: 's10',
      icon: <Wrench size={18} />,
      title: t('help.s10'),
      items: [
        { id: 'q39', q: t('help.q39'), a: t('help.a39') },
        { id: 'q40', q: t('help.q40'), a: t('help.a40') },
        { id: 'q41', q: t('help.q41'), a: t('help.a41') },
        { id: 'q42', q: t('help.q42'), a: t('help.a42') },
        { id: 'q43', q: t('help.q43'), a: t('help.a43') },
        { id: 'q44', q: t('help.q44'), a: t('help.a44') },
        { id: 'q45', q: t('help.q45'), a: t('help.a45') },
      ],
    },
  ], [t]);

  const trimmedQuery = query.trim().toLowerCase();
  const filteredSections = useMemo(() => {
    if (!trimmedQuery) return sections;
    return sections
      .map(s => ({
        ...s,
        items: s.items.filter(i =>
          i.q.toLowerCase().includes(trimmedQuery) ||
          i.a.toLowerCase().includes(trimmedQuery),
        ),
      }))
      .filter(s => s.items.length > 0);
  }, [sections, trimmedQuery]);

  const totalHits = filteredSections.reduce((n, s) => n + s.items.length, 0);
  const isSearching = trimmedQuery.length > 0;

  return (
    <div className="content-body animate-fade-in">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          marginBottom: '1.25rem',
          flexWrap: 'wrap',
        }}
      >
        <h1 className="page-title" style={{ margin: 0 }}>{t('help.title')}</h1>
        <div className="help-search">
          <Search size={14} className="help-search-icon" />
          <input
            type="text"
            className="help-search-input"
            placeholder={t('help.searchPlaceholder')}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="help-search-clear"
              onClick={() => setQuery('')}
              aria-label={t('common.close')}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {isSearching && totalHits === 0 && (
        <div className="empty-state" style={{ padding: '2rem 0' }}>
          {t('help.noResults')}
        </div>
      )}

      <div className="help-columns">
        {filteredSections.map(section => (
          <section key={section.id} className="settings-section" style={{ breakInside: 'avoid', marginBottom: '1.25rem' }}>
            <div className="settings-section-header">
              {section.icon}
              <h2>{section.title}</h2>
            </div>
            <div className="help-list">
              {section.items.map(item => {
                const key = `${section.id}-${item.id}`;
                // While searching, keep matched items expanded so the user sees the answer
                // without having to click each result individually.
                const isOpen = isSearching ? true : openKey === key;
                return (
                  <AccordionItem
                    key={key}
                    q={item.q}
                    a={item.a}
                    open={isOpen}
                    onToggle={() => toggle(key)}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

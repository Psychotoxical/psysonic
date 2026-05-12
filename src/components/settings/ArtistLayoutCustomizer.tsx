import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical } from 'lucide-react';
import { useDragDrop, useDragSource } from '../../contexts/DragDropContext';
import { useArtistLayoutStore, type ArtistSectionConfig, type ArtistSectionId } from '../../store/artistLayoutStore';

const ARTIST_SECTION_LABEL_KEYS: Record<ArtistSectionId, string> = {
  bio:       'settings.artistLayoutBio',
  topTracks: 'settings.artistLayoutTopTracks',
  similar:   'settings.artistLayoutSimilar',
  albums:    'settings.artistLayoutAlbums',
  featured:  'settings.artistLayoutFeatured',
};

type ArtistDropTarget = { idx: number; before: boolean } | null;

function ArtistSectionGripHandle({ idx, label }: { idx: number; label: string }) {
  const { t } = useTranslation();
  const { onMouseDown } = useDragSource(() => ({
    data: JSON.stringify({ type: 'artist_section_reorder', index: idx }),
    label,
  }));
  return (
    <span
      className="sidebar-customizer-grip"
      data-tooltip={t('settings.sidebarDrag')}
      data-tooltip-pos="right"
      onMouseDown={onMouseDown}
    >
      <GripVertical size={16} />
    </span>
  );
}

export function ArtistLayoutCustomizer() {
  const { t } = useTranslation();
  const sections = useArtistLayoutStore(s => s.sections);
  const setSections = useArtistLayoutStore(s => s.setSections);
  const toggleSection = useArtistLayoutStore(s => s.toggleSection);
  const { isDragging: isPsyDragging } = useDragDrop();
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [dropTarget, setDropTarget] = useState<ArtistDropTarget>(null);
  const dropTargetRef = useRef<ArtistDropTarget>(null);
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  useEffect(() => {
    if (!isPsyDragging) { dropTargetRef.current = null; setDropTarget(null); }
  }, [isPsyDragging]);

  useEffect(() => {
    if (!containerEl) return;
    const onPsyDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.data) return;
      let parsed: { type?: string; index?: number };
      try { parsed = JSON.parse(detail.data as string); } catch { return; }
      if (parsed.type !== 'artist_section_reorder' || parsed.index == null) return;

      const fromIdx = parsed.index;
      const target = dropTargetRef.current;
      dropTargetRef.current = null; setDropTarget(null);
      if (!target) return;

      const insertBefore = target.before ? target.idx : target.idx + 1;
      if (insertBefore === fromIdx || insertBefore === fromIdx + 1) return;

      const next = [...sectionsRef.current];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(insertBefore > fromIdx ? insertBefore - 1 : insertBefore, 0, moved);
      setSections(next);
    };
    containerEl.addEventListener('psy-drop', onPsyDrop);
    return () => containerEl.removeEventListener('psy-drop', onPsyDrop);
  }, [containerEl, setSections]);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPsyDragging || !containerEl) return;
    const rows = containerEl.querySelectorAll<HTMLElement>('[data-artist-idx]');
    let target: ArtistDropTarget = null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      const idx = Number(row.dataset.artistIdx);
      if (e.clientY < rect.top + rect.height / 2) { target = { idx, before: true }; break; }
      target = { idx, before: false };
    }
    dropTargetRef.current = target;
    setDropTarget(target);
  };

  return (
    <>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
        {t('settings.artistLayoutDesc')}
      </p>
      <div
        className="settings-card"
        style={{ padding: '4px 0' }}
        ref={setContainerEl}
        onMouseMove={handleMouseMove}
      >
        {sections.map((section: ArtistSectionConfig, i) => {
          const label = t(ARTIST_SECTION_LABEL_KEYS[section.id]);
          const isBefore = isPsyDragging && dropTarget?.idx === i && dropTarget.before;
          const isAfter  = isPsyDragging && dropTarget?.idx === i && !dropTarget.before;
          return (
            <div
              key={section.id}
              data-artist-idx={i}
              className="sidebar-customizer-row"
              style={{
                borderTop:    isBefore ? '2px solid var(--accent)' : undefined,
                borderBottom: isAfter  ? '2px solid var(--accent)' : undefined,
              }}
            >
              <ArtistSectionGripHandle idx={i} label={label} />
              <span style={{ flex: 1, fontSize: 14, opacity: section.visible ? 1 : 0.45 }}>{label}</span>
              <label className="toggle-switch" aria-label={label}>
                <input type="checkbox" checked={section.visible} onChange={() => toggleSection(section.id)} />
                <span className="toggle-track" />
              </label>
            </div>
          );
        })}
      </div>
    </>
  );
}

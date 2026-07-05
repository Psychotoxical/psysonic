import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useArtistLayoutStore, type ArtistSectionConfig, type ArtistSectionId } from '@/features/artist';
import { useListReorderDnd } from '@/lib/hooks/useListReorderDnd';
import { applyListReorderById, type ListReorderDropTarget } from '@/lib/util/listReorder';
import { ReorderGripHandle } from '@/features/settings/components/ReorderGripHandle';

const ARTIST_SECTION_LABEL_KEYS: Record<ArtistSectionId, string> = {
  bio:       'settings.artistLayoutBio',
  topTracks: 'settings.artistLayoutTopTracks',
  similar:   'settings.artistLayoutSimilar',
  albums:    'settings.artistLayoutAlbums',
  featured:  'settings.artistLayoutFeatured',
};

const REORDER_TYPE = 'artist_section_reorder';

export function ArtistLayoutCustomizer() {
  const { t } = useTranslation();
  const sections = useArtistLayoutStore(s => s.sections);
  const setSections = useArtistLayoutStore(s => s.setSections);
  const toggleSection = useArtistLayoutStore(s => s.toggleSection);
  const sectionsRef = useRef(sections);
  // React Compiler refs rule: ref kept in sync with the latest value for use in handlers; not render data.
  // eslint-disable-next-line react-hooks/refs
  sectionsRef.current = sections;

  const apply = useCallback((draggedId: string, target: ListReorderDropTarget) => {
    const next = applyListReorderById(sectionsRef.current, draggedId, target);
    if (next) setSections(next);
  }, [setSections]);

  const { isDragging, setContainer, onMouseMove, dropEdge } = useListReorderDnd({ type: REORDER_TYPE, apply });

  return (
    <>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
        {t('settings.artistLayoutDesc')}
      </p>
      <div style={{ padding: '4px 0' }} ref={setContainer} onMouseMove={onMouseMove}>
        {sections.map((section: ArtistSectionConfig) => {
          const label = t(ARTIST_SECTION_LABEL_KEYS[section.id]);
          const edge = isDragging ? dropEdge(section.id) : null;
          return (
            <div
              key={section.id}
              data-reorder-id={section.id}
              className="sidebar-customizer-row"
              style={{
                borderTop:    edge === 'before' ? '2px solid var(--accent)' : undefined,
                borderBottom: edge === 'after'  ? '2px solid var(--accent)' : undefined,
              }}
            >
              <ReorderGripHandle id={section.id} type={REORDER_TYPE} label={label} />
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

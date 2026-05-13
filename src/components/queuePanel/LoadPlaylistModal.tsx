import { useEffect, useState } from 'react';
import { Play, X, Trash2, ListPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getPlaylists, deletePlaylist } from '../../api/subsonicPlaylists';
import type { SubsonicPlaylist } from '../../api/subsonicTypes';

interface Props {
  onClose: () => void;
  onLoad: (id: string, name: string, mode: 'replace' | 'append') => void;
}

export function LoadPlaylistModal({ onClose, onLoad }: Props) {
  const { t } = useTranslation();
  const [playlists, setPlaylists] = useState<SubsonicPlaylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const fetchPlaylists = () => {
    setLoading(true);
    getPlaylists().then(data => {
      setPlaylists(data);
      setLoading(false);
    }).catch(e => {
      console.error(e);
      setLoading(false);
    });
  };

  useEffect(() => {
    fetchPlaylists();
  }, []);

  const handleDelete = async (id: string, name: string) => {
    setConfirmDelete({ id, name });
  };

  const confirmDeletePlaylist = async () => {
    if (!confirmDelete) return;
    await deletePlaylist(confirmDelete.id);
    setConfirmDelete(null);
    fetchPlaylists();
  };

  return (
    <>
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '560px', width: '90vw' }}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>
        <h3 style={{ marginBottom: '1rem', fontFamily: 'var(--font-display)' }}>{t('queue.loadPlaylist')}</h3>
        {!loading && playlists.length > 0 && (
          <input
            type="text"
            className="live-search-field"
            placeholder={t('queue.filterPlaylists')}
            value={filter}
            onChange={e => setFilter(e.target.value)}
            autoFocus
            style={{ width: '100%', marginBottom: '0.75rem', padding: '8px 14px' }}
          />
        )}
        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>{t('queue.loading')}</p>
        ) : playlists.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>{t('queue.noPlaylists')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
            {playlists.filter(p => p.name.toLowerCase().includes(filter.toLowerCase())).map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--ctp-surface1)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontWeight: 500 }} className="truncate" data-tooltip={p.name}>{p.name}</span>
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                  <button className="nav-btn" onClick={() => onLoad(p.id, p.name, 'replace')} data-tooltip={t('queue.load')} style={{ width: '28px', height: '28px', background: 'transparent' }}><Play size={14} /></button>
                  <button className="nav-btn" onClick={() => onLoad(p.id, p.name, 'append')} data-tooltip={t('queue.appendToQueue')} style={{ width: '28px', height: '28px', background: 'transparent' }}><ListPlus size={14} /></button>
                  <button className="nav-btn" onClick={() => handleDelete(p.id, p.name)} data-tooltip={t('queue.delete')} style={{ width: '28px', height: '28px', background: 'transparent', color: 'var(--ctp-red)' }}><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>

    {confirmDelete && (
      <div className="modal-overlay" onClick={() => setConfirmDelete(null)} role="dialog" aria-modal="true">
        <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '360px' }}>
          <button className="modal-close" onClick={() => setConfirmDelete(null)}><X size={18} /></button>
          <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-display)' }}>{t('queue.delete')}</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem', lineHeight: 1.5 }}>
            {t('queue.deleteConfirm', { name: confirmDelete.name })}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>{t('queue.cancel')}</button>
            <button className="btn btn-primary" style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={confirmDeletePlaylist}>
              {t('queue.delete')}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

import { useTranslation } from 'react-i18next';
import { Download, FileUp, HardDrive, Lightbulb, Search } from 'lucide-react';
import { usePlaylistLayoutStore, type PlaylistLayoutItemId } from '../../store/playlistLayoutStore';

const PLAYLIST_LAYOUT_ICONS: Record<PlaylistLayoutItemId, typeof Search> = {
  addSongs:     Search,
  importCsv:    FileUp,
  downloadZip:  Download,
  offlineCache: HardDrive,
  suggestions:  Lightbulb,
};

const PLAYLIST_LAYOUT_LABEL_KEYS: Record<PlaylistLayoutItemId, string> = {
  addSongs:     'playlists.addSongs',
  importCsv:    'playlists.importCSV',
  downloadZip:  'playlists.downloadZip',
  offlineCache: 'playlists.cacheOffline',
  suggestions:  'playlists.suggestions',
};

export function PlaylistLayoutCustomizer() {
  const { t } = useTranslation();
  const items = usePlaylistLayoutStore(s => s.items);
  const toggleItem = usePlaylistLayoutStore(s => s.toggleItem);

  return (
    <div className="settings-card" style={{ padding: '4px 0' }}>
      {items.map((it) => {
        const Icon = PLAYLIST_LAYOUT_ICONS[it.id];
        const label = t(PLAYLIST_LAYOUT_LABEL_KEYS[it.id]);
        return (
          <div key={it.id} className="sidebar-customizer-row">
            <Icon size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 14 }}>{label}</span>
            <label className="toggle-switch" aria-label={label}>
              <input type="checkbox" checked={it.visible} onChange={() => toggleItem(it.id)} />
              <span className="toggle-track" />
            </label>
          </div>
        );
      })}
    </div>
  );
}

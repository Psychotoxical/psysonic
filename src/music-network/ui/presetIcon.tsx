import { Globe, Radio, Server, Music2, Headphones } from 'lucide-react';
import LastfmIcon from '@/ui/LastfmIcon';
import type { PresetIcon } from '@/music-network';

/**
 * Maps a preset manifest icon id to a rendered icon. Feature code references the
 * manifest's `icon` field — never a provider name — so adding a provider is a
 * data change, not a component edit.
 */
export function renderPresetIcon(icon: PresetIcon, size = 16): React.ReactNode {
  switch (icon) {
    case 'lastfm':
    case 'librefm':
      return <LastfmIcon size={size} />;
    case 'rocksky':
      return <Music2 size={size} />;
    case 'listenbrainz':
      return <Radio size={size} />;
    case 'koito':
      return <Headphones size={size} />;
    case 'maloja':
      return <Server size={size} />;
    case 'custom':
    default:
      return <Globe size={size} />;
  }
}

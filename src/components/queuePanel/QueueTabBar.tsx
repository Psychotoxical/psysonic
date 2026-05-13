import { Info, ListMusic, MicVocal } from 'lucide-react';
import type { TFunction } from 'i18next';

type LyricsTab = 'queue' | 'lyrics' | 'info';

interface Props {
  activeTab: LyricsTab;
  setTab: (tab: LyricsTab) => void;
  t: TFunction;
}

export function QueueTabBar({ activeTab, setTab, t }: Props) {
  return (
    <div className="queue-tab-bar">
      <button
        className={`queue-tab-btn${activeTab === 'queue' ? ' active' : ''}`}
        onClick={() => setTab('queue')}
        aria-label={t('queue.title')}
      >
        <ListMusic size={14} />
        {t('queue.title')}
      </button>
      <button
        className={`queue-tab-btn${activeTab === 'lyrics' ? ' active' : ''}`}
        onClick={() => setTab('lyrics')}
        aria-label={t('player.lyrics')}
      >
        <MicVocal size={14} />
        {t('player.lyrics')}
      </button>
      <button
        className={`queue-tab-btn${activeTab === 'info' ? ' active' : ''}`}
        onClick={() => setTab('info')}
        aria-label={t('nowPlayingInfo.tab')}
      >
        <Info size={14} />
        {t('nowPlayingInfo.tab')}
      </button>
    </div>
  );
}

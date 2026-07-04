import React from 'react';
import { createPortal } from 'react-dom';
import { PictureInPicture2, SlidersVertical } from 'lucide-react';
import { openMiniPlayer } from '@/lib/api/miniPlayer';
import type { TFunction } from 'i18next';
import { PlayerVolume } from '@/features/playback/components/playerBar/PlayerVolume';
import { PlayerPlaybackRateMenuSection } from '@/features/playback/components/playerBar/PlayerPlaybackRate';
import {
  usePlayerBarLayoutStore,
  type PlayerBarLayoutItemId,
} from '@/features/playback/store/playerBarLayoutStore';

interface Props {
  utilityMenuRef: React.RefObject<HTMLDivElement | null>;
  utilityMenuStyle: React.CSSProperties;
  utilityMenuMode: 'full' | 'volume';
  eqOpen: boolean;
  setEqOpen: (updater: boolean | ((v: boolean) => boolean)) => void;
  closeMenu: () => void;
  volume: number;
  setVolume: (v: number) => void;
  premuteVolumeRef: React.MutableRefObject<number>;
  showVolPct: boolean;
  setShowVolPct: (v: boolean) => void;
  handleVolume: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleVolumeWheel: (e: React.WheelEvent<HTMLElement>) => void;
  volumeStyle: React.CSSProperties;
  t: TFunction;
}

export function PlayerOverflowMenu({
  utilityMenuRef, utilityMenuStyle, utilityMenuMode,
  eqOpen, setEqOpen, closeMenu,
  volume, setVolume, premuteVolumeRef, showVolPct, setShowVolPct,
  handleVolume, handleVolumeWheel, volumeStyle, t,
}: Props) {
  const layoutItems = usePlayerBarLayoutStore(s => s.items);
  const isLayoutVisible = (id: PlayerBarLayoutItemId) =>
    layoutItems.find(i => i.id === id)?.visible !== false;
  const showEqualizer = isLayoutVisible('equalizer');
  const showMiniPlayer = isLayoutVisible('miniPlayer');
  const showPlaybackRate = isLayoutVisible('playbackRate');
  return createPortal(
    <div
      className={`player-overflow-menu${utilityMenuMode === 'volume' ? ' player-overflow-menu--volume-only' : ''}`}
      ref={utilityMenuRef}
      style={utilityMenuStyle}
      onWheel={handleVolumeWheel}
    >
      {utilityMenuMode === 'full' && (showEqualizer || showMiniPlayer) && (
        <div className="player-overflow-menu-row">
          {showEqualizer && (
            <button
              className={`player-overflow-menu-btn${eqOpen ? ' active' : ''}`}
              onClick={() => {
                setEqOpen(v => !v);
                closeMenu();
              }}
            >
              <SlidersVertical size={14} />
              {t('player.equalizer')}
            </button>
          )}
          {showMiniPlayer && (
            <button
              className="player-overflow-menu-btn"
              onClick={() => {
                openMiniPlayer().catch(() => {});
                closeMenu();
              }}
            >
              <PictureInPicture2 size={14} />
              {t('player.miniPlayer')}
            </button>
          )}
        </div>
      )}
      {utilityMenuMode === 'full' && showPlaybackRate && (
        <PlayerPlaybackRateMenuSection t={t} />
      )}
      <PlayerVolume
        volume={volume}
        setVolume={setVolume}
        premuteVolumeRef={premuteVolumeRef}
        showVolPct={showVolPct}
        setShowVolPct={setShowVolPct}
        handleVolume={handleVolume}
        handleVolumeWheel={handleVolumeWheel}
        volumeStyle={volumeStyle}
        inputId={utilityMenuMode === 'full' ? 'player-volume-overflow' : 'player-volume-overflow-wheel'}
        sectionModifier="menu"
        wrapModifier={utilityMenuMode === 'volume' ? 'menu-only' : undefined}
        t={t}
      />
    </div>,
    document.body,
  );
}

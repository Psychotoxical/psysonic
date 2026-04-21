import React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { usePlayerStore } from '../store/playerStore';

export default function TitleBar() {
  const win = getCurrentWindow();
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-track" data-tauri-drag-region>
        {currentTrack && (
          <>
            <span className="titlebar-track-state">{isPlaying ? '▶' : '⏸'}</span>
            <span className="titlebar-track-text truncate">
              {currentTrack.artist && `${currentTrack.artist} – `}{currentTrack.title}
            </span>
          </>
        )}
      </div>

      <div className="titlebar-controls">
        <button
          className="titlebar-btn titlebar-btn-minimize"
          onClick={() => win.minimize()}
          data-tooltip="Minimize"
          data-tooltip-pos="bottom"
          aria-label="Minimize"
        />
        <button
          className="titlebar-btn titlebar-btn-maximize"
          onClick={() => win.toggleMaximize()}
          data-tooltip="Maximize"
          data-tooltip-pos="bottom"
          aria-label="Maximize"
        />
        <button
          className="titlebar-btn titlebar-btn-close"
          onClick={() => win.close()}
          data-tooltip="Close"
          data-tooltip-pos="bottom"
          aria-label="Close"
        />
      </div>
    </div>
  );
}

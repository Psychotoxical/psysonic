import { useEffect } from 'react';
import { emit } from '@tauri-apps/api/event';
import { useKeybindingsStore, matchInAppBinding } from '../store/keybindingsStore';

/** Mini-window keyboard shortcuts. Space/Arrow{Left,Right} run the standard
 *  play-pause/next/prev shortcut actions (source: 'mini-window' so the bridge
 *  knows it didn't come from main). Ctrl+Z and Ctrl+Shift+Z emit
 *  mini:undo-queue / mini:redo-queue. The user-configured 'open-mini-player'
 *  chord is also honoured so the same shortcut that opens the mini from main
 *  also closes it from here. All shortcuts ignore inputs/textareas/editable
 *  content. */
export function useMiniKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;

      const openMiniBinding = useKeybindingsStore.getState().bindings['open-mini-player'];
      if (matchInAppBinding(e, openMiniBinding)) {
        e.preventDefault();
        emit('shortcut:run-action', {
          action: 'open-mini-player',
          source: 'mini-window',
        }).catch(() => {});
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyZ' || e.key?.toLowerCase() === 'z')) {
        e.preventDefault();
        if (e.shiftKey) {
          emit('mini:redo-queue', {}).catch(() => {});
        } else {
          emit('mini:undo-queue', {}).catch(() => {});
        }
        return;
      }

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        emit('shortcut:run-action', {
          action: 'play-pause',
          source: 'mini-window',
        }).catch(() => {});
      } else if (e.key === 'ArrowRight') {
        emit('shortcut:run-action', {
          action: 'next',
          source: 'mini-window',
        }).catch(() => {});
      } else if (e.key === 'ArrowLeft') {
        emit('shortcut:run-action', {
          action: 'prev',
          source: 'mini-window',
        }).catch(() => {});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

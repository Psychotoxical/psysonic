import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App';
import './i18n';
import './styles/theme.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/tracks.css';

// Expose the Tauri window label synchronously so App() can pick its root
// component (main app vs mini player) on first render without flicker.
try {
  (window as any).__PSY_WINDOW_LABEL__ = getCurrentWindow().label;
} catch {
  (window as any).__PSY_WINDOW_LABEL__ = 'main';
}

// Sync backend HTTP User-Agent from the main webview once at startup.
try {
  const windowLabel = (window as any).__PSY_WINDOW_LABEL__ ?? 'main';
  if (windowLabel === 'main') {
    const ua = window.navigator.userAgent?.trim();
    if (ua) {
      void invoke('set_subsonic_wire_user_agent', { userAgent: ua, windowLabel });
    }
  }
} catch {
  // Ignore in non-Tauri runtimes.
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

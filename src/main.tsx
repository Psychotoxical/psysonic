import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { runPreReactBootstrap } from './app/bootstrap';
import { scheduleStartupSplashDismiss } from './app/startupSplash';
import '@/lib/i18n';
import './styles/themes/index.css';
import './styles/layout/index.css';
import './styles/components/index.css';
import './styles/tracks/index.css';

runPreReactBootstrap();

try {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
} finally {
  // Always dismiss the inline splash once the bundle has executed — even when
  // React mount throws, so Windows users are not stuck on "Loading" forever.
  scheduleStartupSplashDismiss();
}

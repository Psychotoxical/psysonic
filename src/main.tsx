import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { runPreReactBootstrap } from './app/bootstrap';
import './i18n';
import './styles/themes/index.css';
import './styles/layout/index.css';
import './styles/components/index.css';
import './styles/tracks.css';

runPreReactBootstrap();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

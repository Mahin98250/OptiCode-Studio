import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import App from './App';
import './styles/globals.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/OptiCode-Studio/sw.js', {
        scope: '/OptiCode-Studio/',
        updateViaCache: 'none',
      })
      .catch(() => {
        // Keep the app fully usable even if service worker registration is unavailable.
      });
  });
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <HashRouter>
    <App />
    <Toaster
      richColors
      position="top-right"
      toastOptions={{
        style: {
          borderRadius: '18px',
          backdropFilter: 'blur(24px)',
        },
      }}
    />
  </HashRouter>
);

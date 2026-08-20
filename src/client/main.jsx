import { createRoot } from 'react-dom/client';
import { App } from './dashboard/App.jsx';
import { ReviewApp } from './review/ReviewApp.jsx';
import { ThemeProvider } from './shared/theme.js';

function Root() {
  if (window.location.pathname === '/review') {
    document.title = 'AI Token 复盘 · Token Studio';
    return <ReviewApp />;
  }

  document.title = 'Token Studio · AI Token Dashboard';
  return <App />;
}

createRoot(document.getElementById('root')).render(
  <ThemeProvider>
    <Root />
  </ThemeProvider>
);

// PWA: register the service worker (HTTPS only) and reload exactly once when
// a new worker takes control, so a redeploy lands on open tabs automatically.
if ('serviceWorker' in navigator && window.isSecureContext) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

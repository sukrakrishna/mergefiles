import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App'

// This app ships no service worker. Remove any stale one (e.g. from an earlier deployment on the same origin) so nothing can
// intercept or cache /api requests.
try {
  void navigator.serviceWorker?.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister()))
} catch { /* not supported */ }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { simController } from './state/simController';
import { viewSettings } from './state/viewSettings';
import { aerialStore } from './state/aerial';
import './styles.css';

// Expose the controller for manual inspection in the browser console
// (e.g. beeguard.engine.state). Read it; don't write to it.
(window as unknown as { beeguard: typeof simController }).beeguard = simController;
(window as unknown as { beeguardView: typeof viewSettings }).beeguardView = viewSettings;
(window as unknown as { beeguardAerial: typeof aerialStore }).beeguardAerial = aerialStore;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

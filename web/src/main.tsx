import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyAppearance, cachedAppearance } from './lib/appearance';
import './styles.css';

/*
  Before React draws anything. The server's copy arrives with /auth/me a
  moment later and replaces this, but painting the stock theme first and
  correcting it afterwards is a visible flinch on every page load.
*/
applyAppearance(cachedAppearance(), { persist: false });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

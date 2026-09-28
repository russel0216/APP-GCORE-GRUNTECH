import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyAppearance, cachedAppearance } from './lib/appearance';
import './styles.css';
/*
  One stylesheet per package, after the base so a package's rules win a tie.
  Each holds only what its screens add; tokens come from styles.css and
  nothing in these files is a literal colour.
*/
import './styles/calendar.css';
import './styles/pipeline.css';
import './styles/brief.css';
import './styles/masters.css';
import './styles/numbering.css';
import './styles/finance.css';
import './styles/service.css';
import './styles/plantilla.css';
import './styles/meetings.css';
import './styles/evaluations.css';
import './styles/academy.css';
import './styles/workspace.css';
import './styles/delivery.css';
import './styles/procurement.css';
import './styles/hr-audit.css';
import './styles/archive.css';
import './styles/quotation-editor.css';
import './styles/quotation-detail.css';

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

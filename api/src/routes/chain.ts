import { Router } from 'express';
import { handler } from '../http/kit';
import { authenticate, require_, currentUser } from '../auth/middleware';
import { chainOverview } from '../shared/chain';

// ════════════════════════════════════════════════════════════════════
//  G-CHAIN OVERVIEW — the dashboard's figures, decided once
// ════════════════════════════════════════════════════════════════════

export const chainRoutes = Router();
chainRoutes.use(authenticate);

/**
 * The four numbers on the G-CHAIN landing page. Each is null when the caller
 * cannot open the list behind it, so the page shows "—" rather than a zero
 * that looks like an empty queue.
 */
chainRoutes.get(
  '/overview',
  require_('gchain.dashboard.view_all'),
  handler(async (req, res) => {
    res.json(await chainOverview(currentUser(req)));
  }),
);

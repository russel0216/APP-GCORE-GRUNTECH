import { Router } from 'express';

import { handler } from '../http/kit';
import { authenticate, require_, currentUser } from '../auth/middleware';
import { gopsOverview } from '../shared/gops';

/**
 * G-OPS — the module overview.
 *
 * One read, not twenty. The dashboard used to count each tile with its own
 * `?pageSize=1` request off a list screen, which is fine for four tiles and
 * silly for twenty: twenty round trips, twenty query plans, and a page that
 * fills in raggedly. This groups each entity once and returns the lot.
 *
 * The figures themselves are decided in `shared/gops.ts`, because the
 * Insights brief prints the same counts and must never disagree with this
 * screen. READ ONLY, adds no table, and every block is gated on its own
 * permission — see the comment there.
 */

export const gopsRoutes = Router();
gopsRoutes.use(authenticate);

gopsRoutes.get(
  '/overview',
  require_('gops.dashboard.view_all'),
  handler(async (req, res) => {
    // `_scope` is for the Insights brief; this response stays exactly what it
    // was before the extraction.
    const { _scope, ...overview } = await gopsOverview(currentUser(req), req.query);
    void _scope;
    res.json(overview);
  }),
);

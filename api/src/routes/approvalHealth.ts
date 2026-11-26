/**
 * Admin › Approval Health (2026-11-26) — read-only. See shared/approvalHealth.ts.
 */
import { Router } from 'express';
import { authenticate, require_ } from '../auth/middleware';
import { handler, notFound } from '../http/kit';
import { healthOverview, personCheck } from '../shared/approvalHealth';

export const approvalHealthRoutes = Router();
approvalHealthRoutes.use(authenticate);

approvalHealthRoutes.get(
  '/',
  require_('admin.approval_health.view_all'),
  handler(async (_req, res) => {
    res.json(await healthOverview());
  }),
);

approvalHealthRoutes.get(
  '/person/:userId',
  require_('admin.approval_health.view_all'),
  handler(async (req, res) => {
    const out = await personCheck(String(req.params.userId));
    if (!out) throw notFound('No such login');
    res.json(out);
  }),
);

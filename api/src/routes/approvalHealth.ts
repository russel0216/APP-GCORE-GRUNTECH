/**
 * Admin › Approval Health (2026-11-26) — read-only. See shared/approvalHealth.ts.
 */
import { Router } from 'express';
import { authenticate, require_, requireSuperAdmin } from '../auth/middleware';
import { handler, notFound } from '../http/kit';
import { healthOverview, personCheck } from '../shared/approvalHealth';
import { resumeStranded } from '../shared/approvals';
import { currentUser } from '../auth/middleware';

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

/**
 * Resume a request stranded at a step its route no longer has — the System
 * Administrator's call (see `resumeStranded`). Above nothing: its path has no /:id twin.
 */
approvalHealthRoutes.post(
  '/resume/:requestId',
  require_('admin.approval_health.view_all'),
  requireSuperAdmin,
  handler(async (req, res) => {
    const me = currentUser(req);
    const r = await resumeStranded(String(req.params.requestId), me.id);
    res.json({ ok: true, status: r.status, currentSequence: r.currentSequence });
  }),
);

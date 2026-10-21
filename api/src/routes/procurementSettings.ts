import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { handler, parseBody } from '../http/kit';
import { authenticate } from '../auth/middleware';
import { audit } from '../shared/audit';
import { requireView, requireEdit } from '../shared/ownScope';
import { DEFAULT_TERMS, TERMS_KEY, procurementTerms } from '../shared/procurementTerms';
import { overBudgetIsBlocked } from '../shared/inventory';

/**
 * G-CHAIN › Administration › PROCUREMENT SETTINGS (2026-10-21): the standard
 * terms a purchase order and an RFQ print for goods and for services, and
 * whether a request over a project's budget is refused. A page that keeps no
 * record of anybody's, so either key opens and saves it (CLAUDE.md rule 1).
 */
export const procurementSettingsRoutes = Router();
procurementSettingsRoutes.use(authenticate);

const BLOCK_KEY = 'procurement.blockOverBudget';

async function current() {
  return { terms: await procurementTerms(), defaults: DEFAULT_TERMS, blockOverBudget: await overBudgetIsBlocked() };
}

procurementSettingsRoutes.get(
  '/',
  requireView('gchain', 'settings'),
  handler(async (_req, res) => {
    res.json(await current());
  }),
);

/** Saves the keys sent — a card PUTs only what it edits. Audited as a setting. */
procurementSettingsRoutes.put(
  '/',
  requireEdit('gchain', 'settings'),
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        terms: z.object({ goods: z.string().max(8000), services: z.string().max(8000) }).partial().optional(),
        blockOverBudget: z.boolean().optional(),
      }),
      req.body ?? {},
    );
    const before = await current();
    if (body.terms) {
      const terms = { ...before.terms, ...body.terms };
      await prisma.setting.upsert({ where: { key: TERMS_KEY }, create: { key: TERMS_KEY, value: terms }, update: { value: terms } });
      await audit(
        { entityType: 'setting', entityId: TERMS_KEY, action: 'UPDATED', summary: 'Procurement terms changed', before: before.terms, after: terms },
        req,
      );
    }
    if (body.blockOverBudget !== undefined && body.blockOverBudget !== before.blockOverBudget) {
      await prisma.setting.upsert({
        where: { key: BLOCK_KEY },
        create: { key: BLOCK_KEY, value: body.blockOverBudget },
        update: { value: body.blockOverBudget },
      });
      await audit(
        {
          entityType: 'setting',
          entityId: BLOCK_KEY,
          action: 'UPDATED',
          summary: body.blockOverBudget ? 'Requests over a project budget are refused' : 'Requests over a project budget are allowed',
          before: { blockOverBudget: before.blockOverBudget },
          after: { blockOverBudget: body.blockOverBudget },
        },
        req,
      );
    }
    res.json(await current());
  }),
);

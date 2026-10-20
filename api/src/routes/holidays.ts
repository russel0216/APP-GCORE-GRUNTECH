import { Router } from 'express';
import { z } from 'zod';
import { handler, parseBody } from '../http/kit';
import { authenticate } from '../auth/middleware';
import { audit } from '../shared/audit';
import { requireEdit } from '../shared/ownScope';
import { holidays, loadHolidays, phHolidays, saveHolidays, type Holiday } from '../shared/holidays';

/**
 * Holidays (2026-10-17): read by anyone signed in — the costing sheet, the
 * project form and the job order form count working days with them — and
 * changed on Company Settings › Holidays by whoever edits company settings —
 * Edit Own or Edit All alike, since the page keeps no record of anybody's
 * (2026-10-18).
 */
export const holidayRoutes = Router();
holidayRoutes.use(authenticate);

holidayRoutes.get(
  '/',
  handler(async (_req, res) => {
    res.json({ holidays: await holidays() });
  }),
);

/** The Philippine holidays of a year as the seed would add them — "Add <year>" on the card. */
holidayRoutes.get(
  '/ph/:year',
  requireEdit('admin', 'company'),
  handler(async (req, res) => {
    const year = Number(req.params.year);
    res.json({ holidays: Number.isInteger(year) && year >= 2000 && year <= 2100 ? phHolidays(year) : [] });
  }),
);

const schema = z.object({
  holidays: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A holiday needs a date'),
        name: z.string().trim().min(1, 'Name the holiday').max(120),
        kind: z.enum(['REGULAR', 'SPECIAL']),
      }),
    )
    .max(500),
});

holidayRoutes.put(
  '/',
  requireEdit('admin', 'company'),
  handler(async (req, res) => {
    const body = parseBody(schema, req.body);
    const before = await holidays();
    const after = await saveHolidays(body.holidays as Holiday[]);
    await loadHolidays();
    const was = new Set(before.map((h) => h.date));
    const now = new Set(after.map((h) => h.date));
    const added = after.filter((h) => !was.has(h.date)).map((h) => h.date);
    const removed = before.filter((h) => !now.has(h.date)).map((h) => h.date);
    await audit(
      {
        entityType: 'setting',
        entityId: 'calendar.holidays',
        action: 'UPDATED',
        summary: `Updated the holidays (${after.length}${added.length ? `, ${added.length} added` : ''}${removed.length ? `, ${removed.length} removed` : ''})`,
        after: { added, removed },
      },
      req,
    );
    res.json({ holidays: after });
  }),
);

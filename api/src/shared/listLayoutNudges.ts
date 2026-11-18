import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/** `APPEARANCE_KEY` in routes/appearance.ts — named here so the seed loads no router. */
const APPEARANCE_KEY = 'appearance';

/**
 * Once (2026-11-17, the owner's call): the Sales, Project Management, Aftermarket,
 * G-CHAIN, G-FIN, G-HR and Admin screens lost their big title and every one took the same toolbar — "+ New …"
 * first, Print and ⋯ at the right — and every stat card is centred with its
 * figure at one height, its icon in the corner. Nudges saved before in Modify
 * layout on those screens were made for the old layout, and are pinned by
 * position ("the 9th button"), so they now push the wrong things (the
 * Pipeline's "+ New" landed on its "Working view" box; the Costing tiles'
 * names slid under their icons).
 *
 * Removed: a rule on one of those screens that only MOVES an element (its one
 * declaration is `transform`), and a rule on a stat card or the card grid that
 * only moves or SIZES it. A font size, a colour or anything else is the
 * administrator's choice and stays. Marked so it never runs again: a nudge
 * made after it is kept.
 */

const MARK = 'seed.listLayoutNudges20261117';

const ROUTES = [
  // Sales
  '/g-ops/pipeline',
  '/g-ops/forecast',
  '/g-ops/leads',
  '/g-ops/travel-requests',
  '/g-ops/quotations',
  '/g-ops/sales-orders',
  '/g-ops/customers',
  '/g-ops/partners',
  '/g-ops/calendar',
  '/g-ops/marketing',
  // Project Management
  '/g-ops/costing',
  '/g-ops/projects',
  '/g-ops/job-orders',
  '/g-ops/cad-job-orders',
  // Aftermarket
  '/g-ops/aftermarket',
  '/g-ops/installed-base',
  '/g-ops/service-job-orders',
  '/g-ops/visits',
  '/g-ops/service-contracts',
  '/g-ops/service-documents',
  // G-CHAIN
  '/g-chain',
  '/g-chain/purchase-requests',
  '/g-chain/rfq',
  '/g-chain/canvass',
  '/g-chain/purchase-orders',
  '/g-chain/incoming',
  '/g-chain/inventory',
  '/g-chain/pullout-slips',
  '/g-chain/borrow-slips',
  '/g-chain/outgoing',
  '/g-chain/items',
  '/g-chain/suppliers',
  '/g-chain/warehouses',
  // G-FIN
  '/g-fin',
  '/g-fin/invoice-requests',
  '/g-fin/ar',
  '/g-fin/ap',
  '/g-fin/expenses',
  '/g-fin/cash-advances',
  '/g-fin/commissions',
  '/g-fin/budget-requests',
  '/g-fin/travel-requests',
  '/g-fin/budget-liquidations',
  '/g-fin/payments-out',
  '/g-fin/payments',
  '/g-fin/cash-flow',
  '/g-fin/budget-vs-actual',
  '/g-fin/operations-budget',
  // G-HR
  '/g-hr',
  '/g-hr/memos',
  '/g-hr/attendance',
  '/g-hr/leave',
  '/g-hr/overtime',
  '/g-hr/attendance-corrections',
  '/g-hr/meetings',
  '/g-hr/employees',
  '/g-hr/plantilla',
  '/g-hr/assets',
  '/g-hr/hiring/mpr',
  '/g-hr/hiring/candidates',
  '/g-hr/hiring/exams',
  '/g-hr/hiring/contracts',
  '/g-hr/people-flow',
  '/g-hr/evaluations',
  '/g-hr/evaluation-runs',
  '/g-hr/clearances',
  '/g-hr/academy/courses',
  '/g-hr/academy/sessions',
  '/g-hr/academy/passports',
  // Admin
  '/admin/users',
  '/admin/roles',
  '/admin/workflows',
  '/admin/categories',
  '/admin/audit',
  '/admin/help-tickets',
];

const PLACEMENT = new Set(['transform', 'width', 'height', 'flex', 'max-width', 'min-width', 'max-height', 'min-height']);

/** A rule made for the old layout of one of these screens. */
export function isStaleLayoutNudge(selector: string, declarations: Record<string, string>): boolean {
  if (!ROUTES.some((r) => selector.startsWith(`[data-route="${r}"]`))) return false;
  const keys = Object.keys(declarations);
  if (!keys.length) return false;
  if (keys.length === 1 && keys[0] === 'transform') return true;
  return /\.kpi-/.test(selector) && keys.every((k) => PLACEMENT.has(k));
}

export async function clearListLayoutNudges(): Promise<string | null> {
  if (await prisma.setting.findUnique({ where: { key: MARK } })) return null;
  let said: string | null = null;
  const row = await prisma.setting.findUnique({ where: { key: APPEARANCE_KEY } });
  const value = row?.value as Record<string, unknown> | null | undefined;
  const rules = (value?.rules ?? null) as Record<string, Record<string, string>> | null;
  if (value && rules && typeof rules === 'object') {
    const removed = Object.keys(rules).filter((sel) => isStaleLayoutNudge(sel, rules[sel] ?? {}));
    if (removed.length) {
      const kept = Object.fromEntries(Object.entries(rules).filter(([sel]) => !removed.includes(sel)));
      await prisma.setting.update({
        where: { key: APPEARANCE_KEY },
        data: { value: { ...value, rules: kept } as Prisma.InputJsonValue },
      });
      await prisma.auditLog.create({
        data: {
          entityType: 'setting',
          entityId: APPEARANCE_KEY,
          action: 'UPDATED',
          summary: `Removed ${removed.length} layout nudge${removed.length === 1 ? '' : 's'} on the Sales, Project Management, Aftermarket, G-CHAIN, G-FIN, G-HR and Admin screens, made for the layout before the uniform toolbar`,
          before: { removed: Object.fromEntries(removed.map((sel) => [sel, rules[sel]])) } as Prisma.InputJsonValue,
        },
      });
      said = `${removed.length} old layout nudge${removed.length === 1 ? '' : 's'} removed`;
    }
  }
  await prisma.setting.create({ data: { key: MARK, value: { at: new Date().toISOString() } } });
  return said;
}

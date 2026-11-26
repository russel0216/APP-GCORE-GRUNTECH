import { prisma } from '../prisma';
import { audit } from './audit';

/**
 * The money routes of 2026-11-26 (the owner's call: "they don't want Carter
 * Gasiong to approve budget request, particular in BOSS"):
 *
 *   Budget request  — Team Leader › project budget agreed › Back Support ›
 *                     Cost Controller › Finance Checker › Finance Manager
 *   Reimbursement   — Team Leader › project budget agreed › Cost Controller ›
 *                     Finance Checker › Finance Manager
 *   Liquidation     — Team Leader › Accounting staff › Accounting Manager ›
 *                     Finance Manager
 *   Cash advance    — Team Leader › Cost Controller › Finance Checker ›
 *                     Finance Manager
 *
 * No CEO / President step on any of them, whatever the amount; the travel
 * request keeps its route without the over-₱100,000 band.
 *
 * A LIQUIDATION is an expense claim (one table, one document type, one
 * approval panel), so its route is the second `expense` workflow, told apart
 * by its `optionLabel` — the warehouse stock request's pattern
 * (shared/stockRequestRoute.ts): `pickWorkflow` never picks it unasked, the
 * submit passes it for a claim naming an advance or a budget request. With it
 * switched off or its label changed, a liquidation takes the reimbursement
 * route rather than stalling.
 */
export const LIQUIDATION_OPTION = 'Liquidation';

/** The route a claim takes: the liquidation's for one that accounts for released cash, else the standard (null). */
export async function claimRouteOption(claim: { advanceId?: string | null; budgetRequestId?: string | null } | { liquidation: boolean }): Promise<string | null> {
  const liquidation = 'liquidation' in claim ? claim.liquidation : !!(claim.advanceId || claim.budgetRequestId);
  if (!liquidation) return null;
  const workflow = await prisma.approvalWorkflow.findFirst({
    where: { documentType: 'expense', isActive: true, optionLabel: LIQUIDATION_OPTION },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return workflow?.id ?? null;
}

/**
 * "Erwen" on the owner's routes is one person, and the Finance Clerk role has
 * two holders, so the step is a role of its own: Finance Checker, given ONCE
 * to the login named Erwen … Cabal (`MONEY_ROUTES_MARK`). Admin › Users moves
 * it to whoever checks after that.
 *
 * The role is made at the END of the seed — on a fresh install the chart's
 * replacement deletes every role it does not list — so a route seeded before
 * it existed has a step with no role; that step (named `FINANCE_CHECKER_STEP`)
 * is pointed at the role on every deploy.
 */
export const FINANCE_CHECKER_ROLE = 'finance_checker';
export const FINANCE_CHECKER_STEP = 'Finance Checker';
export const MONEY_ROUTES_MARK = 'seed.moneyRoutes20261126';

export async function applyMoneyRoutes(): Promise<{ created: boolean; given: string | null; steps: number }> {
  let role = await prisma.role.findUnique({ where: { key: FINANCE_CHECKER_ROLE }, select: { id: true } });
  const created = !role;
  if (!role) {
    role = await prisma.role.create({
      data: {
        key: FINANCE_CHECKER_ROLE,
        name: 'Finance Checker',
        description: 'Checks budget requests, reimbursements and cash advances after the Cost Controller, before the Finance Manager',
        rank: 4,
        isSystem: false,
      },
      select: { id: true },
    });
  }
  const { count: steps } = await prisma.approvalStep.updateMany({
    where: { approverType: 'ROLE', roleId: null, name: FINANCE_CHECKER_STEP },
    data: { roleId: role.id },
  });

  let given: string | null = null;
  if (!(await prisma.setting.findUnique({ where: { key: MONEY_ROUTES_MARK } }))) {
    const erwen = await prisma.user.findFirst({
      where: { isActive: true, name: { contains: 'erwen', mode: 'insensitive' }, AND: { name: { contains: 'cabal', mode: 'insensitive' } } },
      select: { id: true, name: true },
    });
    if (erwen) {
      await prisma.userRole.createMany({ data: [{ userId: erwen.id, roleId: role.id }], skipDuplicates: true });
      given = erwen.name;
      await audit({
        entityType: 'user',
        entityId: erwen.id,
        action: 'UPDATED',
        summary: `${erwen.name} given the Finance Checker role — the "Erwen" step of the money routes of 2026-11-26`,
      });
    }
    await prisma.setting.create({ data: { key: MONEY_ROUTES_MARK, value: { at: new Date().toISOString(), given } } });
  }
  return { created, given, steps };
}

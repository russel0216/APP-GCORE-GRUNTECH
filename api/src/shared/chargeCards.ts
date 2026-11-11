import { prisma } from '../prisma';
import { chargeAgainstBudget, type ChargeBasis } from './projectBudget';
import { chargeAgainstOffice } from './officeBudget';
import { chargeGroups, linesAsCharges, type LineCharge } from './lineCharges';
import { requestGroups } from './budgetRequestCharges';

/**
 * "Against the budgets" for a document charged line by line (2026-11-11): one
 * card per place its lines land — a project's budget line (Budget Monitoring's
 * own figures) or an office line — each in the one-place card's shape
 * (`chargeAgainstBudget()` / `chargeAgainstOffice()`), so the page and the
 * paper draw every block alike. `title` names the place.
 */
export interface PlaceCard {
  title: string;
  budget: NonNullable<Awaited<ReturnType<typeof chargeAgainstOffice>>> | Awaited<ReturnType<typeof chargeAgainstBudget>>;
}

async function cardsFor(
  groups: { charge: LineCharge; amount: number }[],
  basis: ChargeBasis,
  own: { expenseClaimId?: string; budgetRequestId?: string },
  exclude?: { sourceType: string; sourceId: string },
): Promise<PlaceCard[]> {
  const jobIds = [...new Set(groups.map((g) => g.charge.jobId).filter((id): id is string => !!id))];
  const jobs = jobIds.length ? await prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, number: true, name: true } }) : [];
  const out: PlaceCard[] = [];
  for (const g of groups) {
    if (g.charge.officeBudgetLineId) {
      const card = await chargeAgainstOffice({ lineId: g.charge.officeBudgetLineId, amount: g.amount, basis, own });
      if (card) out.push({ title: `Office · ${card.office.name} · ${card.line.name}`, budget: card });
    } else if (g.charge.jobId && g.charge.costCategoryId) {
      const card = await chargeAgainstBudget({ jobId: g.charge.jobId, costCategoryId: g.charge.costCategoryId, amount: g.amount, basis, exclude, own });
      const job = jobs.find((j) => j.id === g.charge.jobId);
      out.push({ title: `${job?.number ?? 'Project'} — ${job?.name ?? ''} · ${card.line?.name ?? 'budget line'}`, budget: card });
    }
  }
  return out;
}

/** A split claim's places: its receipts' amounts per place, until approved; then each place as it stands. */
export async function claimCards(claim: { id: string; split: boolean; status: string; jobId: string | null; costCategoryId: string | null; officeBudgetLineId: string | null }): Promise<PlaceCard[]> {
  if (!claim.split) return [];
  const lines = await prisma.expenseClaimLine.findMany({ where: { claimId: claim.id }, orderBy: { sortOrder: 'asc' } });
  const posted = ['APPROVED', 'REIMBURSED', 'SETTLED'].includes(claim.status);
  const closed = ['REJECTED', 'CANCELLED'].includes(claim.status);
  return cardsFor(
    chargeGroups(linesAsCharges(claim, lines)),
    posted ? 'settled' : closed ? 'closed' : 'asked',
    { expenseClaimId: claim.id },
    { sourceType: 'expense_claim', sourceId: claim.id },
  );
}

/** A split budget request's places: what each item group asks, then the cash out by share once released. */
export async function requestCards(request: { id: string; split: boolean; status: string; amount: unknown; amountReleased: unknown; amountRefunded: unknown }): Promise<PlaceCard[]> {
  if (!request.split) return [];
  const settled = ['LIQUIDATED', 'REJECTED', 'CANCELLED'].includes(request.status);
  const out = ['RELEASED', 'REFUND_DUE'].includes(request.status);
  const groups = await requestGroups(request.id);
  const asked = Number(request.amount);
  const cash = Math.max(0, Number(request.amountReleased) - Number(request.amountRefunded));
  const scaled = out && asked > 0 ? groups.map((g) => ({ ...g, amount: Math.round(((cash * g.amount) / asked) * 100) / 100 })) : groups;
  return cardsFor(
    scaled,
    settled ? (['REJECTED', 'CANCELLED'].includes(request.status) ? 'closed' : 'settled') : out ? 'released' : 'asked',
    { budgetRequestId: request.id },
    { sourceType: 'budget_request', sourceId: request.id },
  );
}

/** The approvers' bell: each place and what is left after, in a few words. */
export function cardsPosition(cards: PlaceCard[], money: (n: number) => string): string {
  return cards
    .map((c) => `${c.title.split(' · ').slice(-1)[0]} ${c.budget.over ? `over by ${money(c.budget.overBy)}` : `${money(c.budget.availableAfter)} left`}`)
    .join('; ');
}

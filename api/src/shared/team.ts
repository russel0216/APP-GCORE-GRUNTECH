import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * "My team" (2026-10-08, the owner's call — SCORO's team view on the list
 * of quotes): the people whose employee record carries the same Team as
 * the viewer's. The Team IS `Employee.industryId` — the Industry row HR sets
 * on the employee form (see "Accounts and sign-in") — so a team is never a
 * second list to keep. A login with no employee record, or an employee with
 * no team, has none: the Team view is then not offered, and a `?scope=team`
 * link falls back to Mine on the server.
 */
export interface Team {
  id: string;
  code: string;
  name: string;
}

export async function teamOf(userId: string): Promise<Team | null> {
  const row = await prisma.employee.findUnique({
    where: { userId },
    select: { industry: { select: { id: true, code: true, name: true } } },
  });
  return row?.industry ?? null;
}

/** The users on a team, as a where-clause on a User relation (`owner`, `assignedTo`). */
export function teamMembers(teamId: string): Prisma.UserWhereInput {
  return { employee: { industryId: teamId } };
}

/**
 * The owner's five sales teams (2026-10-08) — the seeded Industry rows:
 * system rows, undeletable, renamable, never recoded (the quotation list's
 * "Quotes by team" and the Team view key on them).
 */
export const TEAMS = [
  { code: 'KAT', name: 'Key Account Team' },
  { code: 'HIT', name: 'Healthcare Industry Team' },
  { code: 'UIT', name: 'Utility Industry Team' },
  { code: 'GIB', name: 'General Industry & Building Team' },
  { code: 'SIT', name: 'Special Industry Team' },
] as const;

/**
 * The five industries that came before the teams (HI, BI, UI, GI, SI) were
 * the teams' first names. Once, on the deploy that brings the teams, the
 * people on them (and the customers still carrying one) move to the team
 * that took the industry over — Healthcare → HIT, Utility → UIT, General
 * and Building → GIB, Special → SIT — and the old rows are switched off,
 * never deleted: a row is history, and audit rows still name it. Done once:
 * the `seed.teamsMigrated` setting marks it, so an administrator who turns
 * an old row back on is left alone by the next deploy.
 */
export const FIRST_INDUSTRY_SUCCESSOR: Record<string, string> = { HI: 'HIT', BI: 'GIB', UI: 'UIT', GI: 'GIB', SI: 'SIT' };

export async function retireFirstIndustries(): Promise<{ moved: number; retired: number } | null> {
  const KEY = 'seed.teamsMigrated';
  if (await prisma.setting.findUnique({ where: { key: KEY } })) return null;
  let moved = 0;
  let retired = 0;
  for (const [oldCode, newCode] of Object.entries(FIRST_INDUSTRY_SUCCESSOR)) {
    const old = await prisma.industry.findUnique({ where: { code: oldCode } });
    const next = await prisma.industry.findUnique({ where: { code: newCode } });
    if (!old || !next || old.id === next.id) continue;
    const people = await prisma.employee.updateMany({ where: { industryId: old.id }, data: { industryId: next.id } });
    const customers = await prisma.customer.updateMany({ where: { industryId: old.id }, data: { industryId: next.id } });
    moved += people.count + customers.count;
    if (old.isActive) {
      // Switched off, and sorted under the teams so Admin › Categories lists the five live ones first.
      await prisma.industry.update({ where: { id: old.id }, data: { isActive: false, sortOrder: 90 + retired } });
      retired++;
    }
  }
  await prisma.setting.upsert({
    where: { key: KEY },
    create: {
      key: KEY,
      value: { at: new Date().toISOString(), moved, retired },
      description: 'The first five industries (HI, BI, UI, GI, SI) were retired in favour of the teams; set once so a row an administrator turns back on stays on.',
    },
    update: {},
  });
  return { moved, retired };
}

// ── A set split by team (2026-10-09, the owner's call: "separate card by team") ──

/** One team's share of a listed set — a card on the quotation, lead and sales order lists. */
export interface TeamShare {
  /** null for the rows whose owner has no team. */
  id: string | null;
  code: string;
  name: string;
  count: number;
  value: number;
}

/** The team a row's owner is on, as the summaries select it. */
export type TeamRef = { id: string; code: string; name: string } | null;

/** The select that brings an owner's team along with a row. */
export const OWNER_TEAM_SELECT = { select: { employee: { select: { industry: { select: { id: true, code: true, name: true } } } } } } as const;

/**
 * Splits a listed set by its owners' teams — every active team in the
 * master's order even at zero, a team since switched off as it is met,
 * "No team" last while any owner has none. Exact in cents; the shares add
 * up to the whole. The one rule for the quotation, lead and sales order
 * lists' team cards.
 */
export async function teamShares(rows: { team: TeamRef; cents: number }[]): Promise<TeamShare[]> {
  const teamList = await prisma.industry.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    select: { id: true, code: true, name: true },
  });
  const byTeam = new Map<string, { id: string | null; code: string; name: string; count: number; cents: number }>();
  for (const t of teamList) byTeam.set(t.id, { id: t.id, code: t.code, name: t.name, count: 0, cents: 0 });
  const noTeam = { id: null, code: '—', name: 'No team', count: 0, cents: 0 };
  for (const r of rows) {
    let row = r.team ? byTeam.get(r.team.id) : noTeam;
    if (!row) {
      row = { id: r.team!.id, code: r.team!.code, name: r.team!.name, count: 0, cents: 0 };
      byTeam.set(r.team!.id, row);
    }
    row.count++;
    row.cents += r.cents;
  }
  return [...byTeam.values(), ...(noTeam.count ? [noTeam] : [])].map((t) => ({ id: t.id, code: t.code, name: t.name, count: t.count, value: t.cents / 100 }));
}

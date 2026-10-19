import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import type { ResolvedUser } from '../permissions/resolve';
import { editScope, viewScope } from './ownScope';

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
 * A QUOTATION's team (2026-10-12, the owner's call: "on SCORO import allow
 * me to select which team it goes"): the team it was tagged with, else its
 * owner's. The Team view, the team cards and the Forecast all read it
 * through these two, so a tagged quotation is counted under its tag
 * everywhere and nowhere under its owner's team.
 */
export function quotationTeamWhere(teamId: string): Prisma.QuotationWhereInput {
  return { OR: [{ teamId }, { teamId: null, owner: teamMembers(teamId) }] };
}

/** The tag if there is one, else the owner's team — `team` and `owner` as QUOTATION_TEAM_SELECT brings them. */
export function quotationTeamOf(row: { team: TeamRef; owner: { employee: { industry: TeamRef } | null } }): TeamRef {
  return row.team ?? row.owner.employee?.industry ?? null;
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

/** A team as a row's relation brings it. */
export const TEAM_REF_SELECT = { select: { id: true, code: true, name: true } } as const;

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

/**
 * Quotations raised before the team was stored on the quotation (2026-10-12,
 * the owner's call: "set the team of old quotations to the author's team")
 * take their author's team, so each keeps the team it counts under now even
 * when its author later moves. Only a quotation with NO team is filled, and
 * only from an author who has one — a team picked on a quotation, or the
 * SCORO import's tag, is never touched. Run by the seed on every deploy, so
 * an author given a team later has their untagged quotations filled then; a
 * second run with nothing new fills none. One audit row per team filled.
 */
export async function fillQuotationTeams(): Promise<number> {
  const teams = await prisma.industry.findMany({ select: { id: true, code: true } });
  let filled = 0;
  for (const team of teams) {
    const where: Prisma.QuotationWhereInput = { teamId: null, owner: teamMembers(team.id) };
    const ids = (await prisma.quotation.findMany({ where, select: { id: true } })).map((q) => q.id);
    if (!ids.length) continue;
    // Claimed on teamId still null, so a team picked meanwhile is kept.
    const done = await prisma.quotation.updateMany({ where: { id: { in: ids }, teamId: null }, data: { teamId: team.id } });
    if (!done.count) continue;
    filled += done.count;
    await prisma.auditLog.create({
      data: {
        entityType: 'quotation',
        entityId: 'list',
        action: 'UPDATED',
        summary: `Set the team of ${done.count} older quotation(s) to their author's team ${team.code}`,
        after: { teamId: team.id, quotationIds: ids },
      },
    });
  }
  return filled;
}

/**
 * A person's TEAM (the money-out registers' Team column: budget requests,
 * reimbursements, cash advances). It read "team, else department" from
 * 2026-10-15 until departments were retired (2026-10-19, the owner's call:
 * "remove the department"); someone with no team now reads as none. Select it
 * on a User relation, read it with `teamOfUser()`.
 */
export const USER_TEAM_SELECT = {
  select: {
    employee: { select: { industry: { select: { id: true, code: true, name: true } } } },
  },
} as const;

export function teamOfUser(
  user: { employee: { industry: { id: string; code: string; name: string } | null } | null } | null | undefined,
): { label: string; title: string; teamId: string | null } | null {
  const team = user?.employee?.industry;
  return team ? { label: team.code, title: team.name, teamId: team.id } : null;
}

/** "This person is on that team" as a where-clause on a User relation; `none` is nobody's team. */
export function userTeamWhere(teamId: string): Prisma.UserWhereInput {
  return teamId === 'none' ? { OR: [{ employee: null }, { employee: { industryId: null } }] } : { employee: { industryId: teamId } };
}

/**
 * Does this login report to that one ("Reports to", one level)? View Own on a
 * request register covers one's direct reports' requests (2026-10-19).
 */
export async function reportsTo(userId: string, supervisorId: string): Promise<boolean> {
  if (userId === supervisorId) return false;
  return !!(await prisma.user.findFirst({ where: { id: userId, supervisorId }, select: { id: true } }));
}

/**
 * Whose records a caller reads on a screen they cannot read all of
 * (2026-10-19, the permission matrix): View Team reads the team's logins
 * (`me.teamMemberIds`, themselves included), View Own their own. Use it as
 * `{ ownerId: { in: visibleOwners(me, 'gops', 'quotations') } }` where the
 * list narrowed to `ownerId: me.id` before.
 */
export function visibleOwners(me: ResolvedUser, m: string, s: string): string[] {
  return viewScope(me, m, s) === 'team' ? me.teamMemberIds : [me.id];
}

/** Whose records a caller may change on a screen they cannot manage all of: Manage Team the team's, else their own. */
export function editableOwners(me: ResolvedUser, m: string, s: string): string[] {
  return editScope(me, m, s) === 'team' ? me.teamMemberIds : [me.id];
}

/**
 * The quotations a caller reads without View All (2026-10-19, the matrix):
 * View Team the team's — tagged with it, else owned on it (`quotationTeamWhere`,
 * the Team view's own rule) — and their own; View Own their own. Null for View All.
 */
export function quotationsReadable(me: ResolvedUser): Prisma.QuotationWhereInput | null {
  const scope = viewScope(me, 'gops', 'quotations');
  if (scope === 'all') return null;
  if (scope === 'team' && me.teamId) return { OR: [{ ownerId: me.id }, quotationTeamWhere(me.teamId)] };
  return { ownerId: me.id };
}

/** A quotation's single-record read without View All: its owner, or — View Team — one of the team's. */
export function readsQuotation(me: ResolvedUser, q: { ownerId: string; teamId?: string | null }): boolean {
  const scope = viewScope(me, 'gops', 'quotations');
  if (scope === 'all' || q.ownerId === me.id) return true;
  return scope === 'team' && (q.teamId ? q.teamId === me.teamId : me.teamMemberIds.includes(q.ownerId));
}

/**
 * The sales orders a caller reads without View All: their own, and — View
 * Team — those booked on a quotation of their team (an order counts under
 * its QUOTATION's team, 2026-10-12). Null for View All.
 */
export function salesOrdersReadable(me: ResolvedUser): Prisma.SalesOrderWhereInput | null {
  const scope = viewScope(me, 'gops', 'sales_orders');
  if (scope === 'all') return null;
  if (scope === 'team' && me.teamId) return { OR: [{ ownerId: me.id }, { quotation: quotationTeamWhere(me.teamId) }] };
  return { ownerId: me.id };
}

/** A sales order's single-record read without View All: its author, or — View Team — one on the team's quotation. */
export function readsSalesOrder(
  me: ResolvedUser,
  o: { ownerId: string; quotation?: { ownerId: string; teamId: string | null } | null },
): boolean {
  const scope = viewScope(me, 'gops', 'sales_orders');
  if (scope === 'all' || o.ownerId === me.id) return true;
  if (scope !== 'team' || !me.teamId) return false;
  const q = o.quotation;
  if (!q) return me.teamMemberIds.includes(o.ownerId);
  return q.teamId ? q.teamId === me.teamId : me.teamMemberIds.includes(q.ownerId);
}

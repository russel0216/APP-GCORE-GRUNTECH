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

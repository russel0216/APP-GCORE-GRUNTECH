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

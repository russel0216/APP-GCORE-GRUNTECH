import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { audit } from './audit';
import { nextNumber } from './numbering';

/**
 * The owner's ROLE_REV1 (2026-10-19): the organisation chart's roles, each
 * with its LEVEL. A person holds up to six roles (`MAX_ROLES`); their title on
 * documents is the highest one (`titleFromRoles`). Applied once by the seed
 * (`applyRoleRev1`, marked `ROLE_REV1_MARK`):
 *
 * - every role below renamed in place where its key is on file (holders,
 *   rights and approval steps kept) or made, with its rank and chart order;
 * - a NEW role takes the rights of the role named in `copyFrom` (Warehouse
 *   Staff the Warehouse Supervisor's, Credit and Collection the Account
 *   Payable Officer's …) — the owner trims them on Admin › Roles;
 * - the roles the chart drops (Welder, Electrician, Collection) hand their
 *   holders and steps to `SUCCESSOR_REV1` and are deleted;
 * - the "Checking" steps (reimbursement, cash advance) are decided by the
 *   Account Payable Officer OR the Credit and Collection Officer (the owner:
 *   "both check");
 * - every role gets a Plantilla slot it counts (`Position.roleId`), the
 *   authorised headcount starting at its holders;
 * - every person's title is worked out from their roles.
 */
export const ROLE_REV1_MARK = 'seed.roleRev1_20261019';

/** A person holds this many roles at most (the owner's call, 2026-10-19). */
export const MAX_ROLES = 6;

export interface ChartRole {
  key: string;
  name: string;
  rank: number;
  /** A role this one is new beside, whose rights it starts with. */
  copyFrom?: string;
}

/** ROLE_REV1, in the chart's order. Rank 1 is the CEO, 6 the skilled trades. */
export const ROLE_REV1: ChartRole[] = [
  { key: 'ceo', name: 'CEO / President', rank: 1 },
  // Industry teams (SIT, HIT, GIB, UIT, KAT)
  { key: 'team_leader', name: 'Team Leader', rank: 2 },
  { key: 'technical_manager', name: 'Technical Manager', rank: 3 },
  { key: 'sales_manager', name: 'Sales Manager', rank: 3 },
  { key: 'service_manager', name: 'Aftermarket Manager', rank: 3 },
  { key: 'project_engineer', name: 'Project Engineer', rank: 4 },
  { key: 'industry_specialist', name: 'Sales Engineer', rank: 4 },
  { key: 'service_engineer', name: 'Service Engineer', rank: 4 },
  { key: 'project_lead', name: 'Project Lead', rank: 5 },
  { key: 'service_technician', name: 'Technician', rank: 5 },
  { key: 'project_support', name: 'Project Support', rank: 6 },
  // Supply Chain — the Warehouse Supervisor handles Local and Import alike
  { key: 'purchasing_manager', name: 'Purchasing Manager (Local)', rank: 2 },
  { key: 'purchasing_manager_import', name: 'Purchasing Manager (Import)', rank: 2 },
  { key: 'local_purchaser', name: 'Local Purchaser', rank: 3, copyFrom: 'back_support' },
  { key: 'import_purchaser', name: 'Import Purchaser', rank: 3, copyFrom: 'back_support' },
  { key: 'warehouse_supervisor', name: 'Warehouse Supervisor', rank: 3 },
  { key: 'back_support', name: 'Back Support', rank: 4 },
  { key: 'warehouse_staff', name: 'Warehouse Staff', rank: 4, copyFrom: 'warehouse_supervisor' },
  // Finance
  { key: 'finance_manager', name: 'Finance Manager', rank: 2 },
  { key: 'credit_collection', name: 'Credit and Collection Officer', rank: 3, copyFrom: 'finance' },
  { key: 'finance', name: 'Account Payable Officer', rank: 3 },
  { key: 'cost_controller', name: 'Cost Controller', rank: 3 },
  { key: 'finance_clerk', name: 'Finance Clerk', rank: 4 },
  { key: 'liaison_officer', name: 'Liaison Officer', rank: 4, copyFrom: 'finance_clerk' },
  // Accounting
  { key: 'accounting', name: 'Accounting Manager', rank: 2 },
  { key: 'accounting_officer', name: 'Accountant', rank: 3 },
  { key: 'accounting_clerk', name: 'Accounting Clerk', rank: 4 },
  // Human Resources
  { key: 'hr_manager', name: 'HR Manager', rank: 2, copyFrom: 'hr' },
  { key: 'hr', name: 'HR Officer', rank: 3 },
  { key: 'hr_clerk', name: 'HR Clerk', rank: 4, copyFrom: 'accounting_clerk' },
  // Office Management
  { key: 'office_manager', name: 'Office Manager', rank: 2, copyFrom: 'accounting_officer' },
  { key: 'office_admin', name: 'Admin', rank: 3, copyFrom: 'accounting_clerk' },
  { key: 'admin_staff', name: 'Admin Staff', rank: 4, copyFrom: 'accounting_clerk' },
  // Marketing
  { key: 'marketing', name: 'Marketing Manager', rank: 2 },
  { key: 'marketing_officer', name: 'Marketing Officer', rank: 3, copyFrom: 'marketing_assistant' },
  { key: 'marketing_assistant', name: 'Marketing Assistant', rank: 4 },
  // Design
  { key: 'design_manager', name: 'Design Manager', rank: 2, copyFrom: 'designer_lead' },
  { key: 'designer_lead', name: 'Design Supervisor', rank: 3 },
  { key: 'designer', name: 'Design Specialist', rank: 4 },
];

/** Roles the chart drops, and who takes their holders and steps. */
export const SUCCESSOR_REV1: Record<string, string> = {
  welder: 'project_support',
  electrician: 'project_support',
  collection: 'credit_collection',
};

/** The "Checking" step decided by either finance role (the owner: "both check"). */
export const CHECKING_ROLES = ['finance', 'credit_collection'];

type Ranked = { name: string; rank: number | null; sortOrder: number };

/** A person's title: their highest role — the lowest rank, then the chart's order. Null with no ranked role. */
export function titleFromRoles(roles: Ranked[]): string | null {
  const ranked = roles.filter((r) => r.rank != null);
  if (!ranked.length) return null;
  ranked.sort((a, b) => a.rank! - b.rank! || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  // Every role at the highest level, joined (2026-10-19, the owner's call:
  // Dina's Finance Manager and Purchasing Manager (Local) both show).
  const top = ranked.filter((r) => r.rank === ranked[0].rank).map((r) => r.name);
  return [...new Set(top)].join(' / ');
}

export async function roleRev1Done(): Promise<boolean> {
  return !!(await prisma.setting.findUnique({ where: { key: ROLE_REV1_MARK } }));
}

export async function applyRoleRev1(): Promise<{ created: string[]; renamed: string[]; deleted: string[]; positions: number; titles: number } | null> {
  if (await roleRev1Done()) return null;
  const result = { created: [] as string[], renamed: [] as string[], deleted: [] as string[], positions: 0, titles: 0 };

  await prisma.$transaction(
    async (tx) => {
      const before = await tx.role.findMany({ select: { id: true, key: true, name: true } });
      const byKey = new Map(before.map((r) => [r.key, r]));
      const idOf = new Map<string, string>();

      // 1. Rename in place or make, with rank and order; a new role takes its source's rights.
      for (const [i, r] of ROLE_REV1.entries()) {
        const had = byKey.get(r.key);
        const row = await tx.role.upsert({
          where: { key: r.key },
          create: { key: r.key, name: r.name, rank: r.rank, sortOrder: i + 1, isSystem: false, description: 'From ROLE_REV1 — its rights are set on Admin › Roles' },
          update: { name: r.name, rank: r.rank, sortOrder: i + 1 },
          select: { id: true },
        });
        idOf.set(r.key, row.id);
        if (!had) {
          result.created.push(r.name);
          const source = r.copyFrom ? byKey.get(r.copyFrom) : undefined;
          let copied = 0;
          if (source) {
            const perms = await tx.rolePermission.findMany({ where: { roleId: source.id }, select: { permissionId: true } });
            await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: row.id, permissionId: p.permissionId })), skipDuplicates: true });
            copied = perms.length;
          }
          await audit(
            {
              entityType: 'role',
              entityId: row.id,
              action: 'CREATED',
              summary: `Role "${r.name}" created from ROLE_REV1${source ? ` with ${source.name}'s ${copied} right(s)` : ''}`,
              after: { key: r.key, name: r.name, rank: r.rank },
            },
            undefined,
            tx,
          );
        } else if (had.name !== r.name) {
          result.renamed.push(`${had.name} → ${r.name}`);
          await audit(
            {
              entityType: 'role',
              entityId: row.id,
              action: 'UPDATED',
              summary: `Role ${had.name} is now "${r.name}" (ROLE_REV1, rank ${r.rank})`,
              before: { name: had.name },
              after: { name: r.name, rank: r.rank },
            },
            undefined,
            tx,
          );
        }
      }

      // 2. The dropped roles: holders and steps to the successor, then deleted.
      for (const [key, successorKey] of Object.entries(SUCCESSOR_REV1)) {
        const old = byKey.get(key);
        const successor = idOf.get(successorKey);
        if (!old || !successor) continue;
        const holders = await tx.userRole.findMany({ where: { roleId: old.id }, select: { userId: true } });
        await tx.userRole.createMany({ data: holders.map((h) => ({ userId: h.userId, roleId: successor })), skipDuplicates: true });
        await tx.approvalStep.updateMany({ where: { roleId: old.id }, data: { roleId: successor } });
        await tx.approvalWorkflow.updateMany({ where: { requesterRoleId: old.id }, data: { requesterRoleId: successor } });
        await tx.role.delete({ where: { id: old.id } });
        result.deleted.push(old.name);
        await audit(
          {
            entityType: 'role',
            entityId: old.id,
            action: 'DELETED',
            summary: `Role ${old.name} deleted (not on ROLE_REV1) — its ${holders.length} holder(s) and steps now ${ROLE_REV1.find((r) => r.key === successorKey)!.name}`,
            before: { key, name: old.name, holders: holders.length },
          },
          undefined,
          tx,
        );
      }

      // 3. "Checking" — the Account Payable Officer or the Credit and Collection Officer.
      const finance = idOf.get('finance');
      const credit = idOf.get('credit_collection');
      if (finance && credit) {
        const steps = await tx.approvalStep.findMany({
          where: { roleId: finance, approverType: 'ROLE', workflow: { documentType: { in: ['expense', 'cash_advance'] } } },
          select: { id: true, alsoRoleIds: true },
        });
        for (const s of steps) {
          if (s.alsoRoleIds.includes(credit)) continue;
          await tx.approvalStep.update({
            where: { id: s.id },
            data: { alsoRoleIds: [...s.alsoRoleIds, credit], name: 'Checking (Account Payable / Credit and Collection)' },
          });
        }
      }

      // 4. A Plantilla slot per role, matched to a position of that title or made.
      const roles = await tx.role.findMany({ select: { id: true, name: true, _count: { select: { users: true } } } });
      const positions = await tx.position.findMany({ select: { id: true, title: true, roleId: true } });
      for (const role of roles) {
        if (positions.some((p) => p.roleId === role.id)) continue;
        const same = positions.find((p) => !p.roleId && p.title.trim().toLowerCase() === role.name.toLowerCase());
        if (same) {
          await tx.position.update({ where: { id: same.id }, data: { roleId: role.id, isActive: true } });
          same.roleId = role.id;
        } else {
          await tx.position.create({
            data: {
              code: await nextNumber('position', tx),
              title: role.name,
              roleId: role.id,
              authorisedHeadcount: Math.max(1, role._count.users),
              description: 'Counts the holders of the role (ROLE_REV1)',
            },
          });
        }
        result.positions += 1;
      }

      await tx.setting.create({
        data: {
          key: ROLE_REV1_MARK,
          value: { at: new Date().toISOString(), created: result.created, renamed: result.renamed, deleted: result.deleted },
          description: 'seed: the roles of ROLE_REV1 applied once (2026-10-19) — ranks, renames, new roles, Plantilla by role',
        },
      });
    },
    { maxWait: 15_000, timeout: 120_000 },
  );

  // 5. Every person's title from their roles (outside the big transaction).
  const users = await prisma.user.findMany({ where: { roles: { some: {} } }, select: { id: true } });
  for (const u of users) if (await refreshUserTitle(prisma, u.id)) result.titles += 1;
  return result;
}

type Db = Prisma.TransactionClient;

/**
 * Writes a person's title — the highest of their roles — onto their login and
 * their employee record (`position`, the mirror every list, search and paper
 * reads). A person with no ranked role keeps what they have. True when it moved.
 */
export async function refreshUserTitle(db: Db, userId: string): Promise<boolean> {
  const rows = await db.userRole.findMany({
    where: { userId },
    select: { role: { select: { name: true, rank: true, sortOrder: true } } },
  });
  const title = titleFromRoles(rows.map((r) => r.role));
  if (!title) return false;
  const user = await db.user.findUnique({ where: { id: userId }, select: { position: true, employee: { select: { id: true, position: true } } } });
  if (!user) return false;
  let moved = false;
  if (user.position !== title) {
    await db.user.update({ where: { id: userId }, data: { position: title } });
    moved = true;
  }
  if (user.employee && user.employee.position !== title) {
    await db.employee.update({ where: { id: user.employee.id }, data: { position: title } });
    moved = true;
  }
  return moved;
}

/** A 400 message when a person would hold more than `MAX_ROLES`, else null. */
export function tooManyRoles(count: number, who?: string): string | null {
  return count > MAX_ROLES ? `${who ? `${who} ` : 'A person '}can hold ${MAX_ROLES} roles at most — ${count} were chosen` : null;
}

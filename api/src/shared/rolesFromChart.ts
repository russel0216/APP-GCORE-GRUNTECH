import { prisma } from '../prisma';
import { audit } from './audit';
import { ORG_CHART } from './orgChart';

/**
 * Every role replaced by the organisation chart's titles (2026-10-18, the
 * owner's call after the roles were emptied: "I cannot delete some roles —
 * delete all and create all from the list of roles I sent from the
 * organizational chart; I'll edit their access per role later"). Once,
 * marked `ROLES_FROM_CHART_MARK`, the seed's last step:
 *
 * - one role per title on the chart (`CHART_ROLES`), named as the chart
 *   names it, EMPTY of rights — the owner fills them on Admin › Roles;
 * - a title the approval engine reads by key keeps that key (Team Leader is
 *   `team_leader`, Purchasing Officer — the chart's Back Support — is
 *   `back_support`, Warehouse Officer is `warehouse_supervisor` …), so the
 *   47 routes keep their steps; the rows are renamed, never re-keyed;
 * - every other role is DELETED — Executive / Management, Employee,
 *   Supervisor, Sales, Project Manager, Trainer, Warehouse and any role made
 *   since — after the steps that named one are pointed at its successor
 *   (`SUCCESSOR`: Executive's at the CEO / President, the Project Manager's
 *   at the Technical Manager …) and "Prepared by" cleared where it named
 *   one with none;
 * - every role comes off every person, and each person with a login is
 *   given their chart titles' roles (by email, else by name). "Supports
 *   teams", "Reports to" and the overrides are the person's and stay.
 */
export const ROLES_FROM_CHART_MARK = 'seed.rolesFromChart20261018';

/** The chart's titles in its order, each with the key its role carries. */
export const CHART_ROLES: { title: string; key: string }[] = [
  { title: 'CEO / President', key: 'ceo' },
  { title: 'Team Leader', key: 'team_leader' },
  { title: 'Technical Manager', key: 'technical_manager' },
  { title: 'Sales Manager', key: 'sales_manager' },
  { title: 'Service Manager', key: 'service_manager' },
  { title: 'Sales Engineer', key: 'industry_specialist' },
  { title: 'Project Engineer', key: 'project_engineer' },
  { title: 'Project Lead', key: 'project_lead' },
  { title: 'Welder', key: 'welder' },
  { title: 'Electrician', key: 'electrician' },
  { title: 'Project Support', key: 'project_support' },
  { title: 'Service Engineer', key: 'service_engineer' },
  { title: 'Service Technician', key: 'service_technician' },
  { title: 'Purchasing Manager (Local)', key: 'purchasing_manager' },
  { title: 'Purchasing Manager (Importation)', key: 'purchasing_manager_import' },
  // The three Purchasing Officers ARE their teams' Back Support (the chart).
  { title: 'Purchasing Officer', key: 'back_support' },
  { title: 'Finance Manager', key: 'finance_manager' },
  { title: 'Finance Officer', key: 'finance' },
  { title: 'Finance Clerk', key: 'finance_clerk' },
  { title: 'Collection', key: 'collection' },
  { title: 'Warehouse Officer', key: 'warehouse_supervisor' },
  { title: 'Accounting Manager', key: 'accounting' },
  { title: 'Accounting Officer', key: 'accounting_officer' },
  { title: 'Accounting Clerk', key: 'accounting_clerk' },
  { title: 'Marketing Manager', key: 'marketing' },
  { title: 'Marketing Assistant', key: 'marketing_assistant' },
  { title: 'Human Resources Officer', key: 'hr' },
  { title: 'CAD Supervisor', key: 'designer_lead' },
  { title: 'CAD Operator', key: 'designer' },
  { title: 'Cost Controller', key: 'cost_controller' },
];

/** Where an approval step naming a role that goes is pointed instead. */
export const SUCCESSOR: Record<string, string> = {
  executive: 'ceo',
  project_manager: 'technical_manager',
  procurement: 'back_support',
  warehouse: 'warehouse_supervisor',
  sales: 'industry_specialist',
  supervisor: 'team_leader',
};

const DESCRIPTION = 'From the organisation chart — its rights are set on Admin › Roles';
const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export async function rolesFromChartDone(): Promise<boolean> {
  return !!(await prisma.setting.findUnique({ where: { key: ROLES_FROM_CHART_MARK } }));
}

export async function replaceRolesWithChart(): Promise<{ deleted: string[]; created: string[]; renamed: string[]; assigned: number; noLogin: string[] } | null> {
  if (await rolesFromChartDone()) return null;
  const titleOf = new Map(CHART_ROLES.map((r) => [r.key, r.title]));
  const result = { deleted: [] as string[], created: [] as string[], renamed: [] as string[], assigned: 0, noLogin: [] as string[] };

  await prisma.$transaction(
    async (tx) => {
      const before = await tx.role.findMany({
        select: { id: true, key: true, name: true, _count: { select: { permissions: true, users: true } } },
      });

      // 1. The chart's roles: renamed in place where the key is on file, else made.
      const idOf = new Map<string, string>();
      for (const { title, key } of CHART_ROLES) {
        const had = before.find((r) => r.key === key);
        const row = await tx.role.upsert({
          where: { key },
          create: { key, name: title, description: DESCRIPTION, isSystem: false },
          update: { name: title, description: DESCRIPTION, isSystem: false },
          select: { id: true },
        });
        idOf.set(key, row.id);
        if (!had) result.created.push(title);
        else if (had.name !== title) result.renamed.push(`${had.name} → ${title}`);
        await audit(
          {
            entityType: 'role',
            entityId: row.id,
            action: had ? 'UPDATED' : 'CREATED',
            summary: had
              ? `Role ${had.name} is now "${title}" from the organisation chart, emptied for its rights to be set`
              : `Role "${title}" created from the organisation chart, empty for its rights to be set`,
            before: had ? { name: had.name, permissions: had._count.permissions, holders: had._count.users } : null,
            after: { key, name: title, permissions: 0 },
          },
          undefined,
          tx,
        );
      }

      // 2. Every role that goes: its steps pointed at the successor first.
      const doomed = before.filter((r) => !titleOf.has(r.key));
      const doomedIds = new Set(doomed.map((r) => r.id));
      for (const r of doomed) {
        const successor = SUCCESSOR[r.key] ? (idOf.get(SUCCESSOR[r.key]) ?? null) : null;
        await tx.approvalStep.updateMany({ where: { roleId: r.id }, data: { roleId: successor } });
        await tx.approvalWorkflow.updateMany({ where: { requesterRoleId: r.id }, data: { requesterRoleId: successor } });
      }
      const alsoSteps = await tx.approvalStep.findMany({ where: { alsoRoleIds: { isEmpty: false } }, select: { id: true, alsoRoleIds: true } });
      for (const s of alsoSteps) {
        const next = [
          ...new Set(
            s.alsoRoleIds
              .map((id) => {
                if (!doomedIds.has(id)) return id;
                const key = doomed.find((d) => d.id === id)!.key;
                return SUCCESSOR[key] ? idOf.get(SUCCESSOR[key]) : undefined;
              })
              .filter((id): id is string => !!id),
          ),
        ];
        if (next.join() !== s.alsoRoleIds.join()) await tx.approvalStep.update({ where: { id: s.id }, data: { alsoRoleIds: next } });
      }

      // 3. Nobody holds anything; no role has a right.
      await tx.userRole.deleteMany({});
      await tx.rolePermission.deleteMany({});
      for (const r of doomed) {
        await tx.role.delete({ where: { id: r.id } });
        result.deleted.push(r.name);
        await audit(
          {
            entityType: 'role',
            entityId: r.id,
            action: 'DELETED',
            summary: `Role ${r.name} deleted — replaced by the organisation chart's roles${SUCCESSOR[r.key] ? `; its approval steps now go to ${titleOf.get(SUCCESSOR[r.key])}` : ''}`,
            before: { key: r.key, name: r.name, permissions: r._count.permissions, holders: r._count.users },
            after: null,
          },
          undefined,
          tx,
        );
      }

      // 4. Each person with a login takes their titles' roles.
      const users = await tx.user.findMany({ select: { id: true, email: true, name: true } });
      const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
      const byName = new Map(users.map((u) => [fold(u.name), u]));
      const keyOf = new Map(CHART_ROLES.map((r) => [r.title, r.key]));
      for (const p of ORG_CHART) {
        const user = (p.email && byEmail.get(p.email.toLowerCase())) || byName.get(fold(p.name));
        if (!user) {
          result.noLogin.push(p.name);
          continue;
        }
        const ids = [...new Set(p.titles.map((t) => idOf.get(keyOf.get(t)!)).filter((id): id is string => !!id))];
        if (!ids.length) continue;
        await tx.userRole.createMany({ data: ids.map((roleId) => ({ userId: user.id, roleId })), skipDuplicates: true });
        result.assigned += 1;
        await audit(
          {
            entityType: 'user',
            entityId: user.id,
            action: 'UPDATED',
            summary: `Roles from the organisation chart: ${p.titles.join(', ')}`,
            after: { roleIds: ids },
          },
          undefined,
          tx,
        );
      }

      await tx.setting.create({
        data: {
          key: ROLES_FROM_CHART_MARK,
          value: { at: new Date().toISOString(), deleted: result.deleted, created: result.created, renamed: result.renamed, assigned: result.assigned },
          description: "seed: every role was replaced once (2026-10-18) by one per title on the organisation chart, empty of rights",
        },
      });
    },
    { maxWait: 15_000, timeout: 120_000 },
  );
  return result;
}

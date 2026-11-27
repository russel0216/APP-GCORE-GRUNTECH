/**
 * Dumps who may do what, and where each document goes for approval, as ONE
 * JSON file — the people, their roles, each role's level on every screen of
 * the registry, and every approval route with who holds each step today.
 *
 *   npx tsx scripts/access-report.ts [out.json]     → data/access-report.json
 *
 * Read-only: it writes nothing to the database. Safe on the live server.
 * No password, token or pay data is read.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { prisma } from '../src/prisma';
import { REGISTRY } from '../src/permissions/registry';
import { levelsOf, levelOptions } from '../src/shared/permissionLevels';

async function main() {
  const out = resolve(process.argv[2] ?? 'data/access-report.json');

  const roles = await prisma.role.findMany({
    orderBy: [{ rank: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      permissions: { include: { permission: { select: { key: true } } } },
      reportsToRole: { select: { name: true } },
    },
  });
  const roleById = new Map(roles.map((r) => [r.id, r]));

  const users = await prisma.user.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      email: true,
      isActive: true,
      isSuperAdmin: true,
      invitePending: true,
      position: true,
      supervisor: { select: { name: true, isActive: true } },
      roles: { select: { role: { select: { id: true, key: true, name: true, rank: true, sortOrder: true } } } },
      supportTeams: { select: { industry: { select: { code: true } } } },
      employee: { select: { employeeNo: true, position: true, isActive: true, industry: { select: { code: true } } } },
    },
  });
  const employeesAlone = await prisma.employee.findMany({
    where: { userId: null },
    orderBy: { lastName: 'asc' },
    select: { employeeNo: true, firstName: true, lastName: true, position: true, isActive: true, industry: { select: { code: true } } },
  });

  const teams = await prisma.industry.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, code: true, name: true } });
  const teamById = new Map(teams.map((t) => [t.id, t.code]));
  const userById = new Map(users.map((u) => [u.id, u.name]));
  const teamPosts = await prisma.teamPost.findMany();

  const workflows = await prisma.approvalWorkflow.findMany({
    orderBy: [{ documentType: 'asc' }, { isActive: 'desc' }, { minAmount: 'asc' }, { name: 'asc' }],
    include: {
      requesterRole: { select: { name: true } },
      steps: { orderBy: { sequence: 'asc' }, include: { role: { select: { key: true, name: true } }, user: { select: { name: true, isActive: true } } } },
    },
  });
  const pending = await prisma.approvalRequest.groupBy({ by: ['workflowId'], where: { status: 'PENDING' }, _count: true });
  const pendingBy = new Map(pending.map((p) => [p.workflowId, p._count]));

  /** Active holders of a role, each with their team. */
  const holders = (roleKey: string) =>
    users
      .filter((u) => u.isActive && u.roles.some((r) => r.role.key === roleKey))
      .map((u) => `${u.name}${u.employee?.industry?.code ? ` (${u.employee.industry.code})` : ''}`);

  const screens = REGISTRY.flatMap((m) =>
    m.submodules.map((s) => ({
      module: m.label,
      moduleKey: m.key,
      group: s.group ?? '',
      key: `${m.key}.${s.key}`,
      label: s.label,
      path: s.path,
      hidden: !!s.hidden,
      caption: s.caption ?? '',
      own: s.own ?? '',
      actions: s.actions,
      options: levelOptions(s.actions),
    })),
  );

  const report = {
    exportedAt: new Date().toISOString(),
    teams,
    screens,
    roles: roles.map((r) => {
      const held = new Set(r.permissions.map((p) => p.permission.key));
      const levels: Record<string, { view: string; manage: string }> = {};
      for (const s of screens) {
        const mine = new Set(s.actions.filter((a) => held.has(`${s.key}.${a}`)));
        const l = levelsOf(s.actions, mine);
        if (l.view !== 'none' || l.manage !== 'none') levels[s.key] = l;
      }
      return {
        key: r.key,
        name: r.name,
        rank: r.rank,
        reportsTo: r.reportsToRole?.name ?? null,
        alsoReportsTo: r.alsoReportsToRoleIds.map((id) => roleById.get(id)?.name).filter(Boolean),
        holders: holders(r.key),
        levels,
      };
    }),
    users: users.map((u) => ({
      name: u.name,
      email: u.email,
      isActive: u.isActive,
      isSuperAdmin: u.isSuperAdmin,
      invitePending: u.invitePending,
      title: u.position ?? u.employee?.position ?? null,
      employeeNo: u.employee?.employeeNo ?? null,
      hasEmployee: !!u.employee,
      team: u.employee?.industry?.code ?? null,
      reportsTo: u.supervisor ? `${u.supervisor.name}${u.supervisor.isActive ? '' : ' (inactive)'}` : null,
      supportsTeams: u.supportTeams.map((t) => t.industry.code).sort(),
      roles: u.roles
        .map((r) => r.role)
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.sortOrder - b.sortOrder)
        .map((r) => ({ key: r.key, name: r.name, rank: r.rank })),
    })),
    employeesAlone: employeesAlone.map((e) => ({
      name: `${e.firstName} ${e.lastName}`.trim(),
      employeeNo: e.employeeNo,
      title: e.position,
      team: e.industry?.code ?? null,
      isActive: e.isActive,
    })),
    teamPosts: teamPosts.map((p) => ({
      team: teamById.get(p.teamId) ?? p.teamId,
      roleKey: p.roleKey,
      role: roles.find((r) => r.key === p.roleKey)?.name ?? p.roleKey,
      mode: p.mode,
      sharedTeams: p.sharedTeamIds.map((id) => teamById.get(id) ?? id),
      people: p.userIds.map((id) => userById.get(id) ?? id),
    })),
    workflows: workflows.map((w) => ({
      documentType: w.documentType,
      name: w.name,
      isActive: w.isActive,
      minAmount: w.minAmount?.toString() ?? null,
      maxAmount: w.maxAmount?.toString() ?? null,
      optionLabel: w.optionLabel,
      requesterRole: w.requesterRole?.name ?? null,
      preparerSigns: w.preparerSigns,
      standIns: w.standIns,
      pending: pendingBy.get(w.id) ?? 0,
      steps: w.steps.map((s) => ({
        sequence: s.sequence,
        name: s.name,
        approverType: s.approverType,
        roleKey: s.role?.key ?? null,
        role: s.role?.name ?? null,
        user: s.user ? `${s.user.name}${s.user.isActive ? '' : ' (inactive)'}` : null,
        alsoRoles: s.alsoRoleIds.map((id) => roleById.get(id)?.name).filter(Boolean),
        holders: s.role ? holders(s.role.key) : [],
        alsoHolders: s.alsoRoleIds.flatMap((id) => (roleById.get(id) ? holders(roleById.get(id)!.key) : [])),
      })),
    })),
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `Wrote ${out}: ${report.users.length} logins, ${report.employeesAlone.length} employees with no login, ` +
      `${report.roles.length} roles, ${report.screens.length} screens, ${report.workflows.length} routes.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

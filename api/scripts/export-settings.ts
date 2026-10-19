/**
 * Takes a snapshot of what administrators set on a G-CORE install —
 * Appearance & Layout (card positions, spacing, colours), the PDF templates,
 * company and division settings, roles and their permissions, who holds
 * which role, approval workflows and the numbering templates — as ONE JSON
 * file, so it can be carried to the repository or to another install.
 *
 *   npx tsx scripts/export-settings.ts                 → data/settings-snapshot.json
 *   npx tsx scripts/export-settings.ts path/to/file.json
 *
 * Read-only: it writes nothing to the database. Safe to run on the live
 * server. It leaves out what is not a setting: passwords and tokens, the
 * seed's own bookkeeping (`seed.*`), verify-script stashes (`__verify__`)
 * and the numbering COUNTERS (only the templates travel — a counter is a
 * record of what was issued, never a setting).
 *
 * Do NOT commit the file on the server: the server deploys by fast-forward
 * from origin/master, and a commit made there stops every later deploy.
 * Copy the file off the server and hand it over; `import-settings.ts`
 * applies it elsewhere.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { prisma } from '../src/prisma';

export const SNAPSHOT_VERSION = 1;

/** A setting that is the install's own bookkeeping, never an administrator's choice. */
export function isBookkeeping(key: string): boolean {
  return key.startsWith('seed.') || key.includes('__verify__');
}

async function main() {
  const out = resolve(process.argv[2] ?? 'data/settings-snapshot.json');

  const settings = await prisma.setting.findMany({ orderBy: { key: 'asc' } });
  const roles = await prisma.role.findMany({
    orderBy: { key: 'asc' },
    include: { permissions: { include: { permission: { select: { key: true } } } } },
  });
  const users = await prisma.user.findMany({
    orderBy: { email: 'asc' },
    select: {
      email: true,
      name: true,
      isActive: true,
      isSuperAdmin: true,
      supervisor: { select: { email: true } },
      roles: { select: { role: { select: { key: true } } } },
      supportTeams: { select: { industry: { select: { code: true } } } },
      employee: { select: { employeeNo: true, industry: { select: { code: true } } } },
    },
  });
  const workflows = await prisma.approvalWorkflow.findMany({
    orderBy: [{ documentType: 'asc' }, { name: 'asc' }],
    include: {
      requesterRole: { select: { key: true } },
      steps: { orderBy: { sequence: 'asc' }, include: { role: { select: { key: true } }, user: { select: { email: true } } } },
    },
  });
  const roleKeyById = new Map(roles.map((r) => [r.id, r.key]));
  const numbering = await prisma.numberSequence.findMany({ where: { periodKey: '' }, orderBy: { documentType: 'asc' } });
  const emailById = new Map((await prisma.user.findMany({ select: { id: true, email: true } })).map((u) => [u.id, u.email]));

  /** A setting that names logins by database id travels with their emails too — an id means nothing on another install. */
  const portable = (key: string, value: unknown): unknown => {
    if (key === 'helpTickets.receivers' && value && typeof value === 'object' && Array.isArray((value as { userIds?: unknown }).userIds)) {
      const ids = (value as { userIds: string[] }).userIds;
      return { ...(value as object), userEmails: ids.map((id) => emailById.get(id)).filter((e): e is string => !!e) };
    }
    return value;
  };

  const snapshot = {
    version: SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: settings
      .filter((s) => !isBookkeeping(s.key))
      .map((s) => ({ key: s.key, value: portable(s.key, s.value), description: s.description })),
    roles: roles.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      permissions: r.permissions.map((p) => p.permission.key).sort(),
    })),
    users: users.map((u) => ({
      email: u.email,
      name: u.name,
      isActive: u.isActive,
      isSuperAdmin: u.isSuperAdmin,
      reportsTo: u.supervisor?.email ?? null,
      roles: u.roles.map((r) => r.role.key).sort(),
      supportsTeams: u.supportTeams.map((t) => t.industry.code).sort(),
      team: u.employee?.industry?.code ?? null,
      employeeNo: u.employee?.employeeNo ?? null,
    })),
    workflows: workflows.map((w) => ({
      documentType: w.documentType,
      name: w.name,
      isActive: w.isActive,
      minAmount: w.minAmount?.toString() ?? null,
      maxAmount: w.maxAmount?.toString() ?? null,
      optionLabel: w.optionLabel,
      requesterRole: w.requesterRole?.key ?? null,
      preparerSigns: w.preparerSigns,
      standIns: w.standIns,
      steps: w.steps.map((s) => ({
        sequence: s.sequence,
        name: s.name,
        approverType: s.approverType,
        role: s.role?.key ?? null,
        user: s.user?.email ?? null,
        alsoRoles: s.alsoRoleIds.map((id) => roleKeyById.get(id)).filter((k): k is string => !!k),
      })),
    })),
    numbering: numbering.map((n) => ({
      documentType: n.documentType,
      label: n.label,
      pattern: n.pattern,
      typeCode: n.typeCode,
      period: n.period,
      scope: n.scope,
      padding: n.padding,
    })),
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(
    `Wrote ${out}: ${snapshot.settings.length} settings, ${snapshot.roles.length} roles, ` +
      `${snapshot.users.length} users, ${snapshot.workflows.length} workflows, ${snapshot.numbering.length} numbering templates.`,
  );
  console.log('Copy it off the server — do not commit it there.');
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

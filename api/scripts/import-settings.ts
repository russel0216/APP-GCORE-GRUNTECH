/**
 * Applies a snapshot made by `export-settings.ts` to this install:
 * Appearance & Layout, the PDF templates and every other administrator's
 * setting, roles and their permissions, who holds which role (by email),
 * approval workflows and the numbering templates.
 *
 *   npx tsx scripts/import-settings.ts [file]           → says what would change
 *   npx tsx scripts/import-settings.ts [file] --apply   → changes it
 *
 * [file] defaults to deploy/settings/snapshot.json (the copy kept in the
 * repository). What it never does: create or delete a login, touch a
 * password, lower or reset a numbering counter, delete a role or a
 * workflow, or delete a workflow step anybody already signed (it says so
 * and leaves it). A role, permission, user or team the snapshot names but
 * this install lacks is reported and skipped. Each run that changes
 * anything writes one audit row.
 *
 * Never run it from the seed: on the live server the database IS the
 * administrators' copy, and a deploy must not write over it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma, type ApproverType, type OverrideEffect, type SequencePeriod, type SequenceScope } from '@prisma/client';
import { prisma } from '../src/prisma';
import { isBookkeeping, SNAPSHOT_VERSION } from './export-settings';

type Snapshot = {
  version: number;
  exportedAt: string;
  settings: { key: string; value: Prisma.InputJsonValue; description: string | null }[];
  roles: { key: string; name: string; description: string | null; isSystem: boolean; permissions: string[] }[];
  users: {
    email: string;
    reportsTo: string | null;
    roles: string[];
    overrides: { permission: string; effect: OverrideEffect }[];
    supportsTeams: string[];
    team: string | null;
  }[];
  workflows: {
    documentType: string;
    name: string;
    isActive: boolean;
    minAmount: string | null;
    maxAmount: string | null;
    optionLabel: string | null;
    requesterRole: string | null;
    preparerSigns: boolean;
    standIns: boolean;
    steps: { sequence: number; name: string; approverType: ApproverType; role: string | null; user: string | null; alsoRoles: string[] }[];
  }[];
  numbering: { documentType: string; label: string; pattern: string; typeCode: string; period: SequencePeriod; scope: SequenceScope; padding: number }[];
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (xs: string[]) => [...xs].sort();

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const file = resolve(args.find((a) => !a.startsWith('--')) ?? '../deploy/settings/snapshot.json');
  const snap = JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
  if (snap.version !== SNAPSHOT_VERSION) throw new Error(`Snapshot version ${snap.version} — this script reads version ${SNAPSHOT_VERSION}`);

  const changes: string[] = [];
  const skipped: string[] = [];
  const say = (line: string) => changes.push(line);

  const permissions = new Map((await prisma.permission.findMany({ select: { id: true, key: true } })).map((p) => [p.key, p.id]));
  const roles = new Map((await prisma.role.findMany({ select: { id: true, key: true } })).map((r) => [r.key, r.id]));
  const teams = new Map((await prisma.industry.findMany({ select: { id: true, code: true } })).map((t) => [t.code, t.id]));
  const userIds = new Map((await prisma.user.findMany({ select: { id: true, email: true } })).map((u) => [u.email.toLowerCase(), u.id]));
  const knownIds = new Set(userIds.values());

  /**
   * The Help box's receivers are stored as login ids, which differ between
   * installs: an email the snapshot carries is turned into this install's id,
   * an id is kept only where it is a login here. Nobody left → undefined (skip).
   */
  const localise = (key: string, value: Prisma.InputJsonValue): Prisma.InputJsonValue | undefined => {
    if (key !== 'helpTickets.receivers' || !value || typeof value !== 'object' || Array.isArray(value)) return value;
    const v = value as { userIds?: unknown; userEmails?: unknown };
    const fromEmails = Array.isArray(v.userEmails)
      ? v.userEmails.map((e) => userIds.get(String(e).toLowerCase())).filter((id): id is string => !!id)
      : [];
    const fromIds = Array.isArray(v.userIds) ? v.userIds.filter((id): id is string => typeof id === 'string' && knownIds.has(id)) : [];
    const ids = [...new Set([...fromEmails, ...fromIds])];
    return ids.length ? { userIds: ids } : undefined;
  };

  await prisma.$transaction(
    async (tx) => {
      // ── Settings ──────────────────────────────────────────────────────
      for (const s of snap.settings) {
        if (isBookkeeping(s.key)) continue;
        const value = localise(s.key, s.value);
        if (value === undefined) {
          skipped.push(`Setting ${s.key}: none of the people it names has a login here`);
          continue;
        }
        const now = await tx.setting.findUnique({ where: { key: s.key } });
        if (now && same(now.value, value)) continue;
        say(`${now ? 'Change' : 'Add'} setting ${s.key}`);
        if (apply) {
          await tx.setting.upsert({
            where: { key: s.key },
            create: { key: s.key, value, description: s.description },
            update: { value },
          });
        }
      }

      // ── Roles and their permissions ──────────────────────────────────
      for (const r of snap.roles) {
        const wanted = r.permissions.filter((k) => {
          if (permissions.has(k)) return true;
          skipped.push(`Role ${r.key}: permission ${k} is not on this install`);
          return false;
        });
        let roleId = roles.get(r.key);
        if (!roleId) {
          say(`Add role ${r.key} (${r.name}) with ${wanted.length} permissions`);
          if (!apply) continue;
          roleId = (await tx.role.create({ data: { key: r.key, name: r.name, description: r.description, isSystem: r.isSystem } })).id;
          roles.set(r.key, roleId);
        } else {
          const role = await tx.role.findUniqueOrThrow({ where: { id: roleId } });
          if (role.name !== r.name || role.description !== r.description) {
            say(`Rename role ${r.key}: "${role.name}" → "${r.name}"`);
            if (apply) await tx.role.update({ where: { id: roleId }, data: { name: r.name, description: r.description } });
          }
        }
        const held = (await tx.rolePermission.findMany({ where: { roleId }, include: { permission: { select: { key: true } } } })).map(
          (p) => p.permission.key,
        );
        const add = wanted.filter((k) => !held.includes(k));
        const drop = held.filter((k) => !wanted.includes(k));
        if (add.length || drop.length) {
          say(`Role ${r.key}: +${add.length} / −${drop.length} permissions`);
          if (apply) {
            if (drop.length) {
              await tx.rolePermission.deleteMany({ where: { roleId, permissionId: { in: drop.map((k) => permissions.get(k)!) } } });
            }
            if (add.length) {
              await tx.rolePermission.createMany({ data: add.map((k) => ({ roleId: roleId!, permissionId: permissions.get(k)! })), skipDuplicates: true });
            }
          }
        }
      }

      // ── People: roles, Reports to, team, Back Support teams, overrides ──
      for (const u of snap.users) {
        const userId = userIds.get(u.email.toLowerCase());
        if (!userId) {
          skipped.push(`User ${u.email} has no login here`);
          continue;
        }
        const now = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: {
            supervisor: { select: { email: true } },
            roles: { select: { role: { select: { key: true } } } },
            overrides: { select: { effect: true, permission: { select: { key: true } } } },
            supportTeams: { select: { industry: { select: { code: true } } } },
            employee: { select: { id: true, industry: { select: { code: true } } } },
          },
        });

        const wantRoles = u.roles.filter((k) => roles.has(k) || (skipped.push(`User ${u.email}: role ${k} is not here`), false));
        const haveRoles = now.roles.map((r) => r.role.key);
        if (!same(sorted(wantRoles), sorted(haveRoles))) {
          say(`User ${u.email}: roles ${sorted(haveRoles).join(', ') || '—'} → ${sorted(wantRoles).join(', ') || '—'}`);
          if (apply) {
            await tx.userRole.deleteMany({ where: { userId } });
            await tx.userRole.createMany({ data: wantRoles.map((k) => ({ userId, roleId: roles.get(k)! })) });
          }
        }

        const boss = u.reportsTo ? userIds.get(u.reportsTo.toLowerCase()) ?? null : null;
        if (u.reportsTo && !boss) skipped.push(`User ${u.email}: Reports to ${u.reportsTo} has no login here`);
        else if ((now.supervisor?.email.toLowerCase() ?? null) !== (u.reportsTo?.toLowerCase() ?? null)) {
          say(`User ${u.email}: Reports to ${now.supervisor?.email ?? '—'} → ${u.reportsTo ?? '—'}`);
          if (apply) await tx.user.update({ where: { id: userId }, data: { supervisorId: boss } });
        }

        const wantSupports = u.supportsTeams.filter((c) => teams.has(c));
        const haveSupports = now.supportTeams.map((t) => t.industry.code);
        if (!same(sorted(wantSupports), sorted(haveSupports))) {
          say(`User ${u.email}: supports teams ${sorted(haveSupports).join(', ') || '—'} → ${sorted(wantSupports).join(', ') || '—'}`);
          if (apply) {
            await tx.userSupportTeam.deleteMany({ where: { userId } });
            await tx.userSupportTeam.createMany({ data: wantSupports.map((c) => ({ userId, industryId: teams.get(c)! })) });
          }
        }

        if (now.employee && (now.employee.industry?.code ?? null) !== u.team) {
          if (u.team && !teams.has(u.team)) skipped.push(`User ${u.email}: team ${u.team} is not here`);
          else {
            say(`User ${u.email}: team ${now.employee.industry?.code ?? '—'} → ${u.team ?? '—'}`);
            if (apply) await tx.employee.update({ where: { id: now.employee.id }, data: { industryId: u.team ? teams.get(u.team)! : null } });
          }
        }

        const wantOv = u.overrides.filter((o) => permissions.has(o.permission));
        const haveOv = now.overrides.map((o) => ({ permission: o.permission.key, effect: o.effect }));
        const key = (xs: { permission: string; effect: string }[]) => xs.map((o) => `${o.permission}:${o.effect}`).sort();
        if (!same(key(wantOv), key(haveOv))) {
          say(`User ${u.email}: ${wantOv.length} permission override(s)`);
          if (apply) {
            await tx.userPermissionOverride.deleteMany({ where: { userId } });
            await tx.userPermissionOverride.createMany({
              data: wantOv.map((o) => ({ userId, permissionId: permissions.get(o.permission)!, effect: o.effect })),
            });
          }
        }
      }

      // ── Approval workflows (matched by document type and name) ───────
      for (const w of snap.workflows) {
        const roleOf = (k: string | null) => (k ? roles.get(k) ?? null : null);
        const header = {
          isActive: w.isActive,
          minAmount: w.minAmount === null ? null : new Prisma.Decimal(w.minAmount),
          maxAmount: w.maxAmount === null ? null : new Prisma.Decimal(w.maxAmount),
          optionLabel: w.optionLabel,
          requesterRoleId: roleOf(w.requesterRole),
          preparerSigns: w.preparerSigns,
          standIns: w.standIns,
        };
        const stepData = (s: Snapshot['workflows'][number]['steps'][number]) => ({
          name: s.name,
          approverType: s.approverType,
          roleId: roleOf(s.role),
          userId: s.user ? userIds.get(s.user.toLowerCase()) ?? null : null,
          alsoRoleIds: s.alsoRoles.map(roleOf).filter((id): id is string => !!id),
        });
        const found = await tx.approvalWorkflow.findFirst({ where: { documentType: w.documentType, name: w.name }, include: { steps: true } });
        if (!found) {
          say(`Add workflow ${w.documentType} — ${w.name} (${w.steps.length} steps)`);
          if (apply) {
            await tx.approvalWorkflow.create({
              data: { documentType: w.documentType, name: w.name, ...header, steps: { create: w.steps.map((s) => ({ sequence: s.sequence, ...stepData(s) })) } },
            });
          }
          continue;
        }
        const headerNow = {
          isActive: found.isActive,
          minAmount: found.minAmount?.toString() ?? null,
          maxAmount: found.maxAmount?.toString() ?? null,
          optionLabel: found.optionLabel,
          requesterRoleId: found.requesterRoleId,
          preparerSigns: found.preparerSigns,
          standIns: found.standIns,
        };
        const headerWant = { ...header, minAmount: header.minAmount?.toString() ?? null, maxAmount: header.maxAmount?.toString() ?? null };
        if (!same(headerNow, headerWant)) {
          say(`Workflow ${w.documentType} — ${w.name}: settings`);
          if (apply) await tx.approvalWorkflow.update({ where: { id: found.id }, data: header });
        }
        for (const s of w.steps) {
          const step = found.steps.find((x) => x.sequence === s.sequence);
          const data = stepData(s);
          if (!step) {
            say(`Workflow ${w.name}: add step ${s.sequence} ${s.name}`);
            if (apply) await tx.approvalStep.create({ data: { workflowId: found.id, sequence: s.sequence, ...data } });
          } else if (!same({ name: step.name, approverType: step.approverType, roleId: step.roleId, userId: step.userId, alsoRoleIds: step.alsoRoleIds }, data)) {
            say(`Workflow ${w.name}: step ${s.sequence} ${step.name} → ${s.name}`);
            if (apply) await tx.approvalStep.update({ where: { id: step.id }, data });
          }
        }
        for (const extra of found.steps.filter((x) => !w.steps.some((s) => s.sequence === x.sequence))) {
          const signed = await tx.approvalAction.count({ where: { stepId: extra.id } });
          if (signed) skipped.push(`Workflow ${w.name}: step ${extra.sequence} ${extra.name} has signatures — left in place`);
          else {
            say(`Workflow ${w.name}: remove step ${extra.sequence} ${extra.name}`);
            if (apply) await tx.approvalStep.delete({ where: { id: extra.id } });
          }
        }
      }

      // ── Numbering templates (never the counters) ─────────────────────
      for (const n of snap.numbering) {
        const t = await tx.numberSequence.findUnique({ where: { documentType_periodKey: { documentType: n.documentType, periodKey: '' } } });
        const want = { label: n.label, pattern: n.pattern, typeCode: n.typeCode, period: n.period, scope: n.scope, padding: n.padding };
        if (t && same({ label: t.label, pattern: t.pattern, typeCode: t.typeCode, period: t.period, scope: t.scope, padding: t.padding }, want)) continue;
        say(`${t ? 'Change' : 'Add'} numbering ${n.documentType}: ${n.pattern}`);
        if (apply) {
          await tx.numberSequence.upsert({
            where: { documentType_periodKey: { documentType: n.documentType, periodKey: '' } },
            create: { documentType: n.documentType, periodKey: '', ...want },
            update: want,
          });
        }
      }

      if (apply && changes.length) {
        await tx.auditLog.create({
          data: {
            entityType: 'setting',
            entityId: 'snapshot',
            action: 'UPDATED',
            summary: `Applied the settings snapshot of ${snap.exportedAt} (${changes.length} change${changes.length === 1 ? '' : 's'})`,
            after: { changes } as Prisma.InputJsonValue,
          },
        });
      }
    },
    { timeout: 120_000, maxWait: 15_000 },
  );

  console.log(`${apply ? 'Applied' : 'Would apply'} ${changes.length} change(s) from ${file} (exported ${snap.exportedAt}):`);
  for (const c of changes) console.log(`  · ${c}`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  – ${s}`);
  }
  if (!apply && changes.length) console.log('Nothing written. Run again with --apply to make these changes.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

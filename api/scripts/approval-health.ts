/**
 * Where is every document waiting, and on whom — and which people are set up
 * so that their documents cannot move.
 *
 *   npx tsx scripts/approval-health.ts          (the first 60 of each list)
 *   npx tsx scripts/approval-health.ts --all    (everything)
 *
 * READ-ONLY. It never writes a row, sends a notification or changes a setting,
 * so it is safe to run against production. It asks the approval engine itself
 * (`approversForStep`) who may decide each open step, so the answer is the
 * one the Approval panel and My Work would give.
 */

import { prisma } from '../src/prisma';
import { approversForStep, ctxOf, stepApplies } from '../src/shared/approvals';

const ALL = process.argv.includes('--all');
const CAP = ALL ? Infinity : 60;
const DAY = 24 * 60 * 60 * 1000;

function heading(text: string) {
  console.log('\n' + '='.repeat(78));
  console.log(text);
  console.log('='.repeat(78));
}
function capped<T>(rows: T[]): T[] {
  if (rows.length > CAP) console.log(`(showing ${CAP} of ${rows.length} — run with --all for every one)`);
  return rows.slice(0, CAP);
}
const days = (from: Date) => Math.floor((Date.now() - from.getTime()) / DAY);

async function main() {
  const users = await prisma.user.findMany({
    select: {
      id: true, name: true, email: true, isActive: true, isSuperAdmin: true, supervisorId: true,
      roles: { select: { role: { select: { key: true, name: true } } } },
      employee: { select: { id: true, industry: { select: { code: true } } } },
    },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  const who = (id: string) => byId.get(id)?.name ?? `(unknown user ${id})`;

  // ── 1. Every request waiting for a decision ──────────────────────────────
  const open = await prisma.approvalRequest.findMany({
    where: { status: 'PENDING' },
    include: {
      workflow: { select: { name: true, isActive: true, steps: { orderBy: { sequence: 'asc' } } } },
      actions: { select: { actedAt: true }, orderBy: { actedAt: 'desc' }, take: 1 },
    },
    orderBy: { createdAt: 'asc' },
  });

  type Row = { number: string; type: string; subject: string; requester: string; step: string; waitingOn: string; days: number; problem: string };
  const rows: Row[] = [];
  for (const r of open) {
    const since = r.actions[0]?.actedAt ?? r.createdAt;
    const base = {
      number: r.documentNumber ?? r.documentId,
      type: r.documentType,
      subject: r.subject,
      requester: who(r.requesterId),
      days: days(since),
    };
    if (!r.workflow) {
      rows.push({ ...base, step: '—', waitingOn: '—', problem: 'NO ROUTE: its workflow was deleted' });
      continue;
    }
    const step = r.workflow.steps.find((s) => s.sequence === r.currentSequence);
    if (!step) {
      rows.push({ ...base, step: `#${r.currentSequence}`, waitingOn: '—', problem: 'STEP MISSING: the route has no step at this number (edited after submit)' });
      continue;
    }
    const ctx = ctxOf(r);
    if (!stepApplies(step, ctx)) {
      rows.push({ ...base, step: step.name, waitingOn: '—', problem: 'STEP DOES NOT APPLY but the request sits on it' });
      continue;
    }
    let ids: string[] = [];
    try {
      ids = await approversForStep(step, r.requesterId, prisma, ctx);
    } catch (e) {
      rows.push({ ...base, step: step.name, waitingOn: '—', problem: `ENGINE ERROR: ${(e as Error).message}` });
      continue;
    }
    const people = [...new Set(ids)].filter((id) => id !== r.requesterId).map((id) => byId.get(id)).filter(Boolean);
    const active = people.filter((u) => u!.isActive);
    let problem = '';
    if (!active.length) problem = people.length ? 'NOBODY ACTIVE: every approver is deactivated' : 'NOBODY: no one holds this step';
    else if (base.days >= 7) problem = `SLOW: waiting ${base.days} days`;
    if (!r.workflow.isActive && !problem) problem = '(on a retired route — finishes on it)';
    rows.push({
      ...base,
      step: `${step.sequence}. ${step.name}`,
      waitingOn: active.map((u) => u!.name).join(', ') || '—',
      problem,
    });
  }

  const stuck = rows.filter((r) => r.problem && !r.problem.startsWith('SLOW') && !r.problem.startsWith('('));
  const slow = rows.filter((r) => r.problem.startsWith('SLOW'));

  heading(`1. DOCUMENTS THAT CANNOT MOVE — ${stuck.length} of ${open.length} waiting`);
  if (!stuck.length) console.log('None. Every waiting document has someone who can decide it.');
  for (const r of capped(stuck)) {
    console.log(`\n${r.number}  [${r.type}]  ${r.problem}`);
    console.log(`   ${r.subject}`);
    console.log(`   raised by ${r.requester} · at step ${r.step} · ${r.days} days`);
  }

  heading(`2. WAITING 7 DAYS OR MORE — ${slow.length}`);
  for (const r of capped(slow.sort((a, b) => b.days - a.days))) {
    console.log(`${String(r.days).padStart(4)}d  ${r.number}  [${r.type}]  step ${r.step}  → ${r.waitingOn}  (raised by ${r.requester})`);
  }

  // Who has the most waiting on them.
  const load = new Map<string, number>();
  for (const r of rows) for (const n of r.waitingOn.split(', ')) if (n && n !== '—') load.set(n, (load.get(n) ?? 0) + 1);
  heading('3. WHO HAS THE MOST WAITING ON THEM');
  for (const [n, c] of [...load].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${String(c).padStart(4)}  ${n}`);

  heading('4. WAITING, BY DOCUMENT TYPE');
  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  for (const [t, c] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`${String(c).padStart(4)}  ${t}`);

  // ── 5. People set up so their documents cannot route ─────────────────────
  const active = users.filter((u) => u.isActive && !u.isSuperAdmin);
  const noRoles = active.filter((u) => !u.roles.length);
  const isHead = (u: (typeof users)[number]) => u.roles.some((r) => r.role.key === 'ceo');
  const noBoss = active.filter((u) => !u.supervisorId && !isHead(u));
  const deadBoss = active.filter((u) => u.supervisorId && !byId.get(u.supervisorId)?.isActive);
  const selfBoss = active.filter((u) => u.supervisorId === u.id);
  const noEmployee = active.filter((u) => !u.employee);
  const noTeam = active.filter((u) => u.employee && !u.employee.industry);

  heading('5. PEOPLE WHOSE SET-UP STOPS DOCUMENTS');
  const list = (title: string, why: string, us: typeof users) => {
    console.log(`\n${title} — ${us.length}`);
    console.log(`   why it matters: ${why}`);
    for (const u of capped(us)) console.log(`   · ${u.name} <${u.email}>  roles: ${u.roles.map((r) => r.role.name).join(', ') || 'none'}`);
  };
  list('Active logins with NO role', 'they see nothing and cannot approve any step', noRoles);
  list('No "Reports to" (and not the CEO)', 'their leave, overtime, claims and Team Leader steps have no superior to go to', noBoss);
  list('"Reports to" is a deactivated login', 'the engine steps past them, often to HR or a fallback role nobody expects', deadBoss);
  list('"Reports to" is themselves', 'submit is refused', selfBoss);
  list('No employee record', 'no team, so every team-based step (Team Leader, Technical Manager, Back Support) falls back to "any holder"', noEmployee);
  list('Employee with NO team', 'team-based steps fall back to every holder of the role, across teams', noTeam);

  // ── 6. Roles ──────────────────────────────────────────────────────────────
  const roles = await prisma.role.findMany({
    select: {
      key: true, name: true,
      _count: { select: { permissions: true } },
      users: { select: { user: { select: { isActive: true } } } },
    },
  });
  const steps = await prisma.approvalStep.findMany({
    where: { workflow: { isActive: true }, roleId: { not: null } },
    select: { name: true, role: { select: { key: true } }, workflow: { select: { name: true } } },
  });
  heading('6. ROLES');
  for (const r of roles.sort((a, b) => a.name.localeCompare(b.name))) {
    const holders = r.users.filter((x) => x.user.isActive).length;
    const usedBy = steps.filter((s) => s.role?.key === r.key).length;
    const flags = [
      holders === 0 && usedBy ? `HELD BY NOBODY but ${usedBy} route step(s) name it` : '',
      holders > 0 && r._count.permissions === 0 ? 'HAS PEOPLE BUT NO RIGHTS (they open nothing)' : '',
    ].filter(Boolean).join('; ');
    console.log(`${r.name.padEnd(34)} ${String(holders).padStart(3)} people  ${String(r._count.permissions).padStart(4)} rights  ${String(usedBy).padStart(3)} steps  ${flags}`);
  }

  console.log(`\nDone. ${open.length} waiting, ${stuck.length} cannot move, ${slow.length} slow. Nothing was changed.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/**
 * Approval health (2026-11-26, the owner's call: "a better visualization of
 * work flow and access so I can easily pin point the problem").
 *
 * READ-ONLY, everything here. It asks the engine itself (`approversForStep`)
 * who may decide each open step, so every answer is the one the Approval
 * panel and My Work give — never a second copy of the routing rules. Read by
 * Admin › Approval Health (routes/approvalHealth.ts) and by
 * scripts/approval-health.ts.
 */

import type { ApprovalStep, Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { approversForStep, ctxOf, stepApplies, MONEY_DOCUMENTS } from './approvals';
import { DOCUMENT_TYPES } from './numbering';
import { REGISTRY } from '../permissions/registry';
import { levelsOf, LEVEL_LABELS } from './permissionLevels';

const DAY = 24 * 60 * 60 * 1000;
export const SLOW_DAYS = 7;

const EXTRA_LABELS: Record<string, string> = {
  expense: 'Reimbursement / liquidation',
  gantt_chart: 'Kick-off Gantt chart',
  schedule_change: 'Phase date change',
  overtime_prior: 'Overtime (prior approval)',
  overtime_request: 'Overtime (actual hours)',
  leave_request: 'Leave',
  evaluation: 'Evaluation',
  clearance: 'Clearance',
  training_certification: 'Training certificate',
};
export function typeLabel(type: string): string {
  return DOCUMENT_TYPES.find((d) => d.type === type)?.label ?? EXTRA_LABELS[type] ?? type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

type UserLite = { id: string; name: string; email: string; isActive: boolean; isSuperAdmin: boolean; supervisorId: string | null; team: string | null; roles: { key: string; name: string }[]; hasEmployee: boolean };

async function loadUsers(): Promise<Map<string, UserLite>> {
  const rows = await prisma.user.findMany({
    select: {
      id: true, name: true, email: true, isActive: true, isSuperAdmin: true, supervisorId: true,
      roles: { select: { role: { select: { key: true, name: true } } } },
      employee: { select: { id: true, industry: { select: { code: true } } } },
    },
  });
  return new Map(rows.map((u) => [u.id, {
    id: u.id, name: u.name, email: u.email, isActive: u.isActive, isSuperAdmin: u.isSuperAdmin, supervisorId: u.supervisorId,
    team: u.employee?.industry?.code ?? null,
    roles: u.roles.map((r) => r.role),
    hasEmployee: !!u.employee,
  }]));
}

type StepWithRole = ApprovalStep & { role: { key: string; name: string } | null; user: { id: string; name: string; isActive: boolean } | null };

/** The step's rule in plain words. */
export function stepRule(step: StepWithRole, alsoNames: string[] = []): string {
  const role = step.role?.name;
  switch (step.approverType) {
    case 'ROLE':
      return `Whoever holds “${role ?? '(role deleted)'}”${alsoNames.length ? ` or “${alsoNames.join('”, “')}”` : ''}`;
    case 'USER':
      return `Only ${step.user?.name ?? '(person deleted)'}`;
    case 'SUPERVISOR':
      return `The preparer’s “Reports to”${role ? ` (or the team’s ${role})` : ''}`;
    case 'HR':
      return 'Whoever holds the HR role';
    case 'PROJECT_MANAGER':
      return `The project’s Technical Manager${role ? ` (none named: ${role})` : ''}`;
    case 'PROJECT_MANAGERS':
      return 'The Technical Manager of EACH project the lines charge';
    default:
      return step.approverType;
  }
}

/** What to change so a step that has nobody gets somebody, in words. */
function fixFor(step: StepWithRole, requester: UserLite | undefined): string {
  const role = step.role?.name ?? 'the role';
  switch (step.approverType) {
    case 'ROLE':
      return `Admin › Users: give someone the “${role}” role${requester?.team ? ` (on team ${requester.team}, if the role works by team)` : ''}.`;
    case 'USER':
      return `Admin › Approval Workflows: this step names one person who is gone — name somebody else.`;
    case 'SUPERVISOR':
      return `Admin › Users: set “Reports to” for ${requester?.name ?? 'the preparer'}${step.role ? `, or give someone “${role}” on their team` : ''}.`;
    case 'HR':
      return 'Admin › Users: give someone the HR role.';
    case 'PROJECT_MANAGER':
    case 'PROJECT_MANAGERS':
      return `Name a Technical Manager on the project, or give someone “${role}”.`;
    default:
      return 'Check the route in Admin › Approval Workflows.';
  }
}

export type Problem = 'nobody' | 'inactive' | 'no_route' | 'step_missing' | 'engine_error' | 'slow' | null;

export interface WaitingRow {
  requestId: string;
  documentType: string;
  typeLabel: string;
  number: string;
  subject: string;
  link: string | null;
  requester: { id: string; name: string };
  steps: { sequence: number; name: string; state: 'done' | 'current' | 'next' }[];
  stepName: string;
  waitingOn: { id: string; name: string }[];
  days: number;
  workflowName: string | null;
  retiredRoute: boolean;
  problem: Problem;
  problemText: string | null;
  fix: string | null;
}

export async function waitingDocuments(users?: Map<string, UserLite>): Promise<WaitingRow[]> {
  const byId = users ?? (await loadUsers());
  const open = await prisma.approvalRequest.findMany({
    where: { status: 'PENDING' },
    include: {
      workflow: { select: { name: true, isActive: true, steps: { orderBy: { sequence: 'asc' }, include: { role: { select: { key: true, name: true } }, user: { select: { id: true, name: true, isActive: true } } } } } },
      actions: { select: { actedAt: true }, orderBy: { actedAt: 'desc' }, take: 1 },
    },
    orderBy: { createdAt: 'asc' },
  });
  const rows: WaitingRow[] = [];
  for (const r of open) {
    const since = r.actions[0]?.actedAt ?? r.createdAt;
    const requester = byId.get(r.requesterId);
    const steps = (r.workflow?.steps ?? []).map((s) => ({
      sequence: s.sequence, name: s.name,
      state: (s.sequence < r.currentSequence ? 'done' : s.sequence === r.currentSequence ? 'current' : 'next') as 'done' | 'current' | 'next',
    }));
    const base = {
      requestId: r.id,
      documentType: r.documentType,
      typeLabel: typeLabel(r.documentType),
      number: r.documentNumber ?? '—',
      subject: r.subject,
      link: r.link,
      requester: { id: r.requesterId, name: requester?.name ?? 'Unknown' },
      steps,
      days: Math.floor((Date.now() - since.getTime()) / DAY),
      workflowName: r.workflow?.name ?? null,
      retiredRoute: !!r.workflow && !r.workflow.isActive,
    };
    const push = (stepName: string, waitingOn: { id: string; name: string }[], problem: Problem, problemText: string | null, fix: string | null) =>
      rows.push({ ...base, stepName, waitingOn, problem, problemText, fix });

    if (!r.workflow) { push('—', [], 'no_route', 'Its approval route was deleted.', 'Pull it back to draft and submit it again.'); continue; }
    const step = r.workflow.steps.find((s) => s.sequence === r.currentSequence) as StepWithRole | undefined;
    if (!step) { push(`#${r.currentSequence}`, [], 'step_missing', 'The route was edited after it was submitted: this step no longer exists.', 'Pull it back to draft and submit it again.'); continue; }
    const ctx = ctxOf(r);
    if (!stepApplies(step, ctx)) { push(step.name, [], 'step_missing', 'It sits on a step that does not apply to it.', 'Pull it back to draft and submit it again.'); continue; }
    let ids: string[];
    try {
      ids = await approversForStep(step, r.requesterId, prisma, ctx);
    } catch (e) {
      push(step.name, [], 'engine_error', (e as Error).message, null);
      continue;
    }
    const people = [...new Set(ids)].filter((id) => id !== r.requesterId).map((id) => byId.get(id)).filter((u): u is UserLite => !!u);
    const active = people.filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.name }));
    if (!active.length) {
      push(step.name, [], people.length ? 'inactive' : 'nobody',
        people.length ? 'Everyone who could decide this step is deactivated.' : 'Nobody can decide this step.',
        fixFor(step, requester));
    } else if (base.days >= SLOW_DAYS) {
      push(step.name, active, 'slow', `Waiting ${base.days} days.`, 'Remind them, or the preparer can press “Follow up” on the document.');
    } else {
      push(step.name, active, null, null, null);
    }
  }
  return rows;
}

export interface RouteStep {
  sequence: number;
  name: string;
  rule: string;
  holders: { id: string; name: string; team: string | null }[];
  waiting: number;
  problem: string | null;
}
export interface RouteCard {
  id: string;
  documentType: string;
  typeLabel: string;
  name: string;
  band: string | null;
  optionLabel: string | null;
  preparerRole: string | null;
  preparerSigns: boolean;
  standIns: boolean;
  moneyRule: boolean;
  steps: RouteStep[];
  waiting: number;
}

function bandOf(min: Prisma.Decimal | null, max: Prisma.Decimal | null): string | null {
  const f = (d: Prisma.Decimal) => `₱${Number(d).toLocaleString('en-PH')}`;
  if (min && max) return `${f(min)} to ${f(max)}`;
  if (min) return `over ${f(min)}`;
  if (max) return `up to ${f(max)}`;
  return null;
}

/** Every active route, step by step, with who holds each step today. */
export async function routeMap(users?: Map<string, UserLite>): Promise<RouteCard[]> {
  const byId = users ?? (await loadUsers());
  const [workflows, roles, pending] = await Promise.all([
    prisma.approvalWorkflow.findMany({
      where: { isActive: true },
      include: {
        requesterRole: { select: { name: true } },
        steps: { orderBy: { sequence: 'asc' }, include: { role: { select: { key: true, name: true } }, user: { select: { id: true, name: true, isActive: true } } } },
      },
    }),
    prisma.role.findMany({ select: { id: true, key: true, name: true, users: { select: { userId: true } } } }),
    prisma.approvalRequest.groupBy({ by: ['workflowId', 'currentSequence'], where: { status: 'PENDING' }, _count: true }),
  ]);
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const hrRole = roles.find((r) => r.key === 'hr');
  const holdersOf = (roleId: string | null | undefined) =>
    (roleId ? roleById.get(roleId)?.users ?? [] : [])
      .map((u) => byId.get(u.userId))
      .filter((u): u is UserLite => !!u && u.isActive)
      .map((u) => ({ id: u.id, name: u.name, team: u.team }));
  const waitingAt = (wid: string, seq: number) => pending.find((p) => p.workflowId === wid && p.currentSequence === seq)?._count ?? 0;

  return workflows
    .map((w): RouteCard => ({
      id: w.id,
      documentType: w.documentType,
      typeLabel: typeLabel(w.documentType),
      name: w.name,
      band: bandOf(w.minAmount, w.maxAmount),
      optionLabel: w.optionLabel,
      preparerRole: w.requesterRole?.name ?? null,
      preparerSigns: w.preparerSigns,
      standIns: w.standIns,
      moneyRule: MONEY_DOCUMENTS.has(w.documentType),
      waiting: pending.filter((p) => p.workflowId === w.id).reduce((n, p) => n + p._count, 0),
      steps: w.steps.map((s) => {
        const also = s.alsoRoleIds.map((id) => roleById.get(id)?.name).filter((n): n is string => !!n);
        let holders: RouteStep['holders'] = [];
        let problem: string | null = null;
        switch (s.approverType) {
          case 'ROLE':
            holders = [...holdersOf(s.roleId), ...s.alsoRoleIds.flatMap((id) => holdersOf(id))];
            if (!s.roleId) problem = 'The role was deleted — this step routes to nobody.';
            else if (!holders.length) problem = `Nobody holds “${s.role?.name}”.`;
            break;
          case 'USER':
            holders = s.user && s.user.isActive ? [{ id: s.user.id, name: s.user.name, team: byId.get(s.user.id)?.team ?? null }] : [];
            if (!holders.length) problem = 'The person this step names is gone or deactivated.';
            break;
          case 'HR':
            holders = holdersOf(hrRole?.id);
            if (!holders.length) problem = 'Nobody holds the HR role.';
            break;
          case 'SUPERVISOR':
            holders = holdersOf(s.roleId);
            if (s.roleId && !holders.length) problem = `Anyone without a “Reports to” lands on nobody: nobody holds “${s.role?.name}”.`;
            break;
          case 'PROJECT_MANAGER':
          case 'PROJECT_MANAGERS':
            holders = holdersOf(s.roleId);
            if (s.roleId && !holders.length) problem = `A project with no Technical Manager lands on nobody: nobody holds “${s.role?.name}”.`;
            break;
        }
        // One name each, even when someone holds two of the roles.
        const seen = new Set<string>();
        holders = holders.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)));
        return { sequence: s.sequence, name: s.name, rule: stepRule(s as StepWithRole, also), holders, waiting: waitingAt(w.id, s.sequence), problem };
      }),
    }))
    .sort((a, b) => a.typeLabel.localeCompare(b.typeLabel) || a.name.localeCompare(b.name));
}

export interface PeopleIssue { key: string; title: string; why: string; people: { id: string; name: string; email: string; roles: string[] }[] }
export interface RoleRow { key: string; name: string; holders: number; rights: number; steps: number; problem: string | null }

export async function setupIssues(users?: Map<string, UserLite>): Promise<{ people: PeopleIssue[]; roles: RoleRow[] }> {
  const byId = users ?? (await loadUsers());
  const active = [...byId.values()].filter((u) => u.isActive && !u.isSuperAdmin);
  const isHead = (u: UserLite) => u.roles.some((r) => r.key === 'ceo');
  const lite = (us: UserLite[]) => us.map((u) => ({ id: u.id, name: u.name, email: u.email, roles: u.roles.map((r) => r.name) })).sort((a, b) => a.name.localeCompare(b.name));
  const people: PeopleIssue[] = [
    { key: 'no_role', title: 'No role', why: 'They see nothing and cannot approve any step.', people: lite(active.filter((u) => !u.roles.length)) },
    { key: 'no_boss', title: 'No “Reports to”', why: 'Their leave, overtime, claims and Team Leader steps have no superior to go to.', people: lite(active.filter((u) => !u.supervisorId && !isHead(u))) },
    { key: 'dead_boss', title: '“Reports to” is deactivated', why: 'The engine steps past them to the next one up, or to a fallback role.', people: lite(active.filter((u) => u.supervisorId && !byId.get(u.supervisorId)?.isActive)) },
    { key: 'self_boss', title: '“Reports to” is themselves', why: 'Their documents are refused at submit.', people: lite(active.filter((u) => u.supervisorId === u.id)) },
    { key: 'no_employee', title: 'No employee record', why: 'No team, so a team-based step (Team Leader, Technical Manager, Back Support) goes to every holder instead.', people: lite(active.filter((u) => !u.hasEmployee)) },
    { key: 'no_team', title: 'Employee with no team', why: 'Team-based steps go to every holder of the role, across teams.', people: lite(active.filter((u) => u.hasEmployee && !u.team)) },
  ];
  const [roles, steps] = await Promise.all([
    prisma.role.findMany({ select: { id: true, key: true, name: true, _count: { select: { permissions: true } }, users: { select: { userId: true } } } }),
    prisma.approvalStep.findMany({ where: { workflow: { isActive: true } }, select: { roleId: true, alsoRoleIds: true } }),
  ]);
  const roleRows: RoleRow[] = roles.map((r) => {
    const holders = r.users.filter((x) => byId.get(x.userId)?.isActive).length;
    const used = steps.filter((s) => s.roleId === r.id || s.alsoRoleIds.includes(r.id)).length;
    const problem = holders === 0 && used ? `Nobody holds it, but ${used} route step${used === 1 ? '' : 's'} name it.`
      : holders > 0 && r._count.permissions === 0 ? 'People hold it, but it has no rights — they open nothing with it.' : null;
    return { key: r.key, name: r.name, holders, rights: r._count.permissions, steps: used, problem };
  }).sort((a, b) => Number(!!b.problem) - Number(!!a.problem) || a.name.localeCompare(b.name));
  return { people, roles: roleRows };
}

/** One person: their set-up, where each document they raise would go, what they may open, what waits on them. */
export async function personCheck(userId: string) {
  const byId = await loadUsers();
  const me = byId.get(userId);
  if (!me) return null;
  const boss = me.supervisorId ? byId.get(me.supervisorId) : undefined;

  const checks = [
    { ok: me.isActive, text: me.isActive ? 'Login is active' : 'Login is DEACTIVATED' },
    { ok: me.roles.length > 0, text: me.roles.length ? `Holds ${me.roles.length} role${me.roles.length === 1 ? '' : 's'}` : 'Holds NO role — sees nothing' },
    { ok: !!boss && boss.isActive && boss.id !== me.id, text: !boss ? (me.roles.some((r) => r.key === 'ceo') ? 'No “Reports to” (the head — fine)' : 'No “Reports to” set') : boss.id === me.id ? '“Reports to” is themselves' : boss.isActive ? `Reports to ${boss.name}` : `Reports to ${boss.name}, who is DEACTIVATED` },
    { ok: me.hasEmployee, text: me.hasEmployee ? 'Has an employee record' : 'No employee record' },
    { ok: !!me.team, text: me.team ? `Team ${me.team}` : 'No team' },
  ];
  if (!boss && me.roles.some((r) => r.key === 'ceo')) checks[2].ok = true;

  // Where each document they raise would go — the standard route of each
  // type (no option, no amount band picked: the smallest band).
  const workflows = await prisma.approvalWorkflow.findMany({
    where: { isActive: true, optionLabel: null },
    include: {
      requesterRole: { select: { key: true } },
      steps: { orderBy: { sequence: 'asc' }, include: { role: { select: { key: true, name: true } }, user: { select: { id: true, name: true, isActive: true } } } },
    },
    orderBy: [{ documentType: 'asc' }, { minAmount: 'asc' }],
  });
  const roleKeys = new Set(me.roles.map((r) => r.key));
  const routes: { documentType: string; typeLabel: string; name: string; band: string | null; steps: { name: string; rule: string; people: string[]; note: string | null }[] }[] = [];
  for (const w of workflows) {
    if (w.requesterRole && !roleKeys.has(w.requesterRole.key)) continue;
    const steps = [];
    for (const s of w.steps) {
      const ctx = { documentType: w.documentType };
      if (!stepApplies(s, { ...ctx, jobIds: [] }) && s.approverType === 'PROJECT_MANAGERS') {
        steps.push({ name: s.name, rule: stepRule(s as StepWithRole), people: [], note: 'Only when a line charges a project — its Technical Manager.' });
        continue;
      }
      let ids: string[] = [];
      try { ids = await approversForStep(s, userId, prisma, ctx); } catch { ids = []; }
      const names = [...new Set(ids)].map((id) => byId.get(id)).filter((u): u is UserLite => !!u && u.isActive);
      const self = names.some((u) => u.id === userId);
      const others = names.filter((u) => u.id !== userId).map((u) => u.name).sort();
      const note = s.approverType === 'PROJECT_MANAGER' ? 'Depends on the project: its own Technical Manager first.'
        : self && !others.length ? (w.preparerSigns && !MONEY_DOCUMENTS.has(w.documentType) ? 'They sign it themselves at submit.' : 'Only they hold it — nobody else can approve.')
        : !others.length ? 'NOBODY — this document will stop here.' : null;
      steps.push({ name: s.name, rule: stepRule(s as StepWithRole), people: others, note });
    }
    routes.push({ documentType: w.documentType, typeLabel: typeLabel(w.documentType), name: w.name, band: bandOf(w.minAmount, w.maxAmount), steps });
  }
  routes.sort((a, b) => a.typeLabel.localeCompare(b.typeLabel));

  // What they may open: every screen, with its View / Manage level.
  const held = new Set(
    (await prisma.rolePermission.findMany({
      where: { role: { users: { some: { userId } } } },
      select: { permission: { select: { key: true } } },
    })).map((p) => p.permission.key),
  );
  const access = REGISTRY.map((m) => ({
    module: m.label,
    screens: m.submodules.filter((s) => !s.hidden).map((s) => {
      const prefix = `${m.key}.${s.key}.`;
      const mine = new Set([...held].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
      const lv = levelsOf(s.actions, mine);
      return { key: `${m.key}.${s.key}`, label: s.label, view: me.isSuperAdmin ? 'all' : lv.view, manage: me.isSuperAdmin ? 'all' : lv.manage, viewLabel: LEVEL_LABELS[me.isSuperAdmin ? 'all' : lv.view], manageLabel: LEVEL_LABELS[me.isSuperAdmin ? 'all' : lv.manage] };
    }),
  }));

  const all = await waitingDocuments(byId);
  const waiting = all.filter((r) => r.waitingOn.some((p) => p.id === userId));
  const raised = all.filter((r) => r.requester.id === userId);

  return {
    person: { id: me.id, name: me.name, email: me.email, team: me.team, isSuperAdmin: me.isSuperAdmin, roles: me.roles.map((r) => r.name), reportsTo: boss ? { id: boss.id, name: boss.name, isActive: boss.isActive } : null },
    checks,
    routes,
    access,
    waitingOnThem: waiting,
    theirsWaiting: raised,
  };
}

export async function healthOverview() {
  const users = await loadUsers();
  const [waiting, routes, setup] = await Promise.all([waitingDocuments(users), routeMap(users), setupIssues(users)]);
  const blocked = waiting.filter((r) => r.problem && r.problem !== 'slow');
  return {
    summary: {
      waiting: waiting.length,
      blocked: blocked.length,
      slow: waiting.filter((r) => r.problem === 'slow').length,
      brokenSteps: routes.reduce((n, r) => n + r.steps.filter((s) => s.problem).length, 0),
      peopleIssues: setup.people.reduce((n, p) => n + p.people.length, 0),
      roleIssues: setup.roles.filter((r) => r.problem).length,
    },
    waiting,
    routes,
    setup,
  };
}

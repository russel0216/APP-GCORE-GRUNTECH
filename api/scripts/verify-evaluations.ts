/**
 * Employee evaluations verification — probation and trainees (item 12).
 *
 *   npx tsx scripts/verify-evaluations.ts      (the API must be running)
 *
 * The arithmetic is asserted directly: when a period ends, which milestones
 * it calls for, what a weighted score comes to, which criteria a form starts
 * with. The rest runs over HTTP and through the approval engine, because that
 * is where the rules that matter live — who can read an evaluation and when,
 * that nothing changes on the employee until the LAST step approves, that the
 * person evaluated can never sit on their own chain, and that a signed form
 * does not change when HR edits the criteria afterwards.
 *
 * The side-effect import below registers the `onApprovalSettled('evaluation')`
 * subscriber in THIS process, so the approvals acted on in-process here reach
 * it. Without it they would settle into the void — see CLAUDE.md.
 */

import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { resolveUser } from '../src/permissions/resolve';
import { act, approvalSlots, pendingFor } from '../src/shared/approvals';
import { globalSearch } from '../src/shared/search';
import { hrSettings } from '../src/shared/hr';
import { addMonths } from '../src/shared/aftermarket';
import { manilaDate } from '../src/shared/day';
import { statusLabel } from '../src/shared/pdf';
import {
  allowedRecommendations,
  dueEvaluations,
  evaluationCriteria,
  evaluationMilestones,
  evaluationScore,
  milestoneLabel,
  milestonesFor,
  probationEnd,
  snapshotLines,
  visibleTo,
  type Criterion,
} from '../src/shared/evaluations';
// Side-effect import: registers the evaluation's settled-approval subscriber.
import '../src/routes/evaluations';
import {
  checkListPaper,
  checkOwnPaper,
  flat,
  names,
  pendingCount,
  printed,
  readScreen,
  roleWords,
  signedCount,
  signoffSlots,
  signs,
  slotsSaid,
  splittingValue,
  words,
} from './lib/paper';

if (env.isProduction) {
  console.error('Refusing to run against a production database.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectRejection(label: string, fn: () => Promise<unknown>, expect: string) {
  try {
    await fn();
    check(label, false, 'it was allowed when it should have been refused');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(label, message.toLowerCase().includes(expect.toLowerCase()), `got: ${message}`);
  }
}

const TAG = 'ZZEV';
const DOMAIN = '@verifyevaluations.local';
const BASE = `http://localhost:${env.port}/api`;
const CRITERIA_KEY = 'hr.evaluationCriteria';

/** The criteria as they stood before this run, restored whatever happens. */
let originalCriteria: Prisma.JsonValue | undefined;

// ── Dates ────────────────────────────────────────────────────────────────────

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date | string | null | undefined) =>
  d == null ? null : (typeof d === 'string' ? d : d.toISOString()).slice(0, 10);

/**
 * Today as a date-only value, the way a @db.Date column stores it, and on the
 * server's rule: the MANILA date. The host's own date agrees only on a host
 * set to Manila time.
 */
const today = () => manilaDate(new Date());
const plusDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
/** An instant at a Manila wall-clock time on a calendar date. */
const manilaAt = (day: Date, hhmm: string) => new Date(`${iso(day)}T${hhmm}:00+08:00`);

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function cleanup() {
  const employees = await prisma.employee.findMany({
    where: { employeeNo: { startsWith: TAG } },
    select: { id: true },
  });
  const employeeIds = employees.map((e) => e.id);
  const evaluations = await prisma.employeeEvaluation.findMany({
    where: { employeeId: { in: employeeIds } },
    select: { id: true },
  });
  const evaluationIds = evaluations.map((e) => e.id);

  if (evaluationIds.length) {
    const requests = await prisma.approvalRequest.findMany({
      where: { documentType: 'evaluation', documentId: { in: evaluationIds } },
      select: { id: true },
    });
    const requestIds = requests.map((r) => r.id);
    await prisma.approvalAction.deleteMany({ where: { requestId: { in: requestIds } } });
    await prisma.approvalRequest.deleteMany({ where: { id: { in: requestIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'evaluation', entityId: { in: evaluationIds } } });
    await prisma.attachment.deleteMany({ where: { entityType: 'evaluation', entityId: { in: evaluationIds } } });
    // Notifications about these evaluations reached real HR and management
    // holders too (the engine and the due-sweep notify every role member).
    for (const id of evaluationIds) {
      await prisma.notification.deleteMany({ where: { link: { contains: id } } });
    }
    await prisma.employeeEvaluation.deleteMany({ where: { id: { in: evaluationIds } } });
  }
  for (const id of employeeIds) {
    await prisma.notification.deleteMany({ where: { link: { contains: id } } });
  }
  if (employeeIds.length) {
    await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
  }

  const users = await prisma.user.findMany({
    where: { email: { endsWith: DOMAIN } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.approvalAction.deleteMany({ where: { approverId: { in: ids } } });
    await prisma.approvalRequest.deleteMany({ where: { requesterId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.userPermissionOverride.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.updateMany({ where: { supervisorId: { in: ids } }, data: { supervisorId: null } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: 'zzev_' } } });

  if (originalCriteria !== undefined) {
    await prisma.setting.update({
      where: { key: CRITERIA_KEY },
      data: { value: originalCriteria as Prisma.InputJsonValue },
    });
  }
}

async function makeRole(key: string, name: string, permissionKeys: string[]) {
  const permissions = await prisma.permission.findMany({
    where: { key: { in: permissionKeys } },
    select: { id: true, key: true },
  });
  if (permissions.length !== permissionKeys.length) {
    const found = new Set(permissions.map((p) => p.key));
    throw new Error(`Unknown permission(s): ${permissionKeys.filter((k) => !found.has(k)).join(', ')}`);
  }
  return prisma.role.create({
    data: { key, name, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } },
  });
}

async function makeUser(name: string, email: string, roleIds: string[]) {
  return prisma.user.create({
    data: {
      name,
      email,
      passwordHash: await bcrypt.hash('x', 10),
      position: `${TAG} tester`,
      roles: { create: roleIds.map((roleId) => ({ roleId })) },
    },
  });
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
  headers: Headers;
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<HttpResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = buffer.toString('latin1');
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(buffer.toString('utf8')) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

interface Line {
  id: string;
  criterionKey: string;
  name: string;
  weight: number;
  rating: number | null;
}

async function pendingRequest(evaluationId: string) {
  return prisma.approvalRequest.findFirst({
    where: { documentType: 'evaluation', documentId: evaluationId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
}

// ── The run ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nG-CORE Evaluations verification\n');
  await cleanup();
  const settings = await hrSettings();

  // ══ 1. The period ════════════════════════════════════════════════════════
  console.log('When a period ends');

  const s6 = { probationMonths: 6, evaluationMilestoneMonths: [3, 5] };
  const jan31 = utc(2026, 1, 31);
  check(
    'probation runs probationMonths from the hire date',
    iso(probationEnd({ employmentType: 'PROBATIONARY', dateHired: utc(2026, 3, 15), periodEndDate: null }, s6)) === '2026-09-15',
  );
  check(
    'a typed period end wins over the computed one — it is where an extension lands',
    iso(probationEnd({ employmentType: 'PROBATIONARY', dateHired: utc(2026, 3, 15), periodEndDate: utc(2026, 11, 30) }, s6)) === '2026-11-30',
  );
  check(
    'a trainee with no period end has no end — there is no statutory one to assume',
    probationEnd({ employmentType: 'TRAINEE', dateHired: utc(2026, 3, 15), periodEndDate: null }, s6) === null,
  );
  check('a regular employee has no period', probationEnd({ employmentType: 'REGULAR', dateHired: jan31, periodEndDate: null }, s6) === null);

  // ══ 2. Milestones ════════════════════════════════════════════════════════
  console.log('\nWhich evaluations a period calls for');

  const ms = evaluationMilestones({ employmentType: 'PROBATIONARY', dateHired: jan31, periodEndDate: null }, s6);
  check(
    'months 3 and 5, then the end — in date order',
    ms.map((m) => m.milestone).join(',') === 'MONTH_3,MONTH_5,END',
    ms.map((m) => m.milestone).join(','),
  );
  check(
    'three months after 31 January is 30 April, not 1 May (addMonths clamps)',
    iso(ms[0].dueDate) === '2026-04-30',
    iso(ms[0].dueDate) ?? '',
  );
  check('the end of a six-month probation from 31 January is 31 July', iso(ms[2].dueDate) === '2026-07-31', iso(ms[2].dueDate) ?? '');
  const short = evaluationMilestones(
    { employmentType: 'PROBATIONARY', dateHired: jan31, periodEndDate: null },
    { probationMonths: 4, evaluationMilestoneMonths: [3, 5] },
  );
  check(
    'a month-5 milestone past a four-month probation is dropped, not clamped',
    short.map((m) => m.milestone).join(',') === 'MONTH_3,END',
    short.map((m) => m.milestone).join(','),
  );
  const trainee = evaluationMilestones({ employmentType: 'TRAINEE', dateHired: jan31, periodEndDate: null }, s6);
  check('a trainee with no period end gets the month milestones and no END', trainee.map((m) => m.milestone).join(',') === 'MONTH_3,MONTH_5');
  check('milestone labels read as words', milestoneLabel('MONTH_3') === 'Month 3' && milestoneLabel('END') === 'End of period' && milestoneLabel('ADHOC') === 'Ad hoc');

  // ══ 3. Outcomes and scoring ══════════════════════════════════════════════
  console.log('\nOutcomes and the score');

  check('probation ends in regularise, extend or end', allowedRecommendations('PROBATIONARY').join(',') === 'REGULARIZE,EXTEND,END');
  check('a trainee is absorbed or ended — never regularised straight from training', allowedRecommendations('TRAINEE').join(',') === 'ABSORB,END');
  check('the score is the weighted mean, to two decimals', evaluationScore([{ weight: 1, rating: 4 }, { weight: 2, rating: 5 }]) === 4.67);
  check(
    'an unrated line is left out rather than counted as zero',
    evaluationScore([{ weight: 1, rating: 4 }, { weight: 1, rating: null }]) === 4,
  );
  check('nothing rated means no score, not zero', evaluationScore([{ weight: 1, rating: null }]) === null);
  check('Decimal weights score like numbers', evaluationScore([{ weight: new Prisma.Decimal('1.5'), rating: 2 }, { weight: new Prisma.Decimal('0.5'), rating: 4 }]) === 2.5);

  // ══ 4. Criteria ══════════════════════════════════════════════════════════
  console.log('\nCriteria, from the seeded Setting');

  const criteria = await evaluationCriteria();
  const liveBoth = criteria.filter((c) => c.isActive && c.appliesTo !== 'TRAINEE').length;
  const liveTrainee = criteria.filter((c) => c.isActive && c.appliesTo !== 'PROBATIONARY').length;
  check('hr.evaluationCriteria is seeded', criteria.length >= 7, String(criteria.length));
  const probLines = snapshotLines(criteria, 'PROBATIONARY');
  const traineeLines = snapshotLines(criteria, 'TRAINEE');
  check('a probationary form takes the BOTH and PROBATIONARY criteria', probLines.length === liveBoth, `${probLines.length} vs ${liveBoth}`);
  check('a trainee form takes the BOTH and TRAINEE criteria', traineeLines.length === liveTrainee, `${traineeLines.length} vs ${liveTrainee}`);
  check(
    'LEARN (trainee only) is on the trainee form and not the probationary one',
    traineeLines.some((l) => l.criterionKey === 'LEARN') && !probLines.some((l) => l.criterionKey === 'LEARN'),
  );
  const synthetic: Criterion[] = [
    { key: 'B', name: 'Second', appliesTo: 'BOTH', weight: 2, sortOrder: 20, isActive: true },
    { key: 'A', name: 'First', appliesTo: 'BOTH', weight: 1, sortOrder: 10, isActive: true },
    { key: 'X', name: 'Retired', appliesTo: 'BOTH', weight: 1, sortOrder: 5, isActive: false },
  ];
  const snap = snapshotLines(synthetic, 'PROBATIONARY');
  check(
    'a retired criterion is not snapshotted, and the rest are numbered 1..n in sort order',
    snap.map((l) => `${l.sortOrder}${l.criterionKey}`).join(',') === '1A,2B',
    snap.map((l) => `${l.sortOrder}${l.criterionKey}`).join(','),
  );

  // ══ HTTP ═════════════════════════════════════════════════════════════════
  if (!(await apiReachable())) {
    console.log('\n  ✗ The API is not running — the HTTP and approval cases were NOT checked.');
    console.log(`    Start it (cd api && npm run dev) and run this script again.\n`);
    failed++;
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exitCode = 1;
    return;
  }

  console.log('\nFixtures');

  const hrRole = await prisma.role.findUnique({ where: { key: 'hr' } });
  const execRole = await prisma.role.findUnique({ where: { key: 'executive' } });
  if (!hrRole || !execRole) throw new Error('The seeded hr/executive roles are missing — run the seed first');
  const workflow = await prisma.approvalWorkflow.findFirst({
    where: { documentType: 'evaluation', isActive: true },
    include: { steps: { orderBy: { sequence: 'asc' }, include: { role: true } } },
  });
  check(
    'the seeded evaluation workflow is HR, then executive',
    !!workflow && workflow.steps.map((s) => (s.approverType === 'ROLE' ? s.role?.key : s.approverType.toLowerCase())).join('>') === 'hr>executive',
    workflow?.steps.map((s) => s.approverType).join('>'),
  );

  // The supervisor's rights, as the seed gives them (VIEW_OWN_SELF).
  const supRole = await makeRole('zzev_supervisor', `${TAG} supervisor`, [
    'ghr.evaluations.view_own', 'ghr.evaluations.create', 'ghr.evaluations.edit_own',
  ]);
  const empRole = await makeRole('zzev_employee', `${TAG} employee`, ['ghr.evaluations.view_own']);

  const supervisor = await makeUser(`${TAG} Supervisor`, `sup${DOMAIN}`, [supRole.id]);
  const subject = await makeUser(`${TAG} Subject`, `subject${DOMAIN}`, [empRole.id]);
  const bystander = await makeUser(`${TAG} Bystander`, `bystander${DOMAIN}`, [empRole.id]);
  const hr = await makeUser(`${TAG} HR Officer`, `hr${DOMAIN}`, [hrRole.id]);
  const hr2 = await makeUser(`${TAG} HR Two`, `hr2${DOMAIN}`, [hrRole.id]);
  const exec = await makeUser(`${TAG} Director`, `exec${DOMAIN}`, [execRole.id]);
  // An HR officer who is on probation — their own evaluation would route to HR.
  const hrSubject = await makeUser(`${TAG} HR Probationer`, `hrsubject${DOMAIN}`, [hrRole.id, empRole.id]);
  // Somebody who joins management AFTER their evaluation was submitted.
  const late = await makeUser(`${TAG} Late Riser`, `late${DOMAIN}`, [empRole.id]);

  const tok = {
    supervisor: signToken(supervisor.id, supervisor.email),
    subject: signToken(subject.id, subject.email),
    bystander: signToken(bystander.id, bystander.email),
    hr: signToken(hr.id, hr.email),
    hr2: signToken(hr2.id, hr2.email),
    exec: signToken(exec.id, exec.email),
  };

  const t = today();
  // Month 3 falls about five days out: hired three months back from five days
  // ahead. addMonths clamps at a month end, so the round trip can come up short
  // (Dec 31 back to Sep 30, forward to Dec 30), and some days — Dec 31, Jul 31,
  // the last days of May — are never a month-3 date at all. So the days are
  // counted to where month 3 really falls: five, or two to four a few days a year.
  const hiredE1 = addMonths(plusDays(t, 5), -3);
  const month3Due = addMonths(hiredE1, 3);
  const month3Days = Math.round((month3Due.getTime() - t.getTime()) / 86_400_000);
  const e1 = await prisma.employee.create({
    data: { employeeNo: `${TAG}-001`, firstName: 'Zia', lastName: 'Probationer', employmentType: 'PROBATIONARY', dateHired: hiredE1, userId: subject.id },
  });
  const e2 = await prisma.employee.create({
    data: {
      employeeNo: `${TAG}-002`, firstName: 'Zed', lastName: 'Trainee', employmentType: 'TRAINEE',
      dateHired: addMonths(t, -2), periodEndDate: plusDays(t, 10),
    },
  });
  const e3 = await prisma.employee.create({
    data: { employeeNo: `${TAG}-003`, firstName: 'Zoe', lastName: 'Regular', employmentType: 'REGULAR', dateHired: addMonths(t, -24) },
  });
  const e4 = await prisma.employee.create({
    data: { employeeNo: `${TAG}-004`, firstName: 'Zak', lastName: 'Hrofficer', employmentType: 'PROBATIONARY', dateHired: addMonths(t, -4), userId: hrSubject.id },
  });
  // The end of probation falls in three days, or fewer at a month end (the
  // same clamp as month 3); nothing below counts on the three.
  const e5 = await prisma.employee.create({
    data: { employeeNo: `${TAG}-005`, firstName: 'Zul', lastName: 'Extendee', employmentType: 'PROBATIONARY', dateHired: addMonths(plusDays(t, 3), -settings.probationMonths) },
  });
  const e7 = await prisma.employee.create({
    data: { employeeNo: `${TAG}-007`, firstName: 'Zen', lastName: 'Lateriser', employmentType: 'PROBATIONARY', dateHired: addMonths(t, -4), userId: late.id },
  });
  check('fixtures created', true);

  // ══ 5. Due, derived on read ══════════════════════════════════════════════
  console.log('\nWho is due');

  const dueDirect = await dueEvaluations({ employeeId: e1.id });
  check(
    `month 3 is due in ${month3Days} days and uncovered`,
    dueDirect.length === 1 && dueDirect[0].milestone === 'MONTH_3' && iso(dueDirect[0].dueDate) === iso(month3Due) &&
      dueDirect[0].daysLeft === month3Days && !dueDirect[0].overdue && dueDirect[0].evaluation === null,
    JSON.stringify(dueDirect.map((r) => [r.milestone, iso(r.dueDate), r.daysLeft, r.evaluation])),
  );
  check('a regular employee is never due', (await dueEvaluations({ employeeId: e3.id })).length === 0);

  // The same milestone read at chosen instants, not at whatever hour this runs
  // — `asOf` is the clock. 00:30 in Manila is 16:30Z the day before: the eight
  // hours a UTC "today" was a day behind the Manila one.
  const month3At = async (at: Date) =>
    (await dueEvaluations({ employeeId: e1.id, asOf: at })).find((r) => r.milestone === 'MONTH_3');
  const atDawn = await month3At(manilaAt(plusDays(month3Due, -5), '00:30'));
  const atNight = await month3At(manilaAt(plusDays(month3Due, -5), '23:30'));
  check(
    'at 00:30 in Manila, with the UTC date still yesterday, month 3 is five days off — as it is at 23:30',
    atDawn?.daysLeft === 5 && atNight?.daysLeft === 5,
    `${atDawn?.daysLeft} at 00:30, ${atNight?.daysLeft} at 23:30`,
  );
  const dayAfter = await month3At(manilaAt(plusDays(month3Due, 1), '00:30'));
  check(
    'at 00:30 on the morning after it fell due it is a day overdue, not "due today"',
    dayAfter?.daysLeft === -1 && dayAfter.overdue,
    JSON.stringify(dayAfter && [dayAfter.daysLeft, dayAfter.overdue]),
  );
  const notice = settings.evaluationNoticeDays;
  const noticeOpens = await month3At(manilaAt(plusDays(month3Due, -notice), '00:30'));
  const eveBefore = await month3At(manilaAt(plusDays(month3Due, -notice - 1), '23:30'));
  check(
    `the ${notice}-day notice is whole Manila days — listed from 00:30 on its first day, not the evening before`,
    noticeOpens?.daysLeft === notice && eveBefore === undefined,
    `${noticeOpens?.daysLeft ?? 'not listed'} at 00:30, ${eveBefore?.daysLeft ?? 'not listed'} the evening before`,
  );
  const tabAtDawn = await milestonesFor(e1.id, manilaAt(plusDays(month3Due, -5), '00:30'));
  check(
    "the employee's Evaluations tab counts the same days at the same hour",
    tabAtDawn?.milestones.find((m) => m.milestone === 'MONTH_3')?.daysLeft === 5,
    JSON.stringify(tabAtDawn?.milestones.map((m) => [m.milestone, m.daysLeft])),
  );

  const due = await api(tok.hr, 'GET', '/evaluations/due');
  const dueRows = (due.body.rows ?? []) as { employee: { id: string }; milestone: string; dueDate: string; evaluation: unknown }[];
  check('GET /evaluations/due lists the probationer at month 3', due.status === 200 && dueRows.some((r) => r.employee.id === e1.id && r.milestone === 'MONTH_3'), `${due.status}`);
  check('and the trainee at the end of the training period', dueRows.some((r) => r.employee.id === e2.id && r.milestone === 'END'));
  check('no stored "due" row — the list is arithmetic over the employee records', (await prisma.employeeEvaluation.count({ where: { employeeId: e1.id } })) === 0);
  const hrNotes = () => prisma.notification.count({ where: { userId: hr.id, type: 'evaluation.due', link: { contains: e1.id } } });
  const notesFirst = await hrNotes();
  await api(tok.hr, 'GET', '/evaluations/due');
  const notesSecond = await hrNotes();
  check('reading the due list tells HR — once per milestone, deduplicated on the link', notesFirst === 1 && notesSecond === 1, `${notesFirst} then ${notesSecond}`);
  const dueSup = await api(tok.supervisor, 'GET', '/evaluations/due');
  check('a supervisor without view_all cannot read the company-wide due list (403)', dueSup.status === 403, String(dueSup.status));

  // ══ 6. Pickers ═══════════════════════════════════════════════════════════
  console.log('\nThe pickers');

  const holders = await fetch(`${BASE}/users/lookup?q=${TAG}&holding=ghr.evaluations.create`, { headers: { Authorization: `Bearer ${tok.hr}` } });
  const holderIds = ((await holders.json()) as { id: string }[]).map((r) => r.id);
  check('the evaluator picker offers the supervisor and not a view-only employee', holderIds.includes(supervisor.id) && !holderIds.includes(bystander.id), JSON.stringify(holderIds.length));
  const lookup = await api(tok.supervisor, 'GET', `/employees/lookup?q=${TAG}&active=true`);
  check('a supervisor holding evaluations.create can look employees up', lookup.status === 200, String(lookup.status));

  // ══ 7. Scheduling and creating ═══════════════════════════════════════════
  console.log('\nScheduling');

  const regular = await api(tok.hr, 'POST', '/evaluations/schedule', { employeeId: e3.id, milestone: 'MONTH_3', evaluatorId: supervisor.id });
  check('a regular employee cannot be put on probation review (400)', regular.status === 400, `${regular.status} ${regular.body.error ?? ''}`);
  const selfEval = await api(tok.hr, 'POST', '/evaluations/schedule', { employeeId: e1.id, milestone: 'MONTH_3', evaluatorId: subject.id });
  check('nobody is made the evaluator of their own evaluation (400)', selfEval.status === 400, String(selfEval.status));
  const forOther = await api(tok.supervisor, 'POST', '/evaluations', { employeeId: e1.id, milestone: 'MONTH_3', evaluatorId: hr.id });
  check('POST opens one for yourself; naming somebody else is scheduling (400)', forOther.status === 400, String(forOther.status));
  const byEmployee = await api(tok.subject, 'POST', '/evaluations', { employeeId: e1.id, milestone: 'MONTH_3' });
  check('an employee holding view_own only cannot open one (403)', byEmployee.status === 403, String(byEmployee.status));

  const scheduled = await api(tok.hr, 'POST', '/evaluations/schedule', { employeeId: e1.id, milestone: 'MONTH_3', evaluatorId: supervisor.id });
  const ev1 = scheduled.body as { id: string; number: string; status: string; dueDate: string; lines: Line[]; evaluator: { id: string } };
  check('HR schedules month 3 for the supervisor (201, SCHEDULED)', scheduled.status === 201 && ev1.status === 'SCHEDULED', `${scheduled.status} ${JSON.stringify(scheduled.body).slice(0, 200)}`);
  check('it is numbered GT-EVAL-YYYY-NNNN by nextNumber', /^GT-EVAL-\d{4}-\d{4}$/.test(String(ev1.number)), String(ev1.number));
  check('its due date is the milestone date, so the due list sees it as covered', iso(ev1.dueDate) === iso(dueDirect[0].dueDate), `${iso(ev1.dueDate)} vs ${iso(dueDirect[0].dueDate)}`);
  check('its lines are the probationary criteria, snapshotted', ev1.lines.length === probLines.length && ev1.lines.every((l, i) => l.criterionKey === probLines[i].criterionKey), String(ev1.lines?.length));
  const supNote = await prisma.notification.count({ where: { userId: supervisor.id, type: 'evaluation.due', link: `/g-hr/evaluations/${ev1.id}` } });
  check('the supervisor is told it is theirs to write', supNote === 1, String(supNote));
  const dup = await api(tok.hr, 'POST', '/evaluations/schedule', { employeeId: e1.id, milestone: 'MONTH_3', evaluatorId: supervisor.id });
  check('a second open evaluation for the same milestone is refused (400)', dup.status === 400, String(dup.status));
  const dueAfter = await dueEvaluations({ employeeId: e1.id });
  check('the milestone is no longer uncovered', dueAfter.length === 0, JSON.stringify(dueAfter.map((r) => r.milestone)));
  const dueCovered = await dueEvaluations({ employeeId: e1.id, includeCovered: true });
  check('but asked for, it is listed with the evaluation that covers it', dueCovered.length === 1 && (dueCovered[0].evaluation?.id ?? '') === ev1.id);

  // ══ 8. Who can see it ════════════════════════════════════════════════════
  console.log('\nVisibility while it is being written');

  const subjGet = await api(tok.subject, 'GET', `/evaluations/${ev1.id}`);
  check('the person evaluated gets a 404 while it is scheduled — not even a 403', subjGet.status === 404, String(subjGet.status));
  const byGet = await api(tok.bystander, 'GET', `/evaluations/${ev1.id}`);
  check('a colleague gets a 404', byGet.status === 404, String(byGet.status));
  const supGet = await api(tok.supervisor, 'GET', `/evaluations/${ev1.id}`);
  check('the evaluator reads it and may edit it', supGet.status === 200 && supGet.body.canEdit === true, `${supGet.status} ${supGet.body.canEdit}`);
  const subjList = await api(tok.subject, 'GET', '/evaluations');
  check('the subject\'s list does not carry it', subjList.status === 200 && !((subjList.body.rows ?? []) as { id: string }[]).some((r) => r.id === ev1.id));
  const supList = await api(tok.supervisor, 'GET', '/evaluations?scope=mine');
  check('the evaluator\'s list does', ((supList.body.rows ?? []) as { id: string }[]).some((r) => r.id === ev1.id));
  const pdfEarly = await api(tok.subject, 'GET', `/evaluations/${ev1.id}/pdf`);
  check('nor can the subject print it (404)', pdfEarly.status === 404, String(pdfEarly.status));

  // The generic attachment routes ask the evaluation's own visibility rule
  // (registerAttachmentGuard), so a file on it is no easier to reach than it.
  const fileRow = await prisma.attachment.create({
    data: {
      entityType: 'evaluation',
      entityId: ev1.id,
      fileName: `${TAG}-memo.pdf`,
      storedName: `${TAG}-not-on-disk.pdf`,
      mimeType: 'application/pdf',
      size: 1,
      uploadedById: hr.id,
    },
  });
  const byFiles = await api(tok.bystander, 'GET', `/attachments/evaluation/${ev1.id}`);
  check('a colleague cannot list the files on it (404)', byFiles.status === 404, String(byFiles.status));
  const supFiles = await api(tok.supervisor, 'GET', `/attachments/evaluation/${ev1.id}`);
  check('the evaluator can', supFiles.status === 200 && supFiles.text.includes(fileRow.id), String(supFiles.status));
  const byFile = await api(tok.bystander, 'GET', `/attachments/file/${fileRow.id}`);
  check('nor fetch one by its id', byFile.status === 404 && /Attachment not found/.test(String(byFile.body.error)), `${byFile.status} ${byFile.body.error}`);
  const subjFile = await api(tok.subject, 'GET', `/attachments/file/${fileRow.id}`);
  check('nor can the subject while it is unapproved', subjFile.status === 404 && /Attachment not found/.test(String(subjFile.body.error)), `${subjFile.status} ${subjFile.body.error}`);
  const supFile = await api(tok.supervisor, 'GET', `/attachments/file/${fileRow.id}`);
  check('the evaluator gets past the guard (here to the missing-file 404)', /missing from disk/.test(String(supFile.body.error)), `${supFile.status} ${supFile.body.error}`);
  const byUpload = await api(tok.bystander, 'POST', `/attachments/evaluation/${ev1.id}`);
  check('and a colleague cannot add a file to it (404)', byUpload.status === 404, String(byUpload.status));
  await prisma.attachment.delete({ where: { id: fileRow.id } });

  const subjectUser = (await resolveUser(subject.id))!;
  const supUser = (await resolveUser(supervisor.id))!;
  const hrUser = (await resolveUser(hr.id))!;
  const shape = (status: string) => ({ status, evaluatorId: supervisor.id, scheduledById: hr.id, employee: { userId: subject.id } });
  check('visibleTo: the subject sees it only once APPROVED',
    !visibleTo(subjectUser, shape('DRAFT')) && !visibleTo(subjectUser, shape('PENDING_APPROVAL')) && visibleTo(subjectUser, shape('APPROVED')));
  check('visibleTo: the evaluator at every stage, HR with view_all always',
    visibleTo(supUser, shape('DRAFT')) && visibleTo(supUser, shape('REJECTED')) && visibleTo(hrUser, shape('SCHEDULED')));

  // ══ 9. Writing it ════════════════════════════════════════════════════════
  console.log('\nWriting it');

  const early = await api(tok.supervisor, 'POST', `/evaluations/${ev1.id}/submit`);
  check('an unrated form cannot be submitted (400)', early.status === 400, String(early.status));
  const tooHigh = await api(tok.supervisor, 'PATCH', `/evaluations/${ev1.id}`, { lines: [{ id: ev1.lines[0].id, rating: settings.ratingScale + 1 }] });
  check(`a rating over ${settings.ratingScale} is refused (400)`, tooHigh.status === 400, String(tooHigh.status));
  const wrongRec = await api(tok.supervisor, 'PATCH', `/evaluations/${ev1.id}`, { recommendation: 'ABSORB' });
  check('ABSORB is not a probationary outcome (400)', wrongRec.status === 400, String(wrongRec.status));
  const byOther = await api(tok.bystander, 'PATCH', `/evaluations/${ev1.id}`, { comments: 'x' });
  check('a colleague cannot write on it (403 — they lack edit rights)', byOther.status === 403, String(byOther.status));

  const ratings = ev1.lines.map((l, i) => ({ id: l.id, rating: [5, 4, 4, 3, 5, 4, 3][i] ?? 4, remarks: i === 0 ? 'Neat work' : undefined }));
  const expected = evaluationScore(ev1.lines.map((l, i) => ({ weight: l.weight, rating: ratings[i].rating })));
  const filled = await api(tok.supervisor, 'PATCH', `/evaluations/${ev1.id}`, {
    lines: ratings,
    strengths: 'Careful with the plant',
    recommendation: 'REGULARIZE',
  });
  check('the evaluator rates it; the first save turns SCHEDULED into DRAFT', filled.status === 200 && filled.body.status === 'DRAFT', `${filled.status} ${filled.body.status}`);
  check('the score is recomputed on the server from the saved lines', filled.body.score === expected, `${filled.body.score} vs ${expected}`);

  const audits = await prisma.auditLog.findMany({ where: { entityType: 'evaluation', entityId: ev1.id } });
  check(
    'no audit row carries a before or after — ratings never reach the audit log',
    audits.length >= 2 && audits.every((a) => a.before === null && a.after === null),
    JSON.stringify(audits.map((a) => [a.action, a.before, a.after])),
  );
  check('the edit is audited by summary only', audits.some((a) => a.action === 'UPDATED' && /criteria rated/.test(a.summary ?? '')));

  // ══ 10. Criteria edited afterwards ═══════════════════════════════════════
  console.log('\nThe snapshot');

  const settingRow = await prisma.setting.findUnique({ where: { key: CRITERIA_KEY } });
  originalCriteria = settingRow?.value ?? null;
  const edited = (criteria as Criterion[]).map((c) => (c.key === ev1.lines[0].criterionKey ? { ...c, name: `${TAG} renamed`, weight: 3 } : c));
  const put = await api(tok.hr, 'PUT', `/hr-settings/lists/${CRITERIA_KEY}`, { rows: edited });
  if (put.status !== 200) {
    // HR without settings rights on this install — edit it directly; the point
    // is what the evaluation does, not who may edit the list.
    await prisma.setting.update({ where: { key: CRITERIA_KEY }, data: { value: edited as unknown as Prisma.InputJsonValue } });
  }
  const afterEdit = await api(tok.supervisor, 'GET', `/evaluations/${ev1.id}`);
  const firstLine = ((afterEdit.body.lines ?? []) as Line[])[0];
  check(
    'editing hr.evaluationCriteria after an evaluation exists leaves its lines unchanged',
    firstLine?.name === ev1.lines[0].name && firstLine?.weight === ev1.lines[0].weight && afterEdit.body.score === expected,
    `${firstLine?.name} w${firstLine?.weight}`,
  );
  await prisma.setting.update({ where: { key: CRITERIA_KEY }, data: { value: originalCriteria as Prisma.InputJsonValue } });

  // ══ 10b. On paper before it is submitted ══════════════════════════════════
  // Evaluated by the evaluator — Pending until the submission signs it — then
  // every step of the route submitting would take, in the step's own name,
  // each Pending under who may sign it, and the subject's acknowledgement
  // last. No "Reviewed by (HR)" / "Approved by" of the document's own.
  console.log('\nThe draft on paper');
  const steps = workflow?.steps ?? [];
  const pdfOf = (token: string, id: string) => printed(token, `/evaluations/${id}/pdf`);
  const draftPdf = await pdfOf(tok.supervisor, ev1.id);
  const draftSlots = signoffSlots(draftPdf.text, 'EVALUATED BY');
  check(
    'a draft prints the route it would take: Evaluated by the supervisor, then HR review and management approval in capitals, then the acknowledgement — all Pending',
    draftPdf.status === 200 &&
      steps.length === 2 &&
      draftSlots.length === 2 + steps.length &&
      signs(draftSlots[0], 'Evaluated by', supervisor.name) &&
      steps.every((st, i) => draftSlots[i + 1].text.startsWith(roleWords(st.name))) &&
      draftSlots[draftSlots.length - 1].text.startsWith('ACKNOWLEDGED BY') &&
      draftSlots.every((sl) => !sl.signed) &&
      pendingCount(draftPdf.text) === 2 + steps.length &&
      signedCount(draftPdf.text) === 0,
    `${draftPdf.status} ${slotsSaid(draftSlots)}`,
  );
  check(
    '…the open steps name who may sign them, and no step is signed in the document\'s own words',
    // In the step's own slot, read as words: a name wraps in a narrow column.
    names(draftSlots[1], hr.name) &&
      names(draftSlots[2], exec.name) &&
      !flat(draftPdf.text).includes('REVIEWED BY') &&
      !flat(draftPdf.text).includes('APPROVED BY'),
    slotsSaid(draftSlots),
  );
  check(
    'its status is a word ("Status: Draft") and its criteria are counted under "No."',
    flat(draftPdf.text).includes('Status: Draft') && draftPdf.text.includes('NO.') && !draftPdf.text.includes('DRAFT\n'),
    draftPdf.text.split('\n').filter((l) => /Status|NO\./.test(l)).join(' | '),
  );

  // ══ 11. Submitting ═══════════════════════════════════════════════════════
  console.log('\nSubmitting and the chain');

  const submitted = await api(tok.supervisor, 'POST', `/evaluations/${ev1.id}/submit`);
  check('the supervisor submits it (PENDING_APPROVAL)', submitted.status === 200 && submitted.body.status === 'PENDING_APPROVAL', `${submitted.status} ${submitted.body.error ?? submitted.body.status}`);
  const req1 = await pendingRequest(ev1.id);
  check('through the approval engine, raised by the evaluator', !!req1 && req1.requesterId === supervisor.id && req1.currentSequence === 1);
  const locked = await api(tok.supervisor, 'PATCH', `/evaluations/${ev1.id}`, { comments: 'late thought' });
  check('a submitted evaluation cannot be edited (400)', locked.status === 400, String(locked.status));
  const subjPending = await api(tok.subject, 'GET', `/evaluations/${ev1.id}`);
  check('the subject still gets a 404 while it is pending', subjPending.status === 404, String(subjPending.status));
  const hrQueue = await api(tok.hr, 'GET', '/approvals/pending');
  check('it is in HR\'s queue', JSON.stringify(hrQueue.body).includes(ev1.number));

  const step1 = await api(tok.hr, 'POST', `/approvals/${req1!.id}/act`, { action: 'APPROVED' });
  check('HR reviews it (step 1 of 2)', step1.status === 200, `${step1.status} ${step1.body.error ?? ''}`);
  const midway = await prisma.employee.findUniqueOrThrow({ where: { id: e1.id } });
  const evMid = await prisma.employeeEvaluation.findUniqueOrThrow({ where: { id: ev1.id } });
  check(
    'after HR alone nothing has changed — the employee is still probationary',
    midway.employmentType === 'PROBATIONARY' && midway.dateRegularized === null && evMid.status === 'PENDING_APPROVAL',
    `${midway.employmentType} ${evMid.status}`,
  );
  const selfAct = await api(tok.supervisor, 'POST', `/approvals/${req1!.id}/act`, { action: 'APPROVED' });
  check('the evaluator cannot approve their own submission (403)', selfAct.status === 403, String(selfAct.status));
  const step2 = await api(tok.exec, 'POST', `/approvals/${req1!.id}/act`, { action: 'APPROVED' });
  check('management approves (step 2 of 2)', step2.status === 200, `${step2.status} ${step2.body.error ?? ''}`);

  const regularised = await prisma.employee.findUniqueOrThrow({ where: { id: e1.id } });
  const evDone = await prisma.employeeEvaluation.findUniqueOrThrow({ where: { id: ev1.id } });
  check('the evaluation is APPROVED', evDone.status === 'APPROVED' && evDone.approvedAt !== null, evDone.status);
  check(
    'REGULARIZE made the employee REGULAR with a regularisation date — an approved document, not a field edit',
    regularised.employmentType === 'REGULAR' && regularised.dateRegularized !== null && regularised.periodEndDate === null,
    `${regularised.employmentType} ${iso(regularised.dateRegularized)}`,
  );
  check(
    'with no effective date typed, it takes effect the day it was approved — the Manila date',
    iso(regularised.dateRegularized) === iso(today()) && iso(evDone.effectiveDate) === iso(today()),
    `${iso(regularised.dateRegularized)} / ${iso(evDone.effectiveDate)} vs ${iso(today())}`,
  );
  check('the hire date is untouched', iso(regularised.dateHired) === iso(hiredE1));

  // ══ 12. The subject reads it ═════════════════════════════════════════════
  console.log('\nOnce approved');

  const subjRead = await api(tok.subject, 'GET', `/evaluations/${ev1.id}`);
  check('the person evaluated now reads it (200)', subjRead.status === 200 && subjRead.body.isSubject === true, String(subjRead.status));
  check('and is told it is ready', (await prisma.notification.count({ where: { userId: subject.id, link: `/g-hr/evaluations/${ev1.id}` } })) >= 1);
  const subjList2 = await api(tok.subject, 'GET', '/evaluations');
  check('it is in their list now', ((subjList2.body.rows ?? []) as { id: string }[]).some((r) => r.id === ev1.id));
  const supAck = await api(tok.supervisor, 'POST', `/evaluations/${ev1.id}/acknowledge`, {});
  check('only the person evaluated can acknowledge it (403)', supAck.status === 403, String(supAck.status));
  const ack = await api(tok.subject, 'POST', `/evaluations/${ev1.id}/acknowledge`, { note: 'Thank you' });
  check('they acknowledge it', ack.status === 200 && !!ack.body.employeeAcknowledgedAt, String(ack.status));
  const ack2 = await api(tok.subject, 'POST', `/evaluations/${ev1.id}/acknowledge`, {});
  check('once', ack2.status === 400, String(ack2.status));
  const cancelApproved = await api(tok.supervisor, 'POST', `/evaluations/${ev1.id}/cancel`);
  check('an approved evaluation cannot be cancelled (400)', cancelApproved.status === 400, String(cancelApproved.status));

  const slots = await approvalSlots('evaluation', ev1.id);
  check(
    'the sign-offs are HR then management, each in its step\'s name and dated',
    slots.length === 2 &&
      slots[0].name === hr.name &&
      slots[1].name === exec.name &&
      slots.every((sl, i) => sl.step === steps[i]?.name && sl.at instanceof Date),
    JSON.stringify(slots.map((sl) => [sl.step, sl.name])),
  );
  const pdf = await printed(tok.subject, `/evaluations/${ev1.id}/pdf`);
  check('it prints through renderDocument (a PDF)', pdf.status === 200 && pdf.type.includes('application/pdf') && pdf.bytes?.subarray(0, 4).toString() === '%PDF', `${pdf.status} ${pdf.type}`);
  const signedText = pdf.text;
  const signedSlots = signoffSlots(signedText, 'EVALUATED BY');
  check(
    'approved and acknowledged, it prints all four people dated, each under their own role — evaluator, HR, management, the subject — and nothing Pending',
    signedSlots.length === 2 + steps.length &&
      signedSlots.every((sl) => sl.signed) &&
      signs(signedSlots[0], 'Evaluated by', supervisor.name) &&
      signs(signedSlots[1], steps[0]?.name ?? '', hr.name) &&
      signs(signedSlots[2], steps[1]?.name ?? '', exec.name) &&
      signedSlots[3].text.startsWith('ACKNOWLEDGED BY') &&
      signedCount(signedText) === 2 + steps.length &&
      pendingCount(signedText) === 0 &&
      flat(signedText).includes('Status: Approved'),
    slotsSaid(signedSlots),
  );
  check('both prints are audited', (await prisma.auditLog.count({ where: { entityType: 'evaluation', entityId: ev1.id, action: 'EXPORTED' } })) === 2);

  const hits = await globalSearch(ev1.number, hrUser);
  const hitsName = await globalSearch('Probationer', hrUser);
  check('no evaluation surfaces in global search', !hits.some((h) => h.id === ev1.id) && !hitsName.some((h) => h.id === ev1.id), JSON.stringify(hits.map((h) => h.kind)));

  // ══ 13. A trainee: returned, resubmitted, absorbed ═══════════════════════
  console.log('\nA trainee');

  const tr = await api(tok.hr, 'POST', '/evaluations', { employeeId: e2.id, milestone: 'END' });
  const ev2 = tr.body as { id: string; number: string; status: string; kind: string; lines: Line[]; dueDate: string };
  check('HR opens an END evaluation for themselves (DRAFT, kind TRAINEE)', tr.status === 201 && ev2.status === 'DRAFT' && ev2.kind === 'TRAINEE', `${tr.status} ${tr.body.error ?? ''}`);
  check('the trainee form carries LEARN', ev2.lines.some((l) => l.criterionKey === 'LEARN') && ev2.lines.length === traineeLines.length);
  check('its due date is the typed period end', iso(ev2.dueDate) === iso(e2.periodEndDate));
  const regTrainee = await api(tok.hr, 'PATCH', `/evaluations/${ev2.id}`, { recommendation: 'REGULARIZE' });
  check('a trainee cannot be regularised directly (400)', regTrainee.status === 400, String(regTrainee.status));
  const effective = plusDays(t, 11);
  await api(tok.hr, 'PATCH', `/evaluations/${ev2.id}`, {
    lines: ev2.lines.map((l) => ({ id: l.id, rating: 4 })),
    recommendation: 'ABSORB',
    effectiveDate: iso(effective),
  });
  const trSubmit = await api(tok.hr, 'POST', `/evaluations/${ev2.id}/submit`);
  check('HR submits it', trSubmit.status === 200 && trSubmit.body.status === 'PENDING_APPROVAL', `${trSubmit.status} ${trSubmit.body.error ?? ''}`);
  const req2 = await pendingRequest(ev2.id);
  await expectRejection('the HR officer who raised it cannot review it — the engine says so', () => act({ requestId: req2!.id, userId: hr.id, action: 'APPROVED' }), 'raised yourself');

  await act({ requestId: req2!.id, userId: hr2.id, action: 'RETURNED', comment: 'Add remarks' });
  const returned = await prisma.employeeEvaluation.findUniqueOrThrow({ where: { id: ev2.id } });
  check('a RETURNED evaluation goes back to the evaluator as a DRAFT, not closed', returned.status === 'DRAFT' && returned.submittedAt === null, returned.status);
  const edit2 = await api(tok.hr, 'PATCH', `/evaluations/${ev2.id}`, { comments: 'Remarks added' });
  check('and can be corrected', edit2.status === 200, String(edit2.status));
  const resubmit = await api(tok.hr, 'POST', `/evaluations/${ev2.id}/submit`);
  check('and resubmitted', resubmit.status === 200 && resubmit.body.status === 'PENDING_APPROVAL', `${resubmit.status} ${resubmit.body.error ?? ''}`);
  const req2b = await pendingRequest(ev2.id);
  await act({ requestId: req2b!.id, userId: hr2.id, action: 'APPROVED' });
  const traineeMid = await prisma.employee.findUniqueOrThrow({ where: { id: e2.id } });
  check('still a trainee after HR alone', traineeMid.employmentType === 'TRAINEE');
  await act({ requestId: req2b!.id, userId: exec.id, action: 'APPROVED' });

  const absorbed = await prisma.employee.findUniqueOrThrow({ where: { id: e2.id } });
  check('ABSORB moves the trainee to PROBATIONARY', absorbed.employmentType === 'PROBATIONARY', absorbed.employmentType);
  check(
    `with a fresh ${settings.probationMonths}-month period from the effective date`,
    iso(absorbed.periodEndDate) === iso(addMonths(effective, settings.probationMonths)),
    `${iso(absorbed.periodEndDate)} vs ${iso(addMonths(effective, settings.probationMonths))}`,
  );
  check('and the hire date unchanged', iso(absorbed.dateHired) === iso(e2.dateHired));
  const picture = await milestonesFor(e2.id);
  check(
    'the new probation counts its milestones from the absorption, not the hire',
    !!picture && picture.kind === 'PROBATIONARY' && iso(picture.anchor) === iso(effective) &&
      picture.milestones[0]?.milestone === `MONTH_${settings.evaluationMilestoneMonths[0]}` &&
      iso(picture.milestones[0]?.dueDate) === iso(addMonths(effective, settings.evaluationMilestoneMonths[0])),
    JSON.stringify(picture?.milestones.map((m) => [m.milestone, iso(m.dueDate)])),
  );
  check('and none of them is covered by the trainee evaluation', !!picture && picture.milestones.every((m) => m.evaluation === null));

  // ══ 14. An extension ═════════════════════════════════════════════════════
  console.log('\nAn extension');

  const endE5 = probationEnd({ employmentType: 'PROBATIONARY', dateHired: e5.dateHired, periodEndDate: null }, settings)!;
  const sched5 = await api(tok.hr, 'POST', '/evaluations/schedule', { employeeId: e5.id, milestone: 'END', evaluatorId: supervisor.id });
  const ev5 = sched5.body as { id: string; lines: Line[] };
  check('HR schedules the end-of-probation evaluation', sched5.status === 201, `${sched5.status} ${sched5.body.error ?? ''}`);
  await api(tok.supervisor, 'PATCH', `/evaluations/${ev5.id}`, {
    lines: ev5.lines.map((l) => ({ id: l.id, rating: 3 })),
    recommendation: 'EXTEND',
    extendedTo: iso(endE5),
  });
  const badExtend = await api(tok.supervisor, 'POST', `/evaluations/${ev5.id}/submit`);
  check('an extension to a date that is not later than the current end is refused (400)', badExtend.status === 400, String(badExtend.status));
  const newEnd = addMonths(endE5, 2);
  await api(tok.supervisor, 'PATCH', `/evaluations/${ev5.id}`, { extendedTo: iso(newEnd) });
  const ok5 = await api(tok.supervisor, 'POST', `/evaluations/${ev5.id}/submit`);
  check('an extension two months out is submitted', ok5.status === 200, `${ok5.status} ${ok5.body.error ?? ''}`);
  const req5 = await pendingRequest(ev5.id);
  await act({ requestId: req5!.id, userId: hr.id, action: 'APPROVED' });
  await act({ requestId: req5!.id, userId: exec.id, action: 'APPROVED' });
  const extended = await prisma.employee.findUniqueOrThrow({ where: { id: e5.id } });
  check('EXTEND writes the new period end on the employee', iso(extended.periodEndDate) === iso(newEnd) && extended.employmentType === 'PROBATIONARY', iso(extended.periodEndDate) ?? 'null');
  const picture5 = await milestonesFor(e5.id);
  const end5 = picture5?.milestones.find((m) => m.milestone === 'END');
  check(
    'the END milestone moves to the new date and is due again — the old evaluation does not cover it',
    !!end5 && iso(end5.dueDate) === iso(newEnd) && end5.evaluation === null,
    JSON.stringify(end5),
  );

  // ══ 15. The subject is never on the chain ════════════════════════════════
  console.log('\nThe subject is never an approver');

  const sched4 = await api(tok.hr2, 'POST', '/evaluations/schedule', { employeeId: e4.id, milestone: 'ADHOC', evaluatorId: supervisor.id });
  const ev4 = sched4.body as { id: string; dueDate: string; lines: Line[] };
  check('an ad hoc evaluation of an HR officer on probation is scheduled', sched4.status === 201, `${sched4.status} ${sched4.body.error ?? ''}`);
  check(
    'given no date, an ad hoc evaluation is due today — the Manila date, not the UTC one',
    iso(ev4.dueDate) === iso(today()),
    `${iso(ev4.dueDate)} vs ${iso(today())}`,
  );
  await api(tok.supervisor, 'PATCH', `/evaluations/${ev4.id}`, { lines: ev4.lines.map((l) => ({ id: l.id, rating: 4 })), recommendation: 'REGULARIZE' });
  const sub4 = await api(tok.supervisor, 'POST', `/evaluations/${ev4.id}/submit`);
  check(
    'submitting refuses: the HR step would route to the person being evaluated',
    sub4.status === 400 && /person being evaluated/.test(String(sub4.body.error ?? sub4.text)),
    `${sub4.status} ${sub4.body.error ?? ''}`,
  );
  check('and it stays a draft', (await prisma.employeeEvaluation.findUniqueOrThrow({ where: { id: ev4.id } })).status === 'DRAFT');

  // The routing was clean at submission; the subject was given the management
  // role before the decision. The engine lets them act (they are eligible and
  // not the requester) — the subscriber is what refuses to apply it.
  const sched7 = await api(tok.hr, 'POST', '/evaluations/schedule', { employeeId: e7.id, milestone: 'ADHOC', evaluatorId: supervisor.id });
  const ev7 = sched7.body as { id: string; lines: Line[] };
  await api(tok.supervisor, 'PATCH', `/evaluations/${ev7.id}`, { lines: ev7.lines.map((l) => ({ id: l.id, rating: 5 })), recommendation: 'REGULARIZE' });
  const sub7 = await api(tok.supervisor, 'POST', `/evaluations/${ev7.id}/submit`);
  check('a clean evaluation is submitted', sub7.status === 200, `${sub7.status} ${sub7.body.error ?? ''}`);
  const req7 = await pendingRequest(ev7.id);
  await act({ requestId: req7!.id, userId: hr.id, action: 'APPROVED' });
  await prisma.userRole.create({ data: { userId: late.id, roleId: execRole.id } });
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    await act({ requestId: req7!.id, userId: late.id, action: 'APPROVED' });
  } finally {
    console.error = originalError;
  }
  const e7After = await prisma.employee.findUniqueOrThrow({ where: { id: e7.id } });
  const ev7After = await prisma.employeeEvaluation.findUniqueOrThrow({ where: { id: ev7.id } });
  check(
    'approved by its own subject, the evaluation is NOT applied — the employee stays probationary',
    e7After.employmentType === 'PROBATIONARY' && e7After.dateRegularized === null && ev7After.status === 'REJECTED',
    `${e7After.employmentType} ${ev7After.status}`,
  );
  check('and it says so loudly', errors.some((m) => m.includes('approved by its own subject')), errors.join(' | ').slice(0, 200));
  await prisma.userRole.deleteMany({ where: { userId: late.id, roleId: execRole.id } });
  const refusedPdf = await pdfOf(tok.supervisor, ev7.id);
  const refusedSlots = signoffSlots(refusedPdf.text, 'EVALUATED BY');
  check(
    'on paper the signatures stand as given — evaluator, HR, the subject on the management step, all dated — no acknowledgement and nothing Pending',
    refusedPdf.status === 200 &&
      refusedSlots.length === 1 + steps.length &&
      refusedSlots.every((sl) => sl.signed) &&
      signs(refusedSlots[1], steps[0]?.name ?? '', hr.name) &&
      signs(refusedSlots[2], steps[1]?.name ?? '', late.name) &&
      pendingCount(refusedPdf.text) === 0 &&
      !flat(refusedPdf.text).includes('ACKNOWLEDGED BY'),
    `${refusedPdf.status} ${slotsSaid(refusedSlots)}`,
  );
  check(
    '…"Status: Rejected", and its Decision line says the subject signed it, so nothing was applied',
    flat(refusedPdf.text).includes('Status: Rejected') &&
      flat(refusedPdf.text).includes('DECISION') &&
      words(refusedPdf.text).includes(words('Not applied: Zen Lateriser signed their own evaluation')),
    refusedPdf.text.split('\n').filter((l) => /Status|applied|DECISION/.test(l)).join(' | ').slice(0, 240),
  );

  // ══ 15b. Rejected at the management step, on paper ═══════════════════════
  // A rejection closes the evaluation for good. The steps that signed stand,
  // dated; the step that rejected it prints no slot — "Pending" there would
  // promise a signature nobody is going to give — and neither does the
  // acknowledgement. The Decision line says who rejected it, where and why.
  console.log('\nRejected by management, on paper');
  const sched9 = await api(tok.hr, 'POST', '/evaluations/schedule', { employeeId: e7.id, milestone: 'ADHOC', evaluatorId: supervisor.id });
  const ev9 = sched9.body as { id: string; lines: Line[] };
  await api(tok.supervisor, 'PATCH', `/evaluations/${ev9.id}`, { lines: (ev9.lines ?? []).map((l) => ({ id: l.id, rating: 2 })), recommendation: 'REGULARIZE' });
  const sub9 = await api(tok.supervisor, 'POST', `/evaluations/${ev9.id}/submit`);
  const req9 = await pendingRequest(ev9.id);
  if (req9) {
    await act({ requestId: req9.id, userId: hr.id, action: 'APPROVED' });
    await act({ requestId: req9.id, userId: exec.id, action: 'REJECTED', comment: 'Not ready to regularise yet' });
  }
  const ev9After = await prisma.employeeEvaluation.findUniqueOrThrow({ where: { id: ev9.id } });
  check(
    'HR signs it, management rejects it: REJECTED, closed',
    sched9.status === 201 && sub9.status === 200 && !!req9 && ev9After.status === 'REJECTED',
    `schedule ${sched9.status}, submit ${sub9.status} ${sub9.body.error ?? ''}, ${ev9After.status}`,
  );
  const rejectedPdf = await pdfOf(tok.supervisor, ev9.id);
  const rejectedSlots = signoffSlots(rejectedPdf.text, 'EVALUATED BY');
  check(
    'it prints the evaluator and the HR step that signed, both dated — and no slot Pending under management, nor an acknowledgement',
    rejectedPdf.status === 200 &&
      rejectedSlots.length === 2 &&
      rejectedSlots.every((sl) => sl.signed) &&
      signs(rejectedSlots[0], 'Evaluated by', supervisor.name) &&
      signs(rejectedSlots[1], steps[0]?.name ?? '', hr.name) &&
      !rejectedSlots.some((sl) => sl.text.startsWith(roleWords(steps[1]?.name ?? ''))) &&
      pendingCount(rejectedPdf.text) === 0 &&
      !flat(rejectedPdf.text).includes('ACKNOWLEDGED BY'),
    `${rejectedPdf.status} ${slotsSaid(rejectedSlots)}`,
  );
  check(
    '…"Status: Rejected", and its Decision line names the step, who rejected it and why',
    flat(rejectedPdf.text).includes('Status: Rejected') &&
      words(rejectedPdf.text).includes(words(`Rejected at ${steps[1]?.name ?? ''} by ${exec.name}`)) &&
      flat(rejectedPdf.text).includes('Not ready to regularise yet'),
    rejectedPdf.text.split('\n').filter((l) => /Status|Rejected/.test(l)).join(' | ').slice(0, 240),
  );

  // ══ 16. Cancel ═══════════════════════════════════════════════════════════
  console.log('\nCancelling');

  const cancelByOther = await api(tok.bystander, 'POST', `/evaluations/${ev4.id}/cancel`);
  check('a colleague cannot cancel it (403 or 404)', cancelByOther.status === 403 || cancelByOther.status === 404, String(cancelByOther.status));
  const cancelled = await api(tok.supervisor, 'POST', `/evaluations/${ev4.id}/cancel`);
  check('the evaluator cancels a draft', cancelled.status === 200 && cancelled.body.status === 'CANCELLED', String(cancelled.status));
  const due4 = await dueEvaluations({ employeeId: e4.id, asOf: addMonths(t, 3) });
  check('a cancelled evaluation covers nothing — the milestones stay due', due4.length > 0 && due4.every((r) => r.evaluation === null), JSON.stringify(due4.map((r) => r.milestone)));

  // Cancelled while HR has it: the request is withdrawn through the engine,
  // not closed by hand — out of HR's queue, and HR told. The person evaluated
  // is neither the requester nor on the chain, so they hear nothing.
  const sched8 = await api(tok.hr, 'POST', '/evaluations/schedule', { employeeId: e7.id, milestone: 'ADHOC', evaluatorId: supervisor.id });
  const ev8 = sched8.body as { id: string; number: string; lines: Line[] };
  await api(tok.supervisor, 'PATCH', `/evaluations/${ev8.id}`, { lines: (ev8.lines ?? []).map((l) => ({ id: l.id, rating: 4 })), recommendation: 'REGULARIZE' });
  const sub8 = await api(tok.supervisor, 'POST', `/evaluations/${ev8.id}/submit`);
  const req8 = await pendingRequest(ev8.id);
  const queued8 = !!req8 && (await pendingFor(hr.id)).some((r) => r.id === req8.id);
  const cancel8 = await api(tok.supervisor, 'POST', `/evaluations/${ev8.id}/cancel`);
  const closed8 = req8 ? await prisma.approvalRequest.findUnique({ where: { id: req8.id } }) : null;
  check(
    'the evaluator cancels a submitted evaluation; its request closes CANCELLED',
    cancel8.status === 200 && cancel8.body.status === 'CANCELLED' && closed8?.status === 'CANCELLED' && !!closed8.closedAt,
    `submit ${sub8.status} ${sub8.body.error ?? ''}; cancel ${cancel8.status}; request ${closed8?.status ?? 'none was open'}`,
  );
  check("it leaves HR's queue", queued8 && !(await pendingFor(hr.id)).some((r) => r.id === req8?.id));
  const told8 = await prisma.notification.findMany({ where: { type: 'approval.withdrawn', link: `/g-hr/evaluations/${ev8.id}` } });
  check(
    'HR is told it was withdrawn, and by whom',
    told8.some((n) => n.userId === hr.id && n.body === `${ev8.number} — cancelled by ${supervisor.name}`),
    JSON.stringify(told8.map((n) => n.body)),
  );
  check(
    'the evaluator who cancelled it is not told, and the person evaluated hears nothing of it',
    told8.length > 0 && !told8.some((n) => n.userId === supervisor.id || n.userId === late.id),
  );
  const trail8 = await prisma.auditLog.findMany({ where: { entityType: 'evaluation', entityId: ev8.id, action: 'CANCELLED' } });
  check(
    "the trail keeps the engine's withdrawal and the evaluation's own cancellation, neither carrying a rating",
    trail8.length === 2 &&
      trail8.some((a) => !!a.summary?.startsWith('Withdrawn from approval at ') && a.summary.endsWith(` — cancelled by ${supervisor.name}`)) &&
      trail8.some((a) => a.summary === `${ev8.number} cancelled`) &&
      trail8.every((a) => a.actorId === supervisor.id && a.before === null && a.after === null),
    JSON.stringify(trail8.map((a) => [a.summary, a.before, a.after])),
  );


  // Cancelled after HR signed, while management has it. The Paper rule: a
  // cancelled document prints only the steps that really signed. HR's step
  // stands, dated; management prints no slot — "Pending" there would promise
  // a signature nobody is going to give — nor does the acknowledgement, and
  // no open "Approved by" stands in for them.
  const sched10 = await api(tok.hr, 'POST', '/evaluations/schedule', { employeeId: e7.id, milestone: 'ADHOC', evaluatorId: supervisor.id });
  const ev10 = sched10.body as { id: string; lines: Line[] };
  await api(tok.supervisor, 'PATCH', `/evaluations/${ev10.id}`, { lines: (ev10.lines ?? []).map((l) => ({ id: l.id, rating: 3 })), recommendation: 'REGULARIZE' });
  const sub10 = await api(tok.supervisor, 'POST', `/evaluations/${ev10.id}/submit`);
  const req10 = await pendingRequest(ev10.id);
  if (req10) await act({ requestId: req10.id, userId: hr.id, action: 'APPROVED' });
  const cancel10 = await api(tok.supervisor, 'POST', `/evaluations/${ev10.id}/cancel`);
  const closed10 = req10 ? await prisma.approvalRequest.findUnique({ where: { id: req10.id } }) : null;
  check(
    'HR signs it, then the evaluator cancels it while management has it; its request closes CANCELLED',
    sched10.status === 201 && sub10.status === 200 && cancel10.status === 200 && closed10?.status === 'CANCELLED',
    `schedule ${sched10.status}, submit ${sub10.status} ${sub10.body.error ?? ''}, cancel ${cancel10.status}, request ${closed10?.status ?? 'none was open'}`,
  );
  const cancelledPdf = await pdfOf(tok.supervisor, ev10.id);
  const cancelledSlots = signoffSlots(cancelledPdf.text, 'EVALUATED BY');
  check(
    'cancelled after a step signed, it prints the evaluator and the HR step that signed, both dated — no slot Pending under management, nor an acknowledgement',
    cancelledPdf.status === 200 &&
      cancelledSlots.length === 2 &&
      cancelledSlots.every((sl) => sl.signed) &&
      signs(cancelledSlots[0], 'Evaluated by', supervisor.name) &&
      signs(cancelledSlots[1], steps[0]?.name ?? '', hr.name) &&
      !cancelledSlots.some((sl) => sl.text.startsWith(roleWords(steps[1]?.name ?? ''))) &&
      pendingCount(cancelledPdf.text) === 0 &&
      !flat(cancelledPdf.text).includes('ACKNOWLEDGED BY') &&
      !flat(cancelledPdf.text).includes('APPROVED BY') &&
      flat(cancelledPdf.text).includes('Status: Cancelled'),
    `${cancelledPdf.status} ${slotsSaid(cancelledSlots)}`,
  );

  // ══ 17. The list on paper ════════════════════════════════════════════════
  console.log('\nThe list on paper');
  const nobody = await makeUser(`${TAG} Nobody`, `nobody${DOMAIN}`, []);
  const searched = `search=${TAG}`;
  const evalRows = (await readScreen(tok.hr, `/evaluations?${searched}&pageSize=200`)).rows;
  const evalStatus = splittingValue(evalRows, 'status');
  await checkListPaper(check, {
    label: 'Evaluations',
    token: tok.hr,
    actorId: hr.id,
    list: '/evaluations',
    query: searched,
    named: `search "${TAG}"`,
    noun: ['evaluation', 'evaluations'],
    mark: (r) => String(r.number),
    filter: { query: `${searched}&status=${evalStatus}`, named: `status ${statusLabel(evalStatus)}` },
    entityType: 'evaluation',
  });
  // The evaluator prints what they write; the person evaluated, only what
  // was approved about them — the record's own rule (visibleTo).
  await checkOwnPaper(check, {
    label: 'Evaluations (the evaluator)',
    ownToken: tok.supervisor,
    allToken: tok.hr,
    list: '/evaluations',
    query: searched,
    noun: ['evaluation', 'evaluations'],
    mark: (r) => String(r.number),
  });
  await checkOwnPaper(check, {
    label: 'Evaluations (the person evaluated)',
    ownToken: tok.subject,
    allToken: tok.hr,
    list: '/evaluations',
    query: searched,
    noun: ['evaluation', 'evaluations'],
    mark: (r) => String(r.number),
  });
  const subjectRows = (await readScreen(tok.subject, `/evaluations?${searched}&pageSize=200`)).rows;
  check(
    'and what the person evaluated prints is approved, every row',
    subjectRows.length > 0 && subjectRows.every((r) => r.status === 'APPROVED'),
    subjectRows.map((r) => String(r.status)).join(', '),
  );
  const listRows = await prisma.auditLog.findMany({ where: { entityType: 'evaluation', entityId: 'list', actorId: hr.id } });
  check(
    "the list's export rows carry a count, never a rating",
    listRows.length > 0 && listRows.every((a) => a.before === null && a.after === null && /^Exported the evaluation list as PDF \(\d+ evaluation\(s\)\)$/.test(a.summary ?? '')),
    JSON.stringify(listRows.map((a) => a.summary)),
  );
  check(
    'Evaluations: the printed list is refused to anyone the list refuses',
    (await printed(signToken(nobody.id, nobody.email), '/evaluations/pdf')).status === 403,
  );

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(async (err) => {
    console.error('\nVerification crashed:', err);
    await cleanup().catch(() => {});
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

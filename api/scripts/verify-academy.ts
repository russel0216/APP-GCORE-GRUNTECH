/**
 * Gruntech Academy verification — G-HR › Academy (item 13).
 *
 *   npx tsx scripts/verify-academy.ts      (the API must be running)
 *
 * The passport is derived, so most of what can go wrong is arithmetic that
 * nobody sees until an auditor asks why a welder with a lapsed certificate
 * showed as ready. The pure rules — which requirement applies to whom, which
 * record answers for a course, where it stands against today — are asserted
 * directly. The lifecycle is asserted over HTTP, because that is where the
 * rules live: who may train, who sees a result, what completion writes, and
 * how an external certificate reaches HR and back.
 */

import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';
import { statusLabel } from '../src/shared/pdf';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { resolveUser } from '../src/permissions/resolve';
import { act } from '../src/shared/approvals';
import { globalSearch } from '../src/shared/search';
import { scheduleFor } from '../src/routes/workspace';
import {
  academySettings,
  bestRecord,
  expiryFor,
  lineState,
  passportFor,
  readinessFor,
  requiredCoursesFor,
  requirementMatches,
  saveAcademySettings,
  sweepExpiryNotices,
  teamReadiness,
  type AcademySettings,
  type RecordLite,
} from '../src/shared/academy';
// Side-effect import: registers the training_certification subscriber, the
// course and session search providers and the schedule provider.
import { courseImport } from '../src/routes/academy';
import {
  checkListPaper,
  checkOwnPaper,
  flat,
  pendingCount,
  printed,
  readScreen,
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

const TAG = 'ZZAC';
const DOMAIN = '@verifyacademy.local';
const BASE = `http://localhost:${env.port}/api`;
const DAY = 86_400_000;

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function cleanup() {
  const employees = await prisma.employee.findMany({
    where: { employeeNo: { startsWith: TAG } },
    select: { id: true },
  });
  const empIds = employees.map((e) => e.id);
  const courses = await prisma.course.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } });
  const courseIds = courses.map((c) => c.id);
  const records = await prisma.trainingRecord.findMany({
    where: { OR: [{ employeeId: { in: empIds } }, { courseId: { in: courseIds } }] },
    select: { id: true },
  });
  const recordIds = records.map((r) => r.id);
  const sessions = await prisma.trainingSession.findMany({ where: { courseId: { in: courseIds } }, select: { id: true } });
  const sessionIds = sessions.map((s) => s.id);

  const requests = await prisma.approvalRequest.findMany({
    where: { documentType: 'training_certification', documentId: { in: recordIds } },
    select: { id: true },
  });
  await prisma.approvalAction.deleteMany({ where: { requestId: { in: requests.map((r) => r.id) } } });
  await prisma.approvalRequest.deleteMany({ where: { id: { in: requests.map((r) => r.id) } } });
  await prisma.trainingRecord.deleteMany({ where: { id: { in: recordIds } } });
  await prisma.trainingSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.course.deleteMany({ where: { id: { in: courseIds } } });
  await prisma.auditLog.deleteMany({
    where: { entityId: { in: [...recordIds, ...sessionIds, ...courseIds, ...empIds] } },
  });
  await prisma.employee.deleteMany({ where: { id: { in: empIds } } });
  await prisma.position.deleteMany({ where: { code: { startsWith: TAG } } });
  await prisma.department.deleteMany({ where: { code: { startsWith: TAG } } });
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: TAG } }, { body: { contains: TAG } }] } });

  const users = await prisma.user.findMany({ where: { email: { endsWith: DOMAIN } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.userPermissionOverride.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: 'zzac_' } } });
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
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
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

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const rec = (p: Partial<RecordLite> & { id: string }): RecordLite => ({
  courseId: 'c',
  status: 'VERIFIED',
  completedAt: d('2025-01-01'),
  expiresAt: null,
  ...p,
});

type Line = { course: { id: string; code: string }; state: string; recordId: string | null };
type Passport = {
  readiness: { required: number; held: number; pct: number | null };
  lines: Line[];
  records: { id: string; number: string | null; source: string; status: string; courseId: string; approvalRequestId: string | null }[];
};

// ── The run ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nG-CORE Academy verification\n');
  await cleanup();
  const originalRules: AcademySettings = await academySettings();

  try {
    await run(originalRules);
  } finally {
    await saveAcademySettings(originalRules);
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

async function run(rules: AcademySettings) {
  // ══ 1. Requirement matching — by id, never by title ═══════════════════════
  console.log('1. Who must hold a course');
  const eng = { departmentId: 'D1', positionId: 'P1' };
  const unclassified = { departmentId: 'D1', positionId: null };
  check('a rule with neither department nor position applies to everyone', requirementMatches({ departmentId: null, positionId: null }, unclassified));
  check('a department rule applies to everyone in it', requirementMatches({ departmentId: 'D1', positionId: null }, unclassified));
  check('and to nobody outside it', !requirementMatches({ departmentId: 'D2', positionId: null }, eng));
  check('a position rule applies to its holders', requirementMatches({ departmentId: null, positionId: 'P1' }, eng));
  check('an unclassified employee matches NO position rule', !requirementMatches({ departmentId: null, positionId: 'P1' }, unclassified));
  check('both named is the intersection', requirementMatches({ departmentId: 'D1', positionId: 'P1' }, eng) && !requirementMatches({ departmentId: 'D2', positionId: 'P1' }, eng));

  // ══ 2. Which record answers for a course ══════════════════════════════════
  console.log('\n2. The record that counts');
  const asOf = d('2026-06-01');
  check('nothing on file is MISSING', lineState([], 60, asOf).state === 'MISSING');
  check('only a pending certificate is PENDING, not held', lineState([rec({ id: 'p', status: 'PENDING_VERIFICATION' })], 60, asOf).state === 'PENDING');
  check('a rejected certificate is MISSING', lineState([rec({ id: 'r', status: 'REJECTED' })], 60, asOf).state === 'MISSING');
  check('never-expiring is CURRENT for good', lineState([rec({ id: 'n' })], 60, asOf).state === 'CURRENT');
  check('expiry beyond the warning is CURRENT', lineState([rec({ id: 'a', expiresAt: d('2026-12-01') })], 60, asOf).state === 'CURRENT');
  check('expiry inside the warning is EXPIRING', lineState([rec({ id: 'b', expiresAt: d('2026-07-01') })], 60, asOf).state === 'EXPIRING');
  check('a passed expiry is EXPIRED', lineState([rec({ id: 'c', expiresAt: d('2026-05-01') })], 60, asOf).state === 'EXPIRED');
  const renewal = bestRecord([
    rec({ id: 'old', completedAt: d('2023-01-01'), expiresAt: d('2025-01-01') }),
    rec({ id: 'new', completedAt: d('2025-01-01'), expiresAt: d('2027-01-01') }),
    rec({ id: 'pend', status: 'PENDING_VERIFICATION', expiresAt: d('2030-01-01') }),
  ]);
  check('a renewal supersedes the certificate it renews; a pending one never counts', renewal?.id === 'new', renewal?.id);

  // ══ 3. Expiry dates ═══════════════════════════════════════════════════════
  console.log('\n3. Expiry');
  check('24 months after 15 Mar 2026 is 15 Mar 2028', expiryFor(d('2026-03-15'), 24)?.toISOString().slice(0, 10) === '2028-03-15');
  check('one month after 31 January clamps to 28 February', expiryFor(d('2026-01-31'), 1)?.toISOString().slice(0, 10) === '2026-02-28');
  check('no validity means no expiry', expiryFor(d('2026-01-31'), null) === null);

  // ══ 4. The CSV import spec ═════════════════════════════════════════════════
  console.log('\n4. Course import');
  const built = (await courseImport.spec.build(
    { Code: 'zzac-imp', Title: 'Imported course', Hours: '8', 'Validity Months': '12', 'Requires Assessment': 'yes', Active: '' },
    1,
  )) as unknown as { code: string; hours: number; validityMonths: number; requiresAssessment: boolean; isActive: boolean };
  check('a row builds with the code upper-cased and the flags parsed', built.code === 'ZZAC-IMP' && built.hours === 8 && built.validityMonths === 12 && built.requiresAssessment && built.isActive);
  await expectRejection('a fractional validity is refused', () => courseImport.spec.build({ Code: 'X1', Title: 'T', 'Validity Months': '1.5' }, 2), 'whole number');
  await expectRejection('a missing title is refused', () => courseImport.spec.build({ Code: 'X1' }, 3), 'Title is required');
  check('the import carries the create right', courseImport.permission === 'ghr.courses.create');

  // ══ HTTP ═════════════════════════════════════════════════════════════════
  if (!(await apiReachable())) {
    console.log('\n  ✗ The API is not running — the HTTP cases were NOT checked.');
    console.log('    Start it (cd api && npm run dev) and run this script again.\n');
    failed++;
    return;
  }

  // Fixtures: a department, two positions, people.
  const dept = await prisma.department.create({ data: { code: `${TAG}-D1`, name: `${TAG} Field Services` } });
  const other = await prisma.department.create({ data: { code: `${TAG}-D2`, name: `${TAG} Office` } });
  const welder = await prisma.position.create({ data: { code: `${TAG}-P1`, title: `${TAG} Welder`, departmentId: dept.id } });
  const clerk = await prisma.position.create({ data: { code: `${TAG}-P2`, title: `${TAG} Clerk`, departmentId: other.id } });

  const hrRole = await makeRole('zzac_hr', `${TAG} HR`, [
    'ghr.courses.view_all', 'ghr.courses.create', 'ghr.courses.edit_all', 'ghr.courses.delete',
    'ghr.training_calendar.view_all',
    'ghr.training_sessions.view_all', 'ghr.training_sessions.create', 'ghr.training_sessions.edit_all', 'ghr.training_sessions.delete',
    'ghr.passports.view_all', 'ghr.passports.create', 'ghr.passports.edit_all', 'ghr.passports.delete', 'ghr.passports.approve',
    'ghr.passport.view_own', 'ghr.passport.create', 'ghr.settings.view_all', 'ghr.settings.edit_all', 'ghr.dashboard.view_all',
  ]);
  const trainerRole = await makeRole('zzac_trainer', `${TAG} trainer`, [
    'ghr.courses.view_all', 'ghr.training_calendar.view_all', 'ghr.training_sessions.view_own',
    'ghr.training_sessions.create', 'ghr.training_sessions.edit_own', 'ghr.passport.view_own',
  ]);
  const staffRole = await makeRole('zzac_staff', `${TAG} staff`, [
    'ghr.training_calendar.view_all', 'ghr.passport.view_own', 'ghr.passport.create',
  ]);
  const seededHr = await prisma.role.findUnique({ where: { key: 'hr' } });
  if (!seededHr) throw new Error('The seeded hr role is missing — run npm run seed');

  const hr = await makeUser(`${TAG} HR Officer`, `hr${DOMAIN}`, [hrRole.id, seededHr.id]);
  const trainer = await makeUser(`${TAG} Trainer`, `trainer${DOMAIN}`, [trainerRole.id]);
  const worker = await makeUser(`${TAG} Welder One`, `welder${DOMAIN}`, [staffRole.id]);
  const worker2 = await makeUser(`${TAG} Welder Two`, `welder2${DOMAIN}`, [staffRole.id]);
  const office = await makeUser(`${TAG} Clerk`, `clerk${DOMAIN}`, [staffRole.id]);

  const empWelder = await prisma.employee.create({
    data: { employeeNo: `${TAG}-001`, firstName: 'Welder', lastName: `${TAG} One`, departmentId: dept.id, positionId: welder.id, position: welder.title, userId: worker.id },
  });
  const empWelder2 = await prisma.employee.create({
    data: { employeeNo: `${TAG}-002`, firstName: 'Welder', lastName: `${TAG} Two`, departmentId: dept.id, positionId: welder.id, position: welder.title, userId: worker2.id },
  });
  const empUnclassified = await prisma.employee.create({
    data: { employeeNo: `${TAG}-003`, firstName: 'Helper', lastName: `${TAG} Three`, departmentId: dept.id, positionId: null, position: 'Helper' },
  });
  const empClerk = await prisma.employee.create({
    data: { employeeNo: `${TAG}-004`, firstName: 'Clerk', lastName: `${TAG} Four`, departmentId: other.id, positionId: clerk.id, position: clerk.title, userId: office.id },
  });
  const empHr = await prisma.employee.create({
    data: { employeeNo: `${TAG}-005`, firstName: 'Officer', lastName: `${TAG} HR`, departmentId: other.id, userId: hr.id },
  });

  const tok = {
    hr: signToken(hr.id, hr.email),
    trainer: signToken(trainer.id, trainer.email),
    worker: signToken(worker.id, worker.email),
    worker2: signToken(worker2.id, worker2.email),
    office: signToken(office.id, office.email),
  };

  // ══ 5. Courses and their requirements ═════════════════════════════════════
  console.log('\n5. Courses');
  const mk = async (code: string, extra: Record<string, unknown> = {}) => {
    const r = await api(tok.hr, 'POST', '/courses', { code, title: `${TAG} ${code}`, hours: 8, ...extra });
    if (r.status !== 201) throw new Error(`course ${code}: ${r.status} ${r.text}`);
    return r.body as { id: string; code: string };
  };
  const everyone = await mk(`${TAG}-ALL`, { validityMonths: 24 });
  const deptOnly = await mk(`${TAG}-DEPT`);
  const weld = await mk(`${TAG}-WELD`, { validityMonths: 12, requiresAssessment: true });
  const clerkCourse = await mk(`${TAG}-CLRK`);

  const dup = await api(tok.hr, 'POST', '/courses', { code: `${TAG.toLowerCase()}-all`, title: `${TAG} dup` });
  check('a course code is unique, whatever its case', dup.status === 409, `${dup.status}`);
  const noRight = await api(tok.trainer, 'POST', '/courses', { code: `${TAG}-NOPE`, title: `${TAG} nope` });
  check('a trainer cannot add to the course master', noRight.status === 403, `${noRight.status}`);

  const put = async (id: string, rows: unknown) => api(tok.hr, 'PUT', `/courses/${id}/requirements`, rows);
  await put(everyone.id, [{}]);
  await put(deptOnly.id, [{ departmentId: dept.id }]);
  const weldReq = await put(weld.id, { requirements: [{ positionId: welder.id }, { positionId: welder.id }] });
  await put(clerkCourse.id, [{ departmentId: other.id, positionId: clerk.id }]);
  check('requirements dedupe and read back with a label', weldReq.status === 200 && (weldReq.body.requirements as { label: string }[]).length === 1 && (weldReq.body.requirements as { label: string }[])[0].label === `${TAG} Welder`, weldReq.text.slice(0, 200));
  const badReq = await put(deptOnly.id, [{ positionId: 'no-such-position' }]);
  check('a requirement naming an unknown position is refused', badReq.status === 400, `${badReq.status}`);

  const reqWelder = (await requiredCoursesFor(empWelder)).map((c) => c.code).filter((c) => c.startsWith(TAG)).sort();
  const reqUnclassified = (await requiredCoursesFor(empUnclassified)).map((c) => c.code).filter((c) => c.startsWith(TAG)).sort();
  const reqClerk = (await requiredCoursesFor(empClerk)).map((c) => c.code).filter((c) => c.startsWith(TAG)).sort();
  check('the welder must hold everyone + department + position courses', JSON.stringify(reqWelder) === JSON.stringify([`${TAG}-ALL`, `${TAG}-DEPT`, `${TAG}-WELD`]), reqWelder.join(','));
  check('an unclassified employee matches department-only and everyone rules only', JSON.stringify(reqUnclassified) === JSON.stringify([`${TAG}-ALL`, `${TAG}-DEPT`]), reqUnclassified.join(','));
  check('the clerk matches the intersection rule and everyone', JSON.stringify(reqClerk) === JSON.stringify([`${TAG}-ALL`, `${TAG}-CLRK`]), reqClerk.join(','));

  const list = await api(tok.hr, 'GET', `/courses?search=${TAG}&pageSize=50`);
  const listRows = (list.body.rows ?? []) as { code: string; requirementCount: number; hours: number }[];
  check('the course list returns hours as a number and counts requirements', list.status === 200 && listRows.some((r) => r.code === `${TAG}-WELD` && r.requirementCount === 1 && r.hours === 8), `${list.status}`);

  // ══ 6. Sessions: who may train, capacity ══════════════════════════════════
  console.log('\n6. Scheduling a session');
  const yStart = new Date(Date.now() - DAY);
  yStart.setHours(9, 0, 0, 0);
  const yEnd = new Date(yStart.getTime() + 8 * 3_600_000);

  const notTrainer = await api(tok.hr, 'POST', '/training-sessions', {
    courseId: weld.id, trainerId: worker.id, startsAt: yStart.toISOString(), endsAt: yEnd.toISOString(),
  });
  check('a trainer must hold the Trainer right', notTrainer.status === 400 && /Trainer right/.test(notTrainer.text), notTrainer.text.slice(0, 120));
  const staffCreate = await api(tok.worker, 'POST', '/training-sessions', {
    courseId: weld.id, startsAt: yStart.toISOString(), endsAt: yEnd.toISOString(),
  });
  check('an employee cannot schedule a session', staffCreate.status === 403, `${staffCreate.status}`);
  const tooMany = await api(tok.hr, 'POST', '/training-sessions', {
    courseId: weld.id, trainerId: trainer.id, startsAt: yStart.toISOString(), endsAt: yEnd.toISOString(),
    capacity: 1, employeeIds: [empWelder.id, empWelder2.id],
  });
  check('enrolling more than the capacity is refused', tooMany.status === 400, `${tooMany.status}`);

  const created = await api(tok.hr, 'POST', '/training-sessions', {
    courseId: weld.id, trainerId: trainer.id, startsAt: yStart.toISOString(), endsAt: yEnd.toISOString(),
    venue: `${TAG} Yard`, capacity: 3, employeeIds: [empWelder.id, empWelder2.id],
  });
  const sessionId = String(created.body.id);
  check('HR schedules a session for a trainer, numbered GT-TS', created.status === 201 && /^GT-TS-\d{4}-\d{4}$/.test(String(created.body.number)), `${created.status} ${created.body.number}`);
  const assigned = await prisma.notification.count({ where: { userId: trainer.id, type: 'training.assigned' } });
  const enrolledNote = await prisma.notification.count({ where: { userId: worker.id, type: 'training.enrolled' } });
  check('the trainer is told they have it, and the attendees that they are on it', assigned === 1 && enrolledNote === 1, `${assigned}/${enrolledNote}`);

  const full = await api(tok.trainer, 'POST', `/training-sessions/${sessionId}/attendees`, { employeeIds: [empUnclassified.id, empClerk.id] });
  check('adding past the capacity is refused', full.status === 409, `${full.status}`);
  const meet = await api(tok.trainer, 'PATCH', `/training-sessions/${sessionId}`, { googleUrl: 'abc-defg-hij' });
  check('the trainer pastes a Meet code and it is stored as a Meet link', meet.status === 200 && meet.body.meetLink === 'https://meet.google.com/abc-defg-hij', `${meet.status} ${meet.body.meetLink}`);
  const calLink = await api(tok.trainer, 'PATCH', `/training-sessions/${sessionId}`, { googleUrl: 'https://calendar.google.com/calendar/event?eid=abc123' });
  check('a Calendar event link is refused with the fix', calLink.status === 400 && /Meet link/.test(calLink.text), calLink.text.slice(0, 120));

  // ══ 7. Visibility: results are the trainer's and HR's ═════════════════════
  console.log('\n7. Who sees what');
  await api(tok.trainer, 'PUT', `/training-sessions/${sessionId}/results`, {
    results: [{ employeeId: empWelder.id, result: 'PASSED', score: 92 }],
  });
  const asWorker2 = await api(tok.worker2, 'GET', `/training-sessions/${sessionId}`);
  const w2Rows = (asWorker2.body.attendees ?? []) as { employeeId: string; result: string | null; score: number | null }[];
  check('a colleague on the same session sees who is going but not their result', asWorker2.status === 200 && w2Rows.find((a) => a.employeeId === empWelder.id)?.result === null, asWorker2.text.slice(0, 160));
  const asWorker = await api(tok.worker, 'GET', `/training-sessions/${sessionId}`);
  const wRows = (asWorker.body.attendees ?? []) as { employeeId: string; result: string | null; score: number | null }[];
  check('the attendee sees their own result and score', wRows.find((a) => a.employeeId === empWelder.id)?.result === 'PASSED' && wRows.find((a) => a.employeeId === empWelder.id)?.score === 92);
  const staffList = await api(tok.worker, 'GET', '/training-sessions');
  check('the session list is the trainer right, not the calendar right', staffList.status === 403, `${staffList.status}`);
  const trainerList = await api(tok.trainer, 'GET', '/training-sessions?pageSize=100');
  check('the trainer lists the sessions they train', trainerList.status === 200 && ((trainerList.body.rows ?? []) as { id: string }[]).some((r) => r.id === sessionId));

  // ══ 8. Completion writes the passport ═════════════════════════════════════
  console.log('\n8. Completing a session');
  const early = await api(tok.trainer, 'POST', `/training-sessions/${sessionId}/complete`, {});
  check('completion is refused while anybody has no result', early.status === 409 && /no result/.test(early.text), early.text.slice(0, 120));
  const unscored = await api(tok.trainer, 'POST', `/training-sessions/${sessionId}/complete`, {
    results: [{ employeeId: empWelder2.id, result: 'FAILED' }],
  });
  check('an assessed course refuses a result with no score', unscored.status === 409 && /score/.test(unscored.text), unscored.text.slice(0, 120));
  const done = await api(tok.trainer, 'POST', `/training-sessions/${sessionId}/complete`, {
    results: [{ employeeId: empWelder2.id, result: 'FAILED', score: 40 }],
  });
  const outcome = done.body.outcome as { passed: number; failed: number } | undefined;
  check('the trainer completes it: one passed, one failed', done.status === 200 && done.body.status === 'COMPLETED' && outcome?.passed === 1 && outcome?.failed === 1, `${done.status} ${done.text.slice(0, 160)}`);
  const sessionRecords = await prisma.trainingRecord.findMany({ where: { sessionId } });
  const expectedExpiry = expiryFor(sessionRecords[0]?.completedAt ?? new Date(), 12)?.toISOString();
  check('only the pass is written — VERIFIED, by the trainer', sessionRecords.length === 1 && sessionRecords[0].employeeId === empWelder.id && sessionRecords[0].status === 'VERIFIED' && sessionRecords[0].verifiedById === trainer.id);
  check('a SESSION record has no number', sessionRecords[0]?.number === null);
  check('it expires by the course validity from the completion date', sessionRecords[0]?.expiresAt?.toISOString() === expectedExpiry, `${sessionRecords[0]?.expiresAt?.toISOString()} vs ${expectedExpiry}`);
  const again = await api(tok.trainer, 'POST', `/training-sessions/${sessionId}/complete`, {});
  check('completing twice is refused', again.status === 409, `${again.status}`);
  const editAfter = await api(tok.trainer, 'PATCH', `/training-sessions/${sessionId}`, { venue: 'elsewhere' });
  check('a completed session refuses edits — its results are final', editAfter.status === 409, `${editAfter.status}`);
  const completedNote = await prisma.notification.count({ where: { userId: worker.id, type: 'training.completed' } });
  check('the attendee is told it is in their passport', completedNote === 1, `${completedNote}`);

  // ══ 9. The passport, and one readiness figure ═════════════════════════════
  console.log('\n9. The passport');
  const myPassport = await api(tok.worker, 'GET', '/passports/me');
  const pp = myPassport.body as unknown as Passport;
  const weldLine = pp.lines?.find((l) => l.course.id === weld.id);
  check('the welder\'s passport lists three required courses', myPassport.status === 200 && pp.lines.filter((l) => l.course.code.startsWith(TAG)).length === 3, `${myPassport.status}`);
  check('the welding course reads CURRENT off the session record', weldLine?.state === 'CURRENT' && weldLine.recordId === sessionRecords[0]?.id, weldLine?.state);
  const otherPassport = await api(tok.worker, 'GET', `/passports/${empWelder2.id}`);
  check('an employee cannot open a colleague\'s passport', otherPassport.status === 404, `${otherPassport.status}`);

  const direct = await passportFor(empWelder.id);
  const batch = (await readinessFor([empWelder, empWelder2, empUnclassified, empClerk])).get(empWelder.id);
  check('the batch readiness equals the passport\'s own', !!direct && !!batch && batch.required === direct.readiness.required && batch.held === direct.readiness.held && batch.pct === direct.readiness.pct, `${JSON.stringify(batch)} vs ${JSON.stringify(direct?.readiness)}`);

  const register = await api(tok.hr, 'GET', `/passports?search=${TAG}&pageSize=50`);
  const regRows = (register.body.rows ?? []) as { id: string; required: number; held: number; pct: number | null }[];
  const regWelder = regRows.find((r) => r.id === empWelder.id);
  check('the Passports register shows the same figure', register.status === 200 && regWelder?.held === direct?.readiness.held && regWelder?.pct === direct?.readiness.pct, JSON.stringify(regWelder));
  const gaps = await api(tok.hr, 'GET', `/passports?search=${TAG}&state=gaps&pageSize=50`);
  check('the gaps filter keeps people with something missing', ((gaps.body.rows ?? []) as { id: string }[]).some((r) => r.id === empWelder2.id));

  const summary = await api(tok.hr, 'GET', '/passports/summary');
  const team = await teamReadiness();
  check('GET /passports/summary equals teamReadiness() read directly', summary.status === 200 && summary.body.held === team.held && summary.body.required === team.required && summary.body.employees === team.employees, `${JSON.stringify(summary.body)} vs ${JSON.stringify(team)}`);
  const summaryStaff = await api(tok.worker, 'GET', '/passports/summary');
  check('an employee cannot read the company figure', summaryStaff.status === 403, `${summaryStaff.status}`);

  // ══ 10. External certificate — numbered, verified by HR ═══════════════════
  console.log('\n10. An external certificate');
  const ext = await api(tok.worker, 'POST', '/passports/me/records', {
    courseId: everyone.id, completedAt: '2026-01-10', provider: `${TAG} Safety Council`, certificateNo: 'BOSH-123',
  });
  const extPp = ext.body as unknown as Passport;
  const extRec = extPp.records?.find((r) => r.courseId === everyone.id && r.source === 'EXTERNAL');
  check('the employee files it, numbered GT-TC', ext.status === 201 && /^GT-TC-\d{4}-\d{4}$/.test(extRec?.number ?? ''), `${ext.status} ${extRec?.number} ${ext.text.slice(0, 120)}`);
  check('it waits on HR and does not count yet', extRec?.status === 'PENDING_VERIFICATION' && extPp.lines.find((l) => l.course.id === everyone.id)?.state === 'PENDING');
  const extRow = await prisma.trainingRecord.findUnique({ where: { id: extRec?.id ?? '' } });
  check('the expiry defaults to the course validity from completion', extRow?.expiresAt?.toISOString().slice(0, 10) === '2028-01-10', extRow?.expiresAt?.toISOString());
  const request = await prisma.approvalRequest.findFirst({ where: { documentType: 'training_certification', documentId: extRec?.id ?? '' } });
  check('it is routed through the approval engine to HR', request?.status === 'PENDING' && extRec?.approvalRequestId === request?.id);
  check('the approval links to the employee\'s passport', request?.link === `/g-hr/academy/passports/${empWelder.id}`, request?.link ?? '');
  await expectRejection('the employee cannot verify their own certificate', () => act({ requestId: request!.id, userId: worker.id, action: 'APPROVED' }), 'raised yourself');
  await act({ requestId: request!.id, userId: hr.id, action: 'APPROVED' });
  const verified = await prisma.trainingRecord.findUnique({ where: { id: extRec!.id } });
  check('HR approval verifies it, naming HR as the verifier', verified?.status === 'VERIFIED' && verified.verifiedById === hr.id && verified.verifiedAt !== null);
  const afterVerify = await passportFor(empWelder.id);
  check('and it now counts toward readiness', afterVerify?.lines.find((l) => l.course.id === everyone.id)?.state === 'CURRENT');

  const ext2 = await api(tok.worker2, 'POST', '/passports/me/records', {
    courseId: deptOnly.id, completedAt: '2026-02-01', provider: `${TAG} Somewhere`,
  });
  const ext2Rec = (ext2.body as unknown as Passport).records?.find((r) => r.courseId === deptOnly.id);
  const req2 = await prisma.approvalRequest.findFirst({ where: { documentType: 'training_certification', documentId: ext2Rec?.id ?? '' } });
  await act({ requestId: req2!.id, userId: hr.id, action: 'REJECTED', comment: 'Unreadable scan' });
  const rejected = await prisma.trainingRecord.findUnique({ where: { id: ext2Rec!.id } });
  check('a rejection marks it REJECTED — it counts for nothing', rejected?.status === 'REJECTED' && (await passportFor(empWelder2.id))?.lines.find((l) => l.course.id === deptOnly.id)?.state === 'MISSING');
  const withdraw = await api(tok.worker2, 'DELETE', `/passports/records/${ext2Rec!.id}`);
  check('the employee can remove their own rejected certificate', withdraw.status === 204, `${withdraw.status}`);
  const sessionDelete = await api(tok.hr, 'DELETE', `/passports/records/${sessionRecords[0].id}`);
  check('a session record cannot be deleted from the passport', sessionDelete.status === 409, `${sessionDelete.status}`);
  const future = await api(tok.worker, 'POST', '/passports/me/records', {
    courseId: deptOnly.id, completedAt: new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10), provider: `${TAG} Later`,
  });
  check('a certificate completed in the future is refused', future.status === 400, `${future.status}`);

  // ══ 11. HR records directly — never for themselves ════════════════════════
  console.log('\n11. HR records training directly');
  const selfRecord = await api(tok.hr, 'POST', `/passports/${empHr.id}/records`, {
    courseId: everyone.id, completedAt: '2026-01-05', provider: `${TAG} Council`,
  });
  check('HR cannot record-and-verify their own certificate', selfRecord.status === 403, `${selfRecord.status}`);
  const expiringDate = new Date(Date.now() - 700 * DAY).toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
  const forClerk = await api(tok.hr, 'POST', `/passports/${empClerk.id}/records`, {
    courseId: clerkCourse.id, completedAt: expiringDate, expiresAt: soon, provider: `${TAG} Council`,
  });
  const clerkRec = (forClerk.body as unknown as Passport).records?.find((r) => r.courseId === clerkCourse.id);
  check('HR records one for somebody else — VERIFIED at once, numbered GT-TC', forClerk.status === 201 && clerkRec?.status === 'VERIFIED' && /^GT-TC-/.test(clerkRec?.number ?? ''), `${forClerk.status} ${forClerk.text.slice(0, 120)}`);
  check('a certificate lapsing in 10 days reads EXPIRING', (forClerk.body as unknown as Passport).lines?.find((l) => l.course.id === clerkCourse.id)?.state === 'EXPIRING');

  // ══ 12. Expiry notices are sent once ══════════════════════════════════════
  console.log('\n12. Expiry notices');
  await sweepExpiryNotices();
  const notices1 = await prisma.notification.count({ where: { userId: office.id, type: 'training.expiring' } });
  await sweepExpiryNotices();
  const notices2 = await prisma.notification.count({ where: { userId: office.id, type: 'training.expiring' } });
  check('the clerk is told once that a certificate is lapsing', notices1 === 1 && notices2 === 1, `${notices1}/${notices2}`);
  const fix = await api(tok.hr, 'PATCH', `/passports/records/${clerkRec!.id}`, { expiresAt: new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10) });
  // The PATCH answers with the passport, whose read sweeps — so the corrected
  // date has already earned its own notice by the time the response lands.
  const notices3 = await prisma.notification.count({ where: { userId: office.id, type: 'training.expiring' } });
  check('correcting the expiry resets the notice so the new date earns its own', fix.status === 200 && notices3 === 2, `${fix.status} ${notices3}`);

  // ══ 13. Self-enrolment, the setting, the calendar ═════════════════════════
  console.log('\n13. Self-enrolment and the calendar');
  const tStart = new Date(Date.now() + 2 * DAY);
  tStart.setHours(9, 0, 0, 0);
  const tEnd = new Date(tStart.getTime() + 4 * 3_600_000);
  const upcoming = await api(tok.trainer, 'POST', '/training-sessions', {
    courseId: deptOnly.id, startsAt: tStart.toISOString(), endsAt: tEnd.toISOString(), venue: `${TAG} Room`,
  });
  const upId = String(upcoming.body.id);
  check('a trainer schedules their own session', upcoming.status === 201 && upcoming.body.trainerId === trainer.id, `${upcoming.status}`);

  await saveAcademySettings({ allowSelfEnrolment: false });
  const off = await api(tok.worker2, 'POST', `/training-sessions/${upId}/enrol-me`);
  check('with self-enrolment off, enrolling yourself is refused', off.status === 403, `${off.status}`);
  await saveAcademySettings({ allowSelfEnrolment: true });
  const on = await api(tok.worker2, 'POST', `/training-sessions/${upId}/enrol-me`);
  check('with it on, an employee enrols from the calendar', on.status === 200 && on.body.enrolled === true && on.body.canWithdraw === true, `${on.status} ${on.text.slice(0, 120)}`);
  const twice = await api(tok.worker2, 'POST', `/training-sessions/${upId}/enrol-me`);
  check('enrolling twice is refused', twice.status === 409, `${twice.status}`);
  await api(tok.trainer, 'POST', `/training-sessions/${upId}/attendees`, { employeeIds: [empWelder.id] });
  const assignedWithdraw = await api(tok.worker, 'DELETE', `/training-sessions/${upId}/enrol-me`);
  check('somebody enrolled by the trainer cannot withdraw themselves', assignedWithdraw.status === 403, `${assignedWithdraw.status}`);
  const selfWithdraw = await api(tok.worker2, 'DELETE', `/training-sessions/${upId}/enrol-me`);
  check('a self-enrolment can be withdrawn', selfWithdraw.status === 200 && selfWithdraw.body.enrolled === false, `${selfWithdraw.status}`);

  const calFrom = new Date(Date.now() - 3 * DAY).toISOString();
  const calTo = new Date(Date.now() + 20 * DAY).toISOString();
  const cal = await api(tok.office, 'GET', `/training-sessions/calendar?from=${calFrom}&to=${calTo}`);
  const calRows = (Array.isArray(cal.body) ? cal.body : []) as unknown as { id: string; date: string; link: string }[];
  check('the calendar is company-wide: the clerk sees both sessions, keyed by day', cal.status === 200 && calRows.some((r) => r.id === upId && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) && calRows.some((r) => r.id === sessionId), `${cal.status} ${calRows.length}`);
  const tooWide = await api(tok.office, 'GET', `/training-sessions/calendar?from=${calFrom}&to=${new Date(Date.now() + 90 * DAY).toISOString()}`);
  check('a calendar window over 62 days is refused', tooWide.status === 400, `${tooWide.status}`);

  const moved = await api(tok.trainer, 'PATCH', `/training-sessions/${upId}`, {
    startsAt: new Date(tStart.getTime() + DAY).toISOString(), endsAt: new Date(tEnd.getTime() + DAY).toISOString(),
  });
  const rescheduled = await prisma.notification.count({ where: { userId: worker.id, type: 'training.rescheduled' } });
  check('moving it bumps the .ics sequence and tells the attendees', moved.status === 200 && moved.body.icsSequence === 1 && rescheduled === 1, `${moved.status} seq ${moved.body.icsSequence} told ${rescheduled}`);

  const ics = await api(tok.worker, 'GET', `/training-sessions/${upId}/ics`);
  check('the .ics downloads with the sequence and the session number', ics.status === 200 && /BEGIN:VEVENT/.test(ics.text) && /SEQUENCE:1/.test(ics.text) && (ics.headers.get('content-type') ?? '').startsWith('text/calendar'), `${ics.status}`);
  const pdfOf = (id: string) => printed(tok.trainer, `/training-sessions/${id}/pdf`);
  const pdf = await pdfOf(sessionId);
  check('the attendance sheet renders as a PDF', pdf.status === 200 && pdf.bytes?.subarray(0, 4).toString() === '%PDF', `${pdf.status}`);
  // No approval routes a session: the sheet prints the people who acted,
  // each dated — HR, who scheduled it, and the trainer, whose completion is
  // the sign-off — never an "Approved by" nobody fills. The details name the
  // trainer and HR too, so who signs is read off the slots, never the page.
  const sheetSlots = signoffSlots(pdf.text, 'SCHEDULED BY');
  check(
    'completed, the sheet is signed by whoever scheduled it and by the trainer, each dated, nothing Pending',
    sheetSlots.length === 2 &&
      signs(sheetSlots[0], 'Scheduled by', hr.name) &&
      sheetSlots[0].signed &&
      signs(sheetSlots[1], 'Conducted by', trainer.name) &&
      sheetSlots[1].signed &&
      signedCount(pdf.text) === 2 &&
      pendingCount(pdf.text) === 0 &&
      !flat(pdf.text).includes('APPROVED BY'),
    slotsSaid(sheetSlots),
  );
  check(
    'its words are words: "Status: Completed", results "Passed" / "Failed" (never the enum), lines under "No." and the employee\'s under "Number"',
    flat(pdf.text).includes('Status: Completed') &&
      /^Passed$/m.test(pdf.text) &&
      /^Failed$/m.test(pdf.text) &&
      !/PASSED|FAILED|NO_SHOW/.test(pdf.text) &&
      pdf.text.includes('NO.') &&
      pdf.text.includes('NUMBER') &&
      !/^#$/m.test(pdf.text),
    pdf.text.split('\n').filter((l) => /Status|Passed|Failed|PASSED|NO\.|NUMBER/.test(l)).join(' | ').slice(0, 200),
  );
  const upPdf = await pdfOf(upId);
  const upSlots = signoffSlots(upPdf.text, 'SCHEDULED BY');
  check(
    'scheduled, the trainer\'s slot is Pending until the session is completed; a result not yet recorded is blank, not "Pending"',
    upPdf.status === 200 &&
      upSlots.length === 2 &&
      signs(upSlots[0], 'Scheduled by', trainer.name) &&
      upSlots[0].signed &&
      signs(upSlots[1], 'Conducted by', trainer.name) &&
      !upSlots[1].signed &&
      signedCount(upPdf.text) === 1 &&
      pendingCount(upPdf.text) === 1 &&
      flat(upPdf.text).includes('Status: Scheduled'),
    `${upPdf.status} ${slotsSaid(upSlots)}`,
  );
  const pdfStaff = await api(tok.worker, 'GET', `/training-sessions/${sessionId}/pdf`);
  check('an attendee cannot print the attendance sheet', pdfStaff.status === 403, `${pdfStaff.status}`);

  const cancel = await api(tok.trainer, 'POST', `/training-sessions/${upId}/cancel`, { reason: `${TAG} trainer unwell` });
  const cancelledNote = await prisma.notification.count({ where: { userId: worker.id, type: 'training.cancelled' } });
  check('cancelling tells everyone enrolled', cancel.status === 200 && cancel.body.status === 'CANCELLED' && cancelledNote === 1, `${cancel.status} ${cancelledNote}`);
  const cancelledPdf = await pdfOf(upId);
  check(
    'cancelled, nobody will conduct it: the sheet drops that slot and says why it was cancelled',
    cancelledPdf.status === 200 &&
      !flat(cancelledPdf.text).includes('CONDUCTED BY') &&
      pendingCount(cancelledPdf.text) === 0 &&
      words(cancelledPdf.text).includes(words(`Status: Cancelled — ${TAG} trainer unwell`)),
    `${cancelledPdf.status} ${pendingCount(cancelledPdf.text)} pending`,
  );
  const sheetPrints = await prisma.auditLog.count({ where: { entityType: 'training_session', entityId: upId, action: 'EXPORTED', summary: { contains: 'attendance sheet' } } });
  check('every print of a sheet is on its session\'s trail as EXPORTED', sheetPrints === 2, String(sheetPrints));

  // ══ 14. Search, schedule, delete guards, settings ═════════════════════════
  console.log('\n14. Search, schedule and guards');
  const hrUser = (await resolveUser(hr.id))!;
  const hits = await globalSearch(`${TAG}-WELD`, hrUser);
  const kinds = new Set(hits.map((h) => h.kind));
  check('Ctrl+K finds the course and its session', kinds.has('course') && kinds.has('training_session'), [...kinds].join(','));
  const nowish = new Date(Date.now() + 60 * 60_000);
  const todays = await api(tok.trainer, 'POST', '/training-sessions', {
    courseId: everyone.id, startsAt: nowish.toISOString(), endsAt: new Date(nowish.getTime() + 3_600_000).toISOString(), employeeIds: [empWelder.id],
  });
  const todaysId = String(todays.body.id);
  const win = { from: new Date(nowish.getTime() - 60_000), to: new Date(nowish.getTime() + 60_000) };
  const trainerDay = await scheduleFor((await resolveUser(trainer.id))!, win);
  const workerDay = await scheduleFor((await resolveUser(worker.id))!, win);
  const officeDay = await scheduleFor((await resolveUser(office.id))!, win);
  check('the day lists it for the trainer and the attendee, kind training', trainerDay.some((s) => s.kind === 'training' && s.id === todaysId) && workerDay.some((s) => s.kind === 'training' && s.link === `/g-hr/academy/sessions/${todaysId}`));
  check('and not for somebody who is not on it', !officeDay.some((s) => s.id === todaysId));

  const delCourse = await api(tok.hr, 'DELETE', `/courses/${weld.id}`);
  check('a course with training on record cannot be deleted', delCourse.status === 409 && /deactivate/.test(delCourse.text), `${delCourse.status}`);
  const delSession = await api(tok.trainer, 'DELETE', `/training-sessions/${todaysId}`);
  check('a session with people on it must be cancelled, not deleted', delSession.status === 409, `${delSession.status}`);

  const badSettings = await api(tok.hr, 'PUT', '/academy-settings', { categories: ['Safety', 'safety'] });
  check('a category listed twice is refused', badSettings.status === 400, `${badSettings.status}`);
  const staffSettings = await api(tok.worker, 'PUT', '/academy-settings', { expiryWarningDays: 5 });
  check('only HR Settings can change the Academy rules', staffSettings.status === 403, `${staffSettings.status}`);
  const goodSettings = await api(tok.hr, 'PUT', '/academy-settings', { expiryWarningDays: rules.expiryWarningDays });
  check('HR saves the rules, audited', goodSettings.status === 200 && (await prisma.auditLog.count({ where: { entityId: 'academy.rules', actorId: hr.id } })) >= 1, `${goodSettings.status}`);

  const audits = await prisma.auditLog.findMany({ where: { entityType: 'training_session', entityId: sessionId }, select: { action: true } });
  const actions = new Set(audits.map((a) => a.action));
  check('the session\'s audit trail runs CREATED → UPDATED → COMPLETED → EXPORTED', ['CREATED', 'UPDATED', 'COMPLETED', 'EXPORTED'].every((a) => actions.has(a)), [...actions].join(','));

  // ══ 15. The lists on paper ════════════════════════════════════════════════
  console.log('\n15. The lists on paper');
  const searched = `search=${TAG}`;
  const searchNamed = `search "${TAG}"`;
  // Every course above is required of somebody, so "required" would keep
  // them all and prove nothing: one asked of nobody is the row it drops.
  await mk(`${TAG}-OPT`);
  await checkListPaper(check, {
    label: 'Courses',
    token: tok.hr,
    actorId: hr.id,
    list: '/courses',
    query: searched,
    named: searchNamed,
    noun: ['course', 'courses'],
    mark: (r) => String(r.code),
    filter: { query: `${searched}&required=true`, named: 'required of somebody' },
    entityType: 'course',
  });
  check('Courses: the printed list is refused to anyone without the course master', (await printed(tok.worker, '/courses/pdf')).status === 403);

  const sessionRows = (await readScreen(tok.hr, `/training-sessions?${searched}&pageSize=200`)).rows;
  const sessionStatus = splittingValue(sessionRows, 'status');
  await checkListPaper(check, {
    label: 'Training sessions',
    token: tok.hr,
    actorId: hr.id,
    list: '/training-sessions',
    query: searched,
    named: searchNamed,
    noun: ['training session', 'training sessions'],
    mark: (r) => String(r.number),
    filter: { query: `${searched}&status=${sessionStatus}`, named: `status ${statusLabel(sessionStatus)}` },
    entityType: 'training_session',
  });
  // A trainer holding only view_own prints the sessions they train, scheduled
  // or attend — and not one HR trains and scheduled, which this script's
  // other sessions (all the trainer's) would never test.
  await prisma.trainingSession.create({
    data: { number: `${TAG}-TS-HR`, courseId: weld.id, trainerId: hr.id, createdById: hr.id, startsAt: yStart, endsAt: yEnd, venue: `${TAG} HR room` },
  });
  await checkOwnPaper(check, {
    label: 'Training sessions',
    ownToken: tok.trainer,
    allToken: tok.hr,
    list: '/training-sessions',
    query: searched,
    noun: ['training session', 'training sessions'],
    mark: (r) => String(r.number),
  });
  check('Training sessions: the printed list is refused to anyone the list refuses', (await printed(tok.worker, '/training-sessions/pdf')).status === 403);

  await checkListPaper(check, {
    label: 'Training passports',
    token: tok.hr,
    actorId: hr.id,
    list: '/passports',
    query: searched,
    named: searchNamed,
    noun: ['person', 'people'],
    mark: (r) => String(r.employeeNo),
    filter: { query: `${searched}&departmentId=${dept.id}`, named: `department ${dept.name}` },
    entityType: 'training_passport',
  });
  // Each person's readiness on paper is the screen's: held of required.
  const passportRows = (await readScreen(tok.hr, `/passports?${searched}&pageSize=200`)).rows as { required: number; held: number }[];
  const passportPaper = await printed(tok.hr, `/passports/pdf?${searched}`);
  const heldLines = passportRows.filter((r) => r.required > 0).map((r) => `${r.held} of ${r.required}`);
  check(
    'Training passports: every held-of-required on the screen is on the paper',
    heldLines.length > 0 && heldLines.every((h) => flat(passportPaper.text).includes(h)),
    heldLines.join(', '),
  );
  check('Training passports: the printed register is refused to anyone without it', (await printed(tok.trainer, '/passports/pdf')).status === 403);
}

main()
  .catch(async (err) => {
    console.error('\nVerification crashed:', err);
    await cleanup().catch(() => {});
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

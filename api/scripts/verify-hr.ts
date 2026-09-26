/**
 * Phase 6 verification — G-HR.
 *
 *   npx tsx scripts/verify-hr.ts      (the API must be running)
 *
 * Three things in this phase are easy to get wrong and expensive to get wrong
 * quietly:
 *
 *   · Overtime cost must reach a project's budget exactly once, and only when
 *     BOTH the supervisor and HR have approved. Prior approval authorises the
 *     work; it must not move money.
 *   · A leave balance must be drawn down on approval and given back on
 *     cancellation — never on filing, or a rejected request would cost someone
 *     their entitlement.
 *   · A face match must refuse when it is ambiguous, not pick the nearer of two
 *     similar people.
 *
 * The arithmetic is checked directly. The route guards — double clock-in,
 * filing actual hours before authorisation, clocking in as somebody else — are
 * checked over HTTP, because that is where they live.
 */

import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { nextNumber } from '../src/shared/numbering';
import { submitForApproval, act } from '../src/shared/approvals';
import {
  hrSettings,
  classifyArrival,
  workedMinutes,
  overtimeHours,
  overtimeRate,
  leaveDays,
  leaveBalance,
  faceDistance,
  matchFace,
  dayKey,
  toMinutes,
  fromMinutes,
} from '../src/shared/hr';
import { describeFace } from '../src/shared/face';
// Side-effect import: registers the leave and overtime approval subscribers.
import '../src/routes/hr';

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

const money = (a: number, b: number) => Math.abs(a - b) < 0.005;
const D = (v: number) => new Prisma.Decimal(v);
const num = (v: Prisma.Decimal | null | undefined) => (v == null ? 0 : Number(v));

const TAG = 'ZZHR';
const BASE = `http://localhost:${env.port}/api`;

// ── Test fixtures ────────────────────────────────────────────────────────────

async function cleanup() {
  await prisma.overtimeRequest.deleteMany({ where: { reason: { startsWith: TAG } } });
  await prisma.leaveRequest.deleteMany({ where: { reason: { startsWith: TAG } } });
  const employees = await prisma.employee.findMany({
    where: { employeeNo: { startsWith: TAG } },
    select: { id: true },
  });
  const employeeIds = employees.map((e) => e.id);
  if (employeeIds.length) {
    await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: employeeIds } } });
    await prisma.attendance.deleteMany({ where: { employeeId: { in: employeeIds } } });
    await prisma.faceEnrollment.deleteMany({ where: { employeeId: { in: employeeIds } } });
    await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
  }
  await prisma.leaveType.deleteMany({ where: { code: { startsWith: TAG } } });
  await prisma.job.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.costing.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });

  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@verifyhr.local' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.approvalAction.deleteMany({ where: { approverId: { in: ids } } });
    await prisma.approvalRequest.deleteMany({ where: { requesterId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.updateMany({
      where: { supervisorId: { in: ids } },
      data: { supervisorId: null },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: 'zzhr_' } } });
}

/**
 * A role holding exactly the permissions named.
 *
 * The verification makes its own roles rather than borrowing the seeded ones:
 * a seeded role's membership is the operator's business, and a test that
 * depends on it breaks the moment somebody is hired.
 */
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
    data: {
      key,
      name,
      permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
    },
  });
}

async function makeUser(name: string, email: string, roleIds: string[], supervisorId?: string) {
  return prisma.user.create({
    data: {
      name,
      email,
      passwordHash: await bcrypt.hash('x', 10),
      supervisorId: supervisorId ?? null,
      roles: { create: roleIds.map((roleId) => ({ roleId })) },
    },
  });
}

/** A 128-float descriptor built from a seed, so "the same face" is repeatable. */
function descriptor(seed: number, jitter = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < 128; i++) {
    out.push(Math.sin(seed * 7.13 + i * 0.37) * 0.5 + (jitter ? Math.sin(i * 3.1 + seed) * jitter : 0));
  }
  return out;
}

/**
 * Real photographs, for testing the detector rather than the distance maths.
 *
 * @vladmandic/face-api ships sample images with its demo. sample2 is one
 * person; sample1 is a group of three, whose left third is one person — a
 * different one. Both are used as fixtures so the whole pipeline (decode →
 * detect → 128 floats) is exercised on actual faces, not on numbers this
 * script made up.
 */
const SAMPLES = path.join(process.cwd(), 'node_modules/@vladmandic/face-api/demo');
const sample = (file: string) => fs.readFileSync(path.join(SAMPLES, file));

/** The left third of the group photo: one face, a different person. */
async function otherPersonPhoto(): Promise<Buffer> {
  const buf = sample('sample1.jpg');
  const meta = await sharp(buf).metadata();
  return sharp(buf)
    .extract({ left: 0, top: 0, width: Math.floor(meta.width! / 3), height: meta.height! })
    .jpeg()
    .toBuffer();
}

/** The same photo through a different camera pipeline — smaller and lossier. */
const recompressed = (buf: Buffer) => sharp(buf).resize(400).jpeg({ quality: 60 }).toBuffer();

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nG-CORE HR verification\n');
  await cleanup();

  const settings = await hrSettings();

  // ══ The working day ══════════════════════════════════════════════════════
  console.log('The working day');

  const on = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(2026, 8, 21, h, m, 0, 0);
    return d;
  };

  check('arriving at 08:00 is on time', classifyArrival(on('08:00'), settings).status === 'PRESENT');
  check(
    'arriving inside the 15-minute grace is still on time',
    classifyArrival(on('08:14'), settings).status === 'PRESENT',
  );
  const late = classifyArrival(on('08:45'), settings);
  check(
    'arriving at 08:45 is 30 minutes late, not 45',
    late.status === 'LATE' && late.lateMinutes === 30,
    `got ${late.lateMinutes}`,
  );

  check(
    'a full day deducts the unpaid break',
    workedMinutes(on('08:00'), on('17:00'), settings) === 540 - settings.breakMinutes,
  );
  check(
    'a short visit does not lose an hour to a break nobody took',
    workedMinutes(on('08:00'), on('09:30'), settings) === 90,
  );
  check('clocking out before clocking in is zero, not negative', workedMinutes(on('17:00'), on('08:00'), settings) === 0);

  check('a time round-trips through minutes', fromMinutes(toMinutes('17:45')) === '17:45');
  await expectRejection('a malformed time is refused', async () => toMinutes('25:00'), 'not a valid time');

  // ══ Overtime hours ═══════════════════════════════════════════════════════
  console.log('\nOvertime hours');

  check(
    '17:00–21:00 with the dinner break is 3 hours, not 4',
    overtimeHours('17:00', '21:00', true, settings) === 3,
    `got ${overtimeHours('17:00', '21:00', true, settings)}`,
  );
  check(
    'unchecking the break makes the same span 4 hours',
    overtimeHours('17:00', '21:00', false, settings) === 4,
  );
  check(
    'overtime starting after dinner keeps its full hours',
    overtimeHours('19:00', '22:00', true, settings) === 3,
    `got ${overtimeHours('19:00', '22:00', true, settings)}`,
  );
  check(
    'overtime past midnight counts forward, not backward',
    overtimeHours('22:00', '02:00', false, settings) === 4,
    `got ${overtimeHours('22:00', '02:00', false, settings)}`,
  );

  // ══ Leave days ═══════════════════════════════════════════════════════════
  console.log('\nLeave days');

  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  check(
    'Monday to Friday is five days',
    leaveDays(day('2026-09-21'), day('2026-09-25'), null, null, settings) === 5,
  );
  check(
    'a span across a weekend does not charge the weekend',
    leaveDays(day('2026-09-25'), day('2026-09-28'), null, null, settings) === 2,
    `got ${leaveDays(day('2026-09-25'), day('2026-09-28'), null, null, settings)}`,
  );
  check(
    'starting at 13:00 on a single day is half a day',
    leaveDays(day('2026-09-21'), day('2026-09-21'), '13:00', null, settings) === 0.5,
    `got ${leaveDays(day('2026-09-21'), day('2026-09-21'), '13:00', null, settings)}`,
  );
  check(
    'finishing at 12:00 on the last day takes half off the end',
    leaveDays(day('2026-09-21'), day('2026-09-22'), null, '12:00', settings) === 1.5,
    `got ${leaveDays(day('2026-09-21'), day('2026-09-22'), null, '12:00', settings)}`,
  );
  await expectRejection(
    'an end date before the start is refused',
    async () => leaveDays(day('2026-09-25'), day('2026-09-21'), null, null, settings),
    'before the start',
  );

  // ══ Fixtures ═════════════════════════════════════════════════════════════

  const workerRole = await makeRole('zzhr_worker', `${TAG} Worker`, [
    'ghr.clock.view_own',
    'ghr.clock.create',
    'ghr.leave.create',
    'ghr.leave.view_own',
    'ghr.overtime.create',
    'ghr.overtime.view_own',
  ]);
  const hrRole = await prisma.role.findUnique({ where: { key: 'hr' } });
  if (!hrRole) throw new Error('The seeded HR role is missing — run the seed first');

  const supervisor = await makeUser('ZZ Supervisor', 'sup@verifyhr.local', []);
  const worker = await makeUser('ZZ Worker', 'worker@verifyhr.local', [workerRole.id], supervisor.id);
  const hrOfficer = await makeUser('ZZ HR Officer', 'hr@verifyhr.local', [hrRole.id]);

  const employee = await prisma.employee.create({
    data: {
      employeeNo: `${TAG}-001`,
      firstName: 'Zeno',
      lastName: 'Worker',
      userId: worker.id,
      dailyRate: D(1000),
      burdenMultiplier: D(1.4),
    },
  });
  const other = await prisma.employee.create({
    data: { employeeNo: `${TAG}-002`, firstName: 'Zara', lastName: 'Other' },
  });

  const customer = await prisma.customer.create({
    data: { code: `${TAG}-C1`, name: `${TAG} Hospital` },
  });
  const categories = await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  const labour = categories.find((c) => /labor|labour/i.test(c.name)) ?? categories[1] ?? categories[0];

  const costing = await prisma.costing.create({
    data: {
      number: await nextNumber('costing'),
      title: `${TAG} Plant`,
      ownerId: supervisor.id,
      totalCost: D(200_000),
      contractValue: D(250_000),
    },
  });
  const job = await prisma.job.create({
    data: {
      number: await nextNumber('project'),
      name: `${TAG} Plant`,
      customerId: customer.id,
      costingId: costing.id,
      createdById: supervisor.id,
      projectManagerId: supervisor.id,
      contractValue: D(250_000),
      costEntries: {
        create: [
          {
            costCategoryId: labour.id,
            state: 'BUDGETED',
            amount: D(200_000),
            sourceType: 'costing',
            sourceNumber: costing.number,
          },
        ],
      },
    },
  });

  // ══ Face matching ════════════════════════════════════════════════════════
  console.log('\nFace matching');

  check('the same descriptor is distance zero', faceDistance(descriptor(1), descriptor(1)) === 0);
  check(
    'two different faces are further apart than two captures of one face',
    faceDistance(descriptor(1), descriptor(2)) > faceDistance(descriptor(1), descriptor(1, 0.02)),
  );

  await prisma.faceEnrollment.create({
    data: { employeeId: employee.id, descriptor: descriptor(1) as unknown as Prisma.InputJsonValue },
  });

  const hit = await matchFace(descriptor(1, 0.02));
  check(
    'a fresh capture of an enrolled face matches its owner',
    hit.best?.employeeId === employee.id && hit.best.distance < hit.threshold,
    `best ${hit.best?.name} at ${hit.best?.distance.toFixed(3)} vs threshold ${hit.threshold}`,
  );

  const miss = await matchFace(descriptor(9));
  check(
    'a stranger does not match anyone under the threshold',
    !miss.best || miss.best.distance > miss.threshold,
    `best ${miss.best?.distance.toFixed(3)} vs threshold ${miss.threshold}`,
  );

  // A near-duplicate enrolment is the ambiguity the clock route has to catch.
  await prisma.faceEnrollment.create({
    data: { employeeId: other.id, descriptor: descriptor(1, 0.03) as unknown as Prisma.InputJsonValue },
  });
  const ambiguous = await matchFace(descriptor(1, 0.015));
  check(
    'two similar enrolments are reported as nearly equal, not silently resolved',
    !!ambiguous.runnerUp && ambiguous.runnerUp.distance - ambiguous.best!.distance < 0.05,
    `gap ${(ambiguous.runnerUp!.distance - ambiguous.best!.distance).toFixed(4)}`,
  );
  await prisma.faceEnrollment.deleteMany({ where: { employeeId: other.id } });

  const inactive = await matchFace(descriptor(1, 0.02));
  check('the match still works once the duplicate is removed', inactive.best?.employeeId === employee.id);

  // ── The detector, on real photographs ──────────────────────────────────

  const blank = await sharp({
    create: { width: 480, height: 640, channels: 3, background: { r: 120, g: 130, b: 140 } },
  })
    .jpeg()
    .toBuffer();
  await expectRejection(
    'a photo with no face in it is refused',
    () => describeFace(blank),
    'no face was found',
  );

  // Two people in frame is how you would clock in a colleague who is not
  // there. Picking the largest face would make that work.
  await expectRejection(
    'a photo with more than one face in it is refused',
    () => describeFace(sample('sample1.jpg')),
    'faces are in that photo',
  );

  const personA = await describeFace(sample('sample2.jpg'));
  const personB = await describeFace(await otherPersonPhoto());
  check('a real photograph yields 128 floats', personA.descriptor.length === 128);
  check('the detector reports its confidence', personA.score > 0.5, `score ${personA.score}`);

  const personAAgain = await describeFace(await recompressed(sample('sample2.jpg')));
  const sameDistance = faceDistance(personA.descriptor, personAAgain.descriptor);
  const differentDistance = faceDistance(personA.descriptor, personB.descriptor);

  check(
    'the same face through a smaller, lossier capture still matches',
    sameDistance < settings.faceThreshold,
    `distance ${sameDistance.toFixed(3)} vs threshold ${settings.faceThreshold}`,
  );
  check(
    'two different people are further apart than the threshold',
    differentDistance > settings.faceThreshold,
    `distance ${differentDistance.toFixed(3)} vs threshold ${settings.faceThreshold}`,
  );
  check(
    'and the gap between the two is wide, not marginal',
    differentDistance - sameDistance > 0.25,
    `same ${sameDistance.toFixed(3)}, different ${differentDistance.toFixed(3)}`,
  );

  // The whole pipeline: enrol from a photo, then recognise a later capture.
  await prisma.faceEnrollment.deleteMany({ where: { employeeId: employee.id } });
  await prisma.faceEnrollment.create({
    data: {
      employeeId: employee.id,
      descriptor: personA.descriptor as unknown as Prisma.InputJsonValue,
    },
  });
  await prisma.faceEnrollment.create({
    data: {
      employeeId: other.id,
      descriptor: personB.descriptor as unknown as Prisma.InputJsonValue,
    },
  });

  const recognised = await matchFace(personAAgain.descriptor);
  check(
    'a later capture of an enrolled person is recognised as them',
    recognised.best?.employeeId === employee.id && recognised.best.distance < recognised.threshold,
    `matched ${recognised.best?.name} at ${recognised.best?.distance.toFixed(3)}`,
  );
  check(
    'and the other enrolled person is clearly the runner-up, not a tie',
    !!recognised.runnerUp &&
      recognised.runnerUp.distance - recognised.best!.distance > 0.05,
    `gap ${(recognised.runnerUp!.distance - recognised.best!.distance).toFixed(3)}`,
  );

  const strangerAtTheDoor = await matchFace(personB.descriptor);
  check(
    'the other person is recognised as themselves, not as the first',
    strangerAtTheDoor.best?.employeeId === other.id,
    `matched ${strangerAtTheDoor.best?.name}`,
  );

  // Put the synthetic enrolment back so the HTTP section still sees an
  // enrolled employee.
  await prisma.faceEnrollment.deleteMany({ where: { employeeId: other.id } });

  // ══ Leave ════════════════════════════════════════════════════════════════
  console.log('\nLeave');

  const leaveType = await prisma.leaveType.create({
    data: { code: `${TAG}VL`, name: `${TAG} Vacation`, daysPerYear: D(5) },
  });

  const openingBalance = await leaveBalance(employee.id, leaveType.id, 2026);
  check('an employee with no balance row starts on the type allotment', openingBalance.remaining === 5);

  async function fileLeave(start: string, end: string, days: number) {
    const request = await prisma.leaveRequest.create({
      data: {
        number: await nextNumber('leave_request'),
        employeeId: employee.id,
        leaveTypeId: leaveType.id,
        startDate: day(start),
        endDate: day(end),
        days: D(days),
        reason: `${TAG} time off`,
        status: 'PENDING_APPROVAL',
      },
    });
    const approval = await submitForApproval({
      documentType: 'leave_request',
      documentId: request.id,
      documentNumber: request.number,
      subject: `${TAG} leave`,
      requesterId: worker.id,
    });
    return { request, approval };
  }

  const first = await fileLeave('2026-09-21', '2026-09-22', 2);

  const pendingBalance = await leaveBalance(employee.id, leaveType.id, 2026);
  check(
    'a filed request shows as pending but has not spent the entitlement',
    pendingBalance.used === 0 && pendingBalance.pending === 2 && pendingBalance.remainingAfterPending === 3,
    `used ${pendingBalance.used}, pending ${pendingBalance.pending}`,
  );

  await expectRejection(
    'the person who filed it cannot approve it',
    () => act({ requestId: first.approval.id, userId: worker.id, action: 'APPROVED' }),
    'raised yourself',
  );

  await act({ requestId: first.approval.id, userId: supervisor.id, action: 'APPROVED' });

  const afterApproval = await leaveBalance(employee.id, leaveType.id, 2026);
  const firstAfter = await prisma.leaveRequest.findUnique({ where: { id: first.request.id } });
  check('approval moves the request to APPROVED', firstAfter?.status === 'APPROVED');
  check(
    'approval draws the days down exactly once',
    afterApproval.used === 2 && afterApproval.remaining === 3,
    `used ${afterApproval.used}, remaining ${afterApproval.remaining}`,
  );

  const second = await fileLeave('2026-09-28', '2026-09-29', 2);
  await act({ requestId: second.approval.id, userId: supervisor.id, action: 'REJECTED' });
  const afterRejection = await leaveBalance(employee.id, leaveType.id, 2026);
  const secondAfter = await prisma.leaveRequest.findUnique({ where: { id: second.request.id } });
  check('a rejected request is marked REJECTED', secondAfter?.status === 'REJECTED');
  check(
    'a rejected request costs nobody a day',
    afterRejection.used === 2 && afterRejection.pending === 0,
    `used ${afterRejection.used}, pending ${afterRejection.pending}`,
  );

  // ══ Overtime ═════════════════════════════════════════════════════════════
  console.log('\nOvertime');

  const rate = await overtimeRate(employee.id);
  check(
    'the hourly rate is burdened, not the wage',
    money(rate.hourlyRate, (1000 * 1.4) / 8),
    `got ${rate.hourlyRate}`,
  );
  check('the overtime premium is the configured multiplier', rate.multiplier === settings.overtimeMultiplier);

  const ledger = async () => {
    const rows = await prisma.jobCostEntry.findMany({
      where: { jobId: job.id, sourceType: 'overtime_request' },
    });
    return { count: rows.length, total: rows.reduce((s, r) => s + num(r.amount), 0) };
  };

  const ot = await prisma.overtimeRequest.create({
    data: {
      number: await nextNumber('overtime_request'),
      employeeId: employee.id,
      date: day('2026-09-21'),
      plannedStart: '17:00',
      plannedEnd: '21:00',
      estimatedHours: D(3),
      reason: `${TAG} commissioning runs late`,
      jobId: job.id,
      costCategoryId: labour.id,
    },
  });

  const prior = await submitForApproval({
    documentType: 'overtime_prior',
    documentId: ot.id,
    documentNumber: ot.number,
    subject: `${TAG} prior`,
    requesterId: worker.id,
  });
  await act({ requestId: prior.id, userId: supervisor.id, action: 'APPROVED' });

  const afterPrior = await prisma.overtimeRequest.findUnique({ where: { id: ot.id } });
  check('prior approval records authorisation to work', afterPrior?.stage === 'PRIOR_APPROVED');
  check('prior approval carries a timestamp the employee can point to', afterPrior?.priorApprovedAt != null);

  const priorLedger = await ledger();
  check(
    'prior approval posts NO cost to the project',
    priorLedger.count === 0,
    `${priorLedger.count} entr(ies) worth ${priorLedger.total}`,
  );

  // The work actually ran an hour longer than approved.
  const actualHours = overtimeHours('17:00', '22:00', true, settings);
  await prisma.overtimeRequest.update({
    where: { id: ot.id },
    data: {
      stage: 'ACTUAL_FILED',
      actualStart: '17:00',
      actualEnd: '22:00',
      actualHours: D(actualHours),
      varianceNote: `${TAG} leak test repeated`,
    },
  });
  check('the actual filing is 4 hours against a 3-hour estimate', actualHours === 4);

  const actual = await submitForApproval({
    documentType: 'overtime_request',
    documentId: ot.id,
    documentNumber: ot.number,
    subject: `${TAG} actual`,
    amount: actualHours * rate.hourlyRate * rate.multiplier,
    requesterId: worker.id,
  });

  await act({ requestId: actual.id, userId: supervisor.id, action: 'APPROVED' });

  const midLedger = await ledger();
  const midStage = await prisma.overtimeRequest.findUnique({ where: { id: ot.id } });
  check(
    'the supervisor alone does not settle it — HR is still to come',
    midStage?.stage === 'ACTUAL_FILED',
    `stage ${midStage?.stage}`,
  );
  check(
    'no cost posts on the supervisor step alone',
    midLedger.count === 0,
    `${midLedger.count} entr(ies) worth ${midLedger.total}`,
  );

  await act({ requestId: actual.id, userId: hrOfficer.id, action: 'APPROVED' });

  const settled = await prisma.overtimeRequest.findUnique({ where: { id: ot.id } });
  const finalLedger = await ledger();
  const expected = 4 * ((1000 * 1.4) / 8) * 1.25;

  check('both approvals settle the request', settled?.stage === 'APPROVED');
  check(
    'cost posts exactly once, when and only when both have approved',
    finalLedger.count === 1,
    `${finalLedger.count} entries`,
  );
  check(
    `the project is charged the ACTUAL hours at the burdened premium rate (₱${expected})`,
    money(finalLedger.total, expected),
    `got ${finalLedger.total}`,
  );
  check(
    'the rate is snapshotted on the request, so a later raise does not rewrite history',
    settled?.hourlyRate != null && money(num(settled.hourlyRate), (1000 * 1.4) / 8),
  );
  check('the posting is INCURRED, not COMMITTED', true === (await (async () => {
    const row = await prisma.jobCostEntry.findFirst({
      where: { jobId: job.id, sourceType: 'overtime_request' },
    });
    return row?.state === 'INCURRED';
  })()));

  // A second overtime, rejected by HR after the supervisor approved.
  const ot2 = await prisma.overtimeRequest.create({
    data: {
      number: await nextNumber('overtime_request'),
      employeeId: employee.id,
      date: day('2026-09-22'),
      plannedStart: '17:00',
      plannedEnd: '20:00',
      estimatedHours: D(2),
      stage: 'ACTUAL_FILED',
      actualStart: '17:00',
      actualEnd: '20:00',
      actualHours: D(2),
      reason: `${TAG} second night`,
      jobId: job.id,
      costCategoryId: labour.id,
    },
  });
  const actual2 = await submitForApproval({
    documentType: 'overtime_request',
    documentId: ot2.id,
    documentNumber: ot2.number,
    subject: `${TAG} actual 2`,
    requesterId: worker.id,
  });
  await act({ requestId: actual2.id, userId: supervisor.id, action: 'APPROVED' });
  await act({ requestId: actual2.id, userId: hrOfficer.id, action: 'REJECTED' });

  const rejected = await prisma.overtimeRequest.findUnique({ where: { id: ot2.id } });
  const rejectedLedger = await ledger();
  check('an HR rejection after a supervisor approval rejects the whole thing', rejected?.stage === 'REJECTED');
  check(
    'a rejection at the last step posts no cost',
    rejectedLedger.count === 1,
    `${rejectedLedger.count} entries — the rejected one should not have added a second`,
  );

  // ══ Route guards ═════════════════════════════════════════════════════════
  console.log('\nRoute guards (over HTTP)');

  if (!(await apiReachable())) {
    failed += 1;
    console.log(
      `  ✗ the API is not reachable at ${BASE} — the route guards were NOT verified.\n` +
        '      Start it with "npm run dev" in api/ and run this script again.',
    );
  } else {
    const workerToken = signToken(worker.id, worker.email);
    const hrToken = signToken(hrOfficer.id, hrOfficer.email);

    const me = await api(workerToken, 'GET', '/clock/me');
    check(
      'clock/me knows who the signed-in person is and that they are enrolled',
      me.status === 200 && (me.body.employee as { id: string } | null)?.id === employee.id && me.body.enrolled === true,
      JSON.stringify(me.body).slice(0, 160),
    );

    /*
      Enrolling over HTTP — the actual /clock/enroll route, not the direct
      prisma.faceEnrollment.create() used above for the matching unit tests.
      This is what verifies the account-photo propagation: a live capture is
      supposed to overwrite User.photoPath with the SAME attachment id the
      enrolment stored, so the topbar avatar and the enrolment photo are
      provably one file, not two that happen to look alike.
    */
    const enrolForm = new FormData();
    enrolForm.set('photo', new Blob([sample('sample2.jpg')], { type: 'image/jpeg' }), 'enrol.jpg');
    const enrolRes = await fetch(`${BASE}/clock/enroll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${workerToken}` },
      body: enrolForm,
    });
    const enrolBody = (await enrolRes.json()) as { id: string; samples: number };
    check(
      'enrolling over HTTP accepts a real photo',
      enrolRes.status === 201 && enrolBody.samples > 0,
      `${enrolRes.status} ${JSON.stringify(enrolBody)}`,
    );

    const enrolledRow = await prisma.faceEnrollment.findUnique({ where: { id: enrolBody.id } });
    const workerAfter = await prisma.user.findUnique({ where: { id: worker.id }, select: { photoPath: true } });
    check(
      'the capture becomes the account photo — same attachment id, not a copy',
      !!enrolledRow?.photoPath && enrolledRow.photoPath === workerAfter?.photoPath,
      `enrolment ${enrolledRow?.photoPath} vs account ${workerAfter?.photoPath}`,
    );

    const photoRes = await fetch(`${BASE}/attachments/file/${workerAfter?.photoPath}`, {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    check(
      'and that photo is actually fetchable — the /file/:id route is not shadowed',
      photoRes.status === 200 && (photoRes.headers.get('content-type') ?? '').startsWith('image/'),
      `${photoRes.status} ${photoRes.headers.get('content-type')}`,
    );

    // Filing actual hours on an overtime that was never authorised.
    const unauthorised = await prisma.overtimeRequest.create({
      data: {
        number: await nextNumber('overtime_request'),
        employeeId: employee.id,
        date: day('2026-09-23'),
        plannedStart: '17:00',
        plannedEnd: '20:00',
        estimatedHours: D(2),
        reason: `${TAG} never authorised`,
      },
    });
    const early = await api(workerToken, 'POST', `/overtime/${unauthorised.id}/actual`, {
      actualStart: '17:00',
      actualEnd: '20:00',
    });
    check(
      'actual hours cannot be filed before the prior approval is granted',
      early.status === 400 && String(early.body.error).includes('not been authorised'),
      `${early.status} ${JSON.stringify(early.body).slice(0, 140)}`,
    );

    // A variance with no explanation.
    await prisma.overtimeRequest.update({
      where: { id: unauthorised.id },
      data: { stage: 'PRIOR_APPROVED' },
    });
    const silent = await api(workerToken, 'POST', `/overtime/${unauthorised.id}/actual`, {
      actualStart: '17:00',
      actualEnd: '22:00',
    });
    check(
      'a variance against the estimate must be explained',
      silent.status === 400 && String(silent.body.error).includes('differs from'),
      `${silent.status} ${JSON.stringify(silent.body).slice(0, 140)}`,
    );

    const explained = await api(workerToken, 'POST', `/overtime/${unauthorised.id}/actual`, {
      actualStart: '17:00',
      actualEnd: '22:00',
      varianceNote: `${TAG} explained`,
    });
    check('with an explanation the same filing is accepted', explained.status === 200, String(explained.status));

    // Leave overlapping an approved request.
    const overlap = await api(workerToken, 'POST', '/leave', {
      leaveTypeId: leaveType.id,
      startDate: '2026-09-22',
      endDate: '2026-09-23',
      reason: `${TAG} overlapping`,
    });
    check(
      'leave overlapping an already-approved request is refused',
      overlap.status === 400 && String(overlap.body.error).includes('already covers'),
      `${overlap.status} ${JSON.stringify(overlap.body).slice(0, 140)}`,
    );

    // Permission boundaries.
    const peek = await api(workerToken, 'GET', '/attendance/dashboard');
    check('an ordinary worker cannot open the HR dashboard', peek.status === 403, String(peek.status));

    const hrPeek = await api(hrToken, 'GET', '/attendance/dashboard');
    check(
      'HR can, and sees the whole active headcount',
      hrPeek.status === 200 && typeof (hrPeek.body.summary as Record<string, number>)?.absent === 'number',
      `${hrPeek.status} ${JSON.stringify(hrPeek.body.summary ?? {}).slice(0, 140)}`,
    );

    const balances = await api(workerToken, 'GET', `/leave/balances?employeeId=${other.id}`);
    check(
      "a worker cannot read somebody else's leave balance",
      balances.status === 403,
      String(balances.status),
    );

    // Clocking in, then again.
    const clockIn = await api(workerToken, 'POST', '/clock', {
      action: 'IN',
      method: 'PIN',
      fallbackReason: `${TAG} verification run`,
    });
    check('a PIN fallback clock-in is accepted and records the reason', clockIn.status === 200, String(clockIn.status));

    const twice = await api(workerToken, 'POST', '/clock', {
      action: 'IN',
      method: 'PIN',
      fallbackReason: `${TAG} again`,
    });
    check(
      'clocking in twice on one day is refused',
      twice.status === 400 && String(twice.body.error).includes('already clocked in'),
      `${twice.status} ${JSON.stringify(twice.body).slice(0, 140)}`,
    );

    const noReason = await api(workerToken, 'POST', '/clock', { action: 'OUT', method: 'PIN' });
    check(
      'a fallback with no reason given is refused — the reason is the record',
      noReason.status === 400 && String(noReason.body.error).includes('Say why'),
      `${noReason.status} ${JSON.stringify(noReason.body).slice(0, 140)}`,
    );

    const clockOut = await api(workerToken, 'POST', '/clock', {
      action: 'OUT',
      method: 'PIN',
      fallbackReason: `${TAG} verification run`,
    });
    check('clocking out is accepted and returns the hours worked', clockOut.status === 200, String(clockOut.status));

    const today = await prisma.attendance.findUnique({
      where: { employeeId_date: { employeeId: employee.id, date: dayKey(new Date()) } },
    });
    check(
      'the attendance row carries both stamps and the method used',
      today?.timeIn != null && today.timeOut != null && today.timeInMethod === 'PIN',
    );

    /*
      The LOCAL calendar date, not toISOString(). Attendance is keyed on the
      local day by `dayKey()`, so asking for the UTC one extracted the wrong
      day's rows for the eight hours either side of midnight in Manila — which
      is how this assertion failed at 07:00 with the route working correctly.
    */
    const pad = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    const localDay = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const csv = await fetch(
      `${BASE}/attendance/export?from=${localDay}&to=${localDay}`,
      { headers: { Authorization: `Bearer ${hrToken}` } },
    );
    const csvText = await csv.text();
    check(
      'HR can extract the day as CSV, with a header row',
      csv.ok && csvText.includes('Employee No') && csvText.includes(employee.employeeNo),
      `${csv.status}, ${csvText.length} bytes`,
    );
  }

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

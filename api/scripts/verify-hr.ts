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
import { submitForApproval, act, pendingFor } from '../src/shared/approvals';
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
  attendanceDay,
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
  // Approvals route to whoever really holds the role, so real people were told
  // about this script's documents too. Every such title carries TAG.
  await prisma.notification.deleteMany({ where: { title: { contains: TAG } } });
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

  // ══ A decision that lands after a cancel ═════════════════════════════════
  // The cancel route ran between the last approver's decision and the
  // subscriber: the filing already reads CANCELLED while its request is the
  // one the approver decided. Nothing may follow from that decision — no days
  // drawn, no authorisation, no cost.
  console.log('\nA decision that lands after a cancel');

  const lateLeave = await fileLeave('2026-10-12', '2026-10-13', 2);
  await prisma.leaveRequest.update({ where: { id: lateLeave.request.id }, data: { status: 'CANCELLED' } });
  const usedBeforeLate = (await leaveBalance(employee.id, leaveType.id, 2026)).used;
  await act({ requestId: lateLeave.approval.id, userId: supervisor.id, action: 'APPROVED' });
  const lateLeaveAfter = await prisma.leaveRequest.findUnique({ where: { id: lateLeave.request.id } });
  const usedAfterLate = (await leaveBalance(employee.id, leaveType.id, 2026)).used;
  check(
    'a leave cancelled before its approval took effect stays CANCELLED and draws no days',
    lateLeaveAfter?.status === 'CANCELLED' && usedAfterLate === usedBeforeLate,
    `${lateLeaveAfter?.status}, used ${usedBeforeLate} → ${usedAfterLate}`,
  );
  check(
    'its trail says the approval came too late to apply',
    !!(await prisma.auditLog.findFirst({
      where: {
        entityType: 'leave_request',
        entityId: lateLeave.request.id,
        summary: `${lateLeave.request.number} was approved after it was cancelled — not applied`,
      },
    })),
  );
  const lateRejected = await fileLeave('2026-10-19', '2026-10-19', 1);
  await prisma.leaveRequest.update({ where: { id: lateRejected.request.id }, data: { status: 'CANCELLED' } });
  await act({ requestId: lateRejected.approval.id, userId: supervisor.id, action: 'REJECTED' });
  const lateRejectedAfter = await prisma.leaveRequest.findUnique({ where: { id: lateRejected.request.id } });
  check('a late rejection leaves it CANCELLED too, not REJECTED', lateRejectedAfter?.status === 'CANCELLED', lateRejectedAfter?.status);

  const latePrior = await prisma.overtimeRequest.create({
    data: {
      number: await nextNumber('overtime_request'),
      employeeId: employee.id,
      date: day('2026-09-25'),
      plannedStart: '17:00',
      plannedEnd: '20:00',
      estimatedHours: D(2),
      reason: `${TAG} called off while it was being authorised`,
    },
  });
  const latePriorRequest = await submitForApproval({
    documentType: 'overtime_prior',
    documentId: latePrior.id,
    documentNumber: latePrior.number,
    subject: `${TAG} late prior`,
    requesterId: worker.id,
  });
  await prisma.overtimeRequest.update({ where: { id: latePrior.id }, data: { stage: 'CANCELLED' } });
  await act({ requestId: latePriorRequest.id, userId: supervisor.id, action: 'APPROVED' });
  const latePriorAfter = await prisma.overtimeRequest.findUnique({ where: { id: latePrior.id } });
  check(
    'overtime cancelled while its prior approval was decided stays CANCELLED, never authorised',
    latePriorAfter?.stage === 'CANCELLED' && latePriorAfter.priorApprovedAt === null,
    `${latePriorAfter?.stage}, authorised ${latePriorAfter?.priorApprovedAt?.toISOString() ?? 'never'}`,
  );

  const lateActual = await prisma.overtimeRequest.create({
    data: {
      number: await nextNumber('overtime_request'),
      employeeId: employee.id,
      date: day('2026-09-26'),
      plannedStart: '17:00',
      plannedEnd: '20:00',
      estimatedHours: D(2),
      stage: 'ACTUAL_FILED',
      actualStart: '17:00',
      actualEnd: '20:00',
      actualHours: D(2),
      reason: `${TAG} called off before HR signed`,
      jobId: job.id,
      costCategoryId: labour.id,
    },
  });
  const lateActualRequest = await submitForApproval({
    documentType: 'overtime_request',
    documentId: lateActual.id,
    documentNumber: lateActual.number,
    subject: `${TAG} late actual`,
    requesterId: worker.id,
  });
  await act({ requestId: lateActualRequest.id, userId: supervisor.id, action: 'APPROVED' });
  const chargedNotices = () =>
    prisma.notification.count({ where: { userId: supervisor.id, title: `Overtime charged to ${job.number}` } });
  const noticesBeforeLate = await chargedNotices();
  await prisma.overtimeRequest.update({ where: { id: lateActual.id }, data: { stage: 'CANCELLED' } });
  await act({ requestId: lateActualRequest.id, userId: hrOfficer.id, action: 'APPROVED' });
  const lateActualAfter = await prisma.overtimeRequest.findUnique({ where: { id: lateActual.id } });
  const lateRows = await prisma.jobCostEntry.count({ where: { sourceType: 'overtime_request', sourceId: lateActual.id } });
  check(
    "overtime cancelled before HR's final approval took effect stays CANCELLED",
    lateActualAfter?.stage === 'CANCELLED',
    lateActualAfter?.stage,
  );
  check(
    'and posts no cost: no ledger row, no rate or amount on the filing, no "charged" notice to the project manager',
    lateRows === 0 &&
      lateActualAfter?.amount === null &&
      lateActualAfter.hourlyRate === null &&
      (await chargedNotices()) === noticesBeforeLate,
    `${lateRows} ledger row(s), amount ${lateActualAfter?.amount}`,
  );
  check(
    'its trail says the approval came too late to apply',
    !!(await prisma.auditLog.findFirst({
      where: {
        entityType: 'overtime_request',
        entityId: lateActual.id,
        summary: `${lateActual.number} was approved after it was cancelled — not applied`,
      },
    })),
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

    /*
      The dashboard's figures are attendanceDay() in shared/hr.ts, and the
      Insights brief prints the same counts from the same function. The route
      must be that function and nothing more — compared as JSON, so a Date
      here and its ISO string there are the same thing.
    */
    const direct = JSON.parse(JSON.stringify(await attendanceDay(new Date()))) as Record<string, unknown>;
    const again = await api(hrToken, 'GET', '/attendance/dashboard');
    check(
      'GET /attendance/dashboard is attendanceDay(today), byte for byte',
      again.status === 200 && JSON.stringify(again.body) === JSON.stringify(direct),
      `${again.status} ${JSON.stringify(again.body.summary ?? {})} vs ${JSON.stringify(direct.summary ?? {})}`,
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

    // ══ One record, one URL (audit fix 21) ════════════════════════════════
    console.log('\nLeave and overtime by id (over HTTP)');

    // A colleague holding exactly what the worker holds: view_own, not view_all.
    const colleague = await makeUser('ZZ Colleague', 'colleague@verifyhr.local', [workerRole.id]);
    await prisma.employee.create({
      data: { employeeNo: `${TAG}-003`, firstName: 'Cora', lastName: 'Colleague', userId: colleague.id },
    });
    const colleagueToken = signToken(colleague.id, colleague.email);

    const ownRead = await api(workerToken, 'GET', `/leave/${first.request.id}`);
    check(
      'GET /leave/:id — the owner reads their own request',
      ownRead.status === 200 && ownRead.body.id === first.request.id && ownRead.body.number === first.request.number,
      `${ownRead.status} ${JSON.stringify(ownRead.body).slice(0, 140)}`,
    );
    check(
      'it is a list row plus proofNote, with the days as a number',
      'proofNote' in ownRead.body &&
        ownRead.body.days === 2 &&
        (ownRead.body.leaveType as { name?: string } | undefined)?.name === leaveType.name &&
        (ownRead.body.employee as { employeeNo?: string } | undefined)?.employeeNo === employee.employeeNo,
      JSON.stringify(ownRead.body).slice(0, 200),
    );
    check(
      'and it does not carry the login id behind the employee',
      !('userId' in ((ownRead.body.employee as Record<string, unknown>) ?? {})),
    );

    const peekLeave = await api(colleagueToken, 'GET', `/leave/${first.request.id}`);
    check("a colleague with view_own cannot read someone else's leave by id", peekLeave.status === 403, String(peekLeave.status));

    const hrLeave = await api(hrToken, 'GET', `/leave/${first.request.id}`);
    check('HR (view_all) reads it', hrLeave.status === 200 && hrLeave.body.id === first.request.id, String(hrLeave.status));

    const missing = await api(hrToken, 'GET', '/leave/does-not-exist');
    check('an unknown id is a 404, not an empty 200', missing.status === 404, String(missing.status));

    const typesStill = await api(workerToken, 'GET', '/leave/types');
    const balancesStill = await api(workerToken, 'GET', '/leave/balances');
    check(
      '/leave/types and /leave/balances still answer — /:id does not swallow them',
      typesStill.status === 200 &&
        Array.isArray(typesStill.body) &&
        balancesStill.status === 200 &&
        Array.isArray(balancesStill.body.balances),
      `${typesStill.status} / ${balancesStill.status}`,
    );

    // Filing over HTTP: the approval the engine raises links to the request.
    const filed = await api(workerToken, 'POST', '/leave', {
      leaveTypeId: leaveType.id,
      startDate: '2026-10-05',
      endDate: '2026-10-06',
      reason: `${TAG} by url`,
      proofNote: `${TAG} note for the approver`,
    });
    const filedId = String(filed.body.id ?? '');
    const submitted = await api(workerToken, 'POST', `/leave/${filedId}/submit`);
    check('a leave request files and submits over HTTP', filed.status === 201 && submitted.status === 200, `${filed.status} / ${submitted.status}`);

    const approvalRow = await prisma.approvalRequest.findFirst({
      where: { documentType: 'leave_request', documentId: filedId },
    });
    check(
      'the approval links to /g-hr/leave/<id>',
      approvalRow?.link === `/g-hr/leave/${filedId}`,
      `got ${approvalRow?.link}`,
    );
    const supervisorNote = await prisma.notification.findFirst({
      where: { userId: supervisor.id, link: `/g-hr/leave/${filedId}` },
    });
    check('and so does the notification the supervisor receives', !!supervisorNote);

    const submitAudit = await prisma.auditLog.findFirst({
      where: { entityType: 'leave_request', entityId: filedId, action: 'SUBMITTED' },
    });
    check('submitting a leave request is audited', !!submitAudit);

    // The approver's door: a supervisor holding only view_own can open the
    // request they are asked to decide — and nothing else of the worker's.
    const ownOnly = await makeRole('zzhr_own_only', `${TAG} Own only`, ['ghr.leave.view_own', 'ghr.overtime.view_own']);
    await prisma.userRole.create({ data: { userId: supervisor.id, roleId: ownOnly.id } });
    const supervisorToken = signToken(supervisor.id, supervisor.email);

    const approverRead = await api(supervisorToken, 'GET', `/leave/${filedId}`);
    check(
      'the approver the engine routed it to reads it with only view_own',
      approverRead.status === 200 && approverRead.body.proofNote === `${TAG} note for the approver`,
      `${approverRead.status} ${JSON.stringify(approverRead.body).slice(0, 120)}`,
    );
    check('but is not offered the cancel button', approverRead.body.canCancel === false);
    const ownerRead = await api(workerToken, 'GET', `/leave/${filedId}`);
    check('the owner is', ownerRead.body.canCancel === true);

    const colleagueOnPending = await api(colleagueToken, 'GET', `/leave/${filedId}`);
    check('a colleague still cannot', colleagueOnPending.status === 403, String(colleagueOnPending.status));

    // Overtime had the same hole: the list was scoped, the record was not.
    const otOwn = await api(workerToken, 'GET', `/overtime/${ot.id}`);
    const otPeek = await api(colleagueToken, 'GET', `/overtime/${ot.id}`);
    const otHr = await api(hrToken, 'GET', `/overtime/${ot.id}`);
    const otApprover = await api(supervisorToken, 'GET', `/overtime/${ot.id}`);
    check('GET /overtime/:id — the owner reads it', otOwn.status === 200, String(otOwn.status));
    check(
      "a colleague with view_own cannot read someone else's overtime, or its rate",
      otPeek.status === 403,
      String(otPeek.status),
    );
    check('HR reads it', otHr.status === 200, String(otHr.status));
    check(
      'the supervisor who approved it reads it with only view_own',
      otApprover.status === 200 && otApprover.body.canFileActual === false,
      `${otApprover.status}`,
    );

    // Ctrl+K: own scope finds your own filings and nobody else's.
    type Hit = { kind: string; id: string; link: string };
    const hits = async (token: string, kind: string) =>
      (((await api(token, 'GET', `/search?q=${TAG}`)).body.hits as Hit[] | undefined) ?? []).filter(
        (h) => h.kind === kind,
      );
    const workerLeaveHits = await hits(workerToken, 'leave_request');
    check(
      'search finds the owner their own leave, linked to /g-hr/leave/:id',
      workerLeaveHits.some((h) => h.id === filedId && h.link === `/g-hr/leave/${filedId}`),
      JSON.stringify(workerLeaveHits).slice(0, 160),
    );
    check("a colleague's search finds none of it", (await hits(colleagueToken, 'leave_request')).length === 0);
    check(
      'HR finds it',
      (await hits(hrToken, 'leave_request')).some((h) => h.id === filedId),
    );
    const workerOtHits = await hits(workerToken, 'overtime_request');
    check(
      'search finds the owner their own overtime, linked to /g-hr/overtime/:id',
      workerOtHits.some((h) => h.id === ot.id && h.link === `/g-hr/overtime/${ot.id}`),
    );
    check("and a colleague's finds none of it", (await hits(colleagueToken, 'overtime_request')).length === 0);

    // The filing form starts on the job this person last filed against.
    const chargeable = await api(workerToken, 'GET', '/overtime/chargeable');
    const defaults = chargeable.body.defaults as { jobId: string | null; costCategoryId: string | null } | undefined;
    check(
      '/overtime/chargeable defaults to the last job and budget line filed against',
      chargeable.status === 200 && defaults?.jobId === job.id && defaults?.costCategoryId === labour.id,
      JSON.stringify(defaults),
    );
    const colleagueDefaults = (await api(colleagueToken, 'GET', '/overtime/chargeable')).body.defaults as
      | { jobId: string | null }
      | undefined;
    check('somebody who never filed starts on no job', colleagueDefaults?.jobId === null);

    // ══ Cancelling withdraws the approval ════════════════════════════════
    // A filing cancelled while it waits on the supervisor takes its request
    // with it, through the engine: CANCELLED, out of the queue, and the
    // supervisor told who cancelled it. The routes used to close the request
    // by hand, which told nobody and audited nothing on the request.
    console.log('\nCancelling withdraws the approval (over HTTP)');

    const cancelWithdraws = async (what: string, documentType: string, documentId: string, cancelPath: string, link: string) => {
      const open = await prisma.approvalRequest.findFirst({ where: { documentType, documentId, status: 'PENDING' } });
      const queued = !!open && (await pendingFor(supervisor.id)).some((r) => r.id === open.id);
      const res = await api(workerToken, 'POST', cancelPath);
      const closed = open ? await prisma.approvalRequest.findUnique({ where: { id: open.id } }) : null;
      check(
        `${what}: cancelling it closes its request CANCELLED`,
        res.status === 200 && closed?.status === 'CANCELLED' && !!closed.closedAt,
        `${res.status}, request ${closed?.status ?? 'none was open'}`,
      );
      check(
        `${what}: and takes it out of the supervisor's queue`,
        queued && !(await pendingFor(supervisor.id)).some((r) => r.id === open?.id),
      );
      const told = await prisma.notification.findMany({ where: { type: 'approval.withdrawn', link } });
      check(
        `${what}: the supervisor is told it was withdrawn, and by whom`,
        told.some((n) => n.userId === supervisor.id && n.body === `${open?.documentNumber} — cancelled by ${worker.name}`),
        JSON.stringify(told.map((n) => n.body)),
      );
      check(`${what}: the worker who cancelled it is not told what they just did`, !told.some((n) => n.userId === worker.id));
      return res;
    };
    // The engine audits the withdrawal on the same record the module audits
    // the cancellation on; both rows are kept, as they are on submission.
    const withdrawalRow = (summary: string | null) =>
      !!summary?.startsWith('Withdrawn from approval at ') && summary.endsWith(` — cancelled by ${worker.name}`);

    // The leave filed over HTTP above is still with the supervisor.
    const filedNumber = (await prisma.leaveRequest.findUniqueOrThrow({ where: { id: filedId } })).number;
    await cancelWithdraws('leave', 'leave_request', filedId, `/leave/${filedId}/cancel`, `/g-hr/leave/${filedId}`);
    const leaveTrail = await prisma.auditLog.findMany({
      where: { entityType: 'leave_request', entityId: filedId, action: 'CANCELLED' },
    });
    check(
      "the leave's trail keeps both: the engine's withdrawal at its step, and the leave's own cancellation",
      leaveTrail.length === 2 &&
        leaveTrail.some((a) => withdrawalRow(a.summary) && a.actorId === worker.id) &&
        leaveTrail.some((a) => a.summary === `${filedNumber} cancelled` && a.actorId === worker.id),
      JSON.stringify(leaveTrail.map((a) => a.summary)),
    );

    // Overtime called off while its prior approval is still being asked for.
    const calledOff = await api(workerToken, 'POST', '/overtime', {
      date: '2026-09-24',
      plannedStart: '17:00',
      plannedEnd: '20:00',
      dinnerBreak: false,
      reason: `${TAG} called off before it started`,
    });
    const calledOffId = String(calledOff.body.id ?? '');
    await cancelWithdraws(
      'overtime awaiting prior approval',
      'overtime_prior',
      calledOffId,
      `/overtime/${calledOffId}/cancel`,
      `/g-hr/overtime/${calledOffId}`,
    );

    // Every write audits — the two overtime writes that did not. The actual
    // hours filed above wait on the supervisor.
    const cancelOt = await cancelWithdraws(
      'overtime whose actual hours are filed',
      'overtime_request',
      unauthorised.id,
      `/overtime/${unauthorised.id}/cancel`,
      `/g-hr/overtime/${unauthorised.id}`,
    );
    const otTrail = await prisma.auditLog.findMany({
      where: { entityType: 'overtime_request', entityId: unauthorised.id, action: 'CANCELLED' },
    });
    const actualAudit = await prisma.auditLog.findFirst({
      where: { entityType: 'overtime_request', entityId: unauthorised.id, action: 'SUBMITTED' },
    });
    check(
      'cancelling overtime is audited',
      cancelOt.status === 200 && otTrail.some((a) => a.summary === `${unauthorised.number} cancelled`),
      String(cancelOt.status),
    );
    check(
      "and the engine's withdrawal sits beside it on the same record",
      otTrail.length === 2 && otTrail.some((a) => withdrawalRow(a.summary)),
      JSON.stringify(otTrail.map((a) => a.summary)),
    );
    check('filing the actual hours is audited', !!actualAudit);
    const again2 = await api(workerToken, 'POST', `/overtime/${unauthorised.id}/cancel`);
    check('cancelling twice is refused', again2.status === 400, String(again2.status));

    // ══ Modify and pull back (Phase 2) ═══════════════════════════════════
    // A leave DRAFT is changed under the rules it was filed under; a pending
    // one is pulled back to draft first, through the engine. A prior filing
    // is changed while it waits on the supervisor — withdrawn and sent again
    // in one go; once authorised its plan is fixed. The actual hours are
    // pulled back and filed again. A decision that lands after any of it
    // changes nothing.
    console.log('\nModify and pull back (over HTTP)');

    const editorRole = await makeRole('zzhr_editor', `${TAG} Editor`, ['ghr.leave.edit_own', 'ghr.overtime.edit_own']);
    await prisma.userRole.create({ data: { userId: worker.id, roleId: editorRole.id } });
    const proofType = await prisma.leaveType.create({
      data: { code: `${TAG}SL`, name: `${TAG} Sick`, daysPerYear: D(5), requiresProof: true },
    });
    const withdrawnNotice = (link: string, body: string) =>
      prisma.notification.findFirst({ where: { userId: supervisor.id, type: 'approval.withdrawn', link, body } });
    const openRequest = (documentType: string, documentId: string) =>
      prisma.approvalRequest.findFirst({ where: { documentType, documentId, status: 'PENDING' } });
    const leaveBody = (over: Record<string, unknown> = {}) => ({
      leaveTypeId: leaveType.id,
      startDate: '2026-11-02',
      endDate: '2026-11-04',
      reason: `${TAG} changed plans`,
      ...over,
    });

    // ── Leave: a draft ──
    const draft = await api(workerToken, 'POST', '/leave', leaveBody({ endDate: '2026-11-03', reason: `${TAG} draft to change` }));
    const draftId = String(draft.body.id ?? '');
    const draftNumber = String(draft.body.number ?? '');
    const draftRead = await api(workerToken, 'GET', `/leave/${draftId}`);
    check(
      'a leave draft offers its owner Modify and Submit, and no pull-back',
      draft.status === 201 &&
        draftRead.body.canModify === true &&
        draftRead.body.canSubmit === true &&
        draftRead.body.canWithdraw === false,
      JSON.stringify({ m: draftRead.body.canModify, s: draftRead.body.canSubmit, w: draftRead.body.canWithdraw }),
    );

    const noRight = await api(colleagueToken, 'PUT', `/leave/${draftId}`, leaveBody());
    check('PUT /leave/:id — somebody holding no edit right is refused (403)', noRight.status === 403, String(noRight.status));
    await prisma.userRole.create({ data: { userId: colleague.id, roleId: editorRole.id } });
    const notTheirs = await api(colleagueToken, 'PUT', `/leave/${draftId}`, leaveBody());
    check(
      "a colleague holding edit_own cannot change someone else's draft (403)",
      notTheirs.status === 403 && String(notTheirs.body.error).includes('someone else'),
      `${notTheirs.status} ${JSON.stringify(notTheirs.body).slice(0, 120)}`,
    );

    const weekend = await api(workerToken, 'PUT', `/leave/${draftId}`, leaveBody({ startDate: '2026-11-07', endDate: '2026-11-08' }));
    check(
      'a change to a weekend is refused — no working days',
      weekend.status === 400 && String(weekend.body.error).includes('no working days'),
      `${weekend.status} ${JSON.stringify(weekend.body).slice(0, 120)}`,
    );
    const clashing = await api(workerToken, 'PUT', `/leave/${draftId}`, leaveBody({ startDate: '2026-09-21', endDate: '2026-09-21' }));
    check(
      'a change onto days an approved request covers is refused',
      clashing.status === 400 && String(clashing.body.error).includes('already covers'),
      `${clashing.status} ${JSON.stringify(clashing.body).slice(0, 120)}`,
    );
    const unproven = await api(workerToken, 'PUT', `/leave/${draftId}`, leaveBody({ leaveTypeId: proofType.id }));
    check(
      'a change to a type that needs proof, with none noted, is refused',
      unproven.status === 400 && String(unproven.body.error).includes('supporting documentation'),
      `${unproven.status} ${JSON.stringify(unproven.body).slice(0, 120)}`,
    );

    const changed = await api(workerToken, 'PUT', `/leave/${draftId}`, leaveBody());
    const changedRow = await prisma.leaveRequest.findUnique({ where: { id: draftId } });
    check(
      'the owner changes the draft: the days are counted again (Mon–Wed is 3)',
      changed.status === 200 && changed.body.days === 3 && num(changedRow?.days) === 3 && changedRow?.reason === `${TAG} changed plans`,
      `${changed.status} ${JSON.stringify(changed.body).slice(0, 140)}`,
    );
    check(
      'the change is audited, with what it was and what it became',
      !!(await prisma.auditLog.findFirst({
        where: {
          entityType: 'leave_request',
          entityId: draftId,
          action: 'UPDATED',
          summary: `${draftNumber} changed — 3 day(s) of ${leaveType.name}`,
          actorId: worker.id,
        },
      })),
    );
    const byHr = await api(hrToken, 'PUT', `/leave/${draftId}`, leaveBody({ reason: `${TAG} corrected by HR` }));
    check('HR (edit_all) may change somebody else’s draft', byHr.status === 200, `${byHr.status} ${JSON.stringify(byHr.body).slice(0, 120)}`);

    // ── Leave: submitted, so pulled back first ──
    const sent = await api(workerToken, 'POST', `/leave/${draftId}/submit`);
    const sentRead = await api(workerToken, 'GET', `/leave/${draftId}`);
    check(
      'once submitted it offers the pull-back instead of Modify and Submit',
      sent.status === 200 && sentRead.body.canModify === false && sentRead.body.canSubmit === false && sentRead.body.canWithdraw === true,
      `${sent.status} ${JSON.stringify({ m: sentRead.body.canModify, s: sentRead.body.canSubmit, w: sentRead.body.canWithdraw })}`,
    );
    const pendingPut = await api(workerToken, 'PUT', `/leave/${draftId}`, leaveBody());
    check(
      'a submitted request cannot be changed — it is pulled back first',
      pendingPut.status === 400 && String(pendingPut.body.error).includes('pull this one back'),
      `${pendingPut.status} ${JSON.stringify(pendingPut.body).slice(0, 120)}`,
    );
    const leaveOpen = await openRequest('leave_request', draftId);
    const strangerPull = await api(colleagueToken, 'POST', `/leave/${draftId}/withdraw`);
    check("a colleague cannot pull back someone else's request (403)", strangerPull.status === 403, String(strangerPull.status));

    const pulled = await api(workerToken, 'POST', `/leave/${draftId}/withdraw`);
    const pulledRow = await prisma.leaveRequest.findUnique({ where: { id: draftId } });
    const pulledRequest = leaveOpen ? await prisma.approvalRequest.findUnique({ where: { id: leaveOpen.id } }) : null;
    check(
      'POST /leave/:id/withdraw — the request goes back to DRAFT',
      pulled.status === 200 && pulledRow?.status === 'DRAFT',
      `${pulled.status} ${pulledRow?.status}`,
    );
    check(
      'and its approval request closes CANCELLED, out of the queue',
      pulledRequest?.status === 'CANCELLED' &&
        !!pulledRequest.closedAt &&
        !(await pendingFor(supervisor.id)).some((r) => r.id === leaveOpen?.id),
      pulledRequest?.status,
    );
    check(
      'the supervisor is told it was pulled back, and by whom',
      !!(await withdrawnNotice(`/g-hr/leave/${draftId}`, `${draftNumber} — pulled back to draft by ${worker.name}`)),
    );
    check(
      'the pull-back is audited on the request',
      !!(await prisma.auditLog.findFirst({
        where: { entityType: 'leave_request', entityId: draftId, summary: `${draftNumber} pulled back to draft` },
      })),
    );
    const usedBeforeLateDecision = (await leaveBalance(employee.id, leaveType.id, 2026)).used;
    await expectRejection(
      'a decision arriving after the pull-back is refused by the engine',
      () => act({ requestId: leaveOpen!.id, userId: supervisor.id, action: 'APPROVED' }),
      'no longer open',
    );
    const afterLateDecision = await prisma.leaveRequest.findUnique({ where: { id: draftId } });
    check(
      'and changes nothing: still DRAFT, no days drawn',
      afterLateDecision?.status === 'DRAFT' && (await leaveBalance(employee.id, leaveType.id, 2026)).used === usedBeforeLateDecision,
      afterLateDecision?.status,
    );
    const pullTwice = await api(workerToken, 'POST', `/leave/${draftId}/withdraw`);
    check(
      'a draft has nothing to pull back',
      pullTwice.status === 400 && String(pullTwice.body.error).includes('nothing to pull back'),
      `${pullTwice.status} ${JSON.stringify(pullTwice.body).slice(0, 120)}`,
    );
    const resent = await api(workerToken, 'PUT', `/leave/${draftId}`, leaveBody({ endDate: '2026-11-03' }));
    const resubmitted = await api(workerToken, 'POST', `/leave/${draftId}/submit`);
    const fresh = await openRequest('leave_request', draftId);
    check(
      'changed again and resubmitted, it is asked afresh, at the new figure',
      resent.status === 200 &&
        resubmitted.status === 200 &&
        !!fresh &&
        fresh.id !== leaveOpen?.id &&
        fresh.requesterId === worker.id &&
        fresh.subject.includes('— 2 day(s)'),
      `${resent.status}/${resubmitted.status} ${fresh?.subject}`,
    );

    // The pull-back claims the request first: its approval, landing after,
    // must not bring it back APPROVED or draw the days.
    const raced = await fileLeave('2026-11-16', '2026-11-16', 1);
    await prisma.leaveRequest.update({ where: { id: raced.request.id }, data: { status: 'DRAFT' } });
    const usedBeforeRace = (await leaveBalance(employee.id, leaveType.id, 2026)).used;
    await act({ requestId: raced.approval.id, userId: supervisor.id, action: 'APPROVED' });
    const racedAfter = await prisma.leaveRequest.findUnique({ where: { id: raced.request.id } });
    check(
      'a leave pulled back while its approval was decided stays DRAFT and draws nothing',
      racedAfter?.status === 'DRAFT' && (await leaveBalance(employee.id, leaveType.id, 2026)).used === usedBeforeRace,
      racedAfter?.status,
    );
    check(
      'its trail says the approval came after the pull-back',
      !!(await prisma.auditLog.findFirst({
        where: {
          entityType: 'leave_request',
          entityId: raced.request.id,
          summary: `${raced.request.number} was approved after it was pulled back to draft — not applied`,
        },
      })),
    );
    // A decision that claimed the request first — approved, its subscriber
    // not yet run: nothing to withdraw, so the pull-back rolls back and the
    // decision is left to apply.
    const decidedFirst = await prisma.leaveRequest.create({
      data: {
        number: await nextNumber('leave_request'),
        employeeId: employee.id,
        leaveTypeId: leaveType.id,
        startDate: day('2026-11-23'),
        endDate: day('2026-11-23'),
        days: D(1),
        reason: `${TAG} decided first`,
        status: 'PENDING_APPROVAL',
      },
    });
    const decidedAsk = (documentType: string, documentId: string, number: string, returned = false) =>
      prisma.approvalRequest.create({
        data: {
          documentType,
          documentId,
          documentNumber: number,
          subject: `${TAG} decided a moment ago`,
          requesterId: worker.id,
          // A return closes the request CANCELLED, as a withdrawal does; the
          // RETURNED action on it is what tells the two apart.
          status: returned ? 'CANCELLED' : 'APPROVED',
          closedAt: new Date(),
          actions: {
            create: { sequence: 1, approverId: supervisor.id, action: returned ? 'RETURNED' : 'APPROVED' },
          },
        },
      });
    await decidedAsk('leave_request', decidedFirst.id, decidedFirst.number);
    const tooLate = await api(workerToken, 'POST', `/leave/${decidedFirst.id}/withdraw`);
    const decidedFirstAfter = await prisma.leaveRequest.findUnique({ where: { id: decidedFirst.id } });
    check(
      'when nothing was left to withdraw the pull-back is refused and rolled back',
      tooLate.status === 400 && String(tooLate.body.error).includes('decided a moment ago') && decidedFirstAfter?.status === 'PENDING_APPROVAL',
      `${tooLate.status} ${decidedFirstAfter?.status}`,
    );
    const returnedFirst = await prisma.leaveRequest.create({
      data: {
        number: await nextNumber('leave_request'),
        employeeId: employee.id,
        leaveTypeId: leaveType.id,
        startDate: day('2026-11-24'),
        endDate: day('2026-11-24'),
        days: D(1),
        reason: `${TAG} returned first`,
        status: 'PENDING_APPROVAL',
      },
    });
    await decidedAsk('leave_request', returnedFirst.id, returnedFirst.number, true);
    const returnedPull = await api(workerToken, 'POST', `/leave/${returnedFirst.id}/withdraw`);
    const returnedAfter = await prisma.leaveRequest.findUnique({ where: { id: returnedFirst.id } });
    check(
      'a request RETURNED a moment ago (closed CANCELLED, the return on it) is a decision too: refused',
      returnedPull.status === 400 && String(returnedPull.body.error).includes('decided a moment ago') && returnedAfter?.status === 'PENDING_APPROVAL',
      `${returnedPull.status} ${returnedAfter?.status}`,
    );
    // Stranded: reads PENDING_APPROVAL, yet no request was ever opened — so
    // nothing is coming, and the pull-back must not claim a decision did.
    const strandedLeave = await prisma.leaveRequest.create({
      data: {
        number: await nextNumber('leave_request'),
        employeeId: employee.id,
        leaveTypeId: leaveType.id,
        startDate: day('2026-11-25'),
        endDate: day('2026-11-25'),
        days: D(1),
        reason: `${TAG} stranded`,
        status: 'PENDING_APPROVAL',
      },
    });
    const strandedPull = await api(workerToken, 'POST', `/leave/${strandedLeave.id}/withdraw`);
    const strandedLeaveAfter = await prisma.leaveRequest.findUnique({ where: { id: strandedLeave.id } });
    check(
      'a request stranded with nobody asked comes back to draft all the same',
      strandedPull.status === 200 && strandedLeaveAfter?.status === 'DRAFT',
      `${strandedPull.status} ${strandedLeaveAfter?.status} ${JSON.stringify(strandedPull.body).slice(0, 100)}`,
    );
    check(
      'and its trail says nothing was with an approver',
      !!(await prisma.auditLog.findFirst({
        where: {
          entityType: 'leave_request',
          entityId: strandedLeave.id,
          summary: `${strandedLeave.number} pulled back to draft — nothing was with an approver`,
        },
      })),
    );

    // ── Overtime: the prior filing, changed while it waits ──
    const plan = (over: Record<string, unknown> = {}) => ({
      date: '2026-11-05',
      plannedStart: '17:00',
      plannedEnd: '20:00',
      dinnerBreak: false,
      reason: `${TAG} plan to change`,
      ...over,
    });
    const filedOt = await api(workerToken, 'POST', '/overtime', plan());
    const otId = String(filedOt.body.id ?? '');
    const otNumber = String(filedOt.body.number ?? '');
    const otLink = `/g-hr/overtime/${otId}`;
    const firstAsk = await openRequest('overtime_prior', otId);
    const otRead = await api(workerToken, 'GET', `/overtime/${otId}`);
    check(
      'a filing awaiting authorisation offers its owner Modify, and no pull-back',
      filedOt.status === 201 && otRead.body.canModify === true && otRead.body.canWithdraw === false,
      `${filedOt.status} ${JSON.stringify({ m: otRead.body.canModify, w: otRead.body.canWithdraw })}`,
    );
    const pullPrior = await api(workerToken, 'POST', `/overtime/${otId}/withdraw`);
    check(
      'a prior filing is modified, not pulled back',
      pullPrior.status === 400 && String(pullPrior.body.error).includes('modify it instead'),
      `${pullPrior.status} ${JSON.stringify(pullPrior.body).slice(0, 120)}`,
    );
    const otStranger = await api(colleagueToken, 'PUT', `/overtime/${otId}`, plan());
    check("PUT /overtime/:id — a colleague cannot change someone else's filing (403)", otStranger.status === 403, String(otStranger.status));
    // Exactly the dinner break, with the break taken: nothing left to work.
    const zero = await api(
      workerToken,
      'PUT',
      `/overtime/${otId}`,
      plan({ plannedStart: settings.dinnerBreakStart, plannedEnd: settings.dinnerBreakEnd, dinnerBreak: true }),
    );
    const noJob = await api(workerToken, 'PUT', `/overtime/${otId}`, plan({ jobId: 'does-not-exist' }));
    check(
      'a change to zero hours, or onto a project that does not exist, is refused',
      zero.status === 400 &&
        String(zero.body.error).includes('zero hours') &&
        noJob.status === 400 &&
        String(noJob.body.error).includes('does not exist'),
      `${zero.status} / ${noJob.status} ${JSON.stringify(noJob.body).slice(0, 100)}`,
    );

    // The supervisor is about to be unreachable: the change is refused before
    // the filing is taken off their desk.
    await prisma.user.update({ where: { id: worker.id }, data: { supervisorId: worker.id } });
    const unroutable = await api(workerToken, 'PUT', `/overtime/${otId}`, plan({ plannedEnd: '21:00' }));
    await prisma.user.update({ where: { id: worker.id }, data: { supervisorId: supervisor.id } });
    const stillAsked = firstAsk ? await prisma.approvalRequest.findUnique({ where: { id: firstAsk.id } }) : null;
    const stillPlanned = await prisma.overtimeRequest.findUnique({ where: { id: otId } });
    check(
      'a change that could not be sent again is refused before anything is withdrawn',
      unroutable.status === 400 && stillAsked?.status === 'PENDING' && num(stillPlanned?.estimatedHours) === 3,
      `${unroutable.status} ${stillAsked?.status} ${num(stillPlanned?.estimatedHours)}h`,
    );

    const asksBefore = await prisma.notification.count({ where: { userId: supervisor.id, type: 'approval.required', link: otLink } });
    const otChanged = await api(workerToken, 'PUT', `/overtime/${otId}`, plan({ plannedEnd: '21:00', reason: `${TAG} plan changed` }));
    const otChangedRow = await prisma.overtimeRequest.findUnique({ where: { id: otId } });
    const firstAskAfter = firstAsk ? await prisma.approvalRequest.findUnique({ where: { id: firstAsk.id } }) : null;
    const secondAsk = await openRequest('overtime_prior', otId);
    check(
      'the owner changes it: the estimate is worked out again (17:00–21:00 is 4h), still awaiting authorisation',
      otChanged.status === 200 && otChangedRow?.stage === 'PRIOR' && num(otChangedRow.estimatedHours) === 4,
      `${otChanged.status} ${otChangedRow?.stage} ${num(otChangedRow?.estimatedHours)}h ${JSON.stringify(otChanged.body).slice(0, 100)}`,
    );
    check(
      'the request the supervisor had is withdrawn (CANCELLED), and they are told why',
      firstAskAfter?.status === 'CANCELLED' &&
        !!(await withdrawnNotice(otLink, `${otNumber} — changed by ${worker.name} and sent again`)),
      firstAskAfter?.status,
    );
    check(
      'and it is sent again from the first step, at the new figure, in the employee’s name',
      !!secondAsk &&
        secondAsk.id !== firstAsk?.id &&
        secondAsk.requesterId === worker.id &&
        secondAsk.subject.includes('4h prior approval') &&
        (await prisma.notification.count({ where: { userId: supervisor.id, type: 'approval.required', link: otLink } })) === asksBefore + 1,
      secondAsk?.subject,
    );
    check(
      'the change is audited',
      !!(await prisma.auditLog.findFirst({
        where: {
          entityType: 'overtime_request',
          entityId: otId,
          action: 'UPDATED',
          summary: `${otNumber} changed before authorisation — 4h estimated, sent again`,
        },
      })),
    );
    await expectRejection(
      'the withdrawn request can no longer be decided',
      () => act({ requestId: firstAsk!.id, userId: supervisor.id, action: 'APPROVED' }),
      'no longer open',
    );
    const otAfterLate = await prisma.overtimeRequest.findUnique({ where: { id: otId } });
    check('so the change stands: still awaiting authorisation, never authorised', otAfterLate?.stage === 'PRIOR' && otAfterLate.priorApprovedAt === null);

    // Authorised: the plan is now what was approved.
    await act({ requestId: secondAsk!.id, userId: supervisor.id, action: 'APPROVED' });
    const authorisedPut = await api(workerToken, 'PUT', `/overtime/${otId}`, plan({ plannedEnd: '22:00' }));
    const authorisedRead = await api(workerToken, 'GET', `/overtime/${otId}`);
    check(
      'once authorised the plan cannot be changed — cancel and file again',
      authorisedPut.status === 400 && String(authorisedPut.body.error).includes('authorised as planned') && authorisedRead.body.canModify === false,
      `${authorisedPut.status} ${JSON.stringify(authorisedPut.body).slice(0, 120)}`,
    );

    // ── Overtime: the actual hours, pulled back and filed again ──
    const filedActual = await api(workerToken, 'POST', `/overtime/${otId}/actual`, { actualStart: '17:00', actualEnd: '21:00' });
    const actualAsk = await openRequest('overtime_request', otId);
    const actualRead = await api(workerToken, 'GET', `/overtime/${otId}`);
    check(
      'filed actual hours offer their owner the pull-back, and no Modify',
      filedActual.status === 200 && actualRead.body.canWithdraw === true && actualRead.body.canModify === false,
      `${filedActual.status} ${JSON.stringify({ m: actualRead.body.canModify, w: actualRead.body.canWithdraw })}`,
    );
    const actualPut = await api(workerToken, 'PUT', `/overtime/${otId}`, plan());
    check(
      'filed hours are not changed in place — they are pulled back',
      actualPut.status === 400 && String(actualPut.body.error).includes('pull them back'),
      `${actualPut.status} ${JSON.stringify(actualPut.body).slice(0, 120)}`,
    );
    const hrPull = await api(hrToken, 'POST', `/overtime/${otId}/withdraw`);
    const colleaguePull = await api(colleagueToken, 'POST', `/overtime/${otId}/withdraw`);
    check(
      'only whoever may file them again pulls them back — not HR, not a colleague (403)',
      hrPull.status === 403 && colleaguePull.status === 403,
      `${hrPull.status} / ${colleaguePull.status}`,
    );
    const otPulled = await api(workerToken, 'POST', `/overtime/${otId}/withdraw`);
    const otPulledRow = await prisma.overtimeRequest.findUnique({ where: { id: otId } });
    const actualAskAfter = actualAsk ? await prisma.approvalRequest.findUnique({ where: { id: actualAsk.id } }) : null;
    check(
      'POST /overtime/:id/withdraw — back to authorised, the filed hours cleared',
      otPulled.status === 200 && otPulledRow?.stage === 'PRIOR_APPROVED' && otPulledRow.actualHours === null && otPulledRow.actualStart === null,
      `${otPulled.status} ${otPulledRow?.stage} ${otPulledRow?.actualHours}`,
    );
    check(
      'its request closes CANCELLED, and the supervisor is told',
      actualAskAfter?.status === 'CANCELLED' && !!(await withdrawnNotice(otLink, `${otNumber} — pulled back by ${worker.name}`)),
      actualAskAfter?.status,
    );
    check(
      'the pull-back is audited with the hours it took back',
      !!(await prisma.auditLog.findFirst({
        where: {
          entityType: 'overtime_request',
          entityId: otId,
          summary: `${otNumber} actual hours pulled back (4h, 17:00–21:00) — to be filed again`,
        },
      })),
    );
    await expectRejection(
      'a decision arriving after the pull-back is refused by the engine',
      () => act({ requestId: actualAsk!.id, userId: supervisor.id, action: 'APPROVED' }),
      'no longer open',
    );
    const refiled = await api(workerToken, 'POST', `/overtime/${otId}/actual`, {
      actualStart: '17:00',
      actualEnd: '20:00',
      varianceNote: `${TAG} finished early`,
    });
    const refiledRow = await prisma.overtimeRequest.findUnique({ where: { id: otId } });
    check(
      'the hours are filed again — the change — and nothing has posted',
      refiled.status === 200 &&
        refiledRow?.stage === 'ACTUAL_FILED' &&
        num(refiledRow.actualHours) === 3 &&
        (await prisma.jobCostEntry.count({ where: { sourceType: 'overtime_request', sourceId: otId } })) === 0,
      `${refiled.status} ${refiledRow?.stage} ${num(refiledRow?.actualHours)}h`,
    );

    // The pull-back claims the filing first: the hours' final approval,
    // landing after, must post nothing.
    const racedOt = await prisma.overtimeRequest.create({
      data: {
        number: await nextNumber('overtime_request'),
        employeeId: employee.id,
        date: day('2026-11-06'),
        plannedStart: '17:00',
        plannedEnd: '20:00',
        estimatedHours: D(2),
        stage: 'ACTUAL_FILED',
        actualStart: '17:00',
        actualEnd: '20:00',
        actualHours: D(2),
        reason: `${TAG} pulled back while HR decided`,
        jobId: job.id,
        costCategoryId: labour.id,
      },
    });
    const racedAsk = await submitForApproval({
      documentType: 'overtime_request',
      documentId: racedOt.id,
      documentNumber: racedOt.number,
      subject: `${TAG} pulled back`,
      requesterId: worker.id,
    });
    await act({ requestId: racedAsk.id, userId: supervisor.id, action: 'APPROVED' });
    await prisma.overtimeRequest.update({ where: { id: racedOt.id }, data: { stage: 'PRIOR_APPROVED' } });
    await act({ requestId: racedAsk.id, userId: hrOfficer.id, action: 'APPROVED' });
    const racedOtAfter = await prisma.overtimeRequest.findUnique({ where: { id: racedOt.id } });
    check(
      'hours pulled back while HR decided stay pulled back, and post no cost',
      racedOtAfter?.stage === 'PRIOR_APPROVED' &&
        racedOtAfter.amount === null &&
        (await prisma.jobCostEntry.count({ where: { sourceType: 'overtime_request', sourceId: racedOt.id } })) === 0,
      racedOtAfter?.stage,
    );
    check(
      'its trail says the approval came after the pull-back',
      !!(await prisma.auditLog.findFirst({
        where: {
          entityType: 'overtime_request',
          entityId: racedOt.id,
          summary: `${racedOt.number} was approved after it was pulled back — not applied`,
        },
      })),
    );
    const notPending = await prisma.overtimeRequest.create({
      data: {
        number: await nextNumber('overtime_request'),
        employeeId: employee.id,
        date: day('2026-11-09'),
        plannedStart: '17:00',
        plannedEnd: '20:00',
        estimatedHours: D(3),
        stage: 'ACTUAL_FILED',
        actualStart: '17:00',
        actualEnd: '20:00',
        actualHours: D(3),
        reason: `${TAG} decided before the pull-back`,
      },
    });
    await decidedAsk('overtime_request', notPending.id, notPending.number);
    const otTooLate = await api(workerToken, 'POST', `/overtime/${notPending.id}/withdraw`);
    const notPendingAfter = await prisma.overtimeRequest.findUnique({ where: { id: notPending.id } });
    check(
      'when nothing was left to withdraw the pull-back is refused and rolled back',
      otTooLate.status === 400 &&
        String(otTooLate.body.error).includes('decided a moment ago') &&
        notPendingAfter?.stage === 'ACTUAL_FILED' &&
        num(notPendingAfter.actualHours) === 3,
      `${otTooLate.status} ${notPendingAfter?.stage}`,
    );
    // Stranded: filed while the engine refused it, before the filing routes
    // put a refusal back — "awaiting approval" with nobody asked.
    const strandedHours = await prisma.overtimeRequest.create({
      data: {
        number: await nextNumber('overtime_request'),
        employeeId: employee.id,
        date: day('2026-11-11'),
        plannedStart: '17:00',
        plannedEnd: '20:00',
        estimatedHours: D(3),
        stage: 'ACTUAL_FILED',
        actualStart: '17:00',
        actualEnd: '20:00',
        actualHours: D(3),
        reason: `${TAG} hours stranded`,
      },
    });
    const strandedHoursPull = await api(workerToken, 'POST', `/overtime/${strandedHours.id}/withdraw`);
    const strandedHoursAfter = await prisma.overtimeRequest.findUnique({ where: { id: strandedHours.id } });
    check(
      'hours stranded with nobody asked come back to authorised all the same, to be filed again',
      strandedHoursPull.status === 200 && strandedHoursAfter?.stage === 'PRIOR_APPROVED' && strandedHoursAfter.actualHours === null,
      `${strandedHoursPull.status} ${strandedHoursAfter?.stage} ${JSON.stringify(strandedHoursPull.body).slice(0, 100)}`,
    );
    check(
      'and the trail says nothing was with an approver',
      !!(await prisma.auditLog.findFirst({
        where: {
          entityType: 'overtime_request',
          entityId: strandedHours.id,
          summary: { contains: '(nothing was with an approver)' },
        },
      })),
    );
    // The prior filing likewise: decided a moment ago, it stands; stranded,
    // the change is simply sent.
    const priorDecided = await prisma.overtimeRequest.create({
      data: {
        number: await nextNumber('overtime_request'),
        employeeId: employee.id,
        date: day('2026-11-12'),
        plannedStart: '17:00',
        plannedEnd: '20:00',
        estimatedHours: D(3),
        dinnerBreak: false,
        stage: 'PRIOR',
        reason: `${TAG} prior decided first`,
      },
    });
    await decidedAsk('overtime_prior', priorDecided.id, priorDecided.number);
    const priorDecidedPut = await api(
      workerToken,
      'PUT',
      `/overtime/${priorDecided.id}`,
      plan({ date: '2026-11-12', plannedEnd: '21:00', reason: `${TAG} prior decided first` }),
    );
    const priorDecidedAfter = await prisma.overtimeRequest.findUnique({ where: { id: priorDecided.id } });
    check(
      'a change to a prior filing decided a moment ago is refused, and nothing is written',
      priorDecidedPut.status === 400 &&
        String(priorDecidedPut.body.error).includes('decided a moment ago') &&
        priorDecidedAfter?.plannedEnd === '20:00' &&
        !(await openRequest('overtime_prior', priorDecided.id)),
      `${priorDecidedPut.status} ${priorDecidedAfter?.plannedEnd}`,
    );
    const strandedPrior = await prisma.overtimeRequest.create({
      data: {
        number: await nextNumber('overtime_request'),
        employeeId: employee.id,
        date: day('2026-11-13'),
        plannedStart: '17:00',
        plannedEnd: '20:00',
        estimatedHours: D(3),
        dinnerBreak: false,
        stage: 'PRIOR',
        reason: `${TAG} prior stranded`,
      },
    });
    const strandedPriorPut = await api(
      workerToken,
      'PUT',
      `/overtime/${strandedPrior.id}`,
      plan({ date: '2026-11-13', plannedEnd: '21:00', reason: `${TAG} prior stranded` }),
    );
    const strandedPriorAsk = await openRequest('overtime_prior', strandedPrior.id);
    check(
      'a prior filing stranded with nobody asked is changed and sent — for the first time',
      strandedPriorPut.status === 200 &&
        !!strandedPriorAsk &&
        strandedPriorAsk.requesterId === worker.id &&
        strandedPriorAsk.subject.includes('4h prior approval'),
      `${strandedPriorPut.status} ${strandedPriorAsk?.subject} ${JSON.stringify(strandedPriorPut.body).slice(0, 100)}`,
    );
    check(
      'and its trail says nothing was with an approver',
      !!(await prisma.auditLog.findFirst({
        where: {
          entityType: 'overtime_request',
          entityId: strandedPrior.id,
          summary: `${strandedPrior.number} changed before authorisation — 4h estimated, sent for authorisation (nothing was with an approver)`,
        },
      })),
    );

    // ── A filing the engine refuses is put back, and burns no number ──
    // Someone who reports to themselves: step 1 would route only to them.
    const loner = await makeUser('ZZ Loner', 'loner@verifyhr.local', [workerRole.id, editorRole.id]);
    await prisma.user.update({ where: { id: loner.id }, data: { supervisorId: loner.id } });
    const lonerEmployee = await prisma.employee.create({
      data: { employeeNo: `${TAG}-005`, firstName: 'Lone', lastName: 'Ranger', userId: loner.id },
    });
    const lonerToken = signToken(loner.id, loner.email);
    const lonerOt = await api(lonerToken, 'POST', '/overtime', plan({ reason: `${TAG} nobody to ask` }));
    check(
      'POST /overtime the engine would refuse is refused before anything is written — naming the real cause, their "Reports to"',
      lonerOt.status === 400 &&
        String(lonerOt.body.error).includes('"Reports to" names themselves') &&
        (await prisma.overtimeRequest.count({ where: { employeeId: lonerEmployee.id } })) === 0,
      `${lonerOt.status} ${JSON.stringify(lonerOt.body).slice(0, 120)}`,
    );
    const lonerAuthorised = await prisma.overtimeRequest.create({
      data: {
        number: await nextNumber('overtime_request'),
        employeeId: lonerEmployee.id,
        date: day('2026-11-10'),
        plannedStart: '17:00',
        plannedEnd: '20:00',
        estimatedHours: D(3),
        dinnerBreak: false,
        stage: 'PRIOR_APPROVED',
        reason: `${TAG} authorised, nobody for the hours`,
      },
    });
    const lonerActual = await api(lonerToken, 'POST', `/overtime/${lonerAuthorised.id}/actual`, { actualStart: '17:00', actualEnd: '20:00' });
    const lonerActualAfter = await prisma.overtimeRequest.findUnique({ where: { id: lonerAuthorised.id } });
    check(
      'actual hours the engine would refuse leave the filing authorised and unfiled',
      lonerActual.status === 400 && lonerActualAfter?.stage === 'PRIOR_APPROVED' && lonerActualAfter.actualHours === null,
      `${lonerActual.status} ${lonerActualAfter?.stage}`,
    );
    const lonerLeave = await api(lonerToken, 'POST', '/leave', leaveBody({ reason: `${TAG} nobody to ask` }));
    const lonerLeaveId = String(lonerLeave.body.id ?? '');
    const lonerSubmit = await api(lonerToken, 'POST', `/leave/${lonerLeaveId}/submit`);
    const lonerLeaveRead = await api(lonerToken, 'GET', `/leave/${lonerLeaveId}`);
    check(
      'a leave submission the engine refuses stays a DRAFT, still offering Submit and Modify',
      lonerSubmit.status === 400 &&
        lonerLeaveRead.body.status === 'DRAFT' &&
        lonerLeaveRead.body.canSubmit === true &&
        lonerLeaveRead.body.canModify === true,
      `${lonerSubmit.status} ${lonerLeaveRead.body.status}`,
    );

    // ── Submitting a leave draft runs the filing's rules again ──
    // The clash check ignores drafts, so two drafts for the same days could
    // otherwise both reach an approver — and, both approved, both draw.
    console.log('\nSubmitting re-checks; the employee is the requester (over HTTP)');
    const twinA = await api(workerToken, 'POST', '/leave', leaveBody({ startDate: '2026-12-01', endDate: '2026-12-02', reason: `${TAG} twin A` }));
    const twinB = await api(workerToken, 'POST', '/leave', leaveBody({ startDate: '2026-12-01', endDate: '2026-12-02', reason: `${TAG} twin B` }));
    const twinAId = String(twinA.body.id ?? '');
    const twinBId = String(twinB.body.id ?? '');
    check('two drafts for the same days are both saved — a draft is with nobody', twinA.status === 201 && twinB.status === 201);
    const sendA = await api(workerToken, 'POST', `/leave/${twinAId}/submit`);
    const sendB = await api(workerToken, 'POST', `/leave/${twinBId}/submit`);
    const twinBRow = await prisma.leaveRequest.findUnique({ where: { id: twinBId } });
    check(
      'the first submitted goes; the second is refused — the first already covers those days — and stays a DRAFT',
      sendA.status === 200 &&
        sendB.status === 400 &&
        String(sendB.body.error).includes(`${twinA.body.number} already covers`) &&
        twinBRow?.status === 'DRAFT' &&
        !(await openRequest('leave_request', twinBId)),
      `${sendA.status}/${sendB.status} ${twinBRow?.status} ${JSON.stringify(sendB.body).slice(0, 120)}`,
    );
    // Pulled back, the first frees its days: the second is sent over them, and
    // the first can then not be sent again on top of it.
    const pullA = await api(workerToken, 'POST', `/leave/${twinAId}/withdraw`);
    const sendB2 = await api(workerToken, 'POST', `/leave/${twinBId}/submit`);
    const sendA2 = await api(workerToken, 'POST', `/leave/${twinAId}/submit`);
    const twinARow = await prisma.leaveRequest.findUnique({ where: { id: twinAId } });
    check(
      'pull one back, send the other over its days, and the first is refused on resubmission — still a DRAFT',
      pullA.status === 200 &&
        sendB2.status === 200 &&
        sendA2.status === 400 &&
        String(sendA2.body.error).includes(`${twinB.body.number} already covers`) &&
        twinARow?.status === 'DRAFT',
      `${pullA.status}/${sendB2.status}/${sendA2.status} ${twinARow?.status}`,
    );
    // The days are counted again on submission: what the approver is asked
    // for is what the record says and what the balance will draw.
    await prisma.leaveRequest.update({
      where: { id: twinAId },
      data: { startDate: day('2026-12-07'), endDate: day('2026-12-09'), days: D(1) },
    });
    const sendA3 = await api(workerToken, 'POST', `/leave/${twinAId}/submit`);
    const twinA3 = await prisma.leaveRequest.findUnique({ where: { id: twinAId } });
    const twinAAsk = await openRequest('leave_request', twinAId);
    check(
      'a draft carrying a stale day count is counted again on submission (Mon–Wed is 3), and the approver is asked for 3',
      sendA3.status === 200 && twinA3?.status === 'PENDING_APPROVAL' && num(twinA3.days) === 3 && !!twinAAsk?.subject.includes('— 3 day(s)'),
      `${sendA3.status} ${num(twinA3?.days)} ${twinAAsk?.subject}`,
    );

    // A super admin sending somebody's draft on files it in the EMPLOYEE's
    // name, so the employee can never approve their own leave.
    const admin = await makeUser('ZZ Admin', 'admin@verifyhr.local', []);
    await prisma.user.update({ where: { id: admin.id }, data: { isSuperAdmin: true } });
    const adminToken = signToken(admin.id, admin.email);
    const forAdmin = await api(workerToken, 'POST', '/leave', leaveBody({ startDate: '2026-12-14', endDate: '2026-12-14', reason: `${TAG} sent on by an admin` }));
    const forAdminId = String(forAdmin.body.id ?? '');
    const draftStamp = (await prisma.leaveRequest.findUnique({ where: { id: forAdminId } }))?.updatedAt;
    await api(workerToken, 'PUT', `/leave/${forAdminId}`, leaveBody({ startDate: '2026-12-14', endDate: '2026-12-14', reason: `${TAG} sent on by an admin, changed` }));
    const changedStamp = (await prisma.leaveRequest.findUnique({ where: { id: forAdminId } }))?.updatedAt;
    check(
      'a change moves the draft’s updatedAt — what the submission and the next change claim against',
      !!draftStamp && !!changedStamp && changedStamp.getTime() > draftStamp.getTime(),
    );
    const adminSend = await api(adminToken, 'POST', `/leave/${forAdminId}/submit`);
    const adminAsk = await openRequest('leave_request', forAdminId);
    check(
      'a super admin submitting the worker’s draft files it in the worker’s name',
      adminSend.status === 200 && adminAsk?.requesterId === worker.id,
      `${adminSend.status} ${adminAsk?.requesterId === admin.id ? 'the admin' : adminAsk?.requesterId}`,
    );
    await expectRejection(
      'so the worker cannot approve it',
      () => act({ requestId: adminAsk!.id, userId: worker.id, action: 'APPROVED' }),
      'raised yourself',
    );

    // HR changing the worker's prior filing: sent again in the worker's name,
    // and the worker is told it was taken off the supervisor's desk.
    const hrEdit = await api(workerToken, 'POST', '/overtime', plan({ date: '2026-12-03', reason: `${TAG} HR corrects the plan` }));
    const hrEditId = String(hrEdit.body.id ?? '');
    const hrFirstAsk = await openRequest('overtime_prior', hrEditId);
    const hrView = await api(hrToken, 'GET', `/overtime/${hrEditId}`);
    const workerView = await api(workerToken, 'GET', `/overtime/${hrEditId}`);
    check(
      'the record says whose it is, and prices at the employee’s rate whoever reads it',
      hrView.body.own === false &&
        workerView.body.own === true &&
        hrView.body.canModify === true &&
        JSON.stringify(hrView.body.rate) === JSON.stringify(workerView.body.rate),
      `${hrView.body.own}/${workerView.body.own} ${JSON.stringify(hrView.body.rate)}`,
    );
    const byHrOt = await api(hrToken, 'PUT', `/overtime/${hrEditId}`, plan({ date: '2026-12-03', plannedEnd: '21:00', reason: `${TAG} HR corrects the plan` }));
    const hrSecondAsk = await openRequest('overtime_prior', hrEditId);
    check(
      'HR (edit_all) changes the worker’s filing, and it is sent again in the WORKER’s name',
      byHrOt.status === 200 && !!hrSecondAsk && hrSecondAsk.id !== hrFirstAsk?.id && hrSecondAsk.requesterId === worker.id,
      `${byHrOt.status} ${hrSecondAsk?.requesterId === hrOfficer.id ? 'HR' : hrSecondAsk?.requesterId} ${JSON.stringify(byHrOt.body).slice(0, 100)}`,
    );
    check(
      'and the worker is told the request was withdrawn — somebody else changed it',
      !!(await prisma.notification.findFirst({
        where: {
          userId: worker.id,
          type: 'approval.withdrawn',
          link: `/g-hr/overtime/${hrEditId}`,
          body: `${hrEdit.body.number} — changed by ${hrOfficer.name} and sent again`,
        },
      })),
    );
    const plain = await makeUser('ZZ Plain', 'plain@verifyhr.local', [workerRole.id]);
    const plainPut = await api(signToken(plain.id, plain.email), 'PUT', `/overtime/${hrEditId}`, plan({ date: '2026-12-03' }));
    check('PUT /overtime/:id — somebody holding no edit right is refused (403)', plainPut.status === 403, String(plainPut.status));

    // The actual hours: a super admin filing them files them in the worker's
    // name; a project or budget line named with them is checked like a plan's.
    const authorisedFor = async (date: string, reason: string) =>
      prisma.overtimeRequest.create({
        data: {
          number: await nextNumber('overtime_request'),
          employeeId: employee.id,
          date: day(date),
          plannedStart: '17:00',
          plannedEnd: '20:00',
          estimatedHours: D(3),
          dinnerBreak: false,
          stage: 'PRIOR_APPROVED',
          reason,
        },
      });
    const adminFiles = await authorisedFor('2026-12-04', `${TAG} hours filed by an admin`);
    const adminActual = await api(adminToken, 'POST', `/overtime/${adminFiles.id}/actual`, { actualStart: '17:00', actualEnd: '20:00' });
    const adminActualAsk = await openRequest('overtime_request', adminFiles.id);
    check(
      'a super admin filing the worker’s actual hours files them in the worker’s name',
      adminActual.status === 200 && adminActualAsk?.requesterId === worker.id,
      `${adminActual.status} ${adminActualAsk?.requesterId === admin.id ? 'the admin' : adminActualAsk?.requesterId}`,
    );

    const charged = await authorisedFor('2026-12-08', `${TAG} hours charged on filing`);
    const strayJob = await api(workerToken, 'POST', `/overtime/${charged.id}/actual`, { actualStart: '17:00', actualEnd: '20:00', jobId: 'does-not-exist' });
    const strayLine = await api(workerToken, 'POST', `/overtime/${charged.id}/actual`, {
      actualStart: '17:00',
      actualEnd: '20:00',
      jobId: job.id,
      costCategoryId: 'does-not-exist',
    });
    const jobStatus = (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status;
    await prisma.job.update({ where: { id: job.id }, data: { status: 'TURNED_OVER' } });
    const closedJob = await api(workerToken, 'POST', `/overtime/${charged.id}/actual`, { actualStart: '17:00', actualEnd: '20:00', jobId: job.id });
    await prisma.job.update({ where: { id: job.id }, data: { status: jobStatus } });
    const chargedAfter = await prisma.overtimeRequest.findUnique({ where: { id: charged.id } });
    check(
      'POST /overtime/:id/actual — a project or budget line that does not exist is a 400, not a 500',
      strayJob.status === 400 &&
        String(strayJob.body.error).includes('project does not exist') &&
        strayLine.status === 400 &&
        String(strayLine.body.error).includes('budget line does not exist'),
      `${strayJob.status} / ${strayLine.status} ${JSON.stringify(strayLine.body).slice(0, 100)}`,
    );
    check(
      'and a closed project is refused — it takes no more overtime; the filing stays authorised and unfiled',
      closedJob.status === 400 &&
        String(closedJob.body.error).includes('no longer takes overtime') &&
        chargedAfter?.stage === 'PRIOR_APPROVED' &&
        chargedAfter.actualHours === null &&
        chargedAfter.jobId === null &&
        !(await openRequest('overtime_request', charged.id)),
      `${closedJob.status} ${chargedAfter?.stage}`,
    );
    const chargedOk = await api(workerToken, 'POST', `/overtime/${charged.id}/actual`, {
      actualStart: '17:00',
      actualEnd: '20:00',
      jobId: job.id,
      costCategoryId: labour.id,
    });
    const chargedOkRow = await prisma.overtimeRequest.findUnique({ where: { id: charged.id } });
    check(
      'an open project and a real budget line are taken',
      chargedOk.status === 200 && chargedOkRow?.jobId === job.id && chargedOkRow.costCategoryId === labour.id,
      `${chargedOk.status} ${JSON.stringify(chargedOk.body).slice(0, 100)}`,
    );

    // The pre-check refuses exactly what the engine refuses, no more: a
    // "Reports to" who has been deactivated is accepted by the engine for
    // leave, so overtime is not refused for it either — the two agree.
    await prisma.user.update({ where: { id: supervisor.id }, data: { isActive: false } });
    const otAway = await api(workerToken, 'POST', '/overtime', plan({ date: '2026-12-10', reason: `${TAG} supervisor away` }));
    const leaveAway = await api(workerToken, 'POST', '/leave', leaveBody({ startDate: '2026-12-10', endDate: '2026-12-10', reason: `${TAG} supervisor away` }));
    const leaveAwaySend = await api(workerToken, 'POST', `/leave/${String(leaveAway.body.id ?? '')}/submit`);
    await prisma.user.update({ where: { id: supervisor.id }, data: { isActive: true } });
    check(
      'with "Reports to" deactivated, overtime and leave agree — the engine accepts both, and so does the pre-check',
      otAway.status === 201 && leaveAwaySend.status === 200,
      `${otAway.status} / ${leaveAwaySend.status} ${JSON.stringify(otAway.body).slice(0, 120)}`,
    );

    // The clock's "Ask HR to link it" becomes a link — for HR only.
    const unlinkedHr = await prisma.user.create({
      data: {
        name: 'ZZ Unlinked HR',
        email: 'unlinked@verifyhr.local',
        employeeNo: `${TAG}-004`,
        passwordHash: await bcrypt.hash('x', 10),
        roles: { create: [{ roleId: hrRole.id }] },
      },
    });
    const orphan = await prisma.employee.create({
      data: { employeeNo: `${TAG}-004`, firstName: 'Una', lastName: 'Linked' },
    });
    const unlinkedMe = await api(signToken(unlinkedHr.id, unlinkedHr.email), 'GET', '/clock/me');
    check(
      "clock/me offers HR the unlinked record carrying the login's employee number",
      unlinkedMe.body.employee === null && (unlinkedMe.body.candidate as { id?: string } | null)?.id === orphan.id,
      JSON.stringify(unlinkedMe.body.candidate),
    );
    // The same login, stripped of HR: the record is no longer named.
    await prisma.userRole.deleteMany({ where: { userId: unlinkedHr.id } });
    await prisma.userRole.create({ data: { userId: unlinkedHr.id, roleId: workerRole.id } });
    const plainMe = await api(signToken(unlinkedHr.id, unlinkedHr.email), 'GET', '/clock/me');
    check(
      'and names no employee record to somebody who cannot open the register',
      plainMe.status === 200 && plainMe.body.candidate === null,
      JSON.stringify(plainMe.body.candidate),
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

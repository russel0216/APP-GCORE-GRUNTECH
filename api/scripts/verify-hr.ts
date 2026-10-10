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
 *     similar people — and must never let one person's face open another
 *     person's account (2026-10-10, "sometimes they matched other account
 *     faces"): three samples before the face clock opens, samples that look
 *     like each other and like nobody else, only the current engine's
 *     descriptors compared, and every refusal on HR's audit trail without the
 *     colleague's name in the person's face.
 *
 * The arithmetic is checked directly. The route guards — double clock-in,
 * filing actual hours before authorisation, clocking in as somebody else — are
 * checked over HTTP, because that is where they live.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
  saveHrSettings,
  faceDistance,
  matchFace,
  decideFace,
  FACE_MARGIN,
  MIN_FACE_SAMPLES,
  MAX_FACE_SAMPLES,
  attendanceDay,
  dayKey,
  toMinutes,
  fromMinutes,
} from '../src/shared/hr';
import { describeFace, faceQualityProblem, FACE_ENGINE, type FaceQuality } from '../src/shared/face';
import { migrateFaceThreshold, rederiveFaceSamples, separateAccountPhotos } from '../src/shared/faceSamples';
import { attachmentPath, deleteAttachment } from '../src/shared/attachments';
import { formatAmount, formatMoney, statusLabel } from '../src/shared/pdf';
// Registers the leave and overtime approval subscribers (a side effect), and
// lends the overtime paper's stage words.
import { OT_STAGE_LABEL } from '../src/routes/hr';
import {
  checkListPaper,
  checkOwnPaper,
  flat,
  printed,
  readScreen,
  referenceOf,
  saysCount,
  splittingValue,
  squash,
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
  const testUsers = await prisma.user.findMany({
    where: { email: { endsWith: '@verifyhr.local' } },
    select: { id: true },
  });
  // Face samples, clock-in captures and account photos: their rows go with
  // the uploader (a cascade), but the files on disk would stay for good.
  const files = await prisma.attachment.findMany({
    where: {
      OR: [
        { uploadedById: { in: testUsers.map((u) => u.id) } },
        { entityType: { in: ['face_enrollment', 'attendance'] }, entityId: { in: employeeIds } },
      ],
    },
    select: { id: true },
  });
  for (const file of files) await deleteAttachment(file.id);
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
 * @vladmandic/face-api ships sample images with its demo. Under the SSD
 * detector every `sampleN.jpg` is a group (sample2, which the old tiny
 * detector read as one face, holds three); the one single face is the demo's
 * webcam screenshot — person A here. Person B is one face cut out of
 * sample6, framed with the margin a webcam would give it. The whole pipeline
 * (decode → detect → level → 128 floats) is exercised on actual faces, not on
 * numbers this script made up.
 */
const SAMPLES = path.join(process.cwd(), 'node_modules/@vladmandic/face-api/demo');
const sample = (file: string) => fs.readFileSync(path.join(SAMPLES, file));
const webcamPhoto = () => sample('screenshot-webcam.png');

/**
 * The threshold the engine was calibrated for (HR Settings' default since
 * FACE_ENGINE). The photograph checks hold to it rather than to whatever this
 * database stores, because it is the stricter of the two values in use.
 */
const FACE_DEFAULT_THRESHOLD = 0.55;

/** One face of sample6 (the second from the left), with room around it: a different person. */
async function personBPhoto(): Promise<Buffer> {
  return sharp(sample('sample6.jpg'))
    .extract({ left: 994, top: 165, width: 560, height: 560 })
    .resize(400, 400)
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** The same photo through a different camera pipeline — smaller and lossier. */
const recompressed = (buf: Buffer) => sharp(buf).resize(400).jpeg({ quality: 60 }).toBuffer();
/** The head tilted: the frame turned, its corners filled grey as a webcam's would not be, but no matter. */
const rotated = (buf: Buffer, degrees: number) =>
  sharp(buf).rotate(degrees, { background: { r: 128, g: 128, b: 128 } }).jpeg({ quality: 92 }).toBuffer();
const asJpeg = (buf: Buffer) => sharp(buf).jpeg({ quality: 92 }).toBuffer();
const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

/** The upload folder's file names, to see what a request left behind. */
const uploadedFiles = () => new Set(fs.readdirSync(env.uploadDir));
/**
 * Files written since `before` holding exactly these bytes. Compared by
 * content, not by count, so another script uploading at the same moment
 * cannot make a refused capture look kept, or a kept one look refused.
 */
function leftBehind(before: Set<string>, bytes: Buffer): number {
  const hash = sha256(bytes);
  let n = 0;
  for (const name of fs.readdirSync(env.uploadDir)) {
    if (before.has(name)) continue;
    try {
      if (sha256(fs.readFileSync(path.join(env.uploadDir, name))) === hash) n++;
    } catch {
      /* removed meanwhile */
    }
  }
  return n;
}

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

/** A multipart request, as the Clock page sends a capture. */
async function apiForm(
  token: string,
  path: string,
  image: Buffer,
  fields: Record<string, string> = {},
  fileField = 'photo',
): Promise<HttpResult> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set(fileField, new Blob([image], { type: 'image/jpeg' }), 'capture.jpg');
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
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

  /** A sample described by the engine this server runs — the only kind the clock compares with. */
  const currentSample = (employeeId: string, d: number[]) =>
    prisma.faceEnrollment.create({
      data: { employeeId, descriptor: d as unknown as Prisma.InputJsonValue, engine: FACE_ENGINE },
    });
  const decide = (m: { own: number | null; nearestOther: { employeeId: string; name: string; distance: number } | null; threshold: number }) =>
    decideFace({ own: m.own, nearestOther: m.nearestOther, threshold: m.threshold, margin: FACE_MARGIN });
  const verdict = (d: ReturnType<typeof decideFace>) => (d.ok ? 'ok' : d.reason);

  await currentSample(employee.id, descriptor(1));

  const hit = await matchFace(descriptor(1, 0.02), employee.id);
  check(
    'a fresh capture of an enrolled face matches its owner',
    hit.best?.employeeId === employee.id && hit.own != null && hit.own < hit.threshold,
    `own ${hit.own?.toFixed(3)} vs threshold ${hit.threshold}`,
  );
  check('and the decision accepts it', verdict(decide(hit)) === 'ok', verdict(decide(hit)));

  const miss = await matchFace(descriptor(9), employee.id);
  check(
    'a stranger does not match anyone under the threshold, and is refused as not recognised',
    (miss.own == null || miss.own > miss.threshold) && verdict(decide(miss)) === 'not_recognised',
    `own ${miss.own?.toFixed(3)} vs threshold ${miss.threshold}: ${verdict(decide(miss))}`,
  );

  /*
    LEGACY samples — another engine's, or none recorded — take no part. The
    same photo through two pipelines lands ~0.1 apart, so comparing a capture
    with an old descriptor measures the pipelines as much as the faces. Here
    the colleague's legacy rows are an EXACT copy of the face, and still the
    owner is matched as though they were not there.
  */
  await prisma.faceEnrollment.createMany({
    data: [
      { employeeId: other.id, descriptor: descriptor(1) as unknown as Prisma.InputJsonValue },
      { employeeId: other.id, descriptor: descriptor(1) as unknown as Prisma.InputJsonValue, engine: 'tiny-legacy-0' },
    ],
  });
  const withLegacy = await matchFace(descriptor(1, 0.02), employee.id);
  check(
    "another person's legacy samples are ignored by matching, even an exact copy of the face",
    withLegacy.nearestOther?.employeeId !== other.id && verdict(decide(withLegacy)) === 'ok',
    `nearest other ${withLegacy.nearestOther?.name ?? 'none'}: ${verdict(decide(withLegacy))}`,
  );
  const legacyOnly = await matchFace(descriptor(1), other.id);
  check(
    'a person whose only samples are legacy has no distance of their own — their face is not matched at all',
    legacyOnly.own === null,
    `own ${legacyOnly.own}`,
  );
  check(
    "and that face, claimed on their account, is the enrolled colleague's: not this account",
    verdict(decide(legacyOnly)) === 'not_this_account' && legacyOnly.nearestOther?.employeeId === employee.id,
    verdict(decide(legacyOnly)),
  );
  await prisma.faceEnrollment.deleteMany({ where: { employeeId: other.id } });

  // A near-duplicate enrolment is the ambiguity the clock route has to catch.
  await currentSample(other.id, descriptor(1, 0.03));
  const ambiguous = await matchFace(descriptor(1, 0.015), employee.id);
  check(
    'two similar enrolments are reported as nearly equal, not silently resolved',
    !!ambiguous.nearestOther && ambiguous.own != null && Math.abs(ambiguous.nearestOther.distance - ambiguous.own) < FACE_MARGIN,
    `own ${ambiguous.own?.toFixed(4)}, other ${ambiguous.nearestOther?.distance.toFixed(4)}`,
  );
  check(
    'and the clock refuses to pick between them — neither person is accepted',
    !decide(ambiguous).ok && !decide(await matchFace(descriptor(1, 0.015), other.id)).ok,
  );
  await prisma.faceEnrollment.deleteMany({ where: { employeeId: other.id } });

  const alone = await matchFace(descriptor(1, 0.02), employee.id);
  check('the match is accepted again once the duplicate is removed', decide(alone).ok);

  // ── The decision, at its edges ───────────────────────────────────────────
  //
  // decideFace() is pure. Threshold 0.55 and the 0.05 margin; both edges are
  // inclusive — exactly the threshold passes, a lead of exactly the margin
  // passes — and 0.45 − 0.40 must not lose to floating point.
  console.log('\nThe face decision (decideFace)');
  const rival = (distance: number) => ({ employeeId: 'zz-other', name: 'ZZ Colleague', distance });
  const edge = (own: number | null, near: ReturnType<typeof rival> | null) =>
    verdict(decideFace({ own, nearestOther: near, threshold: 0.55, margin: FACE_MARGIN }));
  const decisions: [string, number | null, ReturnType<typeof rival> | null, string][] = [
    ['accepted: within the threshold, nobody else near', 0.4, null, 'ok'],
    ['accepted at exactly the threshold', 0.55, null, 'ok'],
    ['accepted: a lead of exactly the margin (0.45 against 0.40)', 0.4, rival(0.45), 'ok'],
    ['accepted: a colleague far behind does not get in the way', 0.3, rival(0.9), 'ok'],
    ['not recognised: just over the threshold, nobody near', 0.5501, null, 'not_recognised'],
    ['not recognised: no samples of their own and nobody near', null, null, 'not_recognised'],
    ['not recognised: over the threshold, the nearest colleague just over it too', 0.7, rival(0.5501), 'not_recognised'],
    ['unsure: a lead just short of the margin', 0.4, rival(0.4499), 'unsure'],
    ['unsure: a dead heat', 0.4, rival(0.4), 'unsure'],
    ['unsure: a colleague within the margin, though over the threshold', 0.54, rival(0.56), 'unsure'],
    ['not this account: a colleague nearer than the owner, both within', 0.45, rival(0.4), 'not_this_account'],
    ['not this account: the owner over the threshold, a colleague within', 0.7, rival(0.5), 'not_this_account'],
    ['not this account: the colleague at exactly the threshold', 0.6, rival(0.55), 'not_this_account'],
    ['not this account: no samples of their own, a colleague within', null, rival(0.3), 'not_this_account'],
  ];
  for (const [label, own, near, want] of decisions) {
    const got = edge(own, near);
    check(`decideFace — ${label}`, got === want, `got ${got}`);
  }

  // ── The quality gates ────────────────────────────────────────────────────
  //
  // faceQualityProblem() is pure too. Enrolment is strict (a sample is what
  // everybody is measured against); the clock refuses only what makes a
  // descriptor unreliable; re-deriving a stored sample has no gate at all.
  console.log('\nThe capture quality gates');
  const SMALL = 'Come closer to the camera — your face is too small in the picture.';
  const DARK = 'It is too dark to see your face clearly — face the light, or turn a light on.';
  const TURNED = 'Look straight at the camera.';
  const goodQuality: FaceQuality = {
    score: 0.95,
    eyeDistance: 90,
    brightness: 120,
    yaw: 0.05,
    tilt: 1,
    levelled: false,
    contrastRetry: false,
    frameScale: 1,
  };
  const q = (patch: Partial<FaceQuality>): FaceQuality => ({ ...goodQuality, ...patch });
  const gate = (patch: Partial<FaceQuality>, purpose: 'enrol' | 'clock' | 'rederive') =>
    faceQualityProblem(q(patch), purpose);
  check(
    'a good capture passes both gates',
    gate({}, 'enrol') === null && gate({}, 'clock') === null,
  );
  check(
    'a dim face (luma 30) is refused for enrolment as too dark, and passed at the clock',
    gate({ brightness: 30 }, 'enrol') === DARK && gate({ brightness: 30 }, 'clock') === null,
    String(gate({ brightness: 30 }, 'enrol')),
  );
  check('a face nearly black (luma 10) is refused at the clock too', gate({ brightness: 10 }, 'clock') === DARK);
  check(
    'eyes 30 px apart are too small to enrol, and fine at the clock; 15 px is too small for either',
    gate({ eyeDistance: 30 }, 'enrol') === SMALL && gate({ eyeDistance: 30 }, 'clock') === null && gate({ eyeDistance: 15 }, 'clock') === SMALL,
  );
  check(
    'the size is judged on the pixels the nets saw: 50 px in a frame shrunk by a third is 37.5, too small to enrol',
    gate({ eyeDistance: 50, frameScale: 4 / 3 }, 'enrol') === SMALL && gate({ eyeDistance: 50 }, 'enrol') === null,
  );
  check(
    'a head turned well aside (yaw 0.45) is refused for enrolment, passed at the clock; past 0.6 the clock refuses it too',
    gate({ yaw: -0.45 }, 'enrol') === TURNED && gate({ yaw: -0.45 }, 'clock') === null && gate({ yaw: 0.7 }, 'clock') === TURNED,
  );
  check(
    'a tilted sample enrols only when it was levelled, and never past 20°',
    gate({ tilt: 8, levelled: true }, 'enrol') === null &&
      /upright/.test(String(gate({ tilt: 8, levelled: false }, 'enrol'))) &&
      /upright/.test(String(gate({ tilt: 25, levelled: true }, 'enrol'))),
  );
  check(
    'at the clock a levelled tilt passes at any angle; an unlevelled one past 15° does not',
    gate({ tilt: 25, levelled: true }, 'clock') === null && /upright/.test(String(gate({ tilt: 20, levelled: false }, 'clock'))),
  );
  check(
    'a low detector confidence (0.6) is refused for enrolment only',
    /could not see your face clearly/.test(String(gate({ score: 0.6 }, 'enrol'))) && gate({ score: 0.6 }, 'clock') === null,
  );
  check(
    're-deriving a stored sample has no gate: the photo was accepted when it was taken',
    gate({ eyeDistance: 10, brightness: 5, yaw: 0.9, tilt: 40, score: 0.3 }, 'rederive') === null,
  );

  // ── The detector, on real photographs ──────────────────────────────────
  console.log('\nThe face engine, on real photographs');

  await expectRejection(
    'describing a face without saying why (clock, enrol or rederive) is a programming error',
    () => describeFace(webcamPhoto(), {} as { purpose: 'clock' }),
    'needs a purpose',
  );

  const blank = await sharp({
    create: { width: 480, height: 640, channels: 3, background: { r: 120, g: 130, b: 140 } },
  })
    .jpeg()
    .toBuffer();
  await expectRejection(
    'a photo with no face in it is refused',
    () => describeFace(blank, { purpose: 'clock' }),
    'no face was found',
  );

  // Two people in frame is how you would clock in a colleague who is not
  // there. Picking the largest face would make that work — and a frame with
  // several faces is never retried.
  await expectRejection(
    'a photo with more than one face in it is refused',
    () => describeFace(sample('sample1.jpg'), { purpose: 'clock' }),
    'faces are in that photo',
  );

  const personA = await describeFace(webcamPhoto(), { purpose: 'enrol' });
  const personB = await describeFace(await personBPhoto(), { purpose: 'enrol' });
  check('a real photograph yields 128 floats', personA.descriptor.length === 128);
  check('the detector reports its confidence', personA.score > 0.5, `score ${personA.score}`);
  check(
    'and how good a capture it was: eye distance, brightness, turn and tilt, none of it rescued',
    personA.quality.eyeDistance > 45 &&
      personA.quality.brightness > 45 &&
      Math.abs(personA.quality.yaw) < 0.35 &&
      typeof personA.quality.tilt === 'number' &&
      personA.quality.contrastRetry === false &&
      faceQualityProblem(personA.quality, 'enrol') === null,
    JSON.stringify(personA.quality),
  );
  check(
    'the second fixture is a single, enrollable face of somebody else',
    faceQualityProblem(personB.quality, 'enrol') === null,
    JSON.stringify(personB.quality),
  );

  const personAAgain = await describeFace(await recompressed(webcamPhoto()), { purpose: 'clock' });
  const sameDistance = faceDistance(personA.descriptor, personAAgain.descriptor);
  const differentDistance = faceDistance(personA.descriptor, personB.descriptor);
  check(
    'the same face through a smaller, lossier capture still matches',
    sameDistance < FACE_DEFAULT_THRESHOLD,
    `distance ${sameDistance.toFixed(3)} vs threshold ${FACE_DEFAULT_THRESHOLD}`,
  );
  check(
    'two different people are further apart than the threshold',
    differentDistance > FACE_DEFAULT_THRESHOLD,
    `distance ${differentDistance.toFixed(3)} vs threshold ${FACE_DEFAULT_THRESHOLD}`,
  );
  check(
    'and the gap between the two is wide, not marginal',
    differentDistance - sameDistance > 0.25,
    `same ${sameDistance.toFixed(3)}, different ${differentDistance.toFixed(3)}`,
  );

  /*
    Levelling. face-api crops the descriptor's face along the landmarks but
    never turns it, so a tilted head used to read as a somewhat different
    face — the benchmark's main source of wrong-account matches. The engine
    now turns the frame until the eyes are level and describes it again.
  */
  const tilted = await describeFace(await rotated(webcamPhoto(), 12), { purpose: 'clock' });
  const tiltedDistance = faceDistance(personA.descriptor, tilted.descriptor);
  check(
    'a head tilted 12° is levelled before it is described',
    tilted.quality.levelled === true && Math.abs(tilted.quality.tilt) >= 3,
    JSON.stringify(tilted.quality),
  );
  check(
    'and still matches its upright self under the threshold',
    tiltedDistance < FACE_DEFAULT_THRESHOLD,
    `distance ${tiltedDistance.toFixed(3)}`,
  );
  check(
    'while somebody else stays over it',
    faceDistance(tilted.descriptor, personB.descriptor) > FACE_DEFAULT_THRESHOLD,
    `distance ${faceDistance(tilted.descriptor, personB.descriptor).toFixed(3)}`,
  );

  // The enrolment gate on real frames, and the clock's leniency.
  const far = await describeFace(await sharp(webcamPhoto()).resize(240).jpeg({ quality: 92 }).toBuffer(), {
    purpose: 'enrol',
  });
  check(
    'a small, far-away copy is refused for enrolment with the size message',
    faceQualityProblem(far.quality, 'enrol') === SMALL,
    `${faceQualityProblem(far.quality, 'enrol')} ${JSON.stringify(far.quality)}`,
  );
  check(
    'the clock lets the same frame through, and it still matches its owner',
    faceQualityProblem(far.quality, 'clock') === null && faceDistance(personA.descriptor, far.descriptor) < FACE_DEFAULT_THRESHOLD,
    `distance ${faceDistance(personA.descriptor, far.descriptor).toFixed(3)}`,
  );
  const glare = await describeFace(await sharp(webcamPhoto()).linear(2.4, 0).jpeg({ quality: 92 }).toBuffer(), {
    purpose: 'enrol',
  });
  check(
    'a face washed out by glare is refused for enrolment, passed at the clock',
    /too much light/.test(String(faceQualityProblem(glare.quality, 'enrol'))) && faceQualityProblem(glare.quality, 'clock') === null,
    `${faceQualityProblem(glare.quality, 'enrol')} (luma ${glare.quality.brightness})`,
  );

  /*
    The contrast retry: a dark office is the commonest reason the detector
    sees nothing, so the clock — and only the clock — tries once more on a
    contrast-stretched copy when the plain pass found no face. An enrolment
    sample is never rescued that way, nor is a stored photo re-derived.
  */
  const dark = await sharp(webcamPhoto()).linear(0.3, 0).jpeg({ quality: 92 }).toBuffer();
  await expectRejection(
    'a dark frame finds no face for enrolment — a sample is never rescued by stretching the contrast',
    () => describeFace(dark, { purpose: 'enrol' }),
    'no face was found',
  );
  await expectRejection(
    'nor when a stored photo is re-derived',
    () => describeFace(dark, { purpose: 'rederive' }),
    'no face was found',
  );
  const darkAtTheDoor = await describeFace(dark, { purpose: 'clock' });
  check(
    "at the clock the contrast retry finds it, says so, and reports the room's darkness, not the stretched copy's",
    darkAtTheDoor.quality.contrastRetry === true && darkAtTheDoor.quality.brightness < 45,
    JSON.stringify(darkAtTheDoor.quality),
  );
  check(
    'and the rescued capture passes the clock gate and matches its owner',
    faceQualityProblem(darkAtTheDoor.quality, 'clock') === null &&
      faceDistance(personA.descriptor, darkAtTheDoor.descriptor) < FACE_DEFAULT_THRESHOLD,
    `distance ${faceDistance(personA.descriptor, darkAtTheDoor.descriptor).toFixed(3)}`,
  );

  // The whole pipeline: enrol from a photo, then recognise a later capture.
  await prisma.faceEnrollment.deleteMany({ where: { employeeId: { in: [employee.id, other.id] } } });
  await currentSample(employee.id, personA.descriptor);
  await currentSample(other.id, personB.descriptor);

  const recognised = await matchFace(personAAgain.descriptor, employee.id);
  check(
    'a later capture of an enrolled person is recognised as them',
    recognised.best?.employeeId === employee.id && recognised.own != null && recognised.own < recognised.threshold,
    `matched ${recognised.best?.name} at ${recognised.best?.distance.toFixed(3)}`,
  );
  check(
    'and accepted: the other enrolled person is far behind, not a tie',
    decide(recognised).ok && !!recognised.nearestOther && recognised.nearestOther.distance - recognised.own! > FACE_MARGIN,
    `gap ${((recognised.nearestOther?.distance ?? 0) - (recognised.own ?? 0)).toFixed(3)}`,
  );

  const strangerAtTheDoor = await matchFace(personB.descriptor, employee.id);
  check(
    "the other person's face on the first person's account is refused as not this account",
    verdict(decide(strangerAtTheDoor)) === 'not_this_account' && strangerAtTheDoor.nearestOther?.employeeId === other.id,
    `${verdict(decide(strangerAtTheDoor))}, nearest other ${strangerAtTheDoor.nearestOther?.name}`,
  );
  check(
    'and on their own account it is accepted',
    decide(await matchFace(personB.descriptor, other.id)).ok,
  );
  await prisma.faceEnrollment.deleteMany({ where: { employeeId: { in: [employee.id, other.id] } } });

  // One face at a time, and only a few waiting: the engine is WebAssembly on
  // the API's own thread. Ten captures at once — the eight that fit are
  // described, the rest are told the clock is busy; the boot-time
  // re-derivation always waits its turn.
  const small = await sharp(webcamPhoto()).resize(320).jpeg({ quality: 85 }).toBuffer();
  const rush = await Promise.allSettled(Array.from({ length: 10 }, () => describeFace(small, { purpose: 'clock' })));
  const busy = rush.filter(
    (r) => r.status === 'rejected' && (r.reason as { status?: number }).status === 429 && /busy/.test(String((r.reason as Error).message)),
  ).length;
  const queuedRederive = await Promise.allSettled([
    ...Array.from({ length: 8 }, () => describeFace(small, { purpose: 'clock' })),
    describeFace(small, { purpose: 'rederive' }),
  ]);
  check(
    'the face engine describes one capture at a time with at most eight waiting: the rest are a 429, never a pile-up',
    rush.filter((r) => r.status === 'fulfilled').length === 8 && busy === 2,
    rush.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as { status?: number }).status)).join(','),
  );
  check(
    'and the re-derivation is never turned away — it waits its turn',
    queuedRederive[8].status === 'fulfilled',
    queuedRederive.map((r) => r.status).join(','),
  );

  // ══ Re-deriving legacy samples ═══════════════════════════════════════════
  //
  // A sample described by an older engine is LEGACY: it is never compared
  // with a new capture. At boot the API describes every legacy sample again
  // from its photo — rederiveFaceSamples() — so an upgrade sends nobody back
  // to the camera if their photo is still on disk.
  console.log('\nRe-deriving legacy samples');
  {
    /** A stored file as the upload route would have left it, filed under the worker. */
    const storedPhoto = async (bytes: Buffer | null, fileName: string) => {
      const storedName = `zzhr-${crypto.randomBytes(8).toString('hex')}.jpg`;
      if (bytes) fs.writeFileSync(path.join(env.uploadDir, storedName), bytes);
      return prisma.attachment.create({
        data: {
          entityType: 'face_enrollment',
          entityId: employee.id,
          fileName,
          storedName,
          mimeType: 'image/jpeg',
          size: bytes?.length ?? 0,
          uploadedById: worker.id,
        },
      });
    };
    const legacy = (photoPath: string | null, engine: string | null) =>
      prisma.faceEnrollment.create({
        data: {
          employeeId: employee.id,
          // An older engine's numbers: nothing like what the new one says.
          descriptor: descriptor(5) as unknown as Prisma.InputJsonValue,
          engine,
          photoPath,
        },
      });

    // Legacy rows that are not this script's are re-derived too (the API
    // would do the same at its next boot); only a run that touched nothing
    // else leaves no audit row behind.
    const foreign = await prisma.faceEnrollment.count({
      where: {
        OR: [{ engine: null }, { engine: { not: FACE_ENGINE } }],
        photoPath: { not: null },
        employeeId: { notIn: [employee.id] },
      },
    });
    const rederiveStarted = new Date();

    const goodPhoto = await storedPhoto(webcamPhoto(), 'legacy-good.png');
    const groupPhoto = await storedPhoto(sample('sample1.jpg'), 'legacy-group.jpg');
    const lostPhoto = await storedPhoto(null, 'legacy-lost.jpg');
    const recoverable = await legacy(goodPhoto.id, null);
    const crowded = await legacy(groupPhoto.id, 'tiny-legacy-0');
    const noPhoto = await legacy(null, null);
    const fileGone = await legacy(lostPhoto.id, null);

    const run = await rederiveFaceSamples();
    const [recoverableAfter, crowdedAfter, noPhotoAfter, fileGoneAfter] = await Promise.all(
      [recoverable, crowded, noPhoto, fileGone].map((r) => prisma.faceEnrollment.findUnique({ where: { id: r.id } })),
    );
    const recomputedDescriptor = (recoverableAfter?.descriptor ?? []) as number[];
    check(
      'a legacy sample whose photo is on disk is described again under the current engine, with its quality',
      recoverableAfter?.engine === FACE_ENGINE &&
        typeof (recoverableAfter.quality as { eyeDistance?: unknown } | null)?.eyeDistance === 'number' &&
        faceDistance(recomputedDescriptor, personA.descriptor) < 1e-6,
      `${recoverableAfter?.engine} ${faceDistance(recomputedDescriptor, personA.descriptor)}`,
    );
    const crowdedQuality = crowdedAfter?.quality as { rederiveFailed?: string; engine?: string } | null;
    check(
      'one whose photo holds several faces keeps its old engine and records why, against this engine',
      crowdedAfter?.engine === 'tiny-legacy-0' &&
        /faces are in that photo/.test(String(crowdedQuality?.rederiveFailed)) &&
        crowdedQuality?.engine === FACE_ENGINE,
      JSON.stringify(crowdedAfter?.quality),
    );
    check(
      'one with no photo, or whose file is gone from disk, stays exactly as it was',
      noPhotoAfter?.engine === null && noPhotoAfter.quality === null && fileGoneAfter?.engine === null && fileGoneAfter.quality === null,
    );
    check(
      'the run reports what it did',
      run.recomputed >= 1 && run.failed >= 1,
      JSON.stringify(run),
    );
    const rederiveAudit = await prisma.auditLog.findMany({
      where: { entityType: 'setting', entityId: 'hr.rules', at: { gte: rederiveStarted }, summary: { contains: 're-derived' } },
    });
    check('and leaves one audit row saying so', rederiveAudit.length === 1, `${rederiveAudit.length} row(s)`);

    const again = await rederiveFaceSamples();
    const crowdedAgain = await prisma.faceEnrollment.findUnique({ where: { id: crowded.id } });
    check(
      'a second run changes nothing — a photo that failed is not retried under the same engine',
      again.recomputed === 0 && again.failed === 0 && JSON.stringify(crowdedAgain?.quality) === JSON.stringify(crowdedAfter?.quality),
      JSON.stringify(again),
    );
    const afterUpgrade = await matchFace(personAAgain.descriptor, employee.id);
    check(
      'and the re-derived sample matches a new capture of its owner',
      afterUpgrade.own != null && afterUpgrade.own < afterUpgrade.threshold,
      `own ${afterUpgrade.own?.toFixed(3)}`,
    );

    // The same face's old sample on ANOTHER person: re-deriving it without the
    // collision check enrolment applies would let one face open two accounts.
    const twinPhoto = await storedPhoto(webcamPhoto(), 'legacy-twin.png');
    const twin = await prisma.faceEnrollment.create({
      data: {
        employeeId: other.id,
        descriptor: descriptor(6) as unknown as Prisma.InputJsonValue,
        engine: null,
        photoPath: twinPhoto.id,
      },
    });
    const third = await rederiveFaceSamples();
    const twinAfter = await prisma.faceEnrollment.findUnique({ where: { id: twin.id } });
    const twinQuality = twinAfter?.quality as { rederiveFailed?: string } | null;
    check(
      "a legacy sample that comes out as another employee's face is not taken into use — and its reason names nobody",
      third.failed === 1 &&
        twinAfter?.engine === null &&
        /too close to another employee/i.test(String(twinQuality?.rederiveFailed)) &&
        !/Zeno|Worker/.test(String(twinQuality?.rederiveFailed)),
      `${JSON.stringify(third)} ${JSON.stringify(twinAfter?.quality)}`,
    );
    const rederiveAudits = await prisma.auditLog.findMany({
      where: { entityType: 'setting', entityId: 'hr.rules', at: { gte: rederiveStarted }, summary: { contains: 're-derived' } },
    });

    // An account photo that IS a sample's capture (every enrolment before the
    // separation made it so) becomes a small picture of its own at boot.
    const separationStarted = new Date();
    await prisma.user.update({ where: { id: worker.id }, data: { photoPath: goodPhoto.id } });
    const separated = await separateAccountPhotos();
    const workerPhoto = await prisma.user.findUnique({ where: { id: worker.id }, select: { photoPath: true } });
    const avatar = workerPhoto?.photoPath
      ? await prisma.attachment.findUnique({ where: { id: workerPhoto.photoPath } })
      : null;
    const avatarSize = avatar ? await sharp(fs.readFileSync(attachmentPath(avatar.storedName))).metadata() : null;
    check(
      "an account photo that is a face sample's capture becomes a 96-pixel picture of its own, the capture left with its sample",
      separated >= 1 &&
        avatar?.entityType === 'user' &&
        avatar.entityId === worker.id &&
        avatarSize?.width === 96 &&
        avatarSize.height === 96 &&
        (avatar.caption ?? '').includes(recoverable.id) &&
        !!(await prisma.attachment.findUnique({ where: { id: goodPhoto.id } })),
      `${separated} ${avatar?.entityType} ${avatarSize?.width}x${avatarSize?.height} ${avatar?.caption}`,
    );
    check('and a second run finds nothing left to separate', (await separateAccountPhotos()) === 0);
    await prisma.user.update({ where: { id: worker.id }, data: { photoPath: null } });
    if (avatar) await deleteAttachment(avatar.id);

    await prisma.faceEnrollment.deleteMany({ where: { employeeId: { in: [employee.id, other.id] } } });
    for (const a of [goodPhoto, groupPhoto, lostPhoto, twinPhoto]) await deleteAttachment(a.id);
    if (foreign === 0) await prisma.auditLog.deleteMany({ where: { id: { in: rederiveAudits.map((r) => r.id) } } });
    if (separated === 1) {
      await prisma.auditLog.deleteMany({
        where: { entityType: 'setting', at: { gte: separationStarted }, summary: { startsWith: 'Account photos separated' } },
      });
    }
  }

  // ══ The threshold migration ══════════════════════════════════════════════
  //
  // Every install's seed stored 0.6, face-api's default for the old engine.
  // The seed moves a stored 0.6 to 0.55 exactly once; any other stored value
  // is somebody's choice and stays. The real setting is put back afterwards.
  console.log('\nThe face threshold migration');
  {
    const MARKER = 'seed.faceEngineMigrated';
    const realRules = await prisma.setting.findUnique({ where: { key: 'hr.rules' } });
    const realMarker = await prisma.setting.findUnique({ where: { key: MARKER } });
    const migrationStarted = new Date();
    const stored = async () => (await hrSettings()).faceThreshold;
    try {
      await prisma.setting.deleteMany({ where: { key: MARKER } });
      await saveHrSettings({ faceThreshold: 0.6 });
      const first = await migrateFaceThreshold();
      check(
        'a stored 0.6 — the old engine default — becomes 0.55',
        first?.changed === true && first.from === 0.6 && first.to === 0.55 && (await stored()) === 0.55,
        `${JSON.stringify(first)} → ${await stored()}`,
      );
      const marked = await prisma.setting.findUnique({ where: { key: MARKER } });
      const moved = await prisma.auditLog.findFirst({
        where: { entityType: 'setting', entityId: 'hr.rules', at: { gte: migrationStarted }, summary: { startsWith: 'Face match threshold moved' } },
      });
      check('the move is marked as done, and audited', !!marked && !!moved);

      const second = await migrateFaceThreshold();
      check('it happens once: a second run does nothing', second === null && (await stored()) === 0.55, JSON.stringify(second));

      await saveHrSettings({ faceThreshold: 0.6 });
      const afterChoice = await migrateFaceThreshold();
      check(
        'so HR setting 0.6 again afterwards is kept',
        afterChoice === null && (await stored()) === 0.6,
        `${JSON.stringify(afterChoice)} → ${await stored()}`,
      );

      await prisma.setting.deleteMany({ where: { key: MARKER } });
      await saveHrSettings({ faceThreshold: 0.5 });
      const kept = await migrateFaceThreshold();
      check(
        "another stored value is an administrator's choice: kept, and the migration still marked as done",
        kept?.changed === false && (await stored()) === 0.5 && !!(await prisma.setting.findUnique({ where: { key: MARKER } })),
        `${JSON.stringify(kept)} → ${await stored()}`,
      );
    } finally {
      if (realRules) {
        await prisma.setting.update({
          where: { key: 'hr.rules' },
          data: { value: realRules.value as Prisma.InputJsonValue },
        });
      } else {
        await prisma.setting.deleteMany({ where: { key: 'hr.rules' } });
      }
      await prisma.setting.deleteMany({ where: { key: MARKER } });
      if (realMarker) {
        await prisma.setting.create({
          data: {
            key: MARKER,
            value: realMarker.value as Prisma.InputJsonValue,
            description: realMarker.description,
          },
        });
      }
      await prisma.auditLog.deleteMany({
        where: {
          entityType: 'setting',
          entityId: 'hr.rules',
          at: { gte: migrationStarted },
          summary: { startsWith: 'Face match threshold moved' },
        },
      });
    }
    check(
      'the real setting is back as it was',
      JSON.stringify((await prisma.setting.findUnique({ where: { key: 'hr.rules' } }))?.value ?? null) ===
        JSON.stringify(realRules?.value ?? null) &&
        !!(await prisma.setting.findUnique({ where: { key: MARKER } })) === !!realMarker,
    );
  }

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
      'clock/me knows who the signed-in person is — and that with no face samples they are not enrolled',
      me.status === 200 &&
        (me.body.employee as { id: string } | null)?.id === employee.id &&
        me.body.enrolled === false &&
        me.body.faceSamples === 0 &&
        me.body.samplesNeeded === MIN_FACE_SAMPLES &&
        me.body.maxSamples === MAX_FACE_SAMPLES,
      JSON.stringify(me.body).slice(0, 160),
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

    // ══ Face clock-in over HTTP ═══════════════════════════════════════════
    //
    // The routes as the Clock page uses them: three samples before the face
    // clock opens, five at most, samples that look like their owner and like
    // nobody else, and a refusal that never tells the person at the camera
    // whose account their face came close to — while HR's audit trail does.
    console.log('\nFace clock-in (over HTTP)');
    {
      // A supervisor (the dashboard right, as the seeded role holds it) with
      // Faye reporting to them, one without, and somebody holding only the
      // employee register's read right — finance's, for labour rates.
      const bossRole = await makeRole('zzhr_face_boss', `${TAG} Face supervisor`, ['ghr.dashboard.view_all']);
      const readerRole = await makeRole('zzhr_face_reader', `${TAG} Register reader`, ['ghr.employees.view_all']);
      const boss = await makeUser('ZZ Face Boss', 'faceboss@verifyhr.local', [bossRole.id]);
      const otherBoss = await makeUser('ZZ Other Boss', 'otherboss@verifyhr.local', [bossRole.id]);
      const reader = await makeUser('ZZ Register Reader', 'facereader@verifyhr.local', [readerRole.id]);
      const bossToken = signToken(boss.id, boss.email);
      const otherBossToken = signToken(otherBoss.id, otherBoss.email);
      const readerToken = signToken(reader.id, reader.email);
      const person = async (key: string, first: string, last: string, no: string, supervisorId?: string) => {
        const user = await makeUser(`ZZ ${first} ${last}`, `${key}@verifyhr.local`, [workerRole.id], supervisorId);
        const row = await prisma.employee.create({
          data: { employeeNo: `${TAG}-${no}`, firstName: first, lastName: last, userId: user.id },
        });
        return { user, employee: row, token: signToken(user.id, user.email) };
      };
      const faye = await person('face', 'Faye', 'Facet', '011', boss.id);
      const tomas = await person('twin', 'Tomas', 'Twin', '012');
      const peeker = await person('peeker', 'Pia', 'Peeker', '013');
      const gone = await prisma.employee.create({
        data: { employeeNo: `${TAG}-014`, firstName: 'Ivo', lastName: 'Inactive', isActive: false },
      });
      const threshold = (await hrSettings()).faceThreshold;

      // Faye is the webcam face, Tomas the face from sample6, and the stranger
      // one face of sample3 — each a capture the way a camera would vary it.
      const A = await asJpeg(webcamPhoto());
      const aLeft = await rotated(webcamPhoto(), 6);
      const aRight = await rotated(webcamPhoto(), -6);
      const aDim = await sharp(webcamPhoto()).modulate({ brightness: 0.9 }).jpeg({ quality: 92 }).toBuffer();
      const aTilted = await rotated(webcamPhoto(), 12);
      const aSmall = await recompressed(webcamPhoto());
      const aFar = await sharp(webcamPhoto()).resize(240).jpeg({ quality: 92 }).toBuffer();
      // Across the room: the face 110 px wide in a 640×480 frame, its eyes some 15 px apart.
      const aAcrossTheRoom = await sharp({
        create: { width: 640, height: 480, channels: 3, background: { r: 128, g: 128, b: 128 } },
      })
        .composite([{ input: await sharp(webcamPhoto()).resize(110).toBuffer(), left: 200, top: 100 }])
        .jpeg({ quality: 92 })
        .toBuffer();
      const B = await personBPhoto();
      const bLeft = await rotated(B, 6);
      const bRight = await rotated(B, -6);
      const bDim = await sharp(B).modulate({ brightness: 0.9 }).jpeg({ quality: 92 }).toBuffer();
      const stranger = await sharp(sample('sample3.jpg'))
        .extract({ left: 414, top: 194, width: 542, height: 542 })
        .resize(400, 400)
        .jpeg({ quality: 92 })
        .toBuffer();

      const CLOCK_SAYS = {
        not_recognised: 'Face not recognised. Face the camera in good light and try again, or use the fallback.',
        not_this_account: 'That face does not match the one enrolled on this account.',
        replay: 'That picture has been sent before. Look at the camera and take a new one.',
      };
      const ENROL_SAYS = {
        full: 'Five samples are on file — remove one before adding another.',
        inconsistent:
          'This does not look like the samples already on your account. Retake facing the camera in good light — if ' +
          'those samples are of someone else, remove them first.',
        collision:
          "This face is too close to another employee's enrolled face for the clock to tell you apart. Use the " +
          'fallback and tell HR.',
      };
      const needsSamples = (n: number) =>
        `Face clock-in needs ${MIN_FACE_SAMPLES} samples of your face — you have ${n}. Add them on this page, or use the fallback.`;

      const enrol = (token: string, image: Buffer, employeeId?: string) =>
        apiForm(token, '/clock/enroll', image, employeeId ? { employeeId } : {});
      const faceClock = (action: 'IN' | 'OUT', image: Buffer) =>
        apiForm(faye.token, '/clock', image, { action, method: 'FACE' });
      const fileStatus = async (token: string, id: string) => {
        const res = await fetch(`${BASE}/attachments/file/${id}`, { headers: { Authorization: `Bearer ${token}` } });
        await res.arrayBuffer();
        return res.status;
      };
      const accountPhoto = async (userId: string) =>
        (await prisma.user.findUnique({ where: { id: userId }, select: { photoPath: true } }))?.photoPath ?? null;
      const refusals = () =>
        prisma.auditLog.findMany({
          where: { entityType: 'attendance', entityId: faye.employee.id, action: 'REJECTED' },
          orderBy: { at: 'desc' },
        });
      type RefusalAfter = {
        faceRefusal?: string;
        ownDistance?: number | null;
        nearestOther?: { name?: string; distance?: number } | null;
      };

      /** A face at Faye's clock that must be refused: the words, one audit row with its reason, no file kept. */
      const refusedClock = async (
        label: string,
        action: 'IN' | 'OUT',
        image: Buffer,
        says: string | RegExp,
        reason: string,
      ) => {
        const files = uploadedFiles();
        const rowsBefore = (await refusals()).length;
        const res = await faceClock(action, image);
        const rows = await refusals();
        const after = (rows[0]?.after ?? {}) as RefusalAfter;
        const error = String(res.body.error ?? '');
        const stray = leftBehind(files, image);
        check(
          label,
          res.status === 400 && (typeof says === 'string' ? error === says : says.test(error)),
          `${res.status} ${error}`,
        );
        check(
          `and it is on HR's audit trail as "${reason}", the capture deleted from disk`,
          rows.length === rowsBefore + 1 && after.faceRefusal === reason && stray === 0,
          `${rows.length - rowsBefore} row(s), reason ${after.faceRefusal}, ${stray} file(s) left`,
        );
        return { res, row: rows[0], after };
      };

      const me0 = await api(faye.token, 'GET', '/clock/me');
      check(
        'a new person has no face samples: clock/me says 0 of the 3 needed, 5 at most, not enrolled',
        me0.status === 200 &&
          me0.body.faceSamples === 0 &&
          me0.body.legacySamples === 0 &&
          me0.body.enrolled === false &&
          me0.body.samplesNeeded === 3 &&
          me0.body.maxSamples === 5,
        JSON.stringify(me0.body).slice(0, 200),
      );

      await refusedClock('a face clock-in with no samples is refused, saying how many are needed', 'IN', A, needsSamples(0), 'too_few_samples');

      // ── Enrolment: three samples ──
      const first = await enrol(faye.token, A);
      check(
        'the first sample is accepted — one of three, not enrolled yet',
        first.status === 201 && first.body.samples === 1 && first.body.enrolled === false && first.body.samplesNeeded === 3,
        `${first.status} ${JSON.stringify(first.body).slice(0, 160)}`,
      );
      const firstRow = await prisma.faceEnrollment.findUnique({ where: { id: String(first.body.id) } });
      check(
        'a sample stores the engine that described it and how good a capture it was',
        firstRow?.engine === FACE_ENGINE &&
          typeof (firstRow.quality as { eyeDistance?: unknown } | null)?.eyeDistance === 'number' &&
          firstRow.enrolledById === faye.user.id,
        `${firstRow?.engine} ${JSON.stringify(firstRow?.quality)}`,
      );
      const firstAccount = await accountPhoto(faye.user.id);
      const firstAvatar = firstAccount ? await prisma.attachment.findUnique({ where: { id: firstAccount } }) : null;
      const firstAvatarSize = firstAvatar
        ? await sharp(fs.readFileSync(attachmentPath(firstAvatar.storedName))).metadata()
        : null;
      check(
        'her account photo is made FROM the capture — a 96-pixel picture of its own, never the sample photo itself',
        !!firstRow?.photoPath &&
          !!firstAvatar &&
          firstAvatar.id !== firstRow.photoPath &&
          firstAvatar.entityType === 'user' &&
          firstAvatarSize?.width === 96 &&
          firstAvatarSize.height === 96,
        `sample ${firstRow?.photoPath} vs account ${firstAccount} (${firstAvatar?.entityType} ${firstAvatarSize?.width}px)`,
      );
      const photoRes = await fetch(`${BASE}/attachments/file/${firstAccount}`, {
        headers: { Authorization: `Bearer ${faye.token}` },
      });
      await photoRes.arrayBuffer();
      check(
        'and that photo is fetchable — the /file/:id route is not shadowed',
        photoRes.status === 200 && (photoRes.headers.get('content-type') ?? '').startsWith('image/'),
        `${photoRes.status} ${photoRes.headers.get('content-type')}`,
      );

      await refusedClock('with one sample the face clock is still closed', 'IN', A, needsSamples(1), 'too_few_samples');

      const second = await enrol(faye.token, aLeft);
      check('a second sample, the head turned a little, is accepted', second.status === 201 && second.body.samples === 2, `${second.status} ${JSON.stringify(second.body).slice(0, 160)}`);
      const firstPhoto = await prisma.attachment.findUnique({ where: { id: firstRow?.photoPath ?? '' } });
      const secondAccount = await accountPhoto(faye.user.id);
      check(
        "a second sample gives her a new picture: the first picture goes, the first sample's photo stays",
        !!firstPhoto &&
          fs.existsSync(attachmentPath(firstPhoto.storedName)) &&
          !!secondAccount &&
          secondAccount !== firstAccount &&
          !(await prisma.attachment.findUnique({ where: { id: firstAccount ?? '' } })),
      );
      await refusedClock('with two it is still closed', 'IN', A, needsSamples(2), 'too_few_samples');

      const third = await enrol(faye.token, aDim);
      check(
        'the third sample enrols her',
        third.status === 201 && third.body.samples === 3 && third.body.enrolled === true,
        `${third.status} ${JSON.stringify(third.body).slice(0, 160)}`,
      );
      const me3 = await api(faye.token, 'GET', '/clock/me');
      check('clock/me agrees: three current samples, enrolled', me3.body.faceSamples === 3 && me3.body.enrolled === true, JSON.stringify(me3.body).slice(0, 120));

      const farFiles = uploadedFiles();
      const far = await enrol(faye.token, aFar);
      check(
        'a sample taken from too far away is refused with the size message, and its file is not kept',
        far.status === 400 && far.body.error === SMALL && leftBehind(farFiles, aFar) === 0,
        `${far.status} ${String(far.body.error)}`,
      );

      // ── The clock ──
      const inFiles = uploadedFiles();
      const clockedIn = await faceClock('IN', aTilted);
      const todayRow = await prisma.attendance.findUnique({
        where: { employeeId_date: { employeeId: faye.employee.id, date: dayKey(new Date()) } },
      });
      check(
        'with three samples her face clocks her in — the head tilted 12°',
        clockedIn.status === 200 && todayRow?.timeInMethod === 'FACE',
        `${clockedIn.status} ${JSON.stringify(clockedIn.body).slice(0, 160)}`,
      );
      check(
        'the match distance is stored with the entry, under the threshold',
        todayRow?.timeInScore != null && Number(todayRow.timeInScore) < threshold,
        String(todayRow?.timeInScore),
      );
      const inPhoto = todayRow?.timeInPhoto
        ? await prisma.attachment.findUnique({ where: { id: todayRow.timeInPhoto } })
        : null;
      check(
        'and the capture is kept as the evidence',
        !!inPhoto && leftBehind(inFiles, aTilted) === 1 && fs.existsSync(attachmentPath(inPhoto.storedName)),
      );
      if (inPhoto) {
        check(
          "a clock-in photo is the person's and HR's: she and HR open it, a colleague cannot",
          (await fileStatus(faye.token, inPhoto.id)) === 200 &&
            (await fileStatus(hrToken, inPhoto.id)) === 200 &&
            (await fileStatus(peeker.token, inPhoto.id)) === 404,
        );
        check(
          'her own supervisor opens it; a supervisor she does not report to does not, nor somebody with only the register',
          (await fileStatus(bossToken, inPhoto.id)) === 200 &&
            (await fileStatus(otherBossToken, inPhoto.id)) === 404 &&
            (await fileStatus(readerToken, inPhoto.id)) === 404,
        );
        const registerRow = async (token: string) => {
          const list = await api(token, 'GET', `/attendance?employeeId=${faye.employee.id}`);
          return ((list.body.rows ?? []) as { timeInPhoto?: string | null; timeInScore?: number | null }[])[0];
        };
        const [bossRow, otherBossRow] = [await registerRow(bossToken), await registerRow(otherBossToken)];
        check(
          'and the attendance register sends the photo only to who may open it — both see the entry and its distance',
          bossRow?.timeInPhoto === inPhoto.id &&
            otherBossRow !== undefined &&
            otherBossRow.timeInPhoto === null &&
            typeof otherBossRow.timeInScore === 'number',
          `${bossRow?.timeInPhoto} / ${otherBossRow?.timeInPhoto}`,
        );
        const dropEvidence = await api(faye.token, 'DELETE', `/attachments/${inPhoto.id}`);
        check(
          'and nobody deletes clock-in evidence through the generic attachment route, not even who uploaded it',
          dropEvidence.status === 403 && !!(await prisma.attachment.findUnique({ where: { id: inPhoto.id } })),
          String(dropEvidence.status),
        );
      }

      await refusedClock(
        "a sample's own bytes sent to the clock are refused as a picture sent before — not clocked in at distance 0",
        'OUT',
        A,
        CLOCK_SAYS.replay,
        'replay',
      );
      await refusedClock(
        "and so is the photo of an earlier clock-in, whose bytes are on file as that entry's evidence",
        'OUT',
        aTilted,
        CLOCK_SAYS.replay,
        'replay',
      );
      await refusedClock('a face across the room is refused at the clock, saying to come closer', 'OUT', aAcrossTheRoom, SMALL, 'quality');
      const strangerRefused = await refusedClock(
        'a stranger at her clock is refused as not recognised',
        'OUT',
        stranger,
        CLOCK_SAYS.not_recognised,
        'not_recognised',
      );
      check(
        "the audit row records the reason and how near her own samples came",
        /Face not recognised/.test(strangerRefused.row?.summary ?? '') && typeof strangerRefused.after.ownDistance === 'number',
        strangerRefused.row?.summary ?? '',
      );
      await refusedClock('a frame with two people in it is refused, never matched', 'OUT', sample('sample1.jpg'), /faces are in that photo/, 'several_faces');

      // ── Collision and consistency at enrolment ──
      const collisionFiles = uploadedFiles();
      const collision = await enrol(tomas.token, aRight);
      check(
        "a colleague enrolling a face too close to Faye's is refused — and not told whose it is",
        collision.status === 400 && collision.body.error === ENROL_SAYS.collision && !String(collision.body.error).includes('Faye'),
        `${collision.status} ${String(collision.body.error)}`,
      );
      const collisionAudit = await prisma.auditLog.findFirst({
        where: { entityType: 'employee', entityId: tomas.employee.id, action: 'REJECTED' },
        orderBy: { at: 'desc' },
      });
      const collisionAfter = (collisionAudit?.after ?? {}) as RefusalAfter;
      check(
        "the audit row names whose face it came close to in its detail, never on its one line — and the capture is not kept",
        collisionAfter.nearestOther?.name === 'Faye Facet' &&
          !/Faye|\d\.\d/.test(collisionAudit?.summary ?? '') &&
          leftBehind(collisionFiles, aRight) === 0 &&
          (await prisma.faceEnrollment.count({ where: { employeeId: tomas.employee.id } })) === 0,
        collisionAudit?.summary ?? 'no audit row',
      );
      const tomasHome = await api(tomas.token, 'GET', '/my-work');
      check(
        'his own My Work shows the refusal without her name',
        tomasHome.status === 200 &&
          JSON.stringify(tomasHome.body.recentActivity ?? []).includes('Face sample refused') &&
          !JSON.stringify(tomasHome.body.recentActivity ?? []).includes('Faye'),
        JSON.stringify(tomasHome.body.recentActivity ?? []).slice(0, 200),
      );
      const hrCollision = await enrol(hrToken, aRight, tomas.employee.id);
      check(
        'HR enrolling the same face for him is told whose face it is',
        hrCollision.status === 400 && String(hrCollision.body.error).includes('Faye Facet'),
        `${hrCollision.status} ${String(hrCollision.body.error)}`,
      );

      const wrongTarget = [
        await enrol(hrToken, A, gone.id),
        await enrol(hrToken, A, 'no-such-employee'),
        await enrol(peeker.token, A, faye.employee.id),
      ];
      check(
        'nobody is enrolled on an inactive record (400) or an unknown one (404), and only HR enrols somebody else (403)',
        wrongTarget[0].status === 400 &&
          /inactive/i.test(String(wrongTarget[0].body.error)) &&
          wrongTarget[1].status === 404 &&
          wrongTarget[2].status === 403,
        wrongTarget.map((r) => `${r.status} ${String(r.body.error)}`).join(' · '),
      );

      const tomasSamples = [await enrol(tomas.token, B), await enrol(tomas.token, bLeft), await enrol(tomas.token, bRight)];
      check(
        'Tomas enrols his own face beside hers — three samples',
        tomasSamples.every((r) => r.status === 201) && tomasSamples[2].body.enrolled === true,
        tomasSamples.map((r) => `${r.status} ${String(r.body.error ?? '')}`).join(' · '),
      );

      const wrongFace = await refusedClock(
        "Tomas's face at Faye's clock is refused as not her account",
        'OUT',
        bDim,
        CLOCK_SAYS.not_this_account,
        'not_this_account',
      );
      check(
        "the person at the camera is never told whose face it was; the audit row's detail says, its one line does not",
        !String(wrongFace.res.body.error).includes('Tomas') &&
          wrongFace.after.nearestOther?.name === 'Tomas Twin' &&
          !/Tomas|\d\.\d/.test(wrongFace.row?.summary ?? ''),
        wrongFace.row?.summary ?? '',
      );
      const fayeHome = await api(faye.token, 'GET', '/my-work');
      const fayeTrail = await api(faye.token, 'GET', `/audit/attendance/${faye.employee.id}`);
      const peekTrail = await api(peeker.token, 'GET', `/audit/attendance/${faye.employee.id}`);
      const fayeRecent = JSON.stringify(fayeHome.body.recentActivity ?? []);
      check(
        'nor can she read it afterwards: My Work lists the refusal by its one line, and the record\'s own history is the audit trail\'s (403)',
        fayeHome.status === 200 &&
          fayeRecent.includes('refused') &&
          !fayeRecent.includes('Tomas') &&
          !fayeRecent.includes('nearestOther') &&
          fayeTrail.status === 403 &&
          !JSON.stringify(fayeTrail.body).includes('Tomas') &&
          peekTrail.status === 403,
        `${fayeHome.status} ${fayeRecent.slice(0, 160)} / ${fayeTrail.status} / ${peekTrail.status}`,
      );

      const inconsistentFiles = uploadedFiles();
      const inconsistent = await enrol(faye.token, bDim);
      check(
        "a sample that does not look like her own samples is refused (another person's face on her account)",
        inconsistent.status === 400 && inconsistent.body.error === ENROL_SAYS.inconsistent && leftBehind(inconsistentFiles, bDim) === 0,
        `${inconsistent.status} ${String(inconsistent.body.error)}`,
      );

      const clockedOut = await faceClock('OUT', aSmall);
      const outRow = await prisma.attendance.findUnique({
        where: { employeeId_date: { employeeId: faye.employee.id, date: dayKey(new Date()) } },
      });
      check(
        'her own face, a smaller lossier capture, clocks her out — the distance stored',
        clockedOut.status === 200 && outRow?.timeOutMethod === 'FACE' && outRow.timeOutScore != null && Number(outRow.timeOutScore) < threshold,
        `${clockedOut.status} ${JSON.stringify(clockedOut.body).slice(0, 120)} ${outRow?.timeOutScore}`,
      );

      // ── The cap ──
      const fourth = await enrol(faye.token, aRight);
      const fifth = await enrol(faye.token, aSmall);
      check(
        'a fourth and a fifth sample are accepted',
        fourth.status === 201 && fifth.status === 201 && fifth.body.samples === 5,
        `${fourth.status} ${fifth.status} ${String(fourth.body.error ?? fifth.body.error ?? '')}`,
      );
      const capFiles = uploadedFiles();
      const sixth = await enrol(faye.token, aDim);
      check(
        'a sixth is refused: five is the most a person keeps',
        sixth.status === 400 && sixth.body.error === ENROL_SAYS.full && leftBehind(capFiles, aDim) === 0,
        `${sixth.status} ${String(sixth.body.error)}`,
      );

      // ── Listing the samples ──
      type SampleRow = {
        id: string;
        photoId: string | null;
        createdAt: string;
        enrolledBy: { id: string } | null;
        current: boolean;
        quality: { eyeDistance?: number } | null;
      };
      const listed = await api(faye.token, 'GET', `/clock/enrollments?employeeId=${faye.employee.id}`);
      const samples = (listed.body.samples ?? []) as SampleRow[];
      check(
        'GET /clock/enrollments lists her five samples: current, each with its photo, date, who added it and its quality',
        listed.status === 200 &&
          samples.length === 5 &&
          listed.body.current === 5 &&
          listed.body.legacy === 0 &&
          listed.body.samplesNeeded === 3 &&
          listed.body.maxSamples === 5 &&
          (listed.body.employee as { id?: string } | undefined)?.id === faye.employee.id &&
          samples.every(
            (s) => !!s.photoId && !!s.createdAt && s.enrolledBy?.id === faye.user.id && s.current === true && typeof s.quality?.eyeDistance === 'number',
          ),
        `${listed.status} ${JSON.stringify(listed.body).slice(0, 200)}`,
      );
      const ownList = await api(faye.token, 'GET', '/clock/enrollments');
      check('without an employee id the list is her own', ownList.status === 200 && ownList.body.current === 5, String(ownList.status));
      const peekList = await api(peeker.token, 'GET', `/clock/enrollments?employeeId=${faye.employee.id}`);
      const readerList = await api(readerToken, 'GET', `/clock/enrollments?employeeId=${faye.employee.id}`);
      const hrList = await api(hrToken, 'GET', `/clock/enrollments?employeeId=${faye.employee.id}`);
      const hrUnknown = await api(hrToken, 'GET', '/clock/enrollments?employeeId=no-such-employee');
      check(
        "a colleague cannot list her samples (403), nor somebody with only the register's read right (403); HR can; an unknown employee is a 404",
        peekList.status === 403 &&
          readerList.status === 403 &&
          hrList.status === 200 &&
          hrList.body.current === 5 &&
          hrUnknown.status === 404,
        `${peekList.status} / ${readerList.status} / ${hrList.status} / ${hrUnknown.status}`,
      );

      // ── The face photos' guard ──
      const accountNow = await accountPhoto(faye.user.id);
      const privateSample = samples[0];
      if (privateSample?.photoId && accountNow) {
        check(
          "a sample's photo is hers and HR's: a colleague who knows its id cannot open it, nor the register's reader",
          (await fileStatus(faye.token, privateSample.photoId)) === 200 &&
            (await fileStatus(hrToken, privateSample.photoId)) === 200 &&
            (await fileStatus(peeker.token, privateSample.photoId)) === 404 &&
            (await fileStatus(readerToken, privateSample.photoId)) === 404,
        );
        const peekAll = await Promise.all(samples.map((x) => (x.photoId ? fileStatus(peeker.token, x.photoId) : 404)));
        check(
          'none of her five sample photos is her account photo, so a colleague opens none of them — and opens her picture, as every avatar is',
          !samples.some((x) => x.photoId === accountNow) &&
            peekAll.every((status) => status === 404) &&
            (await fileStatus(peeker.token, accountNow)) === 200,
          peekAll.join(','),
        );
        const genericDelete = await api(faye.token, 'DELETE', `/attachments/${privateSample.photoId}`);
        const genericAdd = await apiForm(faye.token, `/attachments/face_enrollment/${faye.employee.id}`, A, {}, 'files');
        const peekAdd = await apiForm(peeker.token, `/attachments/face_enrollment/${faye.employee.id}`, A, {}, 'files');
        check(
          'sample photos are never added or deleted through the generic attachment routes (403; 404 for a colleague)',
          genericDelete.status === 403 && genericAdd.status === 403 && peekAdd.status === 404,
          `${genericDelete.status} / ${genericAdd.status} / ${peekAdd.status}`,
        );
      } else {
        check('a sample photo other than the account photo exists to test the guard on', false);
      }

      // ── Face health (HR Settings) ──
      const peekHealth = await api(peeker.token, 'GET', '/clock/face-health');
      check('face health is HR settings: a colleague is refused', peekHealth.status === 403, String(peekHealth.status));

      // A lookalike on file: Faye's face and Tomas's both filed on a third
      // person — a close pair with each, two samples unlike each other, and
      // an account holding two faces. And somebody with only an older
      // engine's sample: not protected by the clock yet.
      const lookalike = await prisma.employee.create({
        data: { employeeNo: `${TAG}-015`, firstName: 'Lena', lastName: 'Lookalike' },
      });
      const unprotectedOne = await prisma.employee.create({
        data: { employeeNo: `${TAG}-016`, firstName: 'Uma', lastName: 'Unprotected' },
      });
      await prisma.faceEnrollment.create({
        data: { employeeId: unprotectedOne.id, descriptor: descriptor(9) as unknown as Prisma.InputJsonValue },
      });
      const fayeSample = await prisma.faceEnrollment.findFirst({ where: { employeeId: faye.employee.id, engine: FACE_ENGINE } });
      const tomasSample = await prisma.faceEnrollment.findFirst({ where: { employeeId: tomas.employee.id, engine: FACE_ENGINE } });
      await prisma.faceEnrollment.createMany({
        data: [fayeSample, tomasSample].map((row) => ({
          employeeId: lookalike.id,
          descriptor: (row?.descriptor ?? []) as Prisma.InputJsonValue,
          engine: FACE_ENGINE,
        })),
      });
      const health = await api(hrToken, 'GET', '/clock/face-health');
      const people = (health.body.people ?? {}) as Record<string, number>;
      const pairs = (health.body.closePairs ?? []) as { a: { id: string }; b: { id: string }; distance: number }[];
      const outliers = (health.body.outliers ?? []) as { employee: { id: string }; sampleId: string; distance: number }[];
      const mixed = (health.body.mixedAccounts ?? []) as { employee: { id: string }; distance: number; sampleIds: string[] }[];
      const unprotected = (health.body.unprotected ?? []) as { id: string; name: string }[];
      const refused30 = (health.body.refusals30d ?? { total: 0, reasons: [] }) as {
        total: number;
        reasons: { reason: string; label: string; count: number }[];
      };
      type RecentRefusal = {
        kind: string;
        reason: string;
        employee: { id: string; name: string };
        nearestOther: { id: string; name: string; distance: number | null } | null;
      };
      const recent = (health.body.recentRefusals ?? []) as RecentRefusal[];
      const pairOf = (x: string, y: string) =>
        pairs.find((p) => (p.a.id === x && p.b.id === y) || (p.a.id === y && p.b.id === x));
      check(
        'face health reports the engine, the threshold and margin, and how many people are ready, partly enrolled, legacy-only or not at all',
        health.status === 200 &&
          health.body.engine === FACE_ENGINE &&
          health.body.threshold === threshold &&
          health.body.margin === FACE_MARGIN &&
          ['ready', 'partial', 'legacyOnly', 'none'].every((k) => typeof people[k] === 'number') &&
          people.ready >= 2,
        `${health.status} ${JSON.stringify(health.body).slice(0, 200)}`,
      );
      check(
        'it names who has only an older engine\'s samples — not protected by the clock until they add new ones',
        unprotected.some((u) => u.id === unprotectedOne.id && u.name === 'Uma Unprotected') &&
          !unprotected.some((u) => u.id === faye.employee.id),
        JSON.stringify(unprotected.slice(0, 4)),
      );
      check(
        'it names two people the clock could confuse, closest first — and not two who are far apart',
        !!pairOf(faye.employee.id, lookalike.id) &&
          pairOf(faye.employee.id, lookalike.id)!.distance <= threshold + 0.1 &&
          !!pairOf(tomas.employee.id, lookalike.id) &&
          !pairOf(faye.employee.id, tomas.employee.id) &&
          pairs.length <= 20 &&
          pairs.every((p, i) => i === 0 || pairs[i - 1].distance <= p.distance),
        JSON.stringify(pairs.slice(0, 4)),
      );
      check(
        "it flags a sample unlike its owner's other samples, and none of Faye's",
        outliers.filter((o) => o.employee.id === lookalike.id).length === 2 &&
          !outliers.some((o) => o.employee.id === faye.employee.id) &&
          outliers.every((o) => o.distance > threshold + FACE_MARGIN),
        JSON.stringify(outliers.slice(0, 4)),
      );
      check(
        'and an account holding two faces, by the two samples furthest apart — not Faye\'s, whose five are one face',
        mixed.some((m) => m.employee.id === lookalike.id && m.distance > threshold + FACE_MARGIN && m.sampleIds.length === 2) &&
          !mixed.some((m) => m.employee.id === faye.employee.id),
        JSON.stringify(mixed.slice(0, 3)),
      );
      const refusedFor = (reason: string) => refused30.reasons.find((r) => r.reason === reason)?.count ?? 0;
      check(
        'the refusals of the last 30 days by reason, counted from the audit rows',
        refused30.total >= 9 &&
          refusedFor('too_few_samples') >= 3 &&
          refusedFor('replay') >= 2 &&
          refusedFor('quality') >= 1 &&
          refusedFor('not_recognised') >= 1 &&
          refusedFor('several_faces') >= 1 &&
          refusedFor('not_this_account') >= 1 &&
          refused30.reasons.every((r) => typeof r.label === 'string' && r.label.length > 0),
        JSON.stringify(refused30).slice(0, 300),
      );
      check(
        'and the latest one by one, for HR: whose face the refused clock-in came near, and whose the refused sample did',
        recent.some(
          (r) =>
            r.kind === 'clock' &&
            r.reason === 'not_this_account' &&
            r.employee.id === faye.employee.id &&
            r.nearestOther?.name === 'Tomas Twin',
        ) &&
          recent.some(
            (r) =>
              r.kind === 'enrol' &&
              r.reason === 'collision' &&
              r.employee.id === tomas.employee.id &&
              r.nearestOther?.name === 'Faye Facet',
          ) &&
          recent.length <= 20,
        JSON.stringify(recent.slice(0, 3)),
      );
      await prisma.faceEnrollment.deleteMany({ where: { employeeId: { in: [lookalike.id, unprotectedOne.id] } } });

      // ── Legacy, removing one, the account photo, starting over ──
      await prisma.faceEnrollment.create({
        data: { employeeId: faye.employee.id, descriptor: descriptor(5) as unknown as Prisma.InputJsonValue },
      });
      const meLegacy = await api(faye.token, 'GET', '/clock/me');
      check(
        "a sample of an older engine is counted apart, and does not count toward the three",
        meLegacy.body.faceSamples === 5 && meLegacy.body.legacySamples === 1 && meLegacy.body.enrolled === true,
        JSON.stringify(meLegacy.body).slice(0, 160),
      );
      // A current-engine row whose descriptor cannot be read is not a sample
      // the clock can use, so it is not counted as one either.
      const unreadable = await prisma.faceEnrollment.create({
        data: { employeeId: faye.employee.id, descriptor: [1, 2, 3] as Prisma.InputJsonValue, engine: FACE_ENGINE },
      });
      const meUnreadable = await api(faye.token, 'GET', '/clock/me');
      check(
        'a current-engine row with no readable descriptor counts with the legacy ones, never toward the three',
        meUnreadable.body.faceSamples === 5 && meUnreadable.body.legacySamples === 2,
        JSON.stringify(meUnreadable.body).slice(0, 160),
      );
      await prisma.faceEnrollment.delete({ where: { id: unreadable.id } });

      // Her account picture was cut from her LAST sample; removing another
      // sample leaves it, removing that one takes it.
      const pictureNow = await accountPhoto(faye.user.id);
      const picture = pictureNow ? await prisma.attachment.findUnique({ where: { id: pictureNow } }) : null;
      const pictureSample = samples.find((x) => (picture?.caption ?? '').endsWith(x.id));
      const otherSample = samples.find((x) => x.id !== pictureSample?.id);
      if (otherSample?.photoId && pictureSample?.photoId && picture) {
        const peekRemove = await api(peeker.token, 'DELETE', `/clock/enrollments/${otherSample.id}`);
        const otherPhoto = await prisma.attachment.findUnique({ where: { id: otherSample.photoId } });
        const removed = await api(faye.token, 'DELETE', `/clock/enrollments/${otherSample.id}`);
        check(
          "a colleague cannot remove her sample (403); she can (204), and its photo goes with it",
          peekRemove.status === 403 &&
            removed.status === 204 &&
            !(await prisma.faceEnrollment.findUnique({ where: { id: otherSample.id } })) &&
            !(await prisma.attachment.findUnique({ where: { id: otherSample.photoId } })) &&
            !!otherPhoto &&
            !fs.existsSync(attachmentPath(otherPhoto.storedName)),
          `${peekRemove.status} / ${removed.status}`,
        );
        check(
          'the removal is audited, an unknown sample is a 404, and her picture — cut from another sample — stays',
          !!(await prisma.auditLog.findFirst({
            where: { entityType: 'employee', entityId: faye.employee.id, summary: { startsWith: 'Face sample removed' } },
          })) &&
            (await api(faye.token, 'DELETE', '/clock/enrollments/no-such-sample')).status === 404 &&
            (await accountPhoto(faye.user.id)) === picture.id,
        );
        const removedSource = await api(faye.token, 'DELETE', `/clock/enrollments/${pictureSample.id}`);
        check(
          'removing the sample her picture was cut from takes the picture too — a face removed from her samples is not left as her avatar',
          removedSource.status === 204 &&
            (await accountPhoto(faye.user.id)) === null &&
            !(await prisma.attachment.findUnique({ where: { id: picture.id } })),
          `${removedSource.status} ${await accountPhoto(faye.user.id)}`,
        );
      } else {
        check('her account picture names the sample it was cut from', false, picture?.caption ?? 'no picture');
      }

      // A plain account photo is replaced and removed as any upload is, and
      // never takes a face sample's photo with it.
      const plainOne = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 40, g: 90, b: 160 } } })
        .jpeg()
        .toBuffer();
      const plainTwo = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 160, g: 90, b: 40 } } })
        .jpeg()
        .toBuffer();
      const sampleFiles = () => prisma.attachment.count({ where: { entityType: 'face_enrollment', entityId: faye.employee.id } });
      const filesBefore = await sampleFiles();
      const upOne = await apiForm(faye.token, '/auth/photo', plainOne);
      const upTwo = await apiForm(faye.token, '/auth/photo', plainTwo);
      check(
        'a plain account photo nothing else holds is deleted when it is replaced',
        upOne.status === 201 && upTwo.status === 201 && !(await prisma.attachment.findUnique({ where: { id: String(upOne.body.photoPath) } })),
        `${upOne.status} ${upTwo.status}`,
      );
      const dropAvatar = await api(faye.token, 'DELETE', '/auth/photo');
      check(
        'removing the account photo deletes that plain photo and leaves her three sample photos',
        dropAvatar.status === 200 &&
          !(await prisma.attachment.findUnique({ where: { id: String(upTwo.body.photoPath) } })) &&
          filesBefore === 3 &&
          (await sampleFiles()) === 3,
        `${dropAvatar.status} ${filesBefore}`,
      );

      const peekReset = await api(peeker.token, 'DELETE', `/clock/enrollments?employeeId=${faye.employee.id}`);
      const reset = await api(faye.token, 'DELETE', '/clock/enrollments');
      const meReset = await api(faye.token, 'GET', '/clock/me');
      check(
        'starting over: a colleague cannot (403); she removes every sample, the older engine\'s too, and their photos with them',
        peekReset.status === 403 &&
          reset.status === 200 &&
          reset.body.removed === 4 &&
          meReset.body.faceSamples === 0 &&
          meReset.body.legacySamples === 0 &&
          (await prisma.attachment.count({ where: { entityType: 'face_enrollment', entityId: faye.employee.id } })) === 0,
        `${peekReset.status} / ${reset.status} ${JSON.stringify(reset.body)}`,
      );
      const tomasPicture = await accountPhoto(tomas.user.id);
      const hrReset = await api(hrToken, 'DELETE', `/clock/enrollments?employeeId=${tomas.employee.id}`);
      check(
        "HR resets somebody else's — his picture, cut from one of them, with them — and both resets are audited",
        hrReset.status === 200 &&
          hrReset.body.removed === 3 &&
          !!tomasPicture &&
          (await accountPhoto(tomas.user.id)) === null &&
          (await prisma.auditLog.count({
            where: {
              entityType: 'employee',
              entityId: { in: [faye.employee.id, tomas.employee.id] },
              summary: { startsWith: 'Face samples reset' },
            },
          })) === 2,
        `${hrReset.status} ${JSON.stringify(hrReset.body)}`,
      );

      // ── Two at once ──
      // Enrolment counts, matches and writes under one lock, so two captures
      // sent together are decided one after the other.
      const pia = peeker;
      const race = await Promise.all([enrol(pia.token, A), enrol(pia.token, B)]);
      const raceStatuses = race.map((r) => r.status).sort();
      check(
        'two different faces sent at once as somebody\'s first samples: one is taken, the other refused as unlike it',
        raceStatuses[0] === 201 &&
          raceStatuses[1] === 400 &&
          race.some((r) => r.body.error === ENROL_SAYS.inconsistent) &&
          (await prisma.faceEnrollment.count({ where: { employeeId: pia.employee.id } })) === 1,
        race.map((r) => `${r.status} ${String(r.body.error ?? '')}`).join(' · '),
      );
      await api(pia.token, 'DELETE', '/clock/enrollments');
      for (const image of [A, aLeft, aRight, aDim]) await enrol(pia.token, image);
      const capRace = await Promise.all([enrol(pia.token, aSmall), enrol(pia.token, aTilted)]);
      const capStatuses = capRace.map((r) => r.status).sort();
      check(
        'and two sent at once with four on file: one is the fifth, the other is told five are on file — five kept, not four',
        (await prisma.faceEnrollment.count({ where: { employeeId: pia.employee.id } })) === 5 &&
          capStatuses[0] === 201 &&
          capStatuses[1] === 400 &&
          capRace.some((r) => r.body.error === ENROL_SAYS.full),
        capRace.map((r) => `${r.status} ${String(r.body.error ?? '')}`).join(' · '),
      );
      await api(pia.token, 'DELETE', '/clock/enrollments');

      // ── The brake ──
      const brakeFiles = uploadedFiles();
      const knocks: number[] = [];
      for (let i = 0; i < 13; i++) {
        knocks.push((await apiForm(tomas.token, '/clock', bDim, { action: 'IN', method: 'PIN' })).status);
      }
      check(
        'one person knocking on the clock more than twelve times a minute is told to wait (429), and no capture is kept',
        knocks.slice(0, 12).every((st) => st === 400) && knocks[12] === 429 && leftBehind(brakeFiles, bDim) === 0,
        knocks.join(','),
      );

      // ── A fallback at both ends of the day ──
      const fallbackPerson = await person('fallback', 'Fran', 'Fallback', '017');
      const fbIn = await apiForm(fallbackPerson.token, '/clock', plainOne, { action: 'IN', method: 'PIN', fallbackReason: 'Camera broken this morning' });
      const fbOut = await apiForm(fallbackPerson.token, '/clock', plainTwo, { action: 'OUT', method: 'BIOMETRIC', fallbackReason: 'Used the reader at the gate' });
      const fbRow = await prisma.attendance.findUnique({
        where: { employeeId_date: { employeeId: fallbackPerson.employee.id, date: dayKey(new Date()) } },
      });
      check(
        "a fallback's written reason is kept at both ends of the day — the clock-in's and the clock-out's, each its own",
        fbIn.status === 200 &&
          fbOut.status === 200 &&
          fbRow?.timeInMethod === 'PIN' &&
          fbRow.notes === 'Camera broken this morning' &&
          fbRow.timeOutMethod === 'BIOMETRIC' &&
          fbRow.timeOutNotes === 'Used the reader at the gate',
        `${fbIn.status} ${fbOut.status} ${fbRow?.notes} / ${fbRow?.timeOutNotes}`,
      );

      // A double tap: the entry is claimed before its photo is filed, so the
      // tap that loses keeps nothing.
      const tapper = await person('tapper', 'Tad', 'Tapper', '019');
      const tapFiles = uploadedFiles();
      const tapOne = await sharp({ create: { width: 220, height: 220, channels: 3, background: { r: 10, g: 120, b: 60 } } }).jpeg().toBuffer();
      const tapTwo = await sharp({ create: { width: 220, height: 220, channels: 3, background: { r: 120, g: 10, b: 60 } } }).jpeg().toBuffer();
      const taps = await Promise.all([
        apiForm(tapper.token, '/clock', tapOne, { action: 'IN', method: 'PIN', fallbackReason: 'First tap' }),
        apiForm(tapper.token, '/clock', tapTwo, { action: 'IN', method: 'PIN', fallbackReason: 'Second tap' }),
      ]);
      const tapRow = await prisma.attendance.findUnique({
        where: { employeeId_date: { employeeId: tapper.employee.id, date: dayKey(new Date()) } },
      });
      const tapStatuses = taps.map((t) => t.status).sort();
      check(
        'two clock-ins at once: one stands, the other is told it already did — and only the standing one keeps its photo',
        tapStatuses[0] === 200 &&
          tapStatuses[1] === 400 &&
          leftBehind(tapFiles, tapOne) + leftBehind(tapFiles, tapTwo) === 1 &&
          !!tapRow?.timeInPhoto &&
          (await prisma.attachment.count({ where: { entityType: 'attendance', entityId: tapper.employee.id } })) === 1,
        taps.map((t) => `${t.status} ${String(t.body.error ?? '')}`).join(' · '),
      );

      // ── A deleted employee's faces go with them ──
      const leaver = await prisma.employee.create({
        data: { employeeNo: `${TAG}-018`, firstName: 'Leo', lastName: 'Leaver' },
      });
      const leaverSample = await enrol(hrToken, A, leaver.id);
      const leaverPhotos = await prisma.attachment.findMany({ where: { entityType: 'face_enrollment', entityId: leaver.id } });
      const dropLeaver = await api(hrToken, 'DELETE', `/employees/${leaver.id}`);
      check(
        "deleting an employee deletes their face samples' photos too, files and all",
        leaverSample.status === 201 &&
          leaverPhotos.length === 1 &&
          dropLeaver.status === 200 &&
          (await prisma.attachment.count({ where: { entityType: 'face_enrollment', entityId: leaver.id } })) === 0 &&
          !fs.existsSync(attachmentPath(leaverPhotos[0].storedName)),
        `${leaverSample.status} ${String(leaverSample.body.error ?? '')} ${dropLeaver.status} ${leaverPhotos.length}`,
      );
    }

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

    // ══ The lists on paper ═══════════════════════════════════════════════
    console.log('\nThe lists on paper (over HTTP)');
    const nobody = await makeUser('ZZ Nobody', 'nobody@verifyhr.local', []);
    const nobodyToken = signToken(nobody.id, nobody.email);
    // The register's reader who may also see pay — and still never prints it.
    const registrarRole = await makeRole('zzhr_registrar', `${TAG} Registrar`, [
      'ghr.employees.view_all',
      'ghr.employee_rates.view_all',
      'ghr.dashboard.view_all',
    ]);
    const registrar = await makeUser('ZZ Registrar', 'registrar@verifyhr.local', [registrarRole.id]);
    const registrarToken = signToken(registrar.id, registrar.email);
    const searched = `search=${TAG}`;
    const searchNamed = `search "${TAG}"`;
    const numberOf = (r: Record<string, unknown>) => String(r.number);

    const leaveRows = (await readScreen(hrToken, `/leave?${searched}&pageSize=200`)).rows;
    const leaveStatus = splittingValue(leaveRows, 'status');
    await checkListPaper(check, {
      label: 'Leave',
      token: hrToken,
      actorId: hrOfficer.id,
      list: '/leave',
      query: searched,
      named: searchNamed,
      noun: ['leave request', 'leave requests'],
      mark: numberOf,
      filter: { query: `${searched}&status=${leaveStatus}`, named: `status ${statusLabel(leaveStatus)}` },
      entityType: 'leave_request',
    });
    await checkOwnPaper(check, {
      label: 'Leave',
      ownToken: workerToken,
      allToken: hrToken,
      list: '/leave',
      query: searched,
      noun: ['leave request', 'leave requests'],
      mark: numberOf,
    });
    check('Leave: the printed list is refused to anyone the list refuses', (await printed(nobodyToken, '/leave/pdf')).status === 403);

    const otScreen = await readScreen(hrToken, `/overtime?${searched}&pageSize=200`);
    const otStage = splittingValue(otScreen.rows, 'stage');
    await checkListPaper(check, {
      label: 'Overtime',
      token: hrToken,
      actorId: hrOfficer.id,
      list: '/overtime',
      query: searched,
      named: searchNamed,
      noun: ['overtime request', 'overtime requests'],
      mark: numberOf,
      filter: { query: `${searched}&stage=${otStage}`, named: `stage ${OT_STAGE_LABEL[otStage as keyof typeof OT_STAGE_LABEL]}` },
      entityType: 'overtime_request',
    });
    await checkOwnPaper(check, {
      label: 'Overtime',
      ownToken: workerToken,
      allToken: hrToken,
      list: '/overtime',
      query: searched,
      noun: ['overtime request', 'overtime requests'],
      mark: numberOf,
    });
    // The cost is the screen's — the amount charged — and the total adds the
    // listed filings up; the hourly rate behind it never reaches the paper.
    const otPaper = await printed(hrToken, `/overtime/pdf?${searched}`);
    const otRates = otScreen.rows.filter((r) => r.hourlyRate != null).map((r) => formatAmount(Number(r.hourlyRate)));
    const otSum = otScreen.rows.reduce((t, r) => t + Math.round(Number(r.amount ?? 0) * 100), 0) / 100;
    check(
      'Overtime: the paper totals the approved cost the screen lists, and never prints an hourly rate',
      otRates.length > 0 &&
        flat(otPaper.text).includes(formatMoney(otSum)) &&
        otRates.every((rate) => !squash(otPaper.text).includes(squash(rate))),
      `${formatMoney(otSum)} · rates ${otRates.join(', ')} · ${flat(otPaper.text).match(/Approved cost.{0,30}/)?.[0] ?? ''}`,
    );
    // The stage in the screen's words — the pill's and the filter's — never
    // the enum's "Prior": a filing awaiting authorisation says so.
    const otPrior = otScreen.rows.find((r) => r.stage === 'PRIOR');
    const otPriorPaper = otPrior ? await printed(hrToken, `/overtime/pdf?ids=${String(otPrior.id)}`) : null;
    check(
      'Overtime: a filing awaiting authorisation prints "Awaiting authorisation", the screen\'s word for its stage',
      !!otPriorPaper &&
        otPriorPaper.status === 200 &&
        squash(otPriorPaper.text).includes(squash(OT_STAGE_LABEL.PRIOR)) &&
        !/\bPrior\b/.test(flat(otPriorPaper.text)),
      otPrior ? referenceOf(otPriorPaper?.text ?? '') : 'no PRIOR row on the screen',
    );
    check('Overtime: the printed list is refused to anyone the list refuses', (await printed(nobodyToken, '/overtime/pdf')).status === 403);

    // Attendance: two days of the other employee's, one late, so the status
    // filter keeps one and drops the other. A row is named by its day and
    // the person — one person has a row a day.
    await prisma.attendance.createMany({
      data: [
        {
          employeeId: other.id,
          date: new Date('2026-09-21T00:00:00.000Z'),
          timeIn: new Date('2026-09-21T00:45:00.000Z'),
          timeOut: new Date('2026-09-21T09:00:00.000Z'),
          status: 'LATE',
          lateMinutes: 30,
          workedMinutes: 435,
          timeInMethod: 'MANUAL',
        },
        {
          employeeId: other.id,
          date: new Date('2026-09-22T00:00:00.000Z'),
          timeIn: new Date('2026-09-22T00:00:00.000Z'),
          timeOut: new Date('2026-09-22T09:00:00.000Z'),
          status: 'PRESENT',
          workedMinutes: 480,
          timeInMethod: 'MANUAL',
        },
      ],
    });
    const mdy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
    const attendanceMark = (r: Record<string, unknown>) => {
      const e = r.employee as { firstName: string; lastName: string };
      return `${mdy(String(r.date))}${e.lastName}, ${e.firstName}`;
    };
    await checkListPaper(check, {
      label: 'Attendance',
      token: registrarToken,
      actorId: registrar.id,
      list: '/attendance',
      query: searched,
      named: searchNamed,
      noun: ['attendance row', 'attendance rows'],
      mark: attendanceMark,
      filter: { query: `${searched}&status=LATE`, named: 'status Late' },
      entityType: 'attendance',
    });
    const ranged = await printed(registrarToken, `/attendance/pdf?${searched}&from=2026-09-21&to=2026-09-21`);
    check(
      'Attendance: a range of days is named and narrows the paper to it',
      ranged.status === 200 &&
        flat(ranged.text).includes('dated 09/21/2026 to 09/21/2026') &&
        saysCount(ranged.text, 1, ['attendance row', 'attendance rows']),
      referenceOf(ranged.text),
    );
    check('Attendance: the printed list is refused to anyone the dashboard refuses', (await printed(workerToken, '/attendance/pdf')).status === 403);

    // Every employee this script made is active, so "active" would keep them
    // all and prove nothing: the loner, whose part is done, is switched off,
    // and the inactive filter keeps them alone.
    await prisma.employee.update({ where: { employeeNo: `${TAG}-005` }, data: { isActive: false } });
    await checkListPaper(check, {
      label: 'Employees',
      token: registrarToken,
      actorId: registrar.id,
      list: '/employees',
      query: searched,
      named: searchNamed,
      noun: ['employee', 'employees'],
      mark: (r) => String(r.employeeNo),
      filter: { query: `${searched}&isActive=false`, named: 'inactive' },
      entityType: 'employee',
    });
    // Zeno Worker's day rate is 1,000.00 at a 1.4 burden: neither prints,
    // although this reader may see both on the screen.
    const registerPaper = await printed(registrarToken, `/employees/pdf?${searched}`);
    check(
      'Employees: the printed register never carries the pay data, even for a reader who may see it',
      registerPaper.status === 200 &&
        squash(registerPaper.text).includes(`${TAG}-001`) &&
        !/1,000\.00|1,400\.00|daily rate|burden/i.test(flat(registerPaper.text)),
      flat(registerPaper.text).slice(0, 200),
    );
    check('Employees: the printed register is refused to anyone the register refuses', (await printed(workerToken, '/employees/pdf')).status === 403);

    // The employment-type filter is checked against the enum's VALUES
    // (listPaper's `choice`): a prototype key once reached the database and
    // answered 500, on the register and on its paper alike.
    const unknownType = await Promise.all(
      ['/employees?employmentType=toString', '/employees/pdf?employmentType=toString'].map(async (path) => {
        const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${registrarToken}` } });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return { status: res.status, error: String(body.error ?? '') };
      }),
    );
    check(
      'Employees: an unknown employment type is a 400 naming the choices in words, on the register and its paper, never a 500',
      unknownType.every((r) => r.status === 400 && r.error.includes('Employment type') && r.error.includes('Project based')),
      unknownType.map((r) => `${r.status} ${r.error}`).join(' · '),
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

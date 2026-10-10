import fs from 'node:fs';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { HttpError } from '../http/kit';
import { audit } from './audit';
import { attachmentPath, deleteAttachment, saveAttachmentBytes } from './attachments';
import { FACE_ENGINE } from './faceEngine';
import type { FaceCapture, FaceQuality } from './face';
import {
  FACE_MARGIN,
  MAX_FACE_SAMPLES,
  MIN_FACE_SAMPLES,
  faceDistance,
  hrSettings,
  isUsableSample,
  matchFace,
  saveHrSettings,
  storedDescriptor,
} from './hr';

/**
 * The face engine itself (shared/face.ts) is loaded only when a photo is
 * actually described or cut down — never just for importing this module,
 * which the seed does for the threshold move. The engine pulls in sharp's
 * native library and the WebAssembly models.
 */
const engine = () => import('./face');

/**
 * A person's face samples, outside the moment of matching (2026-10-10, after
 * "sometimes they matched other account faces"): listing and counting them,
 * keeping their photos, the once-only threshold move, the boot-time
 * re-derivation under a new engine, and HR's view of how healthy the whole
 * set is. The matching itself is `matchFace()` / `decideFace()` in
 * shared/hr.ts; the descriptor is `describeFace()` in shared/face.ts.
 */

// ── Counting ─────────────────────────────────────────────────────────────────

/**
 * How many of a person's samples the clock can use (`current`: the engine
 * this server runs, with a readable descriptor — `isUsableSample`) and how
 * many it cannot (`legacy`).
 */
export async function sampleCounts(
  employeeId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<{ current: number; legacy: number }> {
  const rows = await db.faceEnrollment.findMany({
    where: { employeeId },
    select: { engine: true, descriptor: true },
  });
  const current = rows.filter(isUsableSample).length;
  return { current, legacy: rows.length - current };
}

/** The samples as the Clock page, HR Settings and the employee record list them. */
export async function listSamples(employeeId: string) {
  const [employee, rows] = await Promise.all([
    prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, firstName: true, lastName: true } }),
    prisma.faceEnrollment.findMany({
      where: { employeeId },
      select: {
        id: true,
        photoPath: true,
        createdAt: true,
        engine: true,
        descriptor: true,
        quality: true,
        enrolledBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  if (!employee) return null;
  const samples = rows.map((r) => ({
    id: r.id,
    photoId: r.photoPath,
    createdAt: r.createdAt,
    enrolledBy: r.enrolledBy,
    current: isUsableSample(r),
    // A FaceQuality, or { rederiveFailed, engine } for a photo a new engine could not describe.
    quality: (r.quality ?? null) as (Partial<FaceQuality> & { rederiveFailed?: string }) | null,
  }));
  const current = samples.filter((s) => s.current).length;
  return {
    employee: { id: employee.id, name: `${employee.firstName} ${employee.lastName}` },
    samples,
    current,
    legacy: samples.length - current,
    samplesNeeded: MIN_FACE_SAMPLES,
    maxSamples: MAX_FACE_SAMPLES,
  };
}

// ── Photos ───────────────────────────────────────────────────────────────────

/**
 * Deletes a photo nobody needs any more — never a face sample's photo, never
 * anybody's account photo.
 *
 * Every enrolment makes its capture the account photo, so replacing or
 * removing the account photo used to delete the previous sample's photo: the
 * evidence of whose face that sample is, and the only thing a new engine can
 * re-derive it from. Call this AFTER the row that pointed at the photo has
 * moved on, so the check sees what is left. Answers whether it deleted.
 */
export async function deletePhotoIfUnused(attachmentId: string | null | undefined): Promise<boolean> {
  if (!attachmentId) return false;
  const [samples, accounts] = await Promise.all([
    prisma.faceEnrollment.count({ where: { photoPath: attachmentId } }),
    prisma.user.count({ where: { photoPath: attachmentId } }),
  ]);
  if (samples || accounts) return false;
  await deleteAttachment(attachmentId).catch(() => {});
  return true;
}

/** Makes an attachment the user's account photo, and lets the previous one go if nothing else holds it. */
export async function setAccountPhoto(userId: string, attachmentId: string | null): Promise<void> {
  const previous = await prisma.user.findUnique({ where: { id: userId }, select: { photoPath: true } });
  await prisma.user.update({ where: { id: userId }, data: { photoPath: attachmentId } });
  if (previous?.photoPath && previous.photoPath !== attachmentId) await deletePhotoIfUnused(previous.photoPath);
}

/**
 * How an account picture made from a face sample says which sample: its
 * caption. Removing that sample takes the picture with it — removing a sample
 * "of someone else", as the Clock page tells a person to, must not leave that
 * someone's face as this account's avatar.
 */
const FROM_SAMPLE = 'Account photo — from face sample ';

/**
 * Gives a person an account picture cut from an enrolment capture: the face,
 * small (`accountPhotoFrom`), filed under `user` like any account photo and
 * NEVER the capture itself, which stays the sample's and is read only by the
 * person and HR. Answers the new attachment's id.
 */
export async function setAccountPhotoFromSample(input: {
  userId: string;
  sampleId: string;
  image: Buffer;
  box: FaceCapture['box'] | null;
  uploadedById: string;
}): Promise<string> {
  const { accountPhotoFrom } = await engine();
  const bytes = await accountPhotoFrom(input.image, input.box);
  const attachment = await saveAttachmentBytes({
    entityType: 'user',
    entityId: input.userId,
    bytes,
    fileName: 'account-photo.jpg',
    mimeType: 'image/jpeg',
    uploadedById: input.uploadedById,
    caption: `${FROM_SAMPLE}${input.sampleId}`,
  });
  await setAccountPhoto(input.userId, attachment.id);
  return attachment.id;
}

/**
 * Clears a person's account picture when it was cut from one of these
 * samples. Answers whether it did.
 */
export async function dropAccountPhotoFromSamples(userId: string | null, sampleIds: string[]): Promise<boolean> {
  if (!userId || !sampleIds.length) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { photoPath: true } });
  if (!user?.photoPath) return false;
  const photo = await prisma.attachment.findUnique({ where: { id: user.photoPath }, select: { caption: true } });
  const from = photo?.caption?.startsWith(FROM_SAMPLE) ? photo.caption.slice(FROM_SAMPLE.length) : null;
  if (!from || !sampleIds.includes(from)) return false;
  await setAccountPhoto(userId, null);
  return true;
}

/**
 * Account pictures that ARE a face sample's photo — every enrolment before
 * 2026-10-10 made its capture the account photo — become a small picture of
 * their own (`setAccountPhotoFromSample`, cut from the centre: the capture's
 * face box was not kept). The capture stays the sample's, readable by the
 * person and HR only. Run at boot, after the models load; idempotent, since
 * afterwards no account points at a sample's photo. A photo whose file is
 * gone leaves the account with no picture rather than one nobody may open.
 */
export async function separateAccountPhotos(): Promise<number> {
  const users = await prisma.user.findMany({ where: { photoPath: { not: null } }, select: { id: true, photoPath: true } });
  if (!users.length) return 0;
  const photos = await prisma.attachment.findMany({
    where: { id: { in: users.map((u) => u.photoPath!) }, entityType: 'face_enrollment' },
    select: { id: true, storedName: true, uploadedById: true },
  });
  const byId = new Map(photos.map((p) => [p.id, p]));
  let moved = 0;
  for (const user of users) {
    const photo = byId.get(user.photoPath!);
    if (!photo) continue;
    const sample = await prisma.faceEnrollment.findFirst({ where: { photoPath: photo.id }, select: { id: true } });
    try {
      const image = fs.readFileSync(attachmentPath(photo.storedName));
      await setAccountPhotoFromSample({
        userId: user.id,
        sampleId: sample?.id ?? photo.id,
        image,
        box: null,
        uploadedById: photo.uploadedById,
      });
    } catch (err) {
      console.error(`Account photo of user ${user.id} could not be separated from its face sample:`, err);
      // Claimed on the photo it was read with, so a picture set meanwhile stays.
      await prisma.user.updateMany({ where: { id: user.id, photoPath: photo.id }, data: { photoPath: null } });
      await deletePhotoIfUnused(photo.id);
    }
    moved++;
  }
  if (moved) {
    await audit({
      entityType: 'setting',
      entityId: 'hr.rules',
      action: 'UPDATED',
      summary: `Account photos separated from face samples: ${moved} made from their capture, the capture kept with its sample`,
      actorName: 'system',
    });
  }
  return moved;
}

// ── The threshold ────────────────────────────────────────────────────────────

const THRESHOLD_MIGRATED = 'seed.faceEngineMigrated';

/**
 * Moves a STORED threshold of 0.6 — face-api's default, written by every
 * install's seed — to 0.55, the new engine's, exactly once.
 *
 * Any other stored value is an administrator's choice and is kept. Marked in
 * the `seed.faceEngineMigrated` setting, so an HR officer who sets 0.6 again
 * afterwards keeps it. Called by the seed on every deploy; answers what it did,
 * or null when it had already run.
 */
export async function migrateFaceThreshold(): Promise<{ from: number; to: number; changed: boolean } | null> {
  if (await prisma.setting.findUnique({ where: { key: THRESHOLD_MIGRATED } })) return null;
  const row = await prisma.setting.findUnique({ where: { key: 'hr.rules' } });
  const stored = (row?.value as { faceThreshold?: unknown } | null)?.faceThreshold;
  const changed = row != null && typeof stored === 'number' && Math.abs(stored - 0.6) < 1e-9;
  if (changed) {
    await saveHrSettings({ faceThreshold: 0.55 });
    await audit({
      entityType: 'setting',
      entityId: 'hr.rules',
      action: 'UPDATED',
      summary: `Face match threshold moved from 0.6 to 0.55 for the new face engine (${FACE_ENGINE})`,
      actorName: 'system',
    });
  }
  const from = typeof stored === 'number' ? stored : 0.55;
  await prisma.setting.upsert({
    where: { key: THRESHOLD_MIGRATED },
    create: {
      key: THRESHOLD_MIGRATED,
      value: { at: new Date().toISOString(), engine: FACE_ENGINE, from, to: changed ? 0.55 : from },
      description:
        'A stored face threshold of 0.6 (the old engine default) was moved to 0.55 once, for the new face engine; ' +
        'set so a value HR chooses afterwards is kept.',
    },
    update: {},
  });
  return { from, to: changed ? 0.55 : from, changed };
}

// ── Re-derivation ────────────────────────────────────────────────────────────

let rederiving: Promise<{ recomputed: number; failed: number }> | null = null;

/** Why a re-derived sample was not taken into use, as its owner's sample list says it — naming nobody. */
const COLLIDES = "Too close to another employee's enrolled face for the clock to tell them apart";

/**
 * Recomputes every LEGACY sample (an engine other than FACE_ENGINE) from its
 * photo, so an engine upgrade does not send everybody back to the camera.
 *
 * Run after the models load at boot, never awaited. Each row is CLAIMED with
 * a conditional update on the engine AND the quality it was read with, so two
 * processes never both write it — a success or a failure alike. A row whose
 * photo is gone from disk is skipped and stays as it is. A photo that cannot
 * be described again (no face, several faces) records
 * `{ rederiveFailed: <reason>, engine }` in `quality` and is not retried under
 * this engine; it stays a legacy sample, listed for the person to remove. So
 * does one that comes out within the threshold plus the margin of ANOTHER
 * employee's current samples: enrolment refuses that collision, and a sample
 * re-derived without asking would let one person's face open two accounts.
 * No quality gate: the photo was accepted when it was taken. One audit row
 * per run that changed anything.
 */
export function rederiveFaceSamples(): Promise<{ recomputed: number; failed: number }> {
  if (!rederiving) {
    rederiving = rederive().finally(() => {
      rederiving = null;
    });
  }
  return rederiving;
}

async function rederive(): Promise<{ recomputed: number; failed: number }> {
  let recomputed = 0;
  let failed = 0;
  const { describeFace, faceEngineReady } = await engine();
  if (!faceEngineReady()) return { recomputed, failed };

  const rows = await prisma.faceEnrollment.findMany({
    where: { OR: [{ engine: null }, { engine: { not: FACE_ENGINE } }], photoPath: { not: null } },
    select: { id: true, employeeId: true, engine: true, photoPath: true, quality: true },
  });
  const photos = await prisma.attachment.findMany({
    where: { id: { in: rows.map((r) => r.photoPath!) } },
    select: { id: true, storedName: true },
  });
  const storedName = new Map(photos.map((p) => [p.id, p.storedName]));

  for (const row of rows) {
    // Failed under THIS engine: not retried. A later engine tries it again.
    const before = row.quality as { rederiveFailed?: unknown; engine?: unknown } | null;
    if (before?.rederiveFailed && before.engine === FACE_ENGINE) continue;
    const name = storedName.get(row.photoPath!);
    if (!name) continue;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(attachmentPath(name));
    } catch {
      continue; // the file is gone: the row stays legacy, as it is
    }

    let data: Prisma.FaceEnrollmentUpdateManyMutationInput;
    const failure = (reason: string) => ({
      quality: { rederiveFailed: reason, engine: FACE_ENGINE } as Prisma.InputJsonValue,
    });
    try {
      const capture = await describeFace(bytes, { purpose: 'rederive' });
      const { nearestOther, threshold } = await matchFace(capture.descriptor, row.employeeId);
      data =
        nearestOther && nearestOther.distance <= threshold + FACE_MARGIN
          ? failure(COLLIDES)
          : {
              engine: FACE_ENGINE,
              descriptor: capture.descriptor as unknown as Prisma.InputJsonValue,
              quality: capture.quality as unknown as Prisma.InputJsonValue,
            };
    } catch (err) {
      // Only the PHOTO's fault is recorded (no face, several, unreadable).
      // Anything else — the engine itself failing — leaves the row for the
      // next boot rather than marking a good photo as hopeless.
      if (!(err instanceof HttpError && err.status === 400)) {
        console.error(`Re-deriving face sample ${row.id} failed:`, err);
        continue;
      }
      data = failure(err.message);
    }

    // Claimed on the engine and the quality it was read with: another process
    // that got there first has moved one of them on (a success changes the
    // engine, a failure the quality), and this one writes nothing.
    const claimed = await prisma.faceEnrollment.updateMany({
      where: {
        id: row.id,
        engine: row.engine,
        quality: row.quality == null ? { equals: Prisma.AnyNull } : { equals: row.quality as Prisma.InputJsonValue },
      },
      data,
    });
    if (!claimed.count) continue;
    if (data.engine) recomputed++;
    else failed++;
  }

  if (recomputed || failed) {
    await audit({
      entityType: 'setting',
      entityId: 'hr.rules',
      action: 'UPDATED',
      summary:
        `Face samples re-derived for the face engine ${FACE_ENGINE}: ${recomputed} recomputed from their photos` +
        (failed ? `, ${failed} could not be (kept as legacy samples, not used for matching)` : ''),
      actorName: 'system',
    });
    console.log(`Face samples re-derived: ${recomputed} recomputed, ${failed} could not be.`);
  }
  return { recomputed, failed };
}

// ── Refusals ─────────────────────────────────────────────────────────────────

/**
 * Every reason the clock refuses a face, as the audit row records it and HR's
 * Face health panel counts it. The row's one-line summary says the reason and
 * nothing more; whose face it came near, and how near, are in the row's
 * `after`, which only the audit trail and Face health read — the person who
 * was refused sees their own summary on My Work.
 */
export const FACE_REFUSAL_REASONS = {
  too_few_samples: 'Fewer than three face samples',
  quality: 'Poor capture (size, light or angle)',
  no_face: 'No face in the photo',
  several_faces: 'More than one face in the photo',
  unreadable: 'Not a readable photo',
  replay: 'A photo sent before, sent again',
  not_recognised: 'Face not recognised',
  not_this_account: "Looked like another employee's face",
  unsure: 'Too close to another employee to tell',
} as const;

export type FaceRefusalReason = keyof typeof FACE_REFUSAL_REASONS;

/** Every reason an enrolment refuses a sample for whose face it is (the quality gate is the person's to fix). */
export const ENROL_REFUSAL_REASONS = {
  inconsistent: "Unlike the person's own samples",
  collision: "Too close to another employee's enrolled face",
} as const;

export type EnrolRefusalReason = keyof typeof ENROL_REFUSAL_REASONS;

/**
 * What a describeFace() refusal was, from its message (face.ts words them for
 * the person), or null when it is not about the photo at all — the engine
 * being unavailable is the server's fault, not a refused face.
 */
export function describeRefusalReason(message: string): FaceRefusalReason | null {
  if (/faces are in that photo/i.test(message)) return 'several_faces';
  if (/not an image/i.test(message)) return 'unreadable';
  if (/no face was found/i.test(message)) return 'no_face';
  return null;
}

// ── Face health (HR Settings) ────────────────────────────────────────────────

/** The `after` of a refused clock-in's audit row (and of a refused enrolment's, with `faceEnrolRefusal`). */
export interface FaceRefusalRecord {
  faceRefusal?: FaceRefusalReason;
  faceEnrolRefusal?: EnrolRefusalReason;
  clockAction?: 'IN' | 'OUT';
  ownDistance?: number | null;
  nearestOther?: { employeeId: string; name: string; distance: number | null } | null;
}

/** How many of the last 30 days' refusals Face health lists one by one. */
const RECENT_REFUSALS = 20;

type Named = { id: string; name: string };

/**
 * How healthy the enrolled faces are, for HR: who is ready to use the clock,
 * who is not protected by it yet, which pairs of people the clock may struggle
 * to tell apart, which samples do not look like the rest of their owner's,
 * which accounts hold two faces, and how often the clock refused in the last
 * 30 days — by reason, and the latest refusals one by one with whose face
 * each came near (the names the refused person is never shown).
 */
export async function faceHealth() {
  const settings = await hrSettings();
  const threshold = settings.faceThreshold;
  const since = new Date(Date.now() - 30 * 86_400_000);

  const [employees, samples, refusals, enrolRefusals] = await Promise.all([
    prisma.employee.findMany({ where: { isActive: true }, select: { id: true, firstName: true, lastName: true } }),
    prisma.faceEnrollment.findMany({
      where: { employee: { isActive: true } },
      select: { id: true, employeeId: true, engine: true, descriptor: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.auditLog.findMany({
      where: { entityType: 'attendance', action: 'REJECTED', at: { gte: since } },
      select: { id: true, at: true, entityId: true, actorName: true, after: true },
      orderBy: { at: 'desc' },
    }),
    prisma.auditLog.findMany({
      where: { entityType: 'employee', action: 'REJECTED', at: { gte: since } },
      select: { id: true, at: true, entityId: true, actorName: true, after: true },
      orderBy: { at: 'desc' },
      take: 200,
    }),
  ]);

  const nameOf = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
  const current = new Map<string, { id: string; d: number[] }[]>();
  const legacy = new Map<string, number>();
  for (const s of samples) {
    if (isUsableSample(s)) {
      const list = current.get(s.employeeId) ?? [];
      list.push({ id: s.id, d: storedDescriptor(s.descriptor)! });
      current.set(s.employeeId, list);
    } else {
      legacy.set(s.employeeId, (legacy.get(s.employeeId) ?? 0) + 1);
    }
  }

  const people = { ready: 0, partial: 0, legacyOnly: 0, none: 0 };
  // Legacy-only people are not protected yet: their old samples take no part
  // in matching, so a colleague could enrol their face unrefused until they
  // add new ones.
  const unprotected: Named[] = [];
  for (const e of employees) {
    const n = current.get(e.id)?.length ?? 0;
    if (n >= MIN_FACE_SAMPLES) people.ready++;
    else if (n > 0) people.partial++;
    else if (legacy.get(e.id)) {
      people.legacyOnly++;
      unprotected.push({ id: e.id, name: nameOf.get(e.id) ?? '' });
    } else people.none++;
  }
  unprotected.sort((a, b) => a.name.localeCompare(b.name));

  // Pairs of people whose nearest samples are within threshold + 0.10.
  const ids = [...current.keys()];
  const closePairs: { a: Named; b: Named; distance: number }[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      let nearest = Number.POSITIVE_INFINITY;
      for (const x of current.get(ids[i])!) {
        for (const y of current.get(ids[j])!) nearest = Math.min(nearest, faceDistance(x.d, y.d));
      }
      if (nearest <= threshold + 0.1) {
        closePairs.push({
          a: { id: ids[i], name: nameOf.get(ids[i]) ?? '' },
          b: { id: ids[j], name: nameOf.get(ids[j]) ?? '' },
          distance: Math.round(nearest * 10000) / 10000,
        });
      }
    }
  }
  closePairs.sort((p, q) => p.distance - q.distance);

  // A sample further from every other sample of its owner than an enrolment
  // would have accepted: a poor capture, or somebody else's face. And an
  // account whose two FURTHEST samples are that far apart: enrolment measures
  // a new sample against the nearest one on file, so two faces can sit on one
  // account side by side, each with a twin of its own, and no single sample
  // stands out — the spread does.
  const outliers: { employee: Named; sampleId: string; distance: number }[] = [];
  const mixedAccounts: { employee: Named; distance: number; sampleIds: [string, string] }[] = [];
  for (const [employeeId, list] of current) {
    if (list.length < 2) continue;
    const employee = { id: employeeId, name: nameOf.get(employeeId) ?? '' };
    let widest = { distance: -1, a: '', b: '' };
    for (const s of list) {
      let nearest = Number.POSITIVE_INFINITY;
      for (const o of list) {
        if (o.id === s.id) continue;
        const d = faceDistance(s.d, o.d);
        nearest = Math.min(nearest, d);
        if (d > widest.distance) widest = { distance: d, a: s.id, b: o.id };
      }
      if (nearest > threshold + FACE_MARGIN) {
        outliers.push({ employee, sampleId: s.id, distance: Math.round(nearest * 10000) / 10000 });
      }
    }
    if (widest.distance > threshold + FACE_MARGIN) {
      mixedAccounts.push({
        employee,
        distance: Math.round(widest.distance * 10000) / 10000,
        sampleIds: [widest.a, widest.b],
      });
    }
  }
  outliers.sort((p, q) => q.distance - p.distance);
  mixedAccounts.sort((p, q) => q.distance - p.distance);

  const counts = Object.fromEntries(Object.keys(FACE_REFUSAL_REASONS).map((k) => [k, 0])) as Record<FaceRefusalReason, number>;
  let total = 0;
  for (const r of refusals) {
    const reason = (r.after as FaceRefusalRecord | null)?.faceRefusal;
    if (!reason || !(reason in counts)) continue;
    counts[reason]++;
    total++;
  }

  // The latest refusals, clock and enrolment together, one by one.
  type Recent = {
    id: string;
    at: Date;
    kind: 'clock' | 'enrol';
    reason: string;
    label: string;
    action: 'IN' | 'OUT' | null;
    employee: Named;
    by: string | null;
    ownDistance: number | null;
    nearestOther: (Named & { distance: number | null }) | null;
  };
  const recentRows: (Omit<Recent, 'employee' | 'nearestOther'> & {
    employeeId: string;
    nearest: FaceRefusalRecord['nearestOther'];
  })[] = [];
  for (const r of refusals) {
    const after = r.after as FaceRefusalRecord | null;
    const reason = after?.faceRefusal;
    if (!reason || !(reason in FACE_REFUSAL_REASONS)) continue;
    recentRows.push({
      id: r.id,
      at: r.at,
      kind: 'clock',
      reason,
      label: FACE_REFUSAL_REASONS[reason],
      action: after?.clockAction ?? null,
      employeeId: r.entityId,
      by: r.actorName,
      ownDistance: after?.ownDistance ?? null,
      nearest: after?.nearestOther ?? null,
    });
  }
  for (const r of enrolRefusals) {
    const after = r.after as FaceRefusalRecord | null;
    const reason = after?.faceEnrolRefusal;
    if (!reason || !(reason in ENROL_REFUSAL_REASONS)) continue;
    recentRows.push({
      id: r.id,
      at: r.at,
      kind: 'enrol',
      reason,
      label: ENROL_REFUSAL_REASONS[reason],
      action: null,
      employeeId: r.entityId,
      by: r.actorName,
      ownDistance: after?.ownDistance ?? null,
      nearest: after?.nearestOther ?? null,
    });
  }
  recentRows.sort((a, b) => b.at.getTime() - a.at.getTime());
  const latest = recentRows.slice(0, RECENT_REFUSALS);
  // Names as they are now, inactive people included (a leaver's refusal still names them).
  const missing = [...new Set(latest.map((r) => r.employeeId).filter((id) => !nameOf.has(id)))];
  if (missing.length) {
    const more = await prisma.employee.findMany({
      where: { id: { in: missing } },
      select: { id: true, firstName: true, lastName: true },
    });
    for (const e of more) nameOf.set(e.id, `${e.firstName} ${e.lastName}`);
  }
  const recentRefusals: Recent[] = latest.map(({ employeeId, nearest, ...rest }) => ({
    ...rest,
    employee: { id: employeeId, name: nameOf.get(employeeId) ?? 'Unknown employee' },
    nearestOther: nearest
      ? { id: nearest.employeeId, name: nameOf.get(nearest.employeeId) ?? nearest.name, distance: nearest.distance }
      : null,
  }));

  return {
    engine: FACE_ENGINE,
    threshold,
    margin: FACE_MARGIN,
    samplesNeeded: MIN_FACE_SAMPLES,
    maxSamples: MAX_FACE_SAMPLES,
    people,
    unprotected,
    closePairs: closePairs.slice(0, 20),
    outliers,
    mixedAccounts,
    refusals30d: {
      total,
      reasons: (Object.keys(FACE_REFUSAL_REASONS) as FaceRefusalReason[]).map((reason) => ({
        reason,
        label: FACE_REFUSAL_REASONS[reason],
        count: counts[reason],
      })),
    },
    recentRefusals,
  };
}

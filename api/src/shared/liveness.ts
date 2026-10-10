import crypto from 'node:crypto';
import sharp from 'sharp';
import { env } from '../env';
import { badRequest } from '../http/kit';
import { withFaceEngine, yawOf, type FaceLandmarks, type Point } from './face';
import { faceDistance } from './hr';

/**
 * Telling a live person from a picture of one, at the face clock and its
 * enrolment (2026-10-10, the owner's call: "a printed photo or a phone
 * screen held to the camera must not pass").
 *
 * G-Core has no liveness model. The check is a CHALLENGE the person performs
 * in front of the camera — blink once, or turn the head slightly left and
 * right — which the server verifies from a short burst of frames with the
 * 68-point landmarks the engine already runs: the eye aspect ratio (EAR) for
 * a blink, the yaw figure `FaceQuality` already carries for a turn, and a
 * cheap same-face check so a photo cannot be swapped for a face mid-burst.
 *
 * The challenge is picked at random and signed, so the browser cannot choose
 * it, replay it or hand it to somebody else; it lives 90 seconds and is used
 * once. The token is STATELESS — an HMAC over its own fields — and the only
 * memory is a small set of nonces spent in the last 90 seconds, which a
 * restart forgets: the clock refuses an expired one anyway.
 *
 * THE ACCEPTED LIMIT: a VIDEO of the person performing the same movement,
 * played to the camera, can still pass. The random challenge (two kinds
 * today) makes a prepared video unlikely to match; it does not make it
 * impossible. The photo kept with every entry remains what HR checks a
 * doubtful one against.
 */

// ── The challenge ────────────────────────────────────────────────────────────

export type ChallengeKind = 'blink' | 'turn';
export const CHALLENGE_KINDS: readonly ChallengeKind[] = ['blink', 'turn'];

/** How long the ring runs on the Clock page — the burst the browser records. */
export const CHALLENGE_SECONDS = 2.5;
/** A challenge is good for this long after it is issued. */
export const CHALLENGE_TTL_MS = 90_000;

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const sign = (payload: string) => crypto.createHmac('sha256', env.jwtSecret).update(payload).digest('base64url');

/** The nonces spent in the last `CHALLENGE_TTL_MS`, with when each was issued. */
const spent = new Map<string, number>();

function forgetOldNonces(now: number) {
  for (const [nonce, issuedAt] of spent) if (now - issuedAt > CHALLENGE_TTL_MS) spent.delete(nonce);
}

export interface Challenge {
  challenge: string;
  kind: ChallengeKind;
  seconds: number;
  expiresAt: Date;
}

/** A fresh challenge for this person: the kind is random, the token is theirs alone. */
export function issueChallenge(userId: string, now = new Date()): Challenge {
  const kind = CHALLENGE_KINDS[crypto.randomInt(CHALLENGE_KINDS.length)];
  const nonce = crypto.randomBytes(12).toString('base64url');
  const payload = `${userId}.${kind}.${now.getTime()}.${nonce}`;
  const encoded = b64(payload);
  return {
    challenge: `${encoded}.${sign(encoded)}`,
    kind,
    seconds: CHALLENGE_SECONDS,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  };
}

export const CHALLENGE_MESSAGES = {
  invalid: 'That liveness check is not valid — reload the page and try again',
  expired: 'The liveness check timed out — try again',
  used: 'That liveness check was already used',
  foreign: 'Not your liveness check',
} as const;

/**
 * Checks a challenge token and SPENDS it: the signature, that it was issued
 * to this person, that it is not older than `CHALLENGE_TTL_MS`, and that it
 * has not been used. Throws a 400 in the person's words otherwise.
 */
export function verifyChallenge(token: string, userId: string, now = new Date()): { kind: ChallengeKind } {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) throw badRequest(CHALLENGE_MESSAGES.invalid);
  const encoded = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(encoded));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw badRequest(CHALLENGE_MESSAGES.invalid);
  }
  const parts = Buffer.from(encoded, 'base64url').toString('utf8').split('.');
  // The user id and the nonce carry no dots; a token with more parts is not ours.
  if (parts.length !== 4) throw badRequest(CHALLENGE_MESSAGES.invalid);
  const [owner, kind, issuedAtText, nonce] = parts;
  const issuedAt = Number(issuedAtText);
  if (!CHALLENGE_KINDS.includes(kind as ChallengeKind) || !Number.isFinite(issuedAt) || !nonce) {
    throw badRequest(CHALLENGE_MESSAGES.invalid);
  }
  if (owner !== userId) throw badRequest(CHALLENGE_MESSAGES.foreign);
  const age = now.getTime() - issuedAt;
  if (age > CHALLENGE_TTL_MS || age < -CHALLENGE_TTL_MS) throw badRequest(CHALLENGE_MESSAGES.expired);
  forgetOldNonces(now.getTime());
  if (spent.has(nonce)) throw badRequest(CHALLENGE_MESSAGES.used);
  spent.set(nonce, issuedAt);
  return { kind: kind as ChallengeKind };
}

// ── The verdict ──────────────────────────────────────────────────────────────
//
// Calibrated on 2026-10-10 against fixtures built from face-api's demo
// webcam screenshot (one person, 853×1280; the frames its 480-wide copy, the
// crops as `measureFrame` cuts them) — api/scripts/lib/faceFixtures.ts holds
// the builders. The numbers:
//
// - Twenty identical frames: EAR range 0.000, yaw range 0.000 — a photo held
//   still is exactly still, and even a hand-held one moves in the plane,
//   which neither figure reads (both are ratios within the face).
// - A head TURN cannot be faked by shearing the picture: the 68-point net
//   regularises the nose onto the face shapes it knows, so a shear of
//   ±0.18 — the nose visibly pushed off the eye line — reads as a yaw swing
//   of 0.02–0.04 (the full pipeline: 0.04). Foreshortening one half of the
//   face (what a real turn looks like) does read: squashing the far half to
//   60% swings the yaw by 0.18 (−0.161 … +0.022 around a −0.09 baseline);
//   to 90%, by 0.045. The people in the enrolment benchmark turned to 0.28
//   on their "slightly left / right" samples, so a real turn each way runs
//   past 0.3 of range.
// - A BLINK cannot be faked by painting the lids shut either: a skin-toned
//   patch over each eye drops the net's EAR by 8–18% (0.279 → 0.245 at the
//   crop the check uses), a painted lash line even less. The net places the
//   eye points where an eye should be; it needs a real closed eye. The ratio
//   below is therefore physiology, not the fixture: the eye aspect ratio of
//   an open eye sits at 0.25–0.35 and a closed one under 0.15 (Soukupová &
//   Čech, 2016), so a blink halves it, while frame-to-frame jitter on a
//   moving face kept every open frame within 6% of the median.
// - The frame-to-frame jitter of a moving face at the clock's crop: EAR
//   ±0.015, yaw ±0.01.

/** Frames with readable landmarks a verdict needs. */
export const MIN_FRAMES = 8;
/**
 * A blink: the lowest EAR under this share of the median. A real blink
 * reaches 0.4–0.5 of the open eye; jitter stays above 0.9; painted lids
 * reach 0.82 at best, which is deliberately NOT enough.
 */
export const BLINK_RATIO = 0.7;
/** An eye at or above this share of the median EAR counts as open. */
export const OPEN_RATIO = 0.85;
/** A turn: the yaw must swing by at least this much across the burst. */
export const TURN_RANGE = 0.1;
/**
 * Too still to be a person: EAR AND yaw both within these across every
 * frame. Jitter alone on a live face runs to 0.03 of EAR and 0.02 of yaw;
 * a photo held still gives 0.000 of both.
 */
export const STILL_EAR_RANGE = 0.02;
export const STILL_YAW_RANGE = 0.02;

export type LivenessReason = 'too_few_frames' | 'no_blink' | 'no_turn' | 'not_live';
export type LivenessVerdict = { ok: true } | { ok: false; reason: LivenessReason };

/** One frame's reading: the eye aspect ratio (mean of both eyes) and the yaw. */
export interface FrameReading {
  ear: number;
  yaw: number;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The eye aspect ratio of one eye's six landmarks (p1 … p6 around the eye,
 * p1 and p4 the corners): (|p2−p6| + |p3−p5|) / (2·|p1−p4|). Open eyes sit
 * near 0.3; a closed one falls under 0.15. Scale-free.
 */
export function eyeAspectRatio(eye: Point[]): number {
  if (eye.length < 6) return 0;
  const [p1, p2, p3, p4, p5, p6] = eye;
  const width = dist(p1, p4);
  return width > 0 ? (dist(p2, p6) + dist(p3, p5)) / (2 * width) : 0;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Whether a series of readings shows the challenge being performed — PURE,
 * so it is tested without a camera.
 *
 * - `too_few_frames`: fewer than `MIN_FRAMES` usable readings.
 * - `not_live`, for either kind: too still — the EAR range under
 *   `STILL_EAR_RANGE` AND the yaw range under `STILL_YAW_RANGE` across every
 *   frame, which is a photo held still.
 * - `no_blink`: the lowest EAR is not under `BLINK_RATIO` × the median, or the
 *   eyes were not seen open (≥ `OPEN_RATIO` × the median) in at least two
 *   frames BEFORE and two AFTER it — open, closed, open.
 * - `no_turn`: the yaw's range is under `TURN_RANGE`, or it did not cross the
 *   series' median by `TURN_RANGE / 3` on BOTH sides — left and right, in
 *   either order.
 */
export function livenessVerdict(kind: ChallengeKind, series: FrameReading[]): LivenessVerdict {
  const usable = series.filter((r) => Number.isFinite(r.ear) && Number.isFinite(r.yaw));
  if (usable.length < MIN_FRAMES) return { ok: false, reason: 'too_few_frames' };
  const ears = usable.map((r) => r.ear);
  const yaws = usable.map((r) => r.yaw);
  const earRange = Math.max(...ears) - Math.min(...ears);
  const yawRange = Math.max(...yaws) - Math.min(...yaws);
  if (earRange < STILL_EAR_RANGE && yawRange < STILL_YAW_RANGE) return { ok: false, reason: 'not_live' };

  if (kind === 'blink') {
    const open = median(ears);
    let at = 0;
    for (let i = 1; i < ears.length; i++) if (ears[i] < ears[at]) at = i;
    if (!(ears[at] < BLINK_RATIO * open)) return { ok: false, reason: 'no_blink' };
    const isOpen = (v: number) => v >= OPEN_RATIO * open;
    const before = ears.slice(0, at).filter(isOpen).length;
    const after = ears.slice(at + 1).filter(isOpen).length;
    if (before < 2 || after < 2) return { ok: false, reason: 'no_blink' };
    return { ok: true };
  }

  const centre = median(yaws);
  if (yawRange < TURN_RANGE) return { ok: false, reason: 'no_turn' };
  const each = TURN_RANGE / 3;
  if (Math.max(...yaws) - centre < each || centre - Math.min(...yaws) < each) return { ok: false, reason: 'no_turn' };
  return { ok: true };
}

// ── The server's run ─────────────────────────────────────────────────────────

/**
 * The face box from the still, padded by this much of its size each side,
 * is what each frame is cut to. Measured, not chosen: at 35% the landmark
 * net — trained on the detector's tight boxes — loses the turn (a yaw swing
 * of 0.05 where the full pipeline reads 0.25) and reads a frame identical to
 * the still 0.19 away from it; at 20% it reads the swing (0.18) and the same
 * frame at 0.13; at 0–10% the dlib alignment the descriptor needs runs off
 * the crop's edge (0.30–0.44).
 */
export const CROP_PADDING = 0.2;
/** The landmark net sees the crop at this width (it resizes to 112 inside). */
export const CROP_WIDTH = 160;
/**
 * The first and last frames' faces must be within this of the still's
 * descriptor. A frame identical to the still reads 0.13 (0.28 with the eyes
 * 33 px apart in the frame); a stranger's face pasted over it, 0.80.
 */
export const SAME_FACE_DISTANCE = 0.5;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A frame decoded to packed RGB. */
interface Raw {
  data: Buffer;
  width: number;
  height: number;
}

/** The still's face box on a frame of another size, padded and clamped to the frame. */
function cropRect(box: Box, scale: number, width: number, height: number) {
  const b = { x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale };
  const left = Math.max(0, Math.round(b.x - b.width * CROP_PADDING));
  const top = Math.max(0, Math.round(b.y - b.height * CROP_PADDING));
  const right = Math.min(width, Math.round(b.x + b.width * (1 + CROP_PADDING)));
  const bottom = Math.min(height, Math.round(b.y + b.height * (1 + CROP_PADDING)));
  return { left, top, width: right - left, height: bottom - top };
}

async function cropOf(frame: Buffer, box: Box, stillWidth: number, resizeTo: number | null) {
  const meta = await sharp(frame).rotate().metadata();
  if (!meta.width || !meta.height) throw new Error('not an image');
  const rect = cropRect(box, meta.width / stillWidth, meta.width, meta.height);
  if (rect.width < 24 || rect.height < 24) throw new Error('face box off the frame');
  let img = sharp(frame).rotate().extract(rect);
  if (resizeTo) img = img.resize(resizeTo);
  const out = await img.toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw: Raw = { data: out.data, width: out.info.width, height: out.info.height };
  return { raw, rect };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function landmarksOf(api: any, raw: Raw): Promise<FaceLandmarks | null> {
  const tensor = api.tf.tensor3d(new Uint8Array(raw.data), [raw.height, raw.width, 3]);
  try {
    const found = await api.detectFaceLandmarks(tensor);
    return Array.isArray(found) ? found[0] ?? null : found ?? null;
  } finally {
    tensor.dispose();
  }
}

export interface FrameMeasure extends FrameReading {
  /** Each eye's landmark box in the FRAME's own pixels — what a fixture paints over. */
  leftEye: Box;
  rightEye: Box;
}

const boxOf = (points: Point[], scale: number, dx: number, dy: number): Box => {
  const xs = points.map((p) => p.x * scale + dx);
  const ys = points.map((p) => p.y * scale + dy);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

/**
 * One frame's reading: the still's face box scaled onto the frame
 * (`frameWidth / stillWidth`), padded, cut, resized to `CROP_WIDTH` and put
 * through the landmark net ALONE — no detector, which is what makes twenty
 * frames cost a third of one capture. Null when the landmarks fail.
 * Exported for the fixtures the verify script builds, which need the eyes'
 * boxes; the check itself goes through `checkLiveness`.
 */
export async function measureFrame(frame: Buffer, box: Box, stillWidth: number): Promise<FrameMeasure | null> {
  return withFaceEngine((api) => measureWith(api, frame, box, stillWidth));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function measureWith(api: any, frame: Buffer, box: Box, stillWidth: number): Promise<FrameMeasure | null> {
  try {
    const { raw, rect } = await cropOf(frame, box, stillWidth, CROP_WIDTH);
    const landmarks = await landmarksOf(api, raw);
    if (!landmarks) return null;
    const left = landmarks.getLeftEye();
    const right = landmarks.getRightEye();
    const ear = (eyeAspectRatio(left) + eyeAspectRatio(right)) / 2;
    const yaw = yawOf(landmarks);
    if (!Number.isFinite(ear) || !Number.isFinite(yaw)) return null;
    const back = rect.width / raw.width;
    return { ear, yaw, leftEye: boxOf(left, back, rect.left, rect.top), rightEye: boxOf(right, back, rect.left, rect.top) };
  } catch {
    return null;
  }
}

/**
 * The frame's face as the recognition net sees it — the crop at the frame's
 * own resolution, its landmarks, the dlib alignment face-api's pipeline uses
 * (`align(null, { useDlibAlignment: true })` — the default alignment reads
 * the same face 0.3 further away), the 128 floats. Null when nothing readable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function descriptorWith(api: any, frame: Buffer, box: Box, stillWidth: number): Promise<number[] | null> {
  try {
    const { raw } = await cropOf(frame, box, stillWidth, null);
    const tensor = api.tf.tensor3d(new Uint8Array(raw.data), [raw.height, raw.width, 3]);
    try {
      const found = await api.detectFaceLandmarks(tensor);
      const landmarks = Array.isArray(found) ? found[0] : found;
      if (!landmarks) return null;
      const faces = await api.extractFaceTensors(tensor, [landmarks.align(null, { useDlibAlignment: true })]);
      try {
        const descriptor = await api.computeFaceDescriptor(faces[0]);
        return Array.from(descriptor as Float32Array);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        faces.forEach((t: any) => t.dispose());
      }
    } finally {
      tensor.dispose();
    }
  } catch {
    return null;
  }
}

export interface LivenessInput {
  /** The face box `describeFace` found on the still, in the still's pixels. */
  box: Box;
  /** The still's width (after its EXIF turn) — the frames are scaled from it. */
  stillWidth: number;
  /** The still's descriptor, which the first and last frames must match. */
  descriptor: number[];
}

export interface LivenessResult {
  verdict: LivenessVerdict;
  /** Frames sent. */
  frames: number;
  /** Frames whose landmarks were read. */
  usable: number;
  /** Distance of the first and last usable frames' faces from the still's; null where none could be read. */
  sameFace: { first: number | null; last: number | null };
  /** How long the engine took, in milliseconds. */
  ms: number;
}

/**
 * The server's liveness check over a burst: every frame measured
 * (`measureWith`), the first and last usable ones described and compared
 * with the still — a face more than `SAME_FACE_DISTANCE` away at either end
 * is `not_live`: a photo swapped for a face, or a face for a photo, mid-burst
 * — and the readings judged by `livenessVerdict`. Runs in face.ts's
 * one-at-a-time queue, as one job, so a burst never runs beside a capture.
 */
export async function checkLiveness(frames: Buffer[], kind: ChallengeKind, input: LivenessInput): Promise<LivenessResult> {
  return withFaceEngine(async (api) => {
    const started = performance.now();
    const readings: FrameReading[] = [];
    const usableFrames: Buffer[] = [];
    for (const frame of frames) {
      const m = await measureWith(api, frame, input.box, input.stillWidth);
      if (!m) continue;
      readings.push({ ear: m.ear, yaw: m.yaw });
      usableFrames.push(frame);
    }
    const done = (verdict: LivenessVerdict, sameFace: LivenessResult['sameFace']): LivenessResult => ({
      verdict,
      frames: frames.length,
      usable: readings.length,
      sameFace,
      ms: Math.round(performance.now() - started),
    });
    if (readings.length < MIN_FRAMES) return done({ ok: false, reason: 'too_few_frames' }, { first: null, last: null });

    const ends = [usableFrames[0], usableFrames[usableFrames.length - 1]];
    const sameFace = { first: null as number | null, last: null as number | null };
    for (let i = 0; i < ends.length; i++) {
      const descriptor = await descriptorWith(api, ends[i], input.box, input.stillWidth);
      const distance = descriptor ? faceDistance(descriptor, input.descriptor) : null;
      if (i === 0) sameFace.first = distance;
      else sameFace.last = distance;
      if (distance == null || distance > SAME_FACE_DISTANCE) return done({ ok: false, reason: 'not_live' }, sameFace);
    }
    return done(livenessVerdict(kind, readings), sameFace);
  });
}

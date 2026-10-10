import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { HttpError, badRequest } from '../http/kit';

/**
 * Turning a photograph into a 128-float face descriptor.
 *
 * This runs on the SERVER, not in the browser. The browser sends the picture;
 * the server decides whose face it is. Doing the arithmetic client-side would
 * be faster and cheaper, but it would mean trusting whatever descriptor a
 * client chose to post — and a descriptor is all that stands between someone
 * and clocking in as a colleague. The photo is the evidence, so the photo is
 * what travels.
 *
 * Weights ship inside @vladmandic/face-api, so there is nothing to download at
 * deploy time and no CDN in the path of the time clock.
 *
 * The pipeline (2026-10-10, after "sometimes they matched other account
 * faces"): SSD MobileNet v1 finds the face, the FULL 68-point landmark net
 * places it, and the frame is turned so the eyes are level before the
 * descriptor is taken. A benchmark of 8 people × 5 photos and 22 strangers,
 * through simulated webcam, dark and tilted captures, traced the wrong-account
 * matches to two causes — a tilted head (face-api crops by the landmarks but
 * never rotates the crop, so a tilt reads as a different face) and poor
 * samples — and this pipeline removed every one of them. See FACE_ENGINE for
 * what that means for descriptors stored before it.
 */

/**
 * The version of the pipeline below, stored with every enrolment sample —
 * defined in shared/faceEngine.ts (a module importing nothing, so the code
 * that only needs the string never loads this one) and re-exported here.
 * Change anything that alters a descriptor (detector, landmark net, working
 * size, levelling, retry) and that string must change too.
 */
export { FACE_ENGINE } from './faceEngine';

/**
 * Why a face is being described, which decides how hard the engine tries.
 *
 * - `clock`: a person at the door. A frame with no face gets one
 *   contrast-stretched retry, because a dark office is the commonest reason
 *   the detector sees nothing.
 * - `enrol`: a sample others will be measured against. No retry — a frame
 *   that needs rescuing is not a sample anyone should be compared with.
 * - `rederive`: recomputing a stored sample's photo under a new engine. No
 *   retry and no quality gate: the photo was accepted when it was taken.
 */
export type FacePurpose = 'clock' | 'enrol' | 'rederive';
const PURPOSES: readonly FacePurpose[] = ['clock', 'enrol', 'rederive'];

/** face-api's own types are loaded lazily; the module is ~6MB of WASM. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let faceapi: any = null;
let loading: Promise<void> | null = null;

/**
 * The working frame: no side over 960×1280, never enlarged.
 *
 * SSD scales its input to 512×512 itself; the landmarks and the 150×150 crop
 * the descriptor is taken from are cut from this frame, so a face keeps the
 * pixels the camera gave it. Enlarging a small frame invents none.
 */
const WORK_WIDTH = 960;
const WORK_HEIGHT = 1280;

/** SSD's confidence floor. 0.3 found a few more dark faces and nothing else. */
const SSD_MIN_CONFIDENCE = 0.5;

/**
 * Eyes sloping by this many degrees or more are levelled before the face is
 * described. Below it the turn changes the descriptor by less than the
 * capture's own noise.
 */
const LEVEL_FROM_DEGREES = 3;

/** What fills the corners a levelling turn uncovers: the probes' own mid-grey. */
const LEVEL_BACKGROUND = { r: 128, g: 128, b: 128 };

function modelsPath(): string {
  // Resolved from the package itself rather than from process.cwd(), so it is
  // the same path whether this runs from src/, from dist/ or from a script.
  const pkg = require.resolve('@vladmandic/face-api/package.json');
  return path.join(path.dirname(pkg), 'model');
}

async function load(): Promise<void> {
  if (faceapi) return;
  if (loading) return loading;

  loading = (async () => {
    // The node-wasm build bundles its own TensorFlow backend — no native
    // bindings, so it installs the same way on the Windows host as anywhere.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const api = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
    await api.tf.ready();

    const dir = modelsPath();
    await api.nets.ssdMobilenetv1.loadFromDisk(dir);
    await api.nets.faceLandmark68Net.loadFromDisk(dir);
    await api.nets.faceRecognitionNet.loadFromDisk(dir);

    faceapi = api;
    console.log('Face recognition models loaded.');
  })();

  try {
    await loading;
  } finally {
    loading = null;
  }
}

/**
 * Loads the models ahead of the first clock-in.
 *
 * Without this the first person through the door waits two or three seconds
 * for a model load and assumes the clock is broken. Called at boot; a failure
 * is logged and swallowed, because the rest of G-Core must still start.
 */
export async function warmUpFaceModels(): Promise<void> {
  try {
    await load();
  } catch (err) {
    console.error('Face model warm-up failed — face clock-in will not work:', err);
  }
}

/**
 * How good the capture was, measured on the face the descriptor came from.
 * Stored with an enrolment sample and checked by `faceQualityProblem()`.
 */
export interface FaceQuality {
  /** Detector confidence for the face whose descriptor is kept (0–1). */
  score: number;
  /**
   * Pixels between the centres of the eyes, in the ORIGINAL image's scale
   * (after its EXIF turn), so a figure means the same whatever the working
   * frame was shrunk to.
   */
  eyeDistance: number;
  /** Mean luma (0–255) of the face box, as the camera delivered it. */
  brightness: number;
  /**
   * How far the head is turned: the nose tip's offset from the midpoint of
   * the eyes, along the line of the eyes, over the eye distance. Signed —
   * positive is towards the right of the picture. About 0.5 × tan(turn), so
   * 0.1 is some 11°, 0.3 some 31°.
   */
  yaw: number;
  /** Slope of the eyes in degrees, BEFORE any levelling (positive: clockwise). */
  tilt: number;
  /** The descriptor came from a frame turned so the eyes are level. */
  levelled: boolean;
  /** The face was only found in a contrast-stretched copy of the frame. */
  contrastRetry: boolean;
  /**
   * Original pixels per working pixel (1 when the frame was not shrunk; 1.33
   * for a 1280×720 webcam frame, which works at 960×540). The size gate is
   * judged on the pixels the nets actually saw — `eyeDistance / frameScale` —
   * because that, not the camera's resolution, is what makes a descriptor
   * sharp or blurred. Optional so a quality stored or built without it reads
   * as unshrunk.
   */
  frameScale?: number;
}

export interface FaceCapture {
  descriptor: number[];
  /** Detector confidence, kept alongside the match distance for review. */
  score: number;
  quality: FaceQuality;
  /**
   * Where the face is, in the ORIGINAL image's pixels after its EXIF turn —
   * what `accountPhotoFrom()` crops the avatar around. Not stored.
   */
  box: { x: number; y: number; width: number; height: number };
}

/** A decoded working frame: packed RGB, plus how much it was shrunk. */
interface Frame {
  data: Buffer;
  width: number;
  height: number;
  /** Original pixels per working pixel (1 when nothing was shrunk). */
  scale: number;
}

interface Point {
  x: number;
  y: number;
}

/** One pass of detect → landmarks → descriptor over a frame. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function detect(frame: Frame): Promise<any[]> {
  const tensor = faceapi.tf.tensor3d(new Uint8Array(frame.data), [frame.height, frame.width, 3]);
  try {
    return await faceapi
      .detectAllFaces(tensor, new faceapi.SsdMobilenetv1Options({ minConfidence: SSD_MIN_CONFIDENCE }))
      .withFaceLandmarks()
      .withFaceDescriptors();
  } finally {
    tensor.dispose();
  }
}

/** The same frame through another sharp operation, still packed RGB. */
async function transform(frame: Frame, op: (img: Sharp) => Sharp): Promise<Frame> {
  const out = await op(sharp(frame.data, { raw: { width: frame.width, height: frame.height, channels: 3 } }))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: out.data, width: out.info.width, height: out.info.height, scale: frame.scale };
}

function centre(points: Point[]): Point {
  const x = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const y = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  return { x, y };
}

/** Mean luma (BT.601) of a box of the frame, clipped to the frame. */
function meanLuma(frame: Frame, box: { x: number; y: number; width: number; height: number }): number {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(frame.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(frame.height, Math.ceil(box.y + box.height));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    let i = (y * frame.width + x0) * 3;
    for (let x = x0; x < x1; x++, i += 3) {
      sum += 0.299 * frame.data[i] + 0.587 * frame.data[i + 1] + 0.114 * frame.data[i + 2];
      n++;
    }
  }
  return n ? sum / n : 0;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * One face at a time, and only a few waiting.
 *
 * The engine is WebAssembly on the API's own thread: a dozen captures
 * described at once (a loop, or a group photo sent over and over) held every
 * other request for six seconds, on a host the API shares with a
 * safety-critical system. Run one after another, a capture holds the thread
 * only for its own stretch, and the rest of G-Core is served between them.
 * Past `MAX_WAITING` the door answers 429 rather than queueing without end;
 * the boot-time re-derivation always waits its turn instead.
 */
const MAX_WAITING = 8;
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;

function oneAtATime<T>(work: () => Promise<T>, alwaysWait: boolean): Promise<T> {
  if (!alwaysWait && waiting >= MAX_WAITING) {
    throw new HttpError(429, 'The face clock is busy — wait a moment and try again.');
  }
  waiting++;
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run.finally(() => {
    waiting--;
  });
}

/**
 * Extracts exactly one face from an image, with how good a capture it was.
 *
 * Refuses on none and on more than one. Two faces in frame is the obvious way
 * to try to clock in a colleague who is not there, and picking "the biggest
 * one" would make that work — so a frame with several faces is never retried
 * either.
 *
 * It measures; it does not judge. Whether the capture is good enough is
 * `faceQualityProblem()`'s call, made by the route, which also has to record
 * a refusal and throw the photo away.
 */
export async function describeFace(image: Buffer, options: { purpose: FacePurpose }): Promise<FaceCapture> {
  const purpose = options?.purpose;
  if (!PURPOSES.includes(purpose)) {
    // A caller that forgot to say why would silently get the clock's retry on
    // an enrolment sample. That is a programming error, not a bad photo.
    throw new Error(`describeFace needs a purpose (clock, enrol or rederive), not ${String(purpose)}`);
  }
  await load();
  if (!faceapi) throw badRequest('Face recognition is not available on this server');
  return oneAtATime(() => describe(image, purpose), purpose === 'rederive');
}

async function describe(image: Buffer, purpose: FacePurpose): Promise<FaceCapture> {
  // Down to a sane size first: a modern phone camera frame is far larger than
  // the detector needs and costs seconds for nothing.
  let frame: Frame;
  try {
    const meta = await sharp(image).metadata();
    const raw = await sharp(image)
      .rotate() // honour the EXIF orientation, or a phone portrait arrives sideways
      .resize(WORK_WIDTH, WORK_HEIGHT, { fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb') // a greyscale frame still reaches the detector as three channels
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (raw.info.channels !== 3 || !meta.width || !meta.height) throw new Error('not RGB');
    // Orientations 5–8 are quarter turns: the original's width is its height.
    const originalWidth = (meta.orientation ?? 1) >= 5 ? meta.height : meta.width;
    frame = { data: raw.data, width: raw.info.width, height: raw.info.height, scale: originalWidth / raw.info.width };
  } catch {
    throw badRequest('That file is not an image the camera produced');
  }

  // The plain frame first. Only when it holds NO face, and only at the door,
  // try once more with the contrast stretched (sharp's normalise: the 1st to
  // 99th luminance percentile spread over the full range). In the benchmark
  // that found the face in 38 of 40 dark, small, soft frames where the plain
  // pass found 4, and the descriptors it gave matched their owners.
  let source = frame;
  let found = await detect(frame);
  let contrastRetry = false;
  if (!found.length && purpose === 'clock') {
    source = await transform(frame, (img) => img.normalise());
    found = await detect(source);
    contrastRetry = true;
  }

  if (!found.length) {
    throw badRequest(
      'No face was found in that photo. Face the camera squarely, with the light in front of you rather than behind.',
    );
  }
  if (found.length > 1) {
    throw badRequest(
      `${found.length} faces are in that photo. Only the person clocking in should be in frame.`,
    );
  }

  const face = found[0];
  const landmarks = face.landmarks;
  // getLeftEye() is the eye on the LEFT OF THE PICTURE (the person's right).
  const leftEye = centre(landmarks.getLeftEye());
  const rightEye = centre(landmarks.getRightEye());
  const dx = rightEye.x - leftEye.x;
  const dy = rightEye.y - leftEye.y;
  const eyePx = Math.hypot(dx, dy);
  const tilt = (Math.atan2(dy, dx) * 180) / Math.PI;

  // Yaw: the nose tip (landmark 30) against the midpoint of the eyes,
  // measured ALONG the eye line so a tilted head does not read as a turned one.
  const noseTip: Point = landmarks.positions[30];
  const mid = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };
  const yaw = eyePx > 0 ? ((noseTip.x - mid.x) * dx + (noseTip.y - mid.y) * dy) / (eyePx * eyePx) : 0;

  // Brightness is read off the frame as captured, even when the face was only
  // found in the stretched copy: it reports how dark the room was.
  const brightness = meanLuma(frame, face.detection.box);

  let descriptor: Float32Array = face.descriptor;
  let score: number = face.detection.score;
  let levelled = false;

  // Level the eyes. face-api cuts the descriptor's crop along the landmarks'
  // bounding box but never rotates it, so a head tilted 12° is described as a
  // somewhat different face — and in the benchmark that, more than anything,
  // was how one person came to match another's account. Turn the whole frame
  // back by the slope (sharp turns clockwise for a positive angle) and
  // describe again; keep the levelled descriptor only if the turned frame
  // still holds exactly one face, else the plain one stands.
  if (Math.abs(tilt) >= LEVEL_FROM_DEGREES) {
    const turned = await transform(source, (img) => img.rotate(-tilt, { background: LEVEL_BACKGROUND }));
    const again = await detect(turned);
    if (again.length === 1) {
      descriptor = again[0].descriptor;
      score = again[0].detection.score;
      levelled = true;
    }
  }

  const quality: FaceQuality = {
    score: round(score, 4),
    eyeDistance: round(eyePx * frame.scale, 1),
    brightness: round(brightness, 1),
    yaw: round(yaw, 3),
    // Cut toward level, never rounded up: a 2.96° slope was not levelled, and
    // must not read as 3.0° to a gate that asks whether it should have been.
    tilt: Math.trunc(tilt * 10) / 10,
    levelled,
    contrastRetry,
    frameScale: round(frame.scale, 4),
  };

  const found0 = face.detection.box;
  const box = {
    x: round(found0.x * frame.scale, 1),
    y: round(found0.y * frame.scale, 1),
    width: round(found0.width * frame.scale, 1),
    height: round(found0.height * frame.scale, 1),
  };

  return { descriptor: Array.from(descriptor), score: quality.score, quality, box };
}

/**
 * The account picture made from an enrolment capture: the face, cropped
 * square with room around it, at `AVATAR_PX` — never the capture itself.
 *
 * Every account photo is seen by everyone signed in (it is the face beside a
 * name on every screen). The capture used to BE the account photo, so anyone
 * could fetch a sample's exact bytes and post them back to the clock as that
 * person, matching at a distance of 0. A 96-pixel picture is plenty for an
 * avatar (the largest is drawn at 72) and too little for the clock: its
 * eyes are under the clock's size floor, and blown back up it is a blur.
 */
export const AVATAR_PX = 96;

export async function accountPhotoFrom(image: Buffer, box: FaceCapture['box'] | null): Promise<Buffer> {
  const turned = await sharp(image).rotate().toBuffer({ resolveWithObject: true });
  const { width, height } = turned.info;
  // Twice the face, centred on it; with no box (a capture filed before boxes
  // were kept) the middle of the frame, where the Clock page's oval puts it.
  const side = Math.max(1, Math.min(width, height, box ? Math.round(Math.max(box.width, box.height) * 2) : height));
  const cx = box ? box.x + box.width / 2 : width / 2;
  const cy = box ? box.y + box.height / 2 : height / 2;
  const left = Math.min(Math.max(0, Math.round(cx - side / 2)), width - side);
  const top = Math.min(Math.max(0, Math.round(cy - side / 2)), height - side);
  return sharp(turned.data)
    .extract({ left, top, width: side, height: side })
    .resize(AVATAR_PX, AVATAR_PX)
    .jpeg({ quality: 80 })
    .toBuffer();
}

/**
 * What a capture must be to count, by purpose.
 *
 * Enrolment is strict: a sample is what every later capture of this person —
 * and of everybody else — is measured against, and the person is standing at
 * the camera being asked to get it right. The clock is lenient: it refuses
 * only what makes a descriptor unreliable, because the decision's own
 * threshold and margin already refuse an uncertain match, and a refusal at the
 * door sends someone to the fallback.
 *
 * Calibrated on the benchmark's probes (see each constant).
 */
// ── Enrolment ───────────────────────────────────────────────────────────────
//
// Measured on the benchmark's 40 photos of 8 people and 22 strangers. Every
// clean 640×480 frame of the 8 people passes; every dark, small, soft 240×180
// frame ("hard") is refused — 58 of 62 find no face without the clock's retry,
// and the 4 that do are refused for size (eyes 33.7–35.2 px).

/**
 * Eyes at least 45 px apart in the working frame. The size sweep (one photo
 * at nine sizes in a 640×480 frame) put the capture's own noise — distance
 * from the same photo's full-size descriptor — at 0.05 with eyes ~90 px,
 * 0.10 at ~60 and ~45 px (mean; max 0.19 at 45), then 0.16 (max 0.28) at
 * ~38 px, where SSD already misses a third of the faces. Clean frames' eyes
 * are 55–96 px; the 320×240 "degraded" frames' 27–48 px, so a 320×240 camera
 * enrols only from close up. At 1280×720 that is within about a metre.
 */
const ENROL_MIN_EYE_PX = 45;

/**
 * Mean face luma between 45 and 200. Darkening a clean frame raised the
 * capture noise from 0.05 to 0.14 at luma ~86, 0.19 at ~49 and 0.23 at ~38,
 * where the plain detector — all an enrolment gets — already loses 13–17 of
 * 40 faces (23–29 at ~28). Brightening it did worse, faster: 0.14 below 180,
 * 0.20 at 180–200, 0.30 at 200–215 and 0.40 above 225, as the skin clips to
 * white. Clean frames run 55–168 (the 8 people's 85–168).
 *
 * The floor is deliberately low. Mean face luma also follows skin tone, and
 * a dark-skinned face in good light can sit near 60; the floor is set below
 * that so the gate measures the room, not the person.
 */
const ENROL_MIN_BRIGHTNESS = 45;
const ENROL_MAX_BRIGHTNESS = 200;

/**
 * Head turn |yaw| up to 0.35 — roughly 35°. The 8 people's clean photos turn
 * up to 0.28, and across every capture kind their distance to their own other
 * photos does not grow with it (0.38 / 0.41 / 0.39 mean for |yaw| 0–0.1 /
 * 0.1–0.2 / 0.2–0.3), so the "turn
 * slightly left / right" samples the enrolment asks for pass; a stranger's
 * photo at 0.44 (a face half in profile) does not.
 */
const ENROL_MAX_YAW = 0.35;

/**
 * Head tilt up to 20°, and LEVELLED whenever it is 3° or more. Levelling
 * itself held up at every angle measured — the 8 people's 12°-tilted frames
 * (sloping 0.5–30°), levelled, sat 0.12–0.16 on average from the same frame
 * untilted in every 5° band — but a sample is the reference for every later
 * capture, so it is taken upright (the 8 people's photos slope 0.1–16.7°, and
 * every one of them levelled). A tilted sample that could
 * NOT be levelled is the one that did the damage: the unlevelled pipeline's
 * only wrong-account matches were a 26° probe meeting a stranger enrolled at
 * 46°.
 */
const ENROL_MAX_TILT = 20;

/**
 * Detector confidence at least 0.65. Below about 0.7 the capture noise
 * doubled (0.32–0.34 against 0.14–0.23 above it, across every capture kind —
 * few captures, but all of them); the floor sits a little under that because
 * the 8 people's clean photos score from 0.705. Strangers' photos cropped out
 * of group shots, scoring 0.55–0.62, are refused.
 */
const ENROL_MIN_SCORE = 0.65;

// ── The clock ───────────────────────────────────────────────────────────────
//
// Lenient by design, and the measurements say why: no capture in any sweep —
// faces down to 15 px between the eyes, luma down to 6, luma up to 245 —
// produced a wrong-account match or an accepted impostor under the decision's
// threshold and margin. Poor frames fail as "not recognised". The gates below
// refuse only where the descriptor has stopped meaning much (capture noise
// past ~0.3, more than half the 0.55 threshold), so the person is told what to
// fix instead of being told they are not themselves.

/**
 * Eyes at least 18 px apart in the working frame. At 20–24 px the noise is
 * 0.22 and 99% of genuine captures match; at 18–20 it is 0.28 (max 0.43),
 * SSD finds only 26 of 40 faces, and those it finds still match their owner;
 * at 15 px it finds 1 of 40, with noise 0.33. So the floor sits just under the
 * smallest faces that described reliably. The 240×180 "hard" frames
 * (22.5–36 px) and the 320×240 ones (27–48) pass.
 */
const CLOCK_MIN_EYE_PX = 18;

/**
 * Mean face luma between 15 and 240. Below 15 (a frame at a tenth of its
 * exposure, with a webcam's grain) the noise is 0.37 and a third to a half of
 * genuine captures fail anyway — and the benchmark's grain is mild beside a
 * webcam's at full gain in a dark room; above 240 the face is clipped almost
 * to white (noise 0.43). The "hard" frames, 40–89, pass — the contrast retry
 * recovers them.
 */
const CLOCK_MIN_BRIGHTNESS = 15;
const CLOCK_MAX_BRIGHTNESS = 240;

/**
 * Head turn |yaw| up to 0.6 — roughly 50°, where the far eye is behind the
 * nose and 68 landmarks are guesswork. NOT measured: the benchmark's captures
 * turn at most 0.46, and none of them matched the wrong account. This only
 * refuses a face beyond anything the engine was shown.
 */
const CLOCK_MAX_YAW = 0.6;

/**
 * An UNLEVELLED head tilted past 15°. Levelling fails when the turned frame
 * does not give back exactly one face — 14 of 162 tilted captures, 13 of them
 * scoring under 0.8 — and then the plain descriptor stands. The unlevelled
 * pipeline matched none of the 320×240 frames (natural slopes to 18°) to the
 * wrong account, but did match a 26°-tilted probe to a stranger. A levelled
 * capture is accepted at any tilt.
 */
const CLOCK_MAX_UNLEVELLED_TILT = 15;

const MESSAGES = {
  small: 'Come closer to the camera — your face is too small in the picture.',
  dark: 'It is too dark to see your face clearly — face the light, or turn a light on.',
  bright: 'There is too much light on your face — step out of the glare.',
  turned: 'Look straight at the camera.',
  tilted: 'Hold your head upright and look straight at the camera.',
  unclear: 'The camera could not see your face clearly — face it squarely in good light and hold still.',
};

/**
 * Whether a capture is good enough for its purpose: null, or what the person
 * should do differently, in words they can act on at the camera.
 */
export function faceQualityProblem(quality: FaceQuality, purpose: FacePurpose): string | null {
  if (purpose === 'rederive') return null;
  const eyePx = quality.eyeDistance / (quality.frameScale ?? 1);
  const yaw = Math.abs(quality.yaw);
  const tilt = Math.abs(quality.tilt);

  if (purpose === 'enrol') {
    if (eyePx < ENROL_MIN_EYE_PX) return MESSAGES.small;
    if (quality.brightness < ENROL_MIN_BRIGHTNESS) return MESSAGES.dark;
    if (quality.brightness > ENROL_MAX_BRIGHTNESS) return MESSAGES.bright;
    if (yaw > ENROL_MAX_YAW) return MESSAGES.turned;
    if (tilt > ENROL_MAX_TILT || (tilt >= LEVEL_FROM_DEGREES && !quality.levelled)) return MESSAGES.tilted;
    if (quality.score < ENROL_MIN_SCORE) return MESSAGES.unclear;
    return null;
  }

  if (eyePx < CLOCK_MIN_EYE_PX) return MESSAGES.small;
  if (quality.brightness < CLOCK_MIN_BRIGHTNESS) return MESSAGES.dark;
  if (quality.brightness > CLOCK_MAX_BRIGHTNESS) return MESSAGES.bright;
  if (yaw > CLOCK_MAX_YAW) return MESSAGES.turned;
  if (tilt > CLOCK_MAX_UNLEVELLED_TILT && !quality.levelled) return MESSAGES.tilted;
  return null;
}

/** Whether the models are in memory yet — surfaced on the clock screen. */
export function faceEngineReady(): boolean {
  return faceapi !== null;
}

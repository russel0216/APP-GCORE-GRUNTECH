import path from 'node:path';
import sharp from 'sharp';
import { badRequest } from '../http/kit';

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
 */

/** face-api's own types are loaded lazily; the module is ~6MB of WASM. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let faceapi: any = null;
let loading: Promise<void> | null = null;

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
    await api.nets.tinyFaceDetector.loadFromDisk(dir);
    await api.nets.faceLandmark68TinyNet.loadFromDisk(dir);
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

export interface FaceCapture {
  descriptor: number[];
  /** Detector confidence, kept alongside the match distance for review. */
  score: number;
}

/**
 * Extracts exactly one face from an image.
 *
 * Refuses on none and on more than one. Two faces in frame is the obvious way
 * to try to clock in a colleague who is not there, and picking "the biggest
 * one" would make that work.
 */
export async function describeFace(image: Buffer): Promise<FaceCapture> {
  await load();
  if (!faceapi) throw badRequest('Face recognition is not available on this server');

  // Down to a sane size first: a modern phone camera frame is far larger than
  // the detector needs and costs seconds for nothing.
  let raw;
  try {
    raw = await sharp(image)
      .rotate() // honour the EXIF orientation, or a phone portrait arrives sideways
      .resize(480, 640, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw badRequest('That file is not an image the camera produced');
  }

  const tf = faceapi.tf;
  const tensor = tf.tensor3d(new Uint8Array(raw.data), [raw.info.height, raw.info.width, 3]);

  try {
    const found = await faceapi
      .detectAllFaces(tensor, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.4 }))
      .withFaceLandmarks(true)
      .withFaceDescriptors();

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

    return {
      descriptor: Array.from(found[0].descriptor as Float32Array),
      score: Math.round(found[0].detection.score * 10000) / 10000,
    };
  } finally {
    tensor.dispose();
  }
}

/** Whether the models are in memory yet — surfaced on the clock screen. */
export function faceEngineReady(): boolean {
  return faceapi !== null;
}

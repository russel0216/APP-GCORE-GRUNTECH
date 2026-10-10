import sharp, { type OverlayOptions } from 'sharp';

/**
 * Pictures that stand in for a camera at the face clock, for the verify
 * scripts' liveness checks (shared/liveness.ts). sharp only — nothing here
 * loads the face engine.
 *
 * What the landmark net reads, measured on face-api's demo webcam
 * screenshot (2026-10-10, the numbers in shared/liveness.ts):
 * - identical frames read exactly the same (EAR and yaw range 0.000) — a
 *   photo held still, `stillFrames`;
 * - a horizontal SHEAR of the picture, which moves the nose off the eye line
 *   as a turn would, is NOT read as a turn: ±0.18 of shear swings the yaw
 *   figure by 0.02–0.04, because the net regularises the nose onto the face
 *   shapes it knows. `shearFrames` is therefore a NEGATIVE fixture — a flat
 *   picture waggled about — never a passing turn;
 * - foreshortening one half of the face (what a turned head looks like to
 *   the camera) IS read as a turn: `turnFrames` at ±1 swings the yaw by
 *   about 0.18, at ±0.25 by about 0.045;
 * - painting the eyes shut (`eyesShut`) drops the net's EAR by only 8–18% —
 *   it wants a real closed eye — so a painted blink is refused `no_blink`.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The camera's smaller frame of the same view: the still downscaled to `width`, as a JPEG. */
export function frameOf(still: Buffer, width = 480): Promise<Buffer> {
  return sharp(still).resize(width).jpeg({ quality: 80 }).toBuffer();
}

/** The same frame `n` times — a photo held perfectly still. */
export function stillFrames(frame: Buffer, n: number): Buffer[] {
  return Array.from({ length: n }, () => frame);
}

/**
 * The still sheared horizontally by each `k` (sharp's affine [[1, k], [0, 1]])
 * about the face's vertical centre `cy` (in the still's pixels, so the face
 * stays where the still's box says), then downscaled to a frame.
 */
export async function shearFrames(still: Buffer, ks: number[], cy: number, width = 480): Promise<Buffer[]> {
  const meta = await sharp(still).metadata();
  const W = meta.width!;
  const H = meta.height!;
  const out: Buffer[] = [];
  for (const k of ks) {
    const sheared = await sharp(still)
      .affine([[1, k], [0, 1]], { background: { r: 128, g: 128, b: 128 } })
      .toBuffer({ resolveWithObject: true });
    // A point moves by k·y (k ≥ 0) or k·(y − H) (k < 0): undo the face centre's move.
    const shift = k >= 0 ? k * cy : k * (cy - H);
    const left = Math.max(0, Math.min(sheared.info.width - W, Math.round(shift)));
    out.push(await sharp(sheared.data).extract({ left, top: 0, width: W, height: H }).resize(width).jpeg({ quality: 80 }).toBuffer());
  }
  return out;
}

/**
 * The head turned: for each `turn` in −1 … 1 the half of the still on the
 * side the head turns to — left of the nose column `noseX` (in the still's
 * pixels) for a negative turn, right of it for a positive one — is squashed
 * horizontally to 1 − 0.4·|turn| of its width (0.6 at ±1), the other half is
 * kept, and the result is downscaled to a frame. A sweep −1 → 1 → −1 reads
 * as a yaw swing of about 0.18; |turn| ≤ 0.25 as under 0.05.
 */
export async function turnFrames(still: Buffer, noseX: number, turns: number[], width = 480): Promise<Buffer[]> {
  const meta = await sharp(still).metadata();
  const W = meta.width!;
  const H = meta.height!;
  const nx = Math.round(Math.min(Math.max(1, noseX), W - 1));
  const left = await sharp(still).extract({ left: 0, top: 0, width: nx, height: H }).toBuffer();
  const right = await sharp(still).extract({ left: nx, top: 0, width: W - nx, height: H }).toBuffer();
  const out: Buffer[] = [];
  for (const turn of turns) {
    const f = 1 - 0.4 * Math.min(1, Math.abs(turn));
    const lw = turn < 0 ? Math.max(1, Math.round(nx * f)) : nx;
    const rw = turn > 0 ? Math.max(1, Math.round((W - nx) * f)) : W - nx;
    const canvas = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 128, g: 128, b: 128 } } })
      .composite([
        { input: await sharp(left).resize(lw, H, { fit: 'fill' }).toBuffer(), left: nx - lw, top: 0 },
        { input: await sharp(right).resize(rw, H, { fit: 'fill' }).toBuffer(), left: nx, top: 0 },
      ])
      .png()
      .toBuffer();
    // Composited first, then shrunk: sharp resizes BEFORE it composites.
    out.push(await sharp(canvas).resize(width).jpeg({ quality: 80 }).toBuffer());
  }
  return out;
}

/**
 * The eyes painted shut: a patch in the cheek's own colour (sampled under
 * each eye) over each eye's landmark box, in the picture's own pixels —
 * `measureFrame()` in shared/liveness.ts gives a frame's eye boxes.
 */
export async function eyesShut(picture: Buffer, eyes: Box[]): Promise<Buffer> {
  const meta = await sharp(picture).metadata();
  const W = meta.width!;
  const H = meta.height!;
  const patches: OverlayOptions[] = [];
  for (const eye of eyes) {
    const sx = Math.min(W - 4, Math.max(0, Math.round(eye.x + eye.width * 0.25)));
    const sy = Math.min(H - 4, Math.max(0, Math.round(eye.y + eye.height * 2.2)));
    const sample = await sharp(picture)
      .extract({ left: sx, top: sy, width: Math.min(Math.max(4, Math.round(eye.width * 0.5)), W - sx), height: Math.min(Math.max(4, Math.round(eye.height)), H - sy) })
      .stats();
    const [r, g, b] = sample.channels.map((c) => Math.round(c.mean));
    const pad = Math.max(2, Math.round(eye.height * 0.8));
    const left = Math.max(0, Math.round(eye.x - pad * 0.5));
    const top = Math.max(0, Math.round(eye.y - pad));
    const width = Math.max(1, Math.min(W - left, Math.round(eye.width + pad)));
    const height = Math.max(1, Math.min(H - top, Math.round(eye.height + pad * 2)));
    patches.push({
      input: await sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).blur(1).png().toBuffer(),
      left,
      top,
    });
  }
  return sharp(picture).composite(patches).jpeg({ quality: 80 }).toBuffer();
}

/**
 * Which of a burst of camera frames is the sharpest — DOM-free, so the
 * arithmetic can be tested without a browser.
 *
 * The clock takes three frames a moment apart and sends the one with the
 * least motion blur and the best focus. Sharpness is the VARIANCE OF THE
 * LAPLACIAN: the 4-neighbour Laplacian (4·p − up − down − left − right)
 * responds to edges, a blurred frame has soft edges and so a small spread of
 * responses, a sharp one a large spread. It is measured on a small greyscale
 * copy of the frame (`SCORING_WIDTH` wide), and over its CENTRE only, where
 * the oval guide asks for the face — a sharp bookcase behind a blurred face is
 * not a sharp frame.
 *
 * Only comparisons between frames of one burst mean anything: the figure
 * depends on the scene and the light, so it is never a threshold.
 */

/** Width of the greyscale copy a frame is scored on; the height keeps the frame's shape. */
export const SCORING_WIDTH = 200;

/** The share of the frame's width and height, centred, that is scored. */
export const CENTRE_FRACTION = 0.6;

/** The size of the scoring copy for a frame of `width` × `height`. */
export function scoringSize(width: number, height: number, target = SCORING_WIDTH): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const w = Math.min(target, Math.round(width));
  return { width: w, height: Math.max(1, Math.round((height * w) / width)) };
}

/** Rec. 601 luma of RGBA pixels (as `ImageData.data` holds them), one value per pixel. */
export function toGrey(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const n = width * height;
  const grey = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    grey[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }
  return grey;
}

/**
 * Variance of the 4-neighbour Laplacian over the centred `fraction` of a
 * greyscale frame. 0 for a frame too small to have an interior (a flat frame
 * scores 0 too, which is right: there is nothing in focus).
 */
export function laplacianVariance(
  grey: ArrayLike<number>,
  width: number,
  height: number,
  fraction = CENTRE_FRACTION,
): number {
  const f = Math.min(1, Math.max(0, fraction));
  const marginX = Math.floor((width * (1 - f)) / 2);
  const marginY = Math.floor((height * (1 - f)) / 2);
  // The Laplacian needs a neighbour on every side, so the frame's own edge is never a centre.
  const x0 = Math.max(1, marginX);
  const y0 = Math.max(1, marginY);
  const x1 = Math.min(width - 1, width - marginX);
  const y1 = Math.min(height - 1, height - marginY);
  if (x1 <= x0 || y1 <= y0) return 0;

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) {
      const i = row + x;
      const lap = 4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - width] - grey[i + width];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  const mean = sum / count;
  return Math.max(0, sumSq / count - mean * mean);
}

/** A frame's sharpness straight from its RGBA pixels. */
export function frameSharpness(rgba: ArrayLike<number>, width: number, height: number): number {
  return laplacianVariance(toGrey(rgba, width, height), width, height);
}

/** The index of the sharpest score — the first on a tie, -1 for none. NaN never wins. */
export function sharpestIndex(scores: readonly number[]): number {
  let best = -1;
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (!Number.isFinite(s)) continue;
    if (best === -1 || s > scores[best]) best = i;
  }
  return best;
}

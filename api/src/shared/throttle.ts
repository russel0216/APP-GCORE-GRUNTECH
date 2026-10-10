/**
 * A little memory of recent attempts, per key, for the doors a person can
 * knock on too often: the password reset (per address, and a ceiling for
 * everyone — behind the tunnel every request arrives from the same address,
 * so counting per caller would count nobody), and the face clock and its
 * enrolment (per signed-in person — each attempt costs the server a second of
 * the face engine).
 *
 * In memory, so a restart forgets it, and one process counts its own share:
 * enough for a brake, which is all it is.
 */
const recent = new Map<string, number[]>();

/** Records an attempt under `key` and answers whether it is one too many (the attempt is then not counted). */
export function throttled(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  // Keys nobody has used for a window are forgotten, so a flood of made-up
  // ones cannot grow this without bound.
  if (recent.size > 1_000) {
    for (const [k, times] of recent) if (!times.some((t) => now - t < windowMs)) recent.delete(k);
  }
  const hits = (recent.get(key) ?? []).filter((t) => now - t < windowMs);
  const over = hits.length >= limit;
  if (!over) hits.push(now);
  recent.set(key, hits);
  return over;
}

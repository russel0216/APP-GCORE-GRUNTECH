/**
 * The version of the face pipeline in shared/face.ts, stored with every
 * enrolment sample.
 *
 * Two pipelines' descriptors of the SAME photo differ by about 0.1 (up to
 * 0.3) — a third of the match threshold — so a sample is only ever compared
 * with a capture described the same way. Change anything that alters a
 * descriptor (detector, landmark net, working size, levelling, retry) and this
 * string must change too; the boot-time re-derivation then recomputes the
 * stored samples from their photos.
 *
 * A module of its own, importing nothing, so that what only needs to know
 * which samples are current (shared/hr.ts and everything that imports it —
 * the seed, the verify scripts, Insights) never loads the face engine and the
 * native image library behind it.
 */
export const FACE_ENGINE = 'ssd-l68-level-1';

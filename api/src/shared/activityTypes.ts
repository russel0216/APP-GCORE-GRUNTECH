import { prisma } from '../prisma';

/**
 * Activity types as data (2026-10-08, SCORO's customisable activity types).
 *
 * `SalesActivity.type` was a six-value enum; the owner wants the list to be
 * his. The list is now `SalesActivityType` (Admin › Categories), and every
 * activity carries the type's KEY in `typeKey`. The enum column stays for one
 * more deploy as the fallback: the six built-ins are seeded under the enum's
 * own keys, the seed backfills `typeKey` from `type` once, and a custom type
 * is written as OTHER in the enum — so a reader that still looks at `type`
 * sees something true, and `typeKey ?? type` is always the real one.
 */

export const BUILTIN_ACTIVITY_TYPES: { key: string; name: string; color: string; sortOrder: number }[] = [
  { key: 'SITE_VISIT', name: 'Site visit', color: '#2E9A4B', sortOrder: 1 },
  { key: 'MEETING', name: 'Meeting', color: '#5B2A8C', sortOrder: 2 },
  { key: 'CALL', name: 'Call', color: '#1F6FEB', sortOrder: 3 },
  { key: 'FOLLOW_UP', name: 'Follow-up', color: '#D97706', sortOrder: 4 },
  { key: 'SUBMISSION', name: 'Submission', color: '#0E7490', sortOrder: 5 },
  { key: 'OTHER', name: 'Other', color: '#6B7280', sortOrder: 6 },
];

/** The enum's own keys: a custom type is stored as OTHER in the enum column. */
export const ACTIVITY_ENUM_KEYS = ['CALL', 'SITE_VISIT', 'MEETING', 'FOLLOW_UP', 'SUBMISSION', 'OTHER'] as const;
export type ActivityEnumKey = (typeof ACTIVITY_ENUM_KEYS)[number];

export function activityEnumOf(key: string): ActivityEnumKey {
  return (ACTIVITY_ENUM_KEYS as readonly string[]).includes(key) ? (key as ActivityEnumKey) : 'OTHER';
}

/**
 * The key a typed name gets — "Demo walk" → DEMO_WALK — fixed for life, like
 * an industry's code: an activity carries the key, so renaming the type
 * never rewrites one.
 */
export function activityTypeKey(name: string): string {
  const key = name
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, 40);
  return key || 'TYPE';
}

/** Key → name for the types on file, read once per request. */
export async function activityTypeNames(): Promise<Map<string, string>> {
  const rows = await prisma.salesActivityType.findMany({ select: { key: true, name: true } });
  return new Map(rows.map((r) => [r.key, r.name]));
}

/** "DEMO_WALK" → "Demo walk", for a key with no row behind it. */
export function humaniseTypeKey(key: string): string {
  const words = key.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Seeds the six built-ins (idempotent: a renamed or recoloured one is left
 * as the administrator has it) and gives every activity written before the
 * list existed its `typeKey`. Returns what it did, for the seed's log.
 */
export async function seedActivityTypes(): Promise<{ created: number; backfilled: number }> {
  const made = await prisma.salesActivityType.createMany({
    data: BUILTIN_ACTIVITY_TYPES.map((t) => ({ ...t, isSystem: true })),
    skipDuplicates: true,
  });
  // `typeKey` from the enum column, once, where it was never written.
  const backfilled = await prisma.$executeRaw`UPDATE "SalesActivity" SET "typeKey" = "type"::text WHERE "typeKey" IS NULL`;
  return { created: made.count, backfilled };
}

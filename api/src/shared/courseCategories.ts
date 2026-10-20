import { prisma } from '../prisma';
import { ACADEMY_DEFAULTS } from './academy';

/**
 * Course categories (2026-10-20, the owner's G-HR Academy UI): Admin ›
 * Categories › Course categories. The owner's four are seeded as system rows
 * — renamable, undeletable, switched off rather than removed — each with the
 * colour its chip wears on the course list; the five the Academy settings
 * offered before, and every category a course on file already carries, are
 * seeded as ordinary rows so nothing on file loses its name. A course keeps
 * the category's NAME (`Course.category`): the chip's colour is looked up by
 * name, case-blind, through `categoryColors()`.
 */
export const COURSE_CATEGORIES: { name: string; color: string }[] = [
  { name: 'Pneumatics & Gas', color: '#2E9A4B' },
  { name: 'Hydraulics & Flow', color: '#1C7293' },
  { name: 'Electrical & Control', color: '#5B2A8C' },
  { name: 'Compliance & HSE', color: '#B85042' },
];

/** The category's key for a case- and space-blind match. */
export const categoryKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Seeds the list; a row already on file keeps its name, colour and order (an
 * administrator's spelling is never overwritten). Returns how many were added.
 */
export async function seedCourseCategories(): Promise<number> {
  const rows = await prisma.courseCategory.findMany({ select: { id: true, name: true, isSystem: true } });
  const have = new Map(rows.map((r) => [categoryKey(r.name), r]));
  let created = 0;
  for (const [i, c] of COURSE_CATEGORIES.entries()) {
    const existing = have.get(categoryKey(c.name));
    if (existing) {
      if (!existing.isSystem) await prisma.courseCategory.update({ where: { id: existing.id }, data: { isSystem: true } });
      continue;
    }
    const row = await prisma.courseCategory.create({ data: { name: c.name, color: c.color, sortOrder: i, isSystem: true } });
    have.set(categoryKey(row.name), row);
    created++;
  }
  // What the Academy settings offered before, and what courses on file carry.
  const stored = await prisma.setting.findUnique({ where: { key: 'academy.rules' } });
  const settingNames = Array.isArray((stored?.value as { categories?: unknown } | null)?.categories)
    ? ((stored!.value as { categories: unknown[] }).categories.map(String))
    : ACADEMY_DEFAULTS.categories;
  const onFile = await prisma.course.findMany({
    where: { category: { not: null } },
    distinct: ['category'],
    select: { category: true },
  });
  let order = COURSE_CATEGORIES.length;
  for (const name of [...settingNames, ...onFile.map((c) => c.category!)]) {
    const trimmed = name.trim();
    if (!trimmed || have.has(categoryKey(trimmed))) continue;
    const row = await prisma.courseCategory.create({ data: { name: trimmed, sortOrder: order++ } });
    have.set(categoryKey(row.name), row);
    created++;
  }
  return created;
}

/** Every category's colour by key — the course list's chips. */
export async function categoryColors(): Promise<Map<string, { name: string; color: string | null }>> {
  const rows = await prisma.courseCategory.findMany({ select: { name: true, color: true } });
  return new Map(rows.map((r) => [categoryKey(r.name), { name: r.name, color: r.color }]));
}

/** The active categories in order — what the course form offers. */
export async function activeCategoryNames(): Promise<string[]> {
  const rows = await prisma.courseCategory.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { name: true },
  });
  return rows.map((r) => r.name);
}

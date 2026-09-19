import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { badRequest } from '../http/kit';

/**
 * The aftermarket rules more than one route needs.
 *
 * The thing this module exists to make true: **a finished project becomes a
 * renewal pipeline** (model §4.5). That only works if three dates are answered
 * honestly — when a warranty runs out, when a contract runs out, and when the
 * next visit is due — and if a report still renders the way it was signed
 * years later.
 */

type Tx = Prisma.TransactionClient | typeof prisma;

export const dayKey = (at: Date): Date =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

export function addMonths(date: Date, months: number): Date {
  const out = new Date(date);
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  // Clamp: three months after 31 January is 30 April, not 1 May.
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

export const daysBetween = (from: Date, to: Date): number =>
  Math.floor((dayKey(to).getTime() - dayKey(from).getTime()) / 86_400_000);

// ── Settings ─────────────────────────────────────────────────────────────────

export interface AftermarketSettings {
  /** How far ahead a warranty or contract counts as "expiring soon". */
  expiryWarningDays: number;
  /** Default warranty length on a newly registered asset. */
  defaultWarrantyMonths: number;
  /** Default months between PM visits on a new contract. */
  defaultFrequencyMonths: number;
  /** A scheduled visit this many days past due counts as missed. */
  missedAfterDays: number;
}

const DEFAULTS: AftermarketSettings = {
  expiryWarningDays: 90,
  defaultWarrantyMonths: 12,
  defaultFrequencyMonths: 3,
  missedAfterDays: 14,
};

export async function aftermarketSettings(): Promise<AftermarketSettings> {
  const row = await prisma.setting.findUnique({ where: { key: 'aftermarket.rules' } });
  if (!row) return DEFAULTS;
  return { ...DEFAULTS, ...(row.value as Partial<AftermarketSettings>) };
}

export async function saveAftermarketSettings(
  value: Partial<AftermarketSettings>,
): Promise<AftermarketSettings> {
  const merged = { ...(await aftermarketSettings()), ...value };
  await prisma.setting.upsert({
    where: { key: 'aftermarket.rules' },
    create: {
      key: 'aftermarket.rules',
      value: merged as unknown as Prisma.InputJsonValue,
      description: 'Warranty length, PM frequency and how far ahead expiry is flagged',
    },
    update: { value: merged as unknown as Prisma.InputJsonValue },
  });
  return merged;
}

// ── Expiry ───────────────────────────────────────────────────────────────────

export type Expiry = 'NONE' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED';

export interface ExpiryState {
  state: Expiry;
  /** Negative once it has passed. */
  daysRemaining: number | null;
  endsAt: Date | null;
}

/**
 * Where a date stands relative to today.
 *
 * "Expiring" is deliberately a state of its own rather than a filter somebody
 * has to remember to apply: a warranty that lapses next month is the single
 * most useful thing the aftermarket module can put in front of a salesperson,
 * and it is useless the day after.
 */
export function expiryState(endsAt: Date | null, warningDays: number, asOf = new Date()): ExpiryState {
  if (!endsAt) return { state: 'NONE', daysRemaining: null, endsAt: null };
  const daysRemaining = daysBetween(asOf, endsAt);
  return {
    state: daysRemaining < 0 ? 'EXPIRED' : daysRemaining <= warningDays ? 'EXPIRING' : 'ACTIVE',
    daysRemaining,
    endsAt,
  };
}

// ── The PM schedule ──────────────────────────────────────────────────────────

export interface PlannedVisit {
  sequence: number;
  dueDate: Date;
}

/**
 * The visit dates a contract implies.
 *
 * The first visit falls one interval AFTER the contract starts, not on day
 * one: a quarterly contract signed in January is visited in April, because
 * there is nothing to maintain on the day it begins. A visit that would fall
 * after the contract ends is dropped rather than clamped onto the last day —
 * a schedule with two visits a week apart is worse than a schedule with one.
 */
export function planSchedule(startsAt: Date, endsAt: Date, frequencyMonths: number): PlannedVisit[] {
  if (frequencyMonths < 1) throw badRequest('Visits cannot be less than a month apart');
  if (endsAt <= startsAt) throw badRequest('The contract ends before it starts');

  const visits: PlannedVisit[] = [];
  const start = dayKey(startsAt);
  const end = dayKey(endsAt);

  for (let i = 1; i <= 240; i++) {
    const due = addMonths(start, frequencyMonths * i);
    if (due > end) break;
    visits.push({ sequence: i, dueDate: due });
  }
  return visits;
}

/**
 * Writes a contract's schedule, replacing any visits nobody has attended yet.
 *
 * Completed and missed visits are left alone: they are a record of what
 * happened, and regenerating a schedule must not be able to erase a visit that
 * was made.
 */
export async function regenerateSchedule(
  tx: Tx,
  contractId: string,
  numberFor: (tx: Tx) => Promise<string>,
): Promise<{ created: number; kept: number }> {
  const contract = await tx.serviceContract.findUnique({
    where: { id: contractId },
    include: { job: { select: { customerId: true, siteId: true } } },
  });
  if (!contract) throw badRequest('Service contract not found');

  const kept = await tx.serviceVisit.count({
    where: { contractId, status: { in: ['COMPLETED', 'MISSED'] } },
  });
  await tx.serviceVisit.deleteMany({
    where: { contractId, status: { in: ['SCHEDULED', 'CANCELLED'] } },
  });

  const keptVisits = await tx.serviceVisit.findMany({
    where: { contractId },
    select: { sequence: true },
  });
  const taken = new Set(keptVisits.map((v) => v.sequence));

  const planned = planSchedule(contract.startsAt, contract.endsAt, contract.frequencyMonths);
  let created = 0;
  for (const visit of planned) {
    if (taken.has(visit.sequence)) continue;
    await tx.serviceVisit.create({
      data: {
        number: await numberFor(tx),
        kind: 'PREVENTIVE_MAINTENANCE',
        contractId,
        customerId: contract.job.customerId,
        siteId: contract.job.siteId,
        sequence: visit.sequence,
        dueDate: visit.dueDate,
      },
    });
    created++;
  }

  await tx.serviceContract.update({
    where: { id: contractId },
    data: { plannedVisits: planned.length },
  });

  return { created, kept };
}

// ── Templates ────────────────────────────────────────────────────────────────

export interface TemplateField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'pass_fail' | 'date' | 'note';
  options?: string[];
  unit?: string;
  required?: boolean;
}

export interface TemplateSection {
  key: string;
  title: string;
  help?: string;
  allowPhotos?: boolean;
  fields: TemplateField[];
}

const FIELD_TYPES = new Set(['text', 'number', 'boolean', 'select', 'pass_fail', 'date', 'note']);

/** Rejects a template shape a report screen could not render. */
export function validateSections(value: unknown): TemplateSection[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('A template needs at least one section');
  }
  const sectionKeys = new Set<string>();

  return value.map((raw, i) => {
    const section = raw as Partial<TemplateSection>;
    if (!section.key || !section.title) {
      throw badRequest(`Section ${i + 1} needs a key and a title`);
    }
    if (sectionKeys.has(section.key)) {
      throw badRequest(`Two sections share the key "${section.key}"`);
    }
    sectionKeys.add(section.key);

    if (!Array.isArray(section.fields) || section.fields.length === 0) {
      throw badRequest(`Section "${section.title}" has no fields`);
    }
    const fieldKeys = new Set<string>();
    const fields = section.fields.map((f) => {
      if (!f.key || !f.label) throw badRequest(`A field in "${section.title}" needs a key and a label`);
      if (fieldKeys.has(f.key)) {
        throw badRequest(`Two fields in "${section.title}" share the key "${f.key}"`);
      }
      fieldKeys.add(f.key);
      if (!FIELD_TYPES.has(f.type)) {
        throw badRequest(`"${f.label}" has an unknown field type "${f.type}"`);
      }
      if (f.type === 'select' && (!Array.isArray(f.options) || f.options.length === 0)) {
        throw badRequest(`"${f.label}" is a select with no options`);
      }
      return f;
    });

    return {
      key: section.key,
      title: section.title,
      help: section.help,
      allowPhotos: section.allowPhotos ?? false,
      fields,
    };
  });
}

/**
 * Checks a filled form against the template it was filled on.
 *
 * Only required fields are enforced, and only on submission — a half-filled
 * draft is how a report gets written on site with bad signal.
 */
export function missingRequired(sections: TemplateSection[], data: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const section of sections) {
    const filled = (data[section.key] ?? {}) as Record<string, unknown>;
    for (const field of section.fields) {
      if (!field.required) continue;
      const value = filled[field.key];
      if (value === undefined || value === null || value === '') {
        missing.push(`${section.title} — ${field.label}`);
      }
    }
  }
  return missing;
}

/**
 * The version of a template new reports should be written on.
 *
 * A template that has been used is never edited in place; editing publishes a
 * new version under the same key. That is what lets a report from two years
 * ago still render exactly as it was signed.
 */
export async function currentTemplate(kind: string, key?: string, tx: Tx = prisma) {
  return tx.reportTemplate.findFirst({
    where: {
      kind: kind as never,
      isCurrent: true,
      isActive: true,
      ...(key ? { key } : {}),
    },
    orderBy: { version: 'desc' },
  });
}

// ── Renewal ──────────────────────────────────────────────────────────────────

export interface RenewalCandidate {
  kind: 'CONTRACT' | 'WARRANTY';
  id: string;
  reference: string;
  customerId: string;
  customerName: string;
  siteName: string | null;
  subject: string;
  endsAt: Date;
  daysRemaining: number;
  /** Contract value, where there is one to renew. */
  value: number | null;
}

/**
 * What is about to run out, and is therefore worth a phone call.
 *
 * Two sources, deliberately together: a contract coming up for renewal, and a
 * warranty about to lapse on equipment with no contract at all. The second is
 * the harder one to see and usually the larger opportunity — the customer is
 * about to start paying for repairs they currently get free, and nobody has
 * offered them the alternative.
 */
export async function renewalPipeline(withinDays: number): Promise<RenewalCandidate[]> {
  const today = dayKey(new Date());
  const horizon = new Date(today);
  horizon.setUTCDate(horizon.getUTCDate() + withinDays);

  const [contracts, assets] = await Promise.all([
    prisma.serviceContract.findMany({
      where: { status: 'ACTIVE', endsAt: { lte: horizon }, renewedTo: null },
      include: {
        job: {
          select: {
            name: true,
            contractValue: true,
            customer: { select: { id: true, name: true } },
            site: { select: { name: true } },
          },
        },
      },
      orderBy: { endsAt: 'asc' },
    }),
    prisma.installedAsset.findMany({
      where: {
        status: 'ACTIVE',
        warrantyEndsAt: { not: null, lte: horizon },
        contracts: { none: { contract: { status: 'ACTIVE' } } },
      },
      include: {
        customer: { select: { id: true, name: true } },
        site: { select: { name: true } },
      },
      orderBy: { warrantyEndsAt: 'asc' },
    }),
  ]);

  const out: RenewalCandidate[] = contracts.map((c) => ({
    kind: 'CONTRACT' as const,
    id: c.id,
    reference: c.number,
    customerId: c.job.customer.id,
    customerName: c.job.customer.name,
    siteName: c.job.site?.name ?? null,
    subject: c.job.name,
    endsAt: c.endsAt,
    daysRemaining: daysBetween(today, c.endsAt),
    value: Number(c.job.contractValue),
  }));

  for (const a of assets) {
    out.push({
      kind: 'WARRANTY',
      id: a.id,
      reference: a.code,
      customerId: a.customer.id,
      customerName: a.customer.name,
      siteName: a.site?.name ?? null,
      subject: `${a.name}${a.serialNo ? ` (${a.serialNo})` : ''}`,
      endsAt: a.warrantyEndsAt!,
      daysRemaining: daysBetween(today, a.warrantyEndsAt!),
      value: null,
    });
  }

  return out.sort((a, b) => a.daysRemaining - b.daysRemaining);
}

/**
 * Moves contracts and visits that have quietly passed their date.
 *
 * Called when the aftermarket screens load rather than on a timer: G-Core has
 * no scheduler, and a status that is only correct when a cron job ran is worse
 * than one derived on read.
 */
export async function sweepOverdue(): Promise<{ expired: number; missed: number }> {
  const settings = await aftermarketSettings();
  const today = dayKey(new Date());
  const missedCutoff = new Date(today);
  missedCutoff.setUTCDate(missedCutoff.getUTCDate() - settings.missedAfterDays);

  const [expired, missed] = await Promise.all([
    prisma.serviceContract.updateMany({
      where: { status: 'ACTIVE', endsAt: { lt: today } },
      data: { status: 'EXPIRED' },
    }),
    prisma.serviceVisit.updateMany({
      where: { status: 'SCHEDULED', dueDate: { lt: missedCutoff } },
      data: { status: 'MISSED' },
    }),
  ]);

  return { expired: expired.count, missed: missed.count };
}

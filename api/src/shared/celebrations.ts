import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { manilaDayKey } from './day';
import { hrSettings, type GreetingSettings } from './hr';
import { mailConfig, sendMail } from './mail';
import { notify } from './notifications';

/**
 * Birthdays and work anniversaries (2026-10-08, the owner's call): derived
 * on read from each active employee's birth date and hire date — no table
 * keeps them, so a corrected date is right everywhere at once — and shown on
 * the sales calendar's People layer and in My Work's Today with the age or
 * the years of tenure.
 *
 * The greetings are the one thing here that writes: once per person per
 * year, on the Manila day, from the hour HR sets, claimed with a `Greeting`
 * row before anyone is told so two ticks (or two API processes) never greet
 * twice. The API's minute timer runs `sendDueGreetings` (shared/activities.ts).
 */

export type CelebrationKind = 'BIRTHDAY' | 'ANNIVERSARY';

export interface Celebration {
  kind: CelebrationKind;
  employeeId: string;
  employeeNo: string;
  name: string;
  firstName: string;
  /** 'YYYY-MM-DD' — the day it falls on in the window's year. */
  day: string;
  /** The age, or the years with the company. */
  years: number;
  /** The celebrant's login, when they have one. */
  userId: string | null;
}

const key = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The day an annual date falls on in `year`. A 29 February keeps to 28
 * February in a common year, rather than slipping into March.
 */
export function annualDayIn(annual: Date, year: number): string {
  const m = annual.getUTCMonth();
  const d = annual.getUTCDate();
  const probe = new Date(Date.UTC(year, m, d));
  return key(probe.getUTCMonth() === m ? probe : new Date(Date.UTC(year, m, d - 1)));
}

/**
 * Every occurrence of an annual date within the days `from`..`to`, with the
 * years since it. The date itself (0 years) is not an occasion: a person
 * hired this morning has no anniversary today.
 */
export function occurrencesBetween(annual: Date, from: string, to: string): { day: string; years: number }[] {
  const out: { day: string; years: number }[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    const day = annualDayIn(annual, y);
    const years = y - annual.getUTCFullYear();
    if (years >= 1 && day >= from && day <= to) out.push({ day, years });
  }
  return out;
}

/** The celebrations of the active employees within the days `from`..`to`, in day order. */
export async function celebrationsBetween(from: string, to: string, where: Prisma.EmployeeWhereInput = {}): Promise<Celebration[]> {
  const people = await prisma.employee.findMany({
    where: { isActive: true, OR: [{ birthDate: { not: null } }, { dateHired: { not: null } }], ...where },
    select: { id: true, employeeNo: true, firstName: true, lastName: true, birthDate: true, dateHired: true, userId: true },
  });
  const out: Celebration[] = [];
  for (const p of people) {
    const base = { employeeId: p.id, employeeNo: p.employeeNo, name: `${p.firstName} ${p.lastName}`.trim(), firstName: p.firstName, userId: p.userId };
    if (p.birthDate) for (const o of occurrencesBetween(p.birthDate, from, to)) out.push({ kind: 'BIRTHDAY', ...base, ...o });
    if (p.dateHired) for (const o of occurrencesBetween(p.dateHired, from, to)) out.push({ kind: 'ANNIVERSARY', ...base, ...o });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}

/** "5 years" / "1 year". */
export const yearsText = (n: number) => `${n} year${n === 1 ? '' : 's'}`;

/** A greeting template filled in: {first}, {name}, {company}, {years}, {n}. */
export function fillGreeting(template: string, c: { name: string; firstName: string; years: number }, company: string): string {
  return template
    .replace(/\{first\}/g, c.firstName)
    .replace(/\{name\}/g, c.name)
    .replace(/\{company\}/g, company)
    .replace(/\{years\}/g, yearsText(c.years))
    .replace(/\{n\}/g, String(c.years));
}

const manilaHour = (d: Date) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', hour12: false }).format(d)) % 24;

/**
 * Sends today's greetings (Manila's today) that have not gone yet, once the
 * configured hour has come. Each is CLAIMED with a `Greeting` row — unique on
 * employee, kind and year — before anyone is told, so a second tick or a
 * second process loses the race and sends nothing. Returns how many went.
 */
export async function sendDueGreetings(now = new Date()): Promise<number> {
  const settings: GreetingSettings = (await hrSettings()).greetings;
  if (!settings.enabled || manilaHour(now) < settings.hour) return 0;
  const today = manilaDayKey(now);
  const year = Number(today.slice(0, 4));
  const due = await celebrationsBetween(today, today);
  if (!due.length) return 0;

  const company = (await prisma.company.findUnique({ where: { id: 'company' }, select: { name: true } }))?.name || 'Gruntech';
  const everyone = settings.tellEveryone ? await prisma.user.findMany({ where: { isActive: true }, select: { id: true } }) : [];
  const cfg = mailConfig();
  let sent = 0;

  for (const c of due) {
    try {
      await prisma.greeting.create({ data: { employeeId: c.employeeId, kind: c.kind, year } });
    } catch (err) {
      // Already greeted this year — by this tick's twin, or last minute.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
    sent++;
    const birthday = c.kind === 'BIRTHDAY';
    const title = fillGreeting(birthday ? settings.birthdayTitle : settings.anniversaryTitle, c, company);
    const body = fillGreeting(birthday ? settings.birthdayMessage : settings.anniversaryMessage, c, company);

    // The celebrant: a bell, and an email where email is set up.
    const celebrant = c.userId ? await prisma.user.findUnique({ where: { id: c.userId }, select: { id: true, name: true, email: true, isActive: true } }) : null;
    if (celebrant?.isActive) {
      await notify({ userId: celebrant.id, type: 'greeting', title, body, link: '/my-work' });
      if (cfg) {
        try {
          await sendMail({ to: celebrant.email, toName: celebrant.name, subject: title, text: `${title}\n\n${body}\n` }, cfg);
        } catch (err) {
          console.error(`Greeting email to ${celebrant.email} failed:`, err instanceof Error ? err.message : err);
        }
      }
    }
    // Everyone else: the one-line bell, so the office knows.
    const others = everyone.filter((u) => u.id !== celebrant?.id);
    if (others.length) {
      const line = fillGreeting(birthday ? settings.everyoneBirthday : settings.everyoneAnniversary, c, company);
      await notify(others.map((u) => ({ userId: u.id, type: 'greeting' as const, title: line, link: '/my-work' })));
    }
  }
  return sent;
}

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { AccountTokenPurpose, Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { env } from '../env';
import { conflict } from '../http/kit';
import { mailConfig, sendMail } from './mail';

/**
 * Accounts: creating a login, and the one-time links that let a person choose
 * its password — an invitation (a new account) or a reset (a forgotten one).
 *
 * A link is 32 random bytes; the database keeps only its SHA-256, so the link
 * in the email (or the one an administrator copies) is the only copy of the
 * secret. The token rides in the URL's #fragment, which a browser never sends
 * to a server — so it is in no access log and no Referer header — and the page
 * hands it to the API in a POST body.
 *
 * A link is used once (a conditional update claims it), runs out, and is
 * superseded by the next link of its kind for the same person.
 */

/** An invitation waits a week: it goes to somebody who has not started yet. */
export const INVITE_DAYS = 7;
/** A reset asked for from the sign-in page is live for an hour… */
export const RESET_MINUTES = 60;
/** …one an administrator issues for a day, because it may travel by chat app. */
export const ADMIN_RESET_HOURS = 24;

export const hashToken = (raw: string) => crypto.createHash('sha256').update(raw, 'utf8').digest('hex');

/** A password nobody knows: the account cannot be signed into until its link is used. */
export const unusablePasswordHash = () => bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 10);

export async function issueToken(
  tx: Prisma.TransactionClient,
  userId: string,
  purpose: AccountTokenPurpose,
  opts: { createdById?: string | null; lifetimeMs?: number } = {},
): Promise<{ raw: string; expiresAt: Date }> {
  const now = new Date();
  // Only the newest link of a kind works: resending an invitation kills the old one.
  await tx.accountToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: now } });
  const raw = crypto.randomBytes(32).toString('base64url');
  const lifetime =
    opts.lifetimeMs ?? (purpose === 'INVITE' ? INVITE_DAYS * 86_400_000 : RESET_MINUTES * 60_000);
  const expiresAt = new Date(now.getTime() + lifetime);
  await tx.accountToken.create({
    data: { userId, purpose, tokenHash: hashToken(raw), expiresAt, createdById: opts.createdById ?? null },
  });
  return { raw, expiresAt };
}

/** The link as the person receives it. The token is in the #fragment — see the top of this file. */
export function linkFor(purpose: AccountTokenPurpose, raw: string): string {
  const path = purpose === 'INVITE' ? '/welcome' : '/reset-password';
  return `${env.appUrl.replace(/\/+$/, '')}${path}#token=${raw}`;
}

/** A link that still works, with its person — or null: unknown, used, run out, or the account switched off. */
export async function liveToken(raw: unknown) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) return null;
  const row = await prisma.accountToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          isActive: true,
          invitePending: true,
          employee: {
            select: {
              id: true,
              mobile: true,
              address: true,
              birthDate: true,
              emergencyContactName: true,
              emergencyContactPhone: true,
            },
          },
        },
      },
    },
  });
  if (!row || row.usedAt || row.expiresAt <= new Date() || !row.user.isActive) return null;
  return row;
}

/**
 * Uses a link. The conditional update is the lock: of two submits racing with
 * the same link, one claims it and the other is told it has been used.
 */
export async function consumeToken(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  const claimed = await tx.accountToken.updateMany({
    where: { id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  return claimed.count === 1;
}

// ── Creating a login ─────────────────────────────────────────────────────────

export interface NewLogin {
  email: string;
  name: string;
  roleIds?: string[];
  supervisorId?: string | null;
  departmentId?: string | null;
  position?: string | null;
  phone?: string | null;
  employeeNo?: string | null;
  isActive?: boolean;
  /** A password chosen now. Without one the account is invited, and its person chooses. */
  password?: string | null;
}

export const LOGIN_SELECT = {
  id: true,
  email: true,
  name: true,
  employeeNo: true,
  position: true,
  phone: true,
  isActive: true,
  isSuperAdmin: true,
  invitePending: true,
  supervisorId: true,
  departmentId: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

/**
 * The one way a login is made — from Admin › Users and from an employee
 * record alike — so both give the same account, checked the same way.
 */
export async function createLogin(tx: Prisma.TransactionClient, input: NewLogin, actorId: string) {
  const email = input.email.trim().toLowerCase();
  if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
    throw conflict('Someone already uses that email address');
  }
  const invited = !input.password;
  const user = await tx.user.create({
    data: {
      email,
      name: input.name.trim(),
      passwordHash: invited ? await unusablePasswordHash() : await bcrypt.hash(input.password!, 10),
      invitePending: invited,
      employeeNo: input.employeeNo || null,
      position: input.position || null,
      phone: input.phone || null,
      supervisorId: input.supervisorId || null,
      departmentId: input.departmentId || null,
      isActive: input.isActive ?? true,
      roles: { create: (input.roleIds ?? []).map((roleId) => ({ roleId })) },
    },
    select: LOGIN_SELECT,
  });
  const invite = invited ? await issueToken(tx, user.id, 'INVITE', { createdById: actorId }) : null;
  return { user, invite };
}

/** The seeded self-service role a new login from an employee record starts with. */
export async function defaultRoleIds(tx: Prisma.TransactionClient): Promise<string[]> {
  const role = await tx.role.findUnique({ where: { key: 'employee' }, select: { id: true } });
  return role ? [role.id] : [];
}

// ── Delivering a link ────────────────────────────────────────────────────────

export interface Delivery {
  /** Handed ONLY to the administrator who issued it — never to whoever asked for a reset. */
  link: string;
  emailed: boolean;
  expiresAt: string;
  /** Why the email did not go, when email is set up and it failed. */
  error?: string;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** "Oct 5, 2026, 9:13 AM" in Manila — how the email says when a link runs out. */
function manilaStamp(d: Date): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

/** The two emails G-CORE sends, as plain text and a simple HTML twin. */
export function linkEmail(
  purpose: AccountTokenPurpose,
  p: { name: string; email: string; link: string; expiresAt: Date; org: string; inviter?: string | null },
) {
  const first = p.name.trim().split(/\s+/)[0] || p.name;
  const until = manilaStamp(p.expiresAt);
  const invite = purpose === 'INVITE';
  const subject = invite ? `Your G-CORE account at ${p.org}` : 'Reset your G-CORE password';
  const lead = invite
    ? `${p.inviter ? `${p.inviter} has` : 'We have'} set up your G-CORE account at ${p.org}.`
    : `Someone asked to reset the password of your G-CORE account at ${p.org}. If that was you, choose a new one with the link below.`;
  const action = invite ? 'Choose your password and add your photo' : 'Choose a new password';
  const after = invite
    ? `The link works until ${until} (Manila time) and can be used once. If you were not expecting this, you can ignore this email.`
    : `The link works until ${until} (Manila time) and can be used once. If you did not ask for it, ignore this email — your password has not changed.`;

  const text = [
    `Hi ${first},`,
    '',
    lead,
    '',
    `Your sign-in email: ${p.email}`,
    '',
    `${action}:`,
    p.link,
    '',
    after,
    '',
    `— G-CORE, ${p.org}`,
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f6f5;font-family:Arial,Helvetica,sans-serif;color:#16202e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #d9e0dc">
<tr><td style="padding:24px 28px">
<p style="margin:0 0 4px;font-size:18px;font-weight:bold;letter-spacing:2px;color:#0f7a3e">G-CORE</p>
<p style="margin:0 0 20px;font-size:12px;color:#53637a">${escapeHtml(p.org)}</p>
<p style="margin:0 0 12px">Hi ${escapeHtml(first)},</p>
<p style="margin:0 0 12px">${escapeHtml(lead)}</p>
<p style="margin:0 0 20px">Your sign-in email: <strong>${escapeHtml(p.email)}</strong></p>
<p style="margin:0 0 20px"><a href="${escapeHtml(p.link)}" style="display:inline-block;padding:12px 20px;background:#9b1fb0;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">${escapeHtml(action)}</a></p>
<p style="margin:0 0 12px;font-size:13px;color:#53637a">If the button does not work, copy this link into your browser:<br><span style="word-break:break-all">${escapeHtml(p.link)}</span></p>
<p style="margin:0;font-size:13px;color:#53637a">${escapeHtml(after)}</p>
</td></tr></table></body></html>`;

  return { subject, text, html };
}

/**
 * Sends a link by email when email is set up, and always returns the link so
 * the administrator who issued it can pass it on another way. An email that
 * fails does not undo the account: the link still works, and the reason is
 * returned for the screen to show.
 */
export async function deliverLink(
  purpose: AccountTokenPurpose,
  person: { name: string; email: string },
  issued: { raw: string; expiresAt: Date },
  inviter?: string | null,
): Promise<Delivery> {
  const link = linkFor(purpose, issued.raw);
  const base = { link, expiresAt: issued.expiresAt.toISOString() };
  const cfg = mailConfig();
  if (!cfg) return { ...base, emailed: false };
  const company = await prisma.company.findUnique({ where: { id: 'company' }, select: { name: true } });
  const message = linkEmail(purpose, {
    name: person.name,
    email: person.email,
    link,
    expiresAt: issued.expiresAt,
    org: company?.name ?? 'G-CORE',
    inviter,
  });
  try {
    await sendMail({ to: person.email, toName: person.name, ...message }, cfg);
    return { ...base, emailed: true };
  } catch (err) {
    return { ...base, emailed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

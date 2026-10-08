import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { handler, parseBody, unauthorized, badRequest, HttpError } from '../http/kit';
import { authenticate, currentUser, signToken } from '../auth/middleware';
import { menuFor } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { unreadCount } from '../shared/notifications';
import { upload, saveAttachment, deleteAttachment } from '../shared/attachments';
import { consumeToken, deliverLink, issueToken, liveToken } from '../shared/accounts';
import { mailEnabled } from '../shared/mail';
import { currentAppearance } from './appearance';
import { teamOf } from '../shared/team';

export const authRoutes = Router();

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

authRoutes.post(
  '/login',
  handler(async (req, res) => {
    const { email, password } = parseBody(loginSchema, req.body);

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Same message either way — never reveal which half was wrong.
    const invalid = unauthorized('Email or password is incorrect');
    if (!user || !user.isActive) throw invalid;
    if (!(await bcrypt.compare(password, user.passwordHash))) throw invalid;

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await audit(
      { entityType: 'user', entityId: user.id, action: 'SIGNED_IN', actorId: user.id, actorName: user.name },
      req,
    );

    res.json({ token: signToken(user.id, user.email) });
  }),
);

authRoutes.get(
  '/me',
  authenticate,
  handler(async (req, res) => {
    const user = currentUser(req);
    const [company, row, appearance, team] = await Promise.all([
      prisma.company.findUnique({ where: { id: 'company' } }),
      prisma.user.findUnique({ where: { id: user.id }, select: { photoPath: true, phone: true } }),
      // Rides along rather than taking a request of its own: every browser
      // needs it to draw the page, and this is already the call that says
      // what to draw.
      currentAppearance(),
      // The viewer's team, for the lists' Mine · Team · All switch.
      teamOf(user.id),
    ]);
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        position: user.position,
        isSuperAdmin: user.isSuperAdmin,
        roles: user.roleKeys,
        photoPath: row?.photoPath ?? null,
        phone: row?.phone ?? null,
        team,
      },
      permissions: [...user.permissions],
      menu: menuFor(user),
      company: company && {
        name: company.name,
        logoPath: company.logoPath,
        currency: company.currency,
        numberPrefix: company.numberPrefix,
      },
      unread: await unreadCount(user.id),
      appearance,
    });
  }),
);

/**
 * The account picture.
 *
 * A plain upload — cosmetic only, and available to everyone whether or not
 * they have a linked employee record. It never touches face recognition:
 * `describeFace` is only ever called from `/clock/enroll`, so nothing here can
 * become a match candidate. Enrolling your face there overwrites this with
 * that verified capture (see the note in hr.ts) — this endpoint exists for the
 * people that flow can't reach, and for anyone who would rather just pick a
 * picture.
 */
authRoutes.post(
  '/photo',
  authenticate,
  upload.single('photo'),
  handler(async (req, res) => {
    const me = currentUser(req);
    if (!req.file) throw badRequest('Choose an image file');
    if (!req.file.mimetype.startsWith('image/')) throw badRequest('The photo must be an image');

    const attachment = await saveAttachment({
      entityType: 'user',
      entityId: me.id,
      file: req.file,
      uploadedById: me.id,
      caption: 'Account photo',
    });

    const previous = await prisma.user.findUnique({ where: { id: me.id }, select: { photoPath: true } });
    await prisma.user.update({ where: { id: me.id }, data: { photoPath: attachment.id } });
    if (previous?.photoPath) await deleteAttachment(previous.photoPath).catch(() => {});

    await audit(
      { entityType: 'user', entityId: me.id, action: 'UPDATED', summary: 'Updated account photo' },
      req,
    );
    res.status(201).json({ photoPath: attachment.id });
  }),
);

authRoutes.delete(
  '/photo',
  authenticate,
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await prisma.user.findUnique({ where: { id: me.id }, select: { photoPath: true } });
    if (row?.photoPath) await deleteAttachment(row.photoPath).catch(() => {});
    await prisma.user.update({ where: { id: me.id }, data: { photoPath: null } });
    await audit(
      { entityType: 'user', entityId: me.id, action: 'UPDATED', summary: 'Removed account photo' },
      req,
    );
    res.json({ ok: true });
  }),
);

/**
 * Your own contact details.
 *
 * Only the phone, deliberately. It is the one detail a person knows better
 * than an administrator does, and it prints under "Sincerely Yours," on every
 * quotation they author — so a salesperson whose number changed should not
 * have to raise a ticket to stop customers ringing the old one. Name,
 * position, email and reporting line stay with Admin > Users: position prints
 * beside a sign-off, and the reporting line routes approvals.
 */
/**
 * A person's own contact details on their employee record — the ones they
 * know better than HR does, and that the invitation asks for: mobile,
 * address, birthday and who to call in an emergency. Never the employment
 * fields, the position, the pay or the statutory numbers, which stay HR's.
 */
const personalSchema = z.object({
  mobile: z.string().trim().max(40).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  birthDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD')
    .optional()
    .nullable()
    .or(z.literal('')),
  emergencyContactName: z.string().trim().max(120).optional().nullable(),
  emergencyContactPhone: z.string().trim().max(40).optional().nullable(),
});

type Personal = z.infer<typeof personalSchema>;

function personalData(p: Personal): Prisma.EmployeeUpdateInput {
  const data: Prisma.EmployeeUpdateInput = {};
  if (p.mobile !== undefined) data.mobile = p.mobile || null;
  if (p.address !== undefined) data.address = p.address || null;
  if (p.birthDate !== undefined) data.birthDate = p.birthDate ? new Date(p.birthDate) : null;
  if (p.emergencyContactName !== undefined) data.emergencyContactName = p.emergencyContactName || null;
  if (p.emergencyContactPhone !== undefined) data.emergencyContactPhone = p.emergencyContactPhone || null;
  return data;
}

const PERSONAL_SELECT = {
  mobile: true,
  address: true,
  birthDate: true,
  emergencyContactName: true,
  emergencyContactPhone: true,
} as const;

/** A @db.Date as the 'YYYY-MM-DD' a date input takes. */
const dayOf = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

function presentPersonal<T extends { birthDate: Date | null }>(e: T) {
  return { ...e, birthDate: dayOf(e.birthDate) };
}

/**
 * What HR keeps about a person's job — their team (an Industry row), position
 * and employee number — for the invitation and My Account to SHOW. Never
 * written from here: the employee number is the {EMP} in every quotation
 * number they raise, and the position has one writer (shared/plantilla.ts).
 * The employee record wins over the login's own copy.
 */
const FACTS_SELECT = {
  position: true,
  employeeNo: true,
  employee: { select: { employeeNo: true, position: true, industry: { select: { name: true } } } },
} as const;

function hrFacts(u: {
  position: string | null;
  employeeNo: string | null;
  employee: { employeeNo: string; position: string | null; industry: { name: string } | null } | null;
}) {
  return {
    team: u.employee?.industry?.name ?? null,
    position: u.employee?.position || u.position || null,
    employeeNo: u.employee?.employeeNo || u.employeeNo || null,
  };
}

const profileSchema = z.object({
  phone: z.string().trim().max(40).optional().nullable(),
  personal: personalSchema.optional(),
});

authRoutes.get(
  '/profile',
  authenticate,
  handler(async (req, res) => {
    const me = currentUser(req);
    const [row, facts] = await Promise.all([
      prisma.user.findUnique({
        where: { id: me.id },
        select: { name: true, email: true, position: true, phone: true, employee: { select: PERSONAL_SELECT } },
      }),
      prisma.user.findUnique({ where: { id: me.id }, select: FACTS_SELECT }),
    ]);
    if (!row || !facts) throw unauthorized();
    const { employee, ...rest } = row;
    res.json({ ...rest, personal: employee ? presentPersonal(employee) : null, facts: hrFacts(facts) });
  }),
);

authRoutes.patch(
  '/profile',
  authenticate,
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(profileSchema, req.body);
    const before = await prisma.user.findUnique({
      where: { id: me.id },
      select: { phone: true, employee: { select: { id: true, ...PERSONAL_SELECT } } },
    });
    if (!before) throw unauthorized();
    if (body.personal && !before.employee) {
      throw badRequest('Your account has no employee record to keep personal details on — HR can link one');
    }
    const row = await prisma.$transaction(async (tx) => {
      if (body.personal && before.employee) {
        await tx.employee.update({ where: { id: before.employee.id }, data: personalData(body.personal) });
      }
      return tx.user.update({
        where: { id: me.id },
        data: body.phone !== undefined ? { phone: body.phone || null } : {},
        select: { name: true, email: true, position: true, phone: true, employee: { select: PERSONAL_SELECT } },
      });
    });
    const { employee, ...rest } = row;
    const was = before.employee;
    const facts = await prisma.user.findUnique({ where: { id: me.id }, select: FACTS_SELECT });
    await audit(
      {
        entityType: 'user',
        entityId: me.id,
        action: 'UPDATED',
        summary: body.personal ? 'Updated own contact and personal details' : 'Updated own contact details',
        before: {
          phone: before.phone,
          ...(was
            ? presentPersonal({
                mobile: was.mobile,
                address: was.address,
                birthDate: was.birthDate,
                emergencyContactName: was.emergencyContactName,
                emergencyContactPhone: was.emergencyContactPhone,
              })
            : {}),
        },
        after: { phone: rest.phone, ...(employee ? presentPersonal(employee) : {}) },
      },
      req,
    );
    res.json({ ...rest, personal: employee ? presentPersonal(employee) : null, facts: facts ? hrFacts(facts) : null });
  }),
);

const newPassword = z.string().min(8, 'Use at least 8 characters').max(128, 'Use at most 128 characters');

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword,
});

authRoutes.post(
  '/change-password',
  authenticate,
  handler(async (req, res) => {
    const me = currentUser(req);
    const { currentPassword, newPassword } = parseBody(changePasswordSchema, req.body);

    const row = await prisma.user.findUnique({ where: { id: me.id } });
    if (!row || !(await bcrypt.compare(currentPassword, row.passwordHash))) {
      throw badRequest('Your current password is incorrect');
    }

    await prisma.user.update({
      where: { id: me.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10) },
    });
    await audit(
      { entityType: 'user', entityId: me.id, action: 'UPDATED', summary: 'Changed own password' },
      req,
    );

    res.json({ ok: true });
  }),
);

// ════════════════════════════════════════════════════════════════════
//  Signing in without a password yet: invitations and resets
// ════════════════════════════════════════════════════════════════════

/** What the sign-in page needs to know before anyone is signed in. */
authRoutes.get('/options', (_req, res) => {
  res.json({ mail: mailEnabled() });
});

/**
 * A little memory of recent reset requests, so the sign-in page cannot be
 * used to flood somebody's inbox: per address, and a ceiling for everyone.
 * Behind the tunnel every request arrives from the same address, so counting
 * per caller would count nobody.
 */
const recent = new Map<string, number[]>();
function throttled(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  // Addresses nobody has asked about for a window are forgotten, so a flood of
  // made-up emails cannot grow this without bound.
  if (recent.size > 1_000) {
    for (const [k, times] of recent) if (!times.some((t) => now - t < windowMs)) recent.delete(k);
  }
  const hits = (recent.get(key) ?? []).filter((t) => now - t < windowMs);
  const over = hits.length >= limit;
  if (!over) hits.push(now);
  recent.set(key, hits);
  return over;
}

const linkGone = () =>
  new HttpError(410, 'This link has expired or has already been used — ask for a new one');

const forgotSchema = z.object({ email: z.string().trim().email('Enter a valid email address') });

/**
 * "Forgot password?". The answer is the same whether or not the address has
 * an account — telling them apart would let anyone test which emails work
 * here — and the email is sent after the answer, so how long sending takes
 * gives nothing away either.
 */
authRoutes.post(
  '/forgot',
  handler(async (req, res) => {
    const { email } = parseBody(forgotSchema, req.body);
    if (!mailEnabled()) {
      res.json({ ok: true, mail: false });
      return;
    }
    const address = email.toLowerCase();
    const allowed =
      !throttled(`forgot:${address}`, 3, 15 * 60_000) && !throttled('forgot:*', 60, 15 * 60_000);
    res.json({ ok: true, mail: true });
    if (!allowed) return;
    void (async () => {
      const user = await prisma.user.findUnique({
        where: { email: address },
        select: { id: true, name: true, email: true, isActive: true },
      });
      if (!user || !user.isActive) return;
      const issued = await issueToken(prisma, user.id, 'RESET');
      // The link goes to the mailbox and nowhere else — never back to the caller.
      const sent = await deliverLink('RESET', user, issued);
      await audit(
        {
          entityType: 'user',
          entityId: user.id,
          action: 'UPDATED',
          actorId: null,
          actorName: null,
          summary: sent.emailed
            ? 'Password reset link emailed on request'
            : `Password reset email failed: ${sent.error ?? 'unknown reason'}`,
        },
        req,
      );
    })().catch((err) => console.error('[auth/forgot]', err instanceof Error ? err.message : err));
  }),
);

/** What a link is for, and whose it is — before the page asks for a password. */
authRoutes.post(
  '/link',
  handler(async (req, res) => {
    const { token } = parseBody(z.object({ token: z.string() }), req.body);
    const row = await liveToken(token);
    if (!row) throw linkGone();
    const u = row.user;
    const e = u.employee;
    res.json({
      purpose: row.purpose,
      name: u.name,
      email: u.email,
      expiresAt: row.expiresAt,
      phone: u.phone,
      // Shown on the invitation for the person to check, never to change.
      facts: row.purpose === 'INVITE' ? hrFacts(u) : null,
      // An invitation also asks for the person's own details, when there is an
      // employee record to keep them on.
      personal:
        row.purpose === 'INVITE' && e
          ? presentPersonal({
              mobile: e.mobile,
              address: e.address,
              birthDate: e.birthDate,
              emergencyContactName: e.emergencyContactName,
              emergencyContactPhone: e.emergencyContactPhone,
            })
          : null,
    });
  }),
);

const welcomeSchema = z.object({
  token: z.string(),
  password: newPassword,
  phone: z.string().trim().max(40).optional().nullable(),
  personal: personalSchema.optional(),
});

/**
 * Accepting an invitation: the person chooses their password, adds their
 * mobile and — when HR keeps a record of them — their own details, and is
 * signed in. The photo follows through /auth/photo, with the session this
 * returns.
 */
authRoutes.post(
  '/welcome',
  handler(async (req, res) => {
    const body = parseBody(welcomeSchema, req.body);
    const row = await liveToken(body.token);
    if (!row || row.purpose !== 'INVITE') throw linkGone();
    const user = row.user;
    const passwordHash = await bcrypt.hash(body.password, 10);

    const done = await prisma.$transaction(async (tx) => {
      if (!(await consumeToken(tx, row.id))) return false;
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          invitePending: false,
          lastLoginAt: new Date(),
          ...(body.phone !== undefined ? { phone: body.phone || null } : {}),
        },
      });
      // Every other link this person holds dies with this one.
      await tx.accountToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
      if (body.personal && user.employee) {
        await tx.employee.update({ where: { id: user.employee.id }, data: personalData(body.personal) });
      }
      return true;
    });
    if (!done) throw linkGone();

    await audit(
      {
        entityType: 'user',
        entityId: user.id,
        action: 'UPDATED',
        actorId: user.id,
        actorName: user.name,
        summary: 'Accepted the invitation and chose a password',
      },
      req,
    );
    res.json({ token: signToken(user.id, user.email) });
  }),
);

const resetSchema = z.object({ token: z.string(), password: newPassword });

/**
 * Using a reset link. It also completes an invitation nobody used — the
 * person has now chosen a password — and signs them in.
 */
authRoutes.post(
  '/reset',
  handler(async (req, res) => {
    const body = parseBody(resetSchema, req.body);
    const row = await liveToken(body.token);
    if (!row || row.purpose !== 'RESET') throw linkGone();
    const user = row.user;
    const passwordHash = await bcrypt.hash(body.password, 10);

    const done = await prisma.$transaction(async (tx) => {
      if (!(await consumeToken(tx, row.id))) return false;
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, invitePending: false, lastLoginAt: new Date() },
      });
      await tx.accountToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
      return true;
    });
    if (!done) throw linkGone();

    await audit(
      {
        entityType: 'user',
        entityId: user.id,
        action: 'UPDATED',
        actorId: user.id,
        actorName: user.name,
        summary: 'Chose a new password with a reset link',
      },
      req,
    );
    res.json({ token: signToken(user.id, user.email) });
  }),
);

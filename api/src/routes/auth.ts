import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../prisma';
import { handler, parseBody, unauthorized, badRequest } from '../http/kit';
import { authenticate, currentUser, signToken } from '../auth/middleware';
import { menuFor } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { unreadCount } from '../shared/notifications';
import { upload, saveAttachment, deleteAttachment } from '../shared/attachments';
import { currentAppearance } from './appearance';

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
    const [company, row, appearance] = await Promise.all([
      prisma.company.findUnique({ where: { id: 'company' } }),
      prisma.user.findUnique({ where: { id: user.id }, select: { photoPath: true } }),
      // Rides along rather than taking a request of its own: every browser
      // needs it to draw the page, and this is already the call that says
      // what to draw.
      currentAppearance(),
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

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: z.string().min(8, 'Use at least 8 characters'),
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

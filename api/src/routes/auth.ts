import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../prisma';
import { handler, parseBody, unauthorized, badRequest } from '../http/kit';
import { authenticate, currentUser, signToken } from '../auth/middleware';
import { menuFor } from '../permissions/resolve';
import { audit } from '../shared/audit';
import { unreadCount } from '../shared/notifications';

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
    const company = await prisma.company.findUnique({ where: { id: 'company' } });
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        position: user.position,
        isSuperAdmin: user.isSuperAdmin,
        roles: user.roleKeys,
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
    });
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

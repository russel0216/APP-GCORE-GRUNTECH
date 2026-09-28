import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import {
  handler,
  parseBody,
  listQuery,
  listResult,
  orderBy,
  notFound,
  conflict,
  badRequest,
} from '../http/kit';
import { authenticate, require_, currentUser } from '../auth/middleware';
import { audit, redact } from '../shared/audit';
import { allPermissions, REGISTRY, ACTION_LABELS } from '../permissions/registry';
import { ADMIN_RESET_HOURS, createLogin, deliverLink, issueToken } from '../shared/accounts';
import { mailConfig, sendMail } from '../shared/mail';

export const userRoutes = Router();
userRoutes.use(authenticate);

const SORTABLE = ['name', 'email', 'employeeNo', 'createdAt', 'lastLoginAt'];

const publicUser = {
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

// ── List ─────────────────────────────────────────────────────────────────────

userRoutes.get(
  '/',
  require_('admin.users.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where: Prisma.UserWhereInput = {};

    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { email: { contains: q.search, mode: 'insensitive' } },
        { employeeNo: { contains: q.search, mode: 'insensitive' } },
        { position: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    if (q.filters.isActive) where.isActive = q.filters.isActive === 'true';
    if (q.filters.role) where.roles = { some: { role: { key: q.filters.role } } };
    if (q.filters.departmentId) where.departmentId = q.filters.departmentId;

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          ...publicUser,
          department: { select: { id: true, name: true } },
          supervisor: { select: { id: true, name: true } },
          roles: { select: { role: { select: { key: true, name: true } } } },
        },
        orderBy: orderBy(q, SORTABLE, { name: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.user.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map((r) => ({ ...r, roles: r.roles.map((x) => x.role) })),
        total,
        q,
      ),
    );
  }),
);

// ── Lookup — a people picker, not the admin list ─────────────────────────────

/*
  Naming a colleague is not the admin right. Six pages used to fill their
  person pickers from the admin-gated list above, so a salesperson assigning
  a lead or a supervisor inviting people to a meeting needed admin.users —
  the /overtime/chargeable precedent, in the other direction. This returns
  names only, select-only, for active users, and sits ABOVE /:id or Express
  reads "lookup" as an id.

  `holding=<permission key>` narrows to the people who actually hold that
  right — through a role or an ALLOW override, and not taken away by a DENY
  override — which is what the trainer and evaluator pickers ask. Super
  admins hold everything, as can() says they do.
*/
userRoutes.get(
  '/lookup',
  handler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const holding = String(req.query.holding ?? '').trim();

    const where: Prisma.UserWhereInput = { isActive: true };
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { position: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (holding) {
      where.AND = [
        {
          OR: [
            { isSuperAdmin: true },
            {
              AND: [
                {
                  OR: [
                    { roles: { some: { role: { permissions: { some: { permission: { key: holding } } } } } } },
                    { overrides: { some: { effect: 'ALLOW', permission: { key: holding } } } },
                  ],
                },
                { NOT: { overrides: { some: { effect: 'DENY', permission: { key: holding } } } } },
              ],
            },
          ],
        },
      ];
    }

    const rows = await prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        position: true,
        department: { select: { id: true, name: true } },
      },
      orderBy: [{ department: { name: 'asc' } }, { name: 'asc' }],
      take: 200,
    });
    res.json(rows);
  }),
);

// ── Email: is it set up, and does it work ────────────────────────────────────

/**
 * Whether invitations and resets go by email. The password is never sent to
 * the screen; the host and the sender are enough to tell which account is set.
 */
userRoutes.get(
  '/mail-status',
  require_('admin.users.view_all'),
  handler(async (_req, res) => {
    const cfg = mailConfig();
    res.json({ enabled: !!cfg, host: cfg?.host ?? null, from: cfg?.from ?? null });
  }),
);

/** A test email to the administrator asking, so a wrong password shows up now rather than on an invitation. */
userRoutes.post(
  '/mail-test',
  require_('admin.users.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const cfg = mailConfig();
    if (!cfg) throw badRequest('Email is not set up — add SMTP_HOST and the mailbox details to the server settings first');
    try {
      await sendMail(
        {
          to: me.email,
          toName: me.name,
          subject: 'G-CORE test email',
          text: `This is a test from G-CORE, sent at your request.\n\nIf you are reading it, invitations and password resets will reach people too.\n\nSent through ${cfg.host} as ${cfg.from}.`,
        },
        cfg,
      );
    } catch (err) {
      throw badRequest(`The test email did not go: ${err instanceof Error ? err.message : String(err)}`);
    }
    res.json({ ok: true, to: me.email });
  }),
);

// ── Read one, with effective permissions ─────────────────────────────────────

userRoutes.get(
  '/:id',
  require_('admin.users.view_all'),
  handler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        ...publicUser,
        department: { select: { id: true, name: true } },
        supervisor: { select: { id: true, name: true } },
        roles: { select: { role: { select: { id: true, key: true, name: true } } } },
        overrides: { select: { effect: true, permission: { select: { key: true } } } },
      },
    });
    if (!user) throw notFound('User not found');

    // The invitation in flight, so the screen can say when it went and whether it ran out.
    const invite = user.invitePending
      ? await prisma.accountToken.findFirst({
          where: { userId: user.id, purpose: 'INVITE' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, expiresAt: true, usedAt: true },
        })
      : null;
    const employee = await prisma.employee.findUnique({
      where: { userId: user.id },
      select: { id: true, employeeNo: true, firstName: true, lastName: true },
    });

    res.json({
      ...user,
      roles: user.roles.map((r) => r.role),
      overrides: user.overrides.map((o) => ({ key: o.permission.key, effect: o.effect })),
      invite: invite
        ? { sentAt: invite.createdAt, expiresAt: invite.expiresAt, live: !invite.usedAt && invite.expiresAt > new Date() }
        : null,
      employee,
    });
  }),
);

// ── Create ───────────────────────────────────────────────────────────────────

const createSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  name: z.string().min(2, 'Name is required'),
  /** Without one the person is invited, and chooses their own. */
  password: z.string().min(8, 'Use at least 8 characters').max(128, 'Use at most 128 characters').optional().nullable(),
  /** The employee record this login belongs to — linked in the same save. */
  employeeId: z.string().optional().nullable(),
  employeeNo: z.string().trim().optional().nullable(),
  position: z.string().trim().optional().nullable(),
  /** The author's mobile under "Sincerely Yours," on a quotation. */
  phone: z.string().trim().max(40).optional().nullable(),
  supervisorId: z.string().optional().nullable(),
  departmentId: z.string().optional().nullable(),
  roleIds: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
});

userRoutes.post(
  '/',
  require_('admin.users.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(createSchema, req.body);

    // One save: the login, its link to the employee record, and the invitation.
    const made = await prisma.$transaction(async (tx) => {
      const employee = body.employeeId
        ? await tx.employee.findUnique({ where: { id: body.employeeId }, select: { id: true, userId: true } })
        : null;
      if (body.employeeId && !employee) throw notFound('Employee not found');
      if (employee?.userId) throw conflict('That employee already has a login');
      const login = await createLogin(
        tx,
        {
          email: body.email,
          name: body.name,
          password: body.password,
          employeeNo: body.employeeNo,
          position: body.position,
          phone: body.phone,
          supervisorId: body.supervisorId,
          departmentId: body.departmentId,
          isActive: body.isActive,
          roleIds: body.roleIds,
        },
        me.id,
      );
      if (employee) await tx.employee.update({ where: { id: employee.id }, data: { userId: login.user.id } });
      return login;
    });

    const created = made.user;
    await audit(
      {
        entityType: 'user',
        entityId: created.id,
        action: 'CREATED',
        summary: `Created user ${created.email}${made.invite ? ' — invited' : ''}${body.employeeId ? ', linked to their employee record' : ''}`,
        after: redact(created as Record<string, unknown>),
      },
      req,
    );

    const invite = made.invite ? await deliverLink('INVITE', created, made.invite, me.name) : null;
    res.status(201).json({ ...created, invite });
  }),
);

// ── Invitations and reset links, issued by an administrator ──────────────────

/**
 * A fresh invitation for someone who has not chosen a password yet — the
 * first may have gone to spam or run out. It kills the previous link.
 */
userRoutes.post(
  '/:id/invite',
  require_('admin.users.create'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, email: true, isActive: true, invitePending: true },
    });
    if (!user) throw notFound('User not found');
    if (!user.isActive) throw badRequest('This account is switched off — switch it on before inviting them');
    if (!user.invitePending) {
      throw badRequest('They have already chosen a password — send them a password reset link instead');
    }
    const issued = await issueToken(prisma, user.id, 'INVITE', { createdById: me.id });
    await audit(
      { entityType: 'user', entityId: user.id, action: 'UPDATED', summary: `Sent a new invitation to ${user.email}` },
      req,
    );
    res.json(await deliverLink('INVITE', user, issued, me.name));
  }),
);

/**
 * A reset link an administrator issues — what "Forgot password?" becomes
 * while email is not set up, or for someone locked out who calls in. It is
 * live for a day, because it may be passed on by chat rather than by email.
 */
userRoutes.post(
  '/:id/reset-link',
  require_('admin.users.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, email: true, isActive: true, invitePending: true },
    });
    if (!user) throw notFound('User not found');
    if (!user.isActive) throw badRequest('This account is switched off — switch it on first');
    if (user.invitePending) throw badRequest('They have not used their invitation yet — send a new invitation instead');
    const issued = await issueToken(prisma, user.id, 'RESET', {
      createdById: me.id,
      lifetimeMs: ADMIN_RESET_HOURS * 3_600_000,
    });
    await audit(
      { entityType: 'user', entityId: user.id, action: 'UPDATED', summary: `Issued a password reset link for ${user.email}` },
      req,
    );
    res.json(await deliverLink('RESET', user, issued));
  }),
);

// ── Update ───────────────────────────────────────────────────────────────────

const updateSchema = createSchema
  .omit({ password: true, email: true, employeeId: true })
  .partial()
  .extend({ password: z.string().min(8, 'Use at least 8 characters').max(128, 'Use at most 128 characters').optional() });

userRoutes.patch(
  '/:id',
  require_('admin.users.edit_all'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(updateSchema, req.body);

    const before = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: publicUser,
    });
    if (!before) throw notFound('User not found');

    // A user cannot supervise themselves — that would make an approval step
    // route straight back to the requester, who is then blocked from acting.
    if (body.supervisorId && body.supervisorId === req.params.id) {
      throw badRequest('A user cannot be their own supervisor');
    }
    // Don't let an admin deactivate themselves and lock the door behind them.
    if (body.isActive === false && req.params.id === me.id) {
      throw badRequest('You cannot deactivate your own account');
    }

    const data: Prisma.UserUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.employeeNo !== undefined) data.employeeNo = body.employeeNo || null;
    if (body.position !== undefined) data.position = body.position || null;
    if (body.phone !== undefined) data.phone = body.phone || null;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.password) {
      data.passwordHash = await bcrypt.hash(body.password, 10);
      // A password set here is the invitation answered: the account is ready.
      data.invitePending = false;
    }
    if (body.supervisorId !== undefined) {
      data.supervisor = body.supervisorId
        ? { connect: { id: body.supervisorId } }
        : { disconnect: true };
    }
    if (body.departmentId !== undefined) {
      data.department = body.departmentId
        ? { connect: { id: body.departmentId } }
        : { disconnect: true };
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Any link still out stops working once a password is set by hand.
      if (body.password) {
        await tx.accountToken.updateMany({ where: { userId: req.params.id, usedAt: null }, data: { usedAt: new Date() } });
      }
      if (body.roleIds) {
        await tx.userRole.deleteMany({ where: { userId: req.params.id } });
        await tx.userRole.createMany({
          data: body.roleIds.map((roleId) => ({ userId: req.params.id, roleId })),
        });
      }
      return tx.user.update({ where: { id: req.params.id }, data, select: publicUser });
    });

    await audit(
      {
        entityType: 'user',
        entityId: updated.id,
        action: 'UPDATED',
        summary: `Updated user ${updated.email}`,
        before: redact(before as Record<string, unknown>),
        after: redact(updated as Record<string, unknown>),
      },
      req,
    );

    res.json(updated);
  }),
);

// ── Per-user permission overrides ────────────────────────────────────────────
// This is the endpoint behind "the account or user I can customize what they
// can access ... also until the menu of this access".

const overrideSchema = z.object({
  overrides: z.array(
    z.object({ key: z.string(), effect: z.enum(['ALLOW', 'DENY']) }),
  ),
});

userRoutes.put(
  '/:id/overrides',
  require_('admin.users.edit_all'),
  handler(async (req, res) => {
    const { overrides } = parseBody(overrideSchema, req.body);

    const permissions = await prisma.permission.findMany({
      where: { key: { in: overrides.map((o) => o.key) } },
      select: { id: true, key: true },
    });
    const byKey = new Map(permissions.map((p) => [p.key, p.id]));

    const unknown = overrides.filter((o) => !byKey.has(o.key)).map((o) => o.key);
    if (unknown.length) throw badRequest(`Unknown permissions: ${unknown.join(', ')}`);

    await prisma.$transaction(async (tx) => {
      await tx.userPermissionOverride.deleteMany({ where: { userId: req.params.id } });
      if (overrides.length) {
        await tx.userPermissionOverride.createMany({
          data: overrides.map((o) => ({
            userId: req.params.id,
            permissionId: byKey.get(o.key)!,
            effect: o.effect,
          })),
        });
      }
    });

    await audit(
      {
        entityType: 'user',
        entityId: req.params.id,
        action: 'UPDATED',
        summary: `Set ${overrides.length} permission override(s)`,
        after: overrides,
      },
      req,
    );

    res.json({ ok: true, count: overrides.length });
  }),
);

// ── Roles ────────────────────────────────────────────────────────────────────

export const roleRoutes = Router();
roleRoutes.use(authenticate);

roleRoutes.get(
  '/',
  require_('admin.roles.view_all'),
  handler(async (_req, res) => {
    const roles = await prisma.role.findMany({
      include: {
        permissions: { select: { permission: { select: { key: true } } } },
        _count: { select: { users: true } },
      },
      orderBy: { name: 'asc' },
    });
    res.json(
      roles.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        userCount: r._count.users,
        permissions: r.permissions.map((p) => p.permission.key),
      })),
    );
  }),
);

/** The whole permission tree, for the role editor and the override editor. */
roleRoutes.get(
  '/permission-catalog',
  require_('admin.roles.view_all'),
  handler(async (_req, res) => {
    res.json({
      modules: REGISTRY.map((m) => ({
        key: m.key,
        label: m.label,
        blurb: m.blurb,
        submodules: m.submodules.map((s) => ({
          key: s.key,
          label: s.label,
          phase: s.phase,
          note: s.note,
          actions: s.actions.map((a) => ({
            action: a,
            label: ACTION_LABELS[a],
            key: `${m.key}.${s.key}.${a}`,
          })),
        })),
      })),
      total: allPermissions().length,
    });
  }),
);

const roleSchema = z.object({
  key: z
    .string()
    .min(2)
    .regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores'),
  name: z.string().min(2),
  description: z.string().optional().nullable(),
  permissions: z.array(z.string()).default([]),
});

roleRoutes.post(
  '/',
  require_('admin.roles.create'),
  handler(async (req, res) => {
    const body = parseBody(roleSchema, req.body);
    if (await prisma.role.findUnique({ where: { key: body.key } })) {
      throw conflict(`A role with key "${body.key}" already exists`);
    }
    const permissionIds = await resolvePermissionIds(body.permissions);

    const role = await prisma.role.create({
      data: {
        key: body.key,
        name: body.name,
        description: body.description ?? null,
        permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
      },
    });

    await audit(
      { entityType: 'role', entityId: role.id, action: 'CREATED', summary: `Created role ${role.name}` },
      req,
    );
    res.status(201).json(role);
  }),
);

roleRoutes.put(
  '/:id',
  require_('admin.roles.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(roleSchema.partial(), req.body);
    const role = await prisma.role.findUnique({ where: { id: req.params.id } });
    if (!role) throw notFound('Role not found');

    const updated = await prisma.$transaction(async (tx) => {
      if (body.permissions) {
        const permissionIds = await resolvePermissionIds(body.permissions);
        await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })),
        });
      }
      return tx.role.update({
        where: { id: role.id },
        data: {
          // A system role keeps its key — its permissions stay editable.
          name: body.name ?? role.name,
          description: body.description !== undefined ? body.description : role.description,
        },
      });
    });

    await audit(
      {
        entityType: 'role',
        entityId: role.id,
        action: 'UPDATED',
        summary: `Updated role ${updated.name}${body.permissions ? ` (${body.permissions.length} permissions)` : ''}`,
      },
      req,
    );
    res.json(updated);
  }),
);

roleRoutes.delete(
  '/:id',
  require_('admin.roles.delete'),
  handler(async (req, res) => {
    const role = await prisma.role.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { users: true } } },
    });
    if (!role) throw notFound('Role not found');
    if (role.isSystem) throw badRequest('System roles cannot be deleted — edit its permissions instead');
    if (role._count.users > 0) {
      throw badRequest(`${role._count.users} user(s) still have this role — reassign them first`);
    }

    await prisma.role.delete({ where: { id: role.id } });
    await audit(
      { entityType: 'role', entityId: role.id, action: 'DELETED', summary: `Deleted role ${role.name}` },
      req,
    );
    res.json({ ok: true });
  }),
);

async function resolvePermissionIds(keys: string[]): Promise<string[]> {
  if (!keys.length) return [];
  const rows = await prisma.permission.findMany({
    where: { key: { in: keys } },
    select: { id: true, key: true },
  });
  const found = new Set(rows.map((r) => r.key));
  const unknown = keys.filter((k) => !found.has(k));
  if (unknown.length) throw badRequest(`Unknown permissions: ${unknown.slice(0, 5).join(', ')}`);
  return rows.map((r) => r.id);
}

// ── Departments (needed by the user form) ────────────────────────────────────

export const departmentRoutes = Router();
departmentRoutes.use(authenticate);

departmentRoutes.get(
  '/',
  handler(async (_req, res) => {
    res.json(await prisma.department.findMany({ orderBy: { name: 'asc' } }));
  }),
);

departmentRoutes.post(
  '/',
  require_('admin.users.create'),
  handler(async (req, res) => {
    const body = parseBody(z.object({ code: z.string().min(1), name: z.string().min(2) }), req.body);
    const dept = await prisma.department.create({ data: body });
    res.status(201).json(dept);
  }),
);

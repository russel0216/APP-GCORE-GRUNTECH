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

export const userRoutes = Router();
userRoutes.use(authenticate);

const SORTABLE = ['name', 'email', 'employeeNo', 'createdAt', 'lastLoginAt'];

const publicUser = {
  id: true,
  email: true,
  name: true,
  employeeNo: true,
  position: true,
  isActive: true,
  isSuperAdmin: true,
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

    res.json({
      ...user,
      roles: user.roles.map((r) => r.role),
      overrides: user.overrides.map((o) => ({ key: o.permission.key, effect: o.effect })),
    });
  }),
);

// ── Create ───────────────────────────────────────────────────────────────────

const createSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  name: z.string().min(2, 'Name is required'),
  password: z.string().min(8, 'Use at least 8 characters'),
  employeeNo: z.string().trim().optional().nullable(),
  position: z.string().trim().optional().nullable(),
  supervisorId: z.string().optional().nullable(),
  departmentId: z.string().optional().nullable(),
  roleIds: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
});

userRoutes.post(
  '/',
  require_('admin.users.create'),
  handler(async (req, res) => {
    const body = parseBody(createSchema, req.body);
    const email = body.email.toLowerCase();

    if (await prisma.user.findUnique({ where: { email } })) {
      throw conflict('Someone already uses that email address');
    }

    const created = await prisma.user.create({
      data: {
        email,
        name: body.name,
        passwordHash: await bcrypt.hash(body.password, 10),
        employeeNo: body.employeeNo || null,
        position: body.position || null,
        supervisorId: body.supervisorId || null,
        departmentId: body.departmentId || null,
        isActive: body.isActive,
        roles: { create: body.roleIds.map((roleId) => ({ roleId })) },
      },
      select: publicUser,
    });

    await audit(
      {
        entityType: 'user',
        entityId: created.id,
        action: 'CREATED',
        summary: `Created user ${created.email}`,
        after: redact(created as Record<string, unknown>),
      },
      req,
    );

    res.status(201).json(created);
  }),
);

// ── Update ───────────────────────────────────────────────────────────────────

const updateSchema = createSchema
  .omit({ password: true, email: true })
  .partial()
  .extend({ password: z.string().min(8).optional() });

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
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.password) data.passwordHash = await bcrypt.hash(body.password, 10);
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

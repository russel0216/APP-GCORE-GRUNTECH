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
  idsFilter,
  notFound,
  conflict,
  badRequest,
  type ListQuery,
} from '../http/kit';
import { authenticate, require_, currentUser } from '../auth/middleware';
import { audit, redact } from '../shared/audit';
import { allPermissions, REGISTRY, ACTION_LABELS } from '../permissions/registry';
import { ADMIN_RESET_HOURS, deliverLink, issueToken } from '../shared/accounts';
import { mailConfig, sendMail } from '../shared/mail';
import { renderDocument, formatShortDate } from '../shared/pdf';
import { LIST_CAP, listReference, sendListPdf } from '../shared/listPaper';

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
  /** Attachment id of the account picture — the org chart draws it. */
  photoPath: true,
  /** The teams they support on a team-scoped approval step (Back Support). */
  supportTeams: { select: { industryId: true } },
} as const;

// ── List ─────────────────────────────────────────────────────────────────────

/**
 * The user list's where-builder — the screen's rows and the printed list
 * read the same set; `?ids=` narrows to the rows ticked.
 */
function userListWhere(q: ListQuery): Prisma.UserWhereInput {
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
  const ids = idsFilter(q.filters.ids);
  if (ids) where.id = { in: ids };
  return where;
}

userRoutes.get(
  '/',
  require_('admin.users.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = userListWhere(q);

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          ...publicUser,
          department: { select: { id: true, name: true } },
          supervisor: { select: { id: true, name: true } },
          roles: { select: { role: { select: { key: true, name: true } } } },
          employee: { select: { industry: { select: { code: true, name: true } } } },
        },
        orderBy: orderBy(q, SORTABLE, { name: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.user.count({ where }),
    ]);

    res.json(
      listResult(
        rows.map(({ employee, ...r }) => ({ ...r, roles: r.roles.map((x) => x.role), team: employee?.industry ?? null })),
        total,
        q,
      ),
    );
  }),
);

/**
 * The user list on paper — the list as filtered (or the rows ticked),
 * through `userListWhere`, so the paper is the screen it was printed off:
 * who signs in, as what, under whom, and whether they still can. Names,
 * emails, roles and status only — the select names exactly what prints, so
 * no hash, token or mobile can reach the page. Declared above `/:id`, or
 * that route swallows it.
 */
userRoutes.get(
  '/pdf',
  require_('admin.users.view_all'),
  handler(async (req, res) => {
    const q = listQuery(req);
    const where = userListWhere(q);
    const f = q.filters;
    const [rows, count, role, department] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          name: true,
          email: true,
          employeeNo: true,
          position: true,
          isActive: true,
          isSuperAdmin: true,
          invitePending: true,
          lastLoginAt: true,
          department: { select: { name: true } },
          supervisor: { select: { name: true } },
          roles: { select: { role: { select: { name: true } } } },
        },
        orderBy: orderBy(q, SORTABLE, { name: 'asc' }),
        take: LIST_CAP,
      }),
      prisma.user.count({ where }),
      f.role ? prisma.role.findUnique({ where: { key: f.role }, select: { name: true } }) : null,
      f.departmentId ? prisma.department.findUnique({ where: { id: f.departmentId }, select: { name: true } }) : null,
    ]);

    const reference = listReference(count, rows.length, ['user', 'users'], [
      q.search && `search "${q.search}"`,
      f.isActive && (f.isActive === 'true' ? 'active' : 'inactive'),
      f.role && `role ${role?.name ?? 'not found'}`,
      f.departmentId && `department ${department?.name ?? 'not found'}`,
      f.ids && 'the rows selected',
    ]);

    // Eight columns: landscape (rule 6). A super admin holds every right,
    // whatever roles they also carry, so the roles cell says it first.
    const pdf = await renderDocument({
      title: 'Users',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Name', 'Email', 'Number', 'Roles', 'Department', 'Reports to', 'Last sign-in', 'Status'],
          rows: rows.map((u) => {
            const roles = [...(u.isSuperAdmin ? ['Super admin'] : []), ...u.roles.map((r) => r.role.name)];
            return [
              u.position ? { title: u.name, body: u.position } : u.name,
              u.email,
              u.employeeNo ?? '—',
              roles.length ? roles.join(', ') : '—',
              u.department?.name ?? '—',
              u.supervisor?.name ?? '—',
              u.lastLoginAt ? formatShortDate(u.lastLoginAt) : 'Never',
              !u.isActive ? 'Inactive' : u.invitePending ? 'Invited' : 'Active',
            ];
          }),
        },
      ],
    });
    await audit(
      { entityType: 'user', entityId: 'list', action: 'EXPORTED', summary: `Exported the user list as PDF (${rows.length} user(s))` },
      req,
    );
    sendListPdf(res, pdf, 'users.pdf');
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
        // The photo (an attachment id) for a picker that shows faces (the activity form's participants).
        photoPath: true,
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
      select: { id: true, employeeNo: true, firstName: true, lastName: true, industryId: true },
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

/*
  There is no POST /users (2026-10-10, the owner's call: "unite the creation
  of user and HR employee record"). A person is made ONCE, as an employee
  with their login — `POST /employees { login }` from Admin › Users and from
  HR › Employees alike, or `POST /employees/:id/login` for someone already on
  the register — through `createLogin()` in shared/accounts.ts. A standalone
  login used to leave a User with no Employee behind it: no team, no employee
  number, nothing for the face clock or the quotation numbering to read.
*/

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

/** What Modify may change. The email is the account's identity and stays; a login is only ever made with its employee. */
const updateSchema = z.object({
  name: z.string().min(2, 'Name is required').optional(),
  employeeNo: z.string().trim().optional().nullable(),
  position: z.string().trim().optional().nullable(),
  /** The author's mobile under "Sincerely Yours," on a quotation. */
  phone: z.string().trim().max(40).optional().nullable(),
  supervisorId: z.string().optional().nullable(),
  departmentId: z.string().optional().nullable(),
  roleIds: z.array(z.string()).optional(),
  /** Where they support in back admin — teams; empty is every team. */
  supportTeamIds: z.array(z.string()).max(50).optional(),
  /**
   * Their own TEAM — `Employee.industryId` on the linked employee, the team
   * their quotations and sales orders count under (2026-10-12, the owner's
   * call: "on users edit allow selection of Team"). Null clears it.
   */
  teamId: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  /** A password set by hand answers the invitation. */
  password: z.string().min(8, 'Use at least 8 characters').max(128, 'Use at most 128 characters').optional(),
});

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

    if (body.supportTeamIds?.length) {
      const known = await prisma.industry.count({ where: { id: { in: body.supportTeamIds } } });
      if (known !== new Set(body.supportTeamIds).size) throw badRequest('supportTeamIds: a team was not found');
    }

    // The team lives on the employee record (one place, `shared/team.ts`):
    // a login with none has nowhere to keep it.
    const linked =
      body.teamId !== undefined
        ? await prisma.employee.findUnique({
            where: { userId: req.params.id },
            select: { id: true, industryId: true, industry: { select: { code: true } } },
          })
        : null;
    let newTeam: { id: string; code: string } | null = null;
    if (body.teamId !== undefined) {
      if (!linked) throw badRequest('teamId: this login has no employee record to keep a team on — add one in HR › Employees');
      if (body.teamId && body.teamId !== linked.industryId) {
        newTeam = await prisma.industry.findFirst({ where: { id: body.teamId, isActive: true }, select: { id: true, code: true } });
        if (!newTeam) throw badRequest('teamId: that team was not found or is switched off');
      }
    }
    const teamChanged = !!linked && body.teamId !== undefined && (body.teamId || null) !== linked.industryId;

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
      if (body.supportTeamIds) {
        await tx.userSupportTeam.deleteMany({ where: { userId: req.params.id } });
        await tx.userSupportTeam.createMany({
          data: [...new Set(body.supportTeamIds)].map((industryId) => ({ userId: req.params.id, industryId })),
        });
      }
      if (teamChanged && linked) {
        await tx.employee.update({ where: { id: linked.id }, data: { industryId: body.teamId || null } });
      }
      return tx.user.update({ where: { id: req.params.id }, data, select: publicUser });
    });

    if (teamChanged && linked) {
      await audit(
        {
          entityType: 'employee',
          entityId: linked.id,
          action: 'UPDATED',
          summary: `Team ${linked.industry?.code ?? 'none'} → ${newTeam?.code ?? 'none'} (from Admin › Users)`,
          before: { industryId: linked.industryId },
          after: { industryId: body.teamId || null },
        },
        req,
      );
    }

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

/**
 * Delete a role (2026-10-12, the owner's call: "allow me also to delete role
 * created"). A seeded (system) role stays — the seed would make it again and
 * the seeded approval routes name it. A role still holding people is taken
 * off them in the same transaction (the question says how many). A role an
 * approval route names — a step, or "Prepared by" — is refused, naming the
 * routes: deleting it would leave a step routing to nobody.
 */
roleRoutes.delete(
  '/:id',
  require_('admin.roles.delete'),
  handler(async (req, res) => {
    const role = await prisma.role.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { users: true } } },
    });
    if (!role) throw notFound('Role not found');
    if (role.isSystem) throw badRequest('A built-in role cannot be deleted — remove its permissions or take it off people instead');
    const routes = await prisma.approvalWorkflow.findMany({
      where: { OR: [{ requesterRoleId: role.id }, { steps: { some: { roleId: role.id } } }] },
      select: { name: true },
      orderBy: { name: 'asc' },
    });
    if (routes.length) {
      throw badRequest(
        `The approval route${routes.length > 1 ? 's' : ''} ${routes.map((r) => `"${r.name}"`).join(', ')} still use${routes.length > 1 ? '' : 's'} this role — change ${routes.length > 1 ? 'them' : 'it'} in Admin › Approval Workflows first`,
      );
    }
    const holders = await prisma.userRole.findMany({ where: { roleId: role.id }, select: { user: { select: { email: true } } } });

    await prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { roleId: role.id } });
      await tx.role.delete({ where: { id: role.id } });
    });
    await audit(
      {
        entityType: 'role',
        entityId: role.id,
        action: 'DELETED',
        summary: `Deleted role ${role.name}${holders.length ? ` (taken off ${holders.length} user${holders.length > 1 ? 's' : ''})` : ''}`,
        before: { key: role.key, name: role.name, users: holders.map((h) => h.user.email) },
      },
      req,
    );
    res.json({ ok: true, removedFrom: holders.length });
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

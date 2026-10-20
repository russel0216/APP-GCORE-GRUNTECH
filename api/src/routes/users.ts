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
  forbidden,
  type ListQuery,
} from '../http/kit';
import { authenticate, require_, currentUser } from '../auth/middleware';
import { audit, redact } from '../shared/audit';
import { allPermissions, REGISTRY, ACTION_LABELS } from '../permissions/registry';
import { ADMIN_RESET_HOURS, deliverLink, issueToken, syncLoginFromEmployee } from '../shared/accounts';
import { setCounter, type CounterMove } from '../shared/numbering';
import { setEmployeePosition } from '../shared/plantilla';
import { MAX_ROLES, refreshUserTitle, titleFromRoles, tooManyRoles } from '../shared/roleRev1';
import { ENGINE_ROLE_KEYS } from '../shared/rolesClear';
import { mailConfig, sendMail } from '../shared/mail';
import { requireView, requireEdit, ownOnly, viewScope, editScope, assertCanView, assertCanEdit } from '../shared/ownScope';
import { impliedBy, type ResolvedUser } from '../permissions/resolve';
import { renderDocument, formatShortDate } from '../shared/pdf';
import { LIST_CAP, listReference, sendListPdf } from '../shared/listPaper';

/** How an employee field written from Admin › Users is named in its audit row. */
const PERSONAL_LABELS: Record<string, string> = {
  firstName: 'first name',
  lastName: 'last name',
  suffix: 'suffix',
  mobile: 'mobile',
  position: 'position',
};

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
  lastLoginAt: true,
  createdAt: true,
  /** Attachment id of the account picture — the org chart draws it. */
  photoPath: true,
  /** The teams they support on a team-scoped approval step (Back Support). */
  supportTeams: { select: { industryId: true, industry: { select: { code: true } } } },
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
  // `?linked=no`: a login with no employee record (2026-10-16) — the clean-up
  // the "one person" rule asks for; `yes` the rest.
  if (q.filters.linked === 'no') where.employee = { is: null };
  else if (q.filters.linked === 'yes') where.employee = { isNot: null };
  // `?number=none`: a login with no employee number (2026-10-18 — the numbers
  // are typed here and written through to the employee record); `yes` the rest.
  if (q.filters.number === 'none') where.employeeNo = null;
  else if (q.filters.number === 'yes') where.employeeNo = { not: null };
  const ids = idsFilter(q.filters.ids);
  if (ids) where.id = { in: ids };
  return where;
}

/*
  View Own on Admin › Users is the caller's OWN login (2026-10-18, the
  registry's `own`): the list, its cards and its paper narrow to that one row;
  View All reads as before.
*/
/**
 * The main plantilla post and the ones also held (2026-10-19), from the
 * employee record — the login's `position` is their joined mirror.
 */
function heldPositions(
  e: { positionRef: { title: string } | null; extraPositions: { position: { title: string } }[] } | null | undefined,
): { mainPosition: string | null; alsoHolds: string[] } {
  return { mainPosition: e?.positionRef?.title ?? null, alsoHolds: (e?.extraPositions ?? []).map((x) => x.position.title) };
}

const MINE_USERS = (me: ResolvedUser): Prisma.UserWhereInput => ({ id: me.id });

userRoutes.get(
  '/',
  requireView('admin', 'users'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = ownOnly(me, 'admin', 'users', userListWhere(q), MINE_USERS(me));
    // Logins holding more than six roles (the cap of 2026-10-19 — listed, never trimmed).
    const overIds = (
      await prisma.userRole.groupBy({ by: ['userId'], _count: { _all: true }, having: { userId: { _count: { gt: MAX_ROLES } } } })
    ).map((g) => g.userId);
    if (q.filters.roles === 'over') where.AND = [...((where.AND as Prisma.UserWhereInput[]) ?? []), { id: { in: overIds } }];
    // The cards count everyone's logins — for an own-only reader, only their own.
    const all = viewScope(me, 'admin', 'users') === 'all';

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          ...publicUser,
          supervisor: { select: { id: true, name: true } },
          roles: { select: { role: { select: { key: true, name: true, rank: true, sortOrder: true } } } },
          employee: { select: { id: true, industry: { select: { id: true, code: true, name: true } }, positionRef: { select: { title: true } }, extraPositions: { orderBy: { sortOrder: 'asc' }, select: { position: { select: { title: true } } } } } },
        },
        orderBy: orderBy(q, SORTABLE, { name: 'asc' }),
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.user.count({ where }),
    ]);
    // The halves of a person still apart: logins with no employee record, and
    // active employees with no login (HR › Employees `?login=none`).
    const [loginsAlone, employeesAlone, withoutNumber] = await Promise.all([
      prisma.user.count({ where: { employee: { is: null }, isActive: true, ...(all ? {} : MINE_USERS(me)) } }),
      all ? prisma.employee.count({ where: { userId: null, isActive: true } }) : 0,
      // Active logins still without an employee number (2026-10-18).
      prisma.user.count({ where: { employeeNo: null, isActive: true, ...(all ? {} : MINE_USERS(me)) } }),
    ]);

    res.json({
      summary: { loginsAlone, employeesAlone, withoutNumber, moreThanMaxRoles: all ? overIds.length : 0, maxRoles: MAX_ROLES },
      ...listResult(
        rows.map(({ employee, ...r }) => ({
          ...r,
          roles: r.roles.map((x) => x.role),
          // The title on documents: the highest of the roles (ROLE_REV1).
          title: titleFromRoles(r.roles.map((x) => x.role)),
          team: employee?.industry ?? null,
          employeeId: employee?.id ?? null,
          ...heldPositions(employee),
        })),
        total,
        q,
      ),
    });
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
  requireView('admin', 'users'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const where = ownOnly(me, 'admin', 'users', userListWhere(q), MINE_USERS(me));
    const f = q.filters;
    const [rows, count, role] = await Promise.all([
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
          supervisor: { select: { name: true } },
          roles: { select: { role: { select: { name: true, rank: true, sortOrder: true } } } },
          employee: { select: { industry: { select: { code: true } } } },
        },
        orderBy: orderBy(q, SORTABLE, { name: 'asc' }),
        take: LIST_CAP,
      }),
      prisma.user.count({ where }),
      f.role ? prisma.role.findUnique({ where: { key: f.role }, select: { name: true } }) : null,
    ]);

    const reference = listReference(count, rows.length, ['user', 'users'], [
      q.search && `search "${q.search}"`,
      f.isActive && (f.isActive === 'true' ? 'active' : 'inactive'),
      f.role && `role ${role?.name ?? 'not found'}`,
      f.number && (f.number === 'none' ? 'no employee number yet' : 'with an employee number'),
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
          head: ['Name', 'Email', 'Number', 'Roles', 'Team', 'Reports to', 'Last sign-in', 'Status'],
          rows: rows.map((u) => {
            const roles = [...(u.isSuperAdmin ? ['Super admin'] : []), ...u.roles.map((r) => r.role.name)];
            return [
              (() => {
                const title = titleFromRoles(u.roles.map((r) => r.role)) ?? u.position;
                return title ? { title: u.name, body: title } : u.name;
              })(),
              u.email,
              u.employeeNo ?? '—',
              roles.length ? roles.join(', ') : '—',
              u.employee?.industry?.code ?? '—',
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
  right — through a role (the levels including the ones under them) — which
  is what the trainer and evaluator pickers ask. Super
  admins hold everything, as can() says they do.

  `role=<role key>` narrows to the active holders of that ROLE (2026-10-15:
  the project's Technical Manager is picked from the Technical Managers, not
  from everybody who can read projects). Super admins are not added — a role
  is a job, not a right.
*/
userRoutes.get(
  '/lookup',
  handler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const holding = String(req.query.holding ?? '').trim();
    const role = String(req.query.role ?? '').trim();

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
            // A level includes the ones under it: holding Own is also held by a Team or All role.
            { roles: { some: { role: { permissions: { some: { permission: { key: { in: impliedBy(holding) } } } } } } } },
          ],
        },
      ];
    }

    if (role) {
      where.roles = { some: { role: { key: role } } };
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
        // The team (2026-10-19: departments retired) — what a picker groups by.
        employee: { select: { industry: { select: { id: true, code: true, name: true } } } },
      },
      orderBy: [{ name: 'asc' }],
      take: 200,
    });
    res.json(rows.map(({ employee, ...r }) => ({ ...r, team: employee?.industry ?? null })));
  }),
);

// ── Email: is it set up, and does it work ────────────────────────────────────

/**
 * Whether invitations and resets go by email. The password is never sent to
 * the screen; the host and the sender are enough to tell which account is set.
 */
userRoutes.get(
  '/mail-status',
  requireView('admin', 'users'),
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
  requireView('admin', 'users'),
  handler(async (req, res) => {
    // View Own reads only their own login; anybody else's is a 404 (2026-10-18).
    assertCanView(currentUser(req), 'admin', 'users', req.params.id === currentUser(req).id);
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        ...publicUser,
        supervisor: { select: { id: true, name: true } },
        roles: { select: { role: { select: { id: true, key: true, name: true } } } },
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
      select: { id: true, employeeNo: true, firstName: true, lastName: true, suffix: true, industryId: true, positionRef: { select: { title: true } }, extraPositions: { orderBy: { sortOrder: 'asc' }, select: { position: { select: { title: true } } } } },
    });

    res.json({
      ...user,
      roles: user.roles.map((r) => r.role),
      invite: invite
        ? { sentAt: invite.createdAt, expiresAt: invite.expiresAt, live: !invite.usedAt && invite.expiresAt > new Date() }
        : null,
      employee: employee && {
        id: employee.id,
        employeeNo: employee.employeeNo,
        firstName: employee.firstName,
        lastName: employee.lastName,
        suffix: employee.suffix,
        industryId: employee.industryId,
      },
      ...heldPositions(employee),
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
  /**
   * A login linked to an employee: the name as the employee record keeps it
   * (2026-10-19, the owner's call: its details are edited here too and
   * written through to the record).
   */
  firstName: z.string().trim().min(1, 'First name is required').max(80).optional(),
  lastName: z.string().trim().min(1, 'Last name is required').max(80).optional(),
  suffix: z.string().trim().max(20).optional().nullable(),
  employeeNo: z.string().trim().optional().nullable(),
  position: z.string().trim().optional().nullable(),
  /** The author's mobile under "Sincerely Yours," on a quotation. */
  phone: z.string().trim().max(40).optional().nullable(),
  supervisorId: z.string().optional().nullable(),
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

/*
  Edit Own on Admin › Users is the caller's OWN login, and only its plain
  details (2026-10-18). Anything that decides what a login may do or who
  decides for it — roles, Supports teams, "Reports to", the team (the
  team-first approval steps read it), switching it on or off, the employee
  number (the quotation series reads it) and a password set past the
  current one — stays Edit All's: Edit Own must never be a door to more
  rights. Overrides are their own route, Edit All only; the super-admin
  flag is not writable here at all.
*/
const OWN_ONLY_REFUSED: Record<string, string> = {
  roleIds: 'roles',
  supportTeamIds: 'Supports teams',
  supervisorId: 'Reports to',
  teamId: 'the team',
  isActive: 'Active',
  employeeNo: 'the employee number',
  password: 'the password (use My Account)',
};

userRoutes.patch(
  '/:id',
  requireEdit('admin', 'users'),
  handler(async (req, res) => {
    const me = currentUser(req);
    assertCanEdit(me, 'admin', 'users', req.params.id === me.id);
    const body = parseBody(updateSchema, req.body);
    if (editScope(me, 'admin', 'users') !== 'all') {
      const refused = Object.keys(OWN_ONLY_REFUSED).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
      if (refused.length) {
        throw forbidden(`Changing ${refused.map((k) => OWN_ONLY_REFUSED[k]).join(', ')} needs "admin.users.edit_all" — Edit Own changes only your own details`);
      }
    }

    const before = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: publicUser,
    });
    if (!before) throw notFound('User not found');

    // Six roles at most (the owner's call, 2026-10-19).
    if (body.roleIds) {
      const tooMany = tooManyRoles(new Set(body.roleIds).size);
      if (tooMany) throw badRequest(tooMany, [{ field: 'roleIds', message: `${MAX_ROLES} roles at most` }]);
    }
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

    // The employee owns identity (2026-10-16): a login linked to an employee
    // record takes its name, number, phone and position from it
    // (`syncLoginFromEmployee`). Since 2026-10-19 (the owner's call: "edit
    // them here too") those are typed HERE as well and written THROUGH to the
    // employee record — the employee number (2026-10-18) and the Team already
    // were — and the login mirrors them back, so the two never disagree.
    const owner = await prisma.employee.findUnique({
      where: { userId: req.params.id },
      select: {
        id: true,
        employeeNo: true,
        firstName: true,
        lastName: true,
        suffix: true,
        mobile: true,
        position: true,
        positionId: true,
      },
    });
    const numberTyped = !!owner && body.employeeNo !== undefined && (body.employeeNo || null) !== (owner.employeeNo ?? null);
    if (numberTyped && body.employeeNo) {
      const holder = await prisma.employee.findFirst({
        where: { employeeNo: body.employeeNo, id: { not: owner!.id } },
        select: { firstName: true, lastName: true },
      });
      if (holder) throw conflict(`Employee number "${body.employeeNo}" is already ${holder.firstName} ${holder.lastName}'s`);
    }
    /** What this save writes onto the linked employee record (never pay or statutory fields). */
    const personal: Prisma.EmployeeUncheckedUpdateInput = {};
    const personalBefore: Record<string, unknown> = {};
    let positionTo: { positionId: string | null; text: string | null } | null = null;
    if (owner) {
      const current = await prisma.user.findUnique({ where: { id: req.params.id }, select: { name: true } });
      // A one-box name (an older form) cannot say which part is the surname.
      if (body.name !== undefined && body.name !== current?.name && body.firstName === undefined && body.lastName === undefined) {
        throw badRequest('Send the first and last name — this login takes its name from the employee record', [
          { field: 'name', message: 'Use First name and Last name' },
        ]);
      }
      const put = (key: keyof typeof owner, value: string | null | undefined) => {
        if (value === undefined) return;
        if ((value || null) === ((owner[key] as string | null) ?? null)) return;
        personalBefore[key] = owner[key];
        (personal as Record<string, unknown>)[key] = value || null;
      };
      if (body.firstName !== undefined) put('firstName', body.firstName);
      if (body.lastName !== undefined) put('lastName', body.lastName);
      put('suffix', body.suffix);
      put('mobile', body.phone);
      // The position has one writer (`setEmployeePosition`): a title the
      // Plantilla holds puts them on that position; another title is kept as
      // typed only while they hold no plantilla position — taking somebody
      // off the Plantilla is HR's call, on the employee record.
      const typed = body.position === undefined ? undefined : body.position?.trim() || null;
      if (typed !== undefined && typed !== (owner.position ?? null)) {
        const match = typed
          ? await prisma.position.findFirst({
              where: { title: { equals: typed, mode: 'insensitive' }, isActive: true },
              select: { id: true },
            })
          : null;
        if (match) positionTo = { positionId: match.id, text: null };
        else if (owner.positionId) {
          throw badRequest(
            `${owner.firstName} ${owner.lastName} holds the Plantilla position "${owner.position}" — pick another position from the Plantilla, or change it on the employee record (HR › Employees)`,
            [{ field: 'position', message: 'Not a Plantilla position' }],
          );
        } else positionTo = { positionId: null, text: typed };
        personalBefore.position = owner.position;
      }
    }
    const personalChanged = Object.keys(personal).length > 0 || positionTo !== null;
    if (personalChanged && editScope(me, 'admin', 'users') !== 'all' && positionTo) {
      throw forbidden('Changing the position needs "admin.users.edit_all" — Edit Own changes only your own details');
    }

    const data: Prisma.UserUpdateInput = {};
    // A linked login's name, number, position and phone are the
    // employee's (written below, mirrored back by `syncLoginFromEmployee`).
    if (body.name !== undefined && !owner) data.name = body.name;
    if (body.employeeNo !== undefined && !owner) data.employeeNo = body.employeeNo || null;
    if (body.position !== undefined && !owner) data.position = body.position || null;
    if (body.phone !== undefined && !owner) data.phone = body.phone || null;
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

    // A holder, not a `let`: TypeScript cannot see the assignment inside the
    // transaction's callback and would narrow a plain variable to null.
    const moved: { counter: CounterMove | null } = { counter: null };
    const updated = await prisma.$transaction(async (tx) => {
      // Any link still out stops working once a password is set by hand.
      if (body.password) {
        await tx.accountToken.updateMany({ where: { userId: req.params.id, usedAt: null }, data: { usedAt: new Date() } });
      }
      if (body.roleIds) {
        await tx.userRole.deleteMany({ where: { userId: req.params.id } });
        await tx.userRole.createMany({
          data: [...new Set(body.roleIds)].map((roleId) => ({ userId: req.params.id, roleId })),
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
      if (numberTyped && owner) {
        await tx.employee.update({ where: { id: owner.id }, data: { employeeNo: body.employeeNo || null } });
        // A typed number moves the employee series up to it, never down.
        if (body.employeeNo) moved.counter = await setCounter('employee', body.employeeNo, tx, { mode: 'raise' });
      }
      if (owner && personalChanged) {
        if (Object.keys(personal).length) await tx.employee.update({ where: { id: owner.id }, data: personal });
        if (positionTo) await setEmployeePosition(tx, owner.id, positionTo.positionId, positionTo.text);
      }
      if (owner && (numberTyped || personalChanged)) await syncLoginFromEmployee(tx, owner.id);
      const saved = await tx.user.update({ where: { id: req.params.id }, data, select: publicUser });
      // The title follows the roles: the highest of them (ROLE_REV1, 2026-10-19).
      if (body.roleIds && (await refreshUserTitle(tx, req.params.id))) {
        return tx.user.findUniqueOrThrow({ where: { id: req.params.id }, select: publicUser });
      }
      return saved;
    });

    const numberCounter = moved.counter;
    if (numberTyped && owner) {
      await audit(
        {
          entityType: 'employee',
          entityId: owner.id,
          action: 'UPDATED',
          summary: `Employee number ${owner.employeeNo ?? 'none'} → ${body.employeeNo || 'none'} (from Admin › Users)${numberCounter && numberCounter.after !== numberCounter.before ? ' — the employee series continues from it' : ''}`,
          before: { employeeNo: owner.employeeNo },
          after: { employeeNo: body.employeeNo || null, ...(numberCounter ? { counter: numberCounter } : {}) },
        },
        req,
      );
    }

    if (owner && personalChanged) {
      const after = await prisma.employee.findUnique({
        where: { id: owner.id },
        select: { firstName: true, lastName: true, suffix: true, mobile: true, position: true },
      });
      const keys = Object.keys(personalBefore);
      await audit(
        {
          entityType: 'employee',
          entityId: owner.id,
          action: 'UPDATED',
          summary: `Updated ${keys.map((k) => PERSONAL_LABELS[k] ?? k).join(', ')} (from Admin › Users)`,
          before: personalBefore,
          after: Object.fromEntries(keys.map((k) => [k, (after as Record<string, unknown> | null)?.[k] ?? null])),
        },
        req,
      );
    }

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

// ── Per-user permission overrides: gone (2026-10-19) ─────────────────────────
// The owner's call: access is the role matrix alone (Admin › Roles). The
// overrides on file were dropped once by the seed (`dropOverrides()`), and
// `resolveUser()` no longer reads the table.

// ── Roles ────────────────────────────────────────────────────────────────────

export const roleRoutes = Router();
roleRoutes.use(authenticate);

roleRoutes.get(
  '/',
  requireView('admin', 'roles'),
  handler(async (req, res) => {
    const me = currentUser(req);
    // View Own: the roles they made (`createdById`, 2026-10-18).
    const roles = await prisma.role.findMany({
      where: ownOnly(me, 'admin', 'roles', {} as Prisma.RoleWhereInput, (ids) => ({ createdById: { in: ids } })),
      include: {
        permissions: { select: { permission: { select: { key: true } } } },
        _count: { select: { users: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    res.json(
      roles.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        rank: r.rank,
        reportsToRoleId: r.reportsToRoleId,
        alsoReportsToRoleIds: r.alsoReportsToRoleIds,
        description: r.description,
        isSystem: r.isSystem,
        createdById: r.createdById,
        userCount: r._count.users,
        permissions: r.permissions.map((p) => p.permission.key),
      })),
    );
  }),
);

/** The whole permission tree, for the role editor and the override editor. */
roleRoutes.get(
  '/permission-catalog',
  requireView('admin', 'roles'),
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
          own: s.own,
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
  /** Its level on the chart (1 the CEO … 6 the skilled trades): a person's title is their highest role. */
  rank: z.number().int().min(1).max(9).optional().nullable(),
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
        rank: body.rank ?? null,
        sortOrder: 1000,
        // Who made it — Edit Own on Admin › Roles reads it (2026-10-18).
        createdById: currentUser(req).id,
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

/**
 * The permission matrix's save (2026-10-19): several roles' rights at once —
 * each role's whole set of keys, as its column on Admin › Roles reads. The
 * same rules as Modify role: Edit Own changes only the roles one made and
 * never one held. One transaction; one audit row per role that changed,
 * naming what came and went.
 */
const matrixSchema = z.object({
  roles: z.array(z.object({ id: z.string(), permissions: z.array(z.string()) })).min(1).max(200),
});

roleRoutes.put(
  '/matrix',
  requireEdit('admin', 'roles'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(matrixSchema, req.body);
    const roles = await prisma.role.findMany({
      where: { id: { in: body.roles.map((r) => r.id) } },
      include: { permissions: { select: { permission: { select: { key: true } } } } },
    });
    if (roles.length !== new Set(body.roles.map((r) => r.id)).size) throw badRequest('A role in the matrix was not found');
    const byId = new Map(roles.map((r) => [r.id, r]));
    const allKeys = [...new Set(body.roles.flatMap((r) => r.permissions))];
    const known = new Map((await prisma.permission.findMany({ where: { key: { in: allKeys } }, select: { id: true, key: true } })).map((p) => [p.key, p.id]));
    const unknown = allKeys.filter((k) => !known.has(k));
    if (unknown.length) throw badRequest(`Unknown permissions: ${unknown.slice(0, 5).join(', ')}`);

    const changes: { role: (typeof roles)[number]; added: string[]; removed: string[] }[] = [];
    for (const r of body.roles) {
      const role = byId.get(r.id)!;
      const before = new Set(role.permissions.map((p) => p.permission.key));
      const after = new Set(r.permissions);
      const added = [...after].filter((k) => !before.has(k));
      const removed = [...before].filter((k) => !after.has(k));
      if (!added.length && !removed.length) continue;
      assertCanEdit(me, 'admin', 'roles', role.createdById === me.id);
      if (editScope(me, 'admin', 'roles') !== 'all' && me.roleKeys.includes(role.key)) {
        throw forbidden(`You hold ${role.name} — changing its rights needs "admin.roles.edit_all"`);
      }
      changes.push({ role, added, removed });
    }

    await prisma.$transaction(async (tx) => {
      for (const c of changes) {
        if (c.removed.length) {
          await tx.rolePermission.deleteMany({ where: { roleId: c.role.id, permission: { key: { in: c.removed } } } });
        }
        if (c.added.length) {
          await tx.rolePermission.createMany({
            data: c.added.map((k) => ({ roleId: c.role.id, permissionId: known.get(k)! })),
            skipDuplicates: true,
          });
        }
      }
    });
    for (const c of changes) {
      await audit(
        {
          entityType: 'role',
          entityId: c.role.id,
          action: 'UPDATED',
          summary: `Permission matrix: ${c.role.name} — ${c.added.length} added, ${c.removed.length} removed`,
          before: { removed: c.removed },
          after: { added: c.added },
        },
        req,
      );
    }
    res.json({ changed: changes.map((c) => ({ id: c.role.id, added: c.added.length, removed: c.removed.length })) });
  }),
);

/**
 * The role hierarchy (2026-10-19, the owner's call: "a Hierarchy setting
 * where I can edit report to, based on role only, not by user"). PUT saves
 * each role's parent role (a cycle is a 400); `?apply=true` then writes every
 * holder's "Reports to" from it — the parent role's holder on the same team
 * first, else the only holder; several with no team to tell them apart leave
 * the person as they are and are named. A dry run answers what would change.
 */
const hierarchySchema = z.object({
  roles: z.array(z.object({ id: z.string(), reportsToRoleId: z.string().nullable(), alsoReportsToRoleIds: z.array(z.string()).max(10).optional() })).max(300),
});

roleRoutes.put(
  '/hierarchy',
  require_('admin.roles.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(hierarchySchema, req.body);
    const all = await prisma.role.findMany({ select: { id: true, name: true, reportsToRoleId: true, alsoReportsToRoleIds: true, rank: true } });
    const byId = new Map(all.map((r) => [r.id, r]));
    const parents = new Map(all.map((r) => [r.id, [r.reportsToRoleId, ...r.alsoReportsToRoleIds].filter(Boolean) as string[]]));
    const alsoOf = (r: (typeof body.roles)[number]) =>
      [...new Set((r.alsoReportsToRoleIds ?? byId.get(r.id)?.alsoReportsToRoleIds ?? []).filter((x) => x !== r.reportsToRoleId && x !== r.id))];
    for (const r of body.roles) {
      if (!byId.has(r.id)) throw badRequest('A role in the hierarchy was not found');
      const ps = [r.reportsToRoleId, ...alsoOf(r)].filter(Boolean) as string[];
      if (ps.some((p) => !byId.has(p))) throw badRequest('A "Reports to" role was not found');
      parents.set(r.id, ps);
    }
    // No role may reach itself through any of its parents.
    const visit = (id: string, path: Set<string>): void => {
      if (path.has(id)) throw badRequest(`${byId.get(id)!.name} would end up reporting to itself`);
      path.add(id);
      for (const p of parents.get(id) ?? []) visit(p, path);
      path.delete(id);
    };
    for (const r of all) visit(r.id, new Set());
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    const changed = body.roles.filter((r) => {
      const was = byId.get(r.id)!;
      return (was.reportsToRoleId ?? null) !== r.reportsToRoleId || !same(was.alsoReportsToRoleIds, alsoOf(r));
    });
    await prisma.$transaction(
      changed.map((r) => prisma.role.update({ where: { id: r.id }, data: { reportsToRoleId: r.reportsToRoleId, alsoReportsToRoleIds: alsoOf(r) } })),
    );
    for (const r of changed) {
      const role = byId.get(r.id)!;
      await audit(
        {
          entityType: 'role',
          entityId: r.id,
          action: 'UPDATED',
          summary: `Hierarchy: ${role.name} reports to ${[r.reportsToRoleId, ...alsoOf(r)].filter(Boolean).map((p) => byId.get(p!)!.name).join(' and ') || 'no role'}`,
          before: { reportsToRoleId: role.reportsToRoleId, alsoReportsToRoleIds: role.alsoReportsToRoleIds },
          after: { reportsToRoleId: r.reportsToRoleId, alsoReportsToRoleIds: alsoOf(r) },
        },
        req,
      );
    }
    res.json({ changed: changed.length });
  }),
);

/** The roles for the Organizational Chart (Admin › Users' right, not Roles'). */
roleRoutes.get(
  '/chart',
  requireView('admin', 'users'),
  handler(async (_req, res) => {
    const roles = await prisma.role.findMany({
      select: { id: true, key: true, name: true, rank: true, sortOrder: true, reportsToRoleId: true, alsoReportsToRoleIds: true },
      orderBy: [{ rank: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    res.json(roles);
  }),
);

roleRoutes.post(
  '/hierarchy/apply',
  require_('admin.users.edit_all'),
  handler(async (req, res) => {
    const apply = req.query.apply === 'true';
    const roles = await prisma.role.findMany({ select: { id: true, name: true, rank: true, sortOrder: true, reportsToRoleId: true } });
    const roleById = new Map(roles.map((r) => [r.id, r]));
    const users = await prisma.user.findMany({
      where: { isActive: true },
      select: {
        id: true, name: true, supervisorId: true,
        roles: { select: { roleId: true } },
        employee: { select: { industryId: true } },
      },
    });
    const holders = new Map<string, typeof users>();
    for (const u of users) for (const r of u.roles) holders.set(r.roleId, [...(holders.get(r.roleId) ?? []), u]);
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    const moves: { userId: string; name: string; from: string | null; to: string; via: string }[] = [];
    const unclear: { name: string; reason: string }[] = [];
    for (const u of users) {
      // The person's highest role that has a parent role decides.
      const own = u.roles.map((r) => roleById.get(r.roleId)!).filter((r) => r?.reportsToRoleId)
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.sortOrder - b.sortOrder);
      const role = own[0];
      if (!role) continue;
      const parentRole = roleById.get(role.reportsToRoleId!)!;
      let pool = (holders.get(parentRole.id) ?? []).filter((h) => h.id !== u.id);
      if (!pool.length) { unclear.push({ name: u.name, reason: `nobody holds ${parentRole.name}` }); continue; }
      const team = u.employee?.industryId;
      if (pool.length > 1 && team) {
        const same = pool.filter((h) => h.employee?.industryId === team);
        if (same.length) pool = same;
      }
      if (pool.length > 1) {
        unclear.push({ name: u.name, reason: `${pool.length} people hold ${parentRole.name}${team ? ' on their team' : ''}` });
        continue;
      }
      const to = pool[0];
      if (u.supervisorId === to.id) continue;
      moves.push({ userId: u.id, name: u.name, from: u.supervisorId ? nameOf.get(u.supervisorId) ?? null : null, to: to.name, via: `${role.name} → ${parentRole.name}` });
      if (apply) {
        await prisma.user.update({ where: { id: u.id }, data: { supervisorId: to.id } });
        await audit(
          {
            entityType: 'user',
            entityId: u.id,
            action: 'UPDATED',
            summary: `Reports to ${to.name} (from the role hierarchy: ${role.name} → ${parentRole.name})`,
            before: { supervisorId: u.supervisorId },
            after: { supervisorId: to.id },
          },
          req,
        );
      }
    }
    res.json({ applied: apply, moves, unclear });
  }),
);

roleRoutes.put(
  '/:id',
  requireEdit('admin', 'roles'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(roleSchema.partial(), req.body);
    const role = await prisma.role.findUnique({ where: { id: req.params.id } });
    if (!role) throw notFound('Role not found');
    // Edit Own: the roles they made (2026-10-18) — and never the rights of a
    // role they hold themselves, or Edit Own would be a way to grant oneself
    // more. Edit All edits any role, as before.
    assertCanEdit(me, 'admin', 'roles', role.createdById === me.id);
    if (body.permissions && editScope(me, 'admin', 'roles') !== 'all' && me.roleKeys.includes(role.key)) {
      throw forbidden('You hold this role — changing its rights needs "admin.roles.edit_all"');
    }

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
          rank: body.rank !== undefined ? body.rank : role.rank,
        },
      });
    });
    // A new name or rank moves its holders' titles, and its Plantilla slot's title.
    if ((body.name && body.name !== role.name) || (body.rank !== undefined && body.rank !== role.rank)) {
      if (body.name && body.name !== role.name) await prisma.position.updateMany({ where: { roleId: role.id }, data: { title: body.name } });
      const holders = await prisma.userRole.findMany({ where: { roleId: role.id }, select: { userId: true } });
      for (const h of holders) await refreshUserTitle(prisma, h.userId);
    }

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
    // The engine reads these by KEY (2026-10-18): rename or empty one, never delete it.
    if (ENGINE_ROLE_KEYS.some((k) => k.key === role.key)) {
      throw badRequest(`The role key "${role.key}" is read by the approval engine or the accounts — rename it or empty it instead of deleting it`);
    }
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

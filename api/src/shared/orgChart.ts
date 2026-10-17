import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { audit } from './audit';
import { nextNumber } from './numbering';
import { syncLoginFromEmployee } from './accounts';

/**
 * The owner's organisation chart of 2026-10-17
 * (`organizational_chart_executive_3.pptx` and `ROLE.xlsx`): sixty-one
 * people on five teams and five departments, each with their title, their
 * team or department, the teams they back-support and who they report to.
 * `docs/notes/P-org-chart-2026-10-17.md` has the plan and the owner's
 * answers: every login's roles RESET to the chart's (the roles handed out
 * wholesale were where "A or B" came from), the people with no login made
 * EMPLOYEE records for the owner to invite later, four ambiguous reporting
 * lines set to the first named, and the whole applied by the seed ONCE
 * (`ORG_CHART_MARK`), so what an administrator changes afterwards stays.
 *
 * Matching is by the login's email where one is known (the live install's
 * addresses), else by name, trimmed and case-blind. A person on neither is
 * created as an employee with no login; a login not on the chart (Jhon
 * Russel Balicas, Julian Gasiong, the administrator) is left as it is.
 */

export const ORG_CHART_MARK = 'seed.orgChart20261017';

/** The chart's titles, to G-CORE's roles. A title with none is a POSITION held with the `employee` role alone. */
export const TITLE_ROLES: Record<string, string[]> = {
  'CEO / President': ['ceo', 'executive'],
  'Team Leader': ['team_leader'],
  'Technical Manager': ['technical_manager'],
  'Sales Manager': ['sales_manager'],
  'Service Manager': ['service_manager'],
  'Purchasing Manager (Importation)': ['purchasing_manager_import'],
  'Purchasing Manager (Local)': ['purchasing_manager'],
  'Project Engineer': ['project_engineer'],
  'Project Lead': ['project_lead'],
  Welder: [],
  Electrician: [],
  'Project Support': [],
  'Service Engineer': ['service_engineer'],
  'Service Technician': [],
  'Sales Engineer': ['industry_specialist'],
  // The three Purchasing Officers are their teams' Back Support (the chart).
  'Purchasing Officer': ['procurement', 'back_support'],
  'Finance Manager': ['finance_manager'],
  // Any of the finance staff is "Checking (Finance Staff)" — the owner's call.
  'Finance Officer': ['finance'],
  'Finance Clerk': ['finance'],
  Collection: ['finance'],
  // The one warehouse person is their own supervisor's fallback.
  'Warehouse Officer': ['warehouse', 'warehouse_supervisor'],
  'Accounting Manager': ['accounting'],
  'Accounting Officer': ['accounting'],
  'Accounting Clerk': ['accounting'],
  'Marketing Manager': ['marketing'],
  'Marketing Assistant': ['marketing'],
  'Human Resources Officer': ['hr'],
  'CAD Supervisor': ['designer_lead'],
  'CAD Operator': ['designer'],
  'Cost Controller': ['cost_controller'],
};

/** The chart's departments, seeded beside the eight the install had. */
export const CHART_DEPARTMENTS = [
  { code: 'SCF', name: 'Supply Chain & Finance' },
  { code: 'ACC', name: 'Accounting' },
  { code: 'MKT', name: 'Marketing' },
  { code: 'DSN', name: 'Design Team' },
  { code: 'CCD', name: 'Cost Control' },
];

export interface OrgPerson {
  name: string;
  /** The live install's login address, where one exists. */
  email?: string;
  /** The team (Industry code), or null for department staff. */
  team: 'KAT' | 'HIT' | 'UIT' | 'GIB' | 'SIT' | null;
  department?: 'SCF' | 'ACC' | 'MKT' | 'DSN' | 'CCD';
  /** The teams they back-support ("Supports teams" on Admin › Users). */
  supports?: ('KAT' | 'HIT' | 'UIT' | 'GIB' | 'SIT')[];
  /** Who they report to, by the chart's name; none for the CEO. */
  reportsTo?: string;
  /** The chart's titles, the first their position. */
  titles: (keyof typeof TITLE_ROLES)[];
}

export const ORG_CHART: OrgPerson[] = [
  // ── The CEO and the five Team Leaders ───────────────────────────────────
  { name: 'Carter Gasiong', email: 'cartergasiong@gruntechnology.com', team: 'SIT', titles: ['CEO / President', 'Team Leader', 'Technical Manager', 'Sales Manager', 'Service Manager', 'Purchasing Manager (Importation)'] },
  { name: 'Renerose Yang', email: 'renyang@gruntechnology.com', team: 'KAT', reportsTo: 'Carter Gasiong', titles: ['Team Leader'] },
  { name: 'Ricardo Martinez', email: 'ricmartinez@gruntechnology.com', team: 'HIT', reportsTo: 'Carter Gasiong', titles: ['Team Leader', 'Technical Manager', 'Sales Manager', 'Service Manager'] },
  { name: 'Brian Jay Torres', email: 'briantorres@gruntechnology.com', team: 'UIT', reportsTo: 'Carter Gasiong', titles: ['Team Leader', 'Technical Manager', 'Sales Manager', 'Service Manager'] },
  { name: 'Salvador Ugaban', email: 'salvadorugaban@gruntechnology.com', team: 'GIB', reportsTo: 'Carter Gasiong', titles: ['Team Leader', 'Technical Manager', 'Sales Manager', 'Service Manager'] },
  // ── Project Engineers (report to their team's Technical Manager) ────────
  { name: 'Rolando Tagalog', email: 'rolandotagalog@gruntechnology.com', team: 'HIT', reportsTo: 'Ricardo Martinez', titles: ['Project Engineer'] },
  { name: 'Rodrigo Catuday', email: 'rodrigocatuday@gruntechnology.com', team: 'HIT', reportsTo: 'Ricardo Martinez', titles: ['Project Engineer'] },
  { name: 'Jonel Pada', email: 'jonelpada@gruntechnology.com', team: 'GIB', reportsTo: 'Salvador Ugaban', titles: ['Project Engineer'] },
  { name: 'Renielle Ascano', email: 'renielleascano@gruntechnology.com', team: 'UIT', reportsTo: 'Brian Jay Torres', titles: ['Project Engineer'] },
  { name: 'Marlon Piscos', email: 'marlonpiscos@gruntechnology.com', team: 'UIT', reportsTo: 'Brian Jay Torres', titles: ['Project Engineer'] },
  // ── Project Leads (the sheet says "Project Engineer"; the first named where a team has two) ──
  { name: 'Reagan Cajoto', team: 'HIT', reportsTo: 'Rolando Tagalog', titles: ['Project Lead'] },
  { name: 'Rey Guetan', team: 'HIT', reportsTo: 'Rolando Tagalog', titles: ['Project Lead'] },
  { name: 'Jobby Acasili', team: 'GIB', reportsTo: 'Jonel Pada', titles: ['Project Lead'] },
  { name: 'Arnel Belbes', team: 'UIT', reportsTo: 'Renielle Ascano', titles: ['Project Lead'] },
  // ── The crews (the sheet says "Project Lead"; HIT's first named is Reagan) ──
  { name: 'Florencio Omega', team: 'HIT', reportsTo: 'Reagan Cajoto', titles: ['Welder'] },
  { name: 'Arturo Naanep', team: 'HIT', reportsTo: 'Reagan Cajoto', titles: ['Welder'] },
  { name: 'Christian Argente', team: 'UIT', reportsTo: 'Arnel Belbes', titles: ['Welder'] },
  { name: 'Russel Ramirez', team: 'UIT', reportsTo: 'Arnel Belbes', titles: ['Welder'] },
  { name: 'Apolonio Abonita', team: 'GIB', reportsTo: 'Jobby Acasili', titles: ['Welder'] },
  { name: 'Renuel Reyes', team: 'HIT', reportsTo: 'Reagan Cajoto', titles: ['Electrician'] },
  { name: 'Charlie Malubag', team: 'UIT', reportsTo: 'Arnel Belbes', titles: ['Electrician'] },
  { name: 'Aldrin Dilingon', team: 'GIB', reportsTo: 'Jobby Acasili', titles: ['Electrician'] },
  { name: 'Julius Domegina', team: 'GIB', reportsTo: 'Jobby Acasili', titles: ['Electrician'] },
  { name: 'Alvin Abajar', team: 'HIT', reportsTo: 'Reagan Cajoto', titles: ['Project Support'] },
  { name: 'Joselito Madara', team: 'HIT', reportsTo: 'Reagan Cajoto', titles: ['Project Support'] },
  { name: 'Jericho Naanep', team: 'HIT', reportsTo: 'Reagan Cajoto', titles: ['Project Support'] },
  { name: 'John Harbie Salarzon', team: 'GIB', reportsTo: 'Jobby Acasili', titles: ['Project Support'] },
  { name: 'Loyd Francisco', team: 'HIT', reportsTo: 'Reagan Cajoto', titles: ['Project Support'] },
  { name: 'Samuel Balicas', team: 'HIT', reportsTo: 'Reagan Cajoto', titles: ['Project Support'] },
  { name: 'Reyniel Emhie Tolentino', team: 'HIT', reportsTo: 'Reagan Cajoto', titles: ['Project Support'] },
  { name: 'Don Luigi Rio', team: 'HIT', reportsTo: 'Reagan Cajoto', titles: ['Project Support'] },
  { name: 'Alexis Belbes', team: 'UIT', reportsTo: 'Arnel Belbes', titles: ['Project Support'] },
  // ── Service ─────────────────────────────────────────────────────────────
  { name: 'Emil Martinez', email: 'emilmartinez@gruntechnology.com', team: 'GIB', reportsTo: 'Salvador Ugaban', titles: ['Service Engineer'] },
  { name: 'Paul Iver Yumul', team: 'GIB', reportsTo: 'Emil Martinez', titles: ['Service Technician'] },
  { name: 'Ammar Yasir', team: 'GIB', reportsTo: 'Emil Martinez', titles: ['Service Technician'] },
  { name: 'Mark Angelo Ursulom', team: 'GIB', reportsTo: 'Emil Martinez', titles: ['Service Technician'] },
  { name: 'Paul Ignacio Roa', team: 'GIB', reportsTo: 'Emil Martinez', titles: ['Service Technician'] },
  // ── Sales Engineers (report to their Team Leader) ───────────────────────
  { name: 'Camille Guiling', email: 'camilleguiling@gruntechnology.com', team: 'KAT', reportsTo: 'Renerose Yang', titles: ['Sales Engineer'] },
  { name: 'Ivan Immaculata', email: 'ivanimmaculata@gruntechnology.com', team: 'HIT', reportsTo: 'Ricardo Martinez', titles: ['Sales Engineer'] },
  { name: 'Erica Diolata', email: 'ericadiolata@gruntechnology.com', team: 'HIT', reportsTo: 'Ricardo Martinez', titles: ['Sales Engineer'] },
  { name: 'Jerald Ventura', email: 'jeraldventura@gruntechnology.com', team: 'UIT', reportsTo: 'Brian Jay Torres', titles: ['Sales Engineer'] },
  { name: 'Rodolfo Almonte', email: 'jonalmonte@gruntechnology.com', team: 'GIB', reportsTo: 'Salvador Ugaban', titles: ['Sales Engineer'] },
  { name: 'Daniel Cabacungan', email: 'danielcabacungan@gruntechnology.com', team: 'GIB', reportsTo: 'Salvador Ugaban', titles: ['Sales Engineer'] },
  // ── Supply Chain & Finance ──────────────────────────────────────────────
  { name: 'Dina Gasiong', email: 'dinagasiong@gruntechnology.com', team: null, department: 'SCF', supports: ['SIT'], reportsTo: 'Carter Gasiong', titles: ['Purchasing Manager (Local)', 'Finance Manager'] },
  { name: 'Mylin Sarcillas', email: 'mylinsarcilla@gruntechnology.com', team: null, department: 'SCF', supports: ['UIT'], reportsTo: 'Dina Gasiong', titles: ['Purchasing Officer'] },
  { name: 'Joy Kenneth Robinos', email: 'joyrobinos@gruntechnology.com', team: null, department: 'SCF', supports: ['GIB'], reportsTo: 'Dina Gasiong', titles: ['Purchasing Officer'] },
  { name: 'Wenchie Marcellano', email: 'wenchiemarcellano@gruntechnology.com', team: null, department: 'SCF', supports: ['HIT'], reportsTo: 'Dina Gasiong', titles: ['Purchasing Officer'] },
  { name: 'Princess Martinez', email: 'princessmartinez@gruntechnology.com', team: null, department: 'SCF', reportsTo: 'Dina Gasiong', titles: ['Finance Officer'] },
  { name: 'Erwenn Ann Cabal', team: null, department: 'SCF', reportsTo: 'Dina Gasiong', titles: ['Finance Clerk'] },
  { name: 'Christine Anne Rosario', team: null, department: 'SCF', reportsTo: 'Dina Gasiong', titles: ['Finance Clerk'] },
  { name: 'Noel Talisic', team: null, department: 'SCF', reportsTo: 'Dina Gasiong', titles: ['Collection'] },
  { name: 'Jeric Gasiong', email: 'jericgasiong@gruntechnology.com', team: null, department: 'SCF', reportsTo: 'Dina Gasiong', titles: ['Warehouse Officer'] },
  // ── Accounting, Marketing, HR ───────────────────────────────────────────
  { name: 'Karen Gasiong', email: 'karengasiong@gruntechnology.com', team: null, department: 'ACC', supports: ['KAT'], reportsTo: 'Carter Gasiong', titles: ['Accounting Manager', 'Marketing Manager'] },
  { name: 'Marielle Severino', team: null, department: 'ACC', reportsTo: 'Karen Gasiong', titles: ['Accounting Officer'] },
  { name: 'Samantha Acebutch', team: null, department: 'ACC', reportsTo: 'Marielle Severino', titles: ['Accounting Clerk'] },
  { name: 'Filipina Peleno', email: 'filipinapeleno@gruntechnology.com', team: null, department: 'SCF', reportsTo: 'Karen Gasiong', titles: ['Human Resources Officer'] },
  { name: 'Rodrigo Gimenez', email: 'rodrigogimenez@gruntechnology.com', team: null, department: 'MKT', reportsTo: 'Karen Gasiong', titles: ['Marketing Assistant'] },
  // ── Design Team and Cost Control ────────────────────────────────────────
  { name: 'John Paul Macabudbod', email: 'jpmacabudbud@gruntechnology.com', team: null, department: 'DSN', reportsTo: 'Carter Gasiong', titles: ['CAD Supervisor'] },
  { name: 'Jovenn Grande', email: 'jovenngrande@gruntechnology.com', team: null, department: 'DSN', reportsTo: 'John Paul Macabudbod', titles: ['CAD Operator'] },
  { name: 'Ayesa Jane Yaya', email: 'ayessayaya@gruntechnology.com', team: null, department: 'CCD', reportsTo: 'Carter Gasiong', titles: ['Cost Controller'] },
];

const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** The roles a person on the chart holds: their titles' roles, and Employee. */
export function chartRoles(person: OrgPerson): string[] {
  return [...new Set(['employee', ...person.titles.flatMap((t) => TITLE_ROLES[t] ?? [])])];
}

export interface OrgChange {
  name: string;
  /** What changes, in words — one line each. */
  changes: string[];
}

/**
 * Applies the chart (or, with `dryRun`, says what it would do). Every change
 * is one line in the result; a run that applies audits each person's row.
 */
export async function applyOrgChart(opts: { dryRun?: boolean; force?: boolean } = {}): Promise<{ applied: boolean; people: OrgChange[]; unmatched: string[] }> {
  if (!opts.force && !opts.dryRun && (await prisma.setting.findUnique({ where: { key: ORG_CHART_MARK } }))) {
    return { applied: false, people: [], unmatched: [] };
  }
  const [roles, teams, departments, users, employees] = await Promise.all([
    prisma.role.findMany({ select: { id: true, key: true, name: true } }),
    prisma.industry.findMany({ select: { id: true, code: true } }),
    prisma.department.findMany({ select: { id: true, code: true } }),
    prisma.user.findMany({
      select: { id: true, email: true, name: true, supervisorId: true, isActive: true, roles: { select: { role: { select: { key: true } } } }, supportTeams: { select: { industryId: true } }, employee: { select: { id: true } } },
    }),
    prisma.employee.findMany({ select: { id: true, firstName: true, lastName: true, userId: true, industryId: true, departmentId: true, position: true } }),
  ]);
  const roleId = new Map(roles.map((r) => [r.key, r.id]));
  const teamId = new Map(teams.map((t) => [t.code, t.id]));
  const deptId = new Map(departments.map((d) => [d.code, d.id]));
  const missingRoles = [...new Set(ORG_CHART.flatMap(chartRoles))].filter((k) => !roleId.has(k));
  if (missingRoles.length) throw new Error(`The chart names roles the seed has not made yet: ${missingRoles.join(', ')}`);
  for (const code of ['KAT', 'HIT', 'UIT', 'GIB', 'SIT']) if (!teamId.has(code)) throw new Error(`Team ${code} is not on file`);
  for (const d of CHART_DEPARTMENTS) if (!deptId.has(d.code)) throw new Error(`Department ${d.code} is not on file`);

  // Who is who: a login by email, else a login or an employee by name.
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
  const userByName = new Map(users.map((u) => [fold(u.name), u]));
  const employeeByName = new Map(employees.map((e) => [fold(`${e.firstName} ${e.lastName}`), e]));
  const resolve = (p: OrgPerson) => {
    const user = (p.email && byEmail.get(p.email.toLowerCase())) || userByName.get(fold(p.name)) || null;
    const employee = user ? (employees.find((e) => e.userId === user.id) ?? null) : (employeeByName.get(fold(p.name)) ?? null);
    return { user, employee };
  };
  const resolved = new Map(ORG_CHART.map((p) => [p.name, resolve(p)]));
  const userIdOf = (name: string | undefined) => (name ? (resolved.get(name)?.user?.id ?? null) : null);

  const people: OrgChange[] = [];
  const unmatched: string[] = [];
  const supervising = new Set<string>();
  for (const p of ORG_CHART) if (p.reportsTo && userIdOf(p.reportsTo) && resolved.get(p.name)?.user) supervising.add(userIdOf(p.reportsTo)!);

  const run = async (tx: Prisma.TransactionClient | null) => {
    for (const p of ORG_CHART) {
      const { user, employee } = resolved.get(p.name)!;
      const changes: string[] = [];
      const position = p.titles[0];
      const wantTeam = p.team ? teamId.get(p.team)! : null;
      const wantDept = p.department ? deptId.get(p.department)! : null;

      if (!user && !employee) {
        unmatched.push(p.name);
        changes.push(`create the employee record (${position}${p.team ? `, ${p.team}` : p.department ? `, ${p.department}` : ''}) — no login; invite them from the record`);
        if (tx) {
          const parts = p.name.split(' ');
          const lastName = parts.pop()!;
          const created = await tx.employee.create({
            data: {
              employeeNo: await nextNumber('employee', tx),
              firstName: parts.join(' '),
              lastName,
              position,
              industryId: wantTeam,
              departmentId: wantDept,
            },
          });
          await audit(
            { entityType: 'employee', entityId: created.id, action: 'CREATED', summary: `Created ${p.name} (${position}) from the organisation chart of 2026-10-17 — no login yet` },
            undefined,
            tx,
          );
        }
        people.push({ name: p.name, changes });
        continue;
      }

      // The employee record: team, department, position.
      if (employee) {
        const data: Prisma.EmployeeUpdateInput = {};
        if (employee.industryId !== wantTeam) {
          changes.push(`team: ${teams.find((t) => t.id === employee.industryId)?.code ?? 'none'} → ${p.team ?? 'none'}`);
          data.industry = wantTeam ? { connect: { id: wantTeam } } : { disconnect: true };
        }
        if (wantDept && employee.departmentId !== wantDept) {
          changes.push(`department: ${departments.find((d) => d.id === employee.departmentId)?.code ?? 'none'} → ${p.department}`);
          data.department = { connect: { id: wantDept } };
        }
        if ((employee.position ?? '') !== position) {
          changes.push(`position: ${employee.position ?? 'none'} → ${position}`);
          data.position = position;
          data.positionRef = { disconnect: true };
        }
        if (tx && Object.keys(data).length) {
          await tx.employee.update({ where: { id: employee.id }, data });
          await syncLoginFromEmployee(tx, employee.id);
        }
      } else if (user) {
        changes.push('no employee record — team and position wait until one is made');
      }

      if (user) {
        // Roles: reset to the chart's, plus Supervisor for anyone with a report.
        const want = new Set(chartRoles(p));
        if (supervising.has(user.id)) want.add('supervisor');
        const have = new Set(user.roles.map((r) => r.role.key));
        const added = [...want].filter((k) => !have.has(k));
        const removed = [...have].filter((k) => !want.has(k));
        if (added.length) changes.push(`roles added: ${added.join(', ')}`);
        if (removed.length) changes.push(`roles removed: ${removed.join(', ')}`);
        if (tx && (added.length || removed.length)) {
          await tx.userRole.deleteMany({ where: { userId: user.id } });
          await tx.userRole.createMany({ data: [...want].map((k) => ({ userId: user.id, roleId: roleId.get(k)! })), skipDuplicates: true });
        }
        // Reports to.
        const boss = userIdOf(p.reportsTo);
        if (p.reportsTo && !boss) changes.push(`reports to ${p.reportsTo} — who has no login yet; set it once they do`);
        else if ((user.supervisorId ?? null) !== boss) {
          changes.push(`reports to: ${users.find((u) => u.id === user.supervisorId)?.name ?? 'nobody'} → ${p.reportsTo ?? 'nobody'}`);
          if (tx) await tx.user.update({ where: { id: user.id }, data: { supervisorId: boss } });
        }
        // Supports teams (Back Support).
        const wantSupports = new Set((p.supports ?? []).map((c) => teamId.get(c)!));
        const haveSupports = new Set(user.supportTeams.map((s) => s.industryId));
        if ([...wantSupports].some((t) => !haveSupports.has(t)) || [...haveSupports].some((t) => !wantSupports.has(t))) {
          changes.push(`supports teams: ${[...haveSupports].map((t) => teams.find((x) => x.id === t)?.code).join(', ') || 'none'} → ${(p.supports ?? []).join(', ') || 'none'}`);
          if (tx) {
            await tx.userSupportTeam.deleteMany({ where: { userId: user.id } });
            if (wantSupports.size) await tx.userSupportTeam.createMany({ data: [...wantSupports].map((industryId) => ({ userId: user.id, industryId })) });
          }
        }
        if (tx && changes.length) {
          await audit(
            { entityType: 'user', entityId: user.id, action: 'UPDATED', summary: `Organisation chart of 2026-10-17: ${changes.join('; ')}` },
            undefined,
            tx,
          );
        }
      }
      if (changes.length) people.push({ name: p.name, changes });
    }
    if (tx) {
      await tx.setting.create({
        data: { key: ORG_CHART_MARK, value: { at: new Date().toISOString(), people: people.length, created: unmatched.length }, description: 'seed: the organisation chart of 2026-10-17 was applied once' },
      });
    }
  };

  if (opts.dryRun) {
    await run(null);
    return { applied: false, people, unmatched };
  }
  await prisma.$transaction((tx) => run(tx), { maxWait: 15_000, timeout: 120_000 });
  return { applied: true, people, unmatched };
}

/**
 * Supervisor for everyone with a direct report (the chart's hierarchy, every
 * deploy): the HR dashboard of their reports' attendance, leave and
 * overtime. Offered ONCE per login (the seed's never-offered rule, kept in
 * `SUPERVISOR_OFFERED`), so an administrator's revocation stays revoked.
 */
export const SUPERVISOR_OFFERED = 'seed.supervisorOffered';

export async function grantSupervisorRole(): Promise<number> {
  const role = await prisma.role.findUnique({ where: { key: 'supervisor' }, select: { id: true } });
  if (!role) return 0;
  const offeredRow = await prisma.setting.findUnique({ where: { key: SUPERVISOR_OFFERED } });
  const offered = new Set<string>((offeredRow?.value as string[] | undefined) ?? []);
  const bosses = await prisma.user.findMany({
    where: { isActive: true, reports: { some: { isActive: true } }, roles: { none: { roleId: role.id } }, id: { notIn: [...offered] } },
    select: { id: true, name: true },
  });
  if (!bosses.length) return 0;
  await prisma.$transaction(async (tx) => {
    await tx.userRole.createMany({ data: bosses.map((b) => ({ userId: b.id, roleId: role.id })), skipDuplicates: true });
    const value = [...offered, ...bosses.map((b) => b.id)];
    await tx.setting.upsert({
      where: { key: SUPERVISOR_OFFERED },
      create: { key: SUPERVISOR_OFFERED, value, description: 'seed: logins once given Supervisor for having direct reports' },
      update: { value },
    });
    await audit(
      {
        entityType: 'user',
        entityId: 'list',
        action: 'UPDATED',
        summary: `Gave Supervisor to ${bosses.length} login(s) with direct reports: ${bosses.map((b) => b.name).join(', ')}`,
      },
      undefined,
      tx,
    );
  });
  return bosses.length;
}

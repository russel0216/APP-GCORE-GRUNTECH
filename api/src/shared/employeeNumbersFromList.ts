import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { audit } from './audit';
import { setCounter } from './numbering';
import { syncLoginFromEmployee } from './accounts';
import { ORG_CHART } from './orgChart';

/**
 * The employee numbers of the owner's `ROLE.xlsx` (2026-10-18: "update the
 * employee number of the people / user from this list"), typed under the
 * GTC-0001-14 scheme after every number was cleared the same day
 * (`clearEmployeeNumbers()`). Applied ONCE by the seed (`NUMBERS_FROM_LIST_MARK`),
 * so a number corrected on Admin › Users or HR › Employees afterwards stays.
 *
 * Each person is found as the organisation chart finds them — the login by
 * the chart's email, else a login or an employee by name (trimmed,
 * single-spaced, case-blind) — and the number goes on the EMPLOYEE record,
 * mirrored to the login through `syncLoginFromEmployee()`, the employee
 * series raised to it (never lowered), one audit row each. A number another
 * employee already carries is left and named; so is a person not on file.
 */
export const NUMBERS_FROM_LIST_MARK = 'seed.employeeNumbersFromList20261018';

export const EMPLOYEE_NUMBER_LIST: [name: string, employeeNo: string][] = [
  ['Carter Gasiong', 'GTC-0001-14'],
  ['Renerose Yang', 'GTC-0007-15'],
  ['Ricardo Martinez', 'GTC-0015-17'],
  ['Brian Jay Torres', 'GTC-0039-20'],
  ['Salvador Ugaban', 'GTC-0006-15'],
  ['Rolando Tagalog', 'GTC-0074-22'],
  ['Rodrigo Catuday', 'GTC-0046-21'],
  ['Jonel Pada', 'GTC-0053-22'],
  ['Renielle Ascano', 'GTC-0075-22'],
  ['Marlon Piscos', 'GTC-0123-24'],
  ['Reagan Cajoto', 'GTC-0066-22'],
  ['Rey Guetan', 'GTC-0054-22'],
  ['Jobby Acasili', 'GTC-0126-24'],
  ['Arnel Belbes', 'GTC-0115-24'],
  ['Florencio Omega', 'GTC-0086-23'],
  ['Arturo Naanep', 'GTC-0134-24'],
  ['Christian Argente', 'GTC-0117-24'],
  ['Russel Ramirez', 'GTC-0118-24'],
  ['Apolonio Abonita', 'GTC-0125-24'],
  ['Renuel Reyes', 'GTC-0102-25'],
  ['Charlie Malubag', 'GTC-0107-23'],
  ['Aldrin Dilingon', 'GTC-0116-24'],
  ['Julius Domegina', 'GTC-0103-23'],
  ['Alvin Abajar', 'GTC-0137-24'],
  ['Joselito Madara', 'GTC-0120-25'],
  ['Jericho Naanep', 'GTC-0148-25'],
  ['John Harbie Salarzon', 'GTC-0076-23'],
  ['Loyd Francisco', 'GTC-0100-23'],
  ['Samuel Balicas', 'GTC-0047-23'],
  ['Reyniel Emhie Tolentino', 'GTC-0155-26'],
  ['Don Luigi Rio', 'GTC-0154-26'],
  ['Alexis Belbes', 'GTC-0113-24'],
  ['Emil Martinez', 'GTC-0064-22'],
  ['Paul Iver Yumul', 'GTC-0122-25'],
  ['Ammar Yasir', 'GTC-0163-26'],
  ['Mark Angelo Ursulom', 'GTC-0160-26'],
  ['Paul Ignacio Roa', 'GTC-0161-26'],
  ['Camille Guiling', 'GTC-0083-23'],
  ['Ivan Immaculata', 'GTC-0095-23'],
  ['Erica Diolata', 'GTC-0040-20'],
  ['Jerald Ventura', 'GTC-0060-22'],
  ['Rodolfo Almonte', 'GTC-0105-23'],
  ['Daniel Cabacungan', 'GTC-0124-24'],
  ['Dina Gasiong', 'GTC-0073-22'],
  ['Mylin Sarcillas', 'GTC-0106-24'],
  ['Joy Kenneth Robinos', 'GTC-0141-25'],
  ['Wenchie Marcellano', 'GTC-0099-23'],
  ['Princess Martinez', 'GTC-0072-22'],
  ['Erwenn Ann Cabal', 'GTC-0144-25'],
  ['Christine Anne Rosario', 'GTC-0156-26'],
  ['Noel Talisic', 'GTC-0025-19'],
  ['Jeric Gasiong', 'GTC-0045-21'],
  ['Karen Gasiong', 'GTC-0004-15'],
  ['Marielle Severino', 'GTC-0139-25'],
  ['Samantha Acebutch', 'GTC-0147-25'],
  ['Filipina Peleno', 'GTC-0097-23'],
  ['Rodrigo Gimenez', 'GTC-0071-22'],
  ['John Paul Macabudbod', 'GTC-0023-19'],
  ['Jovenn Grande', 'GTC-0108-24'],
  ['Ayesa Jane Yaya', 'GTC-0089-23'],
];

const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export interface NumberChange {
  name: string;
  employeeNo: string;
  before: string | null;
  login: string | null;
}

export async function applyEmployeeNumberList(opts: { dryRun?: boolean; force?: boolean } = {}): Promise<{
  applied: boolean;
  changed: NumberChange[];
  unchanged: number;
  notFound: string[];
  clashes: string[];
} | null> {
  if (!opts.dryRun && !opts.force && (await prisma.setting.findUnique({ where: { key: NUMBERS_FROM_LIST_MARK } }))) return null;

  const [users, employees] = await Promise.all([
    prisma.user.findMany({ select: { id: true, email: true, name: true, employeeNo: true } }),
    prisma.employee.findMany({ select: { id: true, firstName: true, lastName: true, userId: true, employeeNo: true } }),
  ]);
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
  const userByName = new Map(users.map((u) => [fold(u.name), u]));
  const employeeByName = new Map(employees.map((e) => [fold(`${e.firstName} ${e.lastName}`), e]));
  const emailOf = new Map(ORG_CHART.map((p) => [fold(p.name), p.email ?? null]));
  const listed = new Set(EMPLOYEE_NUMBER_LIST.map(([, no]) => no.toLowerCase()));

  const changed: NumberChange[] = [];
  const notFound: string[] = [];
  const clashes: string[] = [];
  let unchanged = 0;
  const plan: { employeeId: string; change: NumberChange }[] = [];
  const taken = new Set<string>();

  for (const [name, employeeNo] of EMPLOYEE_NUMBER_LIST) {
    const email = emailOf.get(fold(name));
    const user = (email && byEmail.get(email.toLowerCase())) || userByName.get(fold(name)) || null;
    const employee = (user && employees.find((e) => e.userId === user.id)) || employeeByName.get(fold(name)) || null;
    if (!employee) {
      notFound.push(user ? `${name} (login ${user.email}, no employee record)` : name);
      continue;
    }
    if (employee.employeeNo === employeeNo) {
      unchanged += 1;
      continue;
    }
    // Held by somebody NOT on the list: left, named. One on the list who
    // holds another's number is renumbered in the same run, so it is freed.
    const holder = employees.find((e) => e.id !== employee.id && e.employeeNo?.toLowerCase() === employeeNo.toLowerCase());
    if ((holder && !listed.has(holder.employeeNo!.toLowerCase())) || taken.has(employeeNo.toLowerCase())) {
      clashes.push(`${name}: ${employeeNo} is on ${holder ? `${holder.firstName} ${holder.lastName}` : 'another row of the list'}`);
      continue;
    }
    // A login carrying it that is not this person's — the mirror would refuse it.
    const loginHolder = users.find(
      (u) => u.id !== employee.userId && u.employeeNo?.toLowerCase() === employeeNo.toLowerCase() && !employees.some((e) => e.userId === u.id && listed.has((e.employeeNo ?? '').toLowerCase())),
    );
    if (loginHolder) {
      clashes.push(`${name}: ${employeeNo} is on the login ${loginHolder.email}`);
      continue;
    }
    taken.add(employeeNo.toLowerCase());
    const login = user?.email ?? users.find((u) => u.id === employee.userId)?.email ?? null;
    plan.push({ employeeId: employee.id, change: { name, employeeNo, before: employee.employeeNo, login } });
  }

  if (!opts.dryRun) {
    await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        // Clear first, so two people on the list swapping numbers never collide.
        await tx.employee.updateMany({ where: { id: { in: plan.map((p) => p.employeeId) } }, data: { employeeNo: null } });
        const loginIds = employees.filter((e) => e.userId && plan.some((p) => p.employeeId === e.id)).map((e) => e.userId!);
        await tx.user.updateMany({ where: { id: { in: loginIds } }, data: { employeeNo: null } });
        for (const { employeeId, change } of plan) {
          await tx.employee.update({ where: { id: employeeId }, data: { employeeNo: change.employeeNo } });
          await syncLoginFromEmployee(tx, employeeId);
          const counter = await setCounter('employee', change.employeeNo, tx, { mode: 'raise' });
          await audit(
            {
              entityType: 'employee',
              entityId: employeeId,
              action: 'UPDATED',
              summary: `Employee number set to ${change.employeeNo} from the owner's list (ROLE.xlsx, 2026-10-18)`,
              before: { employeeNo: change.before },
              after: { employeeNo: change.employeeNo, ...(counter ? { counter } : {}) },
            },
            undefined,
            tx,
          );
          changed.push(change);
        }
        await tx.setting.upsert({
          where: { key: NUMBERS_FROM_LIST_MARK },
          create: {
            key: NUMBERS_FROM_LIST_MARK,
            value: { at: new Date().toISOString(), changed: changed.length, notFound, clashes },
            description: "seed: the employee numbers of the owner's ROLE.xlsx were applied once (2026-10-18)",
          },
          update: { value: { at: new Date().toISOString(), changed: changed.length, notFound, clashes } },
        });
      },
      { maxWait: 15_000, timeout: 120_000 },
    );
  } else {
    changed.push(...plan.map((p) => p.change));
  }
  return { applied: !opts.dryRun, changed, unchanged, notFound, clashes };
}

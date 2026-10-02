/**
 * Create the accounts used to walk the whole system by hand on a laptop.
 *
 *   npx tsx scripts/seed-test-accounts.ts
 *   TEST_PASSWORD="Something!2026" npx tsx scripts/seed-test-accounts.ts
 *
 * Run it AFTER `npm run seed`, which is what creates the roles and the
 * approval workflows these accounts are only pointed at. Idempotent: an
 * account that already exists has its role, position and supervisor corrected
 * rather than duplicated, so re-running is how you repair a test login.
 *
 * Why these four and no Employee records: a User stands on its own (see the
 * `phone` comment on model User), and the quotation path needs logins and
 * roles, not payroll. Add employees from HR when you come to test HR.
 *
 * The approval route is NOT configured here. It is already seeded:
 *   "Quotation — sales manager"                  → sales_manager decides
 *   "Quotation — over PHP 1,000,000, with the CEO" → sales_manager then executive
 * This script only supplies someone to fill each of those roles.
 */

import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';

const PASSWORD = process.env.TEST_PASSWORD ?? 'Test!2026';

interface AccountSeed {
  email: string;
  name: string;
  position: string;
  /** Role key from prisma/seed.ts ROLES. Omitted for the super admin, whose
   *  access comes from isSuperAdmin rather than from any role. */
  roleKey?: string;
  isSuperAdmin?: boolean;
  /** Email of this account's approver, so SUPERVISOR-routed documents
   *  (leave, overtime) have somewhere to go during testing too. */
  supervisorEmail?: string;
  note: string;
}

const ACCOUNTS: AccountSeed[] = [
  {
    email: 'admin@gruntech.com',
    name: 'System Administrator',
    position: 'Super Admin',
    isSuperAdmin: true,
    note: 'Everything, including Admin > Approval Workflows and Roles',
  },
  {
    email: 'ceo@gruntech.com',
    name: 'Chief Executive',
    position: 'Chief Executive Officer',
    roleKey: 'executive',
    note: 'Second approver on a quotation over PHP 1,000,000',
  },
  {
    email: 'manager@gruntech.com',
    name: 'Sales Manager',
    position: 'Sales Manager',
    roleKey: 'sales_manager',
    supervisorEmail: 'ceo@gruntech.com',
    note: 'First (and for most quotations only) approver',
  },
  {
    email: 'engineer@gruntech.com',
    name: 'Project Engineer',
    position: 'Project Engineer',
    roleKey: 'project_engineer',
    // Should be a Project Manager in a real org chart; there is no PM account
    // yet, so leave and overtime route up to the CEO for now.
    supervisorEmail: 'ceo@gruntech.com',
    note: 'Progress reports, plans, purchase requests - view/edit own only',
  },
  {
    email: 'sales@gruntech.com',
    name: 'Sales Executive',
    position: 'Sales Executive',
    roleKey: 'sales',
    supervisorEmail: 'manager@gruntech.com',
    note: 'Raises leads, customers and quotations; approves nothing',
  },
];

(async () => {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // Two passes: create every account first, then wire the supervisor links,
  // because an account's approver may sit later in the list.
  for (const a of ACCOUNTS) {
    const role = a.roleKey
      ? await prisma.role.findUnique({ where: { key: a.roleKey } })
      : null;
    if (a.roleKey && !role) {
      throw new Error(
        `Role "${a.roleKey}" is missing. Run \`npm run seed\` first — it is what creates the roles.`
      );
    }

    const user = await prisma.user.upsert({
      where: { email: a.email },
      create: {
        email: a.email,
        name: a.name,
        position: a.position,
        passwordHash,
        isSuperAdmin: a.isSuperAdmin ?? false,
        isActive: true,
      },
      // Re-running resets the password and the flags, which is the repair path.
      update: {
        name: a.name,
        position: a.position,
        passwordHash,
        isSuperAdmin: a.isSuperAdmin ?? false,
        isActive: true,
        invitePending: false,
      },
    });

    // Exactly one role per test account: leftover roles from an earlier run
    // would quietly widen what the account can do and hide a permission bug.
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    if (role) {
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
    }
  }

  for (const a of ACCOUNTS.filter((x) => x.supervisorEmail)) {
    const supervisor = await prisma.user.findUniqueOrThrow({
      where: { email: a.supervisorEmail! },
      select: { id: true },
    });
    await prisma.user.update({
      where: { email: a.email },
      data: { supervisorId: supervisor.id },
    });
  }

  console.log(`\n  ${ACCOUNTS.length} test accounts ready — password is the same for all:\n`);
  console.log(`    ${'EMAIL'.padEnd(24)} ${'ROLE'.padEnd(17)} WHAT IT IS FOR`);
  for (const a of ACCOUNTS) {
    console.log(`    ${a.email.padEnd(24)} ${(a.roleKey ?? 'super admin').padEnd(17)} ${a.note}`);
  }
  console.log(`\n    Password: ${PASSWORD}\n`);

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});

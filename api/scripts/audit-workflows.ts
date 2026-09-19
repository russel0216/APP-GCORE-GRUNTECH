/**
 * Audits every active approval workflow for routing that cannot work.
 *
 *   npx tsx scripts/audit-workflows.ts
 *
 * Two seeded workflows shipped with the same latent fault — a step routed to
 * the very role that normally raises the document, so the only eligible
 * approver was the requester and nothing could move. Both were found one at a
 * time, by a document refusing to submit. This finds the rest at once.
 *
 * Read-only. Safe to run against production.
 */

import { prisma } from '../src/prisma';

/**
 * Who normally raises each document type. Not a rule the system enforces —
 * just the realistic case, which is what a routing check has to consider.
 */
const TYPICAL_REQUESTER: Record<string, string[]> = {
  leave_request: ['employee', 'supervisor', 'project_engineer', 'service_engineer'],
  overtime_request: ['employee', 'project_engineer', 'service_engineer'],
  purchase_request: ['project_engineer', 'project_manager', 'service_engineer', 'procurement'],
  budget_request: ['project_manager'],
  quotation: ['sales', 'sales_manager'],
  purchase_order: ['procurement'],
  expense: ['employee', 'project_engineer', 'sales'],
};

async function main() {
  const workflows = await prisma.approvalWorkflow.findMany({
    where: { isActive: true },
    include: {
      steps: { orderBy: { sequence: 'asc' }, include: { role: true, user: true } },
    },
    orderBy: [{ documentType: 'asc' }, { name: 'asc' }],
  });

  const roleMembers = new Map<string, string[]>();
  for (const role of await prisma.role.findMany({
    include: { users: { where: { user: { isActive: true } }, include: { user: true } } },
  })) {
    roleMembers.set(role.key, role.users.map((u) => u.user.name));
  }

  let problems = 0;
  console.log('\nApproval workflow routing audit\n');

  for (const wf of workflows) {
    const issues: string[] = [];

    for (const step of wf.steps) {
      if (step.approverType === 'ROLE') {
        const key = step.role?.key;
        const members = key ? (roleMembers.get(key) ?? []) : [];

        if (members.length === 0) {
          issues.push(
            `step ${step.sequence} "${step.name}" routes to ${step.role?.name ?? 'a deleted role'}, which nobody holds — documents will stall`,
          );
        } else if (members.length === 1) {
          // One holder is only a problem if they are also the likely requester.
          const likely = TYPICAL_REQUESTER[wf.documentType] ?? [];
          if (key && likely.includes(key)) {
            issues.push(
              `step ${step.sequence} "${step.name}" routes to ${step.role?.name} — the role that normally RAISES this document — and only ${members[0]} holds it, so they would be approving their own work`,
            );
          }
        }

        // The structural version of the same fault, independent of headcount.
        const likely = TYPICAL_REQUESTER[wf.documentType] ?? [];
        if (step.sequence === 1 && key && likely.length === 1 && likely[0] === key) {
          issues.push(
            `step 1 routes to ${step.role?.name}, which is the only role that raises this document — nobody could ever approve it`,
          );
        }
      }

      if (step.approverType === 'USER' && !step.user) {
        issues.push(`step ${step.sequence} "${step.name}" names a person who no longer exists`);
      }
      if (step.approverType === 'HR' && (roleMembers.get('hr') ?? []).length === 0) {
        issues.push(`step ${step.sequence} "${step.name}" routes to HR, which nobody holds`);
      }
    }

    if (wf.steps.length === 0) {
      issues.push('has no steps — nothing can route through it');
    }

    const route = wf.steps
      .map((s) => `${s.sequence}. ${s.role?.key ?? s.user?.name ?? s.approverType.toLowerCase()}`)
      .join(' → ');

    if (issues.length) {
      problems += issues.length;
      console.log(`  ✗ ${wf.documentType} — ${wf.name}`);
      console.log(`      ${route}`);
      for (const i of issues) console.log(`      · ${i}`);
    } else {
      console.log(`  ✓ ${wf.documentType} — ${wf.name}`);
      console.log(`      ${route}`);
    }
  }

  console.log(
    problems === 0
      ? '\nNo routing problems found.\n'
      : `\n${problems} problem(s) found. Fix them in Admin › Approval Workflows, or give someone the role.\n`,
  );
  if (problems > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

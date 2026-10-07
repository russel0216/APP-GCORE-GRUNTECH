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
  // Project cash: the team asks, so engineers raise them as often as the PM.
  budget_request: ['project_manager', 'project_engineer'],
  quotation: ['sales', 'sales_manager'],
  sales_order: ['sales', 'sales_manager'],
  costing: ['sales', 'sales_manager', 'project_manager'],
  purchase_order: ['procurement'],
  expense: ['employee', 'project_engineer', 'sales'],
  // A supplier's invoice arrives in finance, so finance keys it in. Routing a
  // step back to finance is the same fault the budget-request and
  // purchase-order workflows both shipped with.
  supplier_bill: ['finance', 'procurement'],
  cash_advance: ['employee', 'project_engineer', 'service_engineer', 'sales', 'project_manager', 'finance'],
  job_order: ['sales', 'sales_manager', 'service_engineer'],
  // HR raises a clearance for an employee with no login, and an evaluation
  // for one with no supervisor — so HR is a requester on both, and a lone HR
  // holder would be approving their own work.
  clearance: ['employee', 'hr'],
  evaluation: ['supervisor', 'project_manager', 'service_manager', 'sales_manager', 'hr'],
  training_certification: ['employee', 'trainer', 'supervisor', 'project_engineer', 'service_engineer'],
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

  // SUPERVISOR falls back to HR when the requester has no supervisor set. That
  // fallback is only a fallback if somebody holds HR — otherwise anyone without
  // a supervisor files into a void.
  const hrHolders = (roleMembers.get('hr') ?? []).length;
  const unsupervised = await prisma.user.count({ where: { isActive: true, supervisorId: null } });
  // A PROJECT_MANAGER step needs the project to name one.
  const unmanagedJobs = await prisma.job.count({
    where: { projectManagerId: null, status: { in: ['PLANNING', 'IN_PROGRESS'] } },
  });

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
      if (step.approverType === 'HR' && hrHolders === 0) {
        issues.push(`step ${step.sequence} "${step.name}" routes to HR, which nobody holds`);
      }
      // The HR-typed version of the single-holder fault: on a document HR
      // sometimes raises, one HR holder is the requester and the approver.
      if (
        step.approverType === 'HR' &&
        hrHolders === 1 &&
        (TYPICAL_REQUESTER[wf.documentType] ?? []).includes('hr')
      ) {
        issues.push(
          `step ${step.sequence} "${step.name}" routes to HR, which only one person holds — when HR raises this document they would be approving their own work`,
        );
      }
      // A SUPERVISOR step that names a role falls back to that role, not HR.
      if (step.approverType === 'SUPERVISOR' && step.role) {
        const fallback = roleMembers.get(step.role.key) ?? [];
        if (fallback.length === 0 && unsupervised > 0) {
          issues.push(
            `step ${step.sequence} "${step.name}" routes to each requester's supervisor, but ${unsupervised} active user(s) have none — and the ${step.role.name} fallback is unheld, so their documents route to nobody`,
          );
        } else if (fallback.length === 1 && (TYPICAL_REQUESTER[wf.documentType] ?? []).includes(step.role.key)) {
          issues.push(
            `step ${step.sequence} "${step.name}" falls back to ${step.role.name}, which only ${fallback[0]} holds — set their "Reports to", or a document they raise has nobody to approve it`,
          );
        }
      } else if (step.approverType === 'SUPERVISOR' && hrHolders === 0 && unsupervised > 0) {
        issues.push(
          `step ${step.sequence} "${step.name}" routes to each requester's supervisor, but ${unsupervised} active user(s) have none — and the HR fallback is unheld, so their documents route to nobody`,
        );
      }
      // A PROJECT_MANAGER step resolves to the project's own manager and falls
      // back to its role (Executive unless another is named) when the project
      // has none or the manager raised the document. The fallback has to be
      // held: a PM's own request, or one on an unmanaged project, goes there.
      if (step.approverType === 'PROJECT_MANAGER') {
        const fallbackKey = step.role?.key ?? 'executive';
        const fallback = roleMembers.get(fallbackKey) ?? [];
        if (fallback.length === 0) {
          issues.push(
            `step ${step.sequence} "${step.name}" routes to the project's manager and falls back to ${step.role?.name ?? 'Executive / Management'}, which nobody holds — a project manager's own request, or one on a project with no manager, routes to nobody`,
          );
        }
        if (unmanagedJobs > 0) {
          issues.push(
            `step ${step.sequence} "${step.name}" routes to the project's manager, but ${unmanagedJobs} active project(s) have none set — their requests go to the ${step.role?.name ?? 'Executive / Management'} fallback`,
          );
        }
      }
    }

    if (wf.steps.length === 0) {
      issues.push('has no steps — nothing can route through it');
    }

    const route = wf.steps
      .map((s) =>
        s.approverType === 'SUPERVISOR'
          ? `${s.sequence}. supervisor, else ${s.role?.key ?? 'hr'}`
          : s.approverType === 'PROJECT_MANAGER'
            ? `${s.sequence}. the project's manager, else ${s.role?.key ?? 'executive'}`
            : `${s.sequence}. ${s.role?.key ?? s.user?.name ?? s.approverType.toLowerCase()}`,
      )
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

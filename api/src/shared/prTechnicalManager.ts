import { prisma } from '../prisma';
import { audit } from './audit';

/**
 * A purchase request's Technical Manager is the PROJECT's (2026-11-19, the
 * owner's call: "I want the technical manager who will approve is the Team
 * Technical Manager who owns the project" — Jhon Russel, a SIT engineer,
 * raised one on another team's project and the route named SIT's Technical
 * Manager, Carter, because the step read the requester's team).
 *
 * The step type that says so already exists — PROJECT_MANAGER, "The
 * Technical Manager on the document or project", its role the fallback — and
 * the request now names its project at submit. This moves every purchase
 * request route's Technical Manager ROLE step onto it, ONCE (marked), in
 * place: the step keeps its row, sequence, name and role, so a request
 * pending at it stays at it (one submitted before carries no project and
 * keeps going to the requester's team's Technical Manager). A route an
 * administrator changes afterwards is left as they set it.
 */
export const PR_TECHNICAL_MANAGER_MARK = 'seed.prTechnicalManagerByProject20261119';

export async function routePurchaseRequestsByProject(): Promise<number | null> {
  if (await prisma.setting.findUnique({ where: { key: PR_TECHNICAL_MANAGER_MARK } })) return null;
  const tm = await prisma.role.findUnique({ where: { key: 'technical_manager' }, select: { id: true } });
  const steps = tm
    ? await prisma.approvalStep.findMany({
        where: { approverType: 'ROLE', roleId: tm.id, workflow: { documentType: 'purchase_request' } },
        select: { id: true, sequence: true, name: true, workflow: { select: { id: true, name: true } } },
      })
    : [];
  for (const step of steps) {
    await prisma.approvalStep.update({ where: { id: step.id }, data: { approverType: 'PROJECT_MANAGER' } });
    await audit({
      entityType: 'approval_workflow',
      entityId: step.workflow.id,
      action: 'UPDATED',
      summary: `${step.workflow.name}: step ${step.sequence} ("${step.name}") goes to the Technical Manager of the project the request buys for — else the one on the team that owns it`,
      before: { sequence: step.sequence, approverType: 'ROLE' },
      after: { sequence: step.sequence, approverType: 'PROJECT_MANAGER' },
    });
  }
  await prisma.setting.create({
    data: {
      key: PR_TECHNICAL_MANAGER_MARK,
      value: { at: new Date().toISOString(), steps: steps.length },
      description: "seed: a purchase request's Technical Manager step moved to the project's Technical Manager once",
    },
  });
  return steps.length;
}

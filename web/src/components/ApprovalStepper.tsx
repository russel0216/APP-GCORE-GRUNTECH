import { Fragment, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatDateTime } from './ui';

/**
 * The approval chain, in two parts.
 *
 * `ApprovalStepper` is presentational: hand it steps, it draws them. It knows
 * nothing about the API, which is what makes it usable for a chain that has
 * not been saved yet — the workflow editor previewing a routing, or a form
 * showing where a document *would* go once submitted.
 *
 * `DocumentApproval` is the wired one: give it a document type and id and it
 * reads the real chain, with the outcome, the workflow that routed it and any
 * comment an approver left.
 *
 * Both are read-only. Approving happens in My Work, where the approver's queue
 * lives; an Approve button here would be a second approval path, and there is
 * exactly one of those (`api/src/shared/approvals.ts`).
 */

export interface Step {
  label: string;
  /** Who acted and when — or who it is waiting on. */
  approver?: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'WAITING';
}

/** `APPROVED` → `approved`, matching the class names in styles.css. */
const CLASS: Record<Step['status'], string> = {
  APPROVED: 'approved',
  PENDING: 'pending',
  REJECTED: 'rejected',
  WAITING: 'waiting',
};

export function ApprovalStepper({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;

  return (
    // An ordered list, because that is what this is. The dividers are siblings
    // of the steps rather than children: `.step-divider` is `flex: 1`, and it
    // can only take up the slack as a flex item of `.stepper` itself.
    <ol className="stepper" aria-label="Approval progress">
      {steps.map((step, idx) => (
        <Fragment key={`${idx}-${step.label}`}>
          <li className={`step-item ${CLASS[step.status]}`}>
            {/* Decoration. The status is already in the text below it, and a
                screen reader announcing "✓" adds nothing. */}
            <span className="step-node" aria-hidden="true">
              {step.status === 'APPROVED' ? '✓' : step.status === 'REJECTED' ? '✕' : idx + 1}
            </span>
            <div className="step-body">
              <strong className="step-name">{step.label}</strong>
              {/* Every state says what it is in WORDS as well as in colour.
                  Roughly one man in twelve cannot separate the neon from the
                  magenta, and a stepper that signals only by hue tells them
                  nothing at all. */}
              <span className="step-who">
                {step.status === 'REJECTED' && 'Rejected — '}
                {step.approver ?? (step.status === 'WAITING' ? 'Not yet' : '')}
              </span>
            </div>
          </li>
          {idx < steps.length - 1 && (
            <li
              aria-hidden="true"
              className={`step-divider${step.status === 'APPROVED' ? ' active' : ''}`}
            />
          )}
        </Fragment>
      ))}
    </ol>
  );
}

// ── The wired version ────────────────────────────────────────────────────────

interface Action {
  id: string;
  sequence: number;
  action: 'APPROVED' | 'REJECTED' | 'RETURNED';
  comment: string | null;
  actedAt: string;
  approver: { id: string; name: string };
}

interface WorkflowStep {
  id: string;
  sequence: number;
  name: string;
}

interface Request {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  currentSequence: number;
  createdAt: string;
  requester: { id: string; name: string };
  workflow: { name: string; steps: WorkflowStep[] } | null;
  actions: Action[];
}

/**
 * Reads `GET /approvals/history/:documentType/:documentId` — an endpoint that
 * has been served since Phase 1 and that nothing in the web app ever called,
 * so "who is sitting on this, and since when" could only be answered by asking
 * the person.
 *
 * Silent when there is nothing to show: a document that was never submitted has
 * no chain, and an empty rail on a draft is noise.
 */
export function DocumentApproval({
  documentType,
  documentId,
  /** Bump to re-read after a submit elsewhere on the page. */
  reloadToken = 0,
  /**
   * Drawn inside something that is already a container — an expanded table
   * row, a panel — rather than as a card of its own: no card chrome, so it
   * does not sit as a box within a box.
   */
  compact = false,
}: {
  documentType: string;
  documentId: string;
  reloadToken?: number;
  compact?: boolean;
}) {
  const [requests, setRequests] = useState<Request[] | null>(null);

  useEffect(() => {
    let live = true;
    api
      .get<Request[]>(`/approvals/history/${documentType}/${documentId}`)
      .then((rows) => live && setRequests(rows))
      // The chain is context, not the record. If it cannot be read, the page it
      // decorates is still perfectly usable — an error banner here would be
      // louder than the information is worth.
      .catch(() => live && setRequests([]));
    return () => {
      live = false;
    };
  }, [documentType, documentId, reloadToken]);

  if (!requests || requests.length === 0) return null;

  // historyFor returns newest first. The one that counts is the latest
  // submission: a document rejected and resubmitted is judged on the attempt in
  // flight, not on the one it already failed.
  const request = requests[0];
  const workflowSteps = request.workflow?.steps ?? [];
  if (workflowSteps.length === 0) return null;

  /*
    A request can be settled with NO recorded actions — seeded data, or a
    document migrated in rather than approved through the engine. Left alone,
    every step then reads "Not yet" on a document whose own badge says
    Approved, which is a straight contradiction on screen. Saying "we do not
    know who" is honest; showing an approved document as still queued is not.
  */
  const unrecorded = request.actions.length === 0 && request.status !== 'PENDING';

  /** When the ball last moved — the submission, or the most recent decision. */
  const lastEventAt = () => {
    const last = request.actions[request.actions.length - 1];
    return last ? last.actedAt : request.createdAt;
  };

  const steps: Step[] = workflowSteps.map((step) => {
    const acted = request.actions.find((a) => a.sequence === step.sequence);
    if (acted) {
      return {
        label: step.name,
        approver: `${acted.approver.name} · ${formatDateTime(new Date(acted.actedAt))}`,
        status: acted.action === 'REJECTED' ? 'REJECTED' : 'APPROVED',
      };
    }
    if (unrecorded) {
      return {
        label: step.name,
        approver: 'Approver not recorded',
        status: request.status === 'APPROVED' ? 'APPROVED' : 'REJECTED',
      };
    }
    if (request.status === 'PENDING' && step.sequence === request.currentSequence) {
      return {
        label: step.name,
        approver: `Waiting since ${formatDateTime(new Date(lastEventAt()))}`,
        status: 'PENDING',
      };
    }
    return { label: step.name, status: 'WAITING' };
  });

  const outcome =
    request.status === 'APPROVED'
      ? 'Approved'
      : request.status === 'REJECTED'
        ? 'Rejected'
        : request.status === 'CANCELLED'
          ? 'Cancelled'
          : `Step ${request.currentSequence} of ${workflowSteps.length}`;

  const tone =
    request.status === 'APPROVED'
      ? 'ok'
      : request.status === 'REJECTED'
        ? 'danger'
        : request.status === 'CANCELLED'
          ? ''
          : 'warn';

  return (
    <section className={compact ? 'panel-block' : 'card panel-block'} aria-label="Approval">
      <div className="panel-head">
        <h3 className="card-title">Approval</h3>
        <span className={`badge ${tone}`}>{outcome}</span>
      </div>

      <p className="panel-blurb">
        {request.workflow?.name} · raised by {request.requester.name} on{' '}
        {formatDateTime(new Date(request.createdAt))}
        {requests.length > 1 && ` · attempt ${requests.length}`}
      </p>

      {unrecorded && (
        <p className="panel-blurb">
          <em>
            Settled without a recorded approver — this document was not raised through the approval
            engine.
          </em>
        </p>
      )}

      <ApprovalStepper steps={steps} />

      {/* A comment is usually why something was sent back, so it is not hidden
          behind a hover. */}
      {request.actions
        .filter((a) => a.comment)
        .map((a) => (
          <div key={a.id} className={`alert ${a.action === 'REJECTED' ? 'error' : 'info'}`}>
            <strong>{a.approver.name}</strong> — {a.comment}
          </div>
        ))}
    </section>
  );
}

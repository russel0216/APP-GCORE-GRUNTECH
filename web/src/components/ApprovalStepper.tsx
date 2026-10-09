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
 * `ApprovalStepper` is read-only. `DocumentApproval` also lets the person the
 * current step is waiting on decide right there (2026-10-06, the owner's
 * call): the approval notification lands on the document, and the approver
 * should not have to go back to My Work after reading it. It posts to the
 * same `POST /approvals/:id/act` My Work uses — one approval path
 * (`api/src/shared/approvals.ts`), two places to reach it. The API says who
 * may (`canAct` on the history), never the page.
 */

export interface Step {
  label: string;
  /** Who acted and when — or who it is waiting on. */
  approver?: string;
  /**
   * RETURNED is an approver sending the document back to be changed and
   * submitted again — neither an approval nor a rejection.
   */
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'RETURNED' | 'WAITING';
}

/** `APPROVED` → `approved`, matching the class names in styles.css. */
const CLASS: Record<Step['status'], string> = {
  APPROVED: 'approved',
  PENDING: 'pending',
  REJECTED: 'rejected',
  RETURNED: 'returned',
  WAITING: 'waiting',
};

/** A decided step's mark. A step still to come shows its number instead. */
const MARK: Partial<Record<Step['status'], string>> = {
  APPROVED: '✓',
  REJECTED: '✕',
  // U+FE0E asks for the plain glyph: bare, ↩ can come out as a coloured emoji
  // where the font falls back to one.
  RETURNED: '↩\uFE0E',
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
              {MARK[step.status] ?? idx + 1}
            </span>
            <div className="step-body">
              <strong className="step-name">{step.label}</strong>
              {/* Every state says what it is in WORDS as well as in colour.
                  Roughly one man in twelve cannot separate the neon from the
                  magenta, and a stepper that signals only by hue tells them
                  nothing at all. */}
              <span className="step-who">
                {step.status === 'REJECTED' && 'Rejected — '}
                {step.status === 'RETURNED' && 'Returned — '}
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
  /** On an open request, a step not yet taken: who may decide it. Empty: nobody can. */
  approvers?: { id: string; name: string }[];
}

interface Request {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  currentSequence: number;
  createdAt: string;
  requester: { id: string; name: string };
  workflow: { name: string; steps: WorkflowStep[] } | null;
  actions: Action[];
  /** The viewer may decide the step this request is at (computed by the API). */
  canAct?: boolean;
}

type Decision = 'APPROVED' | 'RETURNED' | 'REJECTED';
const DECISION_VERB: Record<Decision, string> = { APPROVED: 'Approve', RETURNED: 'Return', REJECTED: 'Reject' };

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
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [decideError, setDecideError] = useState<string | null>(null);

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
    A CANCELLED request with none is not one of those: it was withdrawn before
    anybody decided — a later revision raised, a filing cancelled.
  */
  const unrecorded = request.actions.length === 0 && (request.status === 'APPROVED' || request.status === 'REJECTED');

  // act() closes a returned request CANCELLED, the status a withdrawal leaves
  // too, so the last action is what tells them apart: sent back by an approver
  // to be changed and submitted again, or withdrawn before anybody decided.
  const lastAction = request.actions[request.actions.length - 1];
  const returned = request.status === 'CANCELLED' && lastAction?.action === 'RETURNED';

  /** When the ball last moved — the submission, or the most recent decision. */
  const lastEventAt = () => (lastAction ? lastAction.actedAt : request.createdAt);

  // Who a step waits on, by name: "Cecilia Tan", or "Cecilia Tan or Juan Cruz"
  // where any of several may decide. Null when the API did not say.
  const who = (step: WorkflowStep) =>
    step.approvers === undefined ? null : step.approvers.length ? step.approvers.map((p) => p.name).join(' or ') : '';

  const steps: Step[] = workflowSteps.map((step) => {
    const acted = request.actions.find((a) => a.sequence === step.sequence);
    if (acted) {
      return {
        label: step.name,
        approver: `${acted.approver.name} · ${formatDateTime(new Date(acted.actedAt))}`,
        // The action as taken. Folding RETURNED into APPROVED drew a document
        // sent back for changes with the tick of one that had passed.
        status: acted.action,
      };
    }
    if (unrecorded) {
      return {
        label: step.name,
        approver: 'Approver not recorded',
        status: request.status === 'APPROVED' ? 'APPROVED' : 'REJECTED',
      };
    }
    if (request.status === 'CANCELLED' && step.sequence === request.currentSequence) {
      return { label: step.name, approver: 'Withdrawn before a decision', status: 'WAITING' };
    }
    if (request.status === 'PENDING' && step.sequence === request.currentSequence) {
      const names = who(step);
      const since = formatDateTime(new Date(lastEventAt()));
      return {
        label: step.name,
        approver:
          names === null
            ? `Waiting since ${since}`
            : names
              ? `Waiting on ${names} since ${since}`
              : `Waiting since ${since} — nobody can approve this step`,
        status: 'PENDING',
      };
    }
    if (request.status === 'PENDING') {
      const names = who(step);
      if (names !== null) return { label: step.name, approver: names ? `Then ${names}` : 'Nobody can approve this step', status: 'WAITING' };
    }
    return { label: step.name, status: 'WAITING' };
  });

  const outcome =
    request.status === 'APPROVED'
      ? 'Approved'
      : request.status === 'REJECTED'
        ? 'Rejected'
        : returned
          ? 'Returned'
          : request.status === 'CANCELLED'
            ? 'Cancelled'
            : `Step ${request.currentSequence} of ${workflowSteps.length}`;

  // Returned is amber, as it is on every other badge that says it: the
  // document is waiting again, this time on the person who raised it.
  const tone =
    request.status === 'APPROVED'
      ? 'ok'
      : request.status === 'REJECTED'
        ? 'danger'
        : returned
          ? 'warn'
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

      {request.status === 'PENDING' && request.canAct && (
        <div className="approval-decide" role="group" aria-label="Your decision">
          {deciding === null ? (
            <>
              <p className="panel-blurb">This step is waiting on you.</p>
              <div className="row approval-decide-buttons">
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setDeciding('APPROVED')}>
                  Approve
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setDeciding('RETURNED')}>
                  Return
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setDeciding('REJECTED')}>
                  Reject
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="approval-decide-label" htmlFor={`decide-${request.id}`}>
                {DECISION_VERB[deciding]} — comment {deciding === 'APPROVED' ? '(optional)' : '(say what needs to change)'}
              </label>
              <textarea
                id={`decide-${request.id}`}
                value={comment}
                autoFocus
                onChange={(e) => setComment(e.target.value)}
                placeholder={deciding === 'APPROVED' ? 'Anything the requester should know' : 'This is what the requester sees'}
              />
              {decideError && <div className="alert error">{decideError}</div>}
              {/* The confirm grammar of rule 19: [Keep it] then the decision itself, on the right. */}
              <div className="panel-foot approval-decide-buttons">
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setDeciding(null); setDecideError(null); }}>
                  Keep it
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${deciding === 'APPROVED' ? 'btn-primary' : deciding === 'REJECTED' ? 'btn-danger' : ''}`}
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setDecideError(null);
                    try {
                      await api.post(`/approvals/${request.id}/act`, { action: deciding, comment: comment.trim() || undefined });
                      // The document's own status moves with the decision — read the page again.
                      window.location.reload();
                    } catch (err) {
                      setDecideError(err instanceof Error ? err.message : 'The decision was not recorded');
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? 'Working…' : DECISION_VERB[deciding]}
                </button>
              </div>
              <p className="faint">Recorded against the document permanently, with your name and the time.</p>
            </>
          )}
        </div>
      )}

      {/* A comment is usually why something was sent back, so it is not hidden
          behind a hover. */}
      {request.actions
        .filter((a) => a.comment)
        .map((a) => (
          <div
            key={a.id}
            className={`alert ${a.action === 'REJECTED' ? 'error' : a.action === 'RETURNED' ? 'warn' : 'info'}`}
          >
            <strong>{a.approver.name}</strong> — {a.comment}
          </div>
        ))}
    </section>
  );
}

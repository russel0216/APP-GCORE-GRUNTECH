import { Fragment, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatDateTime } from './ui';
import { useConfirm } from './Confirm';

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

// ── A route before anybody submits ───────────────────────────────────────────

/** A route as a page previews it (`approvalRoutes` on a record): names only. */
export interface PreviewRoute {
  name: string;
  /** `held`: the submitter holds this step and signs it on submitting. */
  steps: { name: string; held?: boolean; approvers: { id: string; name: string }[] }[];
}

/**
 * The steps "Submit for approval sends it to …" draws: who decides each, and
 * a step the submitter holds as theirs, signed on submitting with the same
 * time as Prepared by (2026-10-12) — one rule for the quotation and the sales
 * order pages.
 */
export function previewSteps(route: PreviewRoute): Step[] {
  return route.steps.map((st) => ({
    label: st.name,
    approver: st.held
      ? 'You — signed when you submit'
      : st.approvers.length
        ? st.approvers.map((p) => p.name).join(' or ')
        : 'Nobody — no one else holds this role',
    status: 'WAITING',
  }));
}

/** Every step is the submitter's own: Submit approves it at once. */
export const allHeld = (route: PreviewRoute | null | undefined) => !!route?.steps.length && route.steps.every((st) => st.held);

// ── The wired version ────────────────────────────────────────────────────────

interface Action {
  id: string;
  sequence: number;
  action: 'APPROVED' | 'REJECTED' | 'RETURNED';
  comment: string | null;
  actedAt: string;
  approver: { id: string; name: string };
  /** Signed by the preparer when they submitted — they hold this step. */
  selfSigned?: boolean;
  /** Signed with the same person's Approve on an earlier step (the step's sequence): one signature per person. */
  coSignedWith?: number | null;
  /** A stand-in's decision: the approver they decided in place of. */
  onBehalfOf?: { id: string; name: string } | null;
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
  /** The viewer may pull this APPROVED document back to draft (2026-10-16). */
  canReopen?: boolean;
  /** The requester may follow the open step up to the approver's manager (2026-10-17). */
  canFollowUp?: boolean;
  /** The follow-ups sent: the step, who sent it, to whom, when, the note. */
  followUps?: { id: string; sequence: number; createdAt: string; note: string | null; by: { id: string; name: string }; to: { id: string; name: string }[] }[];
  /** Set when an approved document was pulled back to draft. */
  reopenedAt?: string | null;
  reopenReason?: string | null;
  reopenedBy?: string | null;
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
  // Asking is the one confirm bar of rule 19 (2026-10-16, the review): the
  // decision's comment and the pull-back's reason are its reason box.
  const confirm = useConfirm();

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
      const when = formatDateTime(new Date(acted.actedAt)) + (acted.comment ? ` — “${acted.comment}”` : '');
      return {
        label: step.name,
        approver: acted.selfSigned
          ? `${acted.approver.name} · signed on submitting · ${when}`
          : acted.coSignedWith != null
            ? `${acted.approver.name} · signed with ${workflowSteps.find((w) => w.sequence === acted.coSignedWith)?.name ?? 'an earlier step'} · ${when}`
            : acted.onBehalfOf
              ? `${acted.approver.name}, for ${acted.onBehalfOf.name} · ${when}`
              : `${acted.approver.name} · ${when}`,
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
          <p className="panel-blurb">This step is waiting on you.</p>
          <div className="row approval-decide-buttons">
            {(['APPROVED', 'RETURNED', 'REJECTED'] as Decision[]).map((decision) => (
              <button
                key={decision}
                type="button"
                className={`btn btn-sm${decision === 'APPROVED' ? ' btn-primary' : decision === 'REJECTED' ? ' btn-danger' : ''}`}
                onClick={() =>
                  confirm.ask({
                    title: `${DECISION_VERB[decision]} this step?`,
                    body: 'Recorded against the document permanently, with your name and the time.',
                    confirmLabel: DECISION_VERB[decision],
                    tone: decision === 'APPROVED' ? 'primary' : 'danger',
                    // Sent back or refused, the requester is owed the why.
                    reason: decision === 'APPROVED' ? 'optional' : 'required',
                    reasonLabel:
                      decision === 'APPROVED'
                        ? 'Comment (optional) — anything the requester should know'
                        : 'Comment — say what needs to change; this is what the requester sees',
                    onConfirm: async (comment) => {
                      await api.post(`/approvals/${request.id}/act`, { action: decision, comment: comment.trim() || undefined });
                      // The document's own status moves with the decision — read the page again.
                      window.location.reload();
                    },
                  })
                }
              >
                {DECISION_VERB[decision]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The requester's follow-up (2026-10-17, the owner's call): the
          approver's manager is never shown or queued until the requester asks
          — then they are told and may decide the step in the approver's place. */}
      {request.status === 'PENDING' && request.canFollowUp && (
        <div className="approval-decide" role="group" aria-label="Follow up">
          <p className="panel-blurb">
            Is the approver away? Follow up to their manager, who can decide this step in their place.
          </p>
          <div className="row approval-decide-buttons">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                confirm.ask({
                  title: 'Follow up to the approver’s manager?',
                  body: 'Their manager is told and can approve, return or reject this step in their place. Once a day per step.',
                  confirmLabel: 'Follow up',
                  reason: 'optional',
                  reasonLabel: 'Note (optional) — why it is urgent, or what you know',
                  onConfirm: async (note) => {
                    await api.post(`/approvals/${request.id}/follow-up`, { note: note.trim() || undefined });
                    window.location.reload();
                  },
                })
              }
            >
              Follow up
            </button>
          </div>
        </div>
      )}

      {(request.followUps ?? []).map((f) => (
        <div key={f.id} className="alert info">
          <strong>{f.by.name}</strong> followed up {workflowSteps.find((w) => w.sequence === f.sequence)?.name ?? `step ${f.sequence}`} to{' '}
          {f.to.map((t) => t.name).join(' and ')} on {formatDateTime(new Date(f.createdAt))}
          {f.note ? ` — “${f.note}”` : ''}
        </div>
      ))}

      {/* Pull back to draft after approval (2026-10-16, the owner's call):
          the engine's one path, the module's own refusals shown here. */}
      {request.status === 'APPROVED' && request.canReopen && (
        <div className="approval-decide" role="group" aria-label="Pull back to draft">
          <div className="row approval-decide-buttons">
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() =>
                confirm.ask({
                  title: 'Pull it back to draft?',
                  body: 'What the approval did is undone, and it goes through approval again.',
                  confirmLabel: 'Pull back to draft',
                  reason: 'required',
                  reasonLabel: 'Why?',
                  onConfirm: async (reason) => {
                    await api.post(`/approvals/reopen/${documentType}/${documentId}`, { reason: reason.trim() });
                    window.location.reload();
                  },
                })
              }
            >
              Pull back to draft
            </button>
          </div>
        </div>
      )}

      {confirm.bar}

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

/**
 * The approver's word when a document came back (2026-10-16, the owner's
 * call: "approval return and rejected comments in the viewing environment —
 * add in all"): a banner on the document's own page while it stands
 * returned or rejected — "Returned by Maria Santos on Oct 15 — 'attach the
 * supplier quote'" — read from the approval history, never a copy kept on
 * the document. Gone once the document is submitted again.
 */
export function DecisionNote({ documentType, documentId, reloadToken = 0 }: { documentType: string; documentId: string; reloadToken?: number }) {
  const [request, setRequest] = useState<Request | null>(null);
  useEffect(() => {
    let live = true;
    api
      .get<Request[]>(`/approvals/history/${documentType}/${documentId}`)
      .then((rows) => live && setRequest(rows[0] ?? null))
      .catch(() => live && setRequest(null));
    return () => {
      live = false;
    };
  }, [documentType, documentId, reloadToken]);
  if (!request) return null;
  if (request.status === 'CANCELLED' && request.reopenedAt) {
    return (
      <div className="alert warn" role="status">
        <strong>Pulled back to draft after approval</strong>
        {request.reopenedBy ? ` by ${request.reopenedBy}` : ''} on {formatDateTime(new Date(request.reopenedAt))}
        {request.reopenReason ? <> — “{request.reopenReason}”</> : null}
      </div>
    );
  }
  const last = request.actions[request.actions.length - 1];
  if (!last) return null;
  const returned = request.status === 'CANCELLED' && last.action === 'RETURNED';
  const rejected = request.status === 'REJECTED' && last.action === 'REJECTED';
  if (!returned && !rejected) return null;
  const step = request.workflow?.steps.find((s) => s.sequence === last.sequence)?.name;
  return (
    <div className={`alert ${rejected ? 'error' : 'warn'}`} role="status">
      <strong>{rejected ? 'Rejected' : 'Returned for changes'}</strong> by {last.approver.name}
      {step ? ` (${step})` : ''} on {formatDateTime(new Date(last.actedAt))}
      {last.comment ? <> — “{last.comment}”</> : ' — no comment left'}
    </div>
  );
}

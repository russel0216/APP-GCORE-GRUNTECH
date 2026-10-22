import { useCallback, useEffect, useState } from 'react';
import { api, openPdf } from '../../lib/api';
import { ErrorBox, StatusBadge, formatDate, useToast } from '../../components/ui';
import { useConfirm } from '../../components/Confirm';
import { ApprovalStepper, DecisionNote, DocumentApproval, previewSteps, type PreviewRoute } from '../../components/ApprovalStepper';
import { CustomerAnswerCard, type CustomerAnswer } from './PlanApprovals';

/**
 * The kick-off Gantt chart (2026-10-22, the owner's call, his WESCO UPS chart
 * the sample): the Scope of Work tab printed on A3 for the customer's
 * kick-off meeting — Prepared by the Project Engineer, Checked by the
 * Technical Manager (the approval engine, `gantt_chart`, the project's id the
 * document), Approved by the customer, whose answer is recorded here. The
 * chart's dates are the project's Start Date (Day 1) and Target Date.
 */

interface Kickoff {
  jobId: string;
  number: string;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED';
  submittedAt: string | null;
  approvedAt: string | null;
  engineer: { id: string; name: string } | null;
  technicalManager: { id: string; name: string } | null;
  startDate: string | null;
  targetEndDate: string | null;
  finishDay: number | null;
  phases: number;
  tasks: number;
  undatedTasks: number;
  milestones: number;
  problems: string[];
  canSubmit: boolean;
  canWithdraw: boolean;
  canRecordCustomer: boolean;
  approvalRoute: PreviewRoute | null;
  customer: CustomerAnswer;
}

const STATUS_TONES = { DRAFT: '', PENDING_APPROVAL: 'warn', APPROVED: 'ok' } as const;

/** `reloadToken` changes whenever what the chart is drawn from changes on the page — a task's dates, the project's dates. */
export function KickoffCard({ jobId, reloadToken = '' }: { jobId: string; reloadToken?: string | number }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [row, setRow] = useState<Kickoff | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    try {
      setRow(await api.get<Kickoff>(`/jobs/${jobId}/kickoff`));
    } catch (err) {
      setError(err);
    }
  }, [jobId]);
  useEffect(() => {
    load();
  }, [load, reloadToken]);

  if (!row) return error ? <ErrorBox error={error} /> : null;

  const done = (next: Kickoff) => {
    setRow(next);
    setReload((r) => r + 1);
  };

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      done(await api.post<Kickoff>(`/jobs/${jobId}/kickoff/submit`));
      toast('ok', 'Sent to the Technical Manager to check');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const customerAnswered = !!row.customer.decision;
  const statusLabel =
    row.status === 'DRAFT'
      ? 'Draft'
      : row.status === 'PENDING_APPROVAL'
        ? 'Waiting on the Technical Manager'
        : customerAnswered
          ? row.customer.decisionLabel ?? 'Answered by the customer'
          : 'Checked — for the customer';

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h3 className="card-title">
            Kick-off Gantt chart <StatusBadge status={row.status} extra={STATUS_TONES} label={statusLabel} />
          </h3>
          <div className="row">
            <button type="button" className="btn btn-sm" disabled={!row.startDate} onClick={() => openPdf(`/api/jobs/${jobId}/kickoff/pdf`, setError)} title={row.startDate ? 'The chart on A3 landscape' : 'Set the project’s Start Date first'}>
              Print A3
            </button>
            {row.canWithdraw && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  confirm.ask({
                    title: 'Pull the Gantt chart back to draft?',
                    body: 'The Technical Manager’s request is withdrawn and they are told. Send it again once it is right.',
                    confirmLabel: 'Pull it back',
                    onConfirm: async () => {
                      done(await api.post<Kickoff>(`/jobs/${jobId}/kickoff/withdraw`));
                      toast('ok', 'Back to draft');
                    },
                  })
                }
              >
                Pull back
              </button>
            )}
            {row.status === 'DRAFT' && row.canSubmit && (
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={submit}>
                Submit for approval
              </button>
            )}
          </div>
        </div>
        {confirm.bar}
        <ErrorBox error={error} />
        <dl className="kv">
          <dt>Prepared by</dt>
          <dd>{row.engineer ? `${row.engineer.name} (Project Engineer)` : <span className="faint">No Project Engineer — name one with Modify</span>}</dd>
          <dt>Checked by</dt>
          <dd>{row.technicalManager ? `${row.technicalManager.name} (Technical Manager)` : <span className="faint">No Technical Manager named — the Technical Managers on the engineer’s team</span>}</dd>
          <dt>Planned start (Day 1)</dt>
          <dd>{row.startDate ? formatDate(row.startDate) : <span className="faint">Not set</span>}</dd>
          <dt>Planned finish</dt>
          <dd>
            {row.targetEndDate ? formatDate(row.targetEndDate) : <span className="faint">Not set</span>}
            {row.finishDay ? <span className="faint"> · Day {row.finishDay}, working days Mon–Sat</span> : null}
          </dd>
          <dt>On the chart</dt>
          <dd>
            {row.phases} phase{row.phases === 1 ? '' : 's'}, {row.tasks} task{row.tasks === 1 ? '' : 's'}, {row.milestones} milestone{row.milestones === 1 ? '' : 's'}
            {row.undatedTasks > 0 && <span className="faint"> · {row.undatedTasks} undated, left off</span>}
          </dd>
        </dl>
        {row.status === 'DRAFT' && row.problems.length > 0 && (
          <div className="alert warn">
            Before it can be sent:
            <ul>
              {row.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        {row.status === 'DRAFT' && row.approvalRoute && row.approvalRoute.steps.length > 0 && !row.problems.length && (
          <div className="qd-route">
            <span className="qd-route-label">Submit for approval sends it to</span>
            <ApprovalStepper steps={previewSteps(row.approvalRoute)} />
          </div>
        )}
        {row.status === 'APPROVED' && !customerAnswered && (
          <p className="faint">Checked{row.approvedAt ? ` on ${formatDate(row.approvedAt)}` : ''}. Print it for the kick-off meeting and record the customer’s answer below.</p>
        )}
      </section>
      <DecisionNote documentType="gantt_chart" documentId={jobId} reloadToken={reload} />
      {row.status !== 'DRAFT' && <DocumentApproval documentType="gantt_chart" documentId={jobId} reloadToken={reload} />}
      {(row.status === 'APPROVED' || customerAnswered) && (
        <CustomerAnswerCard
          title="Customer approval — kick-off meeting"
          answer={row.customer}
          canRecord={row.canRecordCustomer}
          endpoint={`/jobs/${jobId}/kickoff/customer`}
          pending="Pending — present the chart at the kick-off meeting and record the customer’s answer here. The name, date and time stand as the signature."
          onSaved={(saved) => setRow(saved as Kickoff)}
        />
      )}
    </>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useConfirm } from '../components/Confirm';
import {
  ErrorBox,
  Loading,
  StatusBadge,
  formatDate,
  formatMoney,
  humanise,
  relativeTime,
  useToast,
} from '../components/ui';

interface ApprovalRequest {
  id: string;
  documentType: string;
  documentNumber: string | null;
  subject: string;
  amount: number | null;
  link: string | null;
  status: string;
  createdAt: string;
  requester?: { name: string };
  actions?: { action: string; comment: string | null; actedAt: string; approver?: { name: string } }[];
}

type Decision = 'APPROVED' | 'REJECTED' | 'RETURNED';

/** The decision as its button says it — the same words as the row's buttons. */
const DECISION_LABEL: Record<Decision, string> = { APPROVED: 'Approve', RETURNED: 'Return', REJECTED: 'Reject' };
/** The decision once made, for the toast. */
const DECISION_DONE: Record<Decision, string> = { APPROVED: 'approved', RETURNED: 'returned', REJECTED: 'rejected' };

/** The row contract every module's work shares — see api/src/routes/workspace.ts. */
export interface WorkRow {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  when?: string | null;
  overdue?: boolean;
  link: string;
}

export interface ScheduleRow {
  kind: string;
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  link: string;
  meetLink: string | null;
  sub?: string;
}

interface Renewal {
  kind: 'CONTRACT' | 'WARRANTY';
  id: string;
  reference: string;
  customerName: string;
  siteName: string | null;
  subject: string;
  endsAt: string;
  daysRemaining: number;
  value: number | null;
  link: string;
}

interface MyWorkData {
  assignedToMe: WorkRow[];
  todaysSchedule: ScheduleRow[];
  myDrafts: WorkRow[];
  renewals: Renewal[];
}

/** `09:30`, in the viewer's clock. */
export function clockTime(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** What kind of thing a work row is, as a short readable word. */
export function kindLabel(kind: string): string {
  const KIND: Record<string, string> = {
    lead: 'Lead',
    job: 'Project',
    visit: 'Visit',
    task: 'Task',
    job_order: 'Job order',
    cad_job_order: 'CAD J.O.',
    activity: 'Activity',
    quotation: 'Quotation',
    purchase_request: 'Purchase request',
    expense_claim: 'Expense claim',
    cash_advance: 'Cash advance',
    leave_request: 'Leave',
    meeting: 'Meeting',
    training: 'Training',
    celebration: 'Today',
  };
  return KIND[kind] ?? humanise(kind);
}

/**
 * The table shared by "Assigned to me" and "My drafts": what it is, the kind,
 * and the date that matters — with overdue rows saying so in words, not only
 * in colour.
 */
function WorkTable({ rows, dateLabel }: { rows: WorkRow[]; dateLabel: string }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>What</th>
            <th>Kind</th>
            <th>{dateLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.kind}:${r.id}`} className={r.overdue ? 'work-overdue' : undefined}>
              <td>
                <Link to={r.link} className="work-title">
                  {r.title}
                </Link>
                {r.subtitle && <div className="faint mono">{r.subtitle}</div>}
              </td>
              <td>
                <span className="badge">{kindLabel(r.kind)}</span>
              </td>
              <td className="muted">
                {r.when ? formatDate(r.when) : '—'}
                {r.overdue && <span className="badge danger work-overdue-tag">overdue</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MyWork() {
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [mine, setMine] = useState<ApprovalRequest[]>([]);
  const [work, setWork] = useState<MyWorkData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const confirm = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, m, w] = await Promise.all([
        api.get<ApprovalRequest[]>('/approvals/pending'),
        api.get<ApprovalRequest[]>('/approvals/mine'),
        api.get<MyWorkData>('/my-work'),
      ]);
      setPending(p);
      setMine(m);
      setWork(w);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
    A decision asks in the page's one confirm bar (components/Confirm.tsx),
    the same bar every other "are you sure" uses: what is being decided, the
    document one click away, a comment, then [Keep it] [Approve]. While the
    decision is being recorded, Keep it is disabled, so nobody backs out of
    a decision that is already on its way.
  */
  function decide(r: ApprovalRequest, action: Decision) {
    const number = r.documentNumber ?? r.documentType;
    const label = DECISION_LABEL[action];
    confirm.ask({
      title: `${label} ${number}?`,
      body: (
        <>
          <div className="decision-subject">
            {r.subject}
            {r.amount !== null && ` · ${formatMoney(r.amount)}`}
            {r.requester?.name && <span className="faint"> · raised by {r.requester.name}</span>}
          </div>
          {/* The decision is about the document, so the document is one click
              away — an approver should never have to decide on a subject line. */}
          <div className="decision-open">
            <Link to={r.link ?? '/my-work'} target="_blank" rel="noopener">
              Open {number}
            </Link>
          </div>
          <div className="faint decision-note">
            Recorded against the document permanently, with your name and the time.
          </div>
        </>
      ),
      confirmLabel: label,
      reason: 'optional',
      reasonLabel:
        action === 'APPROVED'
          ? 'Comment (optional) — anything the requester should know'
          : 'Comment (recommended) — what needs to change; this is what the requester sees',
      tone: action === 'APPROVED' ? 'primary' : 'danger',
      onConfirm: async (comment) => {
        await api.post(`/approvals/${r.id}/act`, { action, comment: comment || undefined });
        toast('ok', `${r.subject} — ${DECISION_DONE[action]}`);
        await load();
      },
    });
  }

  if (loading) return <Loading />;

  const schedule = work?.todaysSchedule ?? [];
  const assigned = work?.assignedToMe ?? [];
  const drafts = work?.myDrafts ?? [];
  const renewals = work?.renewals ?? [];

  return (
    <div className="mywork">
      <div className="page-head">
        <div>
          <h1>My Work</h1>
          <p>
            Everything waiting on you, and everything you are waiting on. One approval engine serves
            every document type, so this queue stays the same as new modules ship.
          </p>
        </div>
      </div>

      {confirm.bar}

      <ErrorBox error={error} />

      <div className="card mywork-card">
        <h3 className="card-title">
          Awaiting my approval
          {pending.length > 0 && <span className="badge warn card-title-count">{pending.length}</span>}
        </h3>

        {pending.length === 0 ? (
          <div className="muted">Nothing is waiting on you right now.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Subject</th>
                  <th>Raised by</th>
                  <th className="right">Amount</th>
                  <th>Raised</th>
                  <th className="mywork-decision-col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={r.link ?? '/my-work'} className="mono">
                        {r.documentNumber ?? r.documentType}
                      </Link>
                    </td>
                    <td>{r.subject}</td>
                    <td>{r.requester?.name ?? <span className="faint">—</span>}</td>
                    <td className="right mono">{r.amount === null ? '—' : formatMoney(r.amount)}</td>
                    <td className="muted">{relativeTime(r.createdAt)}</td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => decide(r, 'APPROVED')}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => decide(r, 'RETURNED')}
                        >
                          Return
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => decide(r, 'REJECTED')}
                        >
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card mywork-card">
        <h3 className="card-title">
          Today
          {schedule.length > 0 && <span className="badge info card-title-count">{schedule.length}</span>}
        </h3>
        {schedule.length === 0 ? (
          <div className="muted">Nothing scheduled today.</div>
        ) : (
          <ul className="today-list">
            {schedule.map((s) => (
              <li key={`${s.kind}:${s.id}`} className="today-row">
                <span className="mono today-time">
                  {/* A birthday or anniversary is the day's, not an hour's. */}
                  {s.startsAt === s.endsAt ? (
                    <span className="faint">all day</span>
                  ) : (
                    <>
                      {clockTime(s.startsAt)}
                      <span className="faint"> – {clockTime(s.endsAt)}</span>
                    </>
                  )}
                </span>
                <span className="today-what">
                  <Link to={s.link} className="work-title">
                    {s.title}
                  </Link>
                  <span className="faint today-sub">
                    {kindLabel(s.kind)}
                    {s.sub ? ` · ${s.sub}` : ''}
                  </span>
                </span>
                {s.meetLink && (
                  <a className="btn btn-sm btn-primary" href={s.meetLink} target="_blank" rel="noopener">
                    Join
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card mywork-card">
        <h3 className="card-title">
          Assigned to me
          {assigned.length > 0 && <span className="badge card-title-count">{assigned.length}</span>}
        </h3>
        {assigned.length === 0 ? (
          <div className="muted">Nothing assigned to you right now.</div>
        ) : (
          <WorkTable rows={assigned} dateLabel="Due" />
        )}
      </div>

      <div className="card mywork-card">
        <h3 className="card-title">
          My drafts
          {drafts.length > 0 && <span className="badge card-title-count">{drafts.length}</span>}
        </h3>
        {drafts.length === 0 ? (
          <div className="muted">No unsent documents. A draft is only visible to you, so this is the one place it would be chased.</div>
        ) : (
          <WorkTable rows={drafts} dateLabel="Last edited" />
        )}
      </div>

      {renewals.length > 0 && (
        <div className="card mywork-card">
          <h3 className="card-title">
            Renewals due
            <span className="badge warn card-title-count">{renewals.length}</span>
          </h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>What runs out</th>
                  <th>Ends</th>
                  <th className="right">Value</th>
                </tr>
              </thead>
              <tbody>
                {renewals.map((r) => (
                  <tr key={`${r.kind}:${r.id}`} className={r.daysRemaining < 0 ? 'work-overdue' : undefined}>
                    <td>
                      <Link to={r.link} className="work-title">
                        {r.customerName}
                      </Link>
                      {r.siteName && <div className="faint">{r.siteName}</div>}
                    </td>
                    <td>
                      <span className="badge">{r.kind === 'CONTRACT' ? 'Contract' : 'Warranty'}</span>{' '}
                      <span className="mono faint">{r.reference}</span>
                      <div className="faint">{r.subject}</div>
                    </td>
                    <td className="muted">
                      {formatDate(r.endsAt)}
                      <div className="faint">
                        {r.daysRemaining < 0
                          ? `${-r.daysRemaining} day(s) ago`
                          : r.daysRemaining === 0
                            ? 'today'
                            : `in ${r.daysRemaining} day(s)`}
                      </div>
                    </td>
                    <td className="right mono">{r.value === null ? '—' : formatMoney(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card mywork-card">
        <h3 className="card-title">My submissions</h3>
        {mine.length === 0 ? (
          <div className="muted">You have not submitted anything for approval yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Subject</th>
                  <th>Status</th>
                  <th>Submitted</th>
                  <th>Last decision</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((r) => {
                  const last = r.actions?.[r.actions.length - 1];
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link to={r.link ?? '/my-work'} className="mono">
                          {r.documentNumber ?? r.documentType}
                        </Link>
                      </td>
                      <td>{r.subject}</td>
                      <td>
                        <StatusBadge status={r.status} extra={{ PENDING: 'warn' }} />
                      </td>
                      <td className="muted">{relativeTime(r.createdAt)}</td>
                      <td className="muted">
                        {last
                          ? `${humanise(last.action)} by ${last.approver?.name ?? '—'}${
                              last.comment ? ` — ${last.comment}` : ''
                            }`
                          : 'Not yet acted on'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

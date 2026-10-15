import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  ErrorBox,
  StatusBadge,
  Field,
  Loading,
  Modal,
  ModalFoot,
  formatDate,
  formatMoney,
  useToast,
  marginTone,
} from '../../components/ui';
import { ProgressBar } from './Projects';
import { Stat } from '../../components/charts';
import { Attachments } from '../../components/Attachments';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { ApprovalStepper, DocumentApproval, DecisionNote, allHeld, previewSteps, type PreviewRoute } from '../../components/ApprovalStepper';
import { useBackLink } from '../../components/Navigation';
import { NumberInput } from '../../components/NumberInput';
import { InvoiceRequestModal, REQUEST_TONES } from '../finance/InvoiceRequests';

// ════════════════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════════════════

interface ReportRow {
  id: string;
  number: string;
  reportNo: number;
  status: string;
  periodFrom: string;
  periodTo: string;
  toDatePct: number;
  earnedValue: number;
  job: { id: string; number: string; name: string; contractValue: number };
  preparedBy: { id: string; name: string };
  billing: { id: string; number: string; status: string } | null;
}

/**
 * The rows the billings half of this screen shows. Only what the register
 * needs — the detail page reads the full record.
 */
interface BillingRow {
  id: string;
  number: string;
  billingNo: number;
  status: string;
  billingDate: string;
  grossAmount: number;
  netCollectible: number;
  job: { id: string; number: string; name: string };
  progressReport: { id: string; number: string } | null;
}

export function ProgressReports() {
  const navigate = useNavigate();
  /*
    The menu entry is "Progress & Billing" and it used to show progress
    reports only: a billing was reachable through the report that raised it or
    through the project workspace, and there was no register of them anywhere.
    A menu that names two things has to show both.
  */
  const [tab, setTab] = useState<'reports' | 'billings'>('reports');

  const billingColumns: Column<BillingRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', render: (b) => <span className="mono">{b.number}</span> },
    {
      key: 'job',
      label: 'Project',
      render: (b) => (
        <div>
          <div>{b.job.name}</div>
          <div className="faint mono">{b.job.number}</div>
        </div>
      ),
    },
    { key: 'billingNo', label: '#', align: 'right', render: (b) => b.billingNo },
    { key: 'billingDate', label: 'Date', sortKey: 'billingDate', render: (b) => formatDate(b.billingDate) },
    {
      key: 'against',
      label: 'Against',
      render: (b) =>
        b.progressReport ? (
          <span className="mono faint">{b.progressReport.number}</span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'gross',
      label: 'Gross',
      align: 'right',
      render: (b) => <span className="mono">{formatMoney(b.grossAmount)}</span>,
    },
    {
      // Invoiced is not collectible: EWT is withheld at source, so this is the
      // figure A/R actually chases. Showing gross alone overstates every one.
      key: 'net',
      label: 'Net collectible',
      align: 'right',
      render: (b) => <span className="mono">{formatMoney(b.netCollectible)}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      render: (b) => <StatusBadge status={b.status} />,
    },
  ];

  const columns: Column<ReportRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'job',
      label: 'Project',
      render: (r) => (
        <div>
          <div>{r.job.name}</div>
          <div className="faint mono">{r.job.number}</div>
        </div>
      ),
    },
    { key: 'reportNo', label: '#', align: 'right', render: (r) => r.reportNo },
    {
      key: 'period',
      label: 'Period',
      sortKey: 'periodTo',
      render: (r) => `${formatDate(r.periodFrom)} — ${formatDate(r.periodTo)}`,
    },
    { key: 'progress', label: 'To date', render: (r) => <ProgressBar pct={r.toDatePct} /> },
    {
      key: 'earned',
      label: 'Earned value',
      align: 'right',
      render: (r) => <span className="mono">{formatMoney(r.earnedValue)}</span>,
    },
    { key: 'preparedBy', label: 'Prepared by', render: (r) => r.preparedBy.name },
    {
      key: 'billing',
      label: 'Billed',
      render: (r) =>
        r.billing ? (
          <span className="mono faint">{r.billing.number}</span>
        ) : (
          <span className="faint">not yet</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <StatusBadge status={r.status} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Progress &amp; Billing</h1>
        </div>
        <div className="scope-switch" role="tablist" aria-label="Progress or billing">
          <button
            role="tab"
            aria-selected={tab === 'reports'}
            className={tab === 'reports' ? 'active' : ''}
            onClick={() => setTab('reports')}
          >
            Progress reports
          </button>
          <button
            role="tab"
            aria-selected={tab === 'billings'}
            className={tab === 'billings' ? 'active' : ''}
            onClick={() => setTab('billings')}
          >
            Billings
          </button>
        </div>
      </div>

      {tab === 'billings' ? (
        <DataList<BillingRow>
          listKey="progress-billings"
          endpoint="/billings"
          columns={billingColumns}
          rowKey={(b) => b.id}
          // No Mine/All switch: a billing has no author the API narrows by
          // (`billingListWhere` reads no scope), so the switch changed nothing.
          searchPlaceholder="Search number, project…"
          onRowClick={(b) => navigate(`/g-ops/billings/${b.id}`)}
          emptyTitle="Nothing billed yet"
          emptyHint="A billing is raised from an approved progress report, and covers only the work that report added."
          printPath="/api/billings/pdf"
          filters={[
            {
              key: 'status',
              label: 'Status',
              options: [
                { value: 'DRAFT', label: 'Draft' },
                { value: 'PENDING_APPROVAL', label: 'Pending approval' },
                { value: 'APPROVED', label: 'Approved' },
                { value: 'INVOICED', label: 'Invoiced' },
              ],
            },
          ]}
        />
      ) : (
      <DataList<ReportRow>
        listKey="progress-reports"
        endpoint="/progress-reports"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        searchPlaceholder="Search number, project…"
        onRowClick={(r) => navigate(`/g-ops/progress/${r.id}`)}
        emptyTitle="No progress reports yet"
        emptyHint="Start one from a project's Progress tab."
        printPath="/api/progress-reports/pdf"
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'DRAFT', label: 'Draft' },
              { value: 'PENDING_APPROVAL', label: 'Pending approval' },
              { value: 'APPROVED', label: 'Approved' },
            ],
          },
        ]}
      />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  REPORT DETAIL — the Accomplishment Report (2026-10-15)
// ════════════════════════════════════════════════════════════════════

interface ReportLine {
  id: string;
  previousPct: number;
  thisPeriodPct: number;
  toDatePct: number;
  remarks: string | null;
  previousAmount: number;
  thisPeriodAmount: number;
  toDateAmount: number;
  /** The line's share of the schedule, and what it adds to the project's %. */
  weightPct: number;
  weightedPct: number;
  /** Its phase's % from the Scope of Work tasks (weight × progress), null with none. */
  fromTasksPct: number | null;
  tasks: { name: string; status: string; progressPct: number; weight: number | null }[];
  scopeItem: { id: string; name: string; value: number; kind: string };
}

interface ReportDay {
  id: string;
  workDate: string;
  actions: string;
  findings: string | null;
  recommendation: string | null;
  remarks: string | null;
  headcount: number | null;
  pictures: number;
}

interface ReportDetail {
  id: string;
  number: string;
  legacyNumber: string | null;
  reportNo: number;
  status: string;
  periodFrom: string;
  periodTo: string;
  weather: string | null;
  manpower: string | null;
  equipment: string | null;
  accomplishment: string | null;
  issues: string | null;
  nextPeriodPlan: string | null;
  milestones: string | null;
  overallStatus: string | null;
  overallStatusNote: string | null;
  overallStatusText: string | null;
  overallChoices: { key: string; label: string }[];
  personnelInCharge: string | null;
  personnelSupport: string[];
  days: ReportDay[];
  canEdit: boolean;
  canSubmit: boolean;
  canWithdraw: boolean;
  canDelete: boolean;
  approvalRoute: PreviewRoute | null;
  job: {
    id: string;
    number: string;
    name: string;
    contractValue: number;
    customer: { name: string };
    site: { name: string; address: string | null; city: string | null } | null;
    startDate: string | null;
    targetEndDate: string | null;
  };
  preparedBy: { id: string; name: string };
  approvedBy: { id: string; name: string } | null;
  approvedAt: string | null;
  previousReport: { id: string; number: string; reportNo: number } | null;
  nextReport: { id: string; number: string; reportNo: number } | null;
  billing: { id: string; number: string; status: string; grossAmount: number } | null;
  lines: ReportLine[];
  totals: {
    contractValue: number;
    earnedValue: number;
    thisPeriodValue: number;
    toDatePct: number;
    thisPeriodPct: number;
  };
}

export function ProgressReportDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();

  const [report, setReport] = useState<ReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [narrative, setNarrative] = useState(false);
  const [day, setDay] = useState<ReportDay | 'new' | null>(null);
  const [reload, setReload] = useState(0);

  // A report belongs to its project: back goes to the project's Progress & Billing tab.
  const seesProjects = can('gops.projects.view_all') || can('gops.projects.view_own');
  useBackLink(
    report && seesProjects ? `/g-ops/projects/${report.job.id}?tab=progress` : null,
    report ? `${report.job.number} Progress & Billing` : null,
  );

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setReport(await api.get<ReportDetail>(`/progress-reports/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeConfirm = confirm.close;
  useEffect(() => {
    closeConfirm();
  }, [id, closeConfirm]);

  if (loading) return <Loading />;
  if (!report) return <ErrorBox error={error ?? new Error('Report not found')} />;

  const done = () => {
    setReload((r) => r + 1);
    void load();
  };

  async function setPct(lineId: string, field: 'thisPeriodPct' | 'toDatePct', value: number) {
    if (!report) return;
    try {
      setReport(await api.patch<ReportDetail>(`/progress-reports/${report.id}/lines/${lineId}`, { [field]: value }));
      setError(null);
    } catch (err) {
      setError(err);
      await load();
    }
  }

  async function fromTasks(lineId: string) {
    if (!report) return;
    try {
      setReport(await api.post<ReportDetail>(`/progress-reports/${report.id}/lines/${lineId}/from-tasks`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }

  async function submit() {
    if (!report) return;
    setError(null);
    try {
      await api.post(`/progress-reports/${report.id}/submit`);
      toast('ok', allHeld(report.approvalRoute) ? 'Approved — you hold every step' : 'Sent for approval');
      done();
    } catch (err) {
      setError(err);
    }
  }

  async function bill() {
    if (!report) return;
    try {
      const created = await api.post<{ id: string }>('/billings', { progressReportId: report.id });
      toast('ok', 'Progress billing raised');
      navigate(`/g-ops/billings/${created.id}`);
    } catch (err) {
      setError(err);
    }
  }

  const route = report.approvalRoute;
  const draft = report.status === 'DRAFT';
  const site = report.job.site ? [report.job.site.address, report.job.site.city].filter(Boolean).join(', ') || report.job.site.name : null;

  return (
    <div>
      <RecordHeader
        type="Accomplishment report"
        code={report.number}
        title={`${report.job.name} · Report #${report.reportNo}`}
        status={report.status}
        amount={`${report.totals.toDatePct.toFixed(2)}%`}
        amountLabel="Complete to date"
        meta={
          <>
            <Link className="mono" to={`/g-ops/projects/${report.job.id}`}>
              {report.job.number}
            </Link>{' '}
            · {report.job.customer.name} · {formatDate(report.periodFrom)} — {formatDate(report.periodTo)} · prepared by{' '}
            {report.preparedBy.name}
            {report.legacyNumber && <> · formerly {report.legacyNumber}</>}
            {report.previousReport && (
              <>
                {' '}
                · after <Link to={`/g-ops/progress/${report.previousReport.id}`}>#{report.previousReport.reportNo}</Link>
              </>
            )}
            {report.nextReport && (
              <>
                {' '}
                · followed by <Link to={`/g-ops/progress/${report.nextReport.id}`}>#{report.nextReport.reportNo}</Link>
              </>
            )}
          </>
        }
        actions={
          <>
            {report.canSubmit && (
              <button className="btn btn-primary" onClick={submit}>
                Submit for approval
              </button>
            )}
            {report.status === 'APPROVED' && !report.billing && can('gops.progress_billing.create') && (
              <button className="btn btn-primary" onClick={bill}>
                Raise billing
              </button>
            )}
          </>
        }
        print={`/api/progress-reports/${report.id}/pdf`}
        more={[
          report.canWithdraw && {
            label: 'Pull back to draft',
            confirm: {
              title: `Pull ${report.number} back?`,
              body: 'The approval request is withdrawn and its approvers are told. It comes back as a draft to change and send again.',
              confirmLabel: 'Pull it back',
              onConfirm: async () => {
                await api.post(`/progress-reports/${report.id}/withdraw`);
                toast('ok', 'Back to draft');
                done();
              },
            },
          },
          report.canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${report.number}?`,
              body: 'It goes for good, with its daily entries and pictures.',
              confirmLabel: 'Delete',
              onConfirm: async () => {
                await api.del(`/progress-reports/${report.id}`);
                toast('ok', 'Deleted');
                navigate(`/g-ops/projects/${report.job.id}?tab=progress`);
              },
            },
          },
        ]}
        modify={report.canEdit ? () => setNarrative(true) : undefined}
        confirm={confirm}
      />

      {draft && route && route.steps.length > 0 && (
        <div className="qd-route">
          <span className="qd-route-label">{allHeld(route) ? 'No one else’s approval needed — you hold every step' : 'Submit for approval sends it to'}</span>
          <ApprovalStepper steps={previewSteps(route)} />
        </div>
      )}
      <DecisionNote documentType="progress_report" documentId={report.id} reloadToken={reload} />
      {!draft && <DocumentApproval documentType="progress_report" documentId={report.id} reloadToken={reload} />}

      <ErrorBox error={error} />

      {report.billing && (
        <div className="alert ok">
          Billed as <Link to={`/g-ops/billings/${report.billing.id}`}>{report.billing.number}</Link> — {formatMoney(report.billing.grossAmount)}
        </div>
      )}
      {report.status === 'APPROVED' && (
        <div className="alert info">
          Approved{report.approvedBy ? ` — last signed by ${report.approvedBy.name}` : ''}. Its percentages are now the record of what was
          reported and cannot be changed.
        </div>
      )}

      <div className="kpi-grid">
        <Stat label="Contract value" value={formatMoney(report.totals.contractValue)} figure />
        <Stat label="This period" value={formatMoney(report.totals.thisPeriodValue)} figure accent="neon" hint={`${report.totals.thisPeriodPct.toFixed(2)}% of the contract`} />
        <Stat label="Earned to date" value={formatMoney(report.totals.earnedValue)} figure />
        <Stat label="Complete" value={<ProgressBar pct={report.totals.toDatePct} />} />
      </div>

      <div className="grid grid-2">
        <section className="card">
          <h3 className="card-title">Project</h3>
          <dl className="kv">
            <dt>Location</dt>
            <dd>{site ?? '—'}</dd>
            <dt>Start</dt>
            <dd>{report.job.startDate ? formatDate(report.job.startDate) : '—'}</dd>
            <dt>Target completion</dt>
            <dd>{report.job.targetEndDate ? formatDate(report.job.targetEndDate) : '—'}</dd>
            <dt>Overall status</dt>
            <dd>{report.overallStatusText ?? '—'}</dd>
          </dl>
        </section>
        <section className="card">
          <h3 className="card-title">Personnel present</h3>
          <dl className="kv">
            <dt>Project in charge</dt>
            <dd>{report.personnelInCharge ?? '—'}</dd>
            <dt>Project support</dt>
            <dd>{report.personnelSupport.length ? report.personnelSupport.join(', ') : '—'}</dd>
          </dl>
        </section>
      </div>

      <div className="card del-gap-top">
        <h3 className="card-title">Accomplishment against the schedule of values</h3>
        <p className="muted del-lede">
          {report.canEdit
            ? 'Each phase weighs its share of the contract. Type this period’s or the to-date figure — the other follows — or take it from the phase’s tasks on the Scope of Work.'
            : 'Percentages as reported for this period, each weighed by its share of the contract.'}
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Scope of work</th>
                <th className="right">Value</th>
                <th className="right">Weight</th>
                <th className="right">Previous</th>
                <th className="right del-col-pct">This period</th>
                <th className="right del-col-pct">To date</th>
                <th className="right">Weighted</th>
                <th className="right">Earned to date</th>
              </tr>
            </thead>
            <tbody>
              {report.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div>{l.scopeItem.name}</div>
                    {l.fromTasksPct !== null ? (
                      <div className="faint">
                        {l.tasks.length} task{l.tasks.length === 1 ? '' : 's'} · {l.fromTasksPct.toFixed(2)}% by their weights
                        {report.canEdit && l.fromTasksPct !== l.toDatePct && (
                          <>
                            {' '}
                            ·{' '}
                            <button type="button" className="pr-link" onClick={() => fromTasks(l.id)}>
                              Use it
                            </button>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="faint">{l.scopeItem.kind.toLowerCase().replace(/_/g, ' ')}</div>
                    )}
                  </td>
                  <td className="right mono">{formatMoney(l.scopeItem.value)}</td>
                  <td className="right mono">{l.weightPct.toFixed(2)}%</td>
                  <td className="right mono faint">{l.previousPct.toFixed(2)}%</td>
                  <td className="right">
                    {report.canEdit ? (
                      <PctInput value={l.thisPeriodPct} onCommit={(v) => setPct(l.id, 'thisPeriodPct', v)} />
                    ) : (
                      <span className="mono">{l.thisPeriodPct.toFixed(2)}%</span>
                    )}
                  </td>
                  <td className="right">
                    {report.canEdit ? (
                      <PctInput value={l.toDatePct} onCommit={(v) => setPct(l.id, 'toDatePct', v)} />
                    ) : (
                      <span className="mono">{l.toDatePct.toFixed(2)}%</span>
                    )}
                  </td>
                  <td className="right mono">{l.weightedPct.toFixed(2)}%</td>
                  <td className="right mono">{formatMoney(l.toDateAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-2 del-gap-top">
        <section className="card">
          <h3 className="card-title">Summary</h3>
          <div className="del-prose">{report.accomplishment || <span className="faint">Not written yet.</span>}</div>
        </section>
        <section className="card">
          <h3 className="card-title">Key milestones achieved</h3>
          <div className="del-prose">{report.milestones || <span className="faint">None stated.</span>}</div>
        </section>
        <section className="card">
          <h3 className="card-title">Remaining works</h3>
          <div className="del-prose">{report.nextPeriodPlan || <span className="faint">None stated.</span>}</div>
        </section>
        <section className="card">
          <h3 className="card-title">Issues and resources</h3>
          <dl className="kv">
            <dt>Issues</dt>
            <dd>{report.issues ?? '—'}</dd>
            <dt>Manpower</dt>
            <dd>{report.manpower ?? '—'}</dd>
            <dt>Equipment</dt>
            <dd>{report.equipment ?? '—'}</dd>
            <dt>Weather / delays</dt>
            <dd>{report.weather ?? '—'}</dd>
          </dl>
        </section>
      </div>

      <section className="card del-gap-top">
        <div className="card-head">
          <h3 className="card-title">Daily accomplishments</h3>
          {report.canEdit && (
            <button className="btn btn-sm" onClick={() => setDay('new')}>
              + Add day
            </button>
          )}
        </div>
        {report.days.length === 0 ? (
          <p className="muted">No day written yet. Each day takes what was done, the findings, the recommendation and its pictures.</p>
        ) : (
          <div className="stack">
            {report.days.map((d) => (
              <div key={d.id} className="pr-day">
                <div className="pr-day-head">
                  <strong>{formatDate(d.workDate)}</strong>
                  {d.headcount !== null && <span className="faint"> · {d.headcount} on site</span>}
                  {report.canEdit && (
                    <button className="btn btn-sm" onClick={() => setDay(d)}>
                      Modify
                    </button>
                  )}
                </div>
                <div className="del-prose">{d.actions}</div>
                {(d.findings || d.recommendation || d.remarks) && (
                  <dl className="kv">
                    {d.findings && (
                      <>
                        <dt>Findings</dt>
                        <dd>{d.findings}</dd>
                      </>
                    )}
                    {d.recommendation && (
                      <>
                        <dt>Recommendation</dt>
                        <dd>{d.recommendation}</dd>
                      </>
                    )}
                    {d.remarks && (
                      <>
                        <dt>Remarks</dt>
                        <dd>{d.remarks}</dd>
                      </>
                    )}
                  </dl>
                )}
                <Attachments
                  entityType="progress_report_day"
                  entityId={d.id}
                  title={`Pictures (${d.pictures})`}
                  hint="Pictures of the day’s work — they print under it, three to a row."
                  canEdit={report.canEdit}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="del-gap-top">
        <Attachments
          entityType="progress_report"
          entityId={report.id}
          title="Other photos and files"
          hint="Anything for the whole period — pictures print at the end of the report."
          canEdit={report.canEdit}
        />
      </div>

      {narrative && (
        <NarrativeModal
          report={report}
          onClose={() => setNarrative(false)}
          onSaved={() => {
            setNarrative(false);
            void load();
          }}
        />
      )}
      {day && (
        <DayModal
          report={report}
          day={day === 'new' ? null : day}
          onClose={() => setDay(null)}
          onSaved={(r) => {
            setDay(null);
            setReport(r);
          }}
        />
      )}
    </div>
  );
}

/** Commits on blur or Enter rather than on every keystroke. The one numeric input (rule 17). */
function PctInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(value.toString());
  useEffect(() => setText(value.toString()), [value]);

  function commit() {
    const n = Number(text);
    if (Number.isFinite(n) && n !== value) onCommit(n);
    else setText(value.toString());
  }

  return (
    <NumberInput
      kind="percent"
      className="mono del-pct-input"
      aria-label="Percentage"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function NarrativeModal({ report, onClose, onSaved }: { report: ReportDetail; onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    overallStatus: report.overallStatus ?? '',
    overallStatusNote: report.overallStatusNote ?? '',
    personnelInCharge: report.personnelInCharge ?? '',
    personnelSupport: report.personnelSupport.join('\n'),
    accomplishment: report.accomplishment ?? '',
    milestones: report.milestones ?? '',
    nextPeriodPlan: report.nextPeriodPlan ?? '',
    issues: report.issues ?? '',
    manpower: report.manpower ?? '',
    equipment: report.equipment ?? '',
    weather: report.weather ?? '',
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/progress-reports/${report.id}`, {
        overallStatus: form.overallStatus || null,
        overallStatusNote: form.overallStatusNote || null,
        personnelInCharge: form.personnelInCharge || null,
        personnelSupport: form.personnelSupport
          .split(/\n|,/)
          .map((s) => s.trim())
          .filter(Boolean),
        accomplishment: form.accomplishment || null,
        milestones: form.milestones || null,
        nextPeriodPlan: form.nextPeriodPlan || null,
        issues: form.issues || null,
        manpower: form.manpower || null,
        equipment: form.equipment || null,
        weather: form.weather || null,
      });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const known = report.overallChoices.some((c) => c.key === form.overallStatus);

  return (
    <Modal
      wide
      title={`Modify accomplishment report ${report.number}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Overall status">
          <select value={form.overallStatus} onChange={set('overallStatus')}>
            <option value="">— not stated —</option>
            {report.overallChoices.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
            {!known && form.overallStatus && <option value={form.overallStatus}>{form.overallStatus}</option>}
          </select>
        </Field>
        <Field label="Status note" hint="Printed after the status — “Awaiting materials”.">
          <input value={form.overallStatusNote} onChange={set('overallStatusNote')} />
        </Field>
        <Field label="Project in charge">
          <input value={form.personnelInCharge} onChange={set('personnelInCharge')} />
        </Field>
        <Field label="Project support" hint="One name per line.">
          <textarea rows={3} value={form.personnelSupport} onChange={set('personnelSupport')} />
        </Field>
      </div>
      <Field label="Summary">
        <textarea value={form.accomplishment} onChange={set('accomplishment')} />
      </Field>
      <Field label="Key milestones achieved" hint="One per line — “Pump room: equipment placed”.">
        <textarea value={form.milestones} onChange={set('milestones')} />
      </Field>
      <Field label="Remaining works" hint="One per line.">
        <textarea value={form.nextPeriodPlan} onChange={set('nextPeriodPlan')} />
      </Field>
      <Field label="Issues and concerns">
        <textarea value={form.issues} onChange={set('issues')} />
      </Field>
      <div className="grid grid-2">
        <Field label="Manpower deployed">
          <input value={form.manpower} placeholder="4 fitters, 2 welders, 1 supervisor" onChange={set('manpower')} />
        </Field>
        <Field label="Equipment deployed">
          <input value={form.equipment} placeholder="Welding machine, chain block, boom truck" onChange={set('equipment')} />
        </Field>
      </div>
      <Field label="Weather and delays">
        <input value={form.weather} onChange={set('weather')} />
      </Field>
    </Modal>
  );
}

/** A day's entry: what was done, the findings and the recommendation. Its pictures go on the page, under it. */
function DayModal({
  report,
  day,
  onClose,
  onSaved,
}: {
  report: ReportDetail;
  day: ReportDay | null;
  onClose: () => void;
  onSaved: (r: ReportDetail) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    workDate: (day?.workDate ?? report.periodTo).slice(0, 10),
    actions: day?.actions ?? '',
    findings: day?.findings ?? '',
    recommendation: day?.recommendation ?? '',
    remarks: day?.remarks ?? '',
    headcount: day?.headcount === null || day?.headcount === undefined ? '' : String(day.headcount),
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      workDate: form.workDate,
      actions: form.actions,
      findings: form.findings || null,
      recommendation: form.recommendation || null,
      remarks: form.remarks || null,
      headcount: form.headcount === '' ? null : Number(form.headcount),
    };
    try {
      onSaved(
        day
          ? await api.put<ReportDetail>(`/progress-reports/${report.id}/days/${day.id}`, body)
          : await api.post<ReportDetail>(`/progress-reports/${report.id}/days`, body),
      );
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!day) return;
    onSaved(await api.del<ReportDetail>(`/progress-reports/${report.id}/days/${day.id}`));
  }

  return (
    <Modal
      wide
      title={day ? `Modify ${formatDate(day.workDate)}` : 'Add day'}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          danger={day ? { label: 'Remove', question: 'Remove this day and its pictures?', onConfirm: remove } : undefined}
        >
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.actions.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Day" required hint={`Within ${formatDate(report.periodFrom)} – ${formatDate(report.periodTo)}.`}>
          <input type="date" value={form.workDate} min={report.periodFrom.slice(0, 10)} max={report.periodTo.slice(0, 10)} onChange={set('workDate')} />
        </Field>
        <Field label="People on site">
          <NumberInput kind="count" value={form.headcount} onChange={set('headcount')} />
        </Field>
      </div>
      <Field label="Actions taken" required>
        <textarea rows={4} value={form.actions} onChange={set('actions')} />
      </Field>
      <Field label="Findings">
        <textarea value={form.findings} onChange={set('findings')} />
      </Field>
      <Field label="Recommendation">
        <textarea value={form.recommendation} onChange={set('recommendation')} />
      </Field>
      <Field label="Remarks">
        <input value={form.remarks} onChange={set('remarks')} />
      </Field>
      {!day && <p className="faint">Save the day first, then add its pictures under it on the page.</p>}
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════
//  BILLING DETAIL
// ════════════════════════════════════════════════════════════════════

interface BillingDetail {
  id: string;
  number: string;
  billingNo: number;
  status: string;
  billingDate: string;
  grossAmount: number;
  vatRate: number;
  vatAmount: number;
  ewtRate: number;
  ewtAmount: number;
  invoiceTotal: number;
  netCollectible: number;
  downpaymentRecouped: number | null;
  retentionWithheld: number | null;
  job: { id: string; number: string; name: string; contractValue: number; customer: { name: string } };
  progressReport: { id: string; number: string; reportNo: number; periodFrom: string; periodTo: string };
  lines: {
    id: string;
    scopeValue: number;
    previousPct: number;
    toDatePct: number;
    previousAmount: number;
    thisPeriodAmount: number;
    scopeItem: { id: string; name: string };
  }[];
  /** The invoice raised from this billing — at most one, by a unique key. */
  invoice: { id: string; number: string; status: string } | null;
  /** Its invoice requests, newest first (2026-10-15). */
  invoiceRequests: { id: string; number: string; status: string; createdAt: string; requestedBy: { name: string } }[];
  canRequestInvoice: boolean;
  canSubmit: boolean;
  canWithdraw: boolean;
  approvalRoute: PreviewRoute | null;
}

export function BillingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();

  const [billing, setBilling] = useState<BillingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const navigate = useNavigate();

  // A billing has no menu entry of its own: back goes to its project's
  // Progress & Billing tab, else to the Progress & Billing register.
  const seesProjects = can('gops.projects.view_all') || can('gops.projects.view_own');
  useBackLink(
    billing ? (seesProjects ? `/g-ops/projects/${billing.job.id}?tab=progress` : '/g-ops/progress') : null,
    billing ? (seesProjects ? `${billing.job.number} Progress & Billing` : 'Progress & Billing') : null,
  );

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setBilling(await api.get<BillingDetail>(`/billings/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Loading />;
  if (!billing) return <ErrorBox error={error ?? new Error('Billing not found')} />;

  const done = () => {
    setReload((r) => r + 1);
    void load();
  };

  async function submit() {
    if (!billing) return;
    setError(null);
    try {
      await api.post(`/billings/${billing.id}/submit`);
      toast('ok', allHeld(billing.approvalRoute) ? 'Approved — you hold every step' : 'Sent for approval');
      done();
    } catch (err) {
      setError(err);
    }
  }
  const route = billing.approvalRoute;

  return (
    <div>
      <RecordHeader
        type="Progress billing"
        code={billing.number}
        title={`${billing.job.name} · Billing #${billing.billingNo}`}
        status={billing.status}
        amount={formatMoney(billing.invoiceTotal)}
        amountLabel="Invoice total"
        meta={
          <>
            <Link className="mono" to={`/g-ops/projects/${billing.job.id}`}>
              {billing.job.number}
            </Link>{' '}
            · {billing.job.customer.name} · {formatDate(billing.billingDate)} · against{' '}
            <Link className="mono" to={`/g-ops/progress/${billing.progressReport.id}`}>
              {billing.progressReport.number}
            </Link>
          </>
        }
        actions={
          <>
            {billing.canSubmit && (
              <button className="btn btn-primary" onClick={submit}>
                Submit for approval
              </button>
            )}
            {/* The hand-off (2026-10-15): the salesperson or Team Leader holding
                the project asks for the invoice; Back Support approves it, and
                the approval raises the draft invoice in A/R. */}
            {billing.canRequestInvoice && (
              <button className="btn btn-primary" onClick={() => setRequesting(true)}>
                Request invoice
              </button>
            )}
          </>
        }
        print={`/api/billings/${billing.id}/pdf`}
        more={[
          // Finance's direct door stays, for a billing nobody asked about.
          !billing.invoice &&
            billing.status === 'APPROVED' &&
            !billing.invoiceRequests.some((r) => r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL') &&
            can('gfin.ar.create') && { label: 'Raise invoice directly (finance)', to: `/g-fin/ar?raise=${billing.id}` },
          billing.canWithdraw && {
            label: 'Pull back to draft',
            confirm: {
              title: `Pull ${billing.number} back?`,
              body: 'The approval request is withdrawn and its approvers are told.',
              confirmLabel: 'Pull it back',
              onConfirm: async () => {
                await api.post(`/billings/${billing.id}/withdraw`);
                toast('ok', 'Back to draft');
                done();
              },
            },
          },
        ]}
        confirm={confirm}
      />

      {billing.status === 'DRAFT' && route && route.steps.length > 0 && (
        <div className="qd-route">
          <span className="qd-route-label">{allHeld(route) ? 'No one else’s approval needed — you hold every step' : 'Submit for approval sends it to'}</span>
          <ApprovalStepper steps={previewSteps(route)} />
        </div>
      )}
      <DecisionNote documentType="progress_billing" documentId={billing.id} reloadToken={reload} />
      {billing.status !== 'DRAFT' && <DocumentApproval documentType="progress_billing" documentId={billing.id} reloadToken={reload} />}

      <ErrorBox error={error} />

      {billing.invoice && (
        <div className="alert ok">
          Invoiced as{' '}
          <Link className="mono" to={`/g-fin/ar/${billing.invoice.id}`}>
            {billing.invoice.number}
          </Link>{' '}
          <StatusBadge status={billing.invoice.status} />
        </div>
      )}
      {!billing.invoice && billing.status === 'APPROVED' && (
        <div className="alert info">
          Approved and not yet invoiced — this is work you are owed and have not asked for.
          {billing.canRequestInvoice
            ? ' Request the invoice: Back Support approves it, and finance gets the draft invoice.'
            : ' The salesperson holding the project, or their Team Leader, requests the invoice.'}
        </div>
      )}
      {billing.invoiceRequests.length > 0 && (
        <section className="card">
          <h3 className="card-title">Invoice requests</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Requested by</th>
                  <th>Raised</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {billing.invoiceRequests.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link className="mono" to={`/g-fin/invoice-requests/${r.id}`}>
                        {r.number}
                      </Link>
                    </td>
                    <td>{r.requestedBy.name}</td>
                    <td>{formatDate(r.createdAt)}</td>
                    <td>
                      <StatusBadge status={r.status} extra={REQUEST_TONES} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {requesting && (
        <InvoiceRequestModal
          billingId={billing.id}
          onClose={() => setRequesting(false)}
          onSaved={(saved) => {
            setRequesting(false);
            navigate(`/g-fin/invoice-requests/${saved.id}`);
          }}
        />
      )}

      <div className="kpi-grid">
        <Stat label="Gross this billing" value={formatMoney(billing.grossAmount)} figure />
        <Stat label={`VAT ${(billing.vatRate * 100).toFixed(0)}%`} value={formatMoney(billing.vatAmount)} figure />
        <Stat label="Invoice total" value={formatMoney(billing.invoiceTotal)} figure accent="neon" hint="what the invoice says" />
        <Stat label="Net collectible" value={formatMoney(billing.netCollectible)} figure hint="what arrives as cash" />
      </div>

      {/* The thing people get wrong about EWT, said plainly. */}
      <div className="alert info">
        The customer withholds {formatMoney(billing.ewtAmount)} ({(billing.ewtRate * 100).toFixed(0)}%
        creditable withholding tax) and remits it to the BIR on our behalf. You will receive{' '}
        <strong>{formatMoney(billing.netCollectible)}</strong> in cash plus a BIR Form 2307 for the
        withheld amount. That shortfall is <strong>not</strong> an unpaid balance.
      </div>

      <div className="card">
        <h3 className="card-title">Billing against the schedule of values</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Scope</th>
                <th className="right">Contract value</th>
                <th className="right">Previously billed %</th>
                <th className="right">To date %</th>
                <th className="right">Previously billed</th>
                <th className="right">This billing</th>
              </tr>
            </thead>
            <tbody>
              {billing.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.scopeItem.name}</td>
                  <td className="right mono">{formatMoney(l.scopeValue)}</td>
                  <td className="right mono faint">{l.previousPct.toFixed(2)}%</td>
                  <td className="right mono">{l.toDatePct.toFixed(2)}%</td>
                  <td className="right mono faint">{formatMoney(l.previousAmount)}</td>
                  <td className="right mono">{formatMoney(l.thisPeriodAmount)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={5} className="right">
                  <strong>GROSS THIS BILLING</strong>
                </td>
                <td className="right mono">
                  <strong>{formatMoney(billing.grossAmount)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card del-gap-top del-summary">
        <h3 className="card-title">Summary</h3>
        <table className="data">
          <tbody>
            <SumRow label="Gross amount this billing" value={formatMoney(billing.grossAmount)} />
            {billing.downpaymentRecouped !== null && (
              <SumRow label="Less: downpayment recouped" value={formatMoney(-billing.downpaymentRecouped)} />
            )}
            {billing.retentionWithheld !== null && (
              <SumRow label="Less: retention withheld" value={formatMoney(-billing.retentionWithheld)} />
            )}
            <SumRow label={`Add: VAT (${(billing.vatRate * 100).toFixed(0)}%)`} value={formatMoney(billing.vatAmount)} />
            <SumRow label="INVOICE TOTAL" value={formatMoney(billing.invoiceTotal)} strong />
            <SumRow
              label={`Less: creditable withholding tax (${(billing.ewtRate * 100).toFixed(0)}%)`}
              value={formatMoney(-billing.ewtAmount)}
            />
            <SumRow label="NET COLLECTIBLE" value={formatMoney(billing.netCollectible)} strong />
          </tbody>
        </table>
        {billing.downpaymentRecouped === null && billing.retentionWithheld === null && (
          <p className="faint del-note">
            Downpayment recoupment and retention are switched off. The lines appear here
            automatically if either is turned on for a project.
          </p>
        )}
      </div>
    </div>
  );
}

function SumRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr>
      <td>{strong ? <strong>{label}</strong> : label}</td>
      <td className="right mono">{strong ? <strong>{value}</strong> : value}</td>
    </tr>
  );
}

// ════════════════════════════════════════════════════════════════════
//  BUDGET MONITORING ACROSS ALL PROJECTS
// ════════════════════════════════════════════════════════════════════

interface MonitorRow {
  id: string;
  number: string;
  name: string;
  status: string;
  contractValue: number;
  actualCost: number;
  grossMarginPct: number;
  expectedMarginPct: number;
  billed: number;
  progressPct: number;
  customer: { name: string };
}

export function BudgetMonitoring() {
  const navigate = useNavigate();

  const columns: Column<MonitorRow>[] = [
    { key: 'number', label: 'Project', sortKey: 'number', render: (j) => (
      <div>
        <div className="mono">{j.number}</div>
        <div className="faint">{j.name}</div>
      </div>
    ) },
    { key: 'customer', label: 'Customer', render: (j) => j.customer.name },
    { key: 'progress', label: 'Progress', render: (j) => <ProgressBar pct={j.progressPct} /> },
    {
      key: 'contractValue',
      label: 'Contract',
      sortKey: 'contractValue',
      align: 'right',
      render: (j) => <span className="mono">{formatMoney(j.contractValue)}</span>,
    },
    { key: 'cost', label: 'Cost to date', align: 'right', render: (j) => <span className="mono">{formatMoney(j.actualCost)}</span> },
    { key: 'billed', label: 'Billed', align: 'right', render: (j) => <span className="mono">{formatMoney(j.billed)}</span> },
    {
      key: 'unbilled',
      label: 'Unbilled',
      align: 'right',
      render: (j) => {
        const unbilled = (j.contractValue * j.progressPct) / 100 - j.billed;
        return (
          <span className={`mono${unbilled > 0 ? ' del-warn' : ''}`}>{formatMoney(unbilled)}</span>
        );
      },
    },
    {
      key: 'margin',
      label: 'Margin',
      align: 'right',
      // Expected margin from the costing — margin computed from spend-so-far
      // reads 100% on a job that has barely started.
      render: (j) => (
        <span
          className={`badge ${marginTone(j.expectedMarginPct)}`}
          title="Expected margin, from the costing"
        >
          {j.expectedMarginPct.toFixed(1)}%
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Budget Monitoring</h1>
        </div>
      </div>

      <DataList<MonitorRow>
        listKey="budget-monitoring"
        endpoint="/jobs"
        columns={columns}
        rowKey={(j) => j.id}
        searchPlaceholder="Search project, customer…"
        onRowClick={(j) => navigate(`/g-ops/projects/${j.id}`)}
        emptyTitle="No projects yet"
        // The same projects as the Projects list, printed in this screen's budget columns.
        printPath="/api/jobs/budget-monitoring/pdf"
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'IN_PROGRESS', label: 'In progress' },
              { value: 'PLANNING', label: 'Planning' },
              { value: 'COMPLETED', label: 'Completed' },
            ],
          },
        ]}
      />
    </div>
  );
}


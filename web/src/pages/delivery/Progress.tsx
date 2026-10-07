import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  Empty,
  ErrorBox,
  StatusBadge,
  Field,
  Loading,
  Modal,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';
import { ProgressBar } from './Projects';
import { openPdf } from '../../lib/api';
import { Stat } from '../../components/charts';
import { Attachments } from '../../components/Attachments';

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
          <p>
            Reports are a chain — each one carries the previous percentages forward, so it reads as
            a period statement rather than a running total someone has to work out by hand. A
            billing covers only the increment that report added.
          </p>
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
          scoped
          searchPlaceholder="Search number, project…"
          onRowClick={(b) => navigate(`/g-ops/billings/${b.id}`)}
          emptyTitle="Nothing billed yet"
          emptyHint="A billing is raised from an approved progress report, and covers only the work that report added."
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
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'DRAFT', label: 'Draft' },
              { value: 'SUBMITTED', label: 'Awaiting approval' },
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
//  REPORT DETAIL
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
  scopeItem: { id: string; name: string; value: number; kind: string };
}

interface ReportDetail {
  id: string;
  number: string;
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
  canEdit: boolean;
  job: { id: string; number: string; name: string; contractValue: number; customer: { name: string } };
  preparedBy: { id: string; name: string };
  approvedBy: { id: string; name: string } | null;
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

  const [report, setReport] = useState<ReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [narrative, setNarrative] = useState(false);

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

  if (loading) return <Loading />;
  if (!report) return <ErrorBox error={error ?? new Error('Report not found')} />;

  async function setPct(lineId: string, field: 'thisPeriodPct' | 'toDatePct', value: number) {
    if (!report) return;
    try {
      setReport(
        await api.patch<ReportDetail>(`/progress-reports/${report.id}/lines/${lineId}`, {
          [field]: value,
        }),
      );
      setError(null);
    } catch (err) {
      setError(err);
      await load();
    }
  }

  async function approve() {
    if (!report) return;
    try {
      await api.post(`/progress-reports/${report.id}/approve`);
      toast('ok', 'Report approved — it can now be billed');
      await load();
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

  return (
    <div>
      <div className="breadcrumb">
        <Link to={`/g-ops/projects/${report.job.id}`}>{report.job.number}</Link>
        <span className="sep">›</span>
        <Link to="/g-ops/progress">Progress</Link>
        <span className="sep">›</span>
        {report.previousReport && (
          <>
            <Link to={`/g-ops/progress/${report.previousReport.id}`}>#{report.previousReport.reportNo}</Link>
            <span className="sep">›</span>
          </>
        )}
        <span className="mono">
          {report.number} (#{report.reportNo})
        </span>
        {report.nextReport && (
          <>
            <span className="sep">›</span>
            <Link to={`/g-ops/progress/${report.nextReport.id}`}>#{report.nextReport.reportNo}</Link>
          </>
        )}
      </div>

      <div className="page-head">
        <div>
          <h1>
            Progress report #{report.reportNo}
          </h1>
          <p>
            {report.job.name} · {report.job.customer.name} · {formatDate(report.periodFrom)} —{' '}
            {formatDate(report.periodTo)} <StatusBadge status={report.status} />
          </p>
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={() => openPdf(`/api/progress-reports/${report.id}/pdf`, () => toast('error', 'Could not print'))}
          >
            Print
          </button>
          {report.canEdit && (
            <button className="btn" onClick={() => setNarrative(true)}>
              Narrative
            </button>
          )}
          {report.status === 'DRAFT' && can('gops.progress_billing.approve') && (
            <button className="btn btn-ok" onClick={approve}>
              Approve
            </button>
          )}
          {report.status === 'APPROVED' && !report.billing && can('gops.progress_billing.create') && (
            <button className="btn btn-primary" onClick={bill}>
              Raise billing
            </button>
          )}
        </div>
      </div>

      <ErrorBox error={error} />

      {report.billing && (
        <div className="alert ok">
          Billed as{' '}
          <Link to={`/g-ops/billings/${report.billing.id}`}>{report.billing.number}</Link> —{' '}
          {formatMoney(report.billing.grossAmount)}
        </div>
      )}
      {report.status === 'APPROVED' && (
        <div className="alert info">
          Approved{report.approvedBy ? ` by ${report.approvedBy.name}` : ''}. The percentages here
          are now the record of what was reported and cannot be changed.
        </div>
      )}

      <div className="kpi-grid">
        <Stat label="Contract value" value={formatMoney(report.totals.contractValue)} figure />
        <Stat
          label="This period"
          value={formatMoney(report.totals.thisPeriodValue)}
          figure
          accent="neon"
          hint="value reported this period"
        />
        <Stat label="Earned to date" value={formatMoney(report.totals.earnedValue)} figure />
        <Stat label="Complete" value={<ProgressBar pct={report.totals.toDatePct} />} />
      </div>

      <div className="card">
        <h3 className="card-title">Accomplishment against the schedule of values</h3>
        <p className="muted del-lede">
          {report.canEdit
            ? 'Enter either the percentage done this period or the cumulative to-date figure — the other follows.'
            : 'Percentages as reported for this period.'}
        </p>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Scope</th>
                <th className="right">Value</th>
                <th className="right">Previous</th>
                <th className="right del-col-pct">This period</th>
                <th className="right del-col-pct">To date</th>
                <th className="right">Earned to date</th>
              </tr>
            </thead>
            <tbody>
              {report.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div>{l.scopeItem.name}</div>
                    <div className="faint">{l.scopeItem.kind.toLowerCase().replace(/_/g, ' ')}</div>
                  </td>
                  <td className="right mono">{formatMoney(l.scopeItem.value)}</td>
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
                  <td className="right mono">{formatMoney(l.toDateAmount)}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>TOTAL</strong>
                </td>
                <td className="right mono">
                  <strong>{formatMoney(report.totals.contractValue)}</strong>
                </td>
                <td />
                <td className="right mono">{report.totals.thisPeriodPct.toFixed(2)}%</td>
                <td className="right mono">
                  <strong>{report.totals.toDatePct.toFixed(2)}%</strong>
                </td>
                <td className="right mono">
                  <strong>{formatMoney(report.totals.earnedValue)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {(report.accomplishment || report.manpower || report.issues || report.nextPeriodPlan) && (
        <div className="grid grid-2 del-gap-top">
          {report.accomplishment && (
            <div className="card">
              <h3 className="card-title">Work accomplished</h3>
              <div className="del-prose">{report.accomplishment}</div>
            </div>
          )}
          {(report.manpower || report.equipment) && (
            <div className="card">
              <h3 className="card-title">Resources</h3>
              <dl className="kv">
                {report.manpower && (
                  <>
                    <dt>Manpower</dt>
                    <dd>{report.manpower}</dd>
                  </>
                )}
                {report.equipment && (
                  <>
                    <dt>Equipment</dt>
                    <dd>{report.equipment}</dd>
                  </>
                )}
                {report.weather && (
                  <>
                    <dt>Weather / delays</dt>
                    <dd>{report.weather}</dd>
                  </>
                )}
              </dl>
            </div>
          )}
          {report.issues && (
            <div className="card">
              <h3 className="card-title">Issues</h3>
              <div className="del-prose">{report.issues}</div>
            </div>
          )}
          {report.nextPeriodPlan && (
            <div className="card">
              <h3 className="card-title">Next period</h3>
              <div className="del-prose">{report.nextPeriodPlan}</div>
            </div>
          )}
        </div>
      )}

      {/* The site photos are the evidence the percentages rest on (model §2.10).
          The PDF already prints them; an approved report's evidence is frozen
          with it. */}
      <div className="del-gap-top">
        <Attachments
          entityType="progress_report"
          entityId={report.id}
          title="Photos"
          hint="Site photos for this period — they print on the report."
          canEdit={report.canEdit && report.status !== 'APPROVED'}
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
    </div>
  );
}

/** Commits on blur or Enter rather than on every keystroke. */
function PctInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(value.toString());
  useEffect(() => setText(value.toString()), [value]);

  function commit() {
    const n = Number(text);
    if (Number.isFinite(n) && n !== value) onCommit(n);
    else setText(value.toString());
  }

  return (
    <input
      className="mono del-pct-input"
      aria-label="Percentage"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function NarrativeModal({
  report,
  onClose,
  onSaved,
}: {
  report: ReportDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    accomplishment: report.accomplishment ?? '',
    manpower: report.manpower ?? '',
    equipment: report.equipment ?? '',
    weather: report.weather ?? '',
    issues: report.issues ?? '',
    nextPeriodPlan: report.nextPeriodPlan ?? '',
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/progress-reports/${report.id}`, {
        accomplishment: form.accomplishment || null,
        manpower: form.manpower || null,
        equipment: form.equipment || null,
        weather: form.weather || null,
        issues: form.issues || null,
        nextPeriodPlan: form.nextPeriodPlan || null,
      });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title="Report narrative"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Work accomplished this period">
        <textarea
          value={form.accomplishment}
          onChange={(e) => setForm({ ...form, accomplishment: e.target.value })}
        />
      </Field>
      <div className="grid grid-2">
        <Field label="Manpower deployed">
          <input
            value={form.manpower}
            placeholder="4 fitters, 2 welders, 1 supervisor"
            onChange={(e) => setForm({ ...form, manpower: e.target.value })}
          />
        </Field>
        <Field label="Equipment deployed">
          <input
            value={form.equipment}
            placeholder="Welding machine, chain block, boom truck"
            onChange={(e) => setForm({ ...form, equipment: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Weather and delays">
        <input value={form.weather} onChange={(e) => setForm({ ...form, weather: e.target.value })} />
      </Field>
      <Field label="Issues">
        <textarea value={form.issues} onChange={(e) => setForm({ ...form, issues: e.target.value })} />
      </Field>
      <Field label="Plan for next period">
        <textarea
          value={form.nextPeriodPlan}
          onChange={(e) => setForm({ ...form, nextPeriodPlan: e.target.value })}
        />
      </Field>
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
}

export function BillingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const toast = useToast();

  const [billing, setBilling] = useState<BillingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

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

  async function approve() {
    if (!billing) return;
    try {
      await api.post(`/billings/${billing.id}/approve`);
      toast('ok', 'Billing approved');
      await load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="breadcrumb">
        <Link to={`/g-ops/projects/${billing.job.id}`}>{billing.job.number}</Link>
        <span className="sep">›</span>
        <Link to={`/g-ops/progress/${billing.progressReport.id}`}>{billing.progressReport.number}</Link>
        <span className="sep">›</span>
        <span className="mono">{billing.number}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>Progress billing #{billing.billingNo}</h1>
          <p>
            {billing.job.name} · {billing.job.customer.name} · {formatDate(billing.billingDate)}{' '}
            <StatusBadge status={billing.status} />
          </p>
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={() => openPdf(`/api/billings/${billing.id}/pdf`, () => toast('error', 'Could not print'))}
          >
            Print
          </button>
          {billing.status === 'DRAFT' && can('gops.progress_billing.approve') && (
            <button className="btn btn-ok" onClick={approve}>
              Approve
            </button>
          )}
          {/* The hand-off to Finance. The invoice copies this billing's figures,
              so it is raised from here rather than keyed again in A/R. */}
          {!billing.invoice && billing.status === 'APPROVED' && can('gfin.ar.create') && (
            <Link className="btn btn-primary" to={`/g-fin/ar?raise=${billing.id}`}>
              Raise invoice
            </Link>
          )}
        </div>
      </div>

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
          {!can('gfin.ar.create') && ' Finance raises the invoice from this billing.'}
        </div>
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
          className={`badge ${j.expectedMarginPct < 0 ? 'danger' : j.expectedMarginPct < 10 ? 'warn' : 'ok'}`}
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
          <p>
            Every live project on one page. <strong>Unbilled</strong> is work done but not yet
            invoiced — cash you are owed and have not asked for. Open a project for its per-category
            budget position.
          </p>
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

/** Register of approved plans across every project. */
export function PlansRegister() {
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);

  useEffect(() => {
    // Closed jobs too: an as-built drawing is looked up long after turnover.
    api.get<typeof jobs>('/jobs/lookup?includeClosed=true').then(setJobs).catch(() => {});
  }, []);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Approved Plans</h1>
          <p>
            Plans are registered and approved inside each project, on its Plans tab. Work should not
            start on an unapproved plan.
          </p>
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="card">
          <Empty title="No projects yet" />
        </div>
      ) : (
        <div className="grid grid-3">
          {jobs.map((j) => (
            <Link key={j.id} className="card card-button" to={`/g-ops/projects/${j.id}?tab=plans`}>
              <div className="mono faint del-small">{j.number}</div>
              <strong>{j.name}</strong>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

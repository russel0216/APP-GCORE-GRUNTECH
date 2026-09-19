import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDate,
  formatMoney,
  useToast,
} from '../../components/ui';
import { ProgressBar } from './Projects';
import { openPdf } from './ProjectWorkspace';

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

export function ProgressReports() {
  const navigate = useNavigate();

  const columns: Column<ReportRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (r) => <span className="mono">{r.number}</span> },
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
    { key: 'progress', label: 'To date', width: '130px', render: (r) => <ProgressBar pct={r.toDatePct} /> },
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
      render: (r) => (
        <span className={`badge ${r.status === 'APPROVED' ? 'ok' : 'warn'}`}>{r.status.toLowerCase()}</span>
      ),
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Progress &amp; Billing</h1>
          <p>
            Reports are a chain — each one carries the previous percentages forward, so it reads as
            a period statement rather than a running total someone has to work out by hand.
          </p>
        </div>
      </div>

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
              { value: 'APPROVED', label: 'Approved' },
            ],
          },
        ]}
      />
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
            {formatDate(report.periodTo)}
            <span className={`badge ${report.status === 'APPROVED' ? 'ok' : 'warn'}`} style={{ marginLeft: 8 }}>
              {report.status.toLowerCase()}
            </span>
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

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Contract value" value={formatMoney(report.totals.contractValue)} />
        <Stat label="This period" value={formatMoney(report.totals.thisPeriodValue)} accent />
        <Stat label="Earned to date" value={formatMoney(report.totals.earnedValue)} />
        <Stat label="Complete" value={<ProgressBar pct={report.totals.toDatePct} />} />
      </div>

      <div className="card">
        <h3 className="card-title">Accomplishment against the schedule of values</h3>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
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
                <th className="right" style={{ width: 110 }}>
                  This period
                </th>
                <th className="right" style={{ width: 110 }}>
                  To date
                </th>
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
        <div className="grid grid-2" style={{ marginTop: 16 }}>
          {report.accomplishment && (
            <div className="card">
              <h3 className="card-title">Work accomplished</h3>
              <div style={{ whiteSpace: 'pre-wrap' }}>{report.accomplishment}</div>
            </div>
          )}
          {(report.manpower || report.equipment) && (
            <div className="card">
              <h3 className="card-title">Resources</h3>
              {report.manpower && <Row label="Manpower" value={report.manpower} />}
              {report.equipment && <Row label="Equipment" value={report.equipment} />}
              {report.weather && <Row label="Weather / delays" value={report.weather} />}
            </div>
          )}
          {report.issues && (
            <div className="card">
              <h3 className="card-title">Issues</h3>
              <div style={{ whiteSpace: 'pre-wrap' }}>{report.issues}</div>
            </div>
          )}
          {report.nextPeriodPlan && (
            <div className="card">
              <h3 className="card-title">Next period</h3>
              <div style={{ whiteSpace: 'pre-wrap' }}>{report.nextPeriodPlan}</div>
            </div>
          )}
        </div>
      )}

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
      className="mono"
      style={{ textAlign: 'right', padding: '5px 7px' }}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className="card">
      <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontSize: 18, marginTop: 6, fontWeight: 600, color: accent ? 'var(--neon)' : 'var(--text)' }}>
        {value}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <span className="faint" style={{ width: 140, flexShrink: 0, fontSize: 12 }}>
        {label}
      </span>
      <span>{value || <span className="faint">—</span>}</span>
    </div>
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
            {billing.job.name} · {billing.job.customer.name} · {formatDate(billing.billingDate)}
            <span
              className={`badge ${billing.status === 'APPROVED' || billing.status === 'INVOICED' ? 'ok' : 'warn'}`}
              style={{ marginLeft: 8 }}
            >
              {billing.status.toLowerCase()}
            </span>
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
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat label="Gross this billing" value={formatMoney(billing.grossAmount)} />
        <Stat label={`VAT ${(billing.vatRate * 100).toFixed(0)}%`} value={formatMoney(billing.vatAmount)} />
        <Stat label="Invoice total" value={formatMoney(billing.invoiceTotal)} accent />
        <Stat label="Net collectible" value={formatMoney(billing.netCollectible)} />
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

      <div className="card" style={{ marginTop: 16, maxWidth: 520 }}>
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
          <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
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
//  BUDGET REQUESTS LIST
// ════════════════════════════════════════════════════════════════════

interface BudgetRequestRow {
  id: string;
  number: string;
  status: string;
  amount: number;
  reason: string;
  createdAt: string;
  job: { id: string; number: string; name: string };
  costCategory: { id: string; name: string };
  requestedBy: { id: string; name: string };
}

export function BudgetRequests() {
  const navigate = useNavigate();

  const columns: Column<BudgetRequestRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (r) => <span className="mono">{r.number}</span> },
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
    { key: 'category', label: 'Budget line', render: (r) => r.costCategory.name },
    {
      key: 'amount',
      label: 'Amount',
      sortKey: 'amount',
      align: 'right',
      render: (r) => <span className="mono">{formatMoney(r.amount)}</span>,
    },
    { key: 'reason', label: 'Reason', render: (r) => r.reason },
    { key: 'requestedBy', label: 'Raised by', render: (r) => r.requestedBy.name },
    { key: 'createdAt', label: 'Raised', sortKey: 'createdAt', render: (r) => formatDate(r.createdAt) },
    {
      key: 'status',
      label: 'Status',
      render: (r) => (
        <span
          className={`badge ${
            r.status === 'APPROVED' ? 'ok' : r.status === 'REJECTED' ? 'danger' : 'warn'
          }`}
        >
          {r.status.toLowerCase().replace(/_/g, ' ')}
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Budget Requests</h1>
          <p>
            A budget request <strong>changes</strong> the budget. A purchase request{' '}
            <strong>spends</strong> it. Approving one raises the budgeted column on the project —
            it does not order anything.
          </p>
        </div>
      </div>

      <DataList<BudgetRequestRow>
        listKey="budget-requests"
        endpoint="/budget-requests"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        searchPlaceholder="Search number, reason, project…"
        onRowClick={(r) => navigate(`/g-ops/projects/${r.job.id}`)}
        emptyTitle="No budget requests"
        emptyHint="Raise one from a project's Budget tab when the budget needs to change."
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'DRAFT', label: 'Draft' },
              { value: 'PENDING_APPROVAL', label: 'Pending' },
              { value: 'APPROVED', label: 'Approved' },
              { value: 'REJECTED', label: 'Rejected' },
            ],
          },
        ]}
      />
    </div>
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
    { key: 'progress', label: 'Progress', width: '120px', render: (j) => <ProgressBar pct={j.progressPct} /> },
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
          <span className="mono" style={{ color: unbilled > 0 ? 'var(--warn)' : undefined }}>
            {formatMoney(unbilled)}
          </span>
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
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<{ id: string; number: string; name: string }[]>([]);

  useEffect(() => {
    api.get<typeof jobs>('/jobs/lookup').then(setJobs).catch(() => {});
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
            <div
              key={j.id}
              className="card"
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/g-ops/projects/${j.id}`)}
            >
              <div className="mono faint" style={{ fontSize: 12 }}>
                {j.number}
              </div>
              <strong>{j.name}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

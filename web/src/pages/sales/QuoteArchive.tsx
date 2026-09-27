import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, downloadBlob, openPdf, qs, type ListResult } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column, type FilterDef } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import {
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  StatusBadge,
  formatDate,
  formatDateTime,
  formatMoney,
  useToast,
  type Tone,
} from '../../components/ui';

/**
 * G-OPS › Sales › SCORO Archive — the read-only history of quotations raised
 * in SCORO before Gruntech moved to G-CORE.
 *
 * Nothing here edits a SCORO quote. The PDF SCORO produced is the record; the
 * lines shown were read back out of it. An OPEN quote (Opportunity,
 * Negotiation, Closing, Hold, This Month Forecast, Confirmed) can be continued
 * as a live G-CORE quotation under the same number; a closed one stays history.
 */

/** SCORO's own statuses, keyed the way statusTone() compares them (uppercase). */
export const SCORO_STATUS_TONES: Record<string, Tone> = {
  COMPLETED: 'ok',
  CONFIRMED: 'info',
  'CONFIRMED PROJECT': 'info',
  OPPORTUNITY: '',
  CLOSING: '',
  NEGOTIATION: '',
  'THIS MONTH FORECAST': '',
  HOLD: 'warn',
  REJECTED: 'danger',
  CANCELLED: 'danger',
};

/** A SCORO status, verbatim, in the one status pill. */
export function ScoroStatus({ status }: { status: string }) {
  return <StatusBadge status={status} extra={SCORO_STATUS_TONES} label={status} />;
}

interface ArchiveRow {
  id: string;
  number: string;
  date: string | null;
  customerName: string;
  customerId: string | null;
  customer: { id: string; name: string } | null;
  contactName: string | null;
  name: string | null;
  projectName: string | null;
  ownerName: string;
  status: string;
  currency: string;
  total: number;
  linesReconcile: boolean;
  isOpen: boolean;
  continuedQuotation: { id: string; number: string } | null;
}

interface Facets {
  total: number;
  unmatched: number;
  owners: { name: string; count: number }[];
  statuses: { status: string; count: number; open: boolean }[];
  years: number[];
}

const stop = (e: MouseEvent) => e.stopPropagation();

/** One label/value pair — the same markup as Customer 360's, in the same `m-details` list. */
function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || <span className="faint">—</span>}</dd>
    </div>
  );
}

export function QuoteArchive() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const customerId = params.get('customerId') ?? '';
  const [facets, setFacets] = useState<Facets | null>(null);
  const [importing, setImporting] = useState(false);
  const [reload, setReload] = useState(0);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const toast = useToast();

  const loadFacets = useCallback(() => {
    api
      .get<Facets>('/quote-archive/facets')
      .then(setFacets)
      .catch(() => setFacets(null));
  }, []);
  useEffect(loadFacets, [loadFacets, reload]);

  // Name the customer a "View all" link narrowed the list to.
  useEffect(() => {
    setCustomerName(null);
    if (!customerId) return;
    api
      .get<ListResult<ArchiveRow>>(`/quote-archive${qs({ customerId, pageSize: 1 })}`)
      .then((r) => setCustomerName(r.rows[0]?.customer?.name ?? null))
      .catch(() => setCustomerName(null));
  }, [customerId]);

  const filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Status',
      options: [
        { value: 'OPEN', label: 'Open — can be continued' },
        { value: 'CLOSED', label: 'Closed — view only' },
        ...(facets?.statuses ?? []).map((s) => ({ value: s.status, label: `${s.status} (${s.count})` })),
      ],
    },
    {
      key: 'owner',
      label: 'Owner',
      options: (facets?.owners ?? []).map((o) => ({ value: o.name, label: `${o.name} (${o.count})` })),
    },
    { key: 'year', label: 'Year', options: (facets?.years ?? []).map((y) => ({ value: String(y), label: String(y) })) },
    {
      key: 'continued',
      label: 'Continued',
      options: [
        { value: 'yes', label: 'Continued in G-CORE' },
        { value: 'no', label: 'Not continued' },
      ],
    },
    {
      key: 'customer',
      label: 'Customer',
      options: [{ value: 'unmatched', label: 'Not linked to a G-CORE customer' }],
    },
  ];

  const columns: Column<ArchiveRow>[] = [
    { key: 'number', label: 'Quote No.', sortKey: 'number', width: '9rem', render: (r) => <span className="mono">{r.number}</span> },
    { key: 'date', label: 'Date', sortKey: 'date', render: (r) => formatDate(r.date) },
    {
      key: 'customer',
      label: 'Client',
      sortKey: 'customerName',
      render: (r) => (
        <div>
          <div>
            {r.customer?.name ?? r.customerName}
            {!r.customer && (
              <>
                {' '}
                <span className="faint archive-inline">not linked</span>
              </>
            )}
          </div>
          {r.name && <div className="faint">{r.name}</div>}
        </div>
      ),
    },
    { key: 'contact', label: 'Contact', optional: true, render: (r) => r.contactName ?? '—' },
    { key: 'project', label: 'Project', optional: true, render: (r) => r.projectName ?? '—' },
    { key: 'owner', label: 'Author', sortKey: 'ownerName', render: (r) => r.ownerName },
    {
      key: 'total',
      label: 'Total',
      sortKey: 'total',
      align: 'right',
      render: (r) => <span className="mono">{formatMoney(r.total, r.currency || 'PHP')}</span>,
    },
    { key: 'status', label: 'Status', sortKey: 'status', render: (r) => <ScoroStatus status={r.status} /> },
    {
      key: 'continued',
      label: 'In G-CORE',
      render: (r) =>
        r.continuedQuotation ? (
          <Link className="mono" to={`/g-ops/quotations/${r.continuedQuotation.id}`} onClick={stop}>
            {r.continuedQuotation.number}
          </Link>
        ) : r.isOpen ? (
          <span className="faint">open</span>
        ) : (
          <span className="faint">—</span>
        ),
    },
  ];

  /** The server export takes the same filters the list shows, read off the URL the list keeps. */
  async function exportAll() {
    const query: Record<string, string> = {};
    const search = params.get('q');
    if (search) query.search = search;
    for (const key of ['status', 'owner', 'year', 'continued', 'customer', 'customerId']) {
      const v = params.get(key);
      if (v) query[key] = v;
    }
    try {
      await downloadBlob(`/quote-archive/export.csv${qs(query)}`, 'scoro-quotes.csv');
    } catch {
      toast('error', 'The export failed');
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>SCORO Archive</h1>
          <p>
            Read-only history from SCORO. Every quote is kept as SCORO issued it, with its PDF as the
            record. An open quote can be continued in G-CORE under the same number; a closed one is
            here to look up.
          </p>
        </div>
      </div>

      {customerId && (
        <div className="alert info archive-scope">
          Showing the SCORO history of {customerName ?? 'one customer'}.{' '}
          <Link to="/g-ops/quote-archive">Show every SCORO quote</Link>
        </div>
      )}

      {facets && facets.unmatched > 0 && !customerId && (
        <div className="alert warn archive-scope">
          {facets.unmatched} of {facets.total} SCORO quotes are not linked to a G-CORE customer. They are
          archived all the same; link one from its page before continuing it.
        </div>
      )}

      <DataList<ArchiveRow>
        listKey="quote-archive"
        endpoint="/quote-archive"
        columns={columns}
        filters={filters}
        initialFilters={customerId ? { customerId } : undefined}
        rowKey={(r) => r.id}
        searchPlaceholder="Search quote no., client, name, author…"
        reloadToken={reload}
        onRowClick={(r) => navigate(`/g-ops/quote-archive/${r.id}`)}
        emptyTitle={facets?.total === 0 ? 'The SCORO archive is empty' : 'No SCORO quotes match'}
        emptyHint={
          facets?.total === 0
            ? 'Import the bundle made by tools/scoro/scoro_quotes.py, from here or with scripts/import-scoro-quotes.ts on the server.'
            : undefined
        }
        emptyAction={
          facets?.total === 0 && can('gops.quote_archive.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setImporting(true)}>
              Import from SCORO
            </button>
          ) : undefined
        }
        actions={
          <>
            {can('gops.quote_archive.export') && (
              <button className="btn btn-sm" onClick={() => void exportAll()}>
                Export all (CSV)
              </button>
            )}
            {can('gops.quote_archive.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setImporting(true)}>
                Import from SCORO
              </button>
            )}
          </>
        }
      />

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={() => {
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

// ── Import ───────────────────────────────────────────────────────────────────

interface CounterPlan {
  periodKey: string;
  month: string;
  emp: string;
  scoroSeq: number;
  existing: number | null;
  target: number;
  change: 'create' | 'raise' | 'keep';
}

interface ImportReport {
  source: string;
  committed: boolean;
  totals: {
    quotes: number;
    created: number;
    updated: number;
    skipped: number;
    open: number;
    closed: number;
    withPdf: number;
    missingPdf: number;
    noPdf: number;
    byStatus: Record<string, number>;
  };
  customers: {
    matchedByName: number;
    matchedByScoroId: number;
    unmatchedQuotes: number;
    matched: { name: string; customerId: string; customerName: string; by: 'name' | 'scoro_id'; quotes: number }[];
    unmatched: { name: string; scoroId: string; quotes: number }[];
  };
  owners: {
    name: string;
    quotes: number;
    codes: { code: string; count: number }[];
    primaryCode: string | null;
    user: { id: string; name: string; employeeNo: string | null; token: string } | null;
    mismatch: boolean;
    message: string | null;
  }[];
  notReconciling: { number: string; customer: string; subtotal: number; linesSum: number }[];
  notHouseFormat: { number: string; date: string; owner: string }[];
  counters: CounterPlan[];
  counterTemplate: { pattern: string; period: string; scope: string; houseScheme: boolean } | null;
  pdfs: { stored: number; replaced: number; kept: number; missing: string[]; noPdf: string[] };
  warnings: string[];
}

function nextAfter(c: CounterPlan): string {
  return `${c.emp}${c.month.slice(2, 4)}${c.month.slice(5, 7)}${String(c.target + 1).padStart(3, '0')}`;
}

function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [quotesFile, setQuotesFile] = useState<File | null>(null);
  const [pdfs, setPdfs] = useState<File[]>([]);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const close = useCallback(() => onClose(), [onClose]);

  function form(): FormData {
    const fd = new FormData();
    if (quotesFile) fd.append('quotes', quotesFile, 'quotes.json');
    for (const f of pdfs) fd.append('pdfs', f, f.name);
    return fd;
  }

  async function run(commit: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<ImportReport>(`/quote-archive/import${commit ? '?commit=true' : ''}`, form());
      setReport(r);
      if (commit) {
        toast('ok', `${r.totals.quotes} SCORO quotes imported`);
        onImported();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const committed = report?.committed ?? false;

  return (
    <Modal
      title="Import from SCORO"
      onClose={close}
      wide
      footer={
        <>
          <button className="btn" onClick={close}>
            {committed ? 'Close' : 'Cancel'}
          </button>
          {!committed && (
            <button className="btn" disabled={!quotesFile || busy} onClick={() => void run(false)}>
              {busy && !report ? 'Checking…' : 'Check (dry run)'}
            </button>
          )}
          {report && !committed && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void run(true)}>
              {busy ? 'Importing…' : `Import ${report.totals.quotes} quotes`}
            </button>
          )}
        </>
      }
    >
      <p className="muted archive-lead">
        Choose the <span className="mono">quotes.json</span> and the PDFs from the bundle that{' '}
        <span className="mono">tools/scoro/scoro_quotes.py</span> made. A dry run writes nothing; it shows
        what the import would do. Importing again later updates the archive rather than duplicating it.
      </p>

      <div className="grid grid-2">
        <Field label="quotes.json" required>
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              setQuotesFile(e.target.files?.[0] ?? null);
              setReport(null);
            }}
          />
        </Field>
        <Field label="Quote PDFs" hint={pdfs.length ? `${pdfs.length} selected` : 'Select every file in the bundle\'s pdf folder'}>
          <input
            type="file"
            accept=".pdf,application/pdf"
            multiple
            onChange={(e) => {
              setPdfs(Array.from(e.target.files ?? []));
              setReport(null);
            }}
          />
        </Field>
      </div>

      <ErrorBox error={error} />
      {report && <ImportReportView report={report} />}
    </Modal>
  );
}

function ImportReportView({ report }: { report: ImportReport }) {
  const t = report.totals;
  const c = report.customers;
  return (
    <div className="archive-report">
      <div className={`alert ${report.committed ? 'ok' : 'info'}`}>
        {report.committed ? 'Imported: ' : 'Dry run — nothing written yet: '}
        {t.quotes} quotes ({t.created} new, {t.updated} already archived
        {t.skipped ? `, ${t.skipped} skipped` : ''}). {t.open} open, {t.closed} closed. {t.withPdf} PDFs
        {t.missingPdf ? `, ${t.missingPdf} missing` : ''}
        {t.noPdf ? `, no PDF: ${t.noPdf} (SCORO exported none)` : ''}.
        {report.committed &&
          ` PDFs: ${report.pdfs.stored} stored, ${report.pdfs.replaced} replaced, ${report.pdfs.kept} unchanged.`}
      </div>

      {report.warnings.map((w) => (
        <div key={w} className="alert warn">
          {w}
        </div>
      ))}

      <h4>Customers</h4>
      <p>
        {c.matchedByName} quotes matched by name, {c.matchedByScoroId} by SCORO id,{' '}
        <strong>{c.unmatchedQuotes} unmatched</strong>
        {c.unmatched.length ? ` across ${c.unmatched.length} SCORO customers` : ''}.
      </p>
      {c.unmatched.length > 0 && (
        <details>
          <summary>Unmatched SCORO customers</summary>
          <ul className="archive-list">
            {c.unmatched.map((u) => (
              <li key={u.name}>
                {u.name}
                {u.scoroId && <span className="faint"> · SCORO id {u.scoroId}</span>}
                <span className="faint"> · {u.quotes} quote(s)</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {c.matched.length > 0 && (
        <details>
          <summary>Matched customers</summary>
          <ul className="archive-list">
            {c.matched.map((m) => (
              <li key={m.name}>
                {m.name} → {m.customerName}
                <span className="faint"> · by {m.by === 'name' ? 'name' : 'SCORO id'} · {m.quotes} quote(s)</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <h4>Owners</h4>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>SCORO owner</th>
              <th className="num">Quotes</th>
              <th>Codes in SCORO numbers</th>
              <th>G-CORE user</th>
              <th>Numbers as</th>
            </tr>
          </thead>
          <tbody>
            {report.owners.map((o) => (
              <tr key={o.name}>
                <td>
                  {o.name}
                  {o.message && <div className={o.mismatch ? 'archive-problem' : 'faint'}>{o.message}</div>}
                </td>
                <td className="num">{o.quotes}</td>
                <td className="mono">{o.codes.map((x) => `${x.code} ×${x.count}`).join(', ') || '—'}</td>
                <td>{o.user ? `${o.user.name}${o.user.employeeNo ? ` · ${o.user.employeeNo}` : ''}` : '—'}</td>
                <td className="mono">
                  {o.user ? o.user.token : '—'}
                  {o.mismatch && <StatusBadge status="MISMATCH" extra={{ MISMATCH: 'danger' }} label="mismatch" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4>Quotation numbering</h4>
      {report.counters.length === 0 ? (
        <p className="muted">No SCORO number is dated this month or later, so no counter needs continuing.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Counter</th>
                <th className="num">SCORO last</th>
                <th className="num">Counter now</th>
                <th className="num">After import</th>
                <th>Next number</th>
              </tr>
            </thead>
            <tbody>
              {report.counters.map((k) => (
                <tr key={k.periodKey}>
                  <td className="mono">{k.periodKey}</td>
                  <td className="num">{k.scoroSeq}</td>
                  <td className="num">{k.existing ?? 'new'}</td>
                  <td className="num">{k.target}</td>
                  <td className="mono">{nextAfter(k)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.notHouseFormat.length > 0 && (
        <details>
          <summary>Not in the house format — no counter seeded ({report.notHouseFormat.length})</summary>
          <p className="muted">
            A number continues a counter only when it reads code, year, month and sequence and its year and
            month are the quote's own date. These are archived as they are.
          </p>
          <ul className="archive-list">
            {report.notHouseFormat.map((q) => (
              <li key={q.number}>
                <span className="mono">{q.number}</span>
                <span className="faint">
                  {' '}
                  · {q.date || 'no date'} · {q.owner || 'no owner'}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {report.notReconciling.length > 0 && (
        <>
          <h4>Lines that do not add up ({report.notReconciling.length})</h4>
          <p className="muted">
            These are archived all the same — the PDF is the record. Continuing one tells the author to
            check its lines.
          </p>
          <ul className="archive-list">
            {report.notReconciling.map((q) => (
              <li key={q.number}>
                <span className="mono">{q.number}</span> {q.customer}
                <span className="faint">
                  {' '}
                  · lines {formatMoney(q.linesSum)} against SCORO {formatMoney(q.subtotal)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ── One SCORO quote ──────────────────────────────────────────────────────────

interface ArchiveLine {
  title: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
}

interface ArchiveDetail {
  id: string;
  source: string;
  sourceId: string;
  number: string;
  date: string | null;
  dueDate: string | null;
  estimatedClosing: string | null;
  confirmedAt: string | null;
  ownerName: string;
  ownerUser: { id: string; name: string } | null;
  customerName: string;
  customer: { id: string; name: string; code: string } | null;
  contactName: string | null;
  name: string | null;
  projectName: string | null;
  status: string;
  previousStatus: string | null;
  statusChangedAt: string | null;
  statusChangedBy: string | null;
  currency: string;
  discountPct: number;
  subtotal: number;
  vat: number;
  total: number;
  /** Present only for callers who may see costings. */
  cost?: number;
  prNumber: string | null;
  delivery: string | null;
  paymentTerms: string | null;
  comment: string | null;
  invoiceNos: string | null;
  isSent: boolean;
  lines: ArchiveLine[];
  linesReconcile: boolean;
  importedAt: string;
  importedBy: { id: string; name: string } | null;
  continuedQuotation: { id: string; number: string; outcome: string } | null;
  attachmentId: string | null;
  isOpen: boolean;
  canContinue: boolean;
  canLink: boolean;
}

export function QuoteArchiveDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [quote, setQuote] = useState<ArchiveDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const [linking, setLinking] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .get<ArchiveDetail>(`/quote-archive/${id}`)
      .then(setQuote)
      .catch(setError);
  }, [id]);
  useEffect(load, [load]);

  if (error && !quote) {
    return (
      <div>
        <div className="breadcrumb">
          <Link to="/g-ops/quote-archive">SCORO Archive</Link>
        </div>
        <ErrorBox error={error} />
      </div>
    );
  }
  if (!quote) return <Loading />;

  const currency = quote.currency || 'PHP';
  const money = (v: number) => formatMoney(v, currency);
  const vatPct = quote.subtotal ? Math.round((quote.vat / quote.subtotal) * 100) : 12;

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/g-ops/quote-archive">SCORO Archive</Link>
        <span className="sep">›</span>
        <span className="mono">{quote.number}</span>
        {quote.continuedQuotation && (
          <>
            <span className="sep">›</span>
            <Link to={`/g-ops/quotations/${quote.continuedQuotation.id}`}>{quote.continuedQuotation.number}</Link>
          </>
        )}
      </div>

      <RecordHeader
        type="SCORO Quote"
        code={quote.number}
        title={quote.name || quote.customer?.name || quote.customerName}
        status={quote.status}
        statusExtra={SCORO_STATUS_TONES}
        amount={money(quote.total)}
        amountLabel="Total with VAT"
        actions={
          <>
            {quote.attachmentId ? (
              <button
                className="btn"
                onClick={() => openPdf(`/api/quote-archive/${quote.id}/pdf`, () => toast('error', 'Could not open the PDF'))}
              >
                Open PDF
              </button>
            ) : (
              <span className="faint">No PDF was exported from SCORO for this quote</span>
            )}
            {quote.canContinue && (
              <button
                className="btn btn-primary"
                disabled={!quote.customer}
                title={quote.customer ? undefined : 'Link this SCORO quote to a customer first'}
                onClick={() => setConfirming(true)}
              >
                Continue in G-CORE
              </button>
            )}
          </>
        }
      />

      <ErrorBox error={error} />

      {quote.continuedQuotation ? (
        <div className="alert ok">
          Continued as{' '}
          <Link className="mono" to={`/g-ops/quotations/${quote.continuedQuotation.id}`}>
            {quote.continuedQuotation.number}
          </Link>
          . Work on it there — this SCORO record stays as it was.
        </div>
      ) : quote.isOpen ? (
        <div className="alert info">
          Read-only history from SCORO, still open there ({quote.status}).
          {quote.canContinue
            ? ' Continue it in G-CORE to carry on under the same number.'
            : ' Someone who can raise quotations can continue it in G-CORE under the same number.'}
        </div>
      ) : (
        <div className="alert info">
          Read-only history from SCORO. It closed there as {quote.status}, so it is kept to look up and
          cannot be continued.
        </div>
      )}

      {!quote.customer && (
        <div className="alert warn archive-link-alert">
          <span>
            SCORO&rsquo;s client &ldquo;{quote.customerName}&rdquo; is not linked to a G-CORE customer.
            {quote.isOpen && ' Link this SCORO quote to a customer first, then continue it.'}
          </span>
          {quote.canLink && (
            <button className="btn btn-sm" onClick={() => setLinking(true)}>
              Link to customer
            </button>
          )}
        </div>
      )}

      {!quote.linesReconcile && (
        <div className="alert warn">
          Lines read from the PDF do not add up to SCORO&rsquo;s total — the PDF is the record.
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Quote</h3>
          <dl className="m-details">
            <Detail label="Quote No." value={<span className="mono">{quote.number}</span>} />
            <Detail label="Date of issue" value={quote.date ? formatDate(quote.date) : null} />
            <Detail
              label="Client"
              value={
                quote.customer ? (
                  <Link to={`/g-ops/customers/${quote.customer.id}`}>{quote.customer.name}</Link>
                ) : (
                  <>
                    {quote.customerName} <span className="faint">(not linked)</span>
                  </>
                )
              }
            />
            <Detail label="Contact person" value={quote.contactName} />
            <Detail label="Quote name" value={quote.name} />
            <Detail label="Project" value={quote.projectName} />
            <Detail label="Author" value={quote.ownerUser ? quote.ownerUser.name : quote.ownerName} />
            <Detail label="Comment" value={quote.comment ? <span className="archive-pre">{quote.comment}</span> : null} />
          </dl>
        </div>
        <div className="card">
          <h3 className="card-title">Terms and status</h3>
          <dl className="m-details">
            <Detail label="Status" value={<ScoroStatus status={quote.status} />} />
            <Detail
              label="Status changed"
              value={
                quote.statusChangedAt
                  ? `${formatDateTime(quote.statusChangedAt)}${quote.statusChangedBy ? ` by ${quote.statusChangedBy}` : ''}${quote.previousStatus ? `, from ${quote.previousStatus}` : ''}`
                  : null
              }
            />
            <Detail label="Due date" value={quote.dueDate ? formatDate(quote.dueDate) : null} />
            <Detail label="Estimated closing" value={quote.estimatedClosing ? formatDate(quote.estimatedClosing) : null} />
            <Detail label="Date confirmed" value={quote.confirmedAt ? formatDateTime(quote.confirmedAt) : null} />
            <Detail label="PR Number" value={quote.prNumber} />
            <Detail label="Delivery" value={quote.delivery} />
            <Detail label="Payment Terms" value={quote.paymentTerms} />
            <Detail label="Currency" value={currency} />
            <Detail label="Invoices" value={quote.invoiceNos} />
            <Detail label="Sent to client" value={quote.isSent ? 'Yes' : 'No'} />
          </dl>
        </div>
      </div>

      <div className="card archive-card">
        <h3 className="card-title">
          Lines<span className="badge">{quote.lines.length}</span>
        </h3>
        {quote.lines.length === 0 ? (
          <Empty title="No lines could be read from the PDF" hint="Open the PDF — it is the record." />
        ) : (
          <div className="table-wrap">
            <table className="data archive-lines">
              <thead>
                <tr>
                  <th>Product description</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit price</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {quote.lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      {l.title && <div className="archive-line-title">{l.title}</div>}
                      {l.description && <div className="archive-pre">{l.description}</div>}
                    </td>
                    <td className="num">
                      {l.quantity} {l.unit}
                    </td>
                    <td className="num mono">{money(l.unitPrice)}</td>
                    <td className="num mono">{money(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <dl className="m-details archive-totals">
          {quote.discountPct > 0 && <Detail label="Discount" value={`${quote.discountPct}%`} />}
          <Detail label="Sum without tax" value={<span className="mono">{money(quote.subtotal)}</span>} />
          <Detail label={`VAT (${vatPct}%)`} value={<span className="mono">{money(quote.vat)}</span>} />
          <Detail label="Total" value={<strong className="mono">{money(quote.total)}</strong>} />
          {quote.cost !== undefined && (
            <Detail
              label="SCORO cost (internal)"
              value={
                <span className="mono">
                  {money(quote.cost)}
                  {quote.subtotal > 0 && (
                    <span className="faint">
                      {' '}
                      · margin {money(quote.subtotal - quote.cost)} (
                      {(((quote.subtotal - quote.cost) / quote.subtotal) * 100).toFixed(1)}%)
                    </span>
                  )}
                </span>
              }
            />
          )}
        </dl>
      </div>

      <p className="faint archive-foot">
        Imported {formatDateTime(quote.importedAt)}
        {quote.importedBy ? ` by ${quote.importedBy.name}` : ''} from {quote.source} (id {quote.sourceId}).
      </p>

      {confirming && (
        <ContinueDialog
          quote={quote}
          onClose={() => setConfirming(false)}
          onDone={(quotationId) => navigate(`/g-ops/quotations/${quotationId}`)}
        />
      )}
      {linking && (
        <LinkCustomerDialog
          quote={quote}
          onClose={() => setLinking(false)}
          onLinked={() => {
            setLinking(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function ContinueDialog({
  quote,
  onClose,
  onDone,
}: {
  quote: ArchiveDetail;
  onClose: () => void;
  onDone: (quotationId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const close = useCallback(() => onClose(), [onClose]);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ quotationId: string; number: string }>(`/quote-archive/${quote.id}/continue`);
      toast('ok', `Quotation ${r.number} is now live in G-CORE`);
      onDone(r.quotationId);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Continue in G-CORE"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void go()} disabled={busy || !quote.customer}>
            {busy ? 'Creating…' : `Create quotation ${quote.number}`}
          </button>
        </>
      }
    >
      <p>
        This creates a live G-CORE quotation numbered <strong className="mono">{quote.number}</strong> — the
        same number SCORO gave it — for {quote.customer?.name ?? quote.customerName}.
      </p>
      <ul className="archive-list">
        <li>Revision 0, as a draft, with the {quote.lines.length} line(s) read from the SCORO PDF.</li>
        <li>Discount, PR Number, Delivery and Payment Terms carry over; totals are recomputed from the lines.</li>
        <li>It is owned by {quote.ownerUser ? quote.ownerUser.name : 'you'}, and goes through approval like any other quotation.</li>
        <li>This SCORO record stays read-only and links to the new quotation. It can only be continued once.</li>
      </ul>
      {!quote.linesReconcile && (
        <div className="alert warn">
          The lines read from the PDF do not add up to SCORO&rsquo;s total. Check them against the PDF before
          sending the quotation.
        </div>
      )}
      <ErrorBox error={error} />
    </Modal>
  );
}

interface CustomerHit {
  id: string;
  code: string;
  name: string;
}

function LinkCustomerDialog({
  quote,
  onClose,
  onLinked,
}: {
  quote: ArchiveDetail;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [term, setTerm] = useState(quote.customerName.split(/[,.(]/)[0].trim());
  const [hits, setHits] = useState<CustomerHit[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (term.trim().length < 2) {
        setHits([]);
        return;
      }
      api
        .get<ListResult<CustomerHit>>(`/customers${qs({ search: term.trim(), pageSize: 8 })}`)
        .then((r) => setHits(r.rows))
        .catch(setError);
    }, 250);
    return () => clearTimeout(t);
  }, [term]);

  async function pick(c: CustomerHit) {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/quote-archive/${quote.id}/customer`, { customerId: c.id });
      toast('ok', `Linked to ${c.name}`);
      onLinked();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal title="Link to a G-CORE customer" onClose={close}>
      <p className="muted">
        SCORO called this client &ldquo;{quote.customerName}&rdquo;. Pick the G-CORE customer it is.
      </p>
      <Field label="Find customer">
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Name or code" />
      </Field>
      {hits.length === 0 ? (
        <p className="faint">{term.trim().length < 2 ? 'Type at least two letters.' : 'No customer matches.'}</p>
      ) : (
        <ul className="archive-picker">
          {hits.map((c) => (
            <li key={c.id}>
              <button className="btn btn-ghost" disabled={busy} onClick={() => void pick(c)}>
                <span>{c.name}</span>
                <span className="faint mono">{c.code}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorBox error={error} />
    </Modal>
  );
}

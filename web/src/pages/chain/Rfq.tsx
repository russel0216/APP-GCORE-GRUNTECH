import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, openPdf, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { Empty, ErrorBox, Field, Loading, StatusBadge, formatDate, formatMoney, useToast, type Tone } from '../../components/ui';
import { Stat } from '../../components/charts';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { useBackLink, useUnsavedChanges } from '../../components/Navigation';
import { NumberInput } from '../../components/NumberInput';
import { SupplierPicker, type SupplierRef } from '../../components/SupplierPicker';
import { Attachments } from '../../components/Attachments';

/**
 * Requests for Quotation (2026-10-14, the owner's call: "Purchase Request,
 * RFQ, Canvass, Purchase Order — the flow from PR to RFQ, a standard form and
 * list"). Raised from an APPROVED purchase request; printed one paper per
 * supplier and sent by hand (printed only — the owner's call); the quotes
 * that come back are recorded here, each with the supplier's own paper as an
 * attachment, and the canvass compares them. No approval route: an enquiry
 * decides nothing. The API is `routes/rfq.ts`.
 */

export const RFQ_TONES: Record<string, Tone> = { SENT: 'info', QUOTED: 'warn', CLOSED: 'ok' };

const STATUS_OPTIONS = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SENT', label: 'Sent' },
  { value: 'QUOTED', label: 'Quoted' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const DEFAULT_TERMS =
  'Please quote your best price per unit, whether prices include VAT, your payment terms, how long the quote is valid and the delivery lead time.';

// ════════════════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════════════════

interface RfqRow {
  id: string;
  number: string;
  status: string;
  dueDate: string | null;
  createdAt: string;
  lineCount: number;
  supplierCount: number;
  quotedCount: number;
  request: { id: string; number: string; purpose: string; job: { id: string; number: string; name: string } | null; warehouse: { id: string; name: string } | null };
  preparedBy: { id: string; name: string };
  suppliers: { id: string; supplier: { name: string } }[];
}

interface RfqSummary {
  open?: number;
}

export function Rfqs() {
  const navigate = useNavigate();
  const { can } = useAuth();

  const columns: Column<RfqRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'request',
      label: 'For',
      render: (r) => (
        <div>
          <div>{r.request.purpose}</div>
          <div className="faint mono">
            {r.request.number}
            {r.request.job ? ` · ${r.request.job.number}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'suppliers',
      label: 'Suppliers asked',
      render: (r) =>
        r.suppliers.length ? r.suppliers.map((s) => s.supplier.name).join(', ') : <span className="faint">None yet</span>,
    },
    {
      key: 'quoted',
      label: 'Quoted',
      align: 'right',
      render: (r) => (r.supplierCount ? `${r.quotedCount} of ${r.supplierCount}` : <span className="faint">—</span>),
    },
    { key: 'lines', label: 'Lines', align: 'right', render: (r) => r.lineCount },
    { key: 'dueDate', label: 'Quote by', sortKey: 'dueDate', render: (r) => (r.dueDate ? formatDate(r.dueDate) : <span className="faint">—</span>) },
    { key: 'preparedBy', label: 'Prepared by', render: (r) => r.preparedBy.name },
    { key: 'createdAt', label: 'Prepared', sortKey: 'createdAt', render: (r) => formatDate(r.createdAt) },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} extra={RFQ_TONES} /> },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Requests for Quotation</h1>
        </div>
      </div>

      <DataList<RfqRow>
        listKey="rfqs"
        endpoint="/rfqs"
        printPath="/api/rfqs/pdf"
        reportPath="/g-chain/reports?kind=rfq"
        columns={columns}
        rowKey={(r) => r.id}
        searchPlaceholder="Search number, request, supplier…"
        onRowClick={(r) => navigate(`/g-chain/rfq/${r.id}`)}
        emptyTitle="No RFQs yet"
        emptyHint="Raise one from an approved purchase request."
        selectable
        filters={[
          { key: 'status', label: 'Status', options: STATUS_OPTIONS },
          { key: 'open', label: 'Open only', options: [{ value: 'true', label: 'Draft, sent or quoted' }] },
        ]}
        summary={(raw, total) => {
          const sum = raw as RfqSummary;
          return (
            <>
              <Stat label="RFQs" value={total} />
              <Stat label="Open" value={sum.open ?? 0} sub="draft, sent or quoted" />
            </>
          );
        }}
        actions={
          can('gchain.rfq.create') ? (
            <button className="btn btn-primary" onClick={() => navigate('/g-chain/rfq/new')}>
              + New RFQ
            </button>
          ) : null
        }
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  SHARED SHAPES
// ════════════════════════════════════════════════════════════════════

interface RfqLine {
  id: string;
  partNumber: string | null;
  name: string | null;
  description: string;
  unit: string;
  quantity: number;
  estimatedCost: number;
  estimatedAmount: number;
  costCategory: { id: string; name: string } | null;
  /** On the source only: the open RFQs that already ask about it. */
  askedOn?: string[];
}

interface RfqSupplierRow {
  id: string;
  supplierId: string;
  contactName: string | null;
  contactPhone: string | null;
  email: string | null;
  sentAt: string | null;
  quoteRef: string | null;
  quoteReceivedAt: string | null;
  leadTimeDays: number | null;
  terms: string | null;
  validUntil: string | null;
  remarks: string | null;
  supplier: { id: string; code: string; name: string; address: string | null; city: string | null; phone: string | null; email: string | null; paymentTerms: string | null };
  quotes: { id: string; requestItemId: string; unitPrice: number; remarks: string | null }[];
  quotedCount: number;
  total: number;
  complete: boolean;
}

interface RfqDetailData {
  id: string;
  number: string;
  status: string;
  dueDate: string | null;
  deliverTo: string | null;
  terms: string | null;
  notes: string | null;
  sentAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  version: string;
  request: {
    id: string;
    number: string;
    purpose: string;
    status: string;
    kind: string;
    neededBy: string | null;
    preferredSupplier: string | null;
    job: { id: string; number: string; name: string } | null;
    warehouse: { id: string; name: string } | null;
  };
  preparedBy: { id: string; name: string };
  lines: RfqLine[];
  suppliers: RfqSupplierRow[];
  canvasses: { id: string; number: string; status: string }[];
  estimatedTotal: number;
  canEdit: boolean;
  canEditLines: boolean;
  canSend: boolean;
  canRecordQuotes: boolean;
  canCancel: boolean;
  canDelete: boolean;
  /** The sheet comparing it, while one is open or awarded. */
  liveCanvass: { id: string; number: string; status: string } | null;
  canStartCanvass: boolean;
}

interface Source {
  request: {
    id: string;
    number: string;
    purpose: string;
    kind: string;
    neededBy: string | null;
    preferredSupplier: string | null;
    job: { id: string; number: string; name: string } | null;
    warehouse: { id: string; name: string } | null;
    requestedBy: { id: string; name: string };
  };
  deliverTo: string;
  lines: RfqLine[];
}

const lineTitle = (l: RfqLine) => l.name || l.description;
const lineBody = (l: RfqLine) => (l.name && l.description && l.description !== l.name ? l.description : null);

// ════════════════════════════════════════════════════════════════════
//  FORM (a page: New and Modify)
// ════════════════════════════════════════════════════════════════════

interface Header {
  dueDate: string;
  deliverTo: string;
  terms: string;
  notes: string;
}

interface SupRow {
  key: string;
  id: string | null;
  supplier: SupplierRef | null;
  contactName: string;
  contactPhone: string;
  email: string;
  quoted: boolean;
}

let keySeq = 0;
const newKey = () => `r${++keySeq}`;
const blankRow = (): SupRow => ({ key: newKey(), id: null, supplier: null, contactName: '', contactPhone: '', email: '', quoted: false });

const snapshot = (h: Header, picked: Set<string>, rows: SupRow[]) =>
  JSON.stringify([h, [...picked].sort(), rows.filter((r) => r.supplier).map((r) => [r.id, r.supplier?.id, r.contactName, r.contactPhone, r.email])]);

/**
 * The RFQ as a PAGE: `/g-chain/rfq/new?fromRequest=` (the request page's
 * "Request quotations"; without it, a request is picked first) and
 * `/g-chain/rfq/:id/edit`. The header, the lines asked (while a draft) and
 * the suppliers asked are one save.
 */
export function RfqEditor() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const fromRequest = params.get('fromRequest');
  const navigate = useNavigate();
  const toast = useToast();
  const editing = !!id;

  const [existing, setExisting] = useState<RfqDetailData | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [lines, setLines] = useState<RfqLine[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [header, setHeader] = useState<Header>({ dueDate: '', deliverTo: '', terms: '', notes: '' });
  const [rows, setRows] = useState<SupRow[]>([blankRow()]);
  const [saved, setSaved] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    (async () => {
      try {
        if (editing) {
          const rfq = await api.get<RfqDetailData>(`/rfqs/${id}`);
          let all: RfqLine[] = rfq.lines;
          if (rfq.status === 'DRAFT') {
            // While a draft its lines may change: offer every line of its request.
            const src = await api.get<Source>(`/rfqs/source${qs({ requestId: rfq.request.id })}`).catch(() => null);
            if (src) all = src.lines.map((l) => ({ ...l, askedOn: (l.askedOn ?? []).filter((n) => n !== rfq.number) }));
          }
          const h: Header = {
            dueDate: rfq.dueDate ? rfq.dueDate.slice(0, 10) : '',
            deliverTo: rfq.deliverTo ?? '',
            terms: rfq.terms ?? '',
            notes: rfq.notes ?? '',
          };
          const p = new Set(rfq.lines.map((l) => l.id));
          const r: SupRow[] = rfq.suppliers.map((s) => ({
            key: newKey(),
            id: s.id,
            supplier: { id: s.supplier.id, name: s.supplier.name, code: s.supplier.code },
            contactName: s.contactName ?? '',
            contactPhone: s.contactPhone ?? '',
            email: s.email ?? '',
            quoted: s.quotedCount > 0,
          }));
          if (!live) return;
          setExisting(rfq);
          setLines(all);
          setPicked(p);
          setHeader(h);
          setRows(r.length ? r : [blankRow()]);
          setSaved(snapshot(h, p, r));
        } else if (fromRequest) {
          const src = await api.get<Source>(`/rfqs/source${qs({ requestId: fromRequest })}`);
          // Lines already asked on another open RFQ start unticked — a second
          // RFQ on one request is a deliberate split, never an accident.
          const fresh = src.lines.filter((l) => !l.askedOn?.length);
          const p = new Set((fresh.length ? fresh : src.lines).map((l) => l.id));
          const h: Header = { dueDate: '', deliverTo: src.deliverTo, terms: '', notes: '' };
          if (!live) return;
          setSource(src);
          setLines(src.lines);
          setPicked(p);
          setHeader(h);
          setRows([blankRow()]);
          setSaved(snapshot(h, p, []));
        }
        if (live) setError(null);
      } catch (err) {
        if (live) setError(err);
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [editing, id, fromRequest]);

  const request = existing?.request ?? source?.request ?? null;
  const dirty = saved !== null && snapshot(header, picked, rows) !== saved;
  useUnsavedChanges(dirty && !busy);
  useBackLink(
    existing ? `/g-chain/rfq/${existing.id}` : request ? `/g-chain/purchase-requests/${request.id}` : null,
    existing ? existing.number : request ? request.number : null,
  );

  const linesFixed = !!existing && existing.status !== 'DRAFT';
  const chosen = rows.filter((r) => r.supplier);
  const problems: string[] = [];
  if (!picked.size) problems.push('Tick at least one line to ask about');
  const ids = chosen.map((r) => r.supplier!.id);
  if (new Set(ids).size !== ids.length) problems.push('A supplier is named twice');

  function setRow(key: string, patch: Partial<SupRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function pickSupplier(key: string, sup: SupplierRef | null) {
    setRow(key, { supplier: sup });
    if (!sup) return;
    try {
      const c = await api.get<{ phone: string | null; email: string | null; contacts: { name: string; phone: string | null; email: string | null }[] }>(
        `/rfqs/contacts${qs({ supplierId: sup.id })}`,
      );
      const first = c.contacts[0];
      setRows((rs) =>
        rs.map((r) =>
          r.key === key
            ? {
                ...r,
                contactName: r.contactName || first?.name || '',
                contactPhone: r.contactPhone || first?.phone || c.phone || '',
                email: r.email || first?.email || c.email || '',
              }
            : r,
        ),
      );
    } catch {
      // The contact is a convenience; the row is filled by hand without it.
    }
  }

  function body() {
    return {
      dueDate: header.dueDate || null,
      deliverTo: header.deliverTo.trim() || null,
      terms: header.terms.trim() || null,
      notes: header.notes.trim() || null,
      itemIds: linesFixed ? undefined : [...picked],
      suppliers: chosen.map((r) => ({
        ...(r.id ? { id: r.id } : {}),
        supplierId: r.supplier!.id,
        contactName: r.contactName.trim() || null,
        contactPhone: r.contactPhone.trim() || null,
        email: r.email.trim() || null,
      })),
      ...(existing ? { version: existing.version } : { requestId: request?.id }),
    };
  }

  async function save() {
    setAttempted(true);
    if (problems.length) return;
    setBusy(true);
    setError(null);
    try {
      const savedId = existing
        ? (await api.put<{ id: string }>(`/rfqs/${existing.id}/sheet`, body())).id
        : (await api.post<{ id: string; number: string }>('/rfqs', body())).id;
      setSaved(snapshot(header, picked, rows));
      toast('ok', existing ? `${existing.number} saved` : 'RFQ saved');
      navigate(`/g-chain/rfq/${savedId}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (!editing && !fromRequest) {
    return <PickRequest onPick={(rid) => setParams({ fromRequest: rid }, { replace: true })} />;
  }
  if (!loaded) return error ? <ErrorBox error={error} /> : <Loading />;
  if (!request) return <ErrorBox error={error ?? new Error('Could not start the RFQ')} />;
  if (existing && !existing.canEdit) {
    return (
      <div className="card">
        <p className="muted">
          {['CLOSED', 'CANCELLED'].includes(existing.status)
            ? `${existing.number} is ${existing.status.toLowerCase()} and stands as it was.`
            : 'Only the person who prepared this RFQ, or someone who may edit every RFQ, can change it.'}
        </p>
      </div>
    );
  }

  const estimate = lines.filter((l) => picked.has(l.id)).reduce((s, l) => s + l.estimatedAmount, 0);
  const allTicked = lines.length > 0 && lines.every((l) => picked.has(l.id));
  const action = (
    <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
      {busy ? 'Saving…' : 'Save'}
    </button>
  );

  return (
    <div className="prq">
      <section className="card qe-card prq-head-card" aria-labelledby="rfq-heading">
        <div className="qe-head">
          <div>
            <h1 id="rfq-heading" className="qe-heading">
              {existing ? `Modify RFQ ${existing.number}` : 'New request for quotation'}
            </h1>
            <p className="muted qe-lead">
              From <Link to={`/g-chain/purchase-requests/${request.id}`}>{request.number}</Link> — {request.purpose}.{' '}
              {existing && existing.status !== 'DRAFT'
                ? 'It was sent: its lines are what the suppliers were asked. A supplier added now is asked today.'
                : 'Tick the lines to ask about and name the suppliers; each supplier gets a paper of their own to print.'}
            </p>
          </div>
          <div className="row qe-actions">{action}</div>
        </div>
        <ErrorBox error={error} />
        {attempted && problems.length > 0 && (
          <div className="alert error" role="alert">
            Not saved yet — {problems.join('; ')}.
          </div>
        )}
      </section>

      <div className="prq-grid prq-grid-solo">
        <div className="prq-main">
          <section className="card" aria-labelledby="rfq-details">
            <h2 id="rfq-details" className="card-title">RFQ details</h2>
            <div className="qe-header qe-rows prq-rows">
              <Field label="Number">
                <div className="qe-static">{existing ? <span className="mono">{existing.number}</span> : <span className="muted">Given on save</span>}</div>
              </Field>
              <Field label="Purchase request">
                <div className="qe-static">
                  <Link to={`/g-chain/purchase-requests/${request.id}`}>{request.number}</Link>
                </div>
              </Field>
              <Field label="For">
                <div className="qe-static">
                  {request.job ? (
                    <Link to={`/g-ops/projects/${request.job.id}`}>
                      {request.job.number} — {request.job.name}
                    </Link>
                  ) : request.warehouse ? (
                    `Stock for ${request.warehouse.name}`
                  ) : (
                    '—'
                  )}
                </div>
              </Field>
              <Field label="Quote by" hint={request.neededBy ? `Needed by ${formatDate(request.neededBy)}` : 'The date the suppliers answer by'}>
                <input type="date" value={header.dueDate} onChange={(e) => setHeader((h) => ({ ...h, dueDate: e.target.value }))} />
              </Field>
              <Field label="Deliver to">
                <input value={header.deliverTo} maxLength={500} onChange={(e) => setHeader((h) => ({ ...h, deliverTo: e.target.value }))} />
              </Field>
            </div>
            <div className="qe-rows">
              <Field label="Terms of the quotation" hint="Printed on every supplier's paper; blank prints the standard wording">
                <textarea rows={3} value={header.terms} placeholder={DEFAULT_TERMS} onChange={(e) => setHeader((h) => ({ ...h, terms: e.target.value }))} />
              </Field>
              <Field label="Notes" hint="Internal — printed on the RFQ's own paper, never on a supplier's">
                <textarea rows={2} value={header.notes} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} />
              </Field>
            </div>
          </section>

          <section className="card" aria-labelledby="rfq-lines">
            <div className="card-head">
              <h2 id="rfq-lines" className="card-title">Lines asked</h2>
              <span className="muted prq-source">
                {picked.size} of {lines.length} · estimated {formatMoney(estimate)}
              </span>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="rfq-tick">
                      <input
                        type="checkbox"
                        aria-label="Ask about every line"
                        checked={allTicked}
                        disabled={linesFixed}
                        onChange={(e) => setPicked(e.target.checked ? new Set(lines.map((l) => l.id)) : new Set())}
                      />
                    </th>
                    <th>Part No.</th>
                    <th>Item and description</th>
                    <th>Unit</th>
                    <th className="right">Qty</th>
                    <th className="right">Est. unit cost</th>
                    <th>Budget line</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td className="rfq-tick">
                        <input
                          type="checkbox"
                          aria-label={`Ask about ${lineTitle(l)}`}
                          checked={picked.has(l.id)}
                          disabled={linesFixed}
                          onChange={(e) =>
                            setPicked((p) => {
                              const next = new Set(p);
                              if (e.target.checked) next.add(l.id);
                              else next.delete(l.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="mono">{l.partNumber ?? ''}</td>
                      <td>
                        <strong>{lineTitle(l)}</strong>
                        {lineBody(l) && <div className="faint">{lineBody(l)}</div>}
                        {l.askedOn && l.askedOn.length > 0 && <div className="faint">Also asked on {l.askedOn.join(', ')}</div>}
                      </td>
                      <td>{l.unit}</td>
                      <td className="right mono">{l.quantity}</td>
                      <td className="right mono">{formatMoney(l.estimatedCost)}</td>
                      <td>{l.costCategory?.name ?? <span className="faint">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card" aria-labelledby="rfq-suppliers">
            <div className="card-head">
              <h2 id="rfq-suppliers" className="card-title">Suppliers asked</h2>
              <button type="button" className="btn btn-sm" onClick={() => setRows((rs) => [...rs, blankRow()])}>
                + Add supplier
              </button>
            </div>
            {request.preferredSupplier && (
              <p className="prq-hint">The requester would like {request.preferredSupplier} asked.</p>
            )}
            <div className="table-wrap">
              <table className="data rfq-sup">
                <thead>
                  <tr>
                    <th>Supplier</th>
                    <th>Attention</th>
                    <th>Tel No.</th>
                    <th>Email</th>
                    <th aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td>
                        <SupplierPicker
                          value={r.supplier}
                          onChange={(sup) => void pickSupplier(r.key, sup)}
                          onError={setError}
                          disabled={!!r.id}
                          exclude={rows.filter((o) => o.key !== r.key && o.supplier).map((o) => o.supplier!.id)}
                        />
                      </td>
                      <td>
                        <input aria-label="Attention" value={r.contactName} maxLength={200} onChange={(e) => setRow(r.key, { contactName: e.target.value })} />
                      </td>
                      <td>
                        <input aria-label="Tel No." value={r.contactPhone} maxLength={60} onChange={(e) => setRow(r.key, { contactPhone: e.target.value })} />
                      </td>
                      <td>
                        <input aria-label="Email" value={r.email} maxLength={200} onChange={(e) => setRow(r.key, { email: e.target.value })} />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={r.quoted}
                          title={r.quoted ? 'This supplier quoted — they stay on the RFQ' : undefined}
                          aria-label={`Remove ${r.supplier?.name ?? 'this row'}`}
                          onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((o) => o.key !== r.key) : [blankRow()]))}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="prq-hint">
              Three quotes is the usual standard for a defensible award. A supplier picked fills its primary contact; change it
              for this RFQ if someone else should receive it.
            </p>
          </section>

          <div className="row qe-foot">{action}</div>
        </div>
      </div>
    </div>
  );
}

/** A new RFQ without a request named: pick one of the approved requests first. */
function PickRequest({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<
    { id: string; number: string; purpose: string; lineCount: number; openRfqs: number; job: { number: string; name: string } | null; warehouse: { name: string } | null }[] | null
  >(null);
  const [error, setError] = useState<unknown>(null);
  useBackLink('/g-chain/rfq', 'Requests for Quotation');

  useEffect(() => {
    const t = window.setTimeout(() => {
      api
        .get<typeof rows>(`/rfqs/requests${qs({ q })}`)
        .then((r) => {
          setRows(r);
          setError(null);
        })
        .catch(setError);
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  return (
    <div className="prq">
      <section className="card qe-card prq-head-card">
        <div className="qe-head">
          <div>
            <h1 className="qe-heading">New request for quotation</h1>
            <p className="muted qe-lead">An RFQ asks suppliers to price an approved purchase request. Which request is it for?</p>
          </div>
        </div>
      </section>
      <section className="card" aria-labelledby="rfq-pick">
        <h2 id="rfq-pick" className="card-title">Approved purchase requests</h2>
        <div className="qe-rows">
          <Field label="Search">
            <input autoFocus value={q} placeholder="Number, purpose or project" onChange={(e) => setQ(e.target.value)} />
          </Field>
        </div>
        <ErrorBox error={error} />
        {rows === null ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty title="No approved request matches" hint="A purchase request is sent for quotation once it is approved." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Purpose</th>
                  <th>For</th>
                  <th className="right">Lines</th>
                  <th>Open RFQs</th>
                  <th aria-label="Choose" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.number}</td>
                    <td>{r.purpose}</td>
                    <td>{r.job ? `${r.job.number} — ${r.job.name}` : r.warehouse ? `Stock for ${r.warehouse.name}` : '—'}</td>
                    <td className="right">{r.lineCount}</td>
                    <td>{r.openRfqs ? r.openRfqs : <span className="faint">None</span>}</td>
                    <td className="right">
                      <button type="button" className="btn btn-sm" onClick={() => onPick(r.id)}>
                        Choose
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  RECORD PAGE
// ════════════════════════════════════════════════════════════════════

export function RfqDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [rfq, setRfq] = useState<RfqDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [quoting, setQuoting] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [params, setParams] = useSearchParams();
  // "+ New canvass" on the Canvass list sends an RFQ with more than six
  // quotes here with ?canvass=1, to choose the six (2026-10-16).
  useEffect(() => {
    if (params.get('canvass') !== '1') return;
    setChoosing(true);
    const next = new URLSearchParams(params);
    next.delete('canvass');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRfq(await api.get<RfqDetailData>(`/rfqs/${id}`));
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
  if (!rfq) return <ErrorBox error={error ?? new Error('RFQ not found')} />;

  async function markSent() {
    if (!rfq) return;
    setRfq(await api.post<RfqDetailData>(`/rfqs/${rfq.id}/send`));
    toast('ok', `${rfq.number} marked sent`);
  }
  async function cancel(reason: string) {
    if (!rfq) return;
    await api.post(`/rfqs/${rfq.id}/cancel`, { reason });
    toast('ok', `${rfq.number} cancelled`);
    await load();
  }
  async function remove() {
    if (!rfq) return;
    await api.del(`/rfqs/${rfq.id}`);
    toast('ok', `${rfq.number} deleted`);
    navigate('/g-chain/rfq');
  }
  /** Opens the comparison sheet from this RFQ's quotes — the suppliers that quoted, or the six chosen. */
  async function startCanvass(supplierRowIds?: string[]) {
    if (!rfq) return;
    const created = await api.post<{ id: string }>('/canvasses', { rfqId: rfq.id, ...(supplierRowIds ? { supplierRowIds } : {}) });
    navigate(`/g-chain/canvass/${created.id}`);
  }

  const forLabel = rfq.request.job ? (
    <Link to={`/g-ops/projects/${rfq.request.job.id}`}>
      {rfq.request.job.number} — {rfq.request.job.name}
    </Link>
  ) : rfq.request.warehouse ? (
    `Stock for ${rfq.request.warehouse.name}`
  ) : (
    '—'
  );
  const quoted = rfq.suppliers.filter((s) => s.quotedCount > 0);
  const row = quoting ? rfq.suppliers.find((s) => s.id === quoting) ?? null : null;
  const startButton = rfq.canStartCanvass && (
    <button
      className="btn btn-primary"
      onClick={() =>
        quoted.length > 6
          ? setChoosing(true)
          : confirm.ask({
              title: `Start a canvass sheet from ${rfq.number}?`,
              body: `It compares the ${quoted.length} supplier${quoted.length === 1 ? '' : 's'} that quoted against the request's estimate, line by line. The sheet keeps the quotes as they stand now.`,
              confirmLabel: 'Start canvass',
              tone: 'primary',
              onConfirm: () => startCanvass(),
            })
      }
    >
      Start canvass
    </button>
  );

  return (
    <div>
      <RecordHeader
        type="Request for Quotation"
        code={rfq.number}
        title={rfq.request.purpose}
        status={rfq.status}
        statusExtra={RFQ_TONES}
        amount={formatMoney(rfq.estimatedTotal)}
        amountLabel="Estimated (the request)"
        meta={
          <>
            For <Link to={`/g-chain/purchase-requests/${rfq.request.id}`}>{rfq.request.number}</Link>
            {rfq.request.job && <> · {forLabel}</>} · prepared by {rfq.preparedBy.name} on {formatDate(rfq.createdAt)}
            {rfq.dueDate ? ` · quote by ${formatDate(rfq.dueDate)}` : ''}
            {rfq.liveCanvass && (
              <>
                {' '}
                · compared on <Link to={`/g-chain/canvass/${rfq.liveCanvass.id}`}>{rfq.liveCanvass.number}</Link>
              </>
            )}
          </>
        }
        actions={
          startButton ||
          (rfq.canSend && (
            <button
              className="btn btn-primary"
              onClick={() =>
                confirm.ask({
                  title: `Mark ${rfq.number} sent?`,
                  body: 'Print each supplier’s paper (Print beside each supplier) and send it. Marking it sent dates it; its lines are then what the suppliers were asked.',
                  confirmLabel: 'Mark sent',
                  tone: 'primary',
                  onConfirm: markSent,
                })
              }
            >
              Mark sent
            </button>
          ))
        }
        print={`/api/rfqs/${rfq.id}/pdf`}
        more={[
          rfq.canCancel && {
            label: 'Cancel RFQ',
            danger: true,
            confirm: {
              title: `Cancel ${rfq.number}?`,
              body: 'The quotes stay on it as a record. The request can be sent for quotation again.',
              confirmLabel: 'Cancel RFQ',
              reason: 'required',
              minReason: 3,
              reasonLabel: 'Why is it cancelled?',
              onConfirm: cancel,
            },
          },
          rfq.canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${rfq.number}?`,
              body: `This ${rfq.status === 'DRAFT' ? 'draft' : 'cancelled'} RFQ goes for good, with its suppliers' files. Its number is not reused.`,
              confirmLabel: 'Delete',
              onConfirm: remove,
            },
          },
        ]}
        modify={rfq.canEdit ? `/g-chain/rfq/${rfq.id}/edit` : undefined}
        confirm={confirm}
      />

      <ErrorBox error={error} />

      <div className="grid grid-2">
        <section className="card" aria-labelledby="rfq-request">
          <h3 id="rfq-request" className="card-title">The request</h3>
          <dl className="kv">
            <dt>Purchase request</dt>
            <dd>
              <Link to={`/g-chain/purchase-requests/${rfq.request.id}`}>{rfq.request.number}</Link>
            </dd>
            <dt>For</dt>
            <dd>{forLabel}</dd>
            <dt>Quote by</dt>
            <dd>{rfq.dueDate ? formatDate(rfq.dueDate) : '—'}</dd>
            <dt>Deliver to</dt>
            <dd>{rfq.deliverTo ?? '—'}</dd>
            <dt>Prepared by</dt>
            <dd>
              {rfq.preparedBy.name} · {formatDate(rfq.createdAt)}
            </dd>
            <dt>Sent</dt>
            <dd>{rfq.sentAt ? formatDate(rfq.sentAt) : 'Not yet'}</dd>
            {rfq.cancelReason && (
              <>
                <dt>Cancelled because</dt>
                <dd>{rfq.cancelReason}</dd>
              </>
            )}
            {rfq.canvasses.length > 0 && (
              <>
                <dt>Canvass</dt>
                <dd>
                  {rfq.canvasses.map((c, i) => (
                    <span key={c.id}>
                      {i > 0 && ', '}
                      <Link to={`/g-chain/canvass/${c.id}`}>{c.number}</Link>
                    </span>
                  ))}
                </dd>
              </>
            )}
          </dl>
        </section>
        <section className="card" aria-labelledby="rfq-terms">
          <h3 id="rfq-terms" className="card-title">Terms of the quotation</h3>
          <p className="activity-notes">{rfq.terms ?? DEFAULT_TERMS}</p>
          {rfq.notes && (
            <>
              <h3 className="card-title">Notes</h3>
              <p className="activity-notes">{rfq.notes}</p>
            </>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="rfq-sups">
        <div className="card-head">
          <h3 id="rfq-sups" className="card-title">Suppliers asked</h3>
          <span className="faint">
            {quoted.length} of {rfq.suppliers.length} quoted
          </span>
        </div>
        {rfq.suppliers.length === 0 ? (
          <Empty title="No suppliers yet" hint="Modify the RFQ to name the suppliers to ask." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Attention</th>
                  <th>Sent</th>
                  <th>Quote</th>
                  <th className="right">Total</th>
                  <th>Lead time</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rfq.suppliers.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/g-chain/suppliers/${s.supplier.id}`}>{s.supplier.name}</Link>
                    </td>
                    <td>
                      <div>{s.contactName ?? <span className="faint">—</span>}</div>
                      <div className="faint">{[s.contactPhone ?? s.supplier.phone, s.email ?? s.supplier.email].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td>{s.sentAt ? formatDate(s.sentAt) : <span className="faint">Not sent</span>}</td>
                    <td>
                      {s.quotedCount ? (
                        <>
                          <div>
                            {s.quotedCount} of {rfq.lines.length} line{rfq.lines.length === 1 ? '' : 's'}
                            {s.quoteRef ? ` · ${s.quoteRef}` : ''}
                          </div>
                          <div className="faint">
                            {s.quoteReceivedAt ? `received ${formatDate(s.quoteReceivedAt)}` : ''}
                            {s.validUntil ? ` · valid until ${formatDate(s.validUntil)}` : ''}
                          </div>
                        </>
                      ) : (
                        <span className="faint">No quote yet</span>
                      )}
                    </td>
                    <td className="right mono">{s.quotedCount ? formatMoney(s.total) : ''}</td>
                    <td>{s.leadTimeDays != null ? `${s.leadTimeDays} day${s.leadTimeDays === 1 ? '' : 's'}` : ''}</td>
                    <td className="right">
                      <div className="proc-row-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          aria-label={`Print the RFQ for ${s.supplier.name}`}
                          onClick={() => openPdf(`/api/rfqs/${rfq.id}/pdf${qs({ supplier: s.id })}`, (m) => toast('error', m))}
                        >
                          Print
                        </button>
                        {rfq.canRecordQuotes && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            aria-label={`Record ${s.supplier.name}'s quote`}
                            onClick={() => setQuoting(s.id)}
                          >
                            {s.quotedCount ? 'Modify quote' : 'Record quote'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rfq.status === 'DRAFT' && rfq.suppliers.length > 0 && (
          <p className="prq-hint">Print each supplier’s paper, send it, then Mark sent. Their quotes are recorded here once it is sent.</p>
        )}
      </section>

      {choosing && (
        <ChooseSuppliers
          rfq={rfq}
          onClose={() => setChoosing(false)}
          onStart={(ids) => startCanvass(ids)}
        />
      )}

      {row && (
        <QuotePanel
          rfq={rfq}
          row={row}
          onClose={() => setQuoting(null)}
          onSaved={(next) => {
            setRfq(next);
            setQuoting(null);
            toast('ok', `${row.supplier.name}'s quote recorded`);
          }}
        />
      )}

      <section className="card" aria-labelledby="rfq-lines-card">
        <h3 id="rfq-lines-card" className="card-title">
          {quoted.length ? 'Quotes received' : 'Lines asked'}
        </h3>
        <QuoteTable rfq={rfq} suppliers={quoted} />
      </section>
    </div>
  );
}

/** The lines asked, and — once quotes came in — each quoting supplier's price, the lowest marked. */
function QuoteTable({ rfq, suppliers }: { rfq: RfqDetailData; suppliers: RfqSupplierRow[] }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>#</th>
            <th>Part No.</th>
            <th>Item and description</th>
            <th className="right">Qty</th>
            <th className="right">Estimate</th>
            {suppliers.map((s) => (
              <th key={s.id} className="right">
                {s.supplier.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rfq.lines.map((l, n) => {
            const prices = suppliers.map((s) => s.quotes.find((qq) => qq.requestItemId === l.id)?.unitPrice);
            const valid = prices.filter((p): p is number => p !== undefined && p > 0);
            const best = valid.length > 1 ? Math.min(...valid) : null;
            return (
              <tr key={l.id}>
                <td className="mono">{n + 1}</td>
                <td className="mono">{l.partNumber ?? ''}</td>
                <td>
                  <strong>{lineTitle(l)}</strong>
                  {lineBody(l) && <div className="faint">{lineBody(l)}</div>}
                </td>
                <td className="right mono">
                  {l.quantity} {l.unit}
                </td>
                <td className="right mono faint">{formatMoney(l.estimatedCost)}</td>
                {suppliers.map((s, i) => (
                  <td key={s.id} className={`right mono${prices[i] !== undefined && prices[i] === best ? ' proc-best' : ''}`}>
                    {prices[i] === undefined ? <span className="faint">—</span> : formatMoney(prices[i]!)}
                  </td>
                ))}
              </tr>
            );
          })}
          <tr>
            <td colSpan={4} className="right">
              <strong>Total</strong>
            </td>
            <td className="right mono faint">{formatMoney(rfq.estimatedTotal)}</td>
            {suppliers.map((s) => (
              <td key={s.id} className="right mono">
                <strong>{s.complete ? formatMoney(s.total) : <span className="faint">{formatMoney(s.total)} · part</span>}</strong>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * A supplier's quote as it came in, recorded in the page under the
 * suppliers (never a dialog): a price per line asked — a line left blank is
 * "not quoted" — and the terms that came with it, with the supplier's own
 * paper attached to the row.
 */
function QuotePanel({
  rfq,
  row,
  onClose,
  onSaved,
}: {
  rfq: RfqDetailData;
  row: RfqSupplierRow;
  onClose: () => void;
  onSaved: (next: RfqDetailData) => void;
}) {
  const start = useMemo(() => {
    const prices: Record<string, string> = {};
    const remarks: Record<string, string> = {};
    for (const qq of row.quotes) {
      prices[qq.requestItemId] = String(qq.unitPrice);
      remarks[qq.requestItemId] = qq.remarks ?? '';
    }
    return {
      prices,
      remarks,
      quoteRef: row.quoteRef ?? '',
      quoteReceivedAt: row.quoteReceivedAt ? row.quoteReceivedAt.slice(0, 10) : '',
      leadTimeDays: row.leadTimeDays != null ? String(row.leadTimeDays) : '',
      terms: row.terms ?? row.supplier.paymentTerms ?? '',
      validUntil: row.validUntil ? row.validUntil.slice(0, 10) : '',
      remarksAll: row.remarks ?? '',
    };
  }, [row]);
  const [form, setForm] = useState(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useUnsavedChanges(JSON.stringify(form) !== JSON.stringify(start) && !busy);

  const total = rfq.lines.reduce((s, l) => {
    const p = Number(form.prices[l.id]);
    return form.prices[l.id] !== undefined && form.prices[l.id] !== '' && Number.isFinite(p) ? s + Math.round(l.quantity * p * 100) / 100 : s;
  }, 0);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<RfqDetailData>(`/rfqs/${rfq.id}/suppliers/${row.id}/quote`, {
        quotes: rfq.lines
          .filter((l) => form.prices[l.id] !== undefined && form.prices[l.id] !== '')
          .map((l) => ({ requestItemId: l.id, unitPrice: Number(form.prices[l.id]), remarks: form.remarks[l.id]?.trim() || null })),
        quoteRef: form.quoteRef.trim() || null,
        quoteReceivedAt: form.quoteReceivedAt || null,
        leadTimeDays: form.leadTimeDays === '' ? null : Number(form.leadTimeDays),
        terms: form.terms.trim() || null,
        validUntil: form.validUntil || null,
        remarks: form.remarksAll.trim() || null,
      });
      onSaved(next);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <>
    <section className="card rfq-quote" aria-labelledby="rfq-quote-head">
      <div className="card-head">
        <h3 id="rfq-quote-head" className="card-title">
          {row.supplier.name}’s quote
        </h3>
        <span className="faint">Total {formatMoney(total)}</span>
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Item and description</th>
              <th className="right">Qty</th>
              <th className="right">Estimate</th>
              <th className="right">Unit price</th>
              <th>Remarks</th>
            </tr>
          </thead>
          <tbody>
            {rfq.lines.map((l) => (
              <tr key={l.id}>
                <td>
                  <strong>{lineTitle(l)}</strong>
                  {lineBody(l) && <div className="faint">{lineBody(l)}</div>}
                </td>
                <td className="right mono">
                  {l.quantity} {l.unit}
                </td>
                <td className="right mono faint">{formatMoney(l.estimatedCost)}</td>
                <td className="right">
                  <NumberInput
                    kind="money"
                    aria-label={`Unit price for ${lineTitle(l)}`}
                    value={form.prices[l.id] ?? ''}
                    placeholder="Not quoted"
                    min={0}
                    onChange={(e) => setForm((f) => ({ ...f, prices: { ...f.prices, [l.id]: e.target.value } }))}
                  />
                </td>
                <td>
                  <input
                    aria-label={`Remarks for ${lineTitle(l)}`}
                    value={form.remarks[l.id] ?? ''}
                    maxLength={500}
                    placeholder="e.g. brand offered"
                    onChange={(e) => setForm((f) => ({ ...f, remarks: { ...f.remarks, [l.id]: e.target.value } }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="qe-header qe-rows prq-rows rfq-quote-terms">
        <Field label="Their quotation no.">
          <input value={form.quoteRef} maxLength={100} onChange={(e) => setForm((f) => ({ ...f, quoteRef: e.target.value }))} />
        </Field>
        <Field label="Received on" hint="Today when left blank">
          <input type="date" value={form.quoteReceivedAt} onChange={(e) => setForm((f) => ({ ...f, quoteReceivedAt: e.target.value }))} />
        </Field>
        <Field label="Lead time (days)">
          <NumberInput kind="count" value={form.leadTimeDays} min={0} onChange={(e) => setForm((f) => ({ ...f, leadTimeDays: e.target.value }))} />
        </Field>
        <Field label="Valid until">
          <input type="date" value={form.validUntil} onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))} />
        </Field>
        <Field label="Payment terms">
          <input value={form.terms} maxLength={1000} onChange={(e) => setForm((f) => ({ ...f, terms: e.target.value }))} />
        </Field>
        <Field label="Remarks">
          <input value={form.remarksAll} maxLength={2000} onChange={(e) => setForm((f) => ({ ...f, remarksAll: e.target.value }))} />
        </Field>
      </div>
      <div className="row card-foot">
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save quote'}
        </button>
      </div>
    </section>
    <Attachments
      entityType="rfq_supplier"
      entityId={row.id}
      title={`${row.supplier.name}’s quotation`}
      hint="The supplier's own paper — a PDF, a photo or a spreadsheet"
      canEdit={rfq.canRecordQuotes}
    />
    </>
  );
}

/** More than six suppliers quoted: the sheet takes six, chosen here, in the page. */
function ChooseSuppliers({ rfq, onClose, onStart }: { rfq: RfqDetailData; onClose: () => void; onStart: (ids: string[]) => Promise<void> }) {
  const quoted = rfq.suppliers.filter((s) => s.quotedCount > 0).sort((a, b) => Number(b.complete) - Number(a.complete) || a.total - b.total);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(quoted.slice(0, 6).map((s) => s.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <section className="card" aria-labelledby="rfq-choose">
      <div className="card-head">
        <h3 id="rfq-choose" className="card-title">
          Start canvass — choose six suppliers
        </h3>
        <span className="faint">{picked.size} of 6</span>
      </div>
      <ErrorBox error={error} />
      <p className="prq-hint">A sheet compares six suppliers at most. The lowest complete quotes are ticked to start with.</p>
      <div className="stack">
        {quoted.map((s) => (
          <label key={s.id} className="checkbox">
            <input
              type="checkbox"
              checked={picked.has(s.id)}
              disabled={!picked.has(s.id) && picked.size >= 6}
              onChange={(e) =>
                setPicked((p) => {
                  const next = new Set(p);
                  if (e.target.checked) next.add(s.id);
                  else next.delete(s.id);
                  return next;
                })
              }
            />
            <span>
              {s.supplier.name} — {formatMoney(s.total)}
              {s.complete ? '' : ` (${s.quotedCount} of ${rfq.lines.length} lines)`}
            </span>
          </label>
        ))}
      </div>
      <div className="row card-foot">
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || !picked.size}
          onClick={() => {
            setBusy(true);
            onStart([...picked]).catch((err) => {
              setError(err);
              setBusy(false);
            });
          }}
        >
          Start canvass
        </button>
      </div>
    </section>
  );
}

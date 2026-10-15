import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { Empty, ErrorBox, Field, Loading, StatusBadge, formatDate, useToast } from '../../components/ui';
import { Stat } from '../../components/charts';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { ApprovalStepper, DocumentApproval, DecisionNote, allHeld, previewSteps, type PreviewRoute } from '../../components/ApprovalStepper';
import { Attachments } from '../../components/Attachments';
import { NumberInput } from '../../components/NumberInput';
import { PersonSelect, usePeople } from '../../components/People';
import { useBackLink, useUnsavedChanges } from '../../components/Navigation';

/**
 * Pull-out slips — the INTERNAL release slip (2026-10-14, then the owner's
 * pull-out slip form of 2026-10-15: "internal, allowing the warehouse to
 * release the item; no customer involved"). Stock leaves a warehouse against
 * an issued sales order, an approved project request, or no source document
 * at all (a supplier return, testing, a repair — with the reason). The slip
 * says what it is for, who asked for it (their manager approves), the
 * references written on it, the authorized person or courier, where it goes
 * and when it is expected back, and each line's serial and condition.
 *
 * The list, the slip page (`/new?salesOrder=`, `?request=` or `?kind=other`;
 * `/:id/edit` on a draft) and the record page; the API is `routes/pullouts.ts`.
 */

export const PULLOUT_TONES = { PULLED_OUT: 'ok', PENDING_APPROVAL: 'warn' } as const;

type Kind = 'SALES_ORDER' | 'PURCHASE_REQUEST' | 'OTHER';

interface PulloutRow {
  id: string;
  number: string;
  kind: Kind;
  status: string;
  pulloutDate: string;
  receivedByName: string | null;
  purpose: string;
  purposeLabel: string;
  destination: string | null;
  salesOrder: { id: string; number: string; customer: { name: string } } | null;
  request: { id: string; number: string } | null;
  job: { id: string; number: string; name: string } | null;
  warehouse: { id: string; name: string };
  preparedBy: { id: string; name: string };
  requestedBy: { id: string; name: string };
  lineCount: number;
  quantity: number;
}

/** The purposes, as the API prints them — for the list's filter before anything loads. */
const PURPOSE_OPTIONS = [
  { value: 'SALES_ORDER', label: 'Sales order fulfilment' },
  { value: 'PROJECT_USE', label: 'Project / site use' },
  { value: 'SITE_INSTALLATION', label: 'Site installation' },
  { value: 'TESTING_AUDIT', label: 'Testing / audit' },
  { value: 'REPAIR_SERVICE', label: 'Repair / service' },
  { value: 'SUPPLIER_RETURN', label: 'Supplier return' },
  { value: 'OTHER', label: 'Other' },
];

export function PulloutSlips() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const columns: Column<PulloutRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'against',
      label: 'Against',
      render: (r) =>
        r.salesOrder ? (
          <div>
            <div className="mono">{r.salesOrder.number}</div>
            <div className="faint">Sales order</div>
          </div>
        ) : r.request ? (
          <div>
            <div className="mono">{r.request.number}</div>
            <div className="faint">Purchase request</div>
          </div>
        ) : (
          <span className="faint">No source document</span>
        ),
    },
    { key: 'purpose', label: 'Purpose', render: (r) => r.purposeLabel },
    {
      key: 'destination',
      label: 'Destination',
      render: (r) => r.destination ?? (r.job ? `${r.job.number} — ${r.job.name}` : <span className="faint">—</span>),
    },
    { key: 'warehouse', label: 'From', render: (r) => r.warehouse.name },
    { key: 'pulloutDate', label: 'Date', sortKey: 'pulloutDate', render: (r) => formatDate(r.pulloutDate) },
    { key: 'lines', label: 'Lines', align: 'right', render: (r) => r.lineCount },
    { key: 'requestedBy', label: 'Requested by', render: (r) => r.requestedBy.name },
    { key: 'receivedBy', label: 'Courier / received by', render: (r) => r.receivedByName ?? <span className="faint">—</span>, optional: true },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} extra={PULLOUT_TONES} /> },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Pull-out Slips</h1>
        </div>
      </div>
      <DataList<PulloutRow>
        listKey="pullout-slips"
        endpoint="/pullout-slips"
        printPath="/api/pullout-slips/pdf"
        reportPath="/g-chain/reports?kind=pullout"
        columns={columns}
        rowKey={(r) => r.id}
        searchPlaceholder="Search number, document, destination, courier…"
        onRowClick={(r) => navigate(`/g-chain/pullout-slips/${r.id}`)}
        emptyTitle="No pull-out slips yet"
        emptyHint="Raise one against an issued sales order, an approved project request, or with no source document."
        selectable
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'DRAFT', label: 'Draft' },
              { value: 'PENDING_APPROVAL', label: 'Pending approval' },
              { value: 'PULLED_OUT', label: 'Pulled out' },
              { value: 'CANCELLED', label: 'Cancelled' },
            ],
          },
          {
            key: 'kind',
            label: 'Against',
            options: [
              { value: 'SALES_ORDER', label: 'Sales orders' },
              { value: 'PURCHASE_REQUEST', label: 'Purchase requests' },
              { value: 'OTHER', label: 'No source document' },
            ],
          },
          { key: 'purpose', label: 'Purpose', options: PURPOSE_OPTIONS },
        ]}
        summary={(raw, total) => {
          const sum = raw as { pending?: number; pulledOut?: number; drafts?: number };
          return (
            <>
              <Stat label="Pull-out slips" value={total} />
              <Stat label="Waiting for approval" value={sum.pending ?? 0} to="/g-chain/pullout-slips?status=PENDING_APPROVAL" />
              <Stat label="Pulled out" value={sum.pulledOut ?? 0} to="/g-chain/pullout-slips?status=PULLED_OUT" />
              <Stat label="Drafts" value={sum.drafts ?? 0} accent="quiet" to="/g-chain/pullout-slips?status=DRAFT" />
            </>
          );
        }}
        actions={
          can('gchain.pullout_slips.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/g-chain/pullout-slips/new')}>
              + New pull-out slip
            </button>
          ) : null
        }
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  THE SLIP PAGE
// ════════════════════════════════════════════════════════════════════

interface SourceLine {
  id: string;
  title: string;
  description: string;
  partNumber: string | null;
  unit: string;
  quantity: number;
  left: number;
  itemId: string | null;
}

interface StockItem {
  id: string;
  code: string;
  partNumber: string | null;
  brand: string | null;
  name: string;
  unit: string;
  available: number;
}

interface SourceData {
  source: {
    kind: Kind;
    salesOrderId: string | null;
    requestId: string | null;
    number: string;
    label: string;
    job: { id: string; number: string; name: string } | null;
    owner: { id: string; name: string } | null;
    poReference: string | null;
    drReference: string | null;
    lines: SourceLine[];
  };
  purposes: { key: string; label: string; noSource: boolean }[];
  warehouses: { id: string; code: string; name: string }[];
  items: StockItem[];
}

interface Pick {
  include: boolean;
  itemId: string;
  quantity: string;
  serialNo: string;
  condition: string;
}
interface FreeLine {
  key: string;
  itemId: string;
  quantity: string;
  serialNo: string;
  condition: string;
}

/** The conditions a line usually leaves in; anything else may be typed. */
const CONDITIONS = ['Brand new', 'Good', 'Calibrated', 'Used — good', 'For repair', 'For return'];

let freeSeq = 0;
const blankFree = (): FreeLine => ({ key: `f${++freeSeq}`, itemId: '', quantity: '', serialNo: '', condition: '' });

type Header = {
  warehouseId: string;
  pulloutDate: string;
  purpose: string;
  requestedById: string;
  receivedByName: string;
  courierCompany: string;
  courierContact: string;
  vehicle: string;
  destination: string;
  poReference: string;
  drReference: string;
  returnBy: string;
  reason: string;
  notes: string;
};
const BLANK: Header = {
  warehouseId: '',
  pulloutDate: '',
  purpose: '',
  requestedById: '',
  receivedByName: '',
  courierCompany: '',
  courierContact: '',
  vehicle: '',
  destination: '',
  poReference: '',
  drReference: '',
  returnBy: '',
  reason: '',
  notes: '',
};

/** Asks which document a new slip pulls against, when the link named none — or none at all. */
function PickSource({ onPick, onNone }: { onPick: (kind: 'SALES_ORDER' | 'PURCHASE_REQUEST', id: string) => void; onNone: () => void }) {
  const [kind, setKind] = useState<'SALES_ORDER' | 'PURCHASE_REQUEST'>('SALES_ORDER');
  const [term, setTerm] = useState('');
  const [rows, setRows] = useState<{ id: string; number: string; label: string; date: string }[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      api
        .get<typeof rows>(`/pullout-slips/sources${qs({ kind, q: term.trim() || undefined })}`)
        .then((r) => live && setRows(r))
        .catch((err) => live && setError(err));
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [kind, term]);
  return (
    <section className="card" aria-labelledby="po-pick">
      <h2 id="po-pick" className="card-title">
        What does it pull out against?
      </h2>
      <div className="scope-switch" role="group" aria-label="Against">
        <button type="button" className={kind === 'SALES_ORDER' ? 'active' : ''} aria-pressed={kind === 'SALES_ORDER'} onClick={() => setKind('SALES_ORDER')}>
          An issued sales order
        </button>
        <button type="button" className={kind === 'PURCHASE_REQUEST' ? 'active' : ''} aria-pressed={kind === 'PURCHASE_REQUEST'} onClick={() => setKind('PURCHASE_REQUEST')}>
          An approved project request
        </button>
        <button type="button" onClick={onNone}>
          No source document
        </button>
      </div>
      <p className="faint">No source document: a supplier return, testing, a repair — you say why on the slip.</p>
      <div className="qe-rows">
        <Field label="Find">
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder={kind === 'SALES_ORDER' ? 'Order number, customer or PO no.' : 'Request number, project or purpose'} />
        </Field>
      </div>
      <ErrorBox error={error} />
      {rows === null ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty title="Nothing to pull out against" hint={kind === 'SALES_ORDER' ? 'Only an issued sales order is pulled out against.' : 'Only an approved project request not yet wholly ordered.'} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.number}</td>
                  <td>{r.label}</td>
                  <td>{formatDate(r.date)}</td>
                  <td className="right">
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => onPick(kind, r.id)}>
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
  );
}

/**
 * One page for a new slip and a draft one being modified: what it is for,
 * who asked for it, the warehouse and the date, the references, the courier
 * and where it goes, and the lines — for each line of the source still to
 * pull out, the item from what that warehouse holds; with no source
 * document, any item the warehouse holds. Save takes the person to the slip,
 * where it is submitted for approval (or, with the route switched off,
 * pulled out).
 */
export function PulloutEditor() {
  const { id } = useParams<{ id: string }>();
  const editing = !!id;
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { me } = useAuth();
  const { people } = usePeople();
  const salesOrderParam = params.get('salesOrder');
  const requestParam = params.get('request');
  const noneParam = params.get('kind') === 'other';
  const [existing, setExisting] = useState<Record<string, unknown> | null>(null);
  const [data, setData] = useState<SourceData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [form, setForm] = useState<Header>(BLANK);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [free, setFree] = useState<FreeLine[]>([blankFree()]);

  useBackLink(editing ? `/g-chain/pullout-slips/${id}` : '/g-chain/pullout-slips', editing ? (existing ? String(existing.number) : 'the slip') : 'Pull-out Slips');
  useUnsavedChanges(dirty && !busy);

  const sourceQuery = (soId: string | null, prId: string | null, none: boolean, warehouseId?: string) =>
    `/pullout-slips/source${qs({
      kind: none ? 'OTHER' : undefined,
      salesOrderId: soId ?? undefined,
      requestId: prId ?? undefined,
      slipId: editing ? id : undefined,
      warehouseId: warehouseId || undefined,
    })}`;

  // The slip being modified, then its source; or the source the link names.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        let slip: Record<string, unknown> | null = null;
        let soId = salesOrderParam;
        let prId = requestParam;
        let none = noneParam;
        let warehouseId = '';
        if (editing) {
          slip = await api.get<Record<string, unknown>>(`/pullout-slips/${id}`);
          soId = (slip.salesOrderId as string | null) ?? null;
          prId = (slip.requestId as string | null) ?? null;
          none = slip.kind === 'OTHER';
          warehouseId = (slip.warehouse as { id: string }).id;
        }
        if (!soId && !prId && !none) return;
        const loaded = await api.get<SourceData>(sourceQuery(soId, prId, none));
        if (!live) return;
        warehouseId = warehouseId || (loaded.warehouses.length === 1 ? loaded.warehouses[0].id : '');
        const withStock = warehouseId ? await api.get<SourceData>(sourceQuery(soId, prId, none, warehouseId)) : loaded;
        if (!live) return;
        setData(withStock);
        const src = withStock.source;
        if (slip) {
          setExisting(slip);
          const str = (k: string) => (typeof slip![k] === 'string' ? (slip![k] as string) : '');
          setForm({
            warehouseId,
            pulloutDate: str('pulloutDate').slice(0, 10),
            purpose: str('purpose'),
            requestedById: (slip.requestedBy as { id: string } | null)?.id ?? '',
            receivedByName: str('receivedByName'),
            courierCompany: str('courierCompany'),
            courierContact: str('courierContact'),
            vehicle: str('vehicle'),
            destination: str('destination'),
            poReference: str('poReference'),
            drReference: str('drReference'),
            returnBy: str('returnBy').slice(0, 10),
            reason: str('reason'),
            notes: str('notes'),
          });
          const items = slip.items as { sourceLineId: string | null; item: { id: string }; quantity: number; serialNo: string | null; condition: string | null }[];
          if (none) {
            setFree(
              items.length
                ? items.map((i) => ({ key: `f${++freeSeq}`, itemId: i.item.id, quantity: String(i.quantity), serialNo: i.serialNo ?? '', condition: i.condition ?? '' }))
                : [blankFree()],
            );
          } else {
            const next: Record<string, Pick> = {};
            for (const l of src.lines) next[l.id] = { include: false, itemId: l.itemId ?? '', quantity: String(l.left), serialNo: '', condition: '' };
            for (const i of items) {
              if (i.sourceLineId) next[i.sourceLineId] = { include: true, itemId: i.item.id, quantity: String(i.quantity), serialNo: i.serialNo ?? '', condition: i.condition ?? '' };
            }
            setPicks(next);
          }
        } else {
          setForm({
            ...BLANK,
            warehouseId,
            purpose: src.kind === 'SALES_ORDER' ? 'SALES_ORDER' : src.kind === 'PURCHASE_REQUEST' ? 'PROJECT_USE' : '',
            requestedById: src.owner?.id ?? me?.user.id ?? '',
            poReference: src.poReference ?? '',
            drReference: src.drReference ?? '',
          });
          setPicks(
            Object.fromEntries(src.lines.map((l) => [l.id, { include: l.left > 0, itemId: l.itemId ?? '', quantity: String(l.left), serialNo: '', condition: 'Brand new' }])),
          );
        }
      } catch (err) {
        if (live) setError(err);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, id, salesOrderParam, requestParam, noneParam]);

  // A warehouse chosen: what it holds now.
  async function chooseWarehouse(warehouseId: string) {
    setForm((f) => ({ ...f, warehouseId }));
    setDirty(true);
    if (!data || !warehouseId) return;
    try {
      setData(await api.get<SourceData>(sourceQuery(data.source.salesOrderId, data.source.requestId, data.source.kind === 'OTHER', warehouseId)));
    } catch (err) {
      setError(err);
    }
  }

  const itemById = useMemo(() => new Map((data?.items ?? []).map((i) => [i.id, i])), [data]);

  if (error && !data) return <ErrorBox error={error} />;
  if (!editing && !salesOrderParam && !requestParam && !noneParam) {
    return (
      <div className="prq">
        <section className="card qe-card prq-head-card">
          <div className="qe-head">
            <div>
              <h1 className="qe-heading">New pull-out slip</h1>
              <p className="muted qe-lead">The warehouse's authority to release stock — against an issued sales order, an approved project request, or no source document.</p>
            </div>
          </div>
        </section>
        <PickSource onPick={(kind, sid) => setParams(kind === 'SALES_ORDER' ? { salesOrder: sid } : { request: sid })} onNone={() => setParams({ kind: 'other' })} />
      </div>
    );
  }
  if (!data) return <Loading />;
  if (editing && existing && existing.canEdit !== true) {
    return (
      <div className="card">
        <p className="muted">{`${String(existing.number)} is no longer a draft — ${existing.status === 'PENDING_APPROVAL' ? 'pull it back from ⋯ on its page to change it' : 'it holds still'}.`}</p>
      </div>
    );
  }

  const { source } = data;
  const none = source.kind === 'OTHER';
  const purposes = data.purposes.filter((p) => !none || p.noSource);
  const chosen = source.lines.filter((l) => picks[l.id]?.include);
  const freeSent = free.filter((l) => l.itemId || l.quantity);
  const problems: string[] = [];
  if (!form.warehouseId) problems.push('choose the warehouse');
  if (!form.purpose) problems.push('say what it is for');
  if (none && form.reason.trim().length < 3) problems.push('say why there is no source document');
  if (none) {
    if (!freeSent.length) problems.push('add at least one item');
    const asked = new Map<string, number>();
    for (const l of freeSent) asked.set(l.itemId, (asked.get(l.itemId) ?? 0) + (Number(l.quantity) || 0));
    freeSent.forEach((l, n) => {
      const it = itemById.get(l.itemId);
      if (!l.itemId) problems.push(`choose the item on line ${n + 1}`);
      else if (!(Number(l.quantity) > 0)) problems.push(`give a quantity on line ${n + 1}`);
      else if (it && (asked.get(l.itemId) ?? 0) > it.available + 0.0005) problems.push(`only ${it.available} ${it.unit} of ${it.name} is available`);
    });
  } else {
    if (!chosen.length) problems.push('tick at least one line');
    for (const l of chosen) {
      const p = picks[l.id];
      const q = Number(p.quantity);
      if (!p.itemId) problems.push(`choose the item for "${l.title}"`);
      else if (!(q > 0)) problems.push(`give a quantity for "${l.title}"`);
      else if (q > l.left + 0.0005) problems.push(`only ${l.left} ${l.unit} of "${l.title}" is left`);
      else {
        const it = itemById.get(p.itemId);
        if (it && q > it.available + 0.0005) problems.push(`only ${it.available} ${it.unit} of ${it.name} is available`);
      }
    }
  }

  async function save() {
    setAttempted(true);
    if (problems.length) return;
    setBusy(true);
    setError(null);
    const t = (v: string) => v.trim() || null;
    const body = {
      kind: source.kind,
      salesOrderId: source.salesOrderId,
      requestId: source.requestId,
      warehouseId: form.warehouseId,
      pulloutDate: form.pulloutDate || null,
      purpose: form.purpose || null,
      requestedById: form.requestedById || null,
      receivedByName: t(form.receivedByName),
      courierCompany: t(form.courierCompany),
      courierContact: t(form.courierContact),
      vehicle: t(form.vehicle),
      destination: t(form.destination),
      poReference: t(form.poReference),
      drReference: t(form.drReference),
      returnBy: form.returnBy || null,
      reason: none ? t(form.reason) : null,
      notes: t(form.notes),
      lines: none
        ? freeSent.map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), serialNo: t(l.serialNo), condition: t(l.condition) }))
        : chosen.map((l) => ({
            sourceLineId: l.id,
            itemId: picks[l.id].itemId,
            quantity: Number(picks[l.id].quantity),
            serialNo: t(picks[l.id].serialNo),
            condition: t(picks[l.id].condition),
          })),
    };
    try {
      if (editing && existing) {
        await api.put(`/pullout-slips/${id}/sheet`, { ...body, version: existing.updatedAt });
        setDirty(false);
        toast('ok', `${String(existing.number)} saved`);
        navigate(`/g-chain/pullout-slips/${id}`);
      } else {
        const created = await api.post<{ id: string; number: string; needsApproval: boolean }>('/pullout-slips', body);
        setDirty(false);
        toast('ok', created.needsApproval ? `${created.number} saved — submit it for approval` : `${created.number} saved — pull it out from its page`);
        navigate(`/g-chain/pullout-slips/${created.id}`);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const set = (k: keyof Header) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setDirty(true);
  };
  const setPick = (lineId: string, patch: Partial<Pick>) => {
    setPicks((ps) => ({ ...ps, [lineId]: { ...ps[lineId], ...patch } }));
    setDirty(true);
  };
  const setFreeLine = (key: string, patch: Partial<FreeLine>) => {
    setFree((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setDirty(true);
  };
  const saveButton = (
    <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
      {busy ? 'Saving…' : 'Save'}
    </button>
  );
  const stock = data.items.filter((i) => i.available > 0);
  const itemOptions = (current: string) => (
    <>
      <option value="">— choose —</option>
      {stock.map((s) => (
        <option key={s.id} value={s.id}>
          {s.partNumber ?? s.code} — {s.name}
        </option>
      ))}
      {current && !stock.some((s) => s.id === current) && <option value={current}>{itemById.get(current)?.name ?? 'Not held in this warehouse'}</option>}
    </>
  );
  const currentRequester = (existing?.requestedBy as { id: string; name: string } | undefined) ?? source.owner;

  return (
    <div className="prq">
      <section className="card qe-card prq-head-card" aria-labelledby="po-heading">
        <div className="qe-head">
          <div>
            <h1 id="po-heading" className="qe-heading">
              {editing && existing ? `Modify pull-out slip ${String(existing.number)}` : 'New pull-out slip'}
            </h1>
            <p className="muted qe-lead">
              {none ? (
                'No source document — say why below. No project is charged.'
              ) : (
                <>
                  Against{' '}
                  {source.kind === 'SALES_ORDER' ? (
                    <Link to={`/g-ops/sales-orders/${source.salesOrderId}`}>{source.label}</Link>
                  ) : (
                    <Link to={`/g-chain/purchase-requests/${source.requestId}`}>{source.label}</Link>
                  )}
                  {source.job ? (
                    <>
                      {' '}
                      — {source.job.number} is charged at the warehouse's average cost
                    </>
                  ) : source.kind === 'SALES_ORDER' ? (
                    ' — no project was built from its quotation, so the order is the whole reference'
                  ) : null}
                  .
                </>
              )}
            </p>
          </div>
          <div className="row qe-actions">{saveButton}</div>
        </div>
        <ErrorBox error={error} />
        {attempted && problems.length > 0 && (
          <div className="alert error" role="alert">
            Not saved yet — {problems.join('; ')}.
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="po-details">
        <h2 id="po-details" className="card-title">
          Pull-out details
        </h2>
        <div className="qe-header qe-rows prq-rows">
          <Field label="Purpose / transaction" required error={attempted && !form.purpose ? 'Say what it is for' : null}>
            <select value={form.purpose} onChange={set('purpose')}>
              <option value="">— choose —</option>
              {purposes.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Requested by" hint="Sales or the project — their manager approves the release">
            <PersonSelect
              value={form.requestedById}
              onChange={(v) => {
                setForm((f) => ({ ...f, requestedById: v }));
                setDirty(true);
              }}
              people={people}
              placeholder="— me —"
              current={currentRequester ?? null}
              self={me?.user.id}
            />
          </Field>
          <Field label="Warehouse source" required error={attempted && !form.warehouseId ? 'Choose the warehouse' : null}>
            <select value={form.warehouseId} required onChange={(e) => void chooseWarehouse(e.target.value)}>
              <option value="">— choose —</option>
              {data.warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date">
            <input type="date" value={form.pulloutDate} onChange={set('pulloutDate')} />
          </Field>
          <Field label="PO ref." hint={source.kind === 'SALES_ORDER' ? 'The customer’s PO on the order' : 'A purchase order it relates to'}>
            <input value={form.poReference} maxLength={120} onChange={set('poReference')} />
          </Field>
          <Field label="DR ref." hint="A delivery receipt it relates to">
            <input value={form.drReference} maxLength={120} onChange={set('drReference')} />
          </Field>
        </div>
        {none && (
          <div className="qe-rows">
            <Field label="Why no source document" required error={attempted && form.reason.trim().length < 3 ? 'Say why there is no source document' : null}>
              <textarea rows={2} value={form.reason} placeholder="e.g. wrong size delivered — back to the supplier; analyzer out for a five-day air audit" onChange={set('reason')} />
            </Field>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="po-courier">
        <h2 id="po-courier" className="card-title">
          Courier and destination
        </h2>
        <div className="qe-header qe-rows prq-rows">
          <Field label="Authorized person / courier" hint="Who takes it out — signs Pulled out / received by">
            <input value={form.receivedByName} maxLength={200} onChange={set('receivedByName')} />
          </Field>
          <Field label="Company / logistics provider">
            <input value={form.courierCompany} maxLength={200} onChange={set('courierCompany')} />
          </Field>
          <Field label="Contact number">
            <input value={form.courierContact} maxLength={80} onChange={set('courierContact')} />
          </Field>
          <Field label="Vehicle plate / type">
            <input value={form.vehicle} maxLength={120} placeholder="e.g. NFK-8921 (Canter truck)" onChange={set('vehicle')} />
          </Field>
          <Field label="Destination / site" hint={source.job ? `Blank prints ${source.job.number}` : 'Where it goes'}>
            <input value={form.destination} maxLength={300} onChange={set('destination')} />
          </Field>
          <Field label="Expected back" hint="For testing, a repair or a temporary deployment">
            <input type="date" value={form.returnBy} onChange={set('returnBy')} />
          </Field>
        </div>
        <div className="qe-rows">
          <Field label="Special instructions / remarks" hint="Accessories included, handling — printed on the slip">
            <textarea rows={2} value={form.notes} onChange={set('notes')} />
          </Field>
        </div>
      </section>

      <section className="card" aria-labelledby="po-lines">
        <div className="prq-card-head">
          <h2 id="po-lines" className="card-title">
            {none ? 'Items to pull out' : `Lines of ${source.number}`}
          </h2>
          {none && form.warehouseId && (
            <button type="button" className="btn btn-sm" onClick={() => setFree((ls) => [...ls, blankFree()])}>
              + Add line
            </button>
          )}
        </div>
        {!form.warehouseId ? (
          <Empty title="Choose the warehouse first" hint="What it holds, and how much is free, appears beside each line." />
        ) : none ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Item from the shelf</th>
                  <th className="right">Available</th>
                  <th className="right proc-col-input">Quantity</th>
                  <th>Serial / batch</th>
                  <th>Condition</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {free.map((l, n) => {
                  const it = itemById.get(l.itemId);
                  return (
                    <tr key={l.key}>
                      <td>{n + 1}</td>
                      <td>
                        <select aria-label={`Item — line ${n + 1}`} value={l.itemId} onChange={(e) => setFreeLine(l.key, { itemId: e.target.value })}>
                          {itemOptions(l.itemId)}
                        </select>
                      </td>
                      <td className="right mono">{it ? `${it.available} ${it.unit}` : <span className="faint">—</span>}</td>
                      <td>
                        <NumberInput
                          kind="quantity"
                          className="mono proc-cell-input"
                          step="0.001"
                          aria-label={`Quantity — line ${n + 1}`}
                          value={l.quantity}
                          onChange={(e) => setFreeLine(l.key, { quantity: e.target.value })}
                        />
                      </td>
                      <td className="inc-unit-cell">
                        <input aria-label={`Serial or batch — line ${n + 1}`} value={l.serialNo} maxLength={120} onChange={(e) => setFreeLine(l.key, { serialNo: e.target.value })} />
                      </td>
                      <td className="inc-unit-cell">
                        <input aria-label={`Condition — line ${n + 1}`} list="pullout-conditions" value={l.condition} maxLength={80} onChange={(e) => setFreeLine(l.key, { condition: e.target.value })} />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm btn-icon"
                          aria-label={`Remove line ${n + 1}`}
                          onClick={() => {
                            setFree((ls) => {
                              const rest = ls.filter((x) => x.key !== l.key);
                              return rest.length ? rest : [blankFree()];
                            });
                            setDirty(true);
                          }}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th aria-label="Pull out" />
                  <th>Line</th>
                  <th className="right">Left</th>
                  <th>Item from the shelf</th>
                  <th className="right">Available</th>
                  <th className="right proc-col-input">Quantity</th>
                  <th>Serial / batch</th>
                  <th>Condition</th>
                </tr>
              </thead>
              <tbody>
                {source.lines.map((l) => {
                  const p = picks[l.id] ?? { include: false, itemId: '', quantity: '', serialNo: '', condition: '' };
                  const it = itemById.get(p.itemId);
                  return (
                    <tr key={l.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Pull out ${l.title}`}
                          checked={p.include}
                          disabled={l.left <= 0 && !p.include}
                          onChange={(e) => setPick(l.id, { include: e.target.checked })}
                        />
                      </td>
                      <td>
                        <div>{l.title}</div>
                        <div className="faint">{[l.partNumber, l.description].filter(Boolean).join(' · ') || `${l.quantity} ${l.unit}`}</div>
                      </td>
                      <td className="right mono">
                        {l.left} {l.unit}
                      </td>
                      <td>
                        <select aria-label={`Item for ${l.title}`} value={p.itemId} disabled={!p.include} onChange={(e) => setPick(l.id, { itemId: e.target.value })}>
                          {itemOptions(p.itemId)}
                        </select>
                      </td>
                      <td className="right mono">{it ? `${it.available} ${it.unit}` : <span className="faint">—</span>}</td>
                      <td>
                        <NumberInput
                          kind="quantity"
                          className="mono proc-cell-input"
                          step="0.001"
                          aria-label={`Quantity of ${l.title}`}
                          value={p.quantity}
                          disabled={!p.include}
                          onChange={(e) => setPick(l.id, { quantity: e.target.value })}
                        />
                      </td>
                      <td className="inc-unit-cell">
                        <input aria-label={`Serial or batch of ${l.title}`} value={p.serialNo} maxLength={120} disabled={!p.include} onChange={(e) => setPick(l.id, { serialNo: e.target.value })} />
                      </td>
                      <td className="inc-unit-cell">
                        <input
                          aria-label={`Condition of ${l.title}`}
                          list="pullout-conditions"
                          value={p.condition}
                          maxLength={80}
                          disabled={!p.include}
                          onChange={(e) => setPick(l.id, { condition: e.target.value })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <datalist id="pullout-conditions">
          {CONDITIONS.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </section>

      <div className="page-foot">{saveButton}</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  THE SLIP
// ════════════════════════════════════════════════════════════════════

export function PulloutDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const confirm = useConfirm();
  const [slip, setSlip] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setSlip(await api.get<Record<string, unknown>>(`/pullout-slips/${id}`));
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
  if (!slip) return <ErrorBox error={error ?? new Error('Not found')} />;

  const number = String(slip.number);
  const status = String(slip.status);
  const isDraft = status === 'DRAFT';
  const so = slip.salesOrder as { id: string; number: string; customer: { name: string } } | null;
  const pr = slip.request as { id: string; number: string } | null;
  const job = slip.job as { id: string; number: string; name: string } | null;
  const warehouse = slip.warehouse as { id: string; name: string };
  const releasedBy = slip.releasedBy as { name: string } | null;
  const requestedBy = slip.requestedBy as { id: string; name: string; position: string | null };
  const preparedBy = slip.preparedBy as { id: string; name: string };
  const route = (slip.approvalRoute ?? null) as PreviewRoute | null;
  const purposeLabel = String(slip.purposeLabel ?? '');
  const str = (k: string) => (typeof slip[k] === 'string' && slip[k] ? (slip[k] as string) : null);
  const items = slip.items as {
    id: string;
    quantity: number;
    serialNo: string | null;
    condition: string | null;
    item: { id: string; code: string; partNumber: string | null; brand: string | null; name: string; unit: string };
    sourceLine: { title: string; unit: string } | null;
  }[];

  async function submit() {
    setSlip(await api.post<Record<string, unknown>>(`/pullout-slips/${id}/submit`));
    setReload((n) => n + 1);
    toast('ok', `${number} submitted for approval`);
  }
  async function pullOut() {
    setSlip(await api.post<Record<string, unknown>>(`/pullout-slips/${id}/pull-out`));
    toast('ok', `${number} pulled out`);
  }
  async function withdraw() {
    setSlip(await api.post<Record<string, unknown>>(`/pullout-slips/${id}/withdraw`));
    setReload((n) => n + 1);
    toast('ok', `${number} pulled back to a draft`);
  }
  async function cancel(reason: string) {
    await api.post(`/pullout-slips/${id}/cancel`, { reason });
    toast('ok', `${number} cancelled`);
    await load();
  }

  const charge = job ? ` ${job.number} is charged at the warehouse's average cost at that moment.` : '';

  return (
    <div>
      <RecordHeader
        type="Pull-out Slip"
        code={number}
        title={str('destination') ?? (job ? `${job.number} — ${job.name}` : purposeLabel)}
        status={status}
        statusExtra={PULLOUT_TONES}
        meta={
          <>
            {purposeLabel} ·{' '}
            {so ? (
              <>
                against <Link to={`/g-ops/sales-orders/${so.id}`}>{so.number}</Link>
              </>
            ) : pr ? (
              <>
                against <Link to={`/g-chain/purchase-requests/${pr.id}`}>{pr.number}</Link>
              </>
            ) : (
              'no source document'
            )}
            {job && (
              <>
                {' '}
                · <Link to={`/g-ops/projects/${job.id}`}>{job.number}</Link>
              </>
            )}{' '}
            · from {warehouse.name} · {formatDate(String(slip.pulloutDate))}
          </>
        }
        actions={
          slip.canSubmit === true ? (
            <button
              className="btn btn-primary"
              onClick={() =>
                confirm.ask({
                  title: `Submit ${number} for approval?`,
                  body: `Nothing leaves ${warehouse.name} until it is approved.${charge}`,
                  confirmLabel: 'Submit for approval',
                  tone: 'primary',
                  onConfirm: submit,
                })
              }
            >
              Submit for approval
            </button>
          ) : slip.canPullOut === true ? (
            <button
              className="btn btn-primary"
              onClick={() =>
                confirm.ask({
                  title: `Pull out ${number}?`,
                  body: `The stock leaves ${warehouse.name}.${charge} It cannot be taken back.`,
                  confirmLabel: 'Pull out',
                  tone: 'primary',
                  onConfirm: pullOut,
                })
              }
            >
              Pull out
            </button>
          ) : null
        }
        print={`/api/pullout-slips/${id}/pdf`}
        more={[
          slip.canWithdraw === true && {
            label: 'Pull back to a draft',
            hint: 'Withdraws it from the approver',
            confirm: {
              title: `Pull ${number} back to a draft?`,
              body: 'Its approval is withdrawn and the approver is told. Change it and submit it again.',
              confirmLabel: 'Pull back',
              tone: 'primary',
              onConfirm: withdraw,
            },
          },
          slip.canCancel === true && {
            label: 'Cancel pull-out slip',
            danger: true,
            confirm: {
              title: `Cancel ${number}?`,
              body: 'Nothing has left the shelf. The reason is kept on the slip.',
              confirmLabel: 'Cancel pull-out slip',
              reason: 'required',
              minReason: 3,
              onConfirm: cancel,
            },
          },
        ]}
        modify={slip.canEdit === true ? `/g-chain/pullout-slips/${id}/edit` : undefined}
        confirm={confirm}
      />

      {isDraft && route && route.steps.length > 0 && (
        <div className="qd-route">
          <span className="qd-route-label">{allHeld(route) ? 'No one else’s approval needed' : 'Submit for approval sends it to'}</span>
          <ApprovalStepper steps={previewSteps(route)} />
        </div>
      )}
      <DecisionNote documentType="pullout_slip" documentId={String(id)} reloadToken={reload} />
      {(status === 'PENDING_APPROVAL' || status === 'PULLED_OUT') && <DocumentApproval documentType="pullout_slip" documentId={String(id)} reloadToken={reload} />}

      <ErrorBox error={error} />
      {isDraft && <div className="alert info">A draft. Nothing has left {warehouse.name} yet.</div>}
      {status === 'PENDING_APPROVAL' && <div className="alert info">Waiting for approval. Nothing has left {warehouse.name} yet — its approval pulls it out.</div>}
      {status === 'CANCELLED' && typeof slip.cancelReason === 'string' && <div className="alert warn">Cancelled — {slip.cancelReason}</div>}

      <div className="card">
        <h3 className="card-title">Release details</h3>
        <dl className="kv">
          <dt>Purpose</dt>
          <dd>{purposeLabel}</dd>
          <dt>Requested by</dt>
          <dd>
            {requestedBy.name}
            {requestedBy.position ? <span className="muted"> · {requestedBy.position}</span> : null}
            {requestedBy.id !== preparedBy.id ? <span className="muted"> · prepared by {preparedBy.name}</span> : null}
          </dd>
          {str('reason') && (
            <>
              <dt>Why no source document</dt>
              <dd>{str('reason')}</dd>
            </>
          )}
          <dt>PO ref. · DR ref.</dt>
          <dd>
            {str('poReference') ?? '—'} · {str('drReference') ?? '—'}
          </dd>
          <dt>Authorized person / courier</dt>
          <dd>{[str('receivedByName'), str('courierCompany'), str('courierContact')].filter(Boolean).join(' · ') || '—'}</dd>
          <dt>Vehicle</dt>
          <dd>{str('vehicle') ?? '—'}</dd>
          <dt>Destination</dt>
          <dd>{str('destination') ?? (job ? `${job.number} — ${job.name}` : '—')}</dd>
          {str('returnBy') && (
            <>
              <dt>Expected back</dt>
              <dd>{formatDate(str('returnBy')!)}</dd>
            </>
          )}
          {str('notes') && (
            <>
              <dt>Special instructions</dt>
              <dd className="activity-notes">{str('notes')}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="card">
        <h3 className="card-title">Items</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th>Serial / batch</th>
                <th>Condition</th>
                {!!(so || pr) && <th>Against</th>}
                <th className="right">Qty</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div>
                      <strong>{i.item.name}</strong>
                    </div>
                    <div className="faint mono">
                      {i.item.partNumber ?? i.item.code}
                      {i.item.brand ? ` · ${i.item.brand}` : ''}
                    </div>
                  </td>
                  <td>{i.serialNo ?? <span className="faint">—</span>}</td>
                  <td>{i.condition ?? <span className="faint">—</span>}</td>
                  {!!(so || pr) && <td>{i.sourceLine?.title ?? <span className="faint">—</span>}</td>}
                  <td className="right mono">
                    {i.quantity} {i.item.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {releasedBy && typeof slip.releasedAt === 'string' && (
          <p className="faint proc-card-note">
            Released from {warehouse.name} by {releasedBy.name} on {formatDate(slip.releasedAt)}
          </p>
        )}
      </div>

      <Attachments
        entityType="pullout_slip"
        entityId={String(id)}
        title="Gate pass and documents"
        hint="The signed slip, the gate clearance or photos of what left — printed behind the slip"
        canEdit={slip.canEdit === true || slip.canWithdraw === true}
      />
    </div>
  );
}

/**
 * The pull-out slips raised against a sales order or a request — a card on
 * that document's page, for a reader of the register; hidden, never empty,
 * without it (a cross-module card's rule).
 */
export function PulloutCard({ salesOrderId, requestId }: { salesOrderId?: string; requestId?: string }) {
  const { can } = useAuth();
  const [rows, setRows] = useState<PulloutRow[] | null>(null);
  const may = can('gchain.pullout_slips.view_all');
  useEffect(() => {
    if (!may) return;
    let live = true;
    api
      .get<{ rows: PulloutRow[] }>(`/pullout-slips${qs({ salesOrderId, requestId, pageSize: 50 })}`)
      .then((r) => live && setRows(r.rows))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [may, salesOrderId, requestId]);
  if (!may || !rows || rows.length === 0) return null;
  return (
    <div className="card">
      <h3 className="card-title">Pulled out</h3>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Number</th>
              <th>Warehouse</th>
              <th>Date</th>
              <th className="right">Lines</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link className="mono" to={`/g-chain/pullout-slips/${r.id}`}>
                    {r.number}
                  </Link>
                </td>
                <td>{r.warehouse.name}</td>
                <td>{formatDate(r.pulloutDate)}</td>
                <td className="right">{r.lineCount}</td>
                <td>
                  <StatusBadge status={r.status} extra={PULLOUT_TONES} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

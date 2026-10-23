import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, formatDate, formatMoney, useToast } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';
import { SupplierPicker, type SupplierRef } from '../../components/SupplierPicker';
import { ApprovalStepper, allHeld, previewSteps } from '../../components/ApprovalStepper';
import { Meter } from '../../components/charts';
import { useBackLink, useUnsavedChanges } from '../../components/Navigation';
import { orderTotals, parseDelimited, prLineAmount, rowsToPrLines } from '../../lib/prLines';
import { ItemCell, type BudgetLine, type Category, type Route, type Suggestion } from './PurchaseRequisitionEditor';

/**
 * The purchase order as a PAGE (2026-10-13, the owner's call after the
 * requisition page: "do the same full page for purchase orders"). One page
 * for New and Modify: `/g-chain/purchase-orders/new` — with `?fromRequest=`
 * or `?fromCanvass=` the request's lines (at the canvass winner's prices, or
 * the request's estimates) are on the page before anything is saved — and
 * `/g-chain/purchase-orders/:id/edit` on a draft.
 *
 * Header and lines are ONE save (`POST /purchase-orders` with `lines[]`,
 * `PUT /purchase-orders/:id/sheet`). Beside the lines, for an order charged to
 * a project, the budget: from a request, the request's declared value that
 * stays committed (2026-10-22 — the order's prices move no budget line);
 * with no request, what is available less this order's lines at the agreed
 * price, which issuing commits. Under them the order's money (the
 * server's `recalcPo`, mirrored in `orderTotals`) and the route submitting
 * would take.
 */

interface Budget {
  job: { id: string; number: string; name: string };
  lines: BudgetLine[];
  total: { budgeted: number; committed: number; incurred: number; available: number };
  /** The request's declared value still committed, per budget line — what Budget Monitoring counts (2026-10-22). */
  declared: Record<string, number>;
  /** Kept empty since 2026-10-22: issuing an order from a request releases nothing. */
  released: Record<string, number>;
  blocked: boolean;
}

interface SourceLine {
  requestItemId: string | null;
  itemId: string | null;
  costCategoryId: string | null;
  partNumber: string | null;
  name: string | null;
  description: string;
  nature?: 'GOODS' | 'SERVICE';
  quantity: number;
  unit: string;
  unitPrice: number;
}

interface Draft {
  vatRate: number;
  kind: string;
  request: { id: string; number: string; purpose: string; preferredSupplier: string | null } | null;
  job: { id: string; number: string; name: string } | null;
  salesOrder?: { id: string; number: string; customer: { name: string } } | null;
  warehouse: { id: string; name: string } | null;
  canvass: { id: string; number: string } | null;
  supplier: { id: string; name: string; paymentTerms: string | null } | null;
  neededBy: string | null;
  quoteRef?: string | null;
  currency?: string;
  lines: SourceLine[];
}

interface ExistingPo {
  id: string;
  number: string;
  kind: string;
  status: string;
  orderDate: string;
  deliveryDate: string | null;
  deliverTo: string | null;
  deliverAddress?: string | null;
  quoteRef?: string | null;
  currency?: string;
  terms: string | null;
  notes: string | null;
  vatRate: number;
  vatInclusive: boolean;
  canEdit: boolean;
  version: string;
  supplier: { id: string; name: string; paymentTerms: string | null };
  job: { id: string; number: string; name: string } | null;
  salesOrder?: { id: string; number: string; customer: { name: string } } | null;
  warehouse: { id: string; name: string } | null;
  request: { id: string; number: string; purpose: string } | null;
  fromCanvass: { id: string; number: string } | null;
  createdBy: { id: string; name: string };
  items: {
    id: string;
    requestItemId: string | null;
    name: string | null;
    partNumber: string | null;
    description: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    nature?: 'GOODS' | 'SERVICE';
    item: { id: string } | null;
    costCategory: { id: string } | null;
  }[];
}

interface Line {
  key: string;
  id: string | null;
  requestItemId: string | null;
  itemId: string | null;
  costCategoryId: string;
  partNumber: string;
  name: string;
  description: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  /** Goods or a service (2026-10-21); a request line keeps the request's. */
  nature: 'GOODS' | 'SERVICE';
}

interface Header {
  supplier: SupplierRef | null;
  deliveryDate: string;
  terms: string;
  deliverTo: string;
  deliverAddress: string;
  quoteRef: string;
  currency: string;
  notes: string;
  vatInclusive: boolean;
  applyVat: boolean;
}

let nextKey = 0;
const newKey = () => `o${++nextKey}`;

const blankLine = (costCategoryId = ''): Line => ({
  key: newKey(),
  id: null,
  requestItemId: null,
  itemId: null,
  costCategoryId,
  partNumber: '',
  name: '',
  description: '',
  unit: 'pcs',
  quantity: '1',
  unitPrice: '',
  nature: 'GOODS',
});

const fromSource = (l: SourceLine): Line => ({
  key: newKey(),
  id: null,
  requestItemId: l.requestItemId,
  itemId: l.itemId,
  costCategoryId: l.costCategoryId ?? '',
  partNumber: l.partNumber ?? '',
  name: l.name ?? l.description,
  description: l.name && l.description !== l.name ? l.description : '',
  unit: l.unit,
  quantity: String(l.quantity),
  unitPrice: String(l.unitPrice),
  nature: l.nature ?? 'GOODS',
});

const amountOf = (l: Line) => prLineAmount(Number(l.quantity) || 0, Number(l.unitPrice) || 0);
const isBlank = (l: Line) => !l.id && !l.requestItemId && !l.name.trim() && !l.description.trim() && !l.partNumber.trim() && !l.unitPrice;
const snapshot = (h: Header, lines: Line[]) =>
  JSON.stringify([{ ...h, supplier: h.supplier?.id ?? null }, lines.filter((l) => !isBlank(l)).map(({ key: _key, ...rest }) => rest)]);

/** The quotation's currencies (shared/quotation.ts QUOTATION_CURRENCIES). */
const PO_CURRENCIES = ['PHP', 'USD', 'EUR', 'JPY', 'SGD', 'CNY', 'GBP', 'AUD', 'HKD'];

export function PurchaseOrderEditor() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const editing = Boolean(id);
  const fromRequest = params.get('fromRequest');
  const fromCanvass = params.get('fromCanvass');

  const [existing, setExisting] = useState<ExistingPo | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);
  // An order raised with no request may be for a sales order (2026-10-21).
  const [orderChoices, setOrderChoices] = useState<{ id: string; number: string; customer: string; subject: string }[]>([]);
  const [pickedOrderId, setPickedOrderId] = useState('');
  // What a standalone order is for (2026-10-23): the warehouse's stock, a
  // project, or a sales order — never "direct to project" with no project.
  const [forMode, setForMode] = useState<'stock' | 'project' | 'order'>('stock');
  const [pickedJobId, setPickedJobId] = useState('');
  const [pickedWarehouseId, setPickedWarehouseId] = useState('');
  const [jobChoices, setJobChoices] = useState<{ id: string; number: string; name: string }[]>([]);
  const [warehouseChoices, setWarehouseChoices] = useState<{ id: string; name: string }[]>([]);
  const [route, setRoute] = useState<Route | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // What Deliver to and its address suggest: the company's name and address.
  const [shipTo, setShipTo] = useState({ name: '', address: '' });
  useEffect(() => {
    api.get<{ name: string; address: string }>('/purchase-orders/ship-to').then(setShipTo, () => undefined);
  }, []);
  const [header, setHeader] = useState<Header>({
    supplier: null,
    deliveryDate: '',
    terms: '',
    deliverTo: '',
    deliverAddress: '',
    quoteRef: '',
    currency: 'PHP',
    notes: '',
    vatInclusive: false,
    applyVat: true,
  });
  const [lines, setLines] = useState<Line[]>(() => [blankLine()]);
  const [saved, setSaved] = useState<string | null>(null);

  // ── Loading ────────────────────────────────────────────────────────────────

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const cats = await api.get<(Category & { isActive?: boolean })[]>('/reference/cost-categories');
        if (!live) return;
        setCategories(cats.filter((c) => c.isActive !== false));
        let h = header;
        let ls = lines;
        if (id) {
          const po = await api.get<ExistingPo>(`/purchase-orders/${id}`);
          if (!live) return;
          setExisting(po);
          h = {
            supplier: { id: po.supplier.id, name: po.supplier.name },
            deliveryDate: po.deliveryDate ? po.deliveryDate.slice(0, 10) : '',
            terms: po.terms ?? '',
            deliverTo: po.deliverTo ?? '',
            deliverAddress: po.deliverAddress ?? '',
            quoteRef: po.quoteRef ?? '',
            currency: po.currency ?? 'PHP',
            notes: po.notes ?? '',
            vatInclusive: po.vatInclusive,
            applyVat: Number(po.vatRate) > 0,
          };
          ls = po.items.map((i) => ({
            key: newKey(),
            id: i.id,
            requestItemId: i.requestItemId,
            itemId: i.item?.id ?? null,
            costCategoryId: i.costCategory?.id ?? '',
            partNumber: i.partNumber ?? '',
            name: i.name ?? i.description,
            description: i.name && i.description !== i.name ? i.description : '',
            unit: i.unit,
            quantity: String(i.quantity),
            unitPrice: String(i.unitPrice),
            nature: i.nature ?? 'GOODS',
          }));
        } else {
          const ship = await api.get<{ name: string; address: string }>('/purchase-orders/ship-to').catch(() => ({ name: '', address: '' }));
          const d = await api.get<Draft>(
            `/purchase-orders/draft${qs({ requestId: fromRequest ?? '', canvassId: fromCanvass ?? '' })}`,
          );
          if (!live) return;
          setDraft(d);
          h = {
            ...h,
            supplier: d.supplier ? { id: d.supplier.id, name: d.supplier.name } : null,
            terms: d.supplier?.paymentTerms ?? '',
            quoteRef: d.quoteRef ?? '',
            currency: 'PHP',
            // The company receives by default (2026-10-14, the owner's call).
            deliverTo: ship.name,
            deliverAddress: ship.address,
            deliveryDate: d.neededBy ? d.neededBy.slice(0, 10) : '',
          };
          ls = d.lines.map(fromSource);
        }
        if (!ls.length) ls = [blankLine()];
        setHeader(h);
        setLines(ls);
        setSaved(snapshot(h, ls));
      } catch (err) {
        if (live) setError(err);
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
    // Loaded once per page; from then on the header and lines are the page's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fromRequest, fromCanvass]);

  const request = existing?.request ?? draft?.request ?? null;
  // Raised with no request, the buyer may name the sales order it is for.
  const standalone = !existing && !request;
  const kind =
    existing?.kind ??
    (standalone
      ? forMode === 'order' && pickedOrderId
        ? 'SALES_ORDER'
        : forMode === 'project' && pickedJobId
          ? 'DIRECT_TO_JOB'
          : 'STOCK_REPLENISHMENT'
      : (draft?.kind ?? 'STOCK_REPLENISHMENT'));
  const job = existing?.job ?? draft?.job ?? (standalone && forMode === 'project' ? (jobChoices.find((j) => j.id === pickedJobId) ?? null) : null);
  // Only an order charged to a project asks each line for its budget line.
  const direct = kind === 'DIRECT_TO_JOB';
  const salesOrder = existing?.salesOrder ?? draft?.salesOrder ?? null;

  useEffect(() => {
    if (!standalone) return;
    api
      .get<typeof orderChoices>('/purchase-orders/sales-orders')
      .then(setOrderChoices)
      .catch(() => setOrderChoices([]));
    api
      .get<typeof jobChoices>('/jobs/lookup')
      .then(setJobChoices)
      .catch(() => setJobChoices([]));
    api
      .get<typeof warehouseChoices>('/warehouses')
      .then(setWarehouseChoices)
      .catch(() => setWarehouseChoices([]));
  }, [standalone]);
  const canvass = existing?.fromCanvass ?? draft?.canvass ?? null;
  const warehouse = existing?.warehouse ?? draft?.warehouse ?? null;
  const companyRate = Number(existing?.vatRate) || Number(draft?.vatRate) || 0.12;
  const vatRate = header.applyVat ? companyRate : 0;

  useEffect(() => {
    setBudget(null);
    if (!direct || !job) return;
    let live = true;
    api
      .get<Budget>(`/purchase-orders/budget${qs({ jobId: job.id, requestId: request?.id ?? '' })}`)
      .then((b) => live && setBudget(b))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [direct, job?.id, request?.id]);

  const sent = lines.filter((l) => !isBlank(l));
  const money = useMemo(
    () => orderTotals(sent.map(amountOf), vatRate, header.vatInclusive),
    [sent, vatRate, header.vatInclusive],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api
        .get<{ route: Route | null }>(`/purchase-orders/route${qs({ amount: String(money.total), orderId: id ?? '', importation: header.applyVat ? '' : '1' })}`)
        .then((r) => setRoute(r.route))
        .catch(() => setRoute(null));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [money.total, id, header.applyVat]);

  const dirty = saved !== null && snapshot(header, lines) !== saved;
  useUnsavedChanges(dirty && !busy);
  useBackLink(
    existing ? `/g-chain/purchase-orders/${existing.id}` : request ? `/g-chain/purchase-requests/${request.id}` : canvass ? `/g-chain/canvass/${canvass.id}` : null,
    existing ? existing.number : request ? request.number : canvass ? canvass.number : null,
  );

  // ── Lines ──────────────────────────────────────────────────────────────────

  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: string) =>
    setLines((ls) => {
      const rest = ls.filter((l) => l.key !== key);
      return rest.length ? rest : [blankLine()];
    });
  const lastCategory = () => [...lines].reverse().find((l) => l.costCategoryId)?.costCategoryId ?? '';

  function fromSuggestion(key: string, sg: Suggestion) {
    setLine(key, {
      itemId: sg.itemId ?? (sg.code ? sg.id : null),
      partNumber: sg.partNumber ?? '',
      name: sg.name,
      description: sg.description,
      unit: sg.unit || 'pcs',
      ...(sg.unitCost != null ? { unitPrice: String(sg.unitCost) } : {}),
      ...(sg.costCategory ? { costCategoryId: sg.costCategory.id } : {}),
    });
  }

  function importRows(text: string, replaceKey?: string) {
    const { lines: parsed, skipped: refused } = rowsToPrLines(parseDelimited(text), categories);
    setSkipped(refused);
    if (!parsed.length) {
      toast('error', refused.length ? 'No row could be read — see the note under the lines' : 'Nothing to add');
      return;
    }
    const fallback = lastCategory();
    const made: Line[] = parsed.map((p) => ({
      key: newKey(),
      id: null,
      requestItemId: null,
      itemId: null,
      costCategoryId: p.costCategoryId || fallback,
      partNumber: p.partNumber,
      name: p.name,
      description: p.description,
      unit: p.unit,
      quantity: p.quantity,
      unitPrice: p.estimatedCost,
      nature: 'GOODS',
    }));
    setLines((ls) => {
      const at = replaceKey ? ls.findIndex((l) => l.key === replaceKey) : -1;
      if (at >= 0 && isBlank(ls[at])) return [...ls.slice(0, at), ...made, ...ls.slice(at + 1)].filter((l) => !isBlank(l));
      return [...ls.filter((l) => !isBlank(l)), ...made];
    });
    toast('ok', `${made.length} line${made.length === 1 ? '' : 's'} added${refused.length ? ` — ${refused.length} row(s) skipped` : ''}`);
  }

  // ── Checking and saving ────────────────────────────────────────────────────

  const lineProblem = (l: Line): string | null => {
    if (isBlank(l)) return null;
    if (!l.name.trim() && !l.description.trim()) return 'Say what is ordered';
    if (!(Number(l.quantity) > 0)) return 'Quantity must be more than zero';
    if (direct && !l.costCategoryId) return 'Choose its budget line';
    return null;
  };
  const problems: string[] = [];
  if (!header.supplier) problems.push('Choose the supplier');
  sent.forEach((l, i) => {
    const p = lineProblem(l);
    if (p) problems.push(`Line ${i + 1}: ${p}`);
  });
  if (request && !sent.some((l) => l.requestItemId)) problems.push(`Keep at least one line of ${request.number}`);

  function body() {
    return {
      supplierId: header.supplier?.id ?? '',
      deliveryDate: header.deliveryDate || null,
      terms: header.terms.trim() || null,
      deliverTo: header.deliverTo.trim() || null,
      deliverAddress: header.deliverAddress.trim() || null,
      quoteRef: header.quoteRef.trim() || null,
      currency: header.currency,
      notes: header.notes.trim() || null,
      vatInclusive: header.applyVat && header.vatInclusive,
      applyVat: header.applyVat,
      lines: sent.map((l) => ({
        id: l.id,
        requestItemId: l.requestItemId,
        itemId: l.nature === 'SERVICE' && kind !== 'STOCK_REPLENISHMENT' ? null : l.itemId,
        costCategoryId: l.costCategoryId || null,
        partNumber: l.partNumber.trim() || null,
        name: l.name.trim() || null,
        description: l.description.trim() || null,
        quantity: Number(l.quantity),
        unit: l.unit.trim() || 'pcs',
        unitPrice: Number(l.unitPrice) || 0,
        nature: kind === 'STOCK_REPLENISHMENT' ? 'GOODS' : l.nature,
      })),
      ...(existing
        ? { version: existing.version }
        : {
            requestId: fromCanvass ? null : fromRequest,
            canvassId: fromCanvass,
            salesOrderId: standalone && forMode === 'order' ? pickedOrderId || null : null,
            jobId: standalone && forMode === 'project' ? pickedJobId || null : null,
            warehouseId: standalone && forMode === 'stock' ? pickedWarehouseId || null : null,
          }),
    };
  }

  async function save(submit: boolean) {
    setAttempted(true);
    if (problems.length) return;
    if (submit && !sent.length) {
      setError(new Error('Add at least one line before submitting'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const savedId = existing
        ? (await api.put<{ id: string }>(`/purchase-orders/${existing.id}/sheet`, body())).id
        : (await api.post<{ id: string }>('/purchase-orders', body())).id;
      setSaved(snapshot(header, lines));
      if (submit) {
        try {
          await api.post(`/purchase-orders/${savedId}/submit`);
          toast('ok', 'Saved and submitted for approval');
        } catch (err) {
          toast('error', `Saved as a draft — not submitted: ${err instanceof Error ? err.message : 'refused'}`);
        }
      } else toast('ok', existing ? `${existing.number} saved` : 'Purchase order saved');
      navigate(`/g-chain/purchase-orders/${savedId}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  if (!loaded) return error ? <ErrorBox error={error} /> : <Loading />;
  if (editing && !existing) return <ErrorBox error={error ?? new Error('Purchase order not found')} />;
  if (!editing && !draft) return <ErrorBox error={error ?? new Error('Could not start the order')} />;
  if (existing && !existing.canEdit) {
    return (
      <div className="card">
        <p className="muted">
          {existing.status !== 'DRAFT'
            ? `${existing.number} is ${existing.status.toLowerCase().replace(/_/g, ' ')} and holds still.`
            : 'Only the person who raised this order, or someone who may edit every order, can change it.'}
        </p>
      </div>
    );
  }

  const ordering = new Map<string, number>();
  for (const l of sent) if (l.costCategoryId) ordering.set(l.costCategoryId, (ordering.get(l.costCategoryId) ?? 0) + amountOf(l));
  // From a request, the request's DECLARED value stays committed and the
  // order's prices move no budget line (2026-10-22, the owner's call); only an
  // order with no request behind it commits its own figure on issue.
  const onRequest = !!request;
  const declared = budget?.declared ?? {};
  const budgetRows = (budget?.lines ?? []).filter((b) => b.budgeted > 0 || ordering.has(b.id) || declared[b.id]);
  const leftAfter = (b: BudgetLine) => (onRequest ? b.available : Math.round((b.available - (ordering.get(b.id) ?? 0)) * 100) / 100);
  const over = onRequest ? [] : budgetRows.filter((b) => leftAfter(b) < -0.004);
  const mayCreate = can('gchain.purchase_orders.create');

  const actions = (
    <>
      <button type="button" className="btn" onClick={() => void save(false)} disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {mayCreate && (
        <button type="button" className="btn btn-primary" onClick={() => void save(true)} disabled={busy}>
          Submit for approval
        </button>
      )}
    </>
  );

  return (
    <div className="prq">
      <section className="card qe-card prq-head-card" aria-labelledby="poe-heading">
        <div className="qe-head">
          <div>
            <h1 id="poe-heading" className="qe-heading">
              {existing ? `Modify purchase order ${existing.number}` : 'New purchase order'}
            </h1>
            <p className="muted qe-lead">
              {request ? (
                <>
                  From <Link to={`/g-chain/purchase-requests/${request.id}`}>{request.number}</Link> — {request.purpose}
                  {canvass ? (
                    <>
                      , awarded on <Link to={`/g-chain/canvass/${canvass.id}`}>{canvass.number}</Link>
                    </>
                  ) : null}
                  .{' '}
                </>
              ) : null}
              {existing
                ? 'Change what you need and Save — the header and the lines are saved together.'
                : 'The header and the lines are saved together; the number is issued on the first save.'}
            </p>
          </div>
          <div className="row qe-actions">{actions}</div>
        </div>
        <ErrorBox error={error} />
        {attempted && problems.length > 0 && (
          <div className="alert error" role="alert">
            Not saved yet — {problems.join('; ')}.
          </div>
        )}
      </section>

      <div className={`prq-grid${direct && job ? '' : ' prq-grid-solo'}`}>
        <div className="prq-main">
          {/* ── Details ─────────────────────────────────────────────────────── */}
          <section className="card" aria-labelledby="poe-details">
            <h2 id="poe-details" className="card-title">Purchase order details</h2>
            <div className="qe-header qe-rows prq-rows">
              <Field label="Number">
                <div className="qe-static">{existing ? <span className="mono">{existing.number}</span> : <span className="muted">Given on save</span>}</div>
              </Field>
              <Field label="Order date">
                <div className="qe-static">{existing ? formatDate(existing.orderDate) : 'Today, on save'}</div>
              </Field>
              <Field
                label="Supplier"
                required
                error={attempted && !header.supplier ? 'Choose the supplier' : null}
                hint={
                  canvass
                    ? `Awarded on ${canvass.number} — raise a new canvass to change it`
                    : draft?.request?.preferredSupplier
                      ? `The requester would like ${draft.request.preferredSupplier} asked first`
                      : undefined
                }
              >
                <SupplierPicker
                  value={header.supplier}
                  onChange={(sup) => setHeader((h) => ({ ...h, supplier: sup }))}
                  onError={setError}
                  disabled={!!canvass}
                  autoFocus={!editing && !canvass}
                />
              </Field>
              <Field
                label="For"
                hint={
                  standalone
                    ? forMode === 'stock'
                      ? 'The goods go on the warehouse’s shelf when received — released later by a pull-out or Outgoing slip; nothing is charged to a project'
                      : forMode === 'project'
                        ? 'Charged to the project when received; each line names its budget line'
                        : 'Bought for the deal — its spend, never a project; the goods sit as the order’s own stock when received into a warehouse'
                    : undefined
                }
              >
                {standalone ? (
                  <div className="stack">
                    <select value={forMode} onChange={(e) => setForMode(e.target.value as typeof forMode)}>
                      <option value="stock">Warehouse stock</option>
                      <option value="project">A project</option>
                      <option value="order">An issued sales order</option>
                    </select>
                    {forMode === 'stock' && (
                      <select value={pickedWarehouseId} onChange={(e) => setPickedWarehouseId(e.target.value)}>
                        <option value="">— the warehouse named on the Incoming —</option>
                        {warehouseChoices.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {forMode === 'project' && (
                      <select value={pickedJobId} onChange={(e) => setPickedJobId(e.target.value)}>
                        <option value="">— choose the project —</option>
                        {jobChoices.map((j) => (
                          <option key={j.id} value={j.id}>
                            {j.number} — {j.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {forMode === 'order' && (
                      <select value={pickedOrderId} onChange={(e) => setPickedOrderId(e.target.value)}>
                        <option value="">— choose the sales order —</option>
                        {orderChoices.map((o) => (
                          <option key={o.id} value={o.id}>
                            Sales order {o.number} — {o.customer}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ) : (
                  <div className="qe-static">
                    {job ? (
                      <Link to={`/g-ops/projects/${job.id}`}>
                        {job.number} — {job.name}
                      </Link>
                    ) : salesOrder ? (
                      <Link to={`/g-ops/sales-orders/${salesOrder.id}`}>
                        Sales order {salesOrder.number} — {salesOrder.customer.name}
                      </Link>
                    ) : warehouse ? (
                      `Stock for ${warehouse.name}`
                    ) : kind === 'DIRECT_TO_JOB' ? (
                      <span className="muted">Direct to project — no project named</span>
                    ) : (
                      'Warehouse stock — the warehouse named on the Incoming'
                    )}
                  </div>
                )}
              </Field>
              <Field label="Delivery date">
                <input type="date" value={header.deliveryDate} onChange={(e) => setHeader((h) => ({ ...h, deliveryDate: e.target.value }))} />
              </Field>
              <Field
                label="Payment terms"
                hint={existing?.supplier.paymentTerms ? `Supplier default: ${existing.supplier.paymentTerms}` : undefined}
              >
                <input value={header.terms} maxLength={300} placeholder="e.g. 30 days" onChange={(e) => setHeader((h) => ({ ...h, terms: e.target.value }))} />
              </Field>
              <Field label="Quotation ref." hint="The supplier's quotation no. — printed on the order">
                <input value={header.quoteRef} maxLength={120} onChange={(e) => setHeader((h) => ({ ...h, quoteRef: e.target.value }))} />
              </Field>
              <Field label="Currency" hint="Printed under Order details — nothing is converted">
                <select value={header.currency} onChange={(e) => setHeader((h) => ({ ...h, currency: e.target.value }))}>
                  {PO_CURRENCIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="Deliver to" hint="Who receives it — the company by default">
                <input list="po-ship-name" value={header.deliverTo} maxLength={300} onChange={(e) => setHeader((h) => ({ ...h, deliverTo: e.target.value }))} />
                <datalist id="po-ship-name">{shipTo.name && <option value={shipTo.name} />}</datalist>
              </Field>
              <Field label="Delivery address" hint={warehouse ? `Blank prints the company's address` : 'Site address, or blank for the company\'s'}>
                <input list="po-ship-address" value={header.deliverAddress} maxLength={500} onChange={(e) => setHeader((h) => ({ ...h, deliverAddress: e.target.value }))} />
                <datalist id="po-ship-address">{shipTo.address && <option value={shipTo.address} />}</datalist>
              </Field>
              <Field label="VAT">
                {/* Wrapped, so the row's label rule does not take the tick box's own label for the field's. */}
                <div className="qe-static">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={header.applyVat}
                      onChange={(e) => setHeader((h) => ({ ...h, applyVat: e.target.checked, vatInclusive: e.target.checked && h.vatInclusive }))}
                    />
                    <span>Apply VAT (untick for an importation)</span>
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      disabled={!header.applyVat}
                      checked={header.vatInclusive}
                      onChange={(e) => setHeader((h) => ({ ...h, vatInclusive: e.target.checked }))}
                    />
                    <span>Supplier prices include VAT</span>
                  </label>
                </div>
              </Field>
            </div>
            <div className="qe-rows">
              <Field label="Notes" hint="Printed on the order">
                <textarea rows={2} value={header.notes} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} />
              </Field>
            </div>
            {request && (
              <p className="prq-hint">
                Lines from {request.number} come at {canvass ? `the price ${canvass.number} awarded` : 'its estimated prices'} — set each to
                the price actually agreed. Budget Monitoring keeps counting the request's declared value; the order's prices move no budget line.
              </p>
            )}
          </section>

          {/* ── Lines ───────────────────────────────────────────────────────── */}
          <section className="card" aria-labelledby="poe-lines">
            <div className="card-head">
              <h2 id="poe-lines" className="card-title">Lines</h2>
              <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>
                Import CSV
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/plain"
                className="visually-hidden"
                aria-hidden="true"
                tabIndex={-1}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void file.text().then((t) => importRows(t)).catch(setError);
                }}
              />
              <button type="button" className="btn btn-sm" onClick={() => setLines((ls) => [...ls.filter((l) => !isBlank(l)), blankLine(lastCategory())])}>
                + Add line
              </button>
            </div>

            <div className="table-wrap qe-table-wrap">
              <table className="data prq-lines">
                <colgroup>
                  <col className="prq-col-no" />
                  <col className="prq-col-cat" />
                  <col className="prq-col-part" />
                  <col />
                  <col className="prq-col-unit" />
                  <col className="prq-col-qty" />
                  <col className="prq-col-cost" />
                  <col className="prq-col-amount" />
                  <col className="prq-col-remove" />
                </colgroup>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Budget line</th>
                    <th>Part No.</th>
                    <th>Item and description</th>
                    <th>Unit</th>
                    <th className="right">Qty</th>
                    <th className="right">Unit price</th>
                    <th className="right">Amount</th>
                    <th aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const problem = attempted ? lineProblem(l) : null;
                    return (
                      <tr key={l.key}>
                        <td className="mono">
                          {i + 1}
                          {l.requestItemId && (
                            <span className="faint prq-from" title={`From ${request?.number ?? 'the request'}`}>
                              PR
                            </span>
                          )}
                        </td>
                        <td>
                          <select
                            aria-label={`Line ${i + 1} budget line`}
                            aria-invalid={problem === 'Choose its budget line' || undefined}
                            value={l.costCategoryId}
                            onChange={(e) => setLine(l.key, { costCategoryId: e.target.value })}
                          >
                            <option value="">{direct ? '— choose —' : '— none —'}</option>
                            {categories.map((c, n) => (
                              <option key={c.id} value={c.id}>
                                {n + 1} {c.name}
                              </option>
                            ))}
                          </select>
                          {/* Goods or a service (2026-10-21): a request line keeps the request's. */}
                          {kind !== 'STOCK_REPLENISHMENT' &&
                            (l.requestItemId ? (
                              <div className="prq-nature muted">{l.nature === 'SERVICE' ? 'Service' : 'Goods'}</div>
                            ) : (
                              <select
                                aria-label={`Line ${i + 1} goods or service`}
                                className="prq-nature"
                                value={l.nature}
                                onChange={(e) => {
                                  const nature = e.target.value as 'GOODS' | 'SERVICE';
                                  setLine(l.key, nature === 'SERVICE' ? { nature, itemId: null } : { nature });
                                }}
                              >
                                <option value="GOODS">Goods</option>
                                <option value="SERVICE">Service</option>
                              </select>
                            ))}
                        </td>
                        <td>
                          <input
                            aria-label={`Line ${i + 1} part number`}
                            value={l.partNumber}
                            maxLength={120}
                            placeholder="Part No."
                            onChange={(e) => setLine(l.key, { partNumber: e.target.value })}
                          />
                        </td>
                        <td>
                          <ItemCell
                            n={i + 1}
                            line={l}
                            jobId={job?.id ?? ''}
                            salesOrderId={salesOrder?.id ?? (standalone ? pickedOrderId : '')}
                            suggestPath="/purchase-orders/suggest"
                            invalid={problem === 'Say what is ordered'}
                            onChange={(patch) => setLine(l.key, patch)}
                            onPick={(sg) => fromSuggestion(l.key, sg)}
                            onPasteRows={(text) => importRows(text, l.key)}
                          />
                          {problem && <div className="field-error">{problem}</div>}
                        </td>
                        <td>
                          <input aria-label={`Line ${i + 1} unit`} value={l.unit} maxLength={40} onChange={(e) => setLine(l.key, { unit: e.target.value })} />
                        </td>
                        <td>
                          <NumberInput
                            kind="quantity"
                            aria-label={`Line ${i + 1} quantity`}
                            aria-invalid={problem === 'Quantity must be more than zero' || undefined}
                            value={l.quantity}
                            onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                          />
                        </td>
                        <td>
                          <NumberInput
                            kind="money"
                            aria-label={`Line ${i + 1} unit price`}
                            value={l.unitPrice}
                            min={0}
                            onChange={(e) => setLine(l.key, { unitPrice: e.target.value })}
                          />
                        </td>
                        <td className="right mono">{formatMoney(amountOf(l), header.currency)}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm btn-icon"
                            aria-label={`Remove line ${i + 1}`}
                            title="Remove"
                            onClick={() => removeLine(l.key)}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {skipped.length > 0 && (
              <div className="alert info prq-skipped">
                Skipped from the file: {skipped.join('; ')}.{' '}
                <button type="button" className="btn btn-sm" onClick={() => setSkipped([])}>
                  Dismiss
                </button>
              </div>
            )}
            <p className="prq-hint">
              Type in Item to search {job ? "this project's costing and " : ''}the item master. Paste rows from a spreadsheet
              into an empty Item box (Part No., Item, Description, Unit, Qty, Unit price) or Import CSV with those headings.
              Lines marked PR came from the purchase request.
            </p>
          </section>

          {/* ── Money ───────────────────────────────────────────────────────── */}
          <section className="card" aria-labelledby="poe-summary">
            <h2 id="poe-summary" className="card-title">Summary</h2>
            <dl className="prq-total">
              <dt>No. of lines</dt>
              <dd>{sent.length}</dd>
              <dt>Subtotal{header.vatInclusive ? ' (VAT included)' : ''}</dt>
              <dd className="mono">{formatMoney(money.subtotal, header.currency)}</dd>
              <dt>{header.applyVat ? `VAT (${Math.round(vatRate * 10000) / 100}%)` : 'VAT — not applied'}</dt>
              <dd className="mono">{formatMoney(money.vatAmount, header.currency)}</dd>
              <dt className="prq-total-big">Order total</dt>
              <dd className="prq-total-big mono">{formatMoney(money.total, header.currency)}</dd>
            </dl>
          </section>

          {/* ── Approval ────────────────────────────────────────────────────── */}
          <section className="card" aria-labelledby="poe-approval">
            <h2 id="poe-approval" className="card-title">Approval</h2>
            {route ? (
              allHeld(route) ? (
                <p className="muted">No one else's approval needed — you hold every step of the route.</p>
              ) : (
                <>
                  <p className="muted">Submit for approval sends it to:</p>
                  <ApprovalStepper steps={previewSteps(route)} />
                </>
              )
            ) : (
              <p className="muted">No approval route covers this order — Submit for approval will say what is missing.</p>
            )}
            <p className="prq-hint">
              Raised by {existing?.createdBy.name ?? 'you'}. The approvers come from the approval route (Admin › Approval
              Workflows), never picked on the form.
            </p>
          </section>

          <div className="row qe-foot">{actions}</div>
        </div>

        {/* ── Budget, as issuing would leave it ──────────────────────────────── */}
        {direct && job && (
          <aside className="card prq-budget" aria-labelledby="poe-budget">
            <div className="card-head">
              <h2 id="poe-budget" className="card-title">Budget — on issue</h2>
              <span className="muted prq-source">as you type</span>
            </div>
            {!budget ? (
              <Loading />
            ) : (
              <>
                <p className="prq-hint">
                  {onRequest
                    ? `Budget Monitoring counts ${request?.number ?? 'the request'}'s declared value, which stays committed until the goods arrive. The prices typed here are the supplier's figure and move no budget line.`
                    : 'Issuing the order commits these lines at the agreed price. Nothing moves until it is approved.'}
                </p>
                {budgetRows.length === 0 && <p className="muted">This project has no budget lines yet.</p>}
                {budgetRows.map((b) => {
                  const mine = ordering.get(b.id) ?? 0;
                  const held = declared[b.id] ?? 0;
                  const left = leftAfter(b);
                  const used = b.budgeted > 0 ? ((b.budgeted - left) / b.budgeted) * 100 : 100;
                  const n = categories.findIndex((c) => c.id === b.id) + 1;
                  return (
                    <div key={b.id} className="prq-bud">
                      <div className="prq-bud-top">
                        <span>
                          {n > 0 ? `${n} · ` : ''}
                          {b.name}
                        </span>
                        <strong className={left < 0 ? 'prq-over' : undefined}>{formatMoney(left)}</strong>
                      </div>
                      <Meter pct={used} tone={left < 0 ? 'danger' : used > 85 ? 'warn' : undefined} />
                      <div className="prq-bud-sub">
                        <span>
                          {onRequest
                            ? held
                              ? `request's declared value ${formatMoney(held)} committed${mine ? ` · this order ${formatMoney(mine)}` : ''}`
                              : mine
                                ? `this order ${formatMoney(mine)} — not counted`
                                : 'not touched'
                            : mine
                              ? `this order ${formatMoney(mine)}`
                              : 'not touched'}
                        </span>
                        <span>{left < 0 ? `over by ${formatMoney(-left)}` : onRequest ? 'left' : 'left after'}</span>
                      </div>
                    </div>
                  );
                })}
                <div className="prq-bud prq-bud-total">
                  <div className="prq-bud-top">
                    <strong>Project — overall left</strong>
                    <strong>{formatMoney(onRequest ? budget.total.available : Math.round((budget.total.available - money.subtotal) * 100) / 100)}</strong>
                  </div>
                </div>
                {over.length > 0 && (
                  <div className="alert error">
                    Issuing this order would go over what is left on {over.map((b) => b.name).join(', ')}. Agree a lower price,
                    or raise a budget request for the project.
                  </div>
                )}
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

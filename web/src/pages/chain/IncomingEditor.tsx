import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, formatDate, formatMoney, useToast } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';
import { SupplierPicker, type SupplierRef } from '../../components/SupplierPicker';
import { ApprovalStepper, allHeld, previewSteps, type PreviewRoute } from '../../components/ApprovalStepper';
import { useBackLink, useUnsavedChanges } from '../../components/Navigation';
import { todayLocal } from '../../lib/day';

/**
 * The Incoming Report as a PAGE (2026-10-14, the owner's call: "Incoming can
 * be linked to a purchase order or receive goods in the purchase order; have
 * an Incoming Report; add a button for incoming"). One page for New and
 * Modify: `/g-chain/incoming/new` (`?order=` with the order already chosen —
 * the purchase order page's "Receive goods") and `/g-chain/incoming/:id/edit`
 * on a draft.
 *
 * Against a purchase order: the order's lines with what is left to receive,
 * and what came in now. Without one ("possible receive without a purchase
 * order, approve it too"): where it came from, why there is no order, the
 * warehouse, and an item from the item master per line with the cost it is
 * taken into stock at. Either way it goes for approval — Back Support, then
 * the Purchasing Manager — and nothing moves until it is approved.
 */

interface Warehouse {
  id: string;
  code: string;
  name: string;
}
/** A product group — the item category goods go into inventory under (2026-10-20). */
interface Category {
  id: string;
  code: string;
  name: string;
}
interface OrderOption {
  id: string;
  number: string;
  status: string;
  orderDate: string;
  supplier: { name: string };
  job: { number: string; name: string } | null;
}
interface OrderLine {
  id: string;
  code: string | null;
  partNumber: string | null;
  name: string | null;
  description: string;
  unit: string;
  quantity: number;
  receivedQty: number;
  pendingQty: number;
  left: number;
  unitPrice: number;
  /** The item's product group; null where it has none. */
  category: Category | null;
  /** No item on file yet: received into a warehouse it is filed new, under the group the line names. */
  newItem: boolean;
}
interface OrderData {
  id: string;
  number: string;
  status: string;
  kind: string;
  receivable: boolean;
  supplier: { id: string; name: string };
  job: { id: string; number: string; name: string } | null;
  warehouse: { id: string; name: string } | null;
  /** An importation order (no VAT): the route goes to the Purchasing Manager (Importation). */
  importation?: boolean;
  lines: OrderLine[];
}
interface ItemOption {
  id: string;
  code: string;
  name: string;
  partNumber: string | null;
  unit: string;
  standardCost: number;
  category?: Category | null;
}
interface FreeLine {
  key: string;
  item: ItemOption | null;
  partNumber: string;
  description: string;
  unit: string;
  quantity: string;
  unitCost: string;
  categoryId: string;
}
interface Existing {
  id: string;
  number: string;
  status: string;
  updatedAt: string;
  canModify: boolean;
  orderId: string | null;
  supplierId: string | null;
  supplier: { id: string; name: string } | null;
  sourceName: string | null;
  reason: string | null;
  warehouseId: string | null;
  receivedDate: string;
  deliveryRefNo: string | null;
  invoiceRefNo: string | null;
  notes: string | null;
  items: {
    orderItemId: string | null;
    itemId: string | null;
    code: string | null;
    partNumber?: string | null;
    name: string | null;
    description: string;
    unit: string;
    quantity: number;
    unitCost: number;
    categoryId?: string | null;
    category?: Category | null;
  }[];
}

type Mode = 'order' | 'none';

let keySeq = 0;
const newKey = () => `l${++keySeq}`;
const blankFree = (): FreeLine => ({ key: newKey(), item: null, partNumber: '', description: '', unit: '', quantity: '', unitCost: '', categoryId: '' });
const cents = (n: number) => Math.round(n * 100) / 100;
const qtyText = (n: number) => new Intl.NumberFormat('en-PH', { maximumFractionDigits: 3 }).format(n);

export function IncomingEditor() {
  const { id } = useParams<{ id: string }>();
  const editing = !!id;
  const [params] = useSearchParams();
  const presetOrder = params.get('order');
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();

  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [existing, setExisting] = useState<Existing | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  /** The product group named on each order line (by order line id). */
  const [groups, setGroups] = useState<Record<string, string>>({});

  const [mode, setMode] = useState<Mode>('order');
  const [order, setOrder] = useState<OrderData | null>(null);
  const [receive, setReceive] = useState<Record<string, string>>({});
  const [free, setFree] = useState<FreeLine[]>([blankFree()]);
  const [fromSupplier, setFromSupplier] = useState(true);
  const [supplier, setSupplier] = useState<SupplierRef | null>(null);
  const [header, setHeader] = useState({
    sourceName: '',
    reason: '',
    warehouseId: '',
    receivedDate: todayLocal(),
    deliveryRefNo: '',
    invoiceRefNo: '',
    notes: '',
  });
  const [saved, setSaved] = useState<string | null>(null);
  const [route, setRoute] = useState<PreviewRoute | null>(null);

  async function loadOrder(orderId: string, except?: string) {
    const o = await api.get<OrderData>(`/receivings/order/${orderId}${qs({ except: except ?? '' })}`);
    setOrder(o);
    return o;
  }

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const opts = await api.get<{ warehouses: Warehouse[]; categories: Category[] }>('/receivings/options');
        if (!live) return;
        setWarehouses(opts.warehouses);
        setCategories(opts.categories ?? []);
        if (editing) {
          const r = await api.get<Existing>(`/receivings/${id}`);
          if (!live) return;
          setExisting(r);
          const h = {
            sourceName: r.sourceName ?? '',
            reason: r.reason ?? '',
            warehouseId: r.warehouseId ?? '',
            receivedDate: String(r.receivedDate).slice(0, 10),
            deliveryRefNo: r.deliveryRefNo ?? '',
            invoiceRefNo: r.invoiceRefNo ?? '',
            notes: r.notes ?? '',
          };
          setHeader(h);
          if (r.orderId) {
            setMode('order');
            await loadOrder(r.orderId, r.id);
            const q: Record<string, string> = {};
            const g: Record<string, string> = {};
            for (const i of r.items) {
              if (!i.orderItemId) continue;
              q[i.orderItemId] = String(i.quantity);
              if (i.categoryId) g[i.orderItemId] = i.categoryId;
            }
            setReceive(q);
            setGroups(g);
            setSaved(JSON.stringify({ mode: 'order', h, q, g }));
          } else {
            setMode('none');
            setFromSupplier(!!r.supplier);
            setSupplier(r.supplier ? { id: r.supplier.id, name: r.supplier.name } : null);
            const ls = r.items.map((i) => ({
              key: newKey(),
              item: i.itemId
                ? { id: i.itemId, code: i.code ?? '', name: i.name ?? i.description, partNumber: null, unit: i.unit, standardCost: 0, category: i.category ?? null }
                : null,
              partNumber: i.partNumber ?? '',
              description: i.description,
              unit: i.unit,
              quantity: String(i.quantity),
              unitCost: String(i.unitCost),
              categoryId: i.categoryId ?? i.category?.id ?? '',
            }));
            setFree(ls.length ? ls : [blankFree()]);
            setSaved(JSON.stringify({ mode: 'none', h, ls: ls.map(({ key: _k, ...rest }) => rest) }));
          }
        } else if (presetOrder) {
          const o = await loadOrder(presetOrder);
          if (!live) return;
          setHeader((h) => ({ ...h, warehouseId: o.warehouse?.id ?? '' }));
          setSaved('');
        } else {
          setSaved('');
        }
      } catch (err) {
        if (live) setError(err);
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, presetOrder]);

  // ── Figures ────────────────────────────────────────────────────────────────

  const orderLinesSent = (order?.lines ?? []).filter((l) => Number(receive[l.id]) > 0);
  const freeSent = free.filter((l) => l.item || l.quantity || l.description);
  const value = useMemo(() => {
    if (mode === 'order') return cents(orderLinesSent.reduce((s, l) => s + Number(receive[l.id]) * l.unitPrice, 0));
    return cents(freeSent.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitCost) || 0), 0));
  }, [mode, orderLinesSent, receive, freeSent]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api
        .get<{ route: PreviewRoute | null }>(`/receivings/route${qs({ amount: String(value), importation: mode === 'order' && order?.importation ? '1' : '' })}`)
        .then((r) => setRoute(r.route))
        .catch(() => setRoute(null));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [value, mode, order?.importation]);

  const snapshot = () =>
    mode === 'order'
      ? JSON.stringify({ mode, h: header, q: receive, g: groups })
      : JSON.stringify({ mode, h: header, ls: free.map(({ key: _k, ...rest }) => rest) });
  const dirty = saved !== null && (saved === '' ? orderLinesSent.length > 0 || freeSent.length > 0 : snapshot() !== saved);
  useUnsavedChanges(dirty && !busy);
  useBackLink(existing ? `/g-chain/incoming/${existing.id}` : null, existing ? existing.number : null);

  // ── Checking and saving ────────────────────────────────────────────────────

  const problems: string[] = [];
  if (mode === 'order') {
    if (!order) problems.push('Choose the purchase order');
    else if (!orderLinesSent.length) problems.push('Type what came in on at least one line');
    for (const l of orderLinesSent) {
      if (Number(receive[l.id]) > l.left + 0.0005) problems.push(`${l.name ?? l.description}: only ${qtyText(l.left)} left to receive`);
      else if (l.newItem && header.warehouseId && !groups[l.id]) problems.push(`${l.name ?? l.description}: choose its product group — it is a new item`);
    }
  } else {
    if (fromSupplier ? !supplier : !header.sourceName.trim()) problems.push('Say where the goods came from');
    if (!header.reason.trim()) problems.push('Say why there is no purchase order');
    if (!header.warehouseId) problems.push('Choose the warehouse');
    if (!freeSent.length) problems.push('Add at least one line');
    freeSent.forEach((l, n) => {
      if (!l.item && !l.partNumber.trim() && !l.description.trim()) problems.push(`Line ${n + 1}: choose the item, or type its part number or description`);
      else if (!(Number(l.quantity) > 0)) problems.push(`Line ${n + 1}: quantity must be more than zero`);
      else if (l.unitCost === '') problems.push(`Line ${n + 1}: type the unit cost (0 for a free item)`);
      else if (!l.item && !l.categoryId) problems.push(`Line ${n + 1}: choose its product group — a new item goes into inventory under one`);
    });
  }

  function body() {
    const common = {
      warehouseId: header.warehouseId || null,
      receivedDate: header.receivedDate || null,
      deliveryRefNo: header.deliveryRefNo.trim() || null,
      invoiceRefNo: header.invoiceRefNo.trim() || null,
      notes: header.notes.trim() || null,
      ...(existing ? { version: existing.updatedAt } : {}),
    };
    if (mode === 'order') {
      return {
        ...common,
        orderId: order!.id,
        items: orderLinesSent.map((l) => ({ orderItemId: l.id, quantity: Number(receive[l.id]), categoryId: groups[l.id] || null })),
      };
    }
    return {
      ...common,
      orderId: null,
      supplierId: fromSupplier ? (supplier?.id ?? null) : null,
      sourceName: fromSupplier ? null : header.sourceName.trim(),
      reason: header.reason.trim(),
      items: freeSent.map((l) => ({
        itemId: l.item?.id ?? null,
        partNumber: l.partNumber.trim() || null,
        description: l.description.trim() || null,
        unit: l.unit.trim() || null,
        quantity: Number(l.quantity),
        unitCost: Number(l.unitCost) || 0,
        categoryId: l.categoryId || null,
      })),
    };
  }

  async function save(submit: boolean) {
    setAttempted(true);
    if (problems.length) return;
    setBusy(true);
    setError(null);
    try {
      const savedId = existing
        ? (await api.put<{ id: string }>(`/receivings/${existing.id}/sheet`, body())).id
        : (await api.post<{ id: string; needsApproval: boolean }>('/receivings', body())).id;
      setSaved(snapshot());
      if (submit) {
        try {
          await api.post(`/receivings/${savedId}/submit`);
          toast('ok', 'Saved and submitted for approval');
        } catch (err) {
          toast('error', `Saved as a draft — not submitted: ${err instanceof Error ? err.message : 'refused'}`);
        }
      } else toast('ok', existing ? `${existing.number} saved` : 'Incoming report saved — attach the packing list, then submit it');
      navigate(`/g-chain/incoming/${savedId}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  if (!loaded) return error ? <ErrorBox error={error} /> : <Loading />;
  if (editing && !existing) return <ErrorBox error={error ?? new Error('Incoming report not found')} />;
  if (existing && !existing.canModify) {
    return (
      <div className="card">
        <p className="muted">
          {existing.status !== 'DRAFT'
            ? `${existing.number} is ${existing.status.toLowerCase().replace(/_/g, ' ')} — only a draft is modified.`
            : 'Only the person who received it, or the warehouse lead, can change it.'}
        </p>
      </div>
    );
  }

  const actions = (
    <>
      <button type="button" className="btn" onClick={() => void save(false)} disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {can('gchain.receiving.create') && (
        <button type="button" className="btn btn-primary" onClick={() => void save(true)} disabled={busy}>
          Submit for approval
        </button>
      )}
    </>
  );
  const switchMode = (m: Mode) => {
    setMode(m);
    setAttempted(false);
  };

  return (
    <div className="prq">
      <section className="card qe-card prq-head-card" aria-labelledby="inc-heading">
        <div className="qe-head">
          <div>
            <h1 id="inc-heading" className="qe-heading">
              {existing ? `Modify incoming report ${existing.number}` : 'New incoming report'}
            </h1>
            <p className="muted qe-lead">
              {existing
                ? 'Change what you need and Save — the header and the lines are saved together.'
                : 'Saved as a draft; nothing moves until it is approved. The number is issued on the first save.'}
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

      <div className="prq-grid prq-grid-solo">
        <div className="prq-main">
          <section className="card" aria-labelledby="inc-details">
            <h2 id="inc-details" className="card-title">Incoming details</h2>
            {!existing && (
              <div className="scope-switch inc-mode" role="radiogroup" aria-label="Received against">
                <button type="button" role="radio" aria-checked={mode === 'order'} className={mode === 'order' ? 'active' : ''} onClick={() => switchMode('order')}>
                  Against a purchase order
                </button>
                <button type="button" role="radio" aria-checked={mode === 'none'} className={mode === 'none' ? 'active' : ''} onClick={() => switchMode('none')}>
                  Without a purchase order
                </button>
              </div>
            )}
            <div className="qe-header qe-rows prq-rows">
              <Field label="Number">
                <div className="qe-static">{existing ? <span className="mono">{existing.number}</span> : <span className="muted">Given on save</span>}</div>
              </Field>
              <Field label="Received date">
                <input type="date" value={header.receivedDate} onChange={(e) => setHeader((h) => ({ ...h, receivedDate: e.target.value }))} />
              </Field>

              {mode === 'order' ? (
                <>
                  <Field label="Purchase order" required error={attempted && !order ? 'Choose the purchase order' : null}>
                    {order ? (
                      <div className="qe-static row">
                        <Link to={`/g-chain/purchase-orders/${order.id}`} className="mono">
                          {order.number}
                        </Link>{' '}
                        <span>— {order.supplier.name}</span>
                        {!existing && (
                          <>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                setOrder(null);
                                setReceive({});
                              }}
                            >
                              Change
                            </button>
                          </>
                        )}
                      </div>
                    ) : (
                      <OrderLookup
                        onPick={(o) => {
                          void loadOrder(o.id)
                            .then((d) => {
                              setReceive({});
                              setHeader((h) => ({ ...h, warehouseId: h.warehouseId || d.warehouse?.id || '' }));
                            })
                            .catch(setError);
                        }}
                      />
                    )}
                  </Field>
                  <Field label="For">
                    <div className="qe-static">
                      {order?.job ? (
                        <Link to={`/g-ops/projects/${order.job.id}`}>
                          {order.job.number} — {order.job.name}
                        </Link>
                      ) : order ? (
                        'Stock'
                      ) : (
                        <span className="muted">From the order</span>
                      )}
                    </div>
                  </Field>
                </>
              ) : (
                <>
                  <Field
                    label="Received from"
                    required
                    hint={fromSupplier ? 'A supplier on file' : 'A customer, a site, another company'}
                    error={attempted && (fromSupplier ? !supplier : !header.sourceName.trim()) ? 'Say where the goods came from' : null}
                  >
                    {fromSupplier ? (
                      <SupplierPicker value={supplier} onChange={setSupplier} onError={setError} />
                    ) : (
                      <input value={header.sourceName} maxLength={200} onChange={(e) => setHeader((h) => ({ ...h, sourceName: e.target.value }))} />
                    )}
                  </Field>
                  <Field label=" ">
                    <div className="qe-static">
                      <label className="checkbox">
                        <input type="checkbox" checked={!fromSupplier} onChange={(e) => setFromSupplier(!e.target.checked)} />
                        <span>Not a supplier on file</span>
                      </label>
                    </div>
                  </Field>
                </>
              )}

              <Field
                label="Into warehouse"
                required={mode === 'none'}
                hint={mode === 'order' ? 'Leave blank if it went straight to site' : 'Goods without an order go into stock'}
                error={attempted && mode === 'none' && !header.warehouseId ? 'Choose the warehouse' : null}
              >
                <select value={header.warehouseId} onChange={(e) => setHeader((h) => ({ ...h, warehouseId: e.target.value }))}>
                  <option value="">{mode === 'order' ? '— straight to site —' : '— choose —'}</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Delivery receipt no.">
                <input value={header.deliveryRefNo} maxLength={120} onChange={(e) => setHeader((h) => ({ ...h, deliveryRefNo: e.target.value }))} />
              </Field>
              <Field label="Invoice no.">
                <input value={header.invoiceRefNo} maxLength={120} onChange={(e) => setHeader((h) => ({ ...h, invoiceRefNo: e.target.value }))} />
              </Field>
            </div>
            <div className="qe-rows">
              {mode === 'none' && (
                <Field label="Why no purchase order" required error={attempted && !header.reason.trim() ? 'Say why there is no purchase order' : null}>
                  <textarea
                    rows={2}
                    value={header.reason}
                    placeholder="e.g. returned from site, free replacement, supplied by the customer"
                    onChange={(e) => setHeader((h) => ({ ...h, reason: e.target.value }))}
                  />
                </Field>
              )}
              <Field label="Notes" hint="Printed on the report">
                <textarea rows={2} value={header.notes} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} />
              </Field>
            </div>
          </section>

          <section className="card" aria-labelledby="inc-lines">
            <div className="card-head">
              <h2 id="inc-lines" className="card-title">
                {mode === 'order' ? 'What came in' : 'Lines'}
              </h2>
              {mode === 'order' && order && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setReceive(Object.fromEntries(order.lines.filter((l) => l.left > 0).map((l) => [l.id, String(l.left)])))}
                >
                  Receive all that is left
                </button>
              )}
              {mode === 'none' && (
                <button type="button" className="btn btn-sm" onClick={() => setFree((ls) => [...ls, blankFree()])}>
                  + Add line
                </button>
              )}
            </div>
            {mode === 'order' ? (
              !order ? (
                <p className="muted">Choose the purchase order — its lines show here with what is left to receive.</p>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Item</th>
                        <th>Product group</th>
                        <th>Unit</th>
                        <th className="right">Ordered</th>
                        <th className="right">Received</th>
                        <th className="right">Left</th>
                        <th className="right">Receive now</th>
                        <th className="right">Unit price</th>
                        <th className="right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {order.lines.map((l, n) => {
                        const now = Number(receive[l.id]) || 0;
                        return (
                          <tr key={l.id}>
                            <td>{n + 1}</td>
                            <td>
                              <div>
                                <strong>{l.name ?? l.description}</strong>
                              </div>
                              {l.name && l.description !== l.name && <div className="faint">{l.description}</div>}
                              {(l.code ?? l.partNumber) && <div className="faint mono">{l.code ?? l.partNumber}</div>}
                            </td>
                            <td>
                              {l.category ? (
                                l.category.name
                              ) : (
                                <GroupSelect
                                  label={`Product group — ${l.name ?? l.description}`}
                                  categories={categories}
                                  value={groups[l.id] ?? ''}
                                  required={l.newItem && !!header.warehouseId}
                                  onChange={(v) => setGroups((g) => ({ ...g, [l.id]: v }))}
                                />
                              )}
                            </td>
                            <td>{l.unit}</td>
                            <td className="right mono">{qtyText(l.quantity)}</td>
                            <td className="right mono">
                              {qtyText(l.receivedQty)}
                              {l.pendingQty > 0 && <div className="faint">+{qtyText(l.pendingQty)} pending</div>}
                            </td>
                            <td className="right mono">{qtyText(l.left)}</td>
                            <td className="right">
                              <NumberInput
                                kind="quantity"
                                aria-label={`Receive now — ${l.name ?? l.description}`}
                                value={receive[l.id] ?? ''}
                                min={0}
                                max={l.left}
                                disabled={l.left <= 0}
                                onChange={(e) => setReceive((q) => ({ ...q, [l.id]: e.target.value }))}
                              />
                            </td>
                            <td className="right mono">{formatMoney(l.unitPrice)}</td>
                            <td className="right mono">{formatMoney(cents(now * l.unitPrice))}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Item</th>
                      <th>Part No.</th>
                      <th>Description</th>
                      <th>Product group</th>
                      <th>Unit</th>
                      <th className="right">Qty</th>
                      <th className="right">Unit cost</th>
                      <th className="right">Amount</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {free.map((l, n) => (
                      <tr key={l.key}>
                        <td>{n + 1}</td>
                        <td className="inc-item-cell">
                          <ItemLookup
                            value={l.item}
                            onPick={(item) =>
                              setFree((ls) =>
                                ls.map((x) =>
                                  x.key === l.key
                                    ? {
                                        ...x,
                                        item,
                                        partNumber: x.partNumber || item?.partNumber || '',
                                        description: x.description || item?.name || '',
                                        unit: x.unit || item?.unit || '',
                                        unitCost: x.unitCost || (item ? String(item.standardCost) : ''),
                                        categoryId: x.categoryId || item?.category?.id || '',
                                      }
                                    : x,
                                ),
                              )
                            }
                            onTyped={(text) =>
                              setFree((ls) => ls.map((x) => (x.key === l.key && !x.item && !x.description.trim() ? { ...x, description: text } : x)))
                            }
                          />
                        </td>
                        <td className="inc-unit-cell">
                          <input
                            aria-label={`Part No. — line ${n + 1}`}
                            value={l.partNumber}
                            onChange={(e) => setFree((ls) => ls.map((x) => (x.key === l.key ? { ...x, partNumber: e.target.value } : x)))}
                          />
                        </td>
                        <td>
                          <input
                            aria-label={`Description — line ${n + 1}`}
                            value={l.description}
                            onChange={(e) => setFree((ls) => ls.map((x) => (x.key === l.key ? { ...x, description: e.target.value } : x)))}
                          />
                        </td>
                        <td>
                          {l.item?.category ? (
                            l.item.category.name
                          ) : (
                            <GroupSelect
                              label={`Product group — line ${n + 1}`}
                              categories={categories}
                              value={l.categoryId}
                              required={!l.item}
                              onChange={(v) => setFree((ls) => ls.map((x) => (x.key === l.key ? { ...x, categoryId: v } : x)))}
                            />
                          )}
                        </td>
                        <td className="inc-unit-cell">
                          <input
                            aria-label={`Unit — line ${n + 1}`}
                            value={l.unit}
                            onChange={(e) => setFree((ls) => ls.map((x) => (x.key === l.key ? { ...x, unit: e.target.value } : x)))}
                          />
                        </td>
                        <td className="right inc-num-cell">
                          <NumberInput
                            kind="quantity"
                            aria-label={`Quantity — line ${n + 1}`}
                            value={l.quantity}
                            min={0}
                            onChange={(e) => setFree((ls) => ls.map((x) => (x.key === l.key ? { ...x, quantity: e.target.value } : x)))}
                          />
                        </td>
                        <td className="right inc-num-cell">
                          <NumberInput
                            kind="money"
                            aria-label={`Unit cost — line ${n + 1}`}
                            value={l.unitCost}
                            min={0}
                            onChange={(e) => setFree((ls) => ls.map((x) => (x.key === l.key ? { ...x, unitCost: e.target.value } : x)))}
                          />
                        </td>
                        <td className="right mono">{formatMoney(cents((Number(l.quantity) || 0) * (Number(l.unitCost) || 0)))}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm btn-icon"
                            aria-label={`Remove line ${n + 1}`}
                            onClick={() =>
                              setFree((ls) => {
                                const rest = ls.filter((x) => x.key !== l.key);
                                return rest.length ? rest : [blankFree()];
                              })
                            }
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="prq-hint">
              {mode === 'order'
                ? 'Received at the order’s price. A line cannot take more than is left on the order — other reports waiting for approval are counted.'
                : 'Stock is kept by item: choose each line’s item from the item master. The unit cost is what it is taken into stock at — 0 for a free item. No project or supplier is charged.'}
            </p>
          </section>

          <section className="card" aria-labelledby="inc-summary">
            <h2 id="inc-summary" className="card-title">Summary</h2>
            <dl className="prq-total">
              <dt>No. of lines</dt>
              <dd>{mode === 'order' ? orderLinesSent.length : freeSent.length}</dd>
              <dt className="prq-total-big">Value received</dt>
              <dd className="prq-total-big mono">{formatMoney(value)}</dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="inc-approval">
            <h2 id="inc-approval" className="card-title">Approval</h2>
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
              <p className="muted">No approval route covers incoming reports — saving it receives the goods at once.</p>
            )}
            <p className="prq-hint">
              {existing ? `Received ${formatDate(existing.receivedDate)}. ` : ''}Attach the packing list and delivery receipt on the report's page
              after saving.
            </p>
          </section>

          <div className="row qe-foot">{actions}</div>
        </div>
      </div>
    </div>
  );
}

/** An issued order still to receive — searched by number, supplier or project. */
function OrderLookup({ onPick }: { onPick: (o: OrderOption) => void }) {
  const [term, setTerm] = useState('');
  const [rows, setRows] = useState<OrderOption[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      api
        .get<{ orders: OrderOption[] }>(`/receivings/options${qs({ q: term })}`)
        .then((r) => live && setRows(r.orders))
        .catch(() => live && setRows([]));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [term]);
  return (
    <div className="lookup" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}>
      <input
        value={term}
        autoComplete="off"
        placeholder="Search order number, supplier or project"
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
      />
      {open && rows && (
        <ul className="lookup-menu">
          {rows.map((o) => (
            <li key={o.id}>
              <button type="button" onClick={() => onPick(o)}>
                <span className="mono">{o.number}</span> — {o.supplier.name}
                <span className="muted">
                  {' '}
                  · {o.job ? o.job.number : 'Stock'} · {formatDate(o.orderDate)}
                </span>
              </button>
            </li>
          ))}
          {!rows.length && <li className="lookup-none">No issued order still to receive matches “{term}”.</li>}
        </ul>
      )}
    </div>
  );
}

/** An item from the item master, for a line received without an order. */
function ItemLookup({
  value,
  onPick,
  onTyped,
}: {
  value: ItemOption | null;
  onPick: (item: ItemOption | null) => void;
  /** What was typed and not picked, when the box is left — a new item's description. */
  onTyped?: (text: string) => void;
}) {
  const [term, setTerm] = useState(value ? `${value.code} — ${value.name}` : '');
  const [rows, setRows] = useState<ItemOption[] | null>(null);
  const [open, setOpen] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!open) return;
    let live = true;
    const t = window.setTimeout(() => {
      api
        .get<ItemOption[]>(`/receivings/items${qs({ q: term })}`)
        .then((r) => live && setRows(r))
        .catch(() => live && setRows([]));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [term, open]);
  return (
    <div
      className="lookup"
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setOpen(false);
        if (!value && term.trim()) onTyped?.(term.trim());
      }}
    >
      <input
        value={term}
        autoComplete="off"
        placeholder="Search item code or name"
        aria-label="Item"
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
          if (value) onPick(null);
        }}
      />
      {open && rows && (
        <ul className="lookup-menu">
          {rows.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(i);
                  setTerm(`${i.code} — ${i.name}`);
                  setOpen(false);
                }}
              >
                <span className="mono">{i.code}</span> — {i.name}
                {i.partNumber && <span className="muted"> · {i.partNumber}</span>}
              </button>
            </li>
          ))}
          {!rows.length && <li className="lookup-none">No item matches “{term}” — it is added to the item master when you save (type its part number and description).</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * The product group a line goes into inventory under (2026-10-20, the owner's
 * call): required where the line files a new item; on an item with none it
 * fills that item's.
 */
function GroupSelect({
  label,
  categories,
  value,
  required,
  onChange,
}: {
  label: string;
  categories: Category[];
  value: string;
  required: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <select aria-label={label} value={value} required={required} onChange={(e) => onChange(e.target.value)}>
      <option value="">{required ? '— choose —' : '— none —'}</option>
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.code} — {c.name}
        </option>
      ))}
    </select>
  );
}

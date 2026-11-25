import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { DataList, type Column, type FilterDef } from '../../components/DataList';
import { Stat } from '../../components/charts';
import { formatDateTime, formatMoney } from '../../components/ui';
import { label } from './PurchaseRequests';
import { FromTo } from './StockCardHistory';

/**
 * G-CHAIN › Warehouse › Stock Movements (2026-11-25, the owner's call: the
 * log left the foot of Inventory for a menu of its own, with filters by item,
 * date and the rest, and columns each person picks). Read only. Two views,
 * never mixed: the movements made in G-CORE, and the history brought across
 * from Odoo (`?view=odoo`).
 */

interface ItemRef {
  id: string;
  code: string;
  name: string;
  unit: string;
  partNumber: string | null;
  brand: string | null;
  productGroup: string | null;
}

interface MovementRow {
  id: string;
  occurredAt: string;
  type: string;
  item: ItemRef;
  quantity: number;
  balanceBefore: number;
  balanceAfter: number;
  unitCost: number;
  value: number;
  sourceNumber: string | null;
  document: string;
  link: string | null;
  from: string | null;
  to: string | null;
  warehouse: { id: string; name: string };
  owner: { kind: 'project' | 'order' | 'quotation'; number: string } | null;
  createdBy: { id: string; name: string } | null;
  notes: string | null;
}

interface OdooRow {
  id: string;
  occurredAt: string;
  item: ItemRef;
  kind: string;
  kindLabel: string;
  direction: number;
  reference: string;
  from: string;
  to: string;
  contact: string | null;
  quantity: number;
  unit: string | null;
  by: string | null;
}

interface Options {
  people: { id: string; name: string; movements: number }[];
  warehouses: { id: string; name: string }[];
  brands: string[];
  groups: string[];
  odooMoves: number;
}

const qty = (n: number) => n.toLocaleString('en-PH', { maximumFractionDigits: 3 });
const dash = <span className="faint">—</span>;

function ItemCell({ item }: { item: ItemRef }) {
  return (
    <>
      <Link to={`/g-chain/inventory/${item.id}`}>{item.name}</Link> <span className="faint mono">({item.code})</span>
    </>
  );
}

const OWNER_WORDS = { project: 'Project', order: 'Sales order', quotation: 'Quotation' } as const;

const itemColumns = <T extends { item: ItemRef }>(): Column<T>[] => [
  { key: 'partNumber', label: 'Part number', optional: true, render: (r) => (r.item.partNumber ? <span className="mono">{r.item.partNumber}</span> : dash) },
  { key: 'brand', label: 'Brand', optional: true, render: (r) => r.item.brand ?? dash },
  { key: 'group', label: 'Product group', optional: true, render: (r) => r.item.productGroup ?? dash },
];

const MOVEMENT_COLUMNS: Column<MovementRow>[] = [
  { key: 'when', label: 'When', sortKey: 'occurredAt', render: (r) => <span className="muted nowrap">{formatDateTime(r.occurredAt)}</span> },
  { key: 'item', label: 'Item', render: (r) => <ItemCell item={r.item} /> },
  ...itemColumns<MovementRow>(),
  { key: 'type', label: 'Type', render: (r) => <span className={`badge ${r.quantity > 0 ? 'ok' : r.type === 'BORROW' ? 'warn' : ''}`}>{label(r.type)}</span> },
  {
    key: 'document',
    label: 'Document',
    render: (r) =>
      r.link ? (
        <Link to={r.link} className="mono">
          {r.sourceNumber ?? r.document}
        </Link>
      ) : (
        <span className="mono faint">{r.sourceNumber ?? r.document}</span>
      ),
  },
  { key: 'fromTo', label: 'From → to', render: (r) => <FromTo from={r.from} to={r.to} /> },
  {
    key: 'quantity',
    label: 'In / out',
    align: 'right',
    render: (r) => (
      <span className={`mono nowrap ${r.quantity > 0 ? 'proc-best' : 'proc-over'}`}>
        {r.quantity > 0 ? '+' : ''}
        {qty(r.quantity)} {r.item.unit}
      </span>
    ),
  },
  { key: 'before', label: 'Before', align: 'right', render: (r) => <span className="mono">{qty(r.balanceBefore)}</span> },
  { key: 'after', label: 'After', align: 'right', render: (r) => <span className="mono">{qty(r.balanceAfter)}</span> },
  { key: 'unitCost', label: 'Unit cost', align: 'right', optional: true, render: (r) => <span className="mono">{formatMoney(r.unitCost)}</span> },
  { key: 'value', label: 'Value', align: 'right', optional: true, render: (r) => <span className="mono">{formatMoney(r.value)}</span> },
  { key: 'warehouse', label: 'Warehouse', optional: true, render: (r) => r.warehouse.name },
  { key: 'owner', label: 'Whose stock', optional: true, render: (r) => (r.owner ? `${OWNER_WORDS[r.owner.kind]} ${r.owner.number}` : 'Company') },
  { key: 'by', label: 'By', render: (r) => r.createdBy?.name ?? dash },
  { key: 'notes', label: 'Notes', optional: true, render: (r) => r.notes ?? dash },
];

const ODOO_COLUMNS: Column<OdooRow>[] = [
  { key: 'when', label: 'When', sortKey: 'occurredAt', render: (r) => <span className="muted nowrap">{formatDateTime(r.occurredAt)}</span> },
  { key: 'item', label: 'Item', render: (r) => <ItemCell item={r.item} /> },
  ...itemColumns<OdooRow>(),
  { key: 'type', label: 'Type', render: (r) => <span className={`badge ${r.direction > 0 ? 'ok' : ''}`}>{r.kindLabel}</span> },
  { key: 'reference', label: 'Reference', render: (r) => <span className="mono">{r.reference}</span> },
  { key: 'fromTo', label: 'From → to', render: (r) => <FromTo from={r.from} to={r.to} /> },
  { key: 'contact', label: 'Customer / supplier', render: (r) => r.contact ?? dash },
  {
    key: 'quantity',
    label: 'Quantity',
    align: 'right',
    render: (r) => (
      <span className={`mono nowrap ${r.direction > 0 ? 'proc-best' : r.direction < 0 ? 'proc-over' : ''}`}>
        {r.direction > 0 ? '+' : r.direction < 0 ? '−' : ''}
        {qty(r.quantity)} {r.unit ?? r.item.unit}
      </span>
    ),
  },
  { key: 'by', label: 'By', render: (r) => r.by ?? dash },
];

const DIRECTION: FilterDef = {
  key: 'direction',
  label: 'In or out',
  options: [
    { value: 'in', label: 'In' },
    { value: 'out', label: 'Out' },
  ],
};

export function StockMovements() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'odoo' ? 'odoo' : 'gcore';
  const [options, setOptions] = useState<Options | null>(null);
  useEffect(() => {
    api.get<Options>('/stock-movements/options').then(setOptions).catch(() => setOptions(null));
  }, []);

  /** The other view starts clean: its filters are its own. */
  function choose(next: 'gcore' | 'odoo') {
    if (next === view) return;
    setParams(next === 'odoo' ? { view: 'odoo' } : {}, { replace: true });
  }

  const shared: FilterDef[] = useMemo(
    () => [
      {
        key: 'itemId',
        label: 'Item',
        type: 'lookup',
        placeholder: 'Type a name, code or part number',
        search: (term) => api.get<{ value: string; label: string }[]>(`/stock-movements/items${qs({ q: term })}`),
        describe: async (value) => (await api.get<{ value: string; label: string }[]>(`/stock-movements/items${qs({ id: value })}`))[0]?.label ?? null,
      },
      { key: 'from', toKey: 'to', label: 'Date', type: 'dateRange' },
      DIRECTION,
      {
        key: 'group',
        label: 'Product group',
        options: [...(options?.groups ?? []).map((g) => ({ value: g, label: g })), { value: 'none', label: 'No product group' }],
      },
      { key: 'brand', label: 'Brand', options: [...(options?.brands ?? []).map((b) => ({ value: b, label: b })), { value: 'none', label: 'No brand' }] },
    ],
    [options],
  );

  const gcoreFilters: FilterDef[] = useMemo(
    () => [
      ...shared.slice(0, 3),
      {
        key: 'type',
        label: 'Type',
        options: ['RECEIPT', 'ISSUE', 'BORROW', 'RETURN', 'ADJUSTMENT'].map((t) => ({ value: t, label: label(t) })),
      },
      {
        key: 'document',
        label: 'Document',
        options: [
          { value: 'receiving', label: 'Incoming' },
          { value: 'stock_issue', label: 'Outgoing' },
          { value: 'pullout_slip', label: 'Pull-out slip' },
          { value: 'borrow_slip', label: 'Borrow slip' },
          { value: 'odoo_opening', label: 'Opening balance from Odoo' },
          { value: 'other', label: 'Anything else' },
        ],
      },
      { key: 'warehouseId', label: 'Warehouse', options: (options?.warehouses ?? []).map((w) => ({ value: w.id, label: w.name })) },
      {
        key: 'userId',
        label: 'Moved by',
        options: [...(options?.people ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.movements})` })), { value: 'none', label: 'No person on record' }],
      },
      ...shared.slice(3),
      {
        key: 'stock',
        label: 'Whose stock',
        options: [
          { value: 'company', label: 'The company’s' },
          { value: 'project', label: 'A project’s own' },
          { value: 'order', label: 'A sales order’s own' },
          { value: 'quotation', label: 'Held for a quotation' },
        ],
      },
    ],
    [shared, options],
  );

  const odooFilters: FilterDef[] = useMemo(
    () => [
      ...shared.slice(0, 3),
      {
        key: 'kind',
        label: 'Type',
        options: [
          { value: 'RECEIPT', label: 'Receipt' },
          { value: 'DELIVERY', label: 'Delivery' },
          { value: 'RETURN_IN', label: 'Customer return' },
          { value: 'RETURN_OUT', label: 'Return to supplier' },
          { value: 'ADJUSTMENT', label: 'Adjustment' },
          { value: 'TRANSFER', label: 'Transfer' },
          { value: 'OTHER', label: 'Other' },
        ],
      },
      ...shared.slice(3),
    ],
    [shared],
  );

  const switcher = (
    <div className="scope-switch" role="group" aria-label="Which movements">
      <button type="button" className={view === 'gcore' ? 'active' : ''} aria-pressed={view === 'gcore'} onClick={() => choose('gcore')}>
        G-CORE
      </button>
      <button type="button" className={view === 'odoo' ? 'active' : ''} aria-pressed={view === 'odoo'} onClick={() => choose('odoo')}>
        Odoo history
      </button>
    </div>
  );

  const cards = (noun: string) => (raw: unknown, total: number) => {
    const sum = raw as { items?: number; in?: number; out?: number };
    return (
      <>
        <Stat label={noun} value={total.toLocaleString('en-PH')} />
        <Stat label="Items moved" value={(sum.items ?? 0).toLocaleString('en-PH')} />
        <Stat label="Movements in" value={(sum.in ?? 0).toLocaleString('en-PH')} accent="quiet" />
        <Stat label="Movements out" value={(sum.out ?? 0).toLocaleString('en-PH')} accent="quiet" />
      </>
    );
  };

  return (
    <div>
      <h1 className="visually-hidden">Stock Movements</h1>
      {view === 'odoo' ? (
        <DataList<OdooRow>
          key="odoo"
          printButton
          exportable={false}
          listKey="stock-movements-odoo"
          endpoint="/stock-movements"
          printPath="/api/stock-movements/pdf"
          initialFilters={{ view: 'odoo' }}
          columns={ODOO_COLUMNS}
          rowKey={(r) => r.id}
          searchPlaceholder="Search item, reference, customer or supplier…"
          emptyTitle="No Odoo history"
          emptyHint="Odoo's product moves appear here once imported from Inventory › ⋯ › Import product moves from Odoo…. They are a record only, never part of the stock."
          actions={switcher}
          filters={odooFilters}
          summary={cards('Odoo moves')}
        />
      ) : (
        <DataList<MovementRow>
          key="gcore"
          printButton
          exportable={false}
          listKey="stock-movements"
          endpoint="/stock-movements"
          printPath="/api/stock-movements/pdf"
          columns={MOVEMENT_COLUMNS}
          rowKey={(r) => r.id}
          searchPlaceholder="Search item, part number or document number…"
          emptyTitle="No stock movements"
          emptyHint="Every incoming report, outgoing slip, pull-out, borrow and return is listed here once it is posted."
          actions={switcher}
          filters={gcoreFilters}
          summary={cards('Stock movements')}
        />
      )}
    </div>
  );
}

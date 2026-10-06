import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { ImportModal, loadImportSpec } from '../../components/ImportModal';
import { Checkbox, ErrorBox, Field, Modal, StatusBadge, formatDate, formatMoney, useToast } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';

const ITEM_TYPES = [
  { value: 'MATERIAL', label: 'Material' },
  { value: 'EQUIPMENT', label: 'Equipment' },
  { value: 'CONSUMABLE', label: 'Consumable' },
  { value: 'SERVICE', label: 'Service' },
  { value: 'TOOL', label: 'Tool' },
];

interface Ref {
  id: string;
  name: string;
  code?: string;
}

interface ItemRow {
  id: string;
  code: string;
  partNumber: string | null;
  name: string;
  description: string | null;
  itemType: string;
  unit: string;
  standardCost: number | null;
  lastCost: number | null;
  /** The partner's published list price — a PRICE, which Sales may see; not a cost. */
  listPrice: number | null;
  listPriceCurrency: string | null;
  listPriceAsOf: string | null;
  isStocked: boolean;
  minStock: number | null;
  reorderLevel: number | null;
  isActive: boolean;
  notes: string | null;
  category: Ref | null;
  costCategory: Ref | null;
  preferredSupplier: Ref | null;
}

export function Items() {
  const { can } = useAuth();
  const navigate = useNavigate();
  // /g-chain/items/:id is the item itself — a link to an item (a partner's
  // price list, a search hit) must open it, not the bare list.
  const { id: routeId } = useParams<{ id: string }>();
  const [editing, setEditing] = useState<ItemRow | 'new' | null>(null);
  const [importing, setImporting] = useState<{ label: string; columns: never[] } | null>(null);
  const [reload, setReload] = useState(0);
  const [categories, setCategories] = useState<Ref[]>([]);
  const [costCategories, setCostCategories] = useState<Ref[]>([]);

  useEffect(() => {
    api.get<Ref[]>('/reference/item-categories').then(setCategories).catch(() => {});
    api.get<Ref[]>('/reference/cost-categories').then(setCostCategories).catch(() => {});
  }, []);

  useEffect(() => {
    if (!routeId) return;
    let live = true;
    api
      .get<ItemRow>(`/items/${routeId}`)
      .then((item) => live && setEditing(item))
      .catch(() => live && navigate('/g-chain/items', { replace: true }));
    return () => {
      live = false;
    };
  }, [routeId, navigate]);

  /** Closing an item opened by its own URL goes back to the list's URL. */
  function close() {
    setEditing(null);
    if (routeId) navigate('/g-chain/items');
  }

  const columns: Column<ItemRow>[] = [
    { key: 'code', label: 'Code', sortKey: 'code', render: (i) => <span className="mono">{i.code}</span> },
    {
      key: 'name',
      label: 'Item',
      sortKey: 'name',
      render: (i) => (
        <div>
          <div>{i.name}</div>
          {i.partNumber && <div className="faint mono">{i.partNumber}</div>}
        </div>
      ),
    },
    {
      key: 'itemType',
      label: 'Type',
      render: (i) => (
        <span className="badge">{ITEM_TYPES.find((t) => t.value === i.itemType)?.label ?? i.itemType}</span>
      ),
    },
    { key: 'category', label: 'Category', render: (i) => i.category?.name ?? '—' },
    {
      key: 'costCategory',
      label: 'Cost bucket',
      render: (i) =>
        i.costCategory ? (
          i.costCategory.name
        ) : (
          <span className="faint" title="Without this, a purchase of this item cannot be filed against a project budget">
            not set
          </span>
        ),
    },
    { key: 'unit', label: 'Unit', render: (i) => i.unit },
    {
      key: 'standardCost',
      label: 'Standard cost',
      align: 'right',
      render: (i) => (i.standardCost == null ? '—' : formatMoney(i.standardCost)),
    },
    {
      key: 'listPrice',
      label: 'List price',
      align: 'right',
      optional: true,
      render: (i) =>
        i.listPrice == null ? (
          <span className="faint">—</span>
        ) : (
          <>
            {formatMoney(i.listPrice, i.listPriceCurrency ?? 'PHP')}
            {i.listPriceAsOf && <span className="m-subname">as of {formatDate(i.listPriceAsOf)}</span>}
          </>
        ),
    },
    {
      key: 'stocked',
      label: 'Stocked',
      render: (i) => (i.isStocked ? <span className="badge ok">yes</span> : <span className="faint">no</span>),
      optional: true,
    },
    {
      key: 'reorderLevel',
      label: 'Reorder at',
      align: 'right',
      render: (i) => (i.reorderLevel == null ? '—' : i.reorderLevel),
      optional: true,
    },
    { key: 'supplier', label: 'Preferred supplier', render: (i) => i.preferredSupplier?.name ?? '—', optional: true },
    {
      key: 'isActive',
      label: 'Status',
      render: (i) => <StatusBadge status={i.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Item Master</h1>
          <p>
            One list of things, used by costing (estimated), procurement (ordered), inventory
            (stocked) and jobs (consumed). The cost bucket on each item is what lets a purchase
            land in the right line of a project budget without anyone choosing it by hand.
          </p>
        </div>
      </div>

      <DataList<ItemRow>
        listKey="items"
        endpoint="/items"
        columns={columns}
        rowKey={(i) => i.id}
        searchPlaceholder="Search name, code, part number…"
        reloadToken={reload}
        onRowClick={(i) => navigate(`/g-chain/items/${i.id}`)}
        emptyTitle="No items yet"
        emptyHint="Add what you buy and install regularly — you do not need every screw."
        filters={[
          { key: 'itemType', label: 'Type', options: ITEM_TYPES },
          {
            key: 'categoryId',
            label: 'Category',
            options: categories.map((c) => ({ value: c.id, label: c.name })),
          },
          {
            key: 'costCategoryId',
            label: 'Cost bucket',
            options: costCategories.map((c) => ({ value: c.id, label: c.name })),
          },
          {
            key: 'isActive',
            label: 'Status',
            options: [
              { value: 'true', label: 'Active' },
              { value: 'false', label: 'Inactive' },
            ],
          },
        ]}
        actions={
          <>
            {can('gchain.items.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
                + Add item
              </button>
            )}
            {can('gchain.items.create') && (
              <button
                className="btn btn-sm"
                onClick={async () => {
                  const spec = await loadImportSpec('items');
                  if (spec) setImporting(spec as { label: string; columns: never[] });
                }}
              >
                Import
              </button>
            )}
          </>
        }
      />

      {editing && (
        <ItemForm
          item={editing === 'new' ? null : editing}
          categories={categories}
          costCategories={costCategories}
          onClose={close}
          onSaved={() => {
            close();
            setReload((r) => r + 1);
          }}
        />
      )}

      {importing && (
        <ImportModal
          entity="items"
          label={importing.label}
          columns={importing.columns}
          onClose={() => setImporting(null)}
          onImported={() => setReload((r) => r + 1)}
        />
      )}
    </div>
  );
}

function ItemForm({
  item,
  categories,
  costCategories,
  onClose,
  onSaved,
}: {
  item: ItemRow | null;
  categories: Ref[];
  costCategories: Ref[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);

  const [form, setForm] = useState({
    code: item?.code ?? '',
    partNumber: item?.partNumber ?? '',
    name: item?.name ?? '',
    description: item?.description ?? '',
    itemType: item?.itemType ?? 'MATERIAL',
    categoryId: item?.category?.id ?? '',
    costCategoryId: item?.costCategory?.id ?? '',
    unit: item?.unit ?? 'pcs',
    standardCost: item?.standardCost?.toString() ?? '',
    listPrice: item?.listPrice?.toString() ?? '',
    listPriceCurrency: item?.listPriceCurrency ?? '',
    listPriceAsOf: item?.listPriceAsOf ? item.listPriceAsOf.slice(0, 10) : '',
    isStocked: item?.isStocked ?? true,
    minStock: item?.minStock?.toString() ?? '',
    reorderLevel: item?.reorderLevel?.toString() ?? '',
    preferredSupplierId: item?.preferredSupplier?.id ?? '',
    isActive: item?.isActive ?? true,
    notes: item?.notes ?? '',
  });

  useEffect(() => {
    api
      .get<{ id: string; name: string }[]>('/suppliers/lookup')
      .then(setSuppliers)
      .catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        code: form.code || undefined,
        partNumber: form.partNumber || null,
        name: form.name,
        description: form.description || null,
        itemType: form.itemType,
        categoryId: form.categoryId || null,
        costCategoryId: form.costCategoryId || null,
        unit: form.unit,
        standardCost: form.standardCost === '' ? null : Number(form.standardCost),
        listPrice: form.listPrice === '' ? null : Number(form.listPrice),
        listPriceCurrency: form.listPriceCurrency.trim() ? form.listPriceCurrency.trim().toUpperCase() : null,
        listPriceAsOf: form.listPriceAsOf || null,
        isStocked: form.isStocked,
        minStock: form.minStock === '' ? null : Number(form.minStock),
        reorderLevel: form.reorderLevel === '' ? null : Number(form.reorderLevel),
        preferredSupplierId: form.preferredSupplierId || null,
        isActive: form.isActive,
        notes: form.notes || null,
      };
      if (item) await api.patch(`/items/${item.id}`, payload);
      else await api.post('/items', payload);
      toast('ok', `${form.name} saved`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!item) return;
    setBusy(true);
    try {
      await api.del(`/items/${item.id}`);
      toast('ok', 'Item deleted');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={item ? `Modify ${item.name}` : 'Add item'}
      onClose={onClose}
      footer={
        <>
          {item && can('gchain.items.delete') && (
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.name.length < 2}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      <div className="grid grid-2">
        <Field label="Item name">
          <input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Code" hint="Leave blank to auto-generate">
          <input className="mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </Field>
        <Field label="Part number" hint="The supplier's or manufacturer's number">
          <input
            className="mono"
            value={form.partNumber}
            onChange={(e) => setForm({ ...form, partNumber: e.target.value })}
          />
        </Field>
        <Field label="Unit">
          <input
            value={form.unit}
            placeholder="pcs, m, kg, set, lot"
            onChange={(e) => setForm({ ...form, unit: e.target.value })}
          />
        </Field>
        <Field label="Type">
          <select value={form.itemType} onChange={(e) => setForm({ ...form, itemType: e.target.value })}>
            {ITEM_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Category">
          <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
            <option value="">— none —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Cost bucket"
          hint="Which line of a project budget a purchase of this lands in"
        >
          <select
            value={form.costCategoryId}
            onChange={(e) => setForm({ ...form, costCategoryId: e.target.value })}
          >
            <option value="">— not set —</option>
            {costCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Standard cost" hint="Used by costing as the starting estimate">
          <NumberInput
            kind="money"
            step="0.01"
            value={form.standardCost}
            onChange={(e) => setForm({ ...form, standardCost: e.target.value })}
          />
        </Field>
        <Field
          label="List price"
          hint="The partner's published price — shown to Sales on the partner's price list. A price, not a cost."
        >
          <NumberInput
            kind="money"
            step="0.01"
            min="0"
            value={form.listPrice}
            onChange={(e) => setForm({ ...form, listPrice: e.target.value })}
          />
        </Field>
        <Field label="List price currency" hint="Three letters, e.g. USD — blank means pesos">
          <input
            className="mono"
            maxLength={3}
            value={form.listPriceCurrency}
            onChange={(e) =>
              setForm({ ...form, listPriceCurrency: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })
            }
          />
        </Field>
        <Field label="List price as of" hint="The date on the price list it came from">
          <input
            type="date"
            value={form.listPriceAsOf}
            onChange={(e) => setForm({ ...form, listPriceAsOf: e.target.value })}
          />
        </Field>
        <Field label="Preferred supplier" hint="A partner's items appear on its price list in G-OPS › Partners">
          <select
            value={form.preferredSupplierId}
            onChange={(e) => setForm({ ...form, preferredSupplierId: e.target.value })}
          >
            <option value="">— none —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Description">
        <textarea
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </Field>

      <hr className="rule" />

      <Checkbox
        checked={form.isStocked}
        onChange={(v) => setForm({ ...form, isStocked: v })}
        label="Kept in stock — carries balances and reorder levels"
      />

      {form.isStocked && (
        <div className="grid grid-2 m-stock-grid">
          <Field label="Minimum stock">
            <NumberInput
              kind="quantity"
              step="0.001"
              value={form.minStock}
              onChange={(e) => setForm({ ...form, minStock: e.target.value })}
            />
          </Field>
          <Field label="Reorder level" hint="Flagged for reordering at or below this">
            <NumberInput
              kind="quantity"
              step="0.001"
              value={form.reorderLevel}
              onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })}
            />
          </Field>
        </div>
      )}

      <Field label="Notes">
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>

      <Checkbox checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} label="Active" />
    </Modal>
  );
}

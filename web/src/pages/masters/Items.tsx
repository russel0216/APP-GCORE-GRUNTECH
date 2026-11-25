import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type BulkContext, type Column } from '../../components/DataList';
import { ImportModal, loadImportSpec } from '../../components/ImportModal';
import {
  Checkbox,
  ErrorBox,
  Field,
  Modal,
  ModalFoot,
  StatusBadge,
  formatMoney,
  useToast,
} from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';
import { SupplierPicker, type SupplierRef } from '../../components/SupplierPicker';


interface Ref {
  id: string;
  name: string;
  code?: string;
}

interface ItemRow {
  id: string;
  code: string;
  partNumber: string | null;
  /** The manufacturer / OEM — not who we buy from. */
  brand: string | null;
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
  /** What the automatic reorder tops the shelf up to (2026-11-25). */
  maxStock?: number | null;
  isActive: boolean;
  notes: string | null;
  category: Ref | null;
  /** The product group, from the quotation's list (2026-11-25). */
  productGroup?: string | null;
  costCategory: Ref | null;
  preferredSupplier: Ref | null;
  /** Whether the viewer may change it — Edit All, or Edit Own on an item they added (2026-10-18). */
  canEdit?: boolean;
  /** Whether the viewer may delete it — the warehouse's leads (2026-11-25). */
  canDelete?: boolean;
}

/** What saving an item answers — enough for a picker to choose it. */
export interface SavedItem {
  id: string;
  code: string;
  name: string;
  partNumber: string | null;
  unit: string;
  standardCost: number | string | null;
}

/** The New item form with the lists it needs, for a popup opened from a picker (2026-11-18). */
export function NewItemPopup({
  presetName,
  onClose,
  onSaved,
}: {
  presetName?: string;
  onClose: () => void;
  onSaved: (saved: SavedItem) => void;
}) {
  return (
    <ItemForm
      item={null}
      presetName={presetName}
      onClose={onClose}
      onSaved={(saved) => (saved ? onSaved(saved) : onClose())}
    />
  );
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
  const [byBrand, setByBrand] = useState(false);
  // The product groups — the quotation's list — are the item's one category (2026-11-25).
  const [groups, setGroups] = useState<{ name: string }[]>([]);

  useEffect(() => {
    api.get<{ name: string }[]>('/reference/quotation-groups?active=true').then(setGroups).catch(() => {});
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
          {i.description && i.description !== i.name && <div className="faint">{i.description}</div>}
          {(i.brand || i.partNumber) && <div className="faint">{[i.brand, i.partNumber].filter(Boolean).join(' · ')}</div>}
        </div>
      ),
    },
    { key: 'productGroup', label: 'Product group', render: (i) => i.productGroup ?? <span className="faint">—</span> },
    { key: 'unit', label: 'Unit', render: (i) => i.unit },
    {
      key: 'standardCost',
      label: 'Standard cost',
      align: 'right',
      render: (i) => (i.standardCost == null ? '—' : formatMoney(i.standardCost)),
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
    {
      key: 'maxStock',
      label: 'Maximum',
      align: 'right',
      render: (i) => (i.maxStock == null ? '—' : i.maxStock),
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
      {/* The open tab names the screen (2026-11-17, the owner's call): the heading is for screen readers alone. */}
      <h1 className="visually-hidden">Item Master</h1>

      <DataList<ItemRow>
        printButton
        exportable={false}
        listKey="items"
        endpoint="/items"
        printPath="/api/items/pdf"
        columns={columns}
        rowKey={(i) => i.id}
        searchPlaceholder="Search items — a comma between several: contactor, wire"
        reloadToken={reload}
        selectable
        // Set the product group of many at once (2026-11-25): the ordinary PATCH per row, which refuses anyone but the warehouse's leads.
        bulkActions={(ctx) => (ctx.rows.some((i) => i.canEdit) ? <ItemBulkActions ctx={ctx} groups={groups} /> : null)}
        onRowClick={(i) => navigate(`/g-chain/items/${i.id}`)}
        emptyTitle="No items yet"
        emptyHint="Add what you buy and install regularly — you do not need every screw."
        filters={[
          {
            key: 'group',
            label: 'Product group',
            options: [...groups.map((g) => ({ value: g.name, label: g.name })), { value: 'none', label: 'No group' }],
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
          can('gchain.items.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
              + New item
            </button>
          ) : null
        }
        // The list's own tool lives in its ⋯ menu, as on the supplier list.
        menuItems={[
          ...(can('gchain.items.create')
            ? [
                {
                  label: 'Import items…',
                  hint: 'From a spreadsheet, checked before anything is saved',
                  onSelect: () => {
                    void loadImportSpec('items').then((spec) => {
                      if (spec) setImporting(spec as { label: string; columns: never[] });
                    });
                  },
                },
              ]
            : []),
          // The items that arrived with a brand and no product group (2026-11-25): each brand, its suggested group, the person's call.
          ...(can('gchain.items.edit_all') || can('gchain.items.edit_own')
            ? [
                {
                  label: 'File under product groups by brand…',
                  hint: 'Every brand whose items have no product group yet, with the group suggested for it — nothing is filed until you say',
                  onSelect: () => setByBrand(true),
                },
              ]
            : []),
        ]}
      />

      {editing && (
        <ItemForm
          item={editing === 'new' ? null : editing}
          onClose={close}
          onSaved={() => {
            close();
            setReload((r) => r + 1);
          }}
        />
      )}

      {byBrand && (
        <GroupByBrandModal
          onClose={() => setByBrand(false)}
          onFiled={() => {
            setByBrand(false);
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

/**
 * The item list's mass action: file the ticked items under a product group
 * (the Odoo items arrived with none). One `PATCH /items/:id` per row; what
 * was refused stays ticked, with the reason.
 */
function ItemBulkActions({ ctx, groups }: { ctx: BulkContext<ItemRow>; groups: { name: string }[] }) {
  const toast = useToast();
  const [group, setGroup] = useState('');
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [refused, setRefused] = useState<{ code: string; why: string }[]>([]);
  const go = ctx.rows.filter((i) => i.canEdit && (i.productGroup ?? '') !== group);

  async function apply() {
    if (!group || !go.length) return;
    const failed: { row: ItemRow; why: string }[] = [];
    let done = 0;
    setRefused([]);
    for (let n = 0; n < go.length; n++) {
      setProgress({ done: n, of: go.length });
      try {
        await api.patch(`/items/${go[n].id}`, { productGroup: group });
        done++;
      } catch (err) {
        failed.push({ row: go[n], why: err instanceof ApiError ? err.message : 'could not be changed' });
      }
    }
    setProgress(null);
    toast(done > 0 ? 'ok' : 'error', `${done} item${done === 1 ? '' : 's'} filed under ${group}${failed.length ? `; ${failed.length} unchanged` : ''}`);
    setRefused(failed.map((f) => ({ code: f.row.code, why: f.why })));
    setGroup('');
    ctx.reload();
    if (failed.length) ctx.keep(failed.map((f) => f.row.id));
    else ctx.clear();
  }

  return (
    <>
      <select aria-label="File the selected items under a product group" value={group} disabled={!!progress} onChange={(e) => setGroup(e.target.value)}>
        <option value="">Set product group…</option>
        {groups.map((g) => (
          <option key={g.name} value={g.name}>
            {g.name}
          </option>
        ))}
      </select>
      {group && (
        <button type="button" className="btn btn-sm btn-primary" disabled={!!progress || !go.length} onClick={() => void apply()}>
          {progress ? `Saving ${progress.done + 1} of ${progress.of}…` : go.length ? `File ${go.length} under ${group}` : `Already ${group}`}
        </button>
      )}
      {refused.length > 0 && (
        <span className="faint" role="status">
          Unchanged: {refused.map((r) => `${r.code} — ${r.why}`).join('; ')}
        </span>
      )}
    </>
  );
}

interface BrandRow {
  key: string;
  brand: string | null;
  items: number;
  suggest: string | null;
}

/**
 * File items under product groups by their brand (2026-11-25, the owner's
 * call). Every brand whose items have no group, the group suggested for it
 * preselected, "— leave —" where there is none; Save files only the brands
 * given a group, and only items still without one.
 */
function GroupByBrandModal({ onClose, onFiled }: { onClose: () => void; onFiled: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<{ brands: BrandRow[]; groups: string[]; total: number } | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<{ brands: BrandRow[]; groups: string[]; total: number }>('/items/group-by-brand')
      .then((d) => {
        setData(d);
        setChoices(Object.fromEntries(d.brands.filter((b) => b.suggest).map((b) => [b.key, b.suggest as string])));
      })
      .catch(setError);
  }, []);

  const chosen = (data?.brands ?? []).filter((b) => choices[b.key]);
  const items = chosen.reduce((n, b) => n + b.items, 0);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ total: number }>('/items/group-by-brand', { choices: Object.fromEntries(chosen.map((b) => [b.key, choices[b.key]])) });
      toast('ok', `${r.total.toLocaleString('en-US')} item${r.total === 1 ? '' : 's'} filed under product groups`);
      onFiled();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title="File items under product groups by brand"
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={save} disabled={busy || !items}>
            {busy ? 'Filing…' : items ? `File ${items.toLocaleString('en-US')} item${items === 1 ? '' : 's'}` : 'Nothing chosen'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {data && (
        <>
          <p className="muted">
            {data.total.toLocaleString('en-US')} item{data.total === 1 ? ' has' : 's have'} no product group, across {data.brands.length} brand
            {data.brands.length === 1 ? '' : 's'}. A group is preselected where the brand names one; leave a brand as it is, or pick OTHERS. Only items
            still without a group are filed.
          </p>
          {data.brands.length === 0 ? (
            <p className="collection-empty">Every item has a product group.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Brand</th>
                    <th className="right">Items</th>
                    <th>File under</th>
                  </tr>
                </thead>
                <tbody>
                  {data.brands.map((b) => (
                    <tr key={b.key}>
                      <td>{b.brand ?? <span className="faint">No brand on the item</span>}</td>
                      <td className="right mono">{b.items.toLocaleString('en-US')}</td>
                      <td>
                        <select
                          aria-label={`Product group for ${b.brand ?? 'items with no brand'}`}
                          value={choices[b.key] ?? ''}
                          onChange={(e) => setChoices({ ...choices, [b.key]: e.target.value })}
                        >
                          <option value="">— leave —</option>
                          {data.groups.map((g) => (
                            <option key={g} value={g}>
                              {g}
                              {g === b.suggest ? ' (suggested)' : ''}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

export function ItemForm({
  item,
  presetName,
  onClose,
  onSaved,
}: {
  item: ItemRow | null;
  /** A new item's name to start with — what was typed in a picker. */
  presetName?: string;
  onClose: () => void;
  onSaved: (saved?: SavedItem) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** The product groups on offer — the quotation's list, active ones (2026-11-25). */
  const [groups, setGroups] = useState<{ name: string; description: string | null }[]>([]);
  useEffect(() => {
    api
      .get<{ name: string; description: string | null }[]>('/reference/quotation-groups?active=true')
      .then(setGroups)
      .catch(() => setGroups([]));
  }, []);
  const [preferredSupplier, setPreferredSupplier] = useState<SupplierRef | null>(
    item?.preferredSupplier ? { id: item.preferredSupplier.id, name: item.preferredSupplier.name } : null,
  );

  const [form, setForm] = useState({
    code: item?.code ?? '',
    partNumber: item?.partNumber ?? '',
    brand: item?.brand ?? '',
    name: item?.name ?? presetName ?? '',
    description: item?.description ?? '',
    productGroup: item?.productGroup ?? '',
    unit: item?.unit ?? 'pcs',
    standardCost: item?.standardCost?.toString() ?? '',
    isStocked: item?.isStocked ?? true,
    minStock: item?.minStock?.toString() ?? '',
    reorderLevel: item?.reorderLevel?.toString() ?? '',
    maxStock: item?.maxStock?.toString() ?? '',
    isActive: item?.isActive ?? true,
    notes: item?.notes ?? '',
  });

  // Someone else's item, to a viewer with Edit Own alone (2026-10-18): read, never saved.
  const readOnly = !!item && item.canEdit === false;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // The type, the old category, the budget line and the partner's list
      // price left the form (2026-11-25): never sent, so an item keeps what it
      // has and a new one takes the server's defaults (Material, Materials).
      const payload = {
        code: form.code || undefined,
        partNumber: form.partNumber || null,
        brand: form.brand.trim() || null,
        name: form.name,
        description: form.description || null,
        productGroup: form.productGroup || null,
        unit: form.unit,
        standardCost: form.standardCost === '' ? null : Number(form.standardCost),
        isStocked: form.isStocked,
        minStock: form.minStock === '' ? null : Number(form.minStock),
        reorderLevel: form.reorderLevel === '' ? null : Number(form.reorderLevel),
        maxStock: form.maxStock === '' ? null : Number(form.maxStock),
        preferredSupplierId: preferredSupplier?.id ?? null,
        isActive: form.isActive,
        notes: form.notes || null,
      };
      const saved = item
        ? await api.patch<SavedItem>(`/items/${item.id}`, payload)
        : await api.post<SavedItem>('/items', payload);
      toast('ok', `${form.name} saved`);
      onSaved(saved);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={item ? (readOnly ? item.name : `Modify item ${item.name}`) : 'New item'}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          cancelLabel={readOnly ? 'Close' : undefined}
          busy={busy}
          danger={
            // The warehouse's leads delete an item, and only one that never moved (2026-11-25).
            item && item.canDelete
              ? {
                  label: 'Delete',
                  question: `Delete ${item.name}? It cannot be undone.`,
                  // Thrown errors show beside the question, which stays open.
                  onConfirm: async () => {
                    await api.del(`/items/${item.id}`);
                    toast('ok', 'Item deleted');
                    onSaved();
                  },
                }
              : undefined
          }
        >
          {!readOnly && (
            <button className="btn btn-primary" onClick={save} disabled={busy || form.name.length < 2}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
        </ModalFoot>
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
        <Field label="Brand / OEM" hint="Who makes it — Pentair, Nidec, SUTO-iTEC — not who we buy from">
          <input value={form.brand} maxLength={120} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
        </Field>
        <Field label="Unit">
          <input
            value={form.unit}
            placeholder="pcs, m, kg, set, lot"
            onChange={(e) => setForm({ ...form, unit: e.target.value })}
          />
        </Field>
        <Field label="Product group" hint={groups.find((g) => g.name === form.productGroup)?.description ?? 'The quotation’s product groups'}>
          <select value={form.productGroup} onChange={(e) => setForm({ ...form, productGroup: e.target.value })}>
            <option value="">— none —</option>
            {form.productGroup && !groups.some((g) => g.name === form.productGroup) && (
              <option value={form.productGroup}>{form.productGroup} — not on the list</option>
            )}
            {groups.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name}
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
        <Field label="Preferred supplier" hint="Who it is usually bought from">
          <SupplierPicker value={preferredSupplier} onChange={setPreferredSupplier} onError={setError} />
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
        <div className="grid grid-3 m-stock-grid">
          <Field label="Minimum stock" hint="At or below this it is Critical">
            <NumberInput
              kind="quantity"
              step="0.001"
              value={form.minStock}
              onChange={(e) => setForm({ ...form, minStock: e.target.value })}
            />
          </Field>
          <Field label="Reorder level" hint="At or below this a purchase request is raised">
            <NumberInput
              kind="quantity"
              step="0.001"
              value={form.reorderLevel}
              onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })}
            />
          </Field>
          <Field label="Maximum stock" hint="The reorder tops the shelf up to this — blank is the reorder level">
            <NumberInput
              kind="quantity"
              step="0.001"
              value={form.maxStock}
              onChange={(e) => setForm({ ...form, maxStock: e.target.value })}
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

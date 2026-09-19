import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Checkbox, Empty, ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';

// ════════════════════════════════════════════════════════════════════
//  CATEGORIES — cost categories and item categories
// ════════════════════════════════════════════════════════════════════

interface CostCategory {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
}

interface ItemCategory {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  _count: { items: number };
}

export function Categories() {
  const { can } = useAuth();
  const toast = useToast();
  const [cost, setCost] = useState<CostCategory[]>([]);
  const [items, setItems] = useState<ItemCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editingCost, setEditingCost] = useState<CostCategory | 'new' | null>(null);
  const [editingItem, setEditingItem] = useState<ItemCategory | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, i] = await Promise.all([
        api.get<CostCategory[]>('/reference/cost-categories'),
        api.get<ItemCategory[]>('/reference/item-categories'),
      ]);
      setCost(c);
      setItems(i);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mayEdit = can('admin.categories.edit_all');

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Categories</h1>
          <p>
            Cost categories are the five buckets every costing, budget and cost-ledger row is
            grouped by. Item categories are how you organise the item master for browsing — they
            have no effect on money.
          </p>
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="grid grid-2">
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              Cost categories
            </h3>
            {can('admin.categories.create') && (
              <button className="btn btn-sm" onClick={() => setEditingCost('new')}>
                + Add
              </button>
            )}
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 80 }}>Code</th>
                  <th>Name</th>
                  <th style={{ width: 90 }}>Status</th>
                  {mayEdit && <th style={{ width: 70 }} />}
                </tr>
              </thead>
              <tbody>
                {cost.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.code}</td>
                    <td>
                      {c.name}
                      {c.isSystem && (
                        <span className="badge" style={{ marginLeft: 7 }}>
                          standard
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${c.isActive ? 'ok' : ''}`}>
                        {c.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    {mayEdit && (
                      <td>
                        <button className="btn btn-sm" onClick={() => setEditingCost(c)}>
                          Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
            The five standard categories cannot be deleted — every budget and cost figure in the
            system is grouped by them. You can rename them.
          </p>
        </div>

        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              Item categories
            </h3>
            {can('admin.categories.create') && (
              <button className="btn btn-sm" onClick={() => setEditingItem('new')}>
                + Add
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <Empty title="No item categories" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 80 }}>Code</th>
                    <th>Name</th>
                    <th style={{ width: 70 }} className="right">
                      Items
                    </th>
                    {mayEdit && <th style={{ width: 70 }} />}
                  </tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.code}</td>
                      <td>
                        {c.parentId && <span className="faint">↳ </span>}
                        {c.name}
                      </td>
                      <td className="right">{c._count.items}</td>
                      {mayEdit && (
                        <td>
                          <button className="btn btn-sm" onClick={() => setEditingItem(c)}>
                            Edit
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {editingCost && (
        <CostCategoryModal
          category={editingCost === 'new' ? null : editingCost}
          onClose={() => setEditingCost(null)}
          onSaved={() => {
            setEditingCost(null);
            void load();
            toast('ok', 'Saved');
          }}
        />
      )}

      {editingItem && (
        <ItemCategoryModal
          category={editingItem === 'new' ? null : editingItem}
          all={items}
          onClose={() => setEditingItem(null)}
          onSaved={() => {
            setEditingItem(null);
            void load();
            toast('ok', 'Saved');
          }}
        />
      )}
    </div>
  );
}

function CostCategoryModal({
  category,
  onClose,
  onSaved,
}: {
  category: CostCategory | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    code: category?.code ?? '',
    name: category?.name ?? '',
    sortOrder: category?.sortOrder ?? 99,
    isActive: category?.isActive ?? true,
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (category) await api.patch(`/reference/cost-categories/${category.id}`, form);
      else await api.post('/reference/cost-categories', form);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!category) return;
    setBusy(true);
    try {
      await api.del(`/reference/cost-categories/${category.id}`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={category ? `Edit ${category.name}` : 'Add cost category'}
      onClose={onClose}
      footer={
        <>
          {category && !category.isSystem && can('admin.categories.delete') && (
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
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
      {category?.isSystem && (
        <div className="alert info">
          This is one of the five standard categories. You can rename it; its code and existence are
          fixed because the cost ledger groups by them.
        </div>
      )}
      <Field label="Name">
        <input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Code">
        <input
          className="mono"
          value={form.code}
          disabled={category?.isSystem}
          onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
        />
      </Field>
      <Field label="Sort order">
        <input
          type="number"
          value={form.sortOrder}
          onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
        />
      </Field>
      <Checkbox checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} label="Active" />
    </Modal>
  );
}

function ItemCategoryModal({
  category,
  all,
  onClose,
  onSaved,
}: {
  category: ItemCategory | null;
  all: ItemCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    code: category?.code ?? '',
    name: category?.name ?? '',
    parentId: category?.parentId ?? '',
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = { code: form.code, name: form.name, parentId: form.parentId || null };
      if (category) await api.patch(`/reference/item-categories/${category.id}`, payload);
      else await api.post('/reference/item-categories', payload);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!category) return;
    setBusy(true);
    try {
      await api.del(`/reference/item-categories/${category.id}`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={category ? `Edit ${category.name}` : 'Add item category'}
      onClose={onClose}
      footer={
        <>
          {category && can('admin.categories.delete') && (
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
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
      <Field label="Name">
        <input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Code">
        <input
          className="mono"
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
        />
      </Field>
      <Field label="Parent category">
        <select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
          <option value="">— top level —</option>
          {all
            .filter((c) => c.id !== category?.id)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </Field>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════
//  WAREHOUSES
// ════════════════════════════════════════════════════════════════════

interface Location {
  id: string;
  code: string;
  name: string | null;
}

interface Warehouse {
  id: string;
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  isActive: boolean;
  locations: Location[];
}

export function Warehouses() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Warehouse | 'new' | null>(null);
  const [addingLocation, setAddingLocation] = useState<Warehouse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.get<Warehouse[]>('/warehouses'));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mayEdit = can('gchain.warehouses.edit_all');

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Warehouses</h1>
          <p>
            Where stock physically sits. Locations are the bin, rack or shelf inside a warehouse —
            worth setting up only if you need to find things by position.
          </p>
        </div>
        {can('gchain.warehouses.create') && (
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            + Add warehouse
          </button>
        )}
      </div>

      <ErrorBox error={error} />

      {rows.length === 0 ? (
        <div className="card">
          <Empty title="No warehouses yet" />
        </div>
      ) : (
        <div className="grid grid-2">
          {rows.map((w) => (
            <div key={w.id} className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <strong>{w.name}</strong>{' '}
                  <span className="mono faint" style={{ fontSize: 12 }}>
                    {w.code}
                  </span>
                </div>
                <span className={`badge ${w.isActive ? 'ok' : ''}`}>
                  {w.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div className="muted" style={{ fontSize: 12, margin: '6px 0 12px' }}>
                {[w.address, w.city].filter(Boolean).join(', ') || 'No address recorded'}
              </div>

              <div className="row" style={{ gap: 5, marginBottom: 12 }}>
                {w.locations.length === 0 ? (
                  <span className="faint" style={{ fontSize: 12 }}>
                    No locations
                  </span>
                ) : (
                  w.locations.map((l) => (
                    <span key={l.id} className="badge" title={l.name ?? undefined}>
                      {l.code}
                    </span>
                  ))
                )}
              </div>

              {mayEdit && (
                <div className="row">
                  <button className="btn btn-sm" onClick={() => setEditing(w)}>
                    Edit
                  </button>
                  <button className="btn btn-sm" onClick={() => setAddingLocation(w)}>
                    + Location
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <WarehouseModal
          warehouse={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
            toast('ok', 'Saved');
          }}
        />
      )}

      {addingLocation && (
        <LocationModal
          warehouse={addingLocation}
          onClose={() => setAddingLocation(null)}
          onSaved={() => {
            setAddingLocation(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function WarehouseModal({
  warehouse,
  onClose,
  onSaved,
}: {
  warehouse: Warehouse | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    code: warehouse?.code ?? '',
    name: warehouse?.name ?? '',
    address: warehouse?.address ?? '',
    city: warehouse?.city ?? '',
    isActive: warehouse?.isActive ?? true,
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        code: form.code,
        name: form.name,
        address: form.address || null,
        city: form.city || null,
        isActive: form.isActive,
      };
      if (warehouse) await api.patch(`/warehouses/${warehouse.id}`, payload);
      else await api.post('/warehouses', payload);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!warehouse) return;
    setBusy(true);
    try {
      await api.del(`/warehouses/${warehouse.id}`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={warehouse ? `Edit ${warehouse.name}` : 'Add warehouse'}
      onClose={onClose}
      footer={
        <>
          {warehouse && can('gchain.warehouses.delete') && (
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.name || !form.code}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Name">
        <input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Code">
        <input
          className="mono"
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
        />
      </Field>
      <Field label="Address">
        <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
      </Field>
      <Field label="City">
        <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
      </Field>
      <Checkbox checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} label="Active" />
    </Modal>
  );
}

function LocationModal({
  warehouse,
  onClose,
  onSaved,
}: {
  warehouse: Warehouse;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/warehouses/${warehouse.id}/locations`, { code, name: name || null });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function removeLocation(id: string) {
    try {
      await api.del(`/warehouses/${warehouse.id}/locations/${id}`);
      onSaved();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Modal
      title={`Locations — ${warehouse.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !code}>
            {busy ? 'Adding…' : 'Add location'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      {warehouse.locations.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Code</th>
                <th>Name</th>
                <th style={{ width: 70 }} />
              </tr>
            </thead>
            <tbody>
              {warehouse.locations.map((l) => (
                <tr key={l.id}>
                  <td className="mono">{l.code}</td>
                  <td>{l.name ?? '—'}</td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => removeLocation(l.id)}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid grid-2">
        <Field label="Code" hint="A-01, RACK-3">
          <input className="mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Description">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

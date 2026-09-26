import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { ImportModal, loadImportSpec } from '../../components/ImportModal';
import {
  Checkbox,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  formatDateTime,
  useToast,
} from '../../components/ui';

interface SupplierRow {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  tin: string | null;
  category: string | null;
  paymentTerms: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  notes: string | null;
  isActive: boolean;
  contactCount: number;
}

interface SupplierContact {
  id: string;
  name: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  isPrimary: boolean;
  notes: string | null;
}

export function Suppliers() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState<{ label: string; columns: never[] } | null>(null);
  const [reload, setReload] = useState(0);

  const columns: Column<SupplierRow>[] = [
    { key: 'code', label: 'Code', sortKey: 'code', width: '150px', render: (s) => <span className="mono">{s.code}</span> },
    {
      key: 'name',
      label: 'Supplier',
      sortKey: 'name',
      render: (s) => (
        <div>
          <div>{s.name}</div>
          {s.legalName && s.legalName !== s.name && <div className="faint">{s.legalName}</div>}
        </div>
      ),
    },
    { key: 'category', label: 'Supplies', render: (s) => s.category ?? '—' },
    { key: 'city', label: 'City', render: (s) => s.city ?? '—' },
    { key: 'paymentTerms', label: 'Terms', render: (s) => s.paymentTerms ?? '—' },
    {
      key: 'contacts',
      label: 'Contacts',
      align: 'right',
      render: (s) => (s.contactCount === 0 ? <span className="faint">none</span> : s.contactCount),
    },
    { key: 'phone', label: 'Phone', render: (s) => s.phone ?? '—', optional: true },
    { key: 'email', label: 'Email', render: (s) => <span className="mono">{s.email ?? '—'}</span>, optional: true },
    { key: 'tin', label: 'TIN', render: (s) => <span className="mono">{s.tin ?? '—'}</span>, optional: true },
    {
      key: 'isActive',
      label: 'Status',
      render: (s) => (
        <span className={`badge ${s.isActive ? 'ok' : ''}`}>{s.isActive ? 'Active' : 'Inactive'}</span>
      ),
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Suppliers</h1>
          <p>
            One supplier record for canvassing, purchase orders, receiving and payables. Keeping
            "Supplies" filled in is what makes a canvass quick — it is how you find the three
            suppliers to ask.
          </p>
        </div>
      </div>

      <DataList<SupplierRow>
        listKey="suppliers"
        endpoint="/suppliers"
        columns={columns}
        rowKey={(s) => s.id}
        scoped
        searchPlaceholder="Search name, code, what they supply, or a contact…"
        reloadToken={reload}
        onRowClick={(s) => navigate(`/g-chain/suppliers/${s.id}`)}
        emptyTitle="No suppliers yet"
        emptyHint="Add the first one, or import a list you already have."
        filters={[
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
            {can('gchain.suppliers.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
                + Add supplier
              </button>
            )}
            {can('gchain.suppliers.create') && (
              <button
                className="btn btn-sm"
                onClick={async () => {
                  const spec = await loadImportSpec('suppliers');
                  if (spec) setImporting(spec as { label: string; columns: never[] });
                }}
              >
                Import
              </button>
            )}
          </>
        }
      />

      {creating && (
        <SupplierForm
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            navigate(`/g-chain/suppliers/${id}`);
          }}
        />
      )}

      {importing && (
        <ImportModal
          entity="suppliers"
          label={importing.label}
          columns={importing.columns}
          onClose={() => setImporting(null)}
          onImported={() => setReload((r) => r + 1)}
        />
      )}
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

export function SupplierDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();

  const [supplier, setSupplier] = useState<(SupplierRow & { contacts: SupplierContact[]; createdAt: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [contactModal, setContactModal] = useState<SupplierContact | 'new' | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      setSupplier(await api.get(`/suppliers/${id}`));
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
  if (!supplier) return <ErrorBox error={error ?? new Error('Supplier not found')} />;

  const mayEdit = can('gchain.suppliers.edit_all');

  async function remove() {
    if (!supplier) return;
    try {
      await api.del(`/suppliers/${supplier.id}`);
      toast('ok', `${supplier.name} deleted`);
      navigate('/g-chain/suppliers');
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/g-chain/suppliers">Suppliers</Link>
        <span className="sep">›</span>
        <span className="mono">{supplier.code}</span>
        <span className="sep">›</span>
        <span>{supplier.name}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>{supplier.name}</h1>
          <p>
            {supplier.category ?? 'No category recorded'}
            {!supplier.isActive && (
              <span className="badge danger" style={{ marginLeft: 8 }}>
                Inactive
              </span>
            )}
          </p>
        </div>
        {mayEdit && (
          <div className="row">
            <button className="btn" onClick={() => setEditing(true)}>
              Modify
            </button>
            {can('gchain.suppliers.delete') && (
              <button className="btn btn-danger" onClick={remove}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      <ErrorBox error={error} />

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Details</h3>
          <Row label="Code" value={<span className="mono">{supplier.code}</span>} />
          <Row label="Registered name" value={supplier.legalName} />
          <Row label="TIN" value={supplier.tin} />
          <Row label="Supplies" value={supplier.category} />
          <Row label="Payment terms" value={supplier.paymentTerms} />
          <Row label="Added" value={formatDateTime(supplier.createdAt)} />
        </div>

        <div className="card">
          <h3 className="card-title">Contact</h3>
          <Row label="Address" value={supplier.address} />
          <Row label="City" value={supplier.city} />
          <Row label="Phone" value={supplier.phone} />
          <Row label="Email" value={supplier.email} />
          <Row label="Website" value={supplier.website} />
        </div>

        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              People
            </h3>
            {mayEdit && (
              <button className="btn btn-primary btn-sm" onClick={() => setContactModal('new')}>
                + Add contact
              </button>
            )}
          </div>
          {supplier.contacts.length === 0 ? (
            <Empty title="No contacts yet" hint="Who do you call to get a quotation?" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Position</th>
                    <th>Email</th>
                    <th>Mobile</th>
                    {mayEdit && <th style={{ width: 70 }} />}
                  </tr>
                </thead>
                <tbody>
                  {supplier.contacts.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.name}
                        {c.isPrimary && (
                          <span className="badge ok" style={{ marginLeft: 7 }}>
                            primary
                          </span>
                        )}
                      </td>
                      <td>{c.position ?? '—'}</td>
                      <td className="mono">{c.email ?? '—'}</td>
                      <td>{c.mobile ?? '—'}</td>
                      {mayEdit && (
                        <td>
                          <button className="btn btn-sm" onClick={() => setContactModal(c)}>
                            Modify
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

        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <Empty
            title="Purchase orders, receiving and payables ship in Phases 5 and 7"
            hint="This supplier's ordering history and outstanding bills will appear here."
          />
        </div>
      </div>

      {editing && (
        <SupplierForm
          supplier={supplier}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}

      {contactModal && (
        <SupplierContactModal
          supplierId={supplier.id}
          contact={contactModal === 'new' ? null : contactModal}
          onClose={() => setContactModal(null)}
          onSaved={() => {
            setContactModal(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <span className="faint" style={{ width: 150, flexShrink: 0, fontSize: 12 }}>
        {label}
      </span>
      <span>{value || <span className="faint">—</span>}</span>
    </div>
  );
}

// ── Forms ────────────────────────────────────────────────────────────────────

function SupplierForm({
  supplier,
  onClose,
  onSaved,
}: {
  supplier?: SupplierRow;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    code: supplier?.code ?? '',
    name: supplier?.name ?? '',
    legalName: supplier?.legalName ?? '',
    tin: supplier?.tin ?? '',
    category: supplier?.category ?? '',
    paymentTerms: supplier?.paymentTerms ?? '',
    address: supplier?.address ?? '',
    city: supplier?.city ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    website: supplier?.website ?? '',
    notes: supplier?.notes ?? '',
    isActive: supplier?.isActive ?? true,
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        code: form.code || undefined,
        name: form.name,
        legalName: form.legalName || null,
        tin: form.tin || null,
        category: form.category || null,
        paymentTerms: form.paymentTerms || null,
        address: form.address || null,
        city: form.city || null,
        phone: form.phone || null,
        email: form.email || null,
        website: form.website || null,
        notes: form.notes || null,
        isActive: form.isActive,
      };
      const saved = supplier
        ? await api.patch<{ id: string }>(`/suppliers/${supplier.id}`, payload)
        : await api.post<{ id: string }>('/suppliers', payload);
      toast('ok', `${form.name} saved`);
      onSaved(saved.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={supplier ? `Modify ${supplier.name}` : 'Add supplier'}
      onClose={onClose}
      footer={
        <>
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
        <Field label="Supplier name">
          <input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Code" hint="Leave blank to auto-generate">
          <input className="mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </Field>
        <Field label="Registered / legal name">
          <input value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
        </Field>
        <Field label="TIN">
          <input value={form.tin} onChange={(e) => setForm({ ...form, tin: e.target.value })} />
        </Field>
        <Field label="What they supply" hint="Used to shortlist suppliers when canvassing">
          <input
            value={form.category}
            placeholder="Steel & fabrication, valves, electrical…"
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          />
        </Field>
        <Field label="Payment terms">
          <input value={form.paymentTerms} onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })} />
        </Field>
        <Field label="Address">
          <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
        <Field label="City">
          <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </Field>
        <Field label="Phone">
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Email">
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
      </div>
      <Field label="Website">
        <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
      </Field>
      <Field label="Notes">
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
      <Checkbox checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} label="Active" />
    </Modal>
  );
}

function SupplierContactModal({
  supplierId,
  contact,
  onClose,
  onSaved,
}: {
  supplierId: string;
  contact: SupplierContact | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    name: contact?.name ?? '',
    position: contact?.position ?? '',
    email: contact?.email ?? '',
    phone: contact?.phone ?? '',
    mobile: contact?.mobile ?? '',
    isPrimary: contact?.isPrimary ?? false,
    notes: contact?.notes ?? '',
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        position: form.position || null,
        email: form.email || null,
        phone: form.phone || null,
        mobile: form.mobile || null,
        isPrimary: form.isPrimary,
        notes: form.notes || null,
      };
      if (contact) await api.patch(`/suppliers/${supplierId}/contacts/${contact.id}`, payload);
      else await api.post(`/suppliers/${supplierId}/contacts`, payload);
      toast('ok', `${form.name} saved`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!contact) return;
    setBusy(true);
    try {
      await api.del(`/suppliers/${supplierId}/contacts/${contact.id}`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={contact ? `Modify ${contact.name}` : 'Add contact'}
      onClose={onClose}
      footer={
        <>
          {contact && (
            <button className="btn btn-danger" onClick={remove} disabled={busy}>
              Remove
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
      <Field label="Name">
        <input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Position">
        <input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
      </Field>
      <div className="grid grid-2">
        <Field label="Email">
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Mobile">
          <input value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
        </Field>
      </div>
      <Field label="Phone">
        <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      </Field>
      <Checkbox
        checked={form.isPrimary}
        onChange={(v) => setForm({ ...form, isPrimary: v })}
        label="Primary contact"
      />
    </Modal>
  );
}

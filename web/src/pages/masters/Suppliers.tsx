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
  StatusBadge,
  formatDate,
  formatDateTime,
  formatMoney,
  humanise,
  useToast,
} from '../../components/ui';
import { Collection, Detail } from './Customer360';

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
  /** Set only through G-OPS › Partners — one owner for the flag. */
  isPartner: boolean;
  brand: string | null;
  partnerSince: string | null;
}

/*
  Supplier 360: each collection arrives behind the permission of the screen it
  comes from, and empty when the caller cannot open that screen.
*/
interface PoLine {
  id: string;
  number: string;
  status: string;
  kind: string;
  orderDate: string;
  deliveryDate: string | null;
  total: number;
  job: { id: string; number: string; name: string } | null;
}

interface ReceivingLine {
  id: string;
  number: string;
  receivedDate: string;
  deliveryRefNo: string | null;
  order: { id: string; number: string };
  receivedBy: { id: string; name: string } | null;
  lineCount: number;
}

interface BillLine {
  id: string;
  number: string;
  status: string;
  billDate: string;
  dueDate: string | null;
  supplierInvoiceNo: string | null;
  total: number;
  netPayable: number;
  outstanding: number;
}

interface PaymentLine {
  id: string;
  number: string;
  method: string;
  paymentDate: string;
  amount: number;
  reference: string | null;
  clearedAt: string | null;
}

type SupplierDetailData = SupplierRow & {
  contacts: SupplierContact[];
  createdAt: string;
  purchaseOrders?: PoLine[];
  receivings?: ReceivingLine[];
  bills?: BillLine[];
  payments?: PaymentLine[];
};

/** The partner flag as a pill — a classification, rendered through the one badge. */
function PartnerBadge() {
  return <StatusBadge status="PARTNER" extra={{ PARTNER: 'info' }} label="Partner" />;
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
    { key: 'code', label: 'Code', sortKey: 'code', render: (s) => <span className="mono">{s.code}</span> },
    {
      key: 'name',
      label: 'Supplier',
      sortKey: 'name',
      render: (s) => (
        <div>
          <div>
            {s.name}
            {s.isPartner && (
              <span className="m-inline">
                <PartnerBadge />
              </span>
            )}
          </div>
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
      render: (s) => <StatusBadge status={s.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />,
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

  const [supplier, setSupplier] = useState<SupplierDetailData | null>(null);
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
            {supplier.isPartner && (
              <span className="m-inline">
                <PartnerBadge />
              </span>
            )}
            {!supplier.isActive && (
              <span className="m-inline">
                <StatusBadge status="INACTIVE" extra={{ INACTIVE: 'danger' }} />
              </span>
            )}
          </p>
        </div>
        <div className="row">
          {supplier.isPartner && can('gops.partners.view_all') && (
            <Link className="btn btn-sm" to={`/g-ops/partners/${supplier.id}`}>
              Open in Sales › Partners
            </Link>
          )}
          {mayEdit && (
            <button className="btn" onClick={() => setEditing(true)}>
              Modify
            </button>
          )}
          {mayEdit && can('gchain.suppliers.delete') && (
            <button className="btn btn-danger" onClick={remove}>
              Delete
            </button>
          )}
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Details</h3>
          <dl className="m-details">
            <Detail label="Code" value={<span className="mono">{supplier.code}</span>} />
            <Detail label="Registered name" value={supplier.legalName} />
            <Detail label="TIN" value={supplier.tin} />
            <Detail label="Supplies" value={supplier.category} />
            <Detail label="Payment terms" value={supplier.paymentTerms} />
            {supplier.isPartner && <Detail label="Brand" value={supplier.brand} />}
            {supplier.isPartner && (
              <Detail
                label="Partner since"
                value={supplier.partnerSince ? formatDate(supplier.partnerSince) : null}
              />
            )}
            <Detail label="Added" value={formatDateTime(supplier.createdAt)} />
          </dl>
        </div>

        <div className="card">
          <h3 className="card-title">Contact</h3>
          <dl className="m-details">
            <Detail label="Address" value={supplier.address} />
            <Detail label="City" value={supplier.city} />
            <Detail label="Phone" value={supplier.phone} />
            <Detail label="Email" value={supplier.email} />
            <Detail label="Website" value={supplier.website} />
          </dl>
        </div>

        <div className="card m-span-all">
          <div className="m-card-head">
            <h3 className="card-title">People</h3>
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
                    {mayEdit && <th className="m-col-action" />}
                  </tr>
                </thead>
                <tbody>
                  {supplier.contacts.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.name}
                        {c.isPrimary && <span className="badge ok m-inline">primary</span>}
                      </td>
                      <td>{c.position ?? '—'}</td>
                      <td className="mono">{c.email ?? '—'}</td>
                      <td>{c.mobile ?? '—'}</td>
                      {mayEdit && (
                        <td className="m-col-action">
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

      </div>

      <div className="stack m-supplier-history">
        <Collection
          title="Purchase orders"
          count={(supplier.purchaseOrders ?? []).length}
          empty="Nothing ordered from this supplier yet."
          head={['Number', 'Ordered', 'Kind', 'For project', 'Deliver by', 'Total', 'Status']}
        >
          {(supplier.purchaseOrders ?? []).map((o) => (
            <tr key={o.id}>
              <td>
                <Link className="mono" to={`/g-chain/purchase-orders/${o.id}`}>
                  {o.number}
                </Link>
              </td>
              <td>{formatDate(o.orderDate)}</td>
              <td>{o.kind === 'DIRECT_TO_JOB' ? 'Direct to project' : 'Stock'}</td>
              <td>{o.job ? `${o.job.number} — ${o.job.name}` : '—'}</td>
              <td>{formatDate(o.deliveryDate)}</td>
              <td className="num">{formatMoney(o.total)}</td>
              <td>
                <StatusBadge status={o.status} />
              </td>
            </tr>
          ))}
        </Collection>

        <Collection
          title="Receiving"
          count={(supplier.receivings ?? []).length}
          empty="Nothing received from this supplier yet."
          head={['Number', 'Received', 'Against PO', 'Delivery ref.', 'Lines', 'Received by']}
        >
          {(supplier.receivings ?? []).map((r) => (
            <tr key={r.id}>
              <td>
                <Link className="mono" to={`/g-chain/receiving/${r.id}`}>
                  {r.number}
                </Link>
              </td>
              <td>{formatDate(r.receivedDate)}</td>
              <td className="mono">{r.order.number}</td>
              <td>{r.deliveryRefNo ?? '—'}</td>
              <td className="num">{r.lineCount}</td>
              <td>{r.receivedBy?.name ?? '—'}</td>
            </tr>
          ))}
        </Collection>

        <Collection
          title="Bills"
          count={(supplier.bills ?? []).length}
          empty="No bills from this supplier on record."
          head={['Number', 'Their invoice', 'Billed', 'Due', 'Net payable', 'Outstanding', 'Status']}
        >
          {(supplier.bills ?? []).map((b) => (
            <tr key={b.id}>
              <td>
                <Link className="mono" to={`/g-fin/ap/${b.id}`}>
                  {b.number}
                </Link>
              </td>
              <td>{b.supplierInvoiceNo ?? '—'}</td>
              <td>{formatDate(b.billDate)}</td>
              <td>{formatDate(b.dueDate)}</td>
              <td className="num">{formatMoney(b.netPayable)}</td>
              <td className="num">{formatMoney(b.outstanding)}</td>
              <td>
                <StatusBadge status={b.status} />
              </td>
            </tr>
          ))}
        </Collection>

        <Collection
          title="Payments"
          count={(supplier.payments ?? []).length}
          empty="Nothing paid to this supplier yet."
          head={['Number', 'Date', 'Method', 'Reference', 'Amount', 'Cleared']}
        >
          {(supplier.payments ?? []).map((p) => (
            <tr key={p.id}>
              <td>
                <Link className="mono" to={`/g-fin/payments?payment=${encodeURIComponent(p.id)}`}>
                  {p.number}
                </Link>
              </td>
              <td>{formatDate(p.paymentDate)}</td>
              <td>{humanise(p.method)}</td>
              <td>{p.reference ?? '—'}</td>
              <td className="num">{formatMoney(p.amount)}</td>
              <td>
                {p.clearedAt ? (
                  formatDate(p.clearedAt)
                ) : (
                  <StatusBadge status="UNCLEARED" extra={{ UNCLEARED: 'warn' }} label="Not cleared" />
                )}
              </td>
            </tr>
          ))}
        </Collection>
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
    brand: supplier?.brand ?? '',
    partnerSince: supplier?.partnerSince ? supplier.partnerSince.slice(0, 10) : '',
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
        brand: form.brand || null,
        partnerSince: form.partnerSince || null,
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
      <div className="grid grid-2">
        <Field label="Brand" hint="Trading name when it differs — Atlas Copco for Atlas Copco (Philippines) Inc.">
          <input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
        </Field>
        <Field
          label="Partner since"
          hint={
            supplier?.isPartner
              ? 'This supplier is a Sales partner'
              : 'Only meaningful once Sales adds this supplier under G-OPS › Partners'
          }
        >
          <input
            type="date"
            value={form.partnerSince}
            onChange={(e) => setForm({ ...form, partnerSince: e.target.value })}
          />
        </Field>
      </div>
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

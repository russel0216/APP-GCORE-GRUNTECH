import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { ImportModal, loadImportSpec } from '../../components/ImportModal';
import { Checkbox, ErrorBox, Field, Modal, StatusBadge, formatMoney, useToast } from '../../components/ui';
import type { Industry } from './Reference';

export interface CustomerRow {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  tin: string | null;
  industryId: string | null;
  industry: { id: string; code: string; name: string } | null;
  paymentTerms: string | null;
  creditLimit: number | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  notes: string | null;
  isActive: boolean;
  contactCount: number;
  siteCount: number;
  createdBy: { id: string; name: string } | null;
}

/**
 * The industry list, loaded once per screen. Any authenticated user may read
 * it — the customer form needs it under gops.customers.* alone.
 */
function useIndustries(activeOnly = false): Industry[] | null {
  const [rows, setRows] = useState<Industry[] | null>(null);
  useEffect(() => {
    api
      .get<Industry[]>(`/reference/industries${activeOnly ? '?active=true' : ''}`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [activeOnly]);
  return rows;
}

/** `HI Healthcare Industry`, or a faint "Unclassified" — never a blank cell. */
export function IndustryLabel({ industry }: { industry: CustomerRow['industry'] }) {
  if (!industry) return <span className="faint">Unclassified</span>;
  return (
    <>
      <span className="m-industry-code">{industry.code}</span>
      <span className="muted">{industry.name}</span>
    </>
  );
}

export function Customers() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const industries = useIndustries();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState<{ label: string; columns: never[] } | null>(null);
  const [reload, setReload] = useState(0);

  const columns: Column<CustomerRow>[] = [
    {
      key: 'name',
      label: 'Customer',
      sortKey: 'name',
      render: (c) => (
        <div>
          <div>{c.name}</div>
          {c.legalName && c.legalName !== c.name && <div className="faint">{c.legalName}</div>}
        </div>
      ),
    },
    { key: 'industry', label: 'Industry', render: (c) => <IndustryLabel industry={c.industry} /> },
    {
      key: 'contacts',
      label: 'Contacts',
      align: 'right',
      render: (c) => (c.contactCount === 0 ? <span className="faint">none</span> : c.contactCount),
    },
    {
      key: 'sites',
      label: 'Sites',
      align: 'right',
      render: (c) => (c.siteCount === 0 ? <span className="faint">none</span> : c.siteCount),
    },
    { key: 'paymentTerms', label: 'Terms', render: (c) => c.paymentTerms ?? '—', optional: true },
    {
      key: 'creditLimit',
      label: 'Credit limit',
      align: 'right',
      render: (c) => (c.creditLimit === null ? '—' : formatMoney(c.creditLimit)),
      optional: true,
    },
    { key: 'tin', label: 'TIN', render: (c) => <span className="mono">{c.tin ?? '—'}</span>, optional: true },
    { key: 'createdBy', label: 'Added by', render: (c) => c.createdBy?.name ?? '—', optional: true },
    {
      key: 'isActive',
      label: 'Status',
      render: (c) => <StatusBadge status={c.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Customers</h1>
          <p>
            One customer record, used by Sales, Projects, Procurement, Finance and Service. A
            customer can hold many contacts and many sites — a hospital group is one customer with
            one plant per location. Every customer is filed under an industry, so sales can be
            counted by the market they come from.
          </p>
        </div>
      </div>

      <DataList<CustomerRow>
        listKey="customers"
        endpoint="/customers"
        columns={columns}
        rowKey={(c) => c.id}
        scoped
        searchPlaceholder="Search name, code, TIN, or a contact's name…"
        reloadToken={reload}
        onRowClick={(c) => navigate(`/g-ops/customers/${c.id}`)}
        emptyTitle="No customers yet"
        emptyHint="Add the first one, or import a list you already have."
        filters={[
          {
            key: 'industry',
            label: 'Industry',
            options: [
              ...(industries ?? []).map((i) => ({ value: i.code, label: `${i.code} — ${i.name}` })),
              { value: 'none', label: 'Unclassified' },
            ],
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
            {can('gops.customers.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
                + Add customer
              </button>
            )}
            {can('gops.customers.create') && (
              <button
                className="btn btn-sm"
                onClick={async () => {
                  const spec = await loadImportSpec('customers');
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
        <CustomerForm
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            navigate(`/g-ops/customers/${id}`);
          }}
        />
      )}

      {importing && (
        <ImportModal
          entity="customers"
          label={importing.label}
          columns={importing.columns}
          onClose={() => setImporting(null)}
          onImported={() => setReload((r) => r + 1)}
        />
      )}
    </div>
  );
}

// ── Create / edit form ───────────────────────────────────────────────────────

export function CustomerForm({
  customer,
  onClose,
  onSaved,
}: {
  customer?: CustomerRow;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const allIndustries = useIndustries();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    code: customer?.code ?? '',
    name: customer?.name ?? '',
    legalName: customer?.legalName ?? '',
    tin: customer?.tin ?? '',
    industryId: customer?.industryId ?? '',
    paymentTerms: customer?.paymentTerms ?? '',
    creditLimit: customer?.creditLimit?.toString() ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    website: customer?.website ?? '',
    notes: customer?.notes ?? '',
    isActive: customer?.isActive ?? true,
  });

  // Show the code the system would assign, without consuming it. The preview
  // only fills the field while it is empty or still holds the last preview —
  // a code somebody typed is theirs and is never overwritten.
  const preview = useRef('');
  useEffect(() => {
    if (customer) return;
    api
      .get<{ code: string }>('/customers/next-code')
      .then((r) =>
        setForm((f) => {
          const untouched = !f.code || f.code === preview.current;
          preview.current = r.code;
          return untouched ? { ...f, code: r.code } : f;
        }),
      )
      .catch(() => {});
  }, [customer]);

  // Offered: the active industries, plus the one this customer already has
  // even if it has since been deactivated — otherwise the select would show a
  // blank and a save would silently reclassify.
  const industries = (allIndustries ?? []).filter((i) => i.isActive || i.id === form.industryId);
  const noIndustries = allIndustries !== null && industries.length === 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        code: form.code || undefined,
        name: form.name,
        legalName: form.legalName || null,
        tin: form.tin || null,
        industryId: form.industryId,
        paymentTerms: form.paymentTerms || null,
        creditLimit: form.creditLimit === '' ? null : Number(form.creditLimit),
        phone: form.phone || null,
        email: form.email || null,
        website: form.website || null,
        notes: form.notes || null,
        isActive: form.isActive,
      };
      const saved = customer
        ? await api.patch<{ id: string }>(`/customers/${customer.id}`, payload)
        : await api.post<{ id: string }>('/customers', payload);
      toast('ok', `${form.name} saved`);
      onSaved(saved.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const industryHint = noIndustries
    ? 'No industries are set up yet — an administrator adds them under Admin › Categories.'
    : customer && !customer.industryId
      ? 'Not classified yet — pick the one that fits. GI (General) covers anything else.'
      : 'HI Healthcare · BI Building · UI Utility · GI General · SI Special';

  return (
    <Modal
      wide
      title={customer ? `Modify ${customer.name}` : 'Add customer'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || form.name.length < 2 || !form.industryId}
            title={!form.industryId ? 'Choose an industry first' : undefined}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      <div className="grid grid-2">
        <Field label="Customer name" required>
          <input
            value={form.name}
            autoFocus
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Code" hint="Auto-generated — override it if you have your own scheme">
          <input className="mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </Field>
        <Field label="Industry" hint={industryHint} required>
          <select
            value={form.industryId}
            disabled={noIndustries}
            onChange={(e) => setForm({ ...form, industryId: e.target.value })}
          >
            <option value="">— choose —</option>
            {industries.map((i) => (
              <option key={i.id} value={i.id}>
                {i.code} — {i.name}
                {i.isActive ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Registered / legal name" hint="Appears on invoices when it differs">
          <input value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
        </Field>
        <Field label="TIN">
          <input value={form.tin} onChange={(e) => setForm({ ...form, tin: e.target.value })} />
        </Field>
        <Field label="Payment terms" hint="e.g. 30 days, or 30% down and balance on turnover">
          <input
            value={form.paymentTerms}
            onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })}
          />
        </Field>
        <Field label="Credit limit">
          <input
            type="number"
            value={form.creditLimit}
            onChange={(e) => setForm({ ...form, creditLimit: e.target.value })}
          />
        </Field>
        <Field label="Phone">
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Field label="Website">
          <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
        </Field>
      </div>

      <Field label="Notes">
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>

      <Checkbox
        checked={form.isActive}
        onChange={(v) => setForm({ ...form, isActive: v })}
        label="Active — inactive customers stay on past records but cannot be picked for new work"
      />
    </Modal>
  );
}

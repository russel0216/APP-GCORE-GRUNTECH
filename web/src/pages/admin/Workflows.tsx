import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, Modal, formatMoney, useToast } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';

interface Step {
  id?: string;
  sequence: number;
  name: string;
  approverType: 'ROLE' | 'USER' | 'SUPERVISOR' | 'HR' | 'PROJECT_MANAGER';
  roleId: string | null;
  userId: string | null;
  role?: { id: string; name: string } | null;
  user?: { id: string; name: string } | null;
  /** Active people who would receive this step; null when it depends on the requester. */
  approverCount?: number | null;
}

interface Workflow {
  id: string;
  documentType: string;
  name: string;
  isActive: boolean;
  minAmount: number | null;
  maxAmount: number | null;
  /** Set: an optional route the submitter may tick, under this label. */
  optionLabel: string | null;
  steps: Step[];
  requestCount: number;
}

interface DocType {
  type: string;
  code: string;
  label: string;
}

const APPROVER_LABELS: Record<Step['approverType'], string> = {
  SUPERVISOR: 'The requester’s supervisor',
  PROJECT_MANAGER: 'The project’s manager',
  HR: 'HR',
  ROLE: 'Anyone with a role',
  USER: 'One specific person',
};

export function Workflows() {
  const { can } = useAuth();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [docTypes, setDocTypes] = useState<DocType[]>([]);
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Workflow | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [w, d, r, u] = await Promise.all([
        api.get<Workflow[]>('/workflows'),
        api.get<DocType[]>('/workflows/document-types'),
        api.get<{ id: string; name: string }[]>('/roles'),
        api.get<{ rows: { id: string; name: string }[] }>('/users?pageSize=200'),
      ]);
      setWorkflows(w);
      setDocTypes(d);
      setRoles(r);
      setPeople(u.rows);
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

  if (loading) return <Loading />;

  const grouped = new Map<string, Workflow[]>();
  for (const w of workflows) {
    const list = grouped.get(w.documentType) ?? [];
    list.push(w);
    grouped.set(w.documentType, list);
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Approval Workflows</h1>
          <p>
            One engine routes every document type. Bands by amount are how thresholds work — a
            request under ₱50,000 can take a short route while a larger one collects more signatures.
            A requester can never approve their own document, whatever the routing says.
          </p>
        </div>
        {can('admin.workflows.create') && (
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            + Add workflow
          </button>
        )}
      </div>

      <ErrorBox error={error} />

      {[...grouped.entries()].map(([docType, list]) => (
        <div key={docType} style={{ marginBottom: 18 }}>
          <h3 className="card-title">{docTypes.find((d) => d.type === docType)?.label ?? docType}</h3>
          <div className="grid grid-2">
            {list.map((w) => (
              // A button, not a div: opening a workflow to edit it was
              // mouse-only, on the screen where approval routing is decided.
              <button
                type="button"
                key={w.id}
                className="card clickable card-button"
                onClick={() => setEditing(w)}
              >
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong>{w.name}</strong>
                  <span className="row" style={{ gap: 'var(--s-1)' }}>
                    {w.optionLabel && <span className="badge info">option</span>}
                    <span className={`badge ${w.isActive ? 'ok' : ''}`}>
                      {w.isActive ? 'active' : 'inactive'}
                    </span>
                  </span>
                </div>
                {w.optionLabel && <div className="faint">Offered as “{w.optionLabel}”</div>}
                <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px' }}>
                  {w.minAmount === null && w.maxAmount === null
                    ? 'Any amount'
                    : `${w.minAmount !== null ? formatMoney(w.minAmount) : 'Up to'} ${
                        w.minAmount !== null && w.maxAmount !== null ? '–' : ''
                      } ${w.maxAmount !== null ? formatMoney(w.maxAmount) : 'and above'}`}
                </div>
                <div className="stack" style={{ gap: 5 }}>
                  {w.steps.map((s) => (
                    <div key={s.sequence} className="row" style={{ gap: 8, fontSize: 12 }}>
                      <span className="step-num" style={{ width: 22, height: 22, fontSize: 11 }}>
                        {s.sequence}
                      </span>
                      <span>{s.name}</span>
                      <span className="faint">
                        →{' '}
                        {s.approverType === 'SUPERVISOR'
                          ? `${APPROVER_LABELS.SUPERVISOR}, else ${s.role?.name ?? 'HR'}`
                          : s.approverType === 'PROJECT_MANAGER'
                            ? `${APPROVER_LABELS.PROJECT_MANAGER}, else ${s.role?.name ?? 'Executive / Management'}`
                            : (s.role?.name ?? s.user?.name ?? APPROVER_LABELS[s.approverType])}
                      </span>
                      {s.approverCount === 0 && (
                        <span className="badge danger" title="Documents reaching this step would stall">
                          no one holds this
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                {w.steps.some((s) => s.approverCount === 0) && (
                  <div className="alert error" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
                    A step routes to nobody. Documents reaching it will stall until someone is given
                    that role.
                  </div>
                )}

                <div className="faint" style={{ fontSize: 11, marginTop: 10 }}>
                  {w.requestCount} request{w.requestCount === 1 ? '' : 's'} routed
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}

      {editing && (
        <WorkflowEditor
          workflow={editing === 'new' ? null : editing}
          docTypes={docTypes}
          roles={roles}
          people={people}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function WorkflowEditor({
  workflow,
  docTypes,
  roles,
  people,
  onClose,
  onSaved,
}: {
  workflow: Workflow | null;
  docTypes: DocType[];
  roles: { id: string; name: string }[];
  people: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const [documentType, setDocumentType] = useState(workflow?.documentType ?? docTypes[0]?.type ?? '');
  const [name, setName] = useState(workflow?.name ?? '');
  const [isActive, setIsActive] = useState(workflow?.isActive ?? true);
  const [minAmount, setMinAmount] = useState(workflow?.minAmount?.toString() ?? '');
  const [maxAmount, setMaxAmount] = useState(workflow?.maxAmount?.toString() ?? '');
  const [optionLabel, setOptionLabel] = useState(workflow?.optionLabel ?? '');
  const [steps, setSteps] = useState<Step[]>(
    workflow?.steps.map((s) => ({ ...s })) ?? [
      { sequence: 1, name: 'Approval', approverType: 'SUPERVISOR', roleId: null, userId: null },
    ],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function update(index: number, patch: Partial<Step>) {
    setSteps((s) => s.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  }

  function addStep() {
    setSteps((s) => [
      ...s,
      {
        sequence: s.length + 1,
        name: 'Approval',
        approverType: 'ROLE',
        roleId: roles[0]?.id ?? null,
        userId: null,
      },
    ]);
  }

  function removeStep(index: number) {
    setSteps((s) => s.filter((_, i) => i !== index).map((step, i) => ({ ...step, sequence: i + 1 })));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        documentType,
        name,
        isActive,
        minAmount: minAmount === '' ? null : Number(minAmount),
        maxAmount: maxAmount === '' ? null : Number(maxAmount),
        optionLabel: optionLabel.trim() || null,
        steps: steps.map((s) => ({
          sequence: s.sequence,
          name: s.name,
          approverType: s.approverType,
          roleId: s.roleId,
          userId: s.userId,
        })),
      };
      if (workflow) await api.put(`/workflows/${workflow.id}`, payload);
      else await api.post('/workflows', payload);
      toast('ok', `${name} saved`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove() {
    if (!workflow) return;
    setBusy(true);
    try {
      await api.del(`/workflows/${workflow.id}`);
      toast('ok', 'Workflow deleted');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={workflow ? `Modify ${workflow.name}` : 'Add workflow'}
      onClose={onClose}
      footer={
        <>
          {workflow && can('admin.workflows.delete') && (
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

      <div className="grid grid-2">
        <Field label="Document type">
          <select value={documentType} onChange={(e) => setDocumentType(e.target.value)} disabled={!!workflow}>
            {docTypes.map((d) => (
              <option key={d.type} value={d.type}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Workflow name">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Applies from (amount)" hint="Blank = no lower bound">
          <NumberInput kind="money" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} />
        </Field>
        <Field label="Applies up to (amount)" hint="Blank = no upper bound">
          <NumberInput kind="money" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} />
        </Field>
        <Field
          label="Offer as an option"
          hint="Blank = a standard route, taken by amount. A label (e.g. Add the CEO as approver) makes it a choice the submitter ticks."
        >
          <input value={optionLabel} maxLength={120} onChange={(e) => setOptionLabel(e.target.value)} />
        </Field>
      </div>

      <label className="checkbox" style={{ marginBottom: 16 }}>
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        <span>Active</span>
      </label>

      <hr className="rule" />

      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>Steps</strong>
        <button className="btn btn-sm" onClick={addStep}>
          + Add step
        </button>
      </div>

      {steps.map((step, i) => (
        <div key={i} className="step-row">
          <div className="step-num">{step.sequence}</div>
          <input
            value={step.name}
            placeholder="Step name"
            onChange={(e) => update(i, { name: e.target.value })}
          />
          <select
            value={step.approverType}
            onChange={(e) =>
              update(i, {
                approverType: e.target.value as Step['approverType'],
                roleId: e.target.value === 'ROLE' ? (roles[0]?.id ?? null) : null,
                userId: e.target.value === 'USER' ? (people[0]?.id ?? null) : null,
              })
            }
          >
            {(Object.keys(APPROVER_LABELS) as Step['approverType'][]).map((t) => (
              <option key={t} value={t}>
                {APPROVER_LABELS[t]}
              </option>
            ))}
          </select>

          {step.approverType === 'ROLE' ? (
            <select value={step.roleId ?? ''} onChange={(e) => update(i, { roleId: e.target.value })}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          ) : step.approverType === 'USER' ? (
            <select value={step.userId ?? ''} onChange={(e) => update(i, { userId: e.target.value })}>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : step.approverType === 'SUPERVISOR' ? (
            /* Who decides when the requester has no "Reports to" — HR unless a role is named. */
            <select
              value={step.roleId ?? ''}
              aria-label="When no supervisor is set"
              onChange={(e) => update(i, { roleId: e.target.value || null })}
            >
              <option value="">No supervisor set: HR</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  No supervisor set: {r.name}
                </option>
              ))}
            </select>
          ) : step.approverType === 'PROJECT_MANAGER' ? (
            /* The project's manager decides; when the project has none, or the manager raised it, this role does. */
            <select
              value={step.roleId ?? ''}
              aria-label="When the project has no manager, or the manager raised it"
              onChange={(e) => update(i, { roleId: e.target.value || null })}
            >
              <option value="">No project manager, or their own request: Executive / Management</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  No project manager, or their own request: {r.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="faint" style={{ fontSize: 12 }}>
              Everyone holding the HR role
            </span>
          )}

          <button
            className="btn btn-ghost btn-sm"
            onClick={() => removeStep(i)}
            disabled={steps.length === 1}
            aria-label="Remove step"
          >
            ✕
          </button>
        </div>
      ))}

      <div className="alert info" style={{ marginTop: 16, marginBottom: 0 }}>
        Steps run in order — the document only moves on once the current step approves. Overtime uses
        two steps (supervisor, then HR) because the cost must not reach a project budget until both
        have signed off.
      </div>
    </Modal>
  );
}

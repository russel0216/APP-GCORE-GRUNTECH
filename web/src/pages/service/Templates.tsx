import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Checkbox,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  StatusBadge,
  formatMoney,
  useToast,
} from '../../components/ui';
import { Stat } from '../../components/charts';
import { KINDS, type Template, type TemplateField, type TemplateSection } from './Reports';

/**
 * Report templates — "report templates are data" (model §4.5).
 *
 * A service engineer builds the form: sections, fields, which are required,
 * which allow photos. A template nobody has used is edited in place. One that
 * reports have been written against is **immutable** — editing publishes a new
 * version, and every old report keeps rendering the way it was signed.
 */

const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / no' },
  { value: 'pass_fail', label: 'Pass / fail' },
  { value: 'select', label: 'Choose one' },
  { value: 'date', label: 'Date' },
  { value: 'note', label: 'Long note' },
];

/** A key a human did not have to think about, derived from the label. */
function slug(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40) || 'field';
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}

export function ReportTemplates() {
  const { can } = useAuth();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTemplates(await api.get<Template[]>(`/report-templates${showAll ? '?all=true' : ''}`));
    } catch (err) {
      setError(err);
    }
  }, [showAll]);

  useEffect(() => {
    load();
  }, [load]);

  const editable = can('gops.pm_reports.create');

  if (error) return <ErrorBox error={error} />;
  if (!templates) return <Loading />;

  const byKind = KINDS.map((k) => ({
    kind: k,
    rows: templates.filter((t) => t.kind === k.value),
  })).filter((g) => g.rows.length > 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Report Templates</h1>
          <p>
            The forms your engineers fill in on site. Change them to suit the work — a template
            that has already been used publishes a new version rather than changing underneath the
            reports that were signed on it.
          </p>
        </div>
        <div className="row">
          <Checkbox checked={showAll} onChange={setShowAll} label="Show old versions" />
          {editable && (
            <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
              + New template
            </button>
          )}
        </div>
      </div>

      {templates.length === 0 ? (
        <Empty
          title="No templates yet"
          hint="A service report needs a form to be written on. Create one, or re-run the seed to get the starting set."
        />
      ) : (
        byKind.map((group) => (
          <div key={group.kind.value} className="card">
            <h3 className="card-title">{group.kind.label}</h3>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Template</th>
                    <th className="right">Version</th>
                    <th className="right">Sections</th>
                    <th className="right">Used by</th>
                    <th>State</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div>{t.name}</div>
                        {t.description && <div className="faint">{t.description}</div>}
                      </td>
                      <td className="right mono">v{t.version}</td>
                      <td className="right mono">{t.sections.length}</td>
                      <td className="right mono">{t._count?.reports ?? 0}</td>
                      <td>
                        {t.isCurrent ? (
                          <span className="badge ok">current</span>
                        ) : (
                          <span className="badge">superseded</span>
                        )}
                      </td>
                      <td className="right">
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditing(t)}>
                          {editable && t.isCurrent ? 'Modify' : 'View'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {editing && (
        <TemplateEditor
          template={editing === 'new' ? null : editing}
          readOnly={editing !== 'new' && (!editable || !editing.isCurrent)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function TemplateEditor({
  template,
  readOnly,
  onClose,
  onSaved,
}: {
  template: Template | null;
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [kind, setKind] = useState(template?.kind ?? 'PREVENTIVE_MAINTENANCE');
  const [name, setName] = useState(template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [sections, setSections] = useState<TemplateSection[]>(
    template?.sections ?? [{ key: 'section_1', title: 'Checks', allowPhotos: false, fields: [] }],
  );

  const used = (template?._count?.reports ?? 0) > 0;

  function patchSection(i: number, patch: Partial<TemplateSection>) {
    setSections((s) => s.map((sec, j) => (j === i ? { ...sec, ...patch } : sec)));
  }

  function patchField(si: number, fi: number, patch: Partial<TemplateField>) {
    setSections((s) =>
      s.map((sec, j) =>
        j === si ? { ...sec, fields: sec.fields.map((f, k) => (k === fi ? { ...f, ...patch } : f)) } : sec,
      ),
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = { kind, name, description: description || null, sections };
      if (template) {
        const saved = await api.put<{ newVersion: boolean; version: number }>(
          `/report-templates/${template.id}`,
          payload,
        );
        toast(
          'ok',
          saved.newVersion
            ? `Published v${saved.version} — reports signed on v${template.version} are untouched`
            : 'Saved',
        );
      } else {
        await api.post('/report-templates', payload);
        toast('ok', 'Template created');
      }
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function duplicate() {
    if (!template) return;
    setBusy(true);
    try {
      await api.post(`/report-templates/${template.id}/duplicate`, { name: `${template.name} (copy)` });
      toast('ok', 'Copied — edit the copy freely');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={template ? `${template.name} v${template.version}` : 'New template'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {template && (
            <button className="btn btn-sm" onClick={duplicate} disabled={busy}>
              Duplicate
            </button>
          )}
          {!readOnly && (
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={busy || name.trim().length < 2 || sections.some((s) => s.fields.length === 0)}
            >
              {busy ? 'Saving…' : used ? 'Publish new version' : 'Save'}
            </button>
          )}
        </>
      }
    >
      <ErrorBox error={error} />

      {used && !readOnly && (
        <div className="alert warn">
          {template!._count!.reports} report{template!._count!.reports === 1 ? ' has' : 's have'} been
          written on this template, so it cannot change underneath them. Saving publishes{' '}
          <strong>v{template!.version + 1}</strong> for new reports and leaves v{template!.version}{' '}
          exactly as it was signed.
        </div>
      )}
      {readOnly && (
        <div className="alert info">
          This version is superseded. It is kept so the reports signed on it still render the way
          they were signed. Duplicate it to start something new.
        </div>
      )}

      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid grid-2">
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Kind of report">
            <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={!!template}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="What is it for?">
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        {sections.map((section, si) => (
          <div key={si} className="card" style={{ marginTop: 14 }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <input
                value={section.title}
                onChange={(e) =>
                  patchSection(si, {
                    title: e.target.value,
                    key: template ? section.key : slug(e.target.value, new Set(sections.filter((_, j) => j !== si).map((s) => s.key))),
                  })
                }
                style={{ fontWeight: 600, maxWidth: 320 }}
              />
              <div className="row">
                <Checkbox
                  checked={section.allowPhotos ?? false}
                  onChange={(v) => patchSection(si, { allowPhotos: v })}
                  label="Photos"
                />
                {sections.length > 1 && !readOnly && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setSections(sections.filter((_, j) => j !== si))}
                  >
                    Remove section
                  </button>
                )}
              </div>
            </div>

            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th style={{ width: 150 }}>Type</th>
                    <th style={{ width: 150 }}>Options / unit</th>
                    <th style={{ width: 90 }}>Required</th>
                    <th style={{ width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {section.fields.map((field, fi) => (
                    <tr key={fi}>
                      <td>
                        <input
                          value={field.label}
                          onChange={(e) =>
                            patchField(si, fi, {
                              label: e.target.value,
                              key: template
                                ? field.key
                                : slug(
                                    e.target.value,
                                    new Set(section.fields.filter((_, k) => k !== fi).map((f) => f.key)),
                                  ),
                            })
                          }
                        />
                      </td>
                      <td>
                        <select
                          value={field.type}
                          onChange={(e) =>
                            patchField(si, fi, { type: e.target.value as TemplateField['type'] })
                          }
                        >
                          {FIELD_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {field.type === 'select' ? (
                          <input
                            value={(field.options ?? []).join(', ')}
                            placeholder="Clean, Cleaned, Replaced"
                            onChange={(e) =>
                              patchField(si, fi, {
                                options: e.target.value
                                  .split(',')
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              })
                            }
                          />
                        ) : field.type === 'number' ? (
                          <input
                            value={field.unit ?? ''}
                            placeholder="bar, %, °C"
                            onChange={(e) => patchField(si, fi, { unit: e.target.value || undefined })}
                          />
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={field.required ?? false}
                          onChange={(e) => patchField(si, fi, { required: e.target.checked })}
                        />
                      </td>
                      <td className="right">
                        {!readOnly && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() =>
                              patchSection(si, { fields: section.fields.filter((_, k) => k !== fi) })
                            }
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!readOnly && (
              <button
                className="btn btn-sm"
                style={{ marginTop: 8 }}
                onClick={() => {
                  const taken = new Set(section.fields.map((f) => f.key));
                  patchSection(si, {
                    fields: [
                      ...section.fields,
                      { key: slug(`field ${section.fields.length + 1}`, taken), label: '', type: 'text' },
                    ],
                  });
                }}
              >
                + Add a field
              </button>
            )}
            {section.fields.length === 0 && (
              <div className="alert warn" style={{ marginTop: 10, marginBottom: 0 }}>
                A section with no fields cannot be saved.
              </div>
            )}
          </div>
        ))}

        {!readOnly && (
          <button
            className="btn btn-sm"
            style={{ marginTop: 14 }}
            onClick={() => {
              const taken = new Set(sections.map((s) => s.key));
              setSections([
                ...sections,
                { key: slug(`section ${sections.length + 1}`, taken), title: '', allowPhotos: false, fields: [] },
              ]);
            }}
          >
            + Add a section
          </button>
        )}
      </fieldset>
    </Modal>
  );
}

// ── The aftermarket dashboard ────────────────────────────────────────────────

interface Dashboard {
  asOf: string;
  installedBase: {
    total: number;
    inWarranty: number;
    warrantyExpiring: number;
    outOfWarranty: number;
    uncovered: number;
  };
  contracts: { active: number; expiring: number };
  visits: { overdue: number; thisMonth: number; missed: number };
  reportsPending: number;
  warningDays: number;
}

export function AftermarketDashboard() {
  const [tab, setTab] = useState<'overview' | 'rules'>('overview');
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.get<Dashboard>('/aftermarket/dashboard').then(setData).catch(setError);
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  if (tab === 'rules') {
    return (
      <div>
        <div className="scope-switch" style={{ marginBottom: 16 }}>
          <button onClick={() => setTab('overview')}>Overview</button>
          <button className="active">Rules</button>
        </div>
        <AftermarketSettings />
      </div>
    );
  }

  const tiles = [
    {
      label: 'Machines installed',
      value: data.installedBase.total,
      sub: `${data.installedBase.inWarranty} still in warranty`,
      to: '/g-ops/installed-base',
    },
    {
      label: 'Not covered',
      value: data.installedBase.uncovered,
      sub: 'no active service contract',
      tone: data.installedBase.uncovered > 0 ? 'var(--warn)' : undefined,
      to: '/g-ops/installed-base?uncovered=true',
    },
    {
      label: 'Active contracts',
      value: data.contracts.active,
      sub: `${data.contracts.expiring} ending within ${data.warningDays} days`,
      tone: data.contracts.expiring > 0 ? 'var(--warn)' : 'var(--neon)',
      to: '/g-ops/service-contracts?status=ACTIVE',
    },
    {
      label: 'Visits overdue',
      value: data.visits.overdue,
      sub: `${data.visits.thisMonth} more due this month`,
      tone: data.visits.overdue > 0 ? 'var(--danger)' : undefined,
      // The list, not the month grid: "overdue" is a list of things to chase.
      to: '/g-ops/visits?mode=list&due=true',
    },
  ];

  return (
    <div>
      <div className="scope-switch" style={{ marginBottom: 16 }}>
        <button className="active">Overview</button>
        <button onClick={() => setTab('rules')}>Rules</button>
      </div>

      <div className="page-head">
        <div>
          <h1>Aftermarket</h1>
          <p>
            What Gruntech has in the field, what covers it, and what is due. Equipment nothing
            covers and warranties about to lapse are the renewal pipeline.
          </p>
        </div>
      </div>

      <div className="kpi-grid svc-kpis">
        {tiles.map((t) => (
          <Stat key={t.label} label={t.label} value={t.value} hint={t.sub} tone={t.tone} to={t.to} />
        ))}
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Warranty</h3>
          <dl className="kv">
            <dt>In warranty</dt>
            <dd className="mono">{data.installedBase.inWarranty}</dd>
            <dt>Expiring within {data.warningDays} days</dt>
            <dd className="mono">
              <span className={data.installedBase.warrantyExpiring > 0 ? 'warn' : ''}>
                {data.installedBase.warrantyExpiring}
              </span>
            </dd>
            <dt>Out of warranty</dt>
            <dd className="mono">{data.installedBase.outOfWarranty}</dd>
          </dl>
          <p className="faint" style={{ marginTop: 12, marginBottom: 0 }}>
            A machine leaving warranty with nothing behind it is a customer about to start paying
            for what they got free. <Link to="/g-ops/renewals">See the renewal pipeline.</Link>
          </p>
        </div>

        <div className="card">
          <h3 className="card-title">Work</h3>
          <dl className="kv">
            <dt>Visits overdue</dt>
            <dd className="mono">
              <span className={data.visits.overdue > 0 ? 'warn' : ''}>{data.visits.overdue}</span>
            </dd>
            <dt>Due later this month</dt>
            <dd className="mono">{data.visits.thisMonth}</dd>
            <dt>Missed</dt>
            <dd className="mono">
              <span className={data.visits.missed > 0 ? 'warn' : ''}>{data.visits.missed}</span>
            </dd>
            <dt>Reports awaiting approval</dt>
            <dd className="mono">{data.reportsPending}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}

// ── Service costing ──────────────────────────────────────────────────────────

/**
 * Service costing is the costing screen narrowed to contracts.
 *
 * A service costing is not a different kind of record — it is a costing whose
 * job happens to be a service contract (model §4.5). Giving it a second table
 * would give it a second place to drift out of step.
 */
export function ServiceCosting() {
  const [rows, setRows] = useState<
    {
      id: string;
      number: string;
      title: string;
      status: string;
      contractValue: number;
      totalCost: number;
      customer: { id: string; name: string } | null;
      owner: { id: string; name: string };
    }[]
  >([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ rows: typeof rows }>('/costings?jobType=SERVICE_CONTRACT&pageSize=100')
      .then((d) => setRows(d.rows))
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Service Costing</h1>
          <p>
            The costings behind service contracts — visits, engineers, consumables and travel,
            priced the same way a project is. This is the ordinary costing screen, narrowed: a
            service costing is a costing whose job is a contract.
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <Empty
          title="No service costings yet"
          hint="Cost a contract from Costing, then create the job as a service contract."
        />
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Title</th>
                  <th>Customer</th>
                  <th className="right">Cost</th>
                  <th className="right">Contract</th>
                  <th className="right">Margin</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const margin =
                    c.contractValue > 0 ? ((c.contractValue - c.totalCost) / c.contractValue) * 100 : 0;
                  return (
                    <tr key={c.id}>
                      <td>
                        <Link to={`/g-ops/costing/${c.id}`} className="mono">
                          {c.number}
                        </Link>
                      </td>
                      <td>{c.title}</td>
                      <td className="faint">{c.customer?.name ?? '—'}</td>
                      <td className="right mono">{formatMoney(c.totalCost)}</td>
                      <td className="right mono">{formatMoney(c.contractValue)}</td>
                      <td className="right mono">{margin.toFixed(1)}%</td>
                      <td>
                        <StatusBadge status={c.status} extra={{ FINAL: 'ok' }} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

export function AftermarketSettings() {
  const { can } = useAuth();
  const toast = useToast();
  const editable = can('gops.service_contracts.edit_all');
  const [settings, setSettings] = useState<{
    expiryWarningDays: number;
    defaultWarrantyMonths: number;
    defaultFrequencyMonths: number;
    missedAfterDays: number;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<NonNullable<typeof settings>>('/aftermarket/settings').then(setSettings).catch(setError);
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!settings) return <Loading />;

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await api.put<NonNullable<typeof settings>>('/aftermarket/settings', settings));
      toast('ok', 'Aftermarket rules saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof NonNullable<typeof settings>, value: number) =>
    setSettings({ ...settings, [key]: value });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Aftermarket Rules</h1>
          <p>How long a warranty runs, how often equipment is visited, and how far ahead expiry is flagged.</p>
        </div>
        {editable && (
          <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save rules'}
          </button>
        )}
      </div>

      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid grid-2">
          <div className="card">
            <h3 className="card-title">Defaults</h3>
            <Field
              label="Warranty length (months)"
              hint="Applied from the install date when nobody types an end date"
            >
              <input
                type="number"
                min={0}
                max={240}
                value={settings.defaultWarrantyMonths}
                onChange={(e) => set('defaultWarrantyMonths', Number(e.target.value))}
              />
            </Field>
            <Field label="Months between PM visits" hint="3 is quarterly — the usual for a plant">
              <input
                type="number"
                min={1}
                max={24}
                value={settings.defaultFrequencyMonths}
                onChange={(e) => set('defaultFrequencyMonths', Number(e.target.value))}
              />
            </Field>
          </div>

          <div className="card">
            <h3 className="card-title">Warnings</h3>
            <Field
              label="Flag expiry this far ahead (days)"
              hint="How much notice the renewal pipeline gives you"
            >
              <input
                type="number"
                min={1}
                max={365}
                value={settings.expiryWarningDays}
                onChange={(e) => set('expiryWarningDays', Number(e.target.value))}
              />
            </Field>
            <Field
              label="A visit counts as missed after (days)"
              hint="Past its due date with nobody attending"
            >
              <input
                type="number"
                min={0}
                max={180}
                value={settings.missedAfterDays}
                onChange={(e) => set('missedAfterDays', Number(e.target.value))}
              />
            </Field>
            <div className="alert info" style={{ marginBottom: 0 }}>
              Expired contracts and missed visits are worked out when these screens load, not by a
              nightly job. A status that is only correct when a scheduler ran is worse than one
              derived on read.
            </div>
          </div>
        </div>
      </fieldset>

    </div>
  );
}

import { useCallback, useEffect, useId, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Checkbox, ErrorBox, Field, Loading, Modal, ModalFoot, useToast } from '../../components/ui';
import type { LeaveType } from './Leave';
import { ProbationCard } from './settings/ProbationCard';
import { ClearanceChecklistCard } from './settings/ClearanceChecklistCard';
import { AcademyCard } from './settings/AcademyCard';
import { GreetingsCard } from './settings/GreetingsCard';
import { FaceHealthPanel } from './settings/FaceHealthPanel';
import { NumberInput } from '../../components/NumberInput';

/**
 * HR settings — the working day, the breaks, the overtime premium, the leave
 * allotments and the face-match threshold.
 *
 * None of these belong in code. The working day differs by site, the premium
 * is a legal minimum somebody may choose to beat, and the match threshold is a
 * judgement about how often a genuine person is turned away versus how often a
 * stranger gets through. HR owns all of it.
 *
 * Below them sit the cards other rules live on — probation and evaluations,
 * the clearance checklist, the Academy. Each loads and saves its own keys, so
 * the Save under the working rules never writes over one of them. Every card
 * that saves on its own has its Save at its foot, on the right.
 */

interface HrSettings {
  workStart: string;
  workEnd: string;
  graceMinutes: number;
  breakMinutes: number;
  dinnerBreakStart: string;
  dinnerBreakEnd: string;
  dinnerBreakMinutes: number;
  overtimeMultiplier: number;
  hoursPerDay: number;
  faceThreshold: number;
  /** A capture must answer a blink-or-turn challenge (the liveness check). */
  faceLiveness: boolean;
}

/**
 * The keys the form on this page edits, and so the only keys it sends.
 * `GET /hr-settings` also returns the probation rules, which ProbationCard
 * saves on its own; PUTting the whole object loaded at mount would write
 * those stale values back over a change just saved on that card.
 */
const EDITED_KEYS = [
  'workStart',
  'workEnd',
  'graceMinutes',
  'breakMinutes',
  'dinnerBreakStart',
  'dinnerBreakEnd',
  'dinnerBreakMinutes',
  'overtimeMultiplier',
  'hoursPerDay',
  'faceThreshold',
  'faceLiveness',
] as const satisfies readonly (keyof HrSettings)[];

function edited(s: HrSettings): HrSettings {
  return Object.fromEntries(EDITED_KEYS.map((k) => [k, s[k]])) as unknown as HrSettings;
}

export function HrSettingsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const editable = can('ghr.settings.edit_all');
  const livenessHintId = useId();

  const [settings, setSettings] = useState<HrSettings | null>(null);
  const [types, setTypes] = useState<LeaveType[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [editingType, setEditingType] = useState<Partial<LeaveType> | null>(null);
  /** Bumped by a save, so Face health reads the threshold just saved. */
  const [saved, setSaved] = useState(0);

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([
        api.get<HrSettings>('/hr-settings'),
        api.get<LeaveType[]>('/leave/types'),
      ]);
      setSettings(edited(s));
      setTypes(t);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(edited(await api.put<HrSettings>('/hr-settings', edited(settings))));
      setSaved((n) => n + 1);
      toast('ok', 'HR rules saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!settings || !types) return <Loading label="Loading HR rules…" />;

  const set = <K extends keyof HrSettings>(key: K, value: HrSettings[K]) =>
    setSettings({ ...settings, [key]: value });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>HR Settings</h1>
          <p>
            The rules every attendance, leave and overtime calculation runs on. Changing one
            affects entries made from now on — it does not rewrite what has already been recorded.
          </p>
        </div>
      </div>

      <ErrorBox error={error} />

      {!editable && (
        <div className="alert info">
          You can see these rules but not change them. That needs{' '}
          <span className="mono">ghr.settings.edit_all</span>.
        </div>
      )}

      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid grid-3">
          <div className="card">
            <h3 className="card-title">The working day</h3>
            <div className="grid grid-2">
              <Field label="Starts">
                <input
                  type="time"
                  value={settings.workStart}
                  onChange={(e) => set('workStart', e.target.value)}
                />
              </Field>
              <Field label="Ends">
                <input
                  type="time"
                  value={settings.workEnd}
                  onChange={(e) => set('workEnd', e.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Grace period (minutes)"
              hint="Arriving within this of the start time is not counted as late"
            >
              <NumberInput
                kind="count"
                min={0}
                max={120}
                value={settings.graceMinutes}
                onChange={(e) => set('graceMinutes', Number(e.target.value))}
              />
            </Field>
            <Field
              label="Unpaid break (minutes)"
              hint="Deducted from a full day's worked hours, not from a short visit"
            >
              <NumberInput
                kind="count"
                min={0}
                max={240}
                value={settings.breakMinutes}
                onChange={(e) => set('breakMinutes', Number(e.target.value))}
              />
            </Field>
            <Field
              label="Hours in a normal day"
              hint="Used to turn a daily rate into an hourly one"
            >
              <NumberInput
                kind="count"
                min={1}
                max={24}
                step={0.5}
                value={settings.hoursPerDay}
                onChange={(e) => set('hoursPerDay', Number(e.target.value))}
              />
            </Field>
          </div>

          <div className="card">
            <h3 className="card-title">Overtime</h3>
            <div className="grid grid-2">
              <Field label="Dinner break from">
                <input
                  type="time"
                  value={settings.dinnerBreakStart}
                  onChange={(e) => set('dinnerBreakStart', e.target.value)}
                />
              </Field>
              <Field label="Until">
                <input
                  type="time"
                  value={settings.dinnerBreakEnd}
                  onChange={(e) => set('dinnerBreakEnd', e.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Break deducted (minutes)"
              hint="Only taken off overtime that actually spans the break"
            >
              <NumberInput
                kind="count"
                min={0}
                max={240}
                value={settings.dinnerBreakMinutes}
                onChange={(e) => set('dinnerBreakMinutes', Number(e.target.value))}
              />
            </Field>
            <Field
              label="Overtime premium"
              hint="Philippine law sets at least 1.25× the hourly rate for ordinary-day overtime"
            >
              <NumberInput
                kind="decimal"
                min={1}
                max={5}
                step={0.05}
                value={settings.overtimeMultiplier}
                onChange={(e) => set('overtimeMultiplier', Number(e.target.value))}
              />
            </Field>
            <div className="alert info" style={{ marginBottom: 0 }}>
              A project bears the <em>burdened</em> hourly rate — daily rate × burden ÷{' '}
              {settings.hoursPerDay} — times this premium. Nobody sees a colleague's wage on a
              project screen.
            </div>
          </div>

          <div className="card">
            <h3 className="card-title">Face recognition</h3>
            <Field
              label="Match threshold"
              hint="Lower is stricter. 0.55 is the default. The clock accepts a face only when it is within this distance of the person's own samples AND clearly nearer to them than to anyone else's (by 0.05) — otherwise it refuses and offers the fallback. 0.50 turns away more genuine people; 0.60 and above let doubtful matches through."
            >
              <NumberInput
                kind="decimal"
                min={0.3}
                max={0.9}
                step={0.01}
                value={settings.faceThreshold}
                onChange={(e) => set('faceThreshold', Number(e.target.value))}
              />
            </Field>
            {/* A Field's label would point at the checkbox's own label; the hint is wired by hand instead. */}
            <div className="field face-liveness">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={settings.faceLiveness}
                  onChange={(e) => set('faceLiveness', e.target.checked)}
                  aria-describedby={livenessHintId}
                />
                <span>Ask for a blink or a head turn (liveness check)</span>
              </label>
              <div className="hint" id={livenessHintId}>
                Stops a printed photo or a phone screen from clocking in. A video of the person could
                still pass.
              </div>
            </div>
            <div className="alert warn" style={{ marginBottom: 0 }}>
              Recognition runs on the server, from the photo the camera sends. Each person enrols
              three samples on the Clock page. Every clock entry keeps its photo and its match
              distance — a match that later looks wrong can be checked against the picture rather
              than argued about, and every refusal is in the audit trail.
            </div>
          </div>
        </div>
        {/* Saves the three cards above — the working day, overtime and face recognition. */}
        {editable && (
          <div className="card-foot">
            <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </fieldset>

      <FaceHealthPanel reloadToken={saved} />

      <div className="card">
        <div className="panel-head">
          <h3 className="card-title">Leave types</h3>
          {editable && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() =>
                setEditingType({ code: '', name: '', daysPerYear: 0, isPaid: true, requiresProof: false, isActive: true })
              }
            >
              + New leave type
            </button>
          )}
        </div>
        <p className="muted">Allotted days per year, per type.</p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Type</th>
                <th className="right">Days / year</th>
                <th>Paid</th>
                <th>Proof</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr
                  key={t.id}
                  className={editable ? 'clickable' : undefined}
                  tabIndex={editable ? 0 : undefined}
                  onClick={editable ? () => setEditingType(t) : undefined}
                  onKeyDown={
                    editable
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setEditingType(t);
                          }
                        }
                      : undefined
                  }
                >
                  <td>
                    {t.name} <span className="faint mono">{t.code}</span>
                    {!t.isActive && <span className="badge"> retired</span>}
                  </td>
                  <td className="right mono">{t.daysPerYear}</td>
                  <td>{t.isPaid ? 'yes' : <span className="faint">unpaid</span>}</td>
                  <td>{t.requiresProof ? 'required' : <span className="faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ProbationCard />

      <div className="grid grid-2">
        <ClearanceChecklistCard />
        <AcademyCard />
      </div>

      <GreetingsCard />

      {editingType && (
        <LeaveTypeModal
          value={editingType}
          onClose={() => setEditingType(null)}
          onSaved={() => {
            setEditingType(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function LeaveTypeModal({
  value,
  onClose,
  onSaved,
}: {
  value: Partial<LeaveType>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    code: value.code ?? '',
    name: value.name ?? '',
    daysPerYear: value.daysPerYear ?? 0,
    isPaid: value.isPaid ?? true,
    requiresProof: value.requiresProof ?? false,
    sortOrder: value.sortOrder ?? 0,
    isActive: value.isActive ?? true,
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (value.id) await api.patch(`/leave/types/${value.id}`, form);
      else await api.post('/leave/types', form);
      toast('ok', 'Leave type saved');
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={value.id ? `Modify leave type ${value.name}` : 'New leave type'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || !form.code.trim() || form.name.trim().length < 2}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Code">
          <input
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            disabled={!!value.id}
            placeholder="VL"
          />
        </Field>
        <Field label="Days per year">
          <NumberInput
            kind="count"
            min={0}
            max={365}
            step={0.5}
            value={form.daysPerYear}
            onChange={(e) => setForm({ ...form, daysPerYear: Number(e.target.value) })}
          />
        </Field>
      </div>
      <Field label="Name">
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Checkbox
        checked={form.isPaid}
        onChange={(v) => setForm({ ...form, isPaid: v })}
        label="Paid leave"
      />
      <Checkbox
        checked={form.requiresProof}
        onChange={(v) => setForm({ ...form, requiresProof: v })}
        label="Needs supporting documentation (a medical certificate, say)"
      />
      <Checkbox
        checked={form.isActive}
        onChange={(v) => setForm({ ...form, isActive: v })}
        label="Available to file against"
      />
      {value.id && (
        <div className="alert info" style={{ marginTop: 'var(--s-3)', marginBottom: 0 }}>
          Changing the yearly allotment affects balances created from now on. Existing balance rows
          keep the entitlement they were opened with.
        </div>
      )}
    </Modal>
  );
}

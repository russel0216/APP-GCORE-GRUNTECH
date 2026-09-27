import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { SettingListCard } from '../../../components/SettingListCard';
import { ErrorBox, Field, Loading, useToast } from '../../../components/ui';

/**
 * HR Settings › Probation and evaluations — how long probation runs, when the
 * evaluations fall due, how far ahead HR is told, and the rating scale; then
 * the criteria every form is rated on.
 *
 * The five rules are read from `GET /hr-settings`, which is the Setting MERGED
 * over the code defaults — never from the raw Setting row. An install seeded
 * before these keys existed has none of them stored, and reading the raw row
 * would show empty boxes for rules that are in fact in force. Saving sends
 * only these five keys, so this card never writes the working day back over a
 * change made on the card beside it.
 *
 * Changing a rule moves what is due from now on; it does not touch an
 * evaluation already open. The criteria are snapshotted onto each form when
 * it is opened, so editing the list never rewrites one already written.
 *
 * Mounted by HR Settings; takes no props.
 */

interface ProbationRules {
  probationMonths: number;
  evaluationMilestoneMonths: number[];
  evaluationNoticeDays: number;
  ratingScale: number;
  ratingLabels: string[];
}

const APPLIES = [
  { value: 'BOTH', label: 'Both' },
  { value: 'PROBATIONARY', label: 'Probation only' },
  { value: 'TRAINEE', label: 'Trainees only' },
];

function pick(s: ProbationRules): ProbationRules {
  return {
    probationMonths: s.probationMonths,
    evaluationMilestoneMonths: s.evaluationMilestoneMonths,
    evaluationNoticeDays: s.evaluationNoticeDays,
    ratingScale: s.ratingScale,
    ratingLabels: s.ratingLabels,
  };
}

/** "3, 5" ⇄ [3, 5]. Anything that is not a whole number is dropped. */
const parseMonths = (text: string) =>
  text
    .split(/[,\s]+/)
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n > 0);

export function ProbationCard() {
  const { can } = useAuth();
  const toast = useToast();
  const editable = can('ghr.settings.edit_all');

  const [rules, setRules] = useState<ProbationRules | null>(null);
  const [monthsText, setMonthsText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    api
      .get<ProbationRules>('/hr-settings')
      .then((s) => {
        if (!live) return;
        const r = pick(s);
        setRules(r);
        setMonthsText(r.evaluationMilestoneMonths.join(', '));
      })
      .catch((err) => live && setError(err));
    return () => {
      live = false;
    };
  }, []);

  if (!rules) {
    return (
      <div className="card">
        <h3 className="card-title">Probation and evaluations</h3>
        {error ? <ErrorBox error={error} /> : <Loading label="Loading the probation rules…" />}
      </div>
    );
  }

  const set = <K extends keyof ProbationRules>(key: K, value: ProbationRules[K]) => {
    setRules({ ...rules, [key]: value });
    setDirty(true);
  };

  /** The labels ARE the scale — resize them with it rather than let them drift apart. */
  function setScale(n: number) {
    const scale = Math.max(2, Math.min(10, Math.round(n) || 2));
    const labels = Array.from({ length: scale }, (_, i) => rules!.ratingLabels[i] ?? '');
    setRules({ ...rules!, ratingScale: scale, ratingLabels: labels });
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.put<ProbationRules>('/hr-settings', {
        ...rules,
        evaluationMilestoneMonths: parseMonths(monthsText),
      });
      const r = pick(saved);
      setRules(r);
      setMonthsText(r.evaluationMilestoneMonths.join(', '));
      setDirty(false);
      toast('ok', 'Probation rules saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="eval-settings">
      <div className="card">
        <div className="panel-head">
          <h3 className="card-title">Probation and evaluations</h3>
          {editable && (
            <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
        <p className="muted">
          When a probationer or trainee is due an evaluation, and what it is rated on. Changing these
          moves what falls due from now on; an evaluation already open keeps its date and its form.
        </p>
        <ErrorBox error={error} />

        <fieldset className="eval-settings-fields" disabled={!editable}>
          <div className="grid grid-3">
            <Field label="Probation (months)" hint="From the hire date, when the employee record gives no period end">
              <input
                type="number"
                min={1}
                max={24}
                value={rules.probationMonths}
                onChange={(e) => set('probationMonths', Number(e.target.value))}
              />
            </Field>
            <Field label="Evaluate at months" hint="Comma-separated, before the end — the end evaluation is added on its own">
              <input
                value={monthsText}
                onChange={(e) => {
                  setMonthsText(e.target.value);
                  setDirty(true);
                }}
                placeholder="3, 5"
              />
            </Field>
            <Field label="Tell HR this many days ahead" hint="A milestone shows as due from this far out">
              <input
                type="number"
                min={0}
                max={90}
                value={rules.evaluationNoticeDays}
                onChange={(e) => set('evaluationNoticeDays', Number(e.target.value))}
              />
            </Field>
          </div>

          <Field label="Rating scale" hint="Ratings run from 1 to this; every point needs a name">
            <input type="number" min={2} max={10} value={rules.ratingScale} onChange={(e) => setScale(Number(e.target.value))} />
          </Field>
          <ol className="eval-labels">
            {rules.ratingLabels.map((label, i) => (
              <li key={i}>
                <Field label={`${i + 1} means`}>
                  <input
                    value={label}
                    onChange={(e) =>
                      set(
                        'ratingLabels',
                        rules.ratingLabels.map((l, j) => (j === i ? e.target.value : l)),
                      )
                    }
                  />
                </Field>
              </li>
            ))}
          </ol>
        </fieldset>
      </div>

      <SettingListCard
        settingKey="hr.evaluationCriteria"
        title="Evaluation criteria"
        hint="What every evaluation is rated on, and how much each counts toward the score. Copied onto a form when it is opened, so renaming or retiring a criterion never changes one already written. The key is permanent — rename freely, but do not reuse a key for something else."
        columns={[
          { key: 'key', label: 'Key', kind: 'text' },
          { key: 'name', label: 'Criterion', kind: 'text' },
          { key: 'description', label: 'What it means', kind: 'text' },
          { key: 'appliesTo', label: 'Applies to', kind: 'select', options: APPLIES },
          { key: 'weight', label: 'Weight', kind: 'number', step: 0.1, min: 0.1, max: 10 },
          { key: 'sortOrder', label: 'Order', kind: 'number', step: 1 },
          { key: 'isActive', label: 'In use', kind: 'checkbox' },
        ]}
        newRow={() => ({ key: '', name: '', description: '', appliesTo: 'BOTH', weight: 1, sortOrder: 99, isActive: true })}
        canEdit={editable}
      />
    </div>
  );
}

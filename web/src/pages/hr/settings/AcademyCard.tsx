import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Link } from 'react-router-dom';
import { useAuth, mayEditPage } from '../../../lib/auth';
import { Checkbox, ErrorBox, Field, Loading, useToast } from '../../../components/ui';
import { NumberInput } from '../../../components/NumberInput';

/**
 * HR Settings › Gruntech Academy — the three rules the Academy keeps in
 * `academy.rules`: how far ahead a certificate counts as expiring (and when
 * its holder is told), whether employees may enrol themselves from the
 * calendar. The course categories moved to Admin › Categories (2026-10-20).
 *
 * Mounted by HR Settings; takes no props. Read-only without
 * `ghr.settings.edit_all`.
 */

interface AcademyRules {
  expiryWarningDays: number;
  allowSelfEnrolment: boolean;
  categories: string[];
}

export function AcademyCard() {
  const { can } = useAuth();
  const toast = useToast();
  const canEdit = mayEditPage(can, 'ghr', 'settings');
  const [rules, setRules] = useState<AcademyRules | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function accept(r: AcademyRules) {
    setRules(r);
    setDirty(false);
  }

  useEffect(() => {
    api
      .get<AcademyRules>('/academy-settings')
      .then(accept)
      .catch(setError);
  }, []);

  function change(patch: Partial<AcademyRules>) {
    setRules((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  }

  const days = rules?.expiryWarningDays ?? 0;
  const valid = Number.isInteger(days) && days >= 0 && days <= 365;

  async function save() {
    if (!rules) return;
    setBusy(true);
    setError(null);
    try {
      accept(
        await api.put<AcademyRules>('/academy-settings', {
          expiryWarningDays: rules.expiryWarningDays,
          allowSelfEnrolment: rules.allowSelfEnrolment,
        }),
      );
      toast('ok', 'Academy rules saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3 className="card-title">Gruntech Academy</h3>
      <p className="muted">
        When a certificate counts as expiring, and whether people may put themselves on a session.
        The categories courses are filed under are <Link to="/admin/categories">Admin › Categories</Link>.
      </p>
      <ErrorBox error={error} />
      {!rules ? (
        !error && <Loading />
      ) : (
        <fieldset className="academy-fieldset" disabled={!canEdit}>
          <div className="grid grid-2">
            <Field
              label="Expiry warning (days)"
              hint="A certificate lapsing within this many days reads Expiring, and its holder is told once."
            >
              <NumberInput
                kind="count"
                min={0}
                max={365}
                step={1}
                value={rules.expiryWarningDays}
                onChange={(e) => change({ expiryWarningDays: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Checkbox
            checked={rules.allowSelfEnrolment}
            onChange={(v) => change({ allowSelfEnrolment: v })}
            label="Employees may enrol themselves on a scheduled session from the Training Calendar"
          />
          {canEdit && (
            <div className="card-foot">
              <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy || !dirty || !valid}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}

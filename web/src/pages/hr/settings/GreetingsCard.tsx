import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { Checkbox, ErrorBox, Field, Loading, useToast } from '../../../components/ui';
import { NumberInput } from '../../../components/NumberInput';

/**
 * HR Settings › Birthday and anniversary greetings (2026-10-08). The
 * templates the API's timer fills in on the day: `{first}`, `{name}`,
 * `{company}`, `{years}` ("5 years" — the age on a birthday) and `{n}` (the
 * bare number). The celebrant gets a bell and an email where email is set
 * up; everyone else a one-line bell when "Tell everyone" is on. Saves only
 * its own key, so the page's Save never writes over it.
 */

interface Greetings {
  enabled: boolean;
  hour: number;
  tellEveryone: boolean;
  birthdayTitle: string;
  birthdayMessage: string;
  anniversaryTitle: string;
  anniversaryMessage: string;
  everyoneBirthday: string;
  everyoneAnniversary: string;
}

const SAMPLE = { first: 'Maria', name: 'Maria Santos', company: 'Gruntech' };

/** The API's rule, for the preview: {years} reads "5 years", {n} the number. */
function fill(template: string, years: number): string {
  return template
    .replace(/\{first\}/g, SAMPLE.first)
    .replace(/\{name\}/g, SAMPLE.name)
    .replace(/\{company\}/g, SAMPLE.company)
    .replace(/\{years\}/g, `${years} year${years === 1 ? '' : 's'}`)
    .replace(/\{n\}/g, String(years));
}

export function GreetingsCard() {
  const { can } = useAuth();
  const toast = useToast();
  const canEdit = can('ghr.settings.edit_all');
  const [rules, setRules] = useState<Greetings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<{ greetings: Greetings }>('/hr-settings')
      .then((s) => setRules(s.greetings))
      .catch(setError);
  }, []);

  function change(patch: Partial<Greetings>) {
    setRules((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  }

  async function save() {
    if (!rules) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.put<{ greetings: Greetings }>('/hr-settings', { greetings: rules });
      setRules(saved.greetings);
      setDirty(false);
      toast('ok', 'Greetings saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const text = (key: keyof Greetings, label: string, hint: string, rows = 1) =>
    rules && (
      <Field label={label} hint={hint}>
        {rows > 1 ? (
          <textarea rows={rows} value={String(rules[key])} onChange={(e) => change({ [key]: e.target.value })} />
        ) : (
          <input value={String(rules[key])} onChange={(e) => change({ [key]: e.target.value })} />
        )}
      </Field>
    );

  return (
    <div className="card">
      <h3 className="card-title">Birthday and anniversary greetings</h3>
      <p className="muted">
        Sent on the day, from the employee record&apos;s birth date and hire date — a bell and an email
        to the person, and a line to everyone else. Templates may use {'{first}'}, {'{name}'},{' '}
        {'{company}'}, {'{years}'} (&quot;5 years&quot;, or the age) and {'{n}'} (the number alone).
      </p>
      <ErrorBox error={error} />
      {!rules ? (
        !error && <Loading />
      ) : (
        <fieldset className="academy-fieldset" disabled={!canEdit}>
          <div className="row">
            <Checkbox checked={rules.enabled} onChange={(v) => change({ enabled: v })} label="Send greetings" />
            <Checkbox checked={rules.tellEveryone} onChange={(v) => change({ tellEveryone: v })} label="Tell everyone else too" />
          </div>
          <div className="grid grid-2">
            <Field label="From what hour" hint="Manila time, 0–23; the day's greetings go out from then.">
              <NumberInput kind="count" min={0} max={23} step={1} value={rules.hour} onChange={(e) => change({ hour: Number(e.target.value) })} />
            </Field>
            <div />
            {text('birthdayTitle', 'Birthday — title', `Now: ${fill(rules.birthdayTitle, 34)}`)}
            {text('anniversaryTitle', 'Work anniversary — title', `Now: ${fill(rules.anniversaryTitle, 5)}`)}
            {text('birthdayMessage', 'Birthday — message', fill(rules.birthdayMessage, 34), 3)}
            {text('anniversaryMessage', 'Work anniversary — message', fill(rules.anniversaryMessage, 5), 3)}
            {text('everyoneBirthday', "Everyone's bell — birthday", `Now: ${fill(rules.everyoneBirthday, 34)}`)}
            {text('everyoneAnniversary', "Everyone's bell — anniversary", `Now: ${fill(rules.everyoneAnniversary, 5)}`)}
          </div>
          {canEdit && (
            <div className="card-foot">
              <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy || !dirty}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}

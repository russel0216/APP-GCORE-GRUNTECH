import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth, mayEditPage } from '../../lib/auth';
import { Checkbox, ErrorBox, Field, Loading, useToast } from '../../components/ui';

interface Terms {
  goods: string;
  services: string;
}
interface Settings {
  terms: Terms;
  defaults: Terms;
  blockOverBudget: boolean;
}

/**
 * G-CHAIN › Procurement Settings (2026-10-21): the standard terms a purchase
 * order and an RFQ print — the goods terms where the document buys goods, the
 * service terms where it buys a service — and the project budget guard.
 */
export function ProcurementSettings() {
  const { can } = useAuth();
  const toast = useToast();
  const editable = mayEditPage(can, 'gchain', 'settings');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Settings>('/procurement-settings').then(setSettings).catch(setError);
  }, []);

  if (error && !settings) return <ErrorBox error={error} />;
  if (!settings) return <Loading />;

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.put<Settings>('/procurement-settings', { terms: settings.terms, blockOverBudget: settings.blockOverBudget });
      setSettings(saved);
      toast('ok', 'Procurement settings saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const setTerm = (key: keyof Terms, value: string) => setSettings({ ...settings, terms: { ...settings.terms, [key]: value } });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Procurement Settings</h1>
          <p>The terms a purchase order and a request for quotation print for goods and for services, and the project budget guard.</p>
        </div>
        {editable && (
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>

      <ErrorBox error={error} />

      <fieldset disabled={!editable} className="fin-fieldset">
        <div className="grid grid-2">
          {(['goods', 'services'] as const).map((key) => (
            <div className="card" key={key}>
              <div className="card-head">
                <h3 className="card-title">{key === 'goods' ? 'Terms — goods' : 'Terms — services'}</h3>
                {editable && settings.terms[key] !== settings.defaults[key] && (
                  <div className="card-actions">
                    <button type="button" className="btn btn-sm" onClick={() => setTerm(key, settings.defaults[key])}>
                      Put the standard back
                    </button>
                  </div>
                )}
              </div>
              <Field
                label={key === 'goods' ? 'Printed where an order buys goods' : 'Printed where an order buys a service'}
                hint="One term per line. Left empty, nothing prints."
              >
                <textarea rows={8} value={settings.terms[key]} onChange={(e) => setTerm(key, e.target.value)} />
              </Field>
            </div>
          ))}
        </div>
        <div className="card">
          <h3 className="card-title">Project budget</h3>
          <Checkbox
            checked={settings.blockOverBudget}
            onChange={(v) => setSettings({ ...settings, blockOverBudget: v })}
            label="Refuse a purchase request that goes over its project's budget line"
          />
        </div>
      </fieldset>
    </div>
  );
}

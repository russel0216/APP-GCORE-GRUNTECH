import { useEffect, useRef, useState } from 'react';
import { api, openPdf } from '../../lib/api';
import { ErrorBox, Field, Loading, useToast } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';
import { dropHolidays, type Holiday } from '../../lib/holidays';

interface CompanyData {
  name: string;
  legalName: string | null;
  address: string | null;
  city: string | null;
  country: string;
  tin: string | null;
  regNo: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
  website: string | null;
  bankName: string | null;
  bankBranch: string | null;
  bankAccount: string | null;
  documentTagline: string | null;
  logoPath: string | null;
  currency: string;
  vatRate: number;
  ewtRate: number;
  numberPrefix: string;
  /** Pesos per unit of each other quotation currency (2026-10-17). */
  exchangeRates: Record<string, number>;
  currencies: { code: string; label: string }[];
}

/**
 * Company settings feed the PDF engine. Everything on this page appears in the
 * header of every document the system prints — which is why the specimen button
 * is here rather than buried somewhere else.
 */
export function Company() {
  const toast = useToast();
  const [data, setData] = useState<CompanyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<CompanyData>('/company')
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.put<CompanyData>('/company', {
        name: data.name,
        legalName: data.legalName,
        address: data.address,
        city: data.city,
        country: data.country,
        tin: data.tin,
        regNo: data.regNo,
        phone: data.phone,
        fax: data.fax,
        email: data.email,
        website: data.website,
        bankName: data.bankName,
        bankBranch: data.bankBranch,
        bankAccount: data.bankAccount,
        documentTagline: data.documentTagline,
        currency: data.currency,
        vatRate: data.vatRate,
        ewtRate: data.ewtRate,
        numberPrefix: data.numberPrefix,
        exchangeRates: Object.fromEntries(data.currencies.map((c) => [c.code, data.exchangeRates[c.code] || null])),
      });
      setData(saved);
      toast('ok', 'Company settings saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function uploadLogo(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api.post<{ logoPath: string }>('/company/logo', form);
      setData((d) => (d ? { ...d, logoPath: res.logoPath } : d));
      toast('ok', 'Logo updated — it appears on every PDF');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /** The one specimen button (C10): every other PDF opens the same way, through `openPdf`. */
  function openSpecimen() {
    openPdf('/api/pdf/specimen', (message) => toast('error', message || 'Could not render the specimen'));
  }

  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;

  const saveButton = (
    <button className="btn btn-primary" onClick={save} disabled={busy}>
      {busy ? 'Saving…' : 'Save'}
    </button>
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Company Settings</h1>
          <p>
            These details render on every document G-Core prints — quotations, purchase orders,
            progress reports, invoices. Change them here and every PDF follows.
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={openSpecimen}>
            Preview document specimen
          </button>
          {saveButton}
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Identity</h3>
          <Field label="Trading name">
            <input value={data.name} onChange={(e) => setData({ ...data, name: e.target.value })} />
          </Field>
          <Field label="Registered / legal name">
            <input
              value={data.legalName ?? ''}
              onChange={(e) => setData({ ...data, legalName: e.target.value })}
            />
          </Field>
          <div className="grid grid-2">
            <Field label="TIN">
              <input value={data.tin ?? ''} onChange={(e) => setData({ ...data, tin: e.target.value })} />
            </Field>
            <Field label="Reg. No." hint="SEC registration, printed as REG. NO.">
              <input value={data.regNo ?? ''} onChange={(e) => setData({ ...data, regNo: e.target.value })} />
            </Field>
          </div>
          <Field label="Logo" hint="PNG with a transparent background works best. Appears top-right on every PDF.">
            <div className="row">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="company-file-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadLogo(f);
                }}
              />
              <button className="btn btn-sm" onClick={() => fileRef.current?.click()} disabled={busy}>
                {data.logoPath ? 'Replace logo' : 'Upload logo'}
              </button>
              <span className="faint mono company-logo-name">
                {data.logoPath ? data.logoPath.split(/[\\/]/).pop() : 'none set'}
              </span>
            </div>
          </Field>
        </div>

        <div className="card">
          <h3 className="card-title">Contact</h3>
          <Field label="Address">
            <input
              value={data.address ?? ''}
              onChange={(e) => setData({ ...data, address: e.target.value })}
            />
          </Field>
          <div className="grid grid-2">
            <Field label="City">
              <input value={data.city ?? ''} onChange={(e) => setData({ ...data, city: e.target.value })} />
            </Field>
            <Field label="Country">
              <input value={data.country} onChange={(e) => setData({ ...data, country: e.target.value })} />
            </Field>
          </div>
          <div className="grid grid-2">
            <Field label="Tel">
              <input
                type="tel"
                value={data.phone ?? ''}
                onChange={(e) => setData({ ...data, phone: e.target.value })}
              />
            </Field>
            <Field label="Fax">
              <input
                type="tel"
                value={data.fax ?? ''}
                onChange={(e) => setData({ ...data, fax: e.target.value })}
              />
            </Field>
          </div>
          <div className="grid grid-2">
            <Field label="Email">
              <input
                type="email"
                value={data.email ?? ''}
                onChange={(e) => setData({ ...data, email: e.target.value })}
              />
            </Field>
            <Field label="Website">
              <input
                value={data.website ?? ''}
                onChange={(e) => setData({ ...data, website: e.target.value })}
              />
            </Field>
          </div>
          <Field
            label="Document tagline"
            hint="Printed along the foot of every document, e.g. INDUSTRIAL UTILITY SOLUTIONS. Leave it empty and the website prints there instead."
          >
            <input
              value={data.documentTagline ?? ''}
              maxLength={140}
              onChange={(e) => setData({ ...data, documentTagline: e.target.value })}
            />
          </Field>
        </div>

        <div className="card">
          <h3 className="card-title">Bank details</h3>
          <p className="muted">
            Where customers pay. Kept here with the rest of the letterhead so every document that asks
            for payment prints the same account.
          </p>
          <div className="grid grid-2">
            <Field label="Bank name">
              <input
                value={data.bankName ?? ''}
                onChange={(e) => setData({ ...data, bankName: e.target.value })}
              />
            </Field>
            <Field label="Bank branch">
              <input
                value={data.bankBranch ?? ''}
                onChange={(e) => setData({ ...data, bankBranch: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Bank account">
            <input
              className="mono"
              value={data.bankAccount ?? ''}
              onChange={(e) => setData({ ...data, bankAccount: e.target.value })}
            />
          </Field>
        </div>

        <div className="card">
          <h3 className="card-title">Money &amp; tax</h3>
          <div className="grid grid-2">
            <Field label="Currency">
              <input
                value={data.currency}
                maxLength={3}
                onChange={(e) => setData({ ...data, currency: e.target.value.toUpperCase() })}
              />
            </Field>
            <Field
              label="Document prefix"
              hint="Leads every prefixed number, e.g. GT-PRJ-2026-0001. A pattern without {PREFIX}, such as the quotation's, ignores it."
            >
              <input
                value={data.numberPrefix}
                maxLength={6}
                onChange={(e) =>
                  setData({ ...data, numberPrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })
                }
              />
            </Field>
          </div>
          <div className="grid grid-2">
            <Field label="VAT rate (%)" hint="Output VAT added to every billing">
              <NumberInput
                kind="percent"
                step="0.01"
                value={(data.vatRate * 100).toFixed(2)}
                onChange={(e) => setData({ ...data, vatRate: Number(e.target.value) / 100 })}
              />
            </Field>
            <Field label="EWT rate (%)" hint="Withheld by the customer — reduces cash, not the amount owed">
              <NumberInput
                kind="percent"
                step="0.01"
                value={(data.ewtRate * 100).toFixed(2)}
                onChange={(e) => setData({ ...data, ewtRate: Number(e.target.value) / 100 })}
              />
            </Field>
          </div>
          <div className="alert info company-note">
            EWT is withheld at source and returns as a tax certificate, not as cash. A/R tracks
            invoiced, collected and withheld separately so withholding never reads as a late payment.
          </div>
        </div>

        <div className="card">
          <h3 className="card-title">Exchange rates</h3>
          <p className="muted">
            Pesos per one unit. A new quotation in another currency starts from its rate here and keeps
            its own after, and every total that adds quotations — the lists, the board, the forecast,
            Insights — converts at that rate. Changing a rate here restates nothing already on file.
          </p>
          <div className="grid grid-2">
            {data.currencies.map((c) => (
              <Field key={c.code} label={c.label} hint={data.exchangeRates[c.code] ? undefined : 'Not set — counted unconverted until it is'}>
                <NumberInput
                  kind="decimal"
                  value={data.exchangeRates[c.code] ?? ''}
                  onChange={(e) =>
                    setData({
                      ...data,
                      exchangeRates: { ...data.exchangeRates, [c.code]: Number(e.target.value) || 0 },
                    })
                  }
                />
              </Field>
            ))}
          </div>
        </div>

        <HolidaysCard />
      </div>

      {/* The form is long: Save again at its foot, right, as at its head. */}
      <div className="page-foot company-actions">
        {saveButton}
      </div>
    </div>
  );
}

/**
 * Holidays (2026-10-17): days off besides Sunday for every working-day count
 * — a costing's plan, a project's dates, a job order's working days. The
 * Philippine holidays for this year and next were added once by the seed;
 * the moon's (Chinese New Year, the Eids) say "check the proclamation".
 * Saved on its own — the company form's Save does not carry it.
 */
function HolidaysCard() {
  const toast = useToast();
  const thisYear = new Date().getFullYear();
  const [list, setList] = useState<Holiday[] | null>(null);
  const [year, setYear] = useState(thisYear);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<{ holidays: Holiday[] }>('/holidays')
      .then((r) => setList(r.holidays))
      .catch(setError);
  }, []);

  if (!list) return error ? <ErrorBox error={error} /> : null;

  const years = [...new Set([thisYear, thisYear + 1, ...list.map((h) => Number(h.date.slice(0, 4)))])].sort();
  const shown = list.map((h, i) => ({ h, i })).filter(({ h }) => h.date.startsWith(`${year}-`));
  const change = (i: number, patch: Partial<Holiday>) => {
    setList(list.map((h, k) => (k === i ? { ...h, ...patch } : h)));
    setDirty(true);
  };
  const remove = (i: number) => {
    setList(list.filter((_, k) => k !== i));
    setDirty(true);
  };
  const add = () => {
    setList([...list, { date: `${year}-01-01`, name: '', kind: 'SPECIAL' }]);
    setDirty(true);
  };
  async function addPh() {
    try {
      const r = await api.get<{ holidays: Holiday[] }>(`/holidays/ph/${year}`);
      const have = new Set(list!.map((h) => h.date));
      const fresh = r.holidays.filter((h) => !have.has(h.date));
      if (!fresh.length) {
        toast('ok', `Every Philippine holiday of ${year} is already listed`);
        return;
      }
      setList([...list!, ...fresh]);
      setDirty(true);
      toast('ok', `Added ${fresh.length} — save to keep them`);
    } catch (err) {
      setError(err);
    }
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.put<{ holidays: Holiday[] }>('/holidays', { holidays: list!.map((h) => ({ ...h, name: h.name.trim() })) });
      setList(r.holidays);
      setDirty(false);
      dropHolidays();
      toast('ok', 'Holidays saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">Holidays</h3>
        <div className="row">
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-sm" onClick={() => void addPh()}>
            Add PH holidays for {year}
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <p className="muted">
        Days off besides Sunday. Costing plans, project dates and job order working days skip them. Dates
        marked “check the proclamation” follow the moon — correct them when the year’s proclamation is out.
      </p>
      {error ? <ErrorBox error={error} /> : null}
      <table className="data">
        <thead>
          <tr>
            <th>Date</th>
            <th>Holiday</th>
            <th>Kind</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <tr>
              <td colSpan={4} className="faint">
                No holidays listed for {year}.
              </td>
            </tr>
          ) : (
            shown.map(({ h, i }) => (
              <tr key={i}>
                <td>
                  <input type="date" value={h.date} aria-label="Date" onChange={(e) => change(i, { date: e.target.value })} />
                </td>
                <td>
                  <input value={h.name} aria-label="Holiday" onChange={(e) => change(i, { name: e.target.value })} />
                </td>
                <td>
                  <select value={h.kind} aria-label="Kind" onChange={(e) => change(i, { kind: e.target.value as Holiday['kind'] })}>
                    <option value="REGULAR">Regular holiday</option>
                    <option value="SPECIAL">Special non-working day</option>
                  </select>
                </td>
                <td className="num">
                  <button type="button" className="btn btn-sm" onClick={() => remove(i)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="card-foot">
        <button type="button" className="btn btn-sm" onClick={add}>
          + Add holiday
        </button>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { api, getToken } from '../../lib/api';
import { ErrorBox, Field, Loading, useToast } from '../../components/ui';

interface CompanyData {
  name: string;
  legalName: string | null;
  address: string | null;
  city: string | null;
  country: string;
  tin: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logoPath: string | null;
  currency: string;
  vatRate: number;
  ewtRate: number;
  numberPrefix: string;
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
        phone: data.phone,
        email: data.email,
        website: data.website,
        currency: data.currency,
        vatRate: data.vatRate,
        ewtRate: data.ewtRate,
        numberPrefix: data.numberPrefix,
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

  function openSpecimen() {
    // The PDF route needs the bearer token, so fetch it and open the blob
    // rather than pointing the browser straight at the URL.
    fetch('/api/pdf/specimen', { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => r.blob())
      .then((b) => window.open(URL.createObjectURL(b), '_blank'))
      .catch(() => toast('error', 'Could not render the specimen'));
  }

  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;

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
        <button className="btn" onClick={openSpecimen}>
          Preview document specimen
        </button>
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
          <Field label="TIN">
            <input value={data.tin ?? ''} onChange={(e) => setData({ ...data, tin: e.target.value })} />
          </Field>
          <Field label="Logo" hint="PNG with a transparent background works best. Appears top-left on every PDF.">
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
            <Field label="Phone">
              <input value={data.phone ?? ''} onChange={(e) => setData({ ...data, phone: e.target.value })} />
            </Field>
            <Field label="Email">
              <input
                type="email"
                value={data.email ?? ''}
                onChange={(e) => setData({ ...data, email: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Website">
            <input
              value={data.website ?? ''}
              onChange={(e) => setData({ ...data, website: e.target.value })}
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
              <input
                type="number"
                step="0.01"
                value={(data.vatRate * 100).toFixed(2)}
                onChange={(e) => setData({ ...data, vatRate: Number(e.target.value) / 100 })}
              />
            </Field>
            <Field label="EWT rate (%)" hint="Withheld by the customer — reduces cash, not the amount owed">
              <input
                type="number"
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
      </div>

      <div className="row company-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save company settings'}
        </button>
      </div>
    </div>
  );
}

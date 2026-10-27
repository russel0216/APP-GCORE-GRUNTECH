import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { parseBadge } from '../../lib/badge';
import { qrReader, readQrFromFile } from '../../lib/qrScan';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { useBackLink } from '../../components/Navigation';
import { MemoryInput } from '../../components/MemoryInput';
import { ImportModal, loadImportSpec } from '../../components/ImportModal';
import { BarList, Panel, Stat } from '../../components/charts';
import { ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, formatDate, formatDateTime, useToast } from '../../components/ui';

/**
 * Marketing — exhibition visitors (2026-10-27, the owner's call during PSECE
 * 2026: "a bar graph; a QR scanner to save the info of the visitor; the
 * brands they are inquiring — several, tick boxes; every account user can
 * scan and input the specific product under the brand; I will input the data
 * of Day 1"; and "even though the entry is saved, make it editable").
 *
 * One page, three views in `?tab=`: the bar graphs, the scanner, the list.
 * The exhibition is `?exhibitionId=` (the latest active one when the URL says
 * nothing). A visitor has a page of their own (`/visitors/:id`) where every
 * field, the day and the brands change through Modify.
 */

export interface ExhibitionDay {
  day: number;
  date: string;
}

export interface Exhibition {
  id: string;
  name: string;
  venue: string | null;
  startDate: string;
  endDate: string;
  isActive: boolean;
  notes: string | null;
  days: ExhibitionDay[];
  today: number;
  visitors?: number;
}

interface Brand {
  id: string;
  name: string;
  isActive: boolean;
}

interface VisitorBrand {
  brandId: string;
  brand: string;
  products: string[];
}

interface VisitorRow {
  id: string;
  day: number;
  name: string;
  company: string | null;
  position: string | null;
  email: string | null;
  mobile: string | null;
  notes: string | null;
  qrText: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  leadId: string | null;
  lead: { id: string; number: string; status: string } | null;
  createdBy: { id: string; name: string };
  brands: VisitorBrand[];
  scanners: string[];
  scanCount: number;
  scans: { id: string; day: number; source: string; at: string; user: { id: string; name: string } }[];
}

interface VisitorDetail extends VisitorRow {
  exhibition: Exhibition;
  canEdit: boolean;
  canDelete: boolean;
  canMakeLead: boolean;
}

interface Dashboard {
  exhibition: Exhibition;
  totals: { visitors: number; today: number; scans: number; withBrand: number; leads: number };
  byBrand: { brandId: string; brand: string; visitors: number }[];
  byDay: (ExhibitionDay & { visitors: number; scans: number })[];
  products: { brandId: string; brand: string; products: { product: string; count: number }[] }[];
  byScanner: { userId: string; name: string; scans: number }[];
}

const BASE = '/g-ops/marketing';
const dayLabel = (d: ExhibitionDay) => `Day ${d.day} — ${formatDate(d.date)}`;

function useBrands() {
  const [rows, setRows] = useState<Brand[]>([]);
  useEffect(() => {
    api
      .get<Brand[]>('/reference/exhibition-brands?active=true')
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  return rows;
}

// ── The page ────────────────────────────────────────────────────────────────

type Tab = 'dashboard' | 'scan' | 'visitors';

export function Marketing() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (['dashboard', 'scan', 'visitors'].includes(params.get('tab') ?? '') ? params.get('tab') : 'dashboard') as Tab;
  const [exhibitions, setExhibitions] = useState<Exhibition[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [setting, setSetting] = useState<Exhibition | 'new' | null>(null);
  const [importing, setImporting] = useState<{ label: string; columns: never[] } | null>(null);
  const [reload, setReload] = useState(0);
  const canSetUp = can('gops.marketing.edit_all');
  const canAdd = can('gops.marketing.create');

  const loadExhibitions = useCallback(() => {
    api
      .get<Exhibition[]>('/marketing/exhibitions')
      .then((rows) => {
        setExhibitions(rows);
        setError(null);
      })
      .catch((err) => {
        setExhibitions([]);
        setError(err);
      });
  }, []);
  useEffect(loadExhibitions, [loadExhibitions]);

  const chosen = params.get('exhibitionId');
  const exhibition = exhibitions?.find((e) => e.id === chosen) ?? exhibitions?.find((e) => e.isActive) ?? exhibitions?.[0] ?? null;

  function go(next: Partial<Record<'tab' | 'exhibitionId', string | null>>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    // A new view, or another exhibition, starts on its own filters — never the last list's.
    for (const k of ['q', 'page', 'day', 'brandId', 'product', 'scannedBy', 'lead', 'noBrand', 'scope']) p.delete(k);
    setParams(p, { replace: next.tab === undefined });
  }

  if (!exhibitions) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Marketing</h1>
          {exhibition && (
            <p className="mk-event-line">
              {exhibition.name}
              {exhibition.venue ? ` · ${exhibition.venue}` : ''} · {formatDate(exhibition.startDate)} – {formatDate(exhibition.endDate)} · today is Day {exhibition.today}
            </p>
          )}
        </div>
        <div className="row">
          {exhibitions.length > 1 && (
            <select aria-label="Exhibition" value={exhibition?.id ?? ''} onChange={(e) => go({ exhibitionId: e.target.value })}>
              {exhibitions.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.isActive ? '' : ' (closed)'}
                </option>
              ))}
            </select>
          )}
          {canSetUp && (
            <button type="button" className="btn" onClick={() => setSetting(exhibition ?? 'new')}>
              Exhibition…
            </button>
          )}
          {canAdd && exhibition && tab !== 'scan' && (
            <button type="button" className="btn btn-primary" onClick={() => go({ tab: 'scan' })}>
              Scan a badge
            </button>
          )}
        </div>
      </div>

      <ErrorBox error={error} />

      {!exhibition ? (
        <section className="card">
          <p>No exhibition is on file yet.</p>
          {canSetUp && (
            <button type="button" className="btn btn-primary" onClick={() => setSetting('new')}>
              + New exhibition
            </button>
          )}
        </section>
      ) : (
        <>
          <div className="scope-switch mk-tabs" role="group" aria-label="View">
            {(
              [
                ['dashboard', 'Bar graphs'],
                ['scan', 'Scan'],
                ['visitors', 'Visitors'],
              ] as [Tab, string][]
            ).map(([key, label]) => (
              <button key={key} type="button" className={tab === key ? 'active' : ''} aria-pressed={tab === key} onClick={() => go({ tab: key })}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'dashboard' && <MarketingDashboard exhibition={exhibition} reload={reload} />}
          {tab === 'scan' && (canAdd ? <ScanPanel exhibition={exhibition} onSaved={() => setReload((r) => r + 1)} /> : <section className="card">You may read the visitors but not add one.</section>)}
          {tab === 'visitors' && (
            <VisitorList
              key={exhibition.id}
              exhibition={exhibition}
              reload={reload}
              onImport={
                canAdd
                  ? () => {
                      void loadImportSpec('exhibition_visitors').then((spec) => {
                        if (spec) setImporting(spec as { label: string; columns: never[] });
                      });
                    }
                  : undefined
              }
            />
          )}
        </>
      )}

      {setting && (
        <ExhibitionModal
          existing={setting === 'new' ? null : setting}
          onNew={() => setSetting('new')}
          onClose={() => setSetting(null)}
          onSaved={(e) => {
            setSetting(null);
            loadExhibitions();
            go({ exhibitionId: e.id });
          }}
        />
      )}
      {importing && (
        <ImportModal
          entity="exhibition_visitors"
          label={importing.label}
          columns={importing.columns}
          onClose={() => setImporting(null)}
          onImported={() => {
            setReload((r) => r + 1);
            loadExhibitions();
          }}
        />
      )}
    </div>
  );
}

// ── The bar graphs ──────────────────────────────────────────────────────────

function MarketingDashboard({ exhibition, reload }: { exhibition: Exhibition; reload: number }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    api
      .get<Dashboard>(`/marketing/dashboard${qs({ exhibitionId: exhibition.id })}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch(setError);
  }, [exhibition.id]);
  useEffect(load, [load, reload]);
  // The booth's numbers move all day: read again every minute while the page is open.
  useEffect(() => {
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const list = (more: Record<string, string>) => `${BASE}${qs({ tab: 'visitors', exhibitionId: exhibition.id, ...more })}`;
  const t = data.totals;

  return (
    <div className="stack">
      <div className="kpi-grid">
        <Stat label="Visitors" value={t.visitors.toLocaleString('en-PH')} sub={`${t.scans.toLocaleString('en-PH')} scan${t.scans === 1 ? '' : 's'} in all`} to={list({})} />
        <Stat label={`Today — Day ${data.exhibition.today}`} value={t.today.toLocaleString('en-PH')} sub="First came by today" to={list({ day: String(data.exhibition.today) })} />
        <Stat label="Asked about a brand" value={t.withBrand.toLocaleString('en-PH')} sub={`${(t.visitors - t.withBrand).toLocaleString('en-PH')} with none ticked`} to={t.visitors - t.withBrand ? list({ noBrand: 'true' }) : undefined} />
        <Stat label="Made a lead" value={t.leads.toLocaleString('en-PH')} sub="Open a visitor to make one" to={list({ lead: 'yes' })} />
      </div>

      <Panel title="Visitors per brand" blurb="Each visitor counted once under every brand they asked about — a bar opens the list.">
        <BarList slices={data.byBrand.map((b) => ({ label: b.brand, value: b.visitors, display: b.visitors.toLocaleString('en-PH'), to: list({ brandId: b.brandId }) }))} />
      </Panel>

      <div className="grid grid-2">
        <Panel title="Visitors per day" blurb="By the day they first came by; scans count every visit.">
          <BarList
            slices={data.byDay.map((d) => ({
              label: dayLabel(d),
              value: d.visitors,
              display: `${d.visitors.toLocaleString('en-PH')} · ${d.scans.toLocaleString('en-PH')} scan${d.scans === 1 ? '' : 's'}`,
              to: list({ day: String(d.day) }),
            }))}
          />
        </Panel>
        <Panel title="Scans per person" blurb="Who scanned or added how many badges.">
          <BarList slices={data.byScanner.map((s) => ({ label: s.name, value: s.scans, display: s.scans.toLocaleString('en-PH'), to: list({ scannedBy: s.userId }) }))} />
        </Panel>
      </div>

      <Panel title="Products asked about, by brand" blurb="The products named under each brand, most asked first.">
        {data.products.length === 0 ? (
          <BarList slices={[]} />
        ) : (
          <div className="mk-products">
            {data.products.map((b) => (
              <BarList
                key={b.brandId}
                caption={b.brand}
                slices={b.products.slice(0, 12).map((p) => ({ label: p.product, value: p.count, display: p.count.toLocaleString('en-PH'), to: list({ brandId: b.brandId, product: p.product }) }))}
              />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

// ── The form ────────────────────────────────────────────────────────────────

export interface VisitorDraft {
  day: number;
  name: string;
  company: string;
  position: string;
  email: string;
  mobile: string;
  notes: string;
  qrText: string;
  /** brandId → products typed under it ("UPS, PLC"); a key present is a ticked brand. */
  brands: Record<string, string>;
}

export const blankDraft = (day: number): VisitorDraft => ({ day, name: '', company: '', position: '', email: '', mobile: '', notes: '', qrText: '', brands: {} });

export function draftOf(v: VisitorRow): VisitorDraft {
  return {
    day: v.day,
    name: v.name,
    company: v.company ?? '',
    position: v.position ?? '',
    email: v.email ?? '',
    mobile: v.mobile ?? '',
    notes: v.notes ?? '',
    qrText: v.qrText ?? '',
    brands: Object.fromEntries(v.brands.map((b) => [b.brandId, b.products.join(', ')])),
  };
}

export const payloadOf = (d: VisitorDraft) => ({
  day: d.day,
  name: d.name.trim(),
  company: d.company.trim() || null,
  position: d.position.trim() || null,
  email: d.email.trim() || null,
  mobile: d.mobile.trim() || null,
  notes: d.notes.trim() || null,
  interests: Object.entries(d.brands).map(([brandId, products]) => ({ brandId, products: products.trim() || null })),
});

/** The visitor's fields, the day, and the brands with the products under each — the scanner's, the Modify modal's and the typed entry's one form. */
function VisitorFields({ draft, onChange, exhibition, brands, extraBrands }: { draft: VisitorDraft; onChange: (d: VisitorDraft) => void; exhibition: Exhibition; brands: Brand[]; extraBrands?: Brand[] }) {
  const id = useId();
  const set = <K extends keyof VisitorDraft>(k: K, v: VisitorDraft[K]) => onChange({ ...draft, [k]: v });
  // A brand switched off since stays offered on a visitor who asked about it.
  const offered = [...brands, ...(extraBrands ?? []).filter((b) => !brands.some((x) => x.id === b.id))];
  function tick(brandId: string, on: boolean) {
    const next = { ...draft.brands };
    if (on) next[brandId] = next[brandId] ?? '';
    else delete next[brandId];
    onChange({ ...draft, brands: next });
  }
  return (
    <>
      <div className="grid grid-2">
        <Field label="Name" htmlFor={`${id}-name`} required>
          <input id={`${id}-name`} value={draft.name} onChange={(e) => set('name', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Day" htmlFor={`${id}-day`}>
          <select id={`${id}-day`} value={draft.day} onChange={(e) => set('day', Number(e.target.value))}>
            {exhibition.days.map((d) => (
              <option key={d.day} value={d.day}>
                {dayLabel(d)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Company" htmlFor={`${id}-company`}>
          <input id={`${id}-company`} value={draft.company} onChange={(e) => set('company', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Position" htmlFor={`${id}-position`}>
          <input id={`${id}-position`} value={draft.position} onChange={(e) => set('position', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Email" htmlFor={`${id}-email`}>
          <input id={`${id}-email`} type="email" value={draft.email} onChange={(e) => set('email', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Mobile" htmlFor={`${id}-mobile`}>
          <input id={`${id}-mobile`} type="tel" value={draft.mobile} onChange={(e) => set('mobile', e.target.value)} autoComplete="off" />
        </Field>
      </div>

      <h4 className="svc-subhead">Brands they asked about</h4>
      <div className="mk-brands" role="group" aria-label="Brands they asked about">
        {offered.map((b) => {
          const on = b.id in draft.brands;
          return (
            <div key={b.id} className={`mk-brand${on ? ' is-on' : ''}`}>
              <label className="checkbox">
                <input type="checkbox" checked={on} onChange={(e) => tick(b.id, e.target.checked)} />
                <span>{b.name}</span>
              </label>
              {on && (
                <MemoryInput
                  aria-label={`Products under ${b.name}`}
                  source="/marketing/suggest/products"
                  field="product"
                  params={{ brandId: b.id }}
                  minChars={0}
                  placeholder="Products — e.g. UPS, F600"
                  value={draft.brands[b.id] ?? ''}
                  onChange={(e) => onChange({ ...draft, brands: { ...draft.brands, [b.id]: e.target.value } })}
                />
              )}
            </div>
          );
        })}
      </div>
      <p className="faint mk-hint">Several products under one brand: separate them with commas.</p>

      <Field label="Notes" htmlFor={`${id}-notes`}>
        <textarea id={`${id}-notes`} rows={2} value={draft.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Wants a quotation, a site visit, a call back…" />
      </Field>
    </>
  );
}

// ── The scanner ─────────────────────────────────────────────────────────────

interface Match {
  visitor: VisitorRow | null;
  exists?: boolean;
}

function ScanPanel({ exhibition, onSaved }: { exhibition: Exhibition; onSaved: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const brands = useBrands();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<'camera' | 'form'>('camera');
  const [camera, setCamera] = useState<'starting' | 'live' | 'off' | 'failed'>('starting');
  const [cameraNote, setCameraNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<VisitorDraft>(() => blankDraft(exhibition.today));
  const [match, setMatch] = useState<Match | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [last, setLast] = useState<{ id: string; name: string; merged: boolean } | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  /** A badge read: fill the form from it and say whether this person is already on file. */
  const found = useCallback(
    async (text: string) => {
      stop();
      navigator.vibrate?.(120);
      const badge = parseBadge(text);
      const next: VisitorDraft = {
        ...blankDraft(exhibition.today),
        name: badge.name ?? '',
        company: badge.company ?? '',
        position: badge.position ?? '',
        email: badge.email ?? '',
        mobile: badge.mobile ?? '',
        qrText: text,
      };
      setDraft(next);
      setMatch(null);
      setError(null);
      setPhase('form');
      try {
        setMatch(await api.get<Match>(`/marketing/visitors/match${qs({ exhibitionId: exhibition.id, qrText: text, email: next.email || undefined, name: next.name || undefined, company: next.company || undefined })}`));
      } catch {
        setMatch(null);
      }
    },
    [exhibition.id, exhibition.today, stop],
  );

  // The camera, while the scanner shows: the back camera, read every 250 ms.
  useEffect(() => {
    if (phase !== 'camera') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setCamera('starting');
    setCameraNote(null);
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamera('failed');
        setCameraNote(window.isSecureContext ? 'This browser cannot open a camera — take a photo of the badge instead, or type it in.' : 'The camera opens only on a secure page — open G-CORE through its https:// address. Meanwhile take a photo of the badge or type it in.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices
          .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
          .catch((err: unknown) => {
            if (err instanceof Error && err.name === 'OverconstrainedError') return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            throw err;
          });
        if (!live) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        setCamera('live');
        const reader = await qrReader();
        const tick = async () => {
          if (!live) return;
          const v = videoRef.current;
          if (v && v.readyState >= 2) {
            const text = await reader.read(v, v.videoWidth, v.videoHeight).catch(() => null);
            if (text && live) {
              live = false;
              void found(text);
              return;
            }
          }
          timer = setTimeout(() => void tick(), 250);
        };
        void tick();
      } catch (err) {
        if (!live) return;
        setCamera('failed');
        const name = err instanceof Error ? err.name : '';
        setCameraNote(
          name === 'NotAllowedError'
            ? 'The camera was not allowed — allow it in the browser’s site settings, or take a photo of the badge instead.'
            : name === 'NotReadableError'
              ? 'The camera is in use by another app — close it and press Scan again.'
              : name === 'NotFoundError'
                ? 'No camera was found on this device — take a photo of the badge or type it in.'
                : 'The camera could not be opened — take a photo of the badge or type it in.',
        );
      }
    })();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      stop();
    };
  }, [phase, found, stop]);

  async function fromPhoto(file: File | undefined) {
    if (!file) return;
    try {
      const text = await readQrFromFile(file);
      if (text) await found(text);
      else toast('error', 'No QR code was found in that photo — hold the phone closer, keep the code flat and in focus.');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'That photo could not be read');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function typeIn() {
    stop();
    setDraft(blankDraft(exhibition.today));
    setMatch(null);
    setError(null);
    setPhase('form');
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.post<VisitorRow & { merged: boolean }>('/marketing/visitors', {
        exhibitionId: exhibition.id,
        ...payloadOf(draft),
        qrText: draft.qrText || null,
        source: draft.qrText ? 'SCAN' : 'MANUAL',
      });
      setLast({ id: saved.id, name: saved.name, merged: saved.merged });
      toast('ok', saved.merged ? `${saved.name} was already on file — this scan and its brands were added` : `${saved.name} saved`);
      onSaved();
      setPhase('camera');
      setDraft(blankDraft(exhibition.today));
      setMatch(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {last && (
        <div className="alert ok">
          Saved: <Link to={`${BASE}/visitors/${last.id}`}>{last.name}</Link>
          {last.merged ? ' — already on file, this scan was added to them.' : '.'} Open them to change anything.
        </div>
      )}

      {phase === 'camera' ? (
        <section className="card mk-scanner">
          <div className="card-head">
            <h3 className="card-title">Scan the visitor’s badge</h3>
          </div>
          <div className="mk-viewfinder">
            <video ref={videoRef} playsInline muted aria-label="Camera" />
            <div className="mk-frame" aria-hidden="true" />
            {camera === 'starting' && <div className="mk-camera-note">Opening the camera…</div>}
            {camera === 'failed' && <div className="mk-camera-note">{cameraNote}</div>}
          </div>
          <p className="faint mk-hint">Hold the QR code on the badge inside the square — it is read by itself.</p>
          <div className="card-foot mk-scan-actions">
            <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void fromPhoto(e.target.files?.[0])} />
            <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>
              Take a photo of the badge
            </button>
            <button type="button" className="btn btn-sm" onClick={typeIn}>
              Type it in instead
            </button>
          </div>
        </section>
      ) : (
        <section className="card">
          <div className="card-head">
            <h3 className="card-title">{draft.qrText ? 'Badge read — tick the brands' : 'New visitor'}</h3>
          </div>
          {match?.visitor && (
            <div className="alert warn">
              <strong>{match.visitor.name}</strong> is already on file — added by {match.visitor.createdBy.name}, Day {match.visitor.day}
              {match.visitor.brands.length ? `, asked about ${match.visitor.brands.map((b) => (b.products.length ? `${b.brand} (${b.products.join(', ')})` : b.brand)).join('; ')}` : ''}. Saving adds this scan
              and the brands ticked below to them.{' '}
              <button type="button" className="btn btn-sm" onClick={() => navigate(`${BASE}/visitors/${match.visitor!.id}`)}>
                Open them instead
              </button>
            </div>
          )}
          {match?.exists && !match.visitor && <div className="alert warn">This badge is already on file under a colleague — saving adds this scan to it.</div>}
          <ErrorBox error={error} />
          <VisitorFields draft={draft} onChange={setDraft} exhibition={exhibition} brands={brands} />
          <div className="card-foot mk-scan-actions">
            <button type="button" className="btn btn-sm" onClick={() => setPhase('camera')} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy || draft.name.trim().length < 2}>
              {busy ? 'Saving…' : 'Save and scan next'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

// ── The list ────────────────────────────────────────────────────────────────

interface VisitorSummary {
  visitors: number;
  today: number;
  leads: number;
  byDay: (ExhibitionDay & { visitors: number })[];
  exhibition: Exhibition;
}

function VisitorList({ exhibition, reload, onImport }: { exhibition: Exhibition; reload: number; onImport?: () => void }) {
  const navigate = useNavigate();
  const brands = useBrands();
  const [scanners, setScanners] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    api
      .get<Dashboard>(`/marketing/dashboard${qs({ exhibitionId: exhibition.id })}`)
      .then((d) => setScanners(d.byScanner.map((s) => ({ value: s.userId, label: s.name }))))
      .catch(() => setScanners([]));
  }, [exhibition.id, reload]);

  const columns: Column<VisitorRow>[] = [
    { key: 'day', label: 'Day', sortKey: 'day', render: (r) => `Day ${r.day}` },
    {
      key: 'name',
      label: 'Visitor',
      sortKey: 'name',
      render: (r) => (
        <div>
          <strong>{r.name}</strong>
          {r.position && <div className="faint">{r.position}</div>}
        </div>
      ),
    },
    { key: 'company', label: 'Company', sortKey: 'company', render: (r) => r.company ?? <span className="faint">—</span> },
    {
      key: 'brands',
      label: 'Brands and products',
      render: (r) =>
        r.brands.length ? (
          <div className="mk-chips">
            {r.brands.map((b) => (
              <span key={b.brandId} className="mk-chip">
                {b.brand}
                {b.products.length ? <span className="faint"> · {b.products.join(', ')}</span> : null}
              </span>
            ))}
          </div>
        ) : (
          <span className="faint">none ticked</span>
        ),
    },
    { key: 'email', label: 'Email', render: (r) => r.email ?? <span className="faint">—</span> },
    { key: 'mobile', label: 'Mobile', render: (r) => r.mobile ?? <span className="faint">—</span> },
    { key: 'scannedBy', label: 'Scanned by', render: (r) => (r.scanners.length ? r.scanners.join(', ') : r.createdBy.name) },
    { key: 'lead', label: 'Lead', optional: true, render: (r) => (r.lead ? r.lead.number : <span className="faint">—</span>) },
    { key: 'notes', label: 'Notes', optional: true, render: (r) => r.notes ?? <span className="faint">—</span> },
    { key: 'added', label: 'Added', sortKey: 'createdAt', optional: true, render: (r) => formatDateTime(r.createdAt) },
  ];

  return (
    <DataList<VisitorRow>
      listKey="exhibition-visitors"
      endpoint="/marketing/visitors"
      columns={columns}
      rowKey={(r) => r.id}
      initialFilters={{ exhibitionId: exhibition.id }}
      reloadToken={reload}
      scoped
      defaultScope="all"
      mineLabel="Scanned by me"
      onRowClick={(r) => navigate(`${BASE}/visitors/${r.id}`)}
      searchPlaceholder="Search name, company, email, product…"
      emptyTitle="No visitors yet"
      emptyHint="Scan a badge, or import the spreadsheet of a day already past."
      printPath="/api/marketing/visitors/pdf"
      selectable
      rowLabel={(r) => r.name}
      menuItems={onImport ? [{ label: 'Import from a spreadsheet…', hint: 'Day 1 kept on a spreadsheet: Name, Company, Position, Email, Mobile, Brands, Products, Day — checked before anything is saved', onSelect: onImport }] : []}
      summary={(raw) => {
        const s = raw as unknown as VisitorSummary;
        return (
          <>
            <Stat label="Visitors" value={(s.visitors ?? 0).toLocaleString('en-PH')} sub={exhibition.name} />
            {(s.byDay ?? []).map((d) => (
              <Stat key={d.day} label={`Day ${d.day}`} value={d.visitors.toLocaleString('en-PH')} sub={formatDate(d.date)} />
            ))}
            <Stat label="Made a lead" value={(s.leads ?? 0).toLocaleString('en-PH')} />
          </>
        );
      }}
      filters={[
        { key: 'day', label: 'Day', options: exhibition.days.map((d) => ({ value: String(d.day), label: dayLabel(d) })) },
        { key: 'brandId', label: 'Brand', options: brands.map((b) => ({ value: b.id, label: b.name })) },
        {
          key: 'product',
          label: 'Product',
          type: 'lookup',
          placeholder: 'Type a product…',
          search: (term) => api.get<string[]>(`/marketing/suggest/products${qs({ field: 'product', q: term })}`).then((rows) => rows.map((p) => ({ value: p, label: p }))),
          describe: async (value) => value,
        },
        { key: 'scannedBy', label: 'Scanned by', options: scanners },
        {
          key: 'lead',
          label: 'Lead',
          options: [
            { value: 'yes', label: 'Made a lead' },
            { value: 'no', label: 'No lead yet' },
          ],
        },
        { key: 'noBrand', label: 'Brands', options: [{ value: 'true', label: 'None ticked' }] },
      ]}
    />
  );
}

// ── One visitor ─────────────────────────────────────────────────────────────

export function VisitorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [row, setRow] = useState<VisitorDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [modifying, setModifying] = useState(false);
  useBackLink(row ? `${BASE}?tab=visitors&exhibitionId=${row.exhibition.id}` : null, row ? 'visitors' : null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRow(await api.get<VisitorDetail>(`/marketing/visitors/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!row) return error ? <ErrorBox error={error} /> : <Loading />;
  const r = row;

  async function makeLead() {
    const lead = await api.post<{ id: string; number: string }>(`/marketing/visitors/${r.id}/lead`, {});
    toast('ok', `Lead ${lead.number} made`);
    navigate(`/g-ops/leads/${lead.id}`);
  }

  async function remove() {
    await api.del(`/marketing/visitors/${r.id}`);
    toast('ok', `${r.name} removed`);
    navigate(`${BASE}?tab=visitors&exhibitionId=${r.exhibition.id}`);
  }

  return (
    <div>
      <RecordHeader
        type="Exhibition visitor"
        title={r.name}
        meta={
          <>
            {[r.position, r.company].filter(Boolean).join(', ') || 'No company given'} · {r.exhibition.name}, Day {r.day} · added by {r.createdBy.name}
          </>
        }
        actions={
          r.lead ? (
            <Link className="btn" to={`/g-ops/leads/${r.lead.id}`}>
              Lead {r.lead.number}
            </Link>
          ) : r.canMakeLead ? (
            <button type="button" className="btn btn-primary" onClick={() => confirm.ask({ title: `Make a lead of ${r.name}?`, body: 'A new lead is filed in your name, its source this exhibition and what they asked about.', confirmLabel: 'Make lead', onConfirm: makeLead })}>
              Make lead
            </button>
          ) : undefined
        }
        more={[
          r.canDelete && {
            label: 'Delete',
            danger: true,
            confirm: { title: `Remove ${r.name}?`, body: 'The visitor, the brands they asked about and every scan of their badge go for good.', confirmLabel: 'Delete', onConfirm: remove },
          },
        ]}
        modify={r.canEdit ? () => setModifying(true) : undefined}
        confirm={confirm}
      />

      <div className="grid grid-2">
        <section className="card">
          <h3 className="card-title">Contact</h3>
          <dl className="kv">
            <dt>Company</dt>
            <dd>{r.company ?? '—'}</dd>
            <dt>Position</dt>
            <dd>{r.position ?? '—'}</dd>
            <dt>Email</dt>
            <dd>{r.email ? <a href={`mailto:${r.email}`}>{r.email}</a> : '—'}</dd>
            <dt>Mobile</dt>
            <dd>{r.mobile ? <a href={`tel:${r.mobile.replace(/\s+/g, '')}`}>{r.mobile}</a> : '—'}</dd>
            <dt>Day</dt>
            <dd>
              Day {r.day}
              {r.exhibition.days.find((d) => d.day === r.day) ? ` — ${formatDate(r.exhibition.days.find((d) => d.day === r.day)!.date)}` : ''}
            </dd>
            <dt>Notes</dt>
            <dd>{r.notes ?? <span className="faint">—</span>}</dd>
          </dl>
        </section>
        <section className="card">
          <h3 className="card-title">Brands and products</h3>
          {r.brands.length === 0 ? (
            <p className="faint">No brand ticked yet{r.canEdit ? ' — Modify to tick them.' : '.'}</p>
          ) : (
            <dl className="kv">
              {r.brands.map((b) => (
                <div key={b.brandId} className="mk-kv-row">
                  <dt>{b.brand}</dt>
                  <dd>{b.products.length ? b.products.join(', ') : <span className="faint">no product named</span>}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>

      <section className="card">
        <h3 className="card-title">Scans</h3>
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Day</th>
              <th>By</th>
              <th>How</th>
            </tr>
          </thead>
          <tbody>
            {r.scans.map((s) => (
              <tr key={s.id}>
                <td>{formatDateTime(s.at)}</td>
                <td>Day {s.day}</td>
                <td>{s.user.name}</td>
                <td>
                  <StatusBadge status={s.source} extra={{ SCAN: 'ok', MANUAL: '', IMPORT: 'info' }} label={s.source === 'SCAN' ? 'Badge scanned' : s.source === 'IMPORT' ? 'Imported' : 'Typed in'} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {r.qrText && (
          <details className="mk-raw">
            <summary>What the badge’s QR held</summary>
            <pre>{r.qrText}</pre>
          </details>
        )}
      </section>

      {modifying && (
        <VisitorModal
          visitor={r}
          onClose={() => setModifying(false)}
          onSaved={() => {
            setModifying(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function VisitorModal({ visitor, onClose, onSaved }: { visitor: VisitorDetail; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const brands = useBrands();
  const [draft, setDraft] = useState<VisitorDraft>(() => draftOf(visitor));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const held = visitor.brands.map((b) => ({ id: b.brandId, name: b.brand, isActive: false }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/marketing/visitors/${visitor.id}`, payloadOf(draft));
      toast('ok', `${draft.name.trim()} updated`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Modify visitor ${visitor.name}`}
      wide
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || draft.name.trim().length < 2}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <VisitorFields draft={draft} onChange={setDraft} exhibition={visitor.exhibition} brands={brands} extraBrands={held} />
    </Modal>
  );
}

// ── The exhibition ──────────────────────────────────────────────────────────

function ExhibitionModal({ existing, onClose, onSaved, onNew }: { existing: Exhibition | null; onClose: () => void; onSaved: (e: Exhibition) => void; onNew: () => void }) {
  const toast = useToast();
  const id = useId();
  const [form, setForm] = useState(() => ({
    name: existing?.name ?? '',
    venue: existing?.venue ?? '',
    startDate: existing?.startDate.slice(0, 10) ?? '',
    endDate: existing?.endDate.slice(0, 10) ?? '',
    isActive: existing?.isActive ?? true,
    notes: existing?.notes ?? '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy(true);
    setError(null);
    const body = { ...form, venue: form.venue.trim() || null, notes: form.notes.trim() || null };
    try {
      const saved = existing ? await api.patch<Exhibition>(`/marketing/exhibitions/${existing.id}`, body) : await api.post<Exhibition>('/marketing/exhibitions', body);
      toast('ok', existing ? 'Exhibition updated' : 'Exhibition added');
      onSaved(saved);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={existing ? `Modify exhibition ${existing.name}` : 'New exhibition'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          {existing && (
            <button type="button" className="btn" onClick={onNew} disabled={busy}>
              + New exhibition
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || form.name.trim().length < 2 || !form.startDate || !form.endDate}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label="Name" htmlFor={`${id}-name`} required>
        <input id={`${id}-name`} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="PSECE 2026" />
      </Field>
      <Field label="Venue" htmlFor={`${id}-venue`}>
        <input id={`${id}-venue`} value={form.venue} onChange={(e) => set('venue', e.target.value)} />
      </Field>
      <div className="grid grid-2">
        <Field label="Day 1" htmlFor={`${id}-start`} required>
          <input id={`${id}-start`} type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
        </Field>
        <Field label="Last day" htmlFor={`${id}-end`} required>
          <input id={`${id}-end`} type="date" value={form.endDate} onChange={(e) => set('endDate', e.target.value)} />
        </Field>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} />
        <span>Running — the scanner and the bar graphs open on the latest running exhibition</span>
      </label>
      <Field label="Notes" htmlFor={`${id}-notes`}>
        <textarea id={`${id}-notes`} rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
      </Field>
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * G-OPS — the module overview.
 *
 * G-OPS is three areas of the business under one roof: sales up to the
 * quotation, delivery of the job that follows, and the aftermarket that job
 * turns into. This is the one screen that shows all three at once, in the same
 * three sections the menu is cut into, so "what is on" and "where do I go" are
 * answered by the same page.
 *
 * It is COUNTS, not money. Value belongs to Insights, which reconciles it
 * against the documents behind it (model §11, Phase 9); a second place that
 * adds up the pipeline is a second number to disagree with the first. Every
 * figure here is a row count off a list screen that already exists, so this
 * adds no endpoint and no table — and every tile is a link to the list it
 * counted, because a number you cannot open is a number you cannot act on.
 */

interface Tile {
  label: string;
  /** The list endpoint and filter this counts — the same one the link opens. */
  endpoint: string;
  query: Record<string, string>;
  to: string;
  /** Which screen this belongs to; the tile is hidden if it is not theirs. */
  module: string;
  submodule: string;
  /** Anything above zero wants attention rather than congratulation. */
  warn?: boolean;
}

interface Band {
  name: string;
  blurb: string;
  tiles: Tile[];
}

const BANDS: Band[] = [
  {
    name: 'Sales',
    blurb: 'Everything before there is a job to deliver.',
    tiles: [
      {
        label: 'Quotations out, awaiting a decision',
        endpoint: '/quotations',
        query: { outcome: 'SUBMITTED' },
        to: '/g-ops/quotations',
        module: 'gops',
        submodule: 'quotations',
      },
      {
        label: 'In negotiation',
        endpoint: '/quotations',
        query: { outcome: 'NEGOTIATION' },
        to: '/g-ops/quotations',
        module: 'gops',
        submodule: 'quotations',
      },
      {
        label: 'Costings still in draft',
        endpoint: '/costings',
        query: { status: 'DRAFT' },
        to: '/g-ops/costing',
        module: 'gops',
        submodule: 'costing',
      },
      {
        label: 'Leads on hold',
        endpoint: '/leads',
        query: { status: 'ON_HOLD' },
        to: '/g-ops/leads',
        module: 'gops',
        submodule: 'leads',
        warn: true,
      },
    ],
  },
  {
    name: 'Delivery',
    blurb: 'Jobs won, and how far through them the business is.',
    tiles: [
      {
        label: 'Projects in progress',
        endpoint: '/jobs',
        query: { status: 'IN_PROGRESS', type: 'PROJECT' },
        to: '/g-ops/projects',
        module: 'gops',
        submodule: 'projects',
      },
      {
        label: 'Projects still in planning',
        endpoint: '/jobs',
        query: { status: 'PLANNING', type: 'PROJECT' },
        to: '/g-ops/projects',
        module: 'gops',
        submodule: 'projects',
      },
      {
        label: 'Projects on hold',
        endpoint: '/jobs',
        query: { status: 'ON_HOLD', type: 'PROJECT' },
        to: '/g-ops/projects',
        module: 'gops',
        submodule: 'projects',
        warn: true,
      },
      {
        label: 'Progress reports awaiting approval',
        endpoint: '/progress-reports',
        // SUBMITTED, not PENDING_APPROVAL. A progress report runs on
        // ProgressStatus (DRAFT/SUBMITTED/APPROVED); it is the BILLING that
        // uses PENDING_APPROVAL. Getting it the wrong way round does not fail
        // a type check — the filter is a query string — it 500s the request.
        query: { status: 'SUBMITTED' },
        to: '/g-ops/progress',
        module: 'gops',
        submodule: 'progress_billing',
        warn: true,
      },
    ],
  },
  {
    name: 'Aftermarket',
    blurb: 'What the business installed, and what it still owes those sites.',
    tiles: [
      {
        label: 'Service contracts running',
        endpoint: '/service-contracts',
        query: { status: 'ACTIVE' },
        to: '/g-ops/service-contracts',
        module: 'gops',
        submodule: 'service_contracts',
      },
      {
        label: 'Up for renewal',
        endpoint: '/service-contracts',
        query: { expiring: 'true' },
        to: '/g-ops/renewals',
        module: 'gops',
        submodule: 'renewals',
        warn: true,
      },
      {
        label: 'PM visits due or overdue',
        endpoint: '/service-visits',
        query: { due: 'true' },
        to: '/g-ops/visits',
        module: 'gops',
        submodule: 'visits',
        warn: true,
      },
      {
        label: 'Service reports awaiting approval',
        endpoint: '/service-reports',
        query: { status: 'PENDING_APPROVAL' },
        to: '/g-ops/pm',
        module: 'gops',
        submodule: 'pm_reports',
        warn: true,
      },
    ],
  },
];

/** `null` means the count could not be read — which is not the same as zero. */
type Counts = Record<string, number | null>;

const keyOf = (t: Tile) => `${t.endpoint}?${new URLSearchParams(t.query).toString()}`;

export function OpsDashboard() {
  const { canView } = useAuth();
  const [counts, setCounts] = useState<Counts>({});
  const [loading, setLoading] = useState(true);

  // Only the tiles this person can actually open. A count of something you are
  // not allowed to look at is a permission leak wearing a number.
  const bands = BANDS.map((b) => ({
    ...b,
    tiles: b.tiles.filter((t) => canView(t.module, t.submodule)),
  })).filter((b) => b.tiles.length > 0);

  useEffect(() => {
    const wanted = bands.flatMap((b) => b.tiles);
    if (!wanted.length) {
      setLoading(false);
      return;
    }
    let live = true;

    // Settled, not all: one screen being slow or refusing must not blank the
    // other eleven. A tile that fails shows a dash and says nothing it cannot
    // back up.
    Promise.allSettled(
      wanted.map((t) =>
        api.get<{ total: number }>(`${t.endpoint}${qs({ ...t.query, pageSize: 1 })}`),
      ),
    ).then((results) => {
      if (!live) return;
      const next: Counts = {};
      results.forEach((r, i) => {
        next[keyOf(wanted[i])] = r.status === 'fulfilled' ? r.value.total : null;
      });
      setCounts(next);
      setLoading(false);
    });

    return () => {
      live = false;
    };
    // The tile list is derived from the menu, which does not change while the
    // screen is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>G-OPS</h1>
          <p>
            Sales, delivery and aftermarket — the three halves of an operation that is really one
            thing: a lead becomes a quotation, a quotation becomes a job, and a job becomes
            something to look after. Counts only; the money is in Insights, which reconciles it
            against the documents behind it.
          </p>
        </div>
      </div>

      {bands.length === 0 ? (
        <div className="card muted">
          You have no G-OPS screens yet. Ask an administrator for access to Leads, Projects or
          Service Contracts.
        </div>
      ) : (
        <div className="stack">
          {bands.map((band) => (
            <div key={band.name} className="card">
              <h3 className="card-title">{band.name}</h3>
              <p className="muted" style={{ margin: '0 0 var(--s-4)' }}>
                {band.blurb}
              </p>
              <div className="ops-grid">
                {band.tiles.map((tile) => {
                  const value = counts[keyOf(tile)];
                  return (
                    <Link key={tile.label} to={tile.to} className="card clickable ops-tile">
                      <div className="section-label">{tile.label}</div>
                      <div
                        className={`ops-tile-value${
                          value ? (tile.warn ? ' warn' : ' ok') : ''
                        }`}
                      >
                        {loading ? '·' : (value ?? '—')}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

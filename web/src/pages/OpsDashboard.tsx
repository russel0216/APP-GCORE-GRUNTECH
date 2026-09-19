import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ErrorBox, Loading } from '../components/ui';
import { BarList, Donut, Funnel, Panel, Stat, type Slice } from '../components/charts';

/**
 * G-OPS — the module overview.
 *
 * G-OPS is three stretches of one road: a lead becomes a quotation, a
 * quotation becomes a job, a job becomes something to look after. The page is
 * cut the same three ways the menu is, and each section answers the question
 * that part of the business actually asks:
 *
 *   Sales        Where is the next job coming from, and where is work
 *                falling out of the pipeline?
 *   Delivery     What are we carrying, and what has stopped moving?
 *   Aftermarket  What do we still owe the sites we have installed, and what
 *                is about to lapse?
 *
 * It is COUNTS, not money. Value lives in Insights, which reconciles every
 * figure against the documents behind it (model §11). Two places adding up the
 * pipeline is two pipeline figures, and one of them will be wrong.
 *
 * One request to `/gops/overview`, which groups each entity once — and every
 * bar, slice and tile links to the list it counted, because a figure you
 * cannot open is a figure you cannot act on.
 */

interface Tally {
  [status: string]: number;
}

interface Overview {
  sales: { leads: Tally | null; quotations: Tally | null; costings: Tally | null } | null;
  delivery: { jobs: Tally | null; reportsAwaitingApproval: number | null } | null;
  aftermarket: {
    contracts: Tally | null;
    upForRenewal: number | null;
    visitsDue: number | null;
    reportsAwaitingApproval: number | null;
  } | null;
}

const n = (t: Tally | null | undefined, ...keys: string[]) =>
  keys.reduce((sum, k) => sum + (t?.[k] ?? 0), 0);

export function OpsDashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.get<Overview>('/gops/overview').then(setData).catch(setError);
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading label="Reading the pipeline…" />;

  const { sales, delivery, aftermarket } = data;

  /*
    The sales funnel, in the order work actually moves through the business.
    Lead statuses are grouped into the stages somebody would name out loud:
    nobody asks "how many are in SITE_VISIT", they ask how many enquiries are
    still being worked.
  */
  const funnel: Slice[] = sales
    ? [
        {
          label: 'Enquiries in play',
          value: n(sales.leads, 'NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT'),
          tone: 'info',
          to: '/g-ops/leads',
        },
        {
          label: 'Being costed',
          value: n(sales.leads, 'COSTING') + n(sales.costings, 'DRAFT'),
          tone: 'info',
          to: '/g-ops/costing',
        },
        {
          label: 'Quotation out',
          value: n(sales.quotations, 'SUBMITTED'),
          tone: 'neon',
          to: '/g-ops/quotations',
        },
        {
          label: 'In negotiation',
          value: n(sales.quotations, 'NEGOTIATION'),
          tone: 'warn',
          to: '/g-ops/quotations',
        },
        { label: 'Won', value: n(sales.quotations, 'WON'), tone: 'neon', to: '/g-ops/quotations' },
      ]
    : [];

  const jobs: Slice[] = delivery?.jobs
    ? [
        { label: 'Planning', value: n(delivery.jobs, 'PLANNING'), tone: 'info', to: '/g-ops/projects' },
        { label: 'In progress', value: n(delivery.jobs, 'IN_PROGRESS'), tone: 'neon', to: '/g-ops/projects' },
        { label: 'On hold', value: n(delivery.jobs, 'ON_HOLD'), tone: 'warn', to: '/g-ops/projects' },
        { label: 'Completed', value: n(delivery.jobs, 'COMPLETED'), tone: 'muted', to: '/g-ops/projects' },
        { label: 'Turned over', value: n(delivery.jobs, 'TURNED_OVER'), tone: 'muted', to: '/g-ops/projects' },
      ]
    : [];

  const contracts: Slice[] = aftermarket?.contracts
    ? [
        { label: 'Running', value: n(aftermarket.contracts, 'ACTIVE'), tone: 'neon', to: '/g-ops/service-contracts' },
        { label: 'Expired', value: n(aftermarket.contracts, 'EXPIRED'), tone: 'danger', to: '/g-ops/renewals' },
        { label: 'Renewed', value: n(aftermarket.contracts, 'RENEWED'), tone: 'info', to: '/g-ops/service-contracts' },
        { label: 'Draft', value: n(aftermarket.contracts, 'DRAFT'), tone: 'muted', to: '/g-ops/service-contracts' },
      ]
    : [];

  const lost = sales ? n(sales.leads, 'LOST') + n(sales.quotations, 'LOST') : 0;
  const onHold = sales ? n(sales.leads, 'ON_HOLD') : 0;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>G-OPS</h1>
          <p>
            Sales, delivery and aftermarket — one road, three stretches. A lead becomes a
            quotation, a quotation becomes a job, and a job becomes something to look after.
            Counts only; the money is in Insights, which reconciles it against the documents
            behind it.
          </p>
        </div>
      </div>

      {!sales && !delivery && !aftermarket ? (
        <div className="card muted">
          You have no G-OPS screens yet. Ask an administrator for access to Leads, Projects or
          Service Contracts.
        </div>
      ) : (
        <div className="stack">
          {sales && (
            <Panel
              title="Sales"
              blurb="Where the next job comes from. The stage where the bar narrows sharply is where work is being lost."
              action={
                <Link to="/g-ops/pipeline" className="btn btn-sm">
                  Open pipeline
                </Link>
              }
            >
              <Funnel
                stages={funnel}
                caption="Enquiry through to won, with the drop-off at each stage"
              />
              <div className="grid grid-2">
                <Stat
                  label="On hold"
                  icon="clock"
                  value={onHold}
                  tone="warn"
                  to="/g-ops/leads"
                  hint="Waiting on the customer"
                />
                <Stat
                  label="Lost"
                  icon="alert"
                  value={lost}
                  tone="muted"
                  to="/g-ops/leads"
                  hint="Leads and quotations together"
                />
              </div>
            </Panel>
          )}

          {delivery && (
            <Panel
              title="Delivery"
              blurb="The jobs the business is carrying, and anything that has stopped moving."
              action={
                <Link to="/g-ops/projects" className="btn btn-sm">
                  Open projects
                </Link>
              }
            >
              <div className="grid grid-2">
                <Donut
                  slices={jobs}
                  centreLabel="projects"
                  caption="Every project, by where it has got to"
                />
                <div className="stack">
                  <Stat
                    label="Progress reports awaiting approval"
                    icon="document"
                    value={delivery.reportsAwaitingApproval}
                    tone="warn"
                    to="/g-ops/progress"
                    hint="Nothing can be billed until these are approved"
                  />
                  <Stat
                    label="Projects on hold"
                    icon="clock"
                    value={n(delivery.jobs, 'ON_HOLD')}
                    tone="warn"
                    to="/g-ops/projects"
                    hint="Costing money, earning nothing"
                  />
                </div>
              </div>
            </Panel>
          )}

          {aftermarket && (
            <Panel
              title="Aftermarket"
              blurb="What the business still owes the sites it has installed — and the cover that is about to lapse."
              action={
                <Link to="/g-ops/renewals" className="btn btn-sm">
                  Open renewals
                </Link>
              }
            >
              <div className="grid grid-2">
                <BarList slices={contracts} caption="Service contracts, by state" />
                <div className="stack">
                  <Stat
                    label="Up for renewal"
                    icon="calendar"
                    value={aftermarket.upForRenewal}
                    tone="warn"
                    to="/g-ops/renewals"
                    hint="Running, but ending within 60 days"
                  />
                  <Stat
                    label="PM visits due or overdue"
                    icon="wrench"
                    value={aftermarket.visitsDue}
                    tone="danger"
                    to="/g-ops/visits"
                    hint="Scheduled, and the date has passed"
                  />
                  <Stat
                    label="Service reports awaiting approval"
                    icon="document"
                    value={aftermarket.reportsAwaitingApproval}
                    tone="warn"
                    to="/g-ops/pm"
                    hint="A visit is not complete until its report is approved"
                  />
                </div>
              </div>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}

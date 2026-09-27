import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { todayLocal } from '../lib/day';
import { ErrorBox, Loading } from '../components/ui';
import { BarList, Donut, Funnel, Panel, Stat, type Slice } from '../components/charts';
import { RangePicker } from './insights/Overview';

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
 *   Aftermarket  What cover are we carrying on the sites we have installed,
 *                and how much maintenance actually got done?
 *
 * It is COUNTS, not money. Value lives in Insights, which reconciles every
 * figure against the documents behind it (model §11). Two places adding up the
 * pipeline is two pipeline figures, and one of them will be wrong.
 *
 * One request to `/gops/overview`, which groups each entity once — and every
 * bar, slice and tile links to the list it counted, because a figure you
 * cannot open is a figure you cannot act on.
 *
 * The date range (year to date by default, or month to date, or a custom
 * span — the same `RangePicker` every Insights report uses) governs the
 * figures that ARE a period question: the sales funnel, and the PM
 * accomplished in Aftermarket. The rest answer "what are we carrying right
 * now" — a project doesn't stop being IN_PROGRESS, and cover doesn't stop
 * running, because it falls outside the window — so those stay live whatever
 * range is showing. See the matching comment on `periodWhere` in
 * api/src/routes/gops.ts.
 */

interface Tally {
  [status: string]: number;
}

interface Overview {
  sales: { leads: Tally | null; quotations: Tally | null; costings: Tally | null } | null;
  delivery: { jobs: Tally | null; reportsAwaitingApproval: number | null } | null;
  aftermarket: {
    contracts: Tally | null;
    activeContracts: number | null;
    pmAccomplished: number | null;
  } | null;
}

const n = (t: Tally | null | undefined, ...keys: string[]) =>
  keys.reduce((sum, k) => sum + (t?.[k] ?? 0), 0);

export function OpsDashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(todayLocal());

  useEffect(() => {
    api
      .get<Overview>(`/gops/overview${qs({ from, to })}`)
      .then(setData)
      .catch(setError);
  }, [from, to]);

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

        {/*
          The range sits with the page title, not inside a panel — so the line
          under it says what it reaches, because a control in the page head
          reads as governing the whole page unless it says otherwise. Shown to
          anyone holding either block it affects, not Sales alone: someone with
          Aftermarket and no Sales still needs to pick the period their PM
          count is measured over.
        */}
        {(sales || aftermarket) && (
          <div>
            <RangePicker
              from={from}
              to={to}
              onChange={(f, t) => {
                setFrom(f);
                setTo(t);
              }}
            />
            <div className="faint" style={{ fontSize: 'var(--fs-xs)', textAlign: 'right' }}>
              Sales and PM accomplished — everything else shows what is open now
            </div>
          </div>
        )}
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
              <div className="grid grid-2">
                <Funnel
                  stages={funnel}
                  caption="Enquiry through to won, with the drop-off at each stage"
                />
                <div className="stack fill">
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
              </div>
            </Panel>
          )}

          {delivery && (
            <Panel
              title="Project"
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
              blurb="The cover the business is carrying on the sites it has installed, and the maintenance actually carried out against it."
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
                    label="Contracts"
                    icon="document"
                    value={aftermarket.activeContracts}
                    tone="neon"
                    to="/g-ops/service-contracts"
                    hint="Cover running today"
                  />
                  <Stat
                    label="PM accomplished"
                    icon="check"
                    value={aftermarket.pmAccomplished}
                    tone="neon"
                    to="/g-ops/visits?mode=list&status=COMPLETED&kind=PREVENTIVE_MAINTENANCE"
                    hint="Preventive maintenance completed in the selected range"
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

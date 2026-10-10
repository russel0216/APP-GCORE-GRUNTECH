import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { ErrorBox, Loading, StatusBadge, formatDateTime, humanise, type Tone } from '../../../components/ui';
import { BarList, Panel, Stat, type Slice } from '../../../components/charts';

/**
 * HR Settings › Face health (2026-10-10, after colleagues were matched to
 * each other's accounts): how ready the office is to clock in by face, and
 * where the clock is likely to go wrong — `GET /clock/face-health`
 * (`ghr.settings.view_all`).
 *
 * - People: ready (3 or more samples from the present engine), partial (1–2),
 *   only old samples the clock no longer reads, none.
 * - Faces close together: two people whose nearest samples sit within the
 *   threshold + 0.10. Within threshold + margin the clock cannot tell them
 *   apart and refuses one of them as "not sure"; retaking both people's
 *   samples in good light is the fix.
 * - Unlike the others: a sample far from the same person's other samples —
 *   blurred, dark, or someone else's — and an account whose two furthest
 *   samples are that far apart (two faces, each with a twin of its own).
 *   Each links to the person's samples on their employee record, where it is
 *   marked and can be removed — for whoever holds the employee edit right,
 *   the one the Face samples tab takes; anyone else reading this panel (an
 *   executive) sees the names alone, never a link to a tab they cannot open.
 * - Not protected yet: people with only old samples, which the clock does
 *   not compare — a colleague could enrol their face unrefused until they
 *   add new ones.
 * - Refusals in the last 30 days, by reason, read from the audit trail, and
 *   the latest one by one with whose face each came near: the name the
 *   refused person is never told, which is HR's to know.
 */

interface Person {
  id: string;
  name: string;
}

interface FaceHealth {
  engine: string;
  threshold: number;
  margin: number;
  samplesNeeded?: number;
  people: { ready: number; partial: number; legacyOnly: number; none: number };
  closePairs: { a: Person; b: Person; distance: number }[];
  outliers: { employee: Person; sampleId: string; distance: number }[];
  /** Accounts whose two furthest samples are further apart than an enrolment would accept. */
  mixedAccounts?: { employee: Person; distance: number; sampleIds: [string, string] }[];
  /** Active people with only old-engine samples. */
  unprotected?: Person[];
  /** Every reason the clock refuses a face for, each with its count (0 included) and HR's words for it. */
  refusals30d: { total: number; reasons: { reason: string; label?: string; count: number }[] };
  /** The latest refusals — clock and enrolment — one by one, newest first. */
  recentRefusals?: RecentRefusal[];
}

interface RecentRefusal {
  id: string;
  at: string;
  kind: 'clock' | 'enrol';
  reason: string;
  label: string;
  action: 'IN' | 'OUT' | null;
  employee: Person;
  /** Who was at the camera (an enrolment may be HR's, for somebody else). */
  by: string | null;
  ownDistance: number | null;
  nearestOther: (Person & { distance: number | null }) | null;
}

const PAIR_TONES: Record<string, Tone> = { TOO_CLOSE: 'danger', CLOSE: 'warn' };

/**
 * What the clock said, at a glance: the refusals that are about WHO it was —
 * a colleague's face, too close to tell, or a photo already on file sent
 * again — are red, those about the picture amber.
 */
const IDENTITY_REASONS = new Set(['not_this_account', 'unsure', 'replay']);

/**
 * Short names for the bar labels, which have room for about twenty
 * characters; the server's own label (shared/faceSamples.ts) is the fallback
 * for a reason added later.
 */
const SHORT_LABELS: Record<string, string> = {
  too_few_samples: 'Too few samples',
  quality: 'Poor picture',
  no_face: 'No face found',
  several_faces: 'Several faces',
  unreadable: 'Unreadable photo',
  replay: 'Photo sent again',
  not_recognised: 'Not recognised',
  not_this_account: 'Someone else’s face',
  unsure: 'Too close to tell',
};

function refusalSlices(refusals: FaceHealth['refusals30d'] | undefined): Slice[] {
  return (refusals?.reasons ?? [])
    .filter((r) => r.count > 0)
    .sort((x, y) => y.count - x.count)
    .map((r) => ({
      label: SHORT_LABELS[r.reason] ?? r.label ?? humanise(r.reason),
      value: r.count,
      tone: IDENTITY_REASONS.has(r.reason) ? 'danger' : 'warn',
    }));
}

const two = (n: number) => n.toFixed(2);

/** A person, linked to their samples where the viewer may open them. */
function PersonLink({ person, linked, sampleId }: { person: Person; linked: boolean; sampleId?: string }) {
  if (!linked) return <>{person.name}</>;
  const sample = sampleId ? `&sample=${encodeURIComponent(sampleId)}` : '';
  return <Link to={`/g-hr/employees/${person.id}?tab=face${sample}`}>{person.name}</Link>;
}

const RECENT_TONES: Record<string, Tone> = { CLOCK: 'info', ENROL: '' };

export function FaceHealthPanel({ reloadToken = 0 }: { reloadToken?: number }) {
  const { can } = useAuth();
  // The Face samples tab on the employee record is the employee EDIT right's.
  const linked = can('ghr.employees.edit_all');
  const [health, setHealth] = useState<FaceHealth | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setHealth(await api.get<FaceHealth>('/clock/face-health'));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const refresh = (
    <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={busy}>
      {busy ? 'Checking…' : 'Check again'}
    </button>
  );

  if (!health) {
    return (
      <Panel title="Face health" action={refresh}>
        {error ? <ErrorBox error={error} /> : <Loading label="Checking the enrolled faces…" />}
      </Panel>
    );
  }

  const { people, closePairs, outliers, threshold, margin } = health;
  const mixed = health.mixedAccounts ?? [];
  const unprotected = health.unprotected ?? [];
  const recent = health.recentRefusals ?? [];
  const tooClose = threshold + margin;
  const refusals = refusalSlices(health.refusals30d);
  const refusedTotal = health.refusals30d?.total ?? refusals.reduce((sum, s) => sum + s.value, 0);
  const total = people.ready + people.partial + people.legacyOnly + people.none;

  return (
    <Panel
      title="Face health"
      blurb={`Who can clock in by face, whose enrolled faces sit close together, and why the clock refused in the last 30 days. Matching at ${two(threshold)} with a ${two(margin)} margin.`}
      action={refresh}
    >
      <ErrorBox error={error} />
      <div className="kpi-grid list-summary">
        <Stat
          label="Ready"
          value={people.ready}
          hint={`of ${total} active · 3+ samples`}
          accent={people.ready > 0 ? 'ok' : undefined}
        />
        <Stat
          label="Partly enrolled"
          value={people.partial}
          hint="1–2 samples · cannot clock in by face yet"
          accent={people.partial > 0 ? 'warn' : undefined}
        />
        <Stat
          label="Old samples only"
          value={people.legacyOnly}
          hint="need new samples since the upgrade"
          accent={people.legacyOnly > 0 ? 'warn' : undefined}
        />
        <Stat label="No samples" value={people.none} hint="fallback only" />
        <Stat
          label="Refused, 30 days"
          value={refusedTotal}
          hint={refusedTotal ? 'see the reasons below' : 'no face refusals'}
          accent={refusedTotal > 0 ? 'warn' : undefined}
        />
      </div>

      <div className="grid grid-2 face-health-lists">
        <div>
          <h4>Faces close together</h4>
          <p className="muted">
            Two people whose enrolled faces are within {two(threshold + 0.1)} of each other, closest first. Within{' '}
            {two(tooClose)} the clock cannot tell them apart and refuses as “not sure” — retake both people’s samples
            facing the camera in good light.
          </p>
          {closePairs.length === 0 ? (
            <p className="faint">No two people’s faces are that close.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Employee</th>
                    <th className="right">Distance</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {closePairs.map((p) => (
                    <tr key={`${p.a.id}-${p.b.id}`}>
                      <td>
                        <PersonLink person={p.a} linked={linked} />
                      </td>
                      <td>
                        <PersonLink person={p.b} linked={linked} />
                      </td>
                      <td className="right mono">{two(p.distance)}</td>
                      <td>
                        <StatusBadge
                          status={p.distance <= tooClose ? 'TOO_CLOSE' : 'CLOSE'}
                          extra={PAIR_TONES}
                          label={p.distance <= tooClose ? 'Too close' : 'Close'}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <h4>Samples unlike the others</h4>
          <p className="muted">
            A sample further than {two(tooClose)} from the same person’s other samples — blurred, dark, or of
            somebody else — and an account whose two furthest samples are that far apart, which can hold two faces
            side by side. {linked ? 'Open the person’s samples to look, and remove what is wrong.' : 'HR can open the person’s samples to look.'}
          </p>
          {outliers.length === 0 && mixed.length === 0 ? (
            <p className="faint">Every sample looks like its owner’s others.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>What</th>
                    <th className="right">Distance</th>
                    {linked && <th />}
                  </tr>
                </thead>
                <tbody>
                  {outliers.map((o) => (
                    <tr key={o.sampleId}>
                      <td>{o.employee.name}</td>
                      <td>One sample unlike the rest</td>
                      <td className="right mono">{two(o.distance)}</td>
                      {linked && (
                        <td>
                          <Link
                            to={`/g-hr/employees/${o.employee.id}?tab=face&sample=${encodeURIComponent(o.sampleId)}`}
                          >
                            Open samples →
                          </Link>
                        </td>
                      )}
                    </tr>
                  ))}
                  {mixed.map((m) => (
                    <tr key={`mixed-${m.employee.id}`}>
                      <td>{m.employee.name}</td>
                      <td>Samples far apart — two faces?</td>
                      <td className="right mono">{two(m.distance)}</td>
                      {linked && (
                        <td>
                          <Link
                            to={`/g-hr/employees/${m.employee.id}?tab=face&sample=${encodeURIComponent(m.sampleIds[0])}`}
                          >
                            Open samples →
                          </Link>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h4 className="hraud-after">Not protected yet</h4>
          {unprotected.length === 0 ? (
            <p className="faint">Nobody is left with only old samples.</p>
          ) : (
            <>
              <p className="muted">
                Only samples from before the upgrade, which the clock no longer compares — so it cannot yet refuse a
                colleague enrolling their face. Ask them to add {health.samplesNeeded ?? 3} new samples on the Clock
                page.
              </p>
              <ul className="face-health-names">
                {unprotected.map((p) => (
                  <li key={p.id}>
                    <PersonLink person={p} linked={linked} />
                  </li>
                ))}
              </ul>
            </>
          )}

          <h4 className="hraud-after">Refusals in the last 30 days</h4>
          <BarList
            slices={refusals}
            caption="Red: somebody else's face, too close to tell, or a photo sent again. Amber: the picture, or too few samples."
          />
        </div>
      </div>

      <h4 className="hraud-after">Latest refusals</h4>
      <p className="muted">
        The clock never tells the person at the camera whose face theirs came near; this list does, for HR. A refusal
        that names a colleague is worth a look at both people’s samples.
      </p>
      {recent.length === 0 ? (
        <p className="faint">No face was refused in the last 30 days.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Where</th>
                <th>Account</th>
                <th>Why</th>
                <th className="right">Own</th>
                <th>Nearest other</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td className="face-health-when">{formatDateTime(r.at)}</td>
                  <td>
                    <StatusBadge
                      status={r.kind.toUpperCase()}
                      extra={RECENT_TONES}
                      label={r.kind === 'enrol' ? 'Enrolment' : r.action === 'OUT' ? 'Clock out' : 'Clock in'}
                    />
                  </td>
                  <td>
                    <PersonLink person={r.employee} linked={linked} />
                    {r.by && r.by !== r.employee.name && <div className="faint">by {r.by}</div>}
                  </td>
                  <td>{r.label}</td>
                  <td className="right mono">{r.ownDistance != null ? two(r.ownDistance) : '—'}</td>
                  <td>
                    {r.nearestOther ? (
                      <>
                        <PersonLink person={r.nearestOther} linked={linked} />{' '}
                        {r.nearestOther.distance != null && <span className="mono">{two(r.nearestOther.distance)}</span>}
                      </>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

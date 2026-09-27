import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, qs, type ListResult } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Loading, StatusBadge, formatDate, humanise } from '../../components/ui';
import {
  EVALUATION_TONES,
  RECOMMENDATION,
  ScheduleModal,
  dueText,
  type EvaluationRow,
  type SchedulePreset,
} from './Evaluations';

/**
 * The employee record's Evaluations tab — where this person stands in their
 * probation or training, and every evaluation written about them.
 *
 * The milestones are worked out on the server from the hire date (or the day
 * a trainee was absorbed), the configured months and the period end — this
 * tab only shows them. Mounted by the employee record for holders of
 * `ghr.evaluations.view_all`; the three props are what the record already has
 * loaded, so the heading does not wait on a request.
 */

interface MilestonePicture {
  kind: string | null;
  anchor: string | null;
  periodEnd: string | null;
  milestones: {
    milestone: string;
    label: string;
    dueDate: string;
    daysLeft: number;
    evaluation: { id: string; number: string; status: string; recommendation: string | null } | null;
  }[];
}

export function EmployeeEvaluationsTab({
  employeeId,
  employmentType,
  dateRegularized,
}: {
  employeeId: string;
  employmentType: string;
  dateRegularized: string | null;
}) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const canCreate = can('ghr.evaluations.create');

  const [picture, setPicture] = useState<MilestonePicture | null>(null);
  const [history, setHistory] = useState<EvaluationRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [preset, setPreset] = useState<SchedulePreset | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, h] = await Promise.all([
        api.get<MilestonePicture>(`/evaluations/milestones/${employeeId}`),
        api.get<ListResult<EvaluationRow>>(`/evaluations${qs({ employeeId, pageSize: 100, sort: 'createdAt', dir: 'desc' })}`),
      ]);
      setPicture(p);
      setHistory(h.rows);
      setError(null);
    } catch (err) {
      setError(err);
      setPicture(null);
      setHistory([]);
    }
  }, [employeeId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!picture && !history && !error) return <Loading label="Reading the evaluations…" />;

  const onPeriod = employmentType === 'PROBATIONARY' || employmentType === 'TRAINEE';

  return (
    <div className="eval-tab">
      <ErrorBox error={error} />

      <div className="eval-tab-head">
        {onPeriod ? (
          <p className="eval-flush">
            <strong>{humanise(employmentType)}</strong>
            {picture?.anchor ? ` since ${formatDate(picture.anchor)}` : ''}
            {picture?.periodEnd ? (
              <>
                {' '}
                · the period ends <strong>{formatDate(picture.periodEnd)}</strong>
              </>
            ) : employmentType === 'TRAINEE' ? (
              ' · no training period end is set — enter one on the Employment tab so the end evaluation can fall due'
            ) : (
              ''
            )}
          </p>
        ) : (
          <p className="eval-flush muted">
            {employmentType === 'REGULAR' && dateRegularized
              ? `Regular since ${formatDate(dateRegularized)}. Evaluations are for probationary and trainee staff; any written before regularisation are listed below.`
              : `${humanise(employmentType)} — evaluations here are for probationary and trainee staff.`}
          </p>
        )}
      </div>

      {onPeriod && picture && picture.milestones.length > 0 && (
        <section className="card" aria-label="Milestones">
          <h3 className="card-title">Milestones</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Evaluation</th>
                  <th>Due</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {picture.milestones.map((m) => (
                  <tr key={`${m.milestone}-${m.dueDate}`}>
                    <td>{m.label}</td>
                    <td>
                      <div className="mono">{formatDate(m.dueDate)}</div>
                      {!m.evaluation && <div className={m.daysLeft < 0 ? 'eval-overdue' : 'faint'}>{dueText(m.daysLeft)}</div>}
                    </td>
                    <td>
                      {m.evaluation ? (
                        <span className="eval-inline">
                          <Link to={`/g-hr/evaluations/${m.evaluation.id}`} className="mono">
                            {m.evaluation.number}
                          </Link>
                          <StatusBadge status={m.evaluation.status} extra={EVALUATION_TONES} />
                        </span>
                      ) : canCreate ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            setPreset({ employeeId, employeeName: 'This employee', milestone: m.milestone, dueDate: m.dueDate.slice(0, 10) })
                          }
                        >
                          Schedule
                        </button>
                      ) : (
                        <span className="faint">not scheduled</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card" aria-label="Evaluation history">
        <div className="panel-head">
          <h3 className="card-title">History</h3>
          {onPeriod && canCreate && (
            <button type="button" className="btn btn-sm" onClick={() => setPreset({ employeeId, employeeName: 'This employee', milestone: 'ADHOC' })}>
              + Ad hoc evaluation
            </button>
          )}
        </div>
        {history && history.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Evaluation</th>
                  <th>Evaluator</th>
                  <th className="right">Score</th>
                  <th>Recommendation</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/g-hr/evaluations/${r.id}`} className="mono">
                        {r.number}
                      </Link>
                    </td>
                    <td>
                      <div>{r.milestoneLabel}</div>
                      <div className="faint">
                        {humanise(r.kind)} · due {formatDate(r.dueDate)}
                      </div>
                    </td>
                    <td>{r.evaluator.name}</td>
                    <td className="right mono">{r.score == null ? '—' : r.score.toFixed(2)}</td>
                    <td>{r.recommendation ? RECOMMENDATION[r.recommendation]?.label ?? humanise(r.recommendation) : <span className="faint">—</span>}</td>
                    <td>
                      <StatusBadge status={r.status} extra={EVALUATION_TONES} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="collection-empty">No evaluations written yet.</p>
        )}
      </section>

      {preset && (
        <ScheduleModal
          preset={preset}
          onClose={() => setPreset(null)}
          onCreated={(id) => {
            setPreset(null);
            navigate(`/g-hr/evaluations/${id}`);
          }}
        />
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { StatusBadge, formatDate, formatTime } from '../../components/ui';

/**
 * My attendance issues (2026-11-13, the owner's call: "the requestor can
 * easily check — a list of what he/she late clock in or missed clock out"):
 * the caller's own late clock-ins, missed clock-outs and absences of the last
 * sixty days (`GET /my-records/issues`, the daily time record's own rule),
 * newest first, each with its time appeal — "Request adjustment" opens the
 * Time Appeals form on that day, the explanation required there; once asked,
 * the row says where it stands. Shown on Clock In/Out and My Records.
 */

interface Row {
  date: string;
  weekday: string;
  issues: ('LATE' | 'NO_CLOCK_OUT' | 'ABSENT')[];
  lateMinutes: number;
  timeIn: string | null;
  timeOut: string | null;
  appeal: { id: string; number: string; status: string; statusLabel: string; waitingOn: string | null } | null;
}
interface Issues {
  employee: boolean;
  days: number;
  rows: Row[];
  counts: { late: number; noClockOut: number; absent: number; unexplained: number };
}

const ISSUE_WORDS: Record<Row['issues'][number], string> = { LATE: 'Late clock-in', NO_CLOCK_OUT: 'No clock-out', ABSENT: 'Absent' };

const lateText = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}min late` : `${m} min late`);

export function AttendanceIssues({ reloadToken = 0 }: { reloadToken?: number }) {
  const [data, setData] = useState<Issues | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api
      .get<Issues>('/my-records/issues')
      .then(setData)
      .catch(() => setFailed(true));
  }, [reloadToken]);
  if (failed || !data || !data.employee) return null;
  const { counts, rows } = data;
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">My attendance issues</h3>
        <span className="faint">last {data.days} days</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted hraud-flush">No late clock-in, missed clock-out or absence in the last {data.days} days.</p>
      ) : (
        <>
          <p className="faint hraud-flush">
            {[counts.late && `${counts.late} late`, counts.noClockOut && `${counts.noClockOut} without a clock-out`, counts.absent && `${counts.absent} absent`].filter(Boolean).join(' · ')}
            {counts.unexplained ? ` — ${counts.unexplained} not explained yet` : ' — every one has an appeal'}
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>What happened</th>
                  <th>Clock</th>
                  <th>Time appeal</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const open = !r.appeal || ['REJECTED', 'CANCELLED'].includes(r.appeal.status);
                  return (
                    <tr key={r.date}>
                      <td>
                        {formatDate(r.date)} <span className="faint">{r.weekday}</span>
                      </td>
                      <td>
                        {r.issues.map((i) => (
                          <div key={i}>
                            {ISSUE_WORDS[i]}
                            {i === 'LATE' && <span className="faint"> · {lateText(r.lateMinutes)}</span>}
                          </div>
                        ))}
                      </td>
                      <td className="mono">
                        {r.timeIn ? formatTime(r.timeIn) : '—'} – {r.timeOut ? formatTime(r.timeOut) : '—'}
                      </td>
                      <td>
                        {r.appeal && (
                          <div>
                            <Link to={`/g-hr/attendance-corrections/${r.appeal.id}`} className="mono">
                              {r.appeal.number}
                            </Link>{' '}
                            <StatusBadge status={r.appeal.status} label={r.appeal.statusLabel} />
                            {r.appeal.waitingOn && <div className="faint">waiting on {r.appeal.waitingOn}</div>}
                          </div>
                        )}
                        {open && (
                          <Link className="btn btn-sm" to={`/g-hr/attendance-corrections?new=1&date=${r.date}`}>
                            Request adjustment
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

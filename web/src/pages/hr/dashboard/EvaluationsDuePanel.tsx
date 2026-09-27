import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { Panel, Stat } from '../../../components/charts';
import { DueTable, scheduleLink, type DueResponse } from '../Evaluations';

/**
 * The HR dashboard's evaluations block: who is due a probation or trainee
 * evaluation, and who is already past it. The same `GET /evaluations/due` the
 * Evaluations page reads, rendered with the same table, so the dashboard and
 * the screen it opens cannot name different people.
 *
 * Two exports, both prop-less:
 *   `EvaluationsDueStat`  one tile, for the dashboard's kpi-grid (the sixth);
 *   `EvaluationsDuePanel` the tile's figures and the list, for under the
 *                         attendance table.
 * Either renders nothing for somebody without `ghr.evaluations.view_all`.
 */

function useDue(): DueResponse | null {
  const { can } = useAuth();
  const allowed = can('ghr.evaluations.view_all');
  const [due, setDue] = useState<DueResponse | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    api
      .get<DueResponse>('/evaluations/due')
      .then((d) => live && setDue(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [allowed]);

  return allowed ? due : null;
}

export function EvaluationsDueStat() {
  const due = useDue();
  if (!due) return null;
  return (
    <Stat
      label="Evaluations due"
      value={due.due}
      sub={
        due.due === 0
          ? 'nobody inside the notice window'
          : `${due.overdue} overdue · ${due.uncovered} not yet scheduled`
      }
      accent={due.overdue > 0 ? 'danger' : due.uncovered > 0 ? 'warn' : 'quiet'}
      icon="check"
      to="/g-hr/evaluations"
      more="Open evaluations"
    />
  );
}

export function EvaluationsDuePanel() {
  const due = useDue();
  if (!due) return null;

  return (
    <Panel
      title="Evaluations due"
      blurb="Probationary and trainee milestones inside the notice window, and any already past. Worked out from each hire date and period end on every read — nothing stores it."
      action={
        <Link to="/g-hr/evaluations" className="btn btn-sm">
          All evaluations
        </Link>
      }
    >
      <p className="eval-due-figures">
        <strong className="mono">{due.due}</strong> due · <strong className="mono">{due.overdue}</strong> overdue ·{' '}
        <strong className="mono">{due.uncovered}</strong> not yet scheduled
      </p>
      <DueTable rows={due.rows} scheduleHref={scheduleLink} limit={8} />
    </Panel>
  );
}

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { ApprovalStepper, previewSteps, type PreviewRoute } from '../../components/ApprovalStepper';

interface Answer {
  route: PreviewRoute | null;
  reportsTo: { name: string; active: boolean } | null;
  stepsUpTo: string | null;
}

/**
 * Where a leave or overtime filing goes, under the form (2026-10-23, the
 * owner's report: requests "not appearing to superior"). With no "Reports
 * to" the Supervisor step goes to HR — said in words, so the person asks for
 * it to be set rather than waiting on a superior who never sees it.
 */
export function FilingRoute({ path }: { path: string }) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  useEffect(() => {
    api
      .get<Answer>(path)
      .then(setAnswer)
      .catch(() => setAnswer(null));
  }, [path]);
  if (!answer?.route) return null;
  return (
    <div className="qd-route">
      {!answer.reportsTo && (
        <div className="alert warn">
          You have no “Reports to” set, so this goes to HR instead of a superior. Ask an administrator to set it on Admin › Users.
        </div>
      )}
      {answer.reportsTo && !answer.reportsTo.active && (
        <div className="alert warn">
          Your “Reports to”, {answer.reportsTo.name}, is no longer active — this goes to {answer.stepsUpTo ?? 'HR'} instead. Ask an administrator to update it on
          Admin › Users.
        </div>
      )}
      <span className="qd-route-label">Submit for approval sends it to</span>
      <ApprovalStepper steps={previewSteps(answer.route)} />
    </div>
  );
}

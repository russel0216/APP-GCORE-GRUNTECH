import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, useToast } from '../../components/ui';
import { rolesByLevel } from '../../lib/roleLevels';

interface HRole {
  id: string;
  name: string;
  rank: number | null;
  reportsToRoleId: string | null;
  userCount: number;
}

interface ApplyResult {
  applied: boolean;
  moves: { userId: string; name: string; from: string | null; to: string; via: string }[];
  unclear: { name: string; reason: string }[];
}

/**
 * Admin › Roles › Hierarchy (2026-10-19): "Reports to" set by ROLE. Saving
 * changes the roles only; "Apply to people" previews, then writes each
 * holder's "Reports to" from it (same team first).
 */
export function RoleHierarchy({ roles, onSaved }: { roles: HRole[]; onSaved: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const editable = can('admin.roles.edit_all');
  const [parent, setParent] = useState<Record<string, string>>(() =>
    Object.fromEntries(roles.map((r) => [r.id, r.reportsToRoleId ?? ''])),
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ApplyResult | null>(null);
  const dirty = roles.some((r) => (r.reportsToRoleId ?? '') !== parent[r.id]);
  const levels = useMemo(() => rolesByLevel(roles), [roles]);

  const save = async () => {
    setBusy(true);
    try {
      await api.put('/roles/hierarchy', {
        roles: roles.map((r) => ({ id: r.id, reportsToRoleId: parent[r.id] || null })),
      });
      toast('ok', 'Hierarchy saved');
      setError(null);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const run = async (apply: boolean) => {
    setBusy(true);
    try {
      const r = await api.post<ApplyResult>(`/roles/hierarchy/apply${apply ? '?apply=true' : ''}`, {});
      setPreview(r);
      if (apply) toast('ok', `${r.moves.length} people's "Reports to" updated`);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <ErrorBox error={error} />
      <div className="card">
        <div className="card-head">
          <h2 className="card-title">Who each role reports to</h2>
          <div className="card-actions">
            {can('admin.users.edit_all') && (
              <button type="button" className="btn btn-sm" disabled={busy || dirty} onClick={() => void run(false)}>
                Apply to people…
              </button>
            )}
            {editable && (
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || !dirty} onClick={() => void save()}>
                Save
              </button>
            )}
          </div>
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>Role</th>
              <th>People</th>
              <th>Reports to (role)</th>
            </tr>
          </thead>
          <tbody>
            {levels.flatMap((level) => [
              <tr key={level.label}>
                <td colSpan={3} className="svc-subhead">{level.label}</td>
              </tr>,
              ...level.roles.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.userCount}</td>
                  <td>
                    <select
                      aria-label={`${r.name} reports to`}
                      value={parent[r.id]}
                      disabled={!editable}
                      onChange={(e) => setParent((p) => ({ ...p, [r.id]: e.target.value }))}
                    >
                      <option value="">— top / none —</option>
                      {roles.filter((o) => o.id !== r.id).map((o) => (
                        <option key={o.id} value={o.id}>{o.name}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>

      {preview && (
        <div className="card">
          <div className="card-head">
            <h2 className="card-title">{preview.applied ? 'Applied' : 'What applying would change'}</h2>
            <div className="card-actions">
              {!preview.applied && preview.moves.length > 0 && (
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(true)}>
                  Apply {preview.moves.length} change{preview.moves.length === 1 ? '' : 's'}
                </button>
              )}
            </div>
          </div>
          {preview.moves.length === 0 && <p>Everyone's "Reports to" already follows the hierarchy.</p>}
          {preview.moves.length > 0 && (
            <table className="data">
              <thead>
                <tr><th>Person</th><th>Now reports to</th><th>Will report to</th><th>Because</th></tr>
              </thead>
              <tbody>
                {preview.moves.map((m) => (
                  <tr key={m.userId}><td>{m.name}</td><td>{m.from ?? '—'}</td><td>{m.to}</td><td>{m.via}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {preview.unclear.length > 0 && (
            <>
              <h3 className="svc-subhead">Left as they are — set by hand on Admin › Users</h3>
              <ul>
                {preview.unclear.map((u) => <li key={u.name}>{u.name}: {u.reason}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { mayEditPage, useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, useToast } from '../../components/ui';
import { TickPicker } from '../../components/TickPicker';
import { PeoplePicker } from '../../components/PeoplePicker';
import { toPerson, usePeople } from '../../components/People';

/*
  Team managers (2026-10-19, the owner's call: "KAT's Technical Manager and
  Aftermarket Manager are shared with GIB, UIT and HIT's; later prepare the
  setting if someone is hired to that role"). Each team's Team Leader,
  Technical Manager, Sales Manager and Aftermarket Manager is its OWN holders
  of the role (the default), SHARED with other teams' holders, or named
  PEOPLE. The approval engine reads it first (shared/teamPosts.ts). When
  KAT hires its own Technical Manager: give them the role with Team = KAT,
  then set KAT's post back to "Its own team".
*/

type Mode = 'OWN' | 'SHARED' | 'PEOPLE';

interface Post {
  roleKey: string;
  label: string;
  mode: Mode;
  sharedTeamIds: string[];
  userIds: string[];
  people: { id: string; name: string }[];
}

interface Team {
  id: string;
  code: string;
  name: string;
  posts: Post[];
}

const MODE_LABEL: Record<Mode, string> = {
  OWN: 'Its own team',
  SHARED: 'Shared from',
  PEOPLE: 'Named people',
};

export function TeamPostsCard() {
  const { can } = useAuth();
  const toast = useToast();
  const mayChange = mayEditPage(can, 'admin', 'categories');
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<{ team: Team; post: Post } | null>(null);

  const load = useCallback(() => {
    api
      .get<{ teams: Team[] }>('/reference/team-posts')
      .then((r) => setTeams(r.teams))
      .catch(setError);
  }, []);
  useEffect(load, [load]);

  if (!teams) return error ? <ErrorBox error={error} /> : <Loading />;
  const codeOf = new Map(teams.map((t) => [t.id, t.code]));
  const roles = teams[0]?.posts ?? [];

  return (
    <div className="card m-industries">
      <div className="card-head">
        <h3 className="card-title">Team managers</h3>
      </div>
      <p className="muted">
        Who decides each team's Team Leader, Technical Manager, Sales Manager and Aftermarket Manager approvals. "Its
        own team" is whoever holds the role with that Team on Admin › Users. A team without its own (KAT today) can
        share another team's — when someone is hired, give them the role with that Team and set it back to its own.
      </p>
      <ErrorBox error={error} />
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Team</th>
              {roles.map((r) => (
                <th key={r.roleKey}>{r.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.id}>
                <td>
                  <strong>{t.code}</strong>
                  <div className="faint">{t.name}</div>
                </td>
                {t.posts.map((p) => (
                  <td key={p.roleKey}>
                    <div>{p.people.length ? p.people.map((x) => x.name).join(', ') : <span className="faint">Nobody yet</span>}</div>
                    <div className="faint">
                      {p.mode === 'SHARED'
                        ? `Shared from ${p.sharedTeamIds.map((id) => codeOf.get(id) ?? '?').join(', ')}`
                        : MODE_LABEL[p.mode]}
                    </div>
                    {mayChange && (
                      <button type="button" className="btn btn-sm" onClick={() => setEditing({ team: t, post: p })}>
                        Change
                      </button>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <PostPanel
          team={editing.team}
          post={editing.post}
          teams={teams}
          onClose={() => setEditing(null)}
          onSaved={() => {
            toast('ok', `${editing.team.code} ${editing.post.label} saved`);
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function PostPanel({
  team,
  post,
  teams,
  onClose,
  onSaved,
}: {
  team: Team;
  post: Post;
  teams: Team[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<Mode>(post.mode);
  const [shared, setShared] = useState<string[]>(post.sharedTeamIds);
  const [userIds, setUserIds] = useState<string[]>(post.userIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { people } = usePeople(`role:${post.roleKey}`);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/reference/team-posts/${team.id}/${post.roleKey}`, { mode, sharedTeamIds: shared, userIds });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h4 className="svc-subhead">
        {team.code} — {post.label}
      </h4>
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Who holds it">
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="OWN">Its own team — the role's holders on {team.code}</option>
            <option value="SHARED">Shared from other teams</option>
            <option value="PEOPLE">Named people</option>
          </select>
        </Field>
        {mode === 'SHARED' && (
          <Field label="Shared from">
            <TickPicker
              choices={teams.filter((t) => t.id !== team.id).map((t) => ({ value: t.id, label: t.code, hint: t.name }))}
              value={shared}
              onChange={setShared}
              none="No team"
              noun="teams"
            />
          </Field>
        )}
      </div>
      {mode === 'PEOPLE' && (
        <Field label={`People holding ${post.label}`}>
          <PeoplePicker people={people.map(toPerson)} value={userIds} onChange={setUserIds} />
        </Field>
      )}
      <div className="panel-foot">
        <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

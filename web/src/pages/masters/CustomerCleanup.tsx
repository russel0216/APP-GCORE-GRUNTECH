import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useBackLink } from '../../components/Navigation';
import { ErrorBox, Loading, formatDate, useToast } from '../../components/ui';

/**
 * Customers › Clean up (2026-11-15, the owner's audit of the customer list):
 * the look-alike customers to merge — "ABOITIZ LAND , INC." beside "ABOITIZ
 * LAND, INC." — and the sub-industries the SCORO import left in the notes.
 * The API decides who may do each: merging is the System Administrator's,
 * the fill is Manage All's.
 */
interface DupRow {
  id: string;
  code: string;
  name: string;
  address: string | null;
  team: string | null;
  createdAt: string;
  createdBy: { name: string } | null;
  contacts: number;
  sites: number;
  holds: Record<string, number>;
  documents: number;
}
interface DupGroup {
  key: string;
  rows: DupRow[];
}
interface Fill {
  withoutSubIndustry: number;
  canFill: number;
  filled: number;
  bySubIndustry: { name: string; count: number }[];
  sample: { code: string; name: string; subIndustry: string }[];
}

export function CustomerCleanup() {
  useBackLink('/g-ops/customers', 'Customers');
  const { me, can } = useAuth();
  const toast = useToast();
  const admin = !!me?.user.isSuperAdmin;
  const [data, setData] = useState<{ words: Record<string, string>; groups: DupGroup[] } | null>(null);
  const [fill, setFill] = useState<Fill | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The customer kept in each group — the one holding the most, until another is chosen.
  const [keep, setKeep] = useState<Record<string, string>>({});
  const [sure, setSure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (admin) setData(await api.get('/customers/duplicates'));
      if (can('gops.customers.edit_all')) setFill(await api.post<Fill>('/customers/fill-sub-industries', {}));
    } catch (err) {
      setError(err);
    }
  }, [admin, can]);
  useEffect(() => {
    void load();
  }, [load]);

  const said = (holds: Record<string, number>) =>
    Object.entries(holds)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${data?.words[k] ?? k}${n === 1 ? '' : 's'}`)
      .join(', ') || 'nothing on file';

  async function merge(group: DupGroup) {
    const target = keep[group.key] ?? group.rows[0].id;
    setBusy(group.key);
    setError(null);
    try {
      for (const r of group.rows) if (r.id !== target) await api.post(`/customers/${r.id}/merge-into`, { targetId: target });
      toast('ok', `Merged into ${group.rows.find((r) => r.id === target)?.code}`);
      setSure(null);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function applyFill() {
    setBusy('fill');
    setError(null);
    try {
      const done = await api.post<Fill>('/customers/fill-sub-industries', { apply: true });
      toast('ok', `Sub-industry filled on ${done.filled} customer${done.filled === 1 ? '' : 's'}`);
      setSure(null);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Clean up customers</h1>
        </div>
      </div>
      <ErrorBox error={error} />

      {fill && (
        <section className="card" aria-labelledby="cu-fill">
          <div className="card-head">
            <h2 id="cu-fill" className="card-title">
              Sub-industry from the SCORO notes
            </h2>
            {fill.canFill > 0 &&
              (sure === 'fill' ? (
                <button type="button" className="btn btn-sm btn-primary" disabled={busy === 'fill'} onClick={() => void applyFill()}>
                  {busy === 'fill' ? 'Filling…' : `Yes, fill ${fill.canFill}`}
                </button>
              ) : (
                <button type="button" className="btn btn-sm" onClick={() => setSure('fill')}>
                  Fill {fill.canFill} customer{fill.canFill === 1 ? '' : 's'}
                </button>
              ))}
          </div>
          <p className="faint">
            {fill.withoutSubIndustry} customer{fill.withoutSubIndustry === 1 ? ' has' : 's have'} no sub-industry.{' '}
            {fill.canFill > 0
              ? `${fill.canFill} of them came from SCORO with a tag that is one of your sub-industries — the fill files it. A sub-industry already set is never changed.`
              : 'None of them carries a SCORO tag that matches a sub-industry — set those by hand, from the list’s Set sub-industry.'}
          </p>
          {fill.bySubIndustry.length > 0 && (
            <p>
              {fill.bySubIndustry.map((b) => `${b.name} (${b.count})`).join(' · ')}
            </p>
          )}
        </section>
      )}

      {admin && (
        <section className="card" aria-labelledby="cu-dups">
          <div className="card-head">
            <h2 id="cu-dups" className="card-title">
              Look-alike customers{data ? ` (${data.groups.length} group${data.groups.length === 1 ? '' : 's'})` : ''}
            </h2>
          </div>
          <p className="faint">
            The same name once capitals, punctuation and “Inc.” / “Corp.” are left out. Choose the one to keep: everything the others hold moves onto it, and
            they are switched off. It cannot be undone — leave a group alone when its customers really are different companies.
          </p>
          {!data ? (
            <Loading />
          ) : data.groups.length === 0 ? (
            <p className="faint">No look-alike customers — nothing to merge.</p>
          ) : (
            data.groups.map((g) => {
              const target = keep[g.key] ?? g.rows[0].id;
              return (
                <div key={g.key} className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Keep</th>
                        <th>Customer</th>
                        <th>Team</th>
                        <th>Added</th>
                        <th>It holds</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {g.rows.map((r, i) => (
                        <tr key={r.id}>
                          <td>
                            <input type="radio" name={`keep-${g.key}`} aria-label={`Keep ${r.code}`} checked={target === r.id} onChange={() => setKeep((k) => ({ ...k, [g.key]: r.id }))} />
                          </td>
                          <td>
                            <Link to={`/g-ops/customers/${r.id}`} className="mono">
                              {r.code}
                            </Link>
                            <div>{r.name}</div>
                            {r.address && <div className="faint">{r.address}</div>}
                          </td>
                          <td>{r.team ?? <span className="faint">Open</span>}</td>
                          <td>
                            {formatDate(r.createdAt)}
                            {r.createdBy && <div className="faint">{r.createdBy.name}</div>}
                          </td>
                          <td>
                            {said(r.holds)}
                            <div className="faint">
                              {r.contacts} contact{r.contacts === 1 ? '' : 's'} · {r.sites} site{r.sites === 1 ? '' : 's'}
                            </div>
                          </td>
                          <td className="right">
                            {i === 0 &&
                              (sure === g.key ? (
                                <button type="button" className="btn btn-sm btn-danger" disabled={busy === g.key} onClick={() => void merge(g)}>
                                  {busy === g.key ? 'Merging…' : `Yes, merge ${g.rows.length - 1} into ${g.rows.find((x) => x.id === target)?.code}`}
                                </button>
                              ) : (
                                <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => setSure(g.key)}>
                                  Merge into the one kept
                                </button>
                              ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })
          )}
        </section>
      )}
    </div>
  );
}

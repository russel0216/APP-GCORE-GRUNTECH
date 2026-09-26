import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { Empty, ErrorBox, Loading, formatMoney } from '../../components/ui';

// ════════════════════════════════════════════════════════════════════
//  PIPELINE
// ════════════════════════════════════════════════════════════════════

interface Card {
  id: string;
  kind: 'lead' | 'quotation';
  title: string;
  subtitle: string;
  amount: number;
  probability: number;
  weighted: number;
  owner: { id: string; name: string } | null;
  link: string;
}

interface Stage {
  key: string;
  label: string;
  cards: Card[];
  count: number;
  value: number;
  weighted: number;
}

export function Pipeline() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [owner, setOwner] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ stages: Stage[] }>(`/pipeline${qs({ ownerId: owner })}`);
      setStages(res.stages);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .get<{ rows: { id: string; name: string }[] }>('/users?pageSize=200')
      .then((r) => setPeople(r.rows))
      .catch(() => {});
  }, []);

  const open = stages.filter((s) => !['WON', 'LOST'].includes(s.key));
  const openValue = open.reduce((sum, s) => sum + s.value, 0);
  const openWeighted = open.reduce((sum, s) => sum + s.weighted, 0);
  const won = stages.find((s) => s.key === 'WON');

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Sales Pipeline</h1>
          <p>
            Leads and quotations in one view, by stage. Weighted value is amount × probability — the
            number that answers what you can actually expect to land, rather than the sum of every
            hopeful quotation.
          </p>
        </div>
        <select style={{ width: 'auto' }} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">All salespeople</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <ErrorBox error={error} />

      <div className="grid grid-3" style={{ marginBottom: 18 }}>
        <div className="card">
          <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
            OPEN PIPELINE
          </div>
          <div style={{ fontSize: 20, marginTop: 6, fontWeight: 600 }}>{formatMoney(openValue)}</div>
        </div>
        <div className="card">
          <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
            WEIGHTED
          </div>
          <div style={{ fontSize: 20, marginTop: 6, fontWeight: 600, color: 'var(--neon)' }}>
            {formatMoney(openWeighted)}
          </div>
        </div>
        <div className="card">
          <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
            WON
          </div>
          <div style={{ fontSize: 20, marginTop: 6, fontWeight: 600 }}>
            {formatMoney(won?.value ?? 0)}
            <span className="faint" style={{ fontSize: 13, marginLeft: 8 }}>
              {won?.count ?? 0} job{won?.count === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      </div>

      {stages.every((s) => s.count === 0) ? (
        <div className="card">
          <Empty title="Nothing in the pipeline yet" hint="Add a lead, and it appears here." />
        </div>
      ) : (
        <div className="pipeline">
          {stages.map((stage) => (
            <div key={stage.key} className="pipe-col">
              <div className="pipe-head">
                <strong>{stage.label}</strong>
                <span className="badge">{stage.count}</span>
              </div>
              <div className="pipe-total mono">{formatMoney(stage.value)}</div>
              {stage.weighted !== stage.value && (
                <div className="pipe-total faint mono" style={{ fontSize: 11 }}>
                  {formatMoney(stage.weighted)} weighted
                </div>
              )}
              <div className="pipe-body">
                {stage.cards.map((c) => (
                  <Link key={`${c.kind}-${c.id}`} to={c.link} className="pipe-card">
                    <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                      <span style={{ fontSize: 13 }}>{c.title}</span>
                      <span className={`tag ${c.kind === 'quotation' ? '' : ''}`}>
                        {c.kind === 'quotation' ? 'QT' : 'LEAD'}
                      </span>
                    </div>
                    <div className="faint" style={{ fontSize: 11, margin: '3px 0' }}>
                      {c.subtitle}
                    </div>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span className="mono" style={{ fontSize: 12 }}>
                        {formatMoney(c.amount)}
                      </span>
                      <span className="section-label">
                        {c.probability}%
                      </span>
                    </div>
                    {c.owner && (
                      <div className="faint" style={{ fontSize: 10, marginTop: 3 }}>
                        {c.owner.name}
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

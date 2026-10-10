import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Checkbox, ErrorBox, Loading, useToast } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';
import { useConfirm } from '../../components/Confirm';

/**
 * Admin › Pipeline Stages — SCORO's "Quotes and pipeline" statuses, as the
 * owner keeps them there: each stage's name, its odds, its colour and
 * whether it is on the active board. The statuses a stage gathers, and the
 * odds the board fixes (Confirmed and Completed 100, Lost 0, On hold says
 * nothing), are code; the page shows them and does not offer to change them.
 */

interface StageDef {
  key: string;
  label: string;
  probability: number | null;
  color: string;
  inActiveList: boolean;
  successful: boolean;
  fixedOdds: boolean;
  columns: string[];
  statuses: string[];
  explanation: string;
}

interface Loaded {
  stages: StageDef[];
  defaults: StageDef[];
}

interface Row {
  label: string;
  probability: string;
  color: string;
  inActiveList: boolean;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function rowsOf(stages: StageDef[]): Record<string, Row> {
  return Object.fromEntries(
    stages.map((s) => [s.key, { label: s.label, probability: s.probability === null ? '' : String(s.probability), color: s.color, inActiveList: s.inActiveList }]),
  );
}

export function PipelineStages() {
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('admin.pipeline_stages.edit_all');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [savedJson, setSavedJson] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    let alive = true;
    api
      .get<Loaded>('/pipeline/stages')
      .then((data) => {
        if (!alive) return;
        setLoaded(data);
        const r = rowsOf(data.stages);
        setRows(r);
        setSavedJson(JSON.stringify(r));
      })
      .catch((err) => alive && setError(err));
    return () => {
      alive = false;
    };
  }, []);

  if (!loaded) return error ? <ErrorBox error={error} /> : <Loading />;

  const dirty = JSON.stringify(rows) !== savedJson;
  const patch = (key: string, change: Partial<Row>) => setRows((r) => ({ ...r, [key]: { ...r[key], ...change } }));

  async function save() {
    if (!loaded) return;
    setBusy(true);
    setError(null);
    try {
      const overrides: Record<string, { label: string; probability?: number | null; color: string; inActiveList: boolean }> = {};
      for (const s of loaded.stages) {
        const r = rows[s.key];
        if (!HEX.test(r.color)) throw new Error(`${r.label || s.label}: the colour is written #RRGGBB`);
        overrides[s.key] = {
          label: r.label.trim() || s.label,
          color: r.color.toUpperCase(),
          inActiveList: r.inActiveList,
          ...(s.fixedOdds ? {} : { probability: r.probability.trim() === '' ? null : Math.round(Number(r.probability)) }),
        };
      }
      const res = await api.put<Loaded>('/pipeline/stages', overrides);
      setLoaded(res);
      const next = rowsOf(res.stages);
      setRows(next);
      setSavedJson(JSON.stringify(next));
      toast('ok', 'Saved — the board and the odds follow these stages now');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /** Asked in the confirm bar first; a refusal is shown there, so it throws. */
  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.del<Loaded>('/pipeline/stages');
      setLoaded(res);
      const next = rowsOf(res.stages);
      setRows(next);
      setSavedJson(JSON.stringify(next));
      toast('ok', 'SCORO’s defaults are back');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ps-screen">
      <div className="page-head">
        <div>
          <h1>Pipeline Stages</h1>
          <p>
            The stages of the <Link to="/g-ops/pipeline">Sales Pipeline</Link>, as SCORO keeps its quote statuses: the name on
            the board, the odds a deal takes when it is moved into the stage, the colour of its band, and whether it is on the
            active board. Which of G-CORE’s own steps a stage gathers is fixed — it is listed under each stage.
          </p>
        </div>
        {canEdit && (
          <div className="row ps-actions">
            <button
              type="button"
              className="btn"
              onClick={() =>
                confirm.ask({
                  title: 'Put SCORO’s defaults back?',
                  body: 'Your names, odds, colours and board listing are replaced.',
                  confirmLabel: 'Put them back',
                  onConfirm: reset,
                })
              }
              disabled={busy}
            >
              SCORO’s defaults
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || !dirty}>
              Save
            </button>
          </div>
        )}
      </div>
      {confirm.bar}
      <ErrorBox error={error} />

      <div className="card">
        <div className="table-wrap">
          <table className="data ps-table">
            <thead>
              <tr>
                <th>Status name</th>
                <th>Probability</th>
                <th>Explanation</th>
                <th>Colour</th>
                <th>In active list</th>
                <th>Successful</th>
              </tr>
            </thead>
            <tbody>
              {loaded.stages.map((s) => {
                const r = rows[s.key];
                return (
                  <tr key={s.key}>
                    <td>
                      <input
                        value={r.label}
                        maxLength={40}
                        disabled={!canEdit}
                        aria-label={`${s.label}: name`}
                        onChange={(e) => patch(s.key, { label: e.target.value })}
                      />
                      <div className="faint ps-steps">{s.columns.map((c) => STEP_LABELS[c] ?? c).join(' · ')}</div>
                    </td>
                    <td className="ps-odds">
                      {s.fixedOdds ? (
                        <span className="mono" title="Fixed by the board">
                          {s.probability === null ? '—' : `${s.probability} %`}
                        </span>
                      ) : (
                        <span className="row ps-odds-row">
                          <NumberInput
                            kind="plain"
                            min={0}
                            max={100}
                            step={5}
                            value={r.probability}
                            disabled={!canEdit}
                            aria-label={`${s.label}: probability`}
                            onChange={(e) => patch(s.key, { probability: e.target.value })}
                          />
                          <span>%</span>
                        </span>
                      )}
                    </td>
                    <td className="faint ps-explain">{s.explanation}</td>
                    <td>
                      <span className="row ps-color">
                        <input
                          type="color"
                          value={HEX.test(r.color) ? r.color : '#000000'}
                          disabled={!canEdit}
                          aria-label={`${s.label}: pick a colour`}
                          onChange={(e) => patch(s.key, { color: e.target.value.toUpperCase() })}
                        />
                        <input
                          className="mono ps-hex"
                          value={r.color}
                          maxLength={7}
                          disabled={!canEdit}
                          aria-label={`${s.label}: colour as #RRGGBB`}
                          onChange={(e) => patch(s.key, { color: e.target.value })}
                        />
                      </span>
                    </td>
                    <td>
                      <Checkbox checked={r.inActiveList} onChange={(v) => canEdit && patch(s.key, { inActiveList: v })} label="" />
                    </td>
                    <td>{s.successful ? '✓' : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint">
          Confirmed and Completed are always 100% and Lost 0% — a won deal weighted at 90% would misstate the forecast — and On
          hold says nothing about odds. Completed is worked out: a won quotation with a sales order or a project created from it.
        </p>
      </div>
    </div>
  );
}

const STEP_LABELS: Record<string, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  SITE_VISIT: 'Site visit',
  COSTING: 'Costing',
  QUOTED: 'Quotation drafted',
  SUBMITTED: 'Submitted',
  NEGOTIATION: 'Negotiation',
  WON: 'Won',
  LOST: 'Lost',
  ON_HOLD: 'On hold',
};

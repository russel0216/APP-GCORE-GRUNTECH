import { useRef, useState } from 'react';
import { api, downloadBlob } from '../lib/api';
import { ErrorBox, Field, Modal, useToast } from './ui';

/**
 * CSV import, shared by every master screen.
 *
 * Two-step by design: the first upload only reports what *would* happen. A
 * half-applied import of master data is worse than a rejected one, because
 * afterwards nobody can tell which rows landed.
 */

interface ColumnDef {
  header: string;
  required?: boolean;
  example?: string;
  hint?: string;
}

interface RowResult {
  row: number;
  action: 'create' | 'update' | 'error';
  key: string;
  message?: string;
}

interface ImportReport {
  entity: string;
  committed: boolean;
  total: number;
  created: number;
  updated: number;
  errors: number;
  rows: RowResult[];
  /** What the dry run asks before the file is applied (the SCORO quotes' groups, and the team to tag them with). */
  extra?: { groups?: GroupQuestion; teams?: TeamQuestion };
}

/** "Allow me also to select which team it goes" (2026-10-12): the active teams, and how many quotations the file holds. */
interface TeamQuestion {
  choices: { id: string; code: string; name: string }[];
  quotations: number;
}

/** A SCORO group not on Admin › Categories › Quotation groups, and how many lines use it. */
interface UnlistedGroup {
  key: string;
  name: string;
  lines: number;
  quotations: number;
}

/** "Let me decide, or set it as OTHERS" (2026-10-11): each unlisted group, the list, the default. */
interface GroupQuestion {
  unlisted: UnlistedGroup[];
  choices: string[];
  fallback: string;
}

export function ImportModal({
  entity,
  label,
  columns,
  onClose,
  onImported,
}: {
  entity: string;
  label: string;
  columns: ColumnDef[];
  onClose: () => void;
  onImported: () => void;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Where each group not on the list goes, keyed by the SCORO group's key.
  const [groupChoice, setGroupChoice] = useState<Record<string, string>>({});
  const question = report && !report.committed ? report.extra?.groups : undefined;
  // The team the file's quotations are tagged with; '' follows each owner's team.
  const [teamChoice, setTeamChoice] = useState('');
  const teamQuestion = report && !report.committed ? report.extra?.teams : undefined;

  async function send(commit: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      // The answers to what the check asked: each unlisted group's choice,
      // else the default; and the team, when one was picked.
      if (commit && (question?.unlisted.length || (teamQuestion && teamChoice))) {
        const groups = question?.unlisted.length
          ? Object.fromEntries(question.unlisted.map((g) => [g.key, groupChoice[g.key] ?? question.fallback]))
          : undefined;
        form.append('options', JSON.stringify({ ...(groups ? { groups } : {}), ...(teamQuestion && teamChoice ? { team: teamChoice } : {}) }));
      }
      const result = await api.post<ImportReport>(
        `/imports/${entity}${commit ? '?commit=true' : ''}`,
        form,
      );
      setReport(result);
      if (result.committed) {
        toast('ok', `${result.created} created, ${result.updated} updated`);
        onImported();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    downloadBlob(`/imports/${entity}/template`, `gcore-${entity}-template.csv`).catch(() =>
      toast('error', 'Could not download the template'),
    );
  }

  const clean = report && report.errors === 0;

  return (
    <Modal
      wide
      title={`Import ${label}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={downloadTemplate} disabled={busy}>
            Download template
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={busy}>
            {report?.committed ? 'Close' : 'Cancel'}
          </button>
          {!report?.committed && (
            <button
              className="btn btn-primary"
              disabled={busy || !file || (report !== null && !clean)}
              onClick={() => send(report !== null && clean === true)}
            >
              {busy
                ? 'Working…'
                : report === null
                  ? 'Check file'
                  : clean
                    ? `Import ${report.total} row${report.total === 1 ? '' : 's'}`
                    : 'Fix the errors first'}
            </button>
          )}
        </>
      }
    >
      <ErrorBox error={error} />

      {!report?.committed && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Download the template, fill it in, and upload it. Nothing is saved until you have seen
            what the file would do and confirmed it.
          </p>

          <div className="field">
            <label>CSV file</label>
            <div className="row">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                style={{ display: 'none' }}
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setReport(null);
                  setError(null);
                }}
              />
              <button className="btn" onClick={() => fileRef.current?.click()} disabled={busy}>
                Choose file
              </button>
              <span className="muted">{file ? file.name : 'No file chosen'}</span>
            </div>
          </div>
        </>
      )}

      {report && (
        <div style={{ marginTop: 12 }}>
          <div
            className={`alert ${report.errors ? 'error' : report.committed ? 'ok' : 'info'}`}
          >
            {report.committed ? (
              <>
                Imported — {report.created} created, {report.updated} updated.
              </>
            ) : report.errors ? (
              <>
                {report.errors} of {report.total} row{report.total === 1 ? '' : 's'} have problems.
                Nothing has been saved. Fix the file and check it again.
              </>
            ) : (
              <>
                Ready: {report.created} to create, {report.updated} to update. Nothing is saved
                yet — press Import to apply.
              </>
            )}
          </div>

          {teamQuestion && teamQuestion.choices.length > 0 && (
            <section className="import-groups" aria-labelledby="import-team-title">
              <h3 id="import-team-title" className="svc-subhead">
                Team
              </h3>
              <p className="faint">
                Tag the {teamQuestion.quotations} quotation{teamQuestion.quotations === 1 ? '' : 's'} in this file with a team: the team cards
                and the Team view count them under it. Left as it is, each one follows its owner’s team. Quotations already on file from
                this file take the team too.
              </p>
              <Field label="Tag with team">
                <select value={teamChoice} onChange={(e) => setTeamChoice(e.target.value)}>
                  <option value="">— each owner’s team —</option>
                  {teamQuestion.choices.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.code} — {t.name}
                    </option>
                  ))}
                </select>
              </Field>
            </section>
          )}

          {question && question.unlisted.length > 0 && (
            <section className="import-groups" aria-labelledby="import-groups-title">
              <h3 id="import-groups-title" className="svc-subhead">
                Groups not on the list
              </h3>
              <p className="faint">
                These groups are not in Admin › Categories › Quotation groups. Choose where their lines go; they go to{' '}
                {question.fallback} unless you pick another. Nothing is added to the list.
              </p>
              <table className="data">
                <thead>
                  <tr>
                    <th>Group in the file</th>
                    <th className="right">Lines</th>
                    <th>File under</th>
                  </tr>
                </thead>
                <tbody>
                  {question.unlisted.map((g) => (
                    <tr key={g.key}>
                      <td>{g.name}</td>
                      <td className="right">
                        {g.lines} in {g.quotations} quotation{g.quotations === 1 ? '' : 's'}
                      </td>
                      <td>
                        <select
                          aria-label={`File the lines of ${g.name} under`}
                          value={groupChoice[g.key] ?? question.fallback}
                          onChange={(e) => setGroupChoice((c) => ({ ...c, [g.key]: e.target.value }))}
                        >
                          {question.choices.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <div className="table-wrap" style={{ maxHeight: 280 }}>
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>Row</th>
                  <th style={{ width: 90 }}>Action</th>
                  <th>Record</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.row}>
                    <td className="mono">{r.row}</td>
                    <td>
                      <span
                        className={`badge ${
                          r.action === 'error' ? 'danger' : r.action === 'create' ? 'ok' : 'info'
                        }`}
                      >
                        {r.action}
                      </span>
                    </td>
                    <td>{r.key}</td>
                    <td className={r.action === 'error' ? '' : 'muted'}>{r.message ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!report && (
        <details style={{ marginTop: 14 }}>
          <summary className="muted" style={{ cursor: 'pointer' }}>
            Expected columns ({columns.length})
          </summary>
          <div className="table-wrap" style={{ marginTop: 10, maxHeight: 260 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Column</th>
                  <th style={{ width: 80 }}>Required</th>
                  <th>Example</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((c) => (
                  <tr key={c.header}>
                    <td className="mono">{c.header}</td>
                    <td>{c.required ? <span className="badge warn">yes</span> : <span className="faint">no</span>}</td>
                    <td className="muted">{c.example || '—'}</td>
                    <td className="faint">{c.hint ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </Modal>
  );
}

/** Fetches the column spec for an entity, so each screen doesn't hard-code it. */
export async function loadImportSpec(entity: string): Promise<{ label: string; columns: ColumnDef[] } | null> {
  try {
    const specs = await api.get<{ entity: string; label: string; columns: ColumnDef[] }[]>('/imports');
    return specs.find((s) => s.entity === entity) ?? null;
  } catch {
    return null;
  }
}

import { Fragment, useRef, useState } from 'react';
import { api, downloadBlob, qs } from '../lib/api';
import { extensionOf, type ViewWorkbook } from '../lib/spreadsheet';
import { ErrorBox, Field, Modal, ModalFoot, StatusBadge, useToast, type Tone } from './ui';

/** What the check says it would do with a row. */
const IMPORT_TONES: Record<string, Tone> = { error: 'danger', create: 'ok', update: 'info', skip: '' };

/** Past this many rows the check lists every problem and skip, and only the first of the rest. */
const ROWS_SHOWN = 200;

/** A workbook the import reads directly (2026-10-25, Odoo's export is .xlsx) — its first sheet, made CSV here. */
const WORKBOOK_EXTENSIONS = ['xlsx', 'xlsm', 'xls', 'ods'];

/**
 * The first sheet of a workbook as CSV text, from its headings row down:
 * each cell as Excel shows it, parsed in the spreadsheet viewer's worker
 * (an upload is untrusted input; the page never parses it).
 */
async function workbookToCsv(file: File, required: string[]): Promise<File> {
  const bytes = await file.arrayBuffer();
  const book = await new Promise<ViewWorkbook>((resolve, reject) => {
    const worker = new Worker(new URL('../lib/spreadsheet.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Reading the workbook took too long — save it as CSV in Excel and choose that instead'));
    }, 60_000);
    worker.onmessage = (event: MessageEvent<{ ok: true; workbook: ViewWorkbook } | { ok: false; error: string }>) => {
      clearTimeout(timer);
      worker.terminate();
      if (event.data.ok) resolve(event.data.workbook);
      else reject(new Error('This file could not be read as a spreadsheet — save it as CSV in Excel and choose that instead'));
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error('This file could not be read as a spreadsheet — save it as CSV in Excel and choose that instead'));
    };
    worker.postMessage({ bytes, fileName: file.name }, [bytes]);
  });
  const sheet = book.sheets[0];
  if (!sheet || !sheet.rows.length) throw new Error('The workbook’s first sheet is empty');
  if (sheet.truncatedRows) throw new Error('The sheet is longer than the browser reads — save it as CSV in Excel and choose that instead');
  const quote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const width = sheet.colCount;
  // The headings are the first row carrying every required column (Odoo's
  // are row 1), else the row the viewer guesses, else the top.
  const named = sheet.rows.slice(0, 20).findIndex((row) => required.every((h) => row.some((cell) => cell.trim() === h)));
  const top = named >= 0 ? named : (sheet.headerRow ?? 0);
  const lines = sheet.rows.slice(top).map((row) => Array.from({ length: width }, (_, c) => quote(row[c] ?? '')).join(','));
  return new File([lines.join('\r\n')], file.name.replace(/\.[^.]+$/, '.csv'), { type: 'text/csv' });
}

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
  action: 'create' | 'update' | 'error' | 'skip';
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
  /** Rows the import leaves to another on purpose (the Odoo file's assets, or its products). */
  skipped?: number;
  rows: RowResult[];
  /**
   * What the dry run asks before the file is applied (the SCORO quotes' groups,
   * and the team to tag them with), and what it says the file holds (the Odoo
   * import's facts and tables).
   */
  extra?: { groups?: GroupQuestion; teams?: TeamQuestion; facts?: { label: string; value: string }[]; tables?: ReportTable[] };
}

/** A small table the check draws over the rows: the Odoo import's groups, brands, holders. */
interface ReportTable {
  title: string;
  note?: string;
  head: string[];
  rows: (string | number)[][];
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
  context,
}: {
  entity: string;
  label: string;
  columns: ColumnDef[];
  onClose: () => void;
  onImported: () => void;
  /** What the screen imports into (`?exhibitionId=`), sent with the check and the commit alike. */
  context?: Record<string, string>;
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
      form.append('file', WORKBOOK_EXTENSIONS.includes(extensionOf(file.name)) ? await workbookToCsv(file, columns.filter((c) => c.required).map((c) => c.header)) : file);
      // The answers to what the check asked: each unlisted group's choice,
      // else the default; and the team, when one was picked.
      if (commit && (question?.unlisted.length || (teamQuestion && teamChoice))) {
        const groups = question?.unlisted.length
          ? Object.fromEntries(question.unlisted.map((g) => [g.key, groupChoice[g.key] ?? question.fallback]))
          : undefined;
        form.append('options', JSON.stringify({ ...(groups ? { groups } : {}), ...(teamQuestion && teamChoice ? { team: teamChoice } : {}) }));
      }
      const result = await api.post<ImportReport>(
        `/imports/${entity}${qs({ ...(context ?? {}), ...(commit ? { commit: 'true' } : {}) })}`,
        form,
      );
      setReport(result);
      if (result.committed) {
        toast('ok', `${result.created} created, ${result.updated} updated${result.skipped ? `, ${result.skipped} skipped` : ''}`);
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
        <ModalFoot onCancel={onClose} cancelLabel={report?.committed ? 'Close' : 'Cancel'} busy={busy}>
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
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      {!report?.committed && (
        <>
          <p className="muted import-lede">
            Download the template, fill it in, and upload it. Nothing is saved until you have seen
            what the file would do and confirmed it.{' '}
            <button type="button" className="btn btn-sm" onClick={downloadTemplate} disabled={busy}>
              Download template
            </button>
          </p>

          <div className="field">
            <label>CSV or Excel file</label>
            <div className="row">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv,.xlsx,.xlsm,.xls,.ods"
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
        <div className="import-report">
          <div
            className={`alert ${report.errors ? 'error' : report.committed ? 'ok' : 'info'}`}
          >
            {report.committed ? (
              <>
                Imported — {report.created} created, {report.updated} updated{report.skipped ? `, ${report.skipped} skipped` : ''}.
              </>
            ) : report.errors ? (
              <>
                {report.errors} of {report.total} row{report.total === 1 ? '' : 's'} have problems.
                Nothing has been saved. Fix the file and check it again.
              </>
            ) : (
              <>
                Ready: {report.created} to create, {report.updated} to update
                {report.skipped ? `, ${report.skipped} left for another import` : ''}. Nothing is saved yet — press Import to apply.
              </>
            )}
          </div>

          {report.extra?.facts && report.extra.facts.length > 0 && (
            <dl className="kv">
              {report.extra.facts.map((f) => (
                <Fragment key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </Fragment>
              ))}
            </dl>
          )}

          {report.extra?.tables?.map((t) => (
            <section key={t.title} className="import-groups" aria-label={t.title}>
              <h3 className="svc-subhead">{t.title}</h3>
              {t.note && <p className="faint">{t.note}</p>}
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      {t.head.map((h, i) => (
                        <th key={h} className={i > 0 && typeof t.rows[0]?.[i] === 'number' ? 'right' : undefined}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.rows.map((r, n) => (
                      <tr key={n}>
                        {r.map((c, i) => (
                          <td key={i} className={typeof c === 'number' ? 'right mono' : undefined}>
                            {c}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

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

          <div className="table-wrap import-rows">
            <table className="data">
              <thead>
                <tr>
                  <th className="import-col-row">Row</th>
                  <th className="import-col-action">Action</th>
                  <th>Record</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {shownRows(report.rows).map((r) => (
                  <tr key={r.row}>
                    <td className="mono">{r.row}</td>
                    <td>
                      <StatusBadge status={r.action} extra={IMPORT_TONES} label={r.action} />
                    </td>
                    <td>{r.key}</td>
                    <td className={r.action === 'error' ? '' : 'muted'}>{r.message ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.rows.length > shownRows(report.rows).length && (
            <p className="faint">
              Every row with a problem or skipped is listed; of the rest, the first {ROWS_SHOWN} of {report.rows.length.toLocaleString('en-US')} rows.
            </p>
          )}
        </div>
      )}

      {!report && (
        <details className="import-columns">
          <summary className="muted">
            Expected columns ({columns.length})
          </summary>
          <div className="table-wrap import-rows">
            <table className="data">
              <thead>
                <tr>
                  <th>Column</th>
                  <th className="import-col-action">Required</th>
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

/** A long file's rows: every problem and skip, then the first of the rest. */
function shownRows(rows: RowResult[]): RowResult[] {
  if (rows.length <= ROWS_SHOWN) return rows;
  const loud = rows.filter((r) => r.action === 'error' || r.action === 'skip');
  const quiet = rows.filter((r) => r.action !== 'error' && r.action !== 'skip').slice(0, ROWS_SHOWN);
  return [...loud, ...quiet].sort((a, b) => a.row - b.row);
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

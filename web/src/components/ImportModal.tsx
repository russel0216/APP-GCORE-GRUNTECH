import { useRef, useState } from 'react';
import { api, downloadBlob } from '../lib/api';
import { ErrorBox, Modal, useToast } from './ui';

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

  async function send(commit: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
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

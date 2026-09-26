import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ErrorBox, Loading, useToast } from './ui';

/**
 * A settings card that edits a LIST — the clearance checklist, the evaluation
 * criteria. Each is one Setting row holding an array, read and written
 * through `GET/PUT /hr-settings/lists/:key`, whose zod schema is the real
 * validation; this card only keeps the rows typed and the table honest.
 *
 * Rows are plain objects so the two callers can describe their own columns.
 * The server answers `{ key, rows }` (a bare array is accepted too) and the
 * PUT body is `{ rows }`.
 */

export type SettingRow = Record<string, string | number | boolean | null | undefined>;

export interface SettingColumn {
  key: string;
  label: string;
  kind: 'text' | 'select' | 'number' | 'checkbox';
  options?: { value: string; label: string }[];
  /** For `number` — passed straight to the input. */
  step?: number;
  min?: number;
  max?: number;
}

export function SettingListCard({
  settingKey,
  title,
  hint,
  columns,
  newRow,
  canEdit = true,
}: {
  settingKey: string;
  title: string;
  hint: string;
  columns: SettingColumn[];
  newRow: () => SettingRow;
  /** Read-only when the viewer holds `view_all` but not `edit_all`. */
  canEdit?: boolean;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<SettingRow[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<SettingRow[] | { rows: SettingRow[] }>(`/hr-settings/lists/${settingKey}`)
      .then((res) => {
        if (!cancelled) setRows(Array.isArray(res) ? res : res.rows);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err);
          setRows([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settingKey]);

  function update(index: number, key: string, value: SettingRow[string]) {
    setRows((prev) => (prev ?? []).map((r, i) => (i === index ? { ...r, [key]: value } : r)));
    setDirty(true);
  }

  function add() {
    setRows((prev) => [...(prev ?? []), newRow()]);
    setDirty(true);
  }

  function remove(index: number) {
    setRows((prev) => (prev ?? []).filter((_, i) => i !== index));
    setDirty(true);
  }

  async function save() {
    if (!rows) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.put<SettingRow[] | { rows: SettingRow[] }>(`/hr-settings/lists/${settingKey}`, {
        rows,
      });
      if (res) setRows(Array.isArray(res) ? res : res.rows);
      setDirty(false);
      toast('ok', 'Saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3 className="card-title">{title}</h3>
      <p className="muted">{hint}</p>
      <ErrorBox error={error} />

      {rows === null ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
                {canEdit && <th aria-label="Remove" />}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + (canEdit ? 1 : 0)} className="faint">
                    Nothing yet.
                  </td>
                </tr>
              )}
              {rows.map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key}>
                      <Cell column={c} value={row[c.key]} disabled={!canEdit} onChange={(v) => update(i, c.key, v)} />
                    </td>
                  ))}
                  {canEdit && (
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`Remove row ${i + 1}`}
                        onClick={() => remove(i)}
                      >
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && rows !== null && (
        <div className="row setting-list-actions">
          <button type="button" className="btn btn-sm" onClick={add}>
            + Add row
          </button>
          <div className="topbar-spacer" />
          <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  );
}

function Cell({
  column,
  value,
  disabled,
  onChange,
}: {
  column: SettingColumn;
  value: SettingRow[string];
  disabled: boolean;
  onChange: (v: SettingRow[string]) => void;
}) {
  switch (column.kind) {
    case 'checkbox':
      return (
        <input
          type="checkbox"
          aria-label={column.label}
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case 'select':
      return (
        <select
          aria-label={column.label}
          value={value == null ? '' : String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {(column.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'number':
      return (
        <input
          type="number"
          aria-label={column.label}
          value={value == null ? '' : String(value)}
          step={column.step}
          min={column.min}
          max={column.max}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    default:
      return (
        <input
          type="text"
          aria-label={column.label}
          value={value == null ? '' : String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

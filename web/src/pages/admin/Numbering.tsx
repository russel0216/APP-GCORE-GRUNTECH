import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';

interface SequenceRow {
  id: string;
  documentType: string;
  label: string;
  pattern: string;
  typeCode: string;
  period: 'YEAR' | 'NONE';
  padding: number;
  lastNumber: number;
  preview: string;
}

export function Numbering() {
  const { can } = useAuth();
  const [rows, setRows] = useState<SequenceRow[]>([]);
  const [prefix, setPrefix] = useState('GT');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<SequenceRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ prefix: string; rows: SequenceRow[] }>('/numbering');
      setPrefix(res.prefix);
      setRows(res.rows);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Document Numbering</h1>
          <p>
            Every document type in the system is registered here, including the ones whose modules
            ship later — so numbering is decided once rather than improvised per module. Counters
            reset each year and are handed out atomically, so two people saving at the same moment
            cannot get the same number.
          </p>
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Document</th>
              <th>Code</th>
              <th>Pattern</th>
              <th>Resets</th>
              <th className="right">Issued this year</th>
              <th>Next number</th>
              {can('admin.numbering.edit_all') && <th style={{ width: 70 }} />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.documentType}>
                <td>{row.label}</td>
                <td className="mono">{row.typeCode}</td>
                <td className="mono faint">{row.pattern}</td>
                <td className="muted">{row.period === 'YEAR' ? 'Yearly' : 'Never'}</td>
                <td className="right mono">{row.lastNumber}</td>
                <td className="mono" style={{ color: 'var(--neon)' }}>
                  {row.preview}
                </td>
                {can('admin.numbering.edit_all') && (
                  <td>
                    <button className="btn btn-sm" onClick={() => setEditing(row)}>
                      Modify
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="faint" style={{ fontSize: 12, marginTop: 12 }}>
        Tokens: <span className="mono">{'{PREFIX}'}</span> company prefix ({prefix}) ·{' '}
        <span className="mono">{'{TYPE}'}</span> document code · <span className="mono">{'{YYYY}'}</span>{' '}
        year · <span className="mono">{'{YY}'}</span> short year · <span className="mono">{'{MM}'}</span>{' '}
        month · <span className="mono">{'{SEQ}'}</span> counter. Change the prefix in Company Settings.
      </p>

      {editing && (
        <SequenceEditor
          row={editing}
          prefix={prefix}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function SequenceEditor({
  row,
  prefix,
  onClose,
  onSaved,
}: {
  row: SequenceRow;
  prefix: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [pattern, setPattern] = useState(row.pattern);
  const [typeCode, setTypeCode] = useState(row.typeCode);
  const [padding, setPadding] = useState(row.padding);
  const [period, setPeriod] = useState(row.period);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const now = new Date();
  const preview = pattern
    .replace('{PREFIX}', prefix)
    .replace('{TYPE}', typeCode)
    .replace('{YYYY}', String(now.getFullYear()))
    .replace('{YY}', String(now.getFullYear()).slice(-2))
    .replace('{MM}', String(now.getMonth() + 1).padStart(2, '0'))
    .replace('{SEQ}', String(row.lastNumber + 1).padStart(padding, '0'));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/numbering/${row.documentType}`, { pattern, typeCode, padding, period });
      toast('ok', `${row.label} numbering updated`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Numbering — ${row.label}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Pattern" hint="Must contain {SEQ}">
        <input className="mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />
      </Field>
      <div className="grid grid-2">
        <Field label="Type code">
          <input value={typeCode} onChange={(e) => setTypeCode(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Digits">
          <input
            type="number"
            min={1}
            max={10}
            value={padding}
            onChange={(e) => setPadding(Number(e.target.value))}
          />
        </Field>
      </div>
      <Field label="Counter resets">
        <select value={period} onChange={(e) => setPeriod(e.target.value as 'YEAR' | 'NONE')}>
          <option value="YEAR">Every year</option>
          <option value="NONE">Never — one continuous sequence</option>
        </select>
      </Field>
      <div className="alert info" style={{ marginBottom: 0 }}>
        Next number: <span className="mono">{preview}</span>
        <br />
        <span style={{ fontSize: 12 }}>
          Numbers already issued keep the format they were created with — this only affects new
          documents.
        </span>
      </div>
    </Modal>
  );
}

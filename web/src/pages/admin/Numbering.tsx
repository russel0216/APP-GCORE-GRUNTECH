import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, Modal, ModalFoot, useToast } from '../../components/ui';
import { NumberInput } from '../../components/NumberInput';

type Period = 'YEAR' | 'MONTH' | 'NONE';
type Scope = 'GLOBAL' | 'OWNER';

interface SequenceRow {
  id: string;
  documentType: string;
  label: string;
  pattern: string;
  typeCode: string;
  period: Period;
  scope: Scope;
  padding: number;
  /** Numbers issued in the current period — summed over every employee's run
   *  for a per-employee counter. */
  lastNumber: number;
  /** The next number as it would print for the viewer. */
  preview: string;
  /** Why the type cannot issue, when it cannot; null otherwise. */
  problem: string | null;
}

interface NumberingResponse {
  prefix: string;
  previewFor: { employeeNo: string | null; linked: boolean };
  rows: SequenceRow[];
}

const PERIOD_LABEL: Record<Period, string> = {
  YEAR: 'Yearly',
  MONTH: 'Monthly',
  NONE: 'Never',
};

/** The token chain the server uses, rendered locally for a live preview. */
function renderPreview(
  pattern: string,
  v: { prefix: string; typeCode: string; seq: number; padding: number; emp: string },
): string {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  return pattern
    .replace('{PREFIX}', v.prefix)
    .replace('{TYPE}', v.typeCode)
    .replace('{YYYY}', yyyy)
    .replace('{YY}', yyyy.slice(-2))
    .replace('{MM}', String(now.getMonth() + 1).padStart(2, '0'))
    .replace('{EMP}', v.emp)
    .replace('{SEQ}', String(v.seq).padStart(v.padding, '0'));
}

export function Numbering() {
  const { can } = useAuth();
  const [rows, setRows] = useState<SequenceRow[]>([]);
  const [prefix, setPrefix] = useState('GT');
  const [previewFor, setPreviewFor] = useState<NumberingResponse['previewFor']>({
    employeeNo: null,
    linked: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<SequenceRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<NumberingResponse>('/numbering');
      setPrefix(res.prefix);
      setPreviewFor(res.previewFor);
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

  const canEdit = can('admin.numbering.edit_all');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Document Numbering</h1>
          <p>
            Every document type in the system is registered here, including the ones whose modules
            ship later — so numbering is decided once rather than improvised per module. A counter
            resets yearly, monthly or never, and counts company-wide or per employee: the quotation
            follows the house scheme, where each salesperson's run restarts every month. Numbers
            are handed out atomically, so two people saving at the same moment cannot get the same
            one.
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
              <th className="right">Issued this period</th>
              <th>Next number</th>
              {canEdit && <th className="numbering-actions" aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              // The row opens "Modify numbering …" for whoever may change it — clicked,
              // or Enter / Space while it has focus (rule 13); the row-end Modify stays.
              <tr
                key={row.documentType}
                className={canEdit ? 'clickable' : undefined}
                tabIndex={canEdit ? 0 : undefined}
                onClick={canEdit ? () => setEditing(row) : undefined}
                onKeyDown={
                  canEdit
                    ? (e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setEditing(row);
                        }
                      }
                    : undefined
                }
              >
                <td>{row.label}</td>
                <td className="mono">{row.typeCode}</td>
                <td className="mono faint">{row.pattern}</td>
                <td className="muted">
                  {PERIOD_LABEL[row.period]}
                  {row.scope === 'OWNER' && <span className="numbering-scope">per employee</span>}
                </td>
                <td className="right mono">{row.lastNumber}</td>
                <td className={row.problem ? 'numbering-problem' : 'mono numbering-next'}>
                  {row.problem ?? row.preview}
                </td>
                {canEdit && (
                  <td className="numbering-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(row);
                      }}
                    >
                      Modify
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="faint numbering-legend">
        Tokens: <span className="mono">{'{PREFIX}'}</span> company prefix ({prefix}) ·{' '}
        <span className="mono">{'{TYPE}'}</span> document code · <span className="mono">{'{YYYY}'}</span>{' '}
        year · <span className="mono">{'{YY}'}</span> short year · <span className="mono">{'{MM}'}</span>{' '}
        month · <span className="mono">{'{EMP}'}</span> the author's employee number, last digits
        padded to three (000 for a login with no employee record) ·{' '}
        <span className="mono">{'{SEQ}'}</span> counter. Change the prefix in Company Settings.
      </p>
      <p className="muted numbering-for">
        {previewFor.linked
          ? `Next numbers are shown as they would print for you — employee ${previewFor.employeeNo}.`
          : 'Your login is not linked to an employee, so {EMP} shows as 000 in the samples above.'}
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
  const [period, setPeriod] = useState<Period>(row.period);
  const [scope, setScope] = useState<Scope>(row.scope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // A changed period or scope starts on a fresh counter, so the sample is the
  // first number of the new run; an unchanged one continues the current run.
  const continues = period === row.period && scope === row.scope;
  const preview = renderPreview(pattern, {
    prefix,
    typeCode,
    seq: (continues && scope === 'GLOBAL' ? row.lastNumber : 0) + 1,
    padding,
    emp: '001',
  });
  const usesEmp = pattern.includes('{EMP}');

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/numbering/${row.documentType}`, { pattern, typeCode, padding, period, scope });
      toast('ok', `${row.label} numbering updated`);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Modify numbering — ${row.label}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field
        label="Pattern"
        hint="Must contain {SEQ}. A monthly counter also needs {MM} and a year; a per-employee one needs {EMP}."
      >
        <input className="mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />
      </Field>
      <div className="grid grid-2">
        <Field label="Type code">
          <input value={typeCode} onChange={(e) => setTypeCode(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Digits">
          <NumberInput
            kind="count"
            min={1}
            max={10}
            value={padding}
            onChange={(e) => setPadding(Number(e.target.value))}
          />
        </Field>
      </div>
      <div className="grid grid-2">
        <Field label="Counter resets">
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            <option value="YEAR">Every year</option>
            <option value="MONTH">Every month</option>
            <option value="NONE">Never — one continuous sequence</option>
          </select>
        </Field>
        <Field
          label="Counts"
          hint={scope === 'OWNER' && !usesEmp ? 'The pattern must include {EMP}' : undefined}
        >
          <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="GLOBAL">Company-wide</option>
            <option value="OWNER">Per employee — the pattern must include {'{EMP}'}</option>
          </select>
        </Field>
      </div>
      <div className="alert info numbering-preview">
        Next number: <span className="mono">{preview}</span>
        {usesEmp && <span className="numbering-caption">shown for employee 001</span>}
        <span className="numbering-caption">
          Numbers already issued keep the format they were created with — this only affects new
          documents.
        </span>
      </div>
    </Modal>
  );
}

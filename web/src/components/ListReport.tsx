import { useEffect, useState } from 'react';
import { api, downloadBlob, openPdf, qs } from '../lib/api';
import { Field, Modal, ModalFoot, ErrorBox } from './ui';
import { TickPicker, type TickChoice } from './TickPicker';
import { PersonSelect, type PersonRow } from './People';

/**
 * "Generate Report" on a list (2026-10-16, the owner's Job Orders and CAD
 * J.O. samples): pick the requester, the team, the assigned person, the
 * requested-date range and any number of statuses, then download the list's
 * own paper (PDF) or its CSV that opens in Excel. Both are the list's own
 * endpoints under the list's own filter keys, so the report is the list.
 */
export function ListReportModal({
  title,
  pdfPath,
  csvPath,
  fileName,
  requesters,
  assignees,
  assigneeLabel,
  statuses,
  onClose,
}: {
  title: string;
  /** e.g. `/api/job-orders/pdf` */
  pdfPath: string;
  /** e.g. `/job-orders/csv` */
  csvPath: string;
  fileName: string;
  requesters: PersonRow[];
  assignees: PersonRow[];
  assigneeLabel: string;
  statuses: TickChoice[];
  onClose: () => void;
}) {
  const [teams, setTeams] = useState<TickChoice[]>([]);
  const [requestedById, setRequester] = useState('');
  const [teamId, setTeam] = useState('');
  const [assignedToId, setAssignee] = useState('');
  const [createdFrom, setFrom] = useState('');
  const [createdTo, setTo] = useState('');
  const [status, setStatus] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ id: string; code: string; name: string; isActive: boolean }[]>('/reference/industries')
      .then((rows) => setTeams(rows.filter((t) => t.isActive).map((t) => ({ value: t.id, label: t.code, hint: t.name }))))
      .catch(() => setTeams([]));
  }, []);

  const query = () =>
    qs({
      scope: 'all',
      requestedById: requestedById || undefined,
      teamId: teamId || undefined,
      assignedToId: assignedToId || undefined,
      createdFrom: createdFrom || undefined,
      createdTo: createdTo || undefined,
      status: status.length ? status.join(',') : undefined,
    });

  function reset() {
    setRequester('');
    setTeam('');
    setAssignee('');
    setFrom('');
    setTo('');
    setStatus([]);
  }

  async function csv() {
    setBusy(true);
    setError(null);
    try {
      await downloadBlob(`${csvPath}${query()}`, fileName);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} cancelLabel="Close" busy={busy}>
          <button type="button" className="btn" onClick={reset} disabled={busy}>
            Reset filters
          </button>
          <button type="button" className="btn" onClick={() => void csv()} disabled={busy}>
            Download Excel (CSV)
          </button>
          <button type="button" className="btn btn-primary" onClick={() => openPdf(`${pdfPath}${query()}`, (m) => setError(new Error(m)))} disabled={busy}>
            Download PDF report
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-2">
        <Field label="Requester">
          <PersonSelect value={requestedById} onChange={setRequester} people={requesters} placeholder="All requesters" />
        </Field>
        <Field label="Team">
          <select value={teamId} onChange={(e) => setTeam(e.target.value)}>
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label} — {t.hint}
              </option>
            ))}
            <option value="none">No team</option>
          </select>
        </Field>
        <Field label={assigneeLabel}>
          <PersonSelect value={assignedToId} onChange={setAssignee} people={assignees} placeholder={`All — ${assigneeLabel.toLowerCase()}`} />
        </Field>
        <Field label="Date requested">
          <div className="grid grid-2">
            <input type="date" aria-label="Requested from" value={createdFrom} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" aria-label="Requested to" value={createdTo} min={createdFrom || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
        </Field>
      </div>
      <Field label="Status">
        <TickPicker choices={statuses} value={status} onChange={setStatus} none="Every status" noun="statuses" />
      </Field>
    </Modal>
  );
}

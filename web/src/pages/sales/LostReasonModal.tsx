import { useState } from 'react';
import { ErrorBox, Field, Modal } from '../../components/ui';

/**
 * "Why was it lost?" — asked before anything is marked lost.
 *
 * The lead and quotation routes refuse LOST without a reason
 * (`assertLeadStatusChange` / `assertOutcomeChange` in api/src/shared/
 * pipeline.ts), because Sales Analytics reports the reasons and "Not recorded"
 * teaches nobody anything. This is the one place that question is asked, so
 * the board, the lead page and the quotation page ask it the same way.
 *
 * `onSave` does the PATCH; if it throws, the message stays in the modal and
 * the reason typed so far is kept.
 */
export function LostReasonModal({
  what,
  initial = '',
  onClose,
  onSave,
}: {
  /** What is being lost, for the title line — a number or a company name. */
  what?: string;
  initial?: string;
  onClose: () => void;
  onSave: (reason: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = reason.trim().length >= 3;

  async function save() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(reason.trim());
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Why was it lost?"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={save} disabled={busy || !valid}>
            {busy ? 'Saving…' : 'Mark lost'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field
          label={what ? `Reason ${what} was lost` : 'Reason'}
          required
          hint="Price, timing, went to a competitor, project shelved… Sales Analytics groups these, so a few plain words beat a paragraph."
        >
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { api, qs } from '../../lib/api';
import { openAttachment } from '../../components/Attachments';
import { useConfirm } from '../../components/Confirm';
import { ErrorBox, Loading, StatusBadge, formatDateTime, useToast, type Tone } from '../../components/ui';

/**
 * The face samples on file for one person — the Clock page's "Your face
 * samples" and the employee record's Face samples tab for HR.
 *
 * Every sample is listed, the ones the clock matches against ("current",
 * computed by the server's present face engine) and the old ones it no longer
 * reads ("legacy": computed by an earlier engine, kept so a person's photo
 * history is not lost and re-derived at boot where the photo survives). A
 * sample is removed one at a time or all together, always asked first in the
 * confirm bar (rule 19); its photo goes with it, and so does the account
 * picture when it was cut from that sample — a face removed from a person's
 * samples is not left as their avatar.
 *
 * `GET /clock/enrollments?employeeId=`, `DELETE /clock/enrollments/:id` and
 * `DELETE /clock/enrollments?employeeId=`: self, or HR with
 * `ghr.employees.edit_all` — the right the employee record's Face samples tab
 * takes (a face sample is not the register's to read).
 */

/** What the server keeps about a capture (shared/face.ts `FaceQuality`), or why a re-derive failed. */
export interface FaceSampleQuality {
  score?: number;
  eyeDistance?: number;
  brightness?: number;
  yaw?: number;
  tilt?: number;
  levelled?: boolean;
  contrastRetry?: boolean;
  frameScale?: number;
  rederiveFailed?: string;
}

export interface FaceSample {
  id: string;
  /** The attachment holding the capture; null when the photo is gone. */
  photoId: string | null;
  createdAt: string;
  enrolledBy: { id: string; name: string } | null;
  /** Computed by the present engine, so the clock matches against it. */
  current: boolean;
  quality: FaceSampleQuality | null;
}

export interface FaceEnrollments {
  employee: { id: string; name: string };
  samples: FaceSample[];
  current: number;
  legacy: number;
  samplesNeeded: number;
  maxSamples: number;
}

const SAMPLE_TONES: Record<string, Tone> = { CURRENT: 'ok', LEGACY: 'warn', FLAGGED: 'danger' };

/** A capture as `openAttachment` takes it: the clock's captures are JPEGs. */
const asFile = (photoId: string) => ({ id: photoId, fileName: 'face-sample.jpg', mimeType: 'image/jpeg' });

/**
 * One sample's picture, fetched with the bearer token (an `<img src>` cannot
 * carry it) and shown as an object URL that is revoked when it goes. A button,
 * so the keyboard reaches it: it opens the capture full size.
 */
export function FaceThumb({ photoId, label }: { photoId: string | null; label: string }) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setUrl(null);
    setFailed(false);
    if (!photoId) return;
    let live = true;
    let made: string | null = null;
    api
      .getBlob(`/attachments/file/${photoId}`)
      .then((blob) => {
        made = URL.createObjectURL(blob);
        if (live) setUrl(made);
        else URL.revokeObjectURL(made);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [photoId]);

  if (!photoId || failed) {
    return (
      <span className="face-thumb face-thumb-empty" role="img" aria-label={`${label}: no photo on file`}>
        No photo
      </span>
    );
  }
  return (
    <button
      type="button"
      className="face-thumb"
      aria-label={`${label} — open the photo`}
      title="Open the photo"
      onClick={() => {
        void openAttachment(asFile(photoId)).then((ok) => {
          if (!ok) toast('error', 'The photo could not be opened');
        });
      }}
    >
      {url ? <img src={url} alt="" /> : <span className="faint">…</span>}
    </button>
  );
}

export function FaceSamplesPanel({
  employeeId,
  self,
  editable,
  reloadToken = 0,
  flaggedSampleId,
  onChanged,
}: {
  employeeId: string;
  /** The viewer's own samples ("your …"), as on the Clock page. */
  self: boolean;
  /** May remove samples: the person themself, or `ghr.employees.edit_all`. */
  editable: boolean;
  /** Bump to load again (after a sample is added elsewhere on the page). */
  reloadToken?: number;
  /** A sample Face health flagged as unlike the person's others — marked in the grid. */
  flaggedSampleId?: string | null;
  /** After a sample is removed or the set reset, so the page can reload its own counts. */
  onChanged?: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<FaceEnrollments | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<FaceEnrollments>(`/clock/enrollments${qs({ employeeId })}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [employeeId]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading label="Loading the face samples…" />;

  const { samples, current, legacy, samplesNeeded, maxSamples } = data;
  const whose = self ? 'your' : `${data.employee.name}’s`;
  const short = Math.max(0, samplesNeeded - current);

  function askRemove(sample: FaceSample, index: number) {
    const left = sample.current ? current - 1 : current;
    confirm.ask({
      title: `Remove face sample ${index + 1}?`,
      body: (
        <>
          The sample and its photo are deleted, and the account picture too if it was made from this sample.{' '}
          {sample.current && left < samplesNeeded
            ? `Face clock-in needs ${samplesNeeded} samples; with ${left} left, ${self ? 'you' : data!.employee.name} cannot clock in with a face until more are added.`
            : sample.current
              ? `${left} current samples stay.`
              : 'It is an old sample the clock no longer matches against.'}
        </>
      ),
      confirmLabel: 'Remove',
      onConfirm: async () => {
        await api.del(`/clock/enrollments/${sample.id}`);
        toast('ok', 'Face sample removed');
        await load();
        onChanged?.();
      },
    });
  }

  function askReset() {
    confirm.ask({
      title: self ? 'Start over with your face samples?' : `Remove all of ${data!.employee.name}’s face samples?`,
      body: `All ${samples.length} sample${samples.length === 1 ? '' : 's'} are deleted, current and old. Face clock-in stops until ${samplesNeeded} new samples are added${self ? ' on this page' : ' — they add them on the Clock page'}.`,
      confirmLabel: self ? 'Start over' : 'Remove all',
      onConfirm: async () => {
        const result = await api.del<{ removed: number } | undefined>(`/clock/enrollments${qs({ employeeId })}`);
        const removed = result?.removed ?? samples.length;
        toast('ok', `${removed} face sample${removed === 1 ? '' : 's'} removed`);
        await load();
        onChanged?.();
      },
    });
  }

  return (
    <div className="face-samples">
      {confirm.bar}
      <ErrorBox error={error} />

      <p className="muted face-samples-count">
        {short === 0
          ? `${current} samples in use — face clock-in needs ${samplesNeeded}, and takes at most ${maxSamples}`
          : `${current} of the ${samplesNeeded} samples face clock-in needs`}
        {legacy > 0 && ` · ${legacy} old sample${legacy === 1 ? '' : 's'} the clock no longer matches against`}.
        {short > 0 && samples.length > 0 && (
          <>
            {' '}
            {self ? 'Add' : 'They need'} {short} more before face clock-in works.
          </>
        )}
      </p>

      {samples.length === 0 ? (
        <p className="faint hraud-flush">No face samples on file{self ? ' yet' : ''}.</p>
      ) : (
        <ul className="face-sample-grid">
          {samples.map((s, i) => {
            const label = `Sample ${i + 1}, ${formatDateTime(s.createdAt)}`;
            // Who added it, when that was somebody else (HR at the person's side).
            const by =
              !self && s.enrolledBy && s.enrolledBy.name !== data.employee.name ? `added by ${s.enrolledBy.name}` : null;
            const flagged = flaggedSampleId === s.id;
            return (
              <li key={s.id} className={`face-sample${flagged ? ' flagged' : ''}`}>
                <FaceThumb photoId={s.photoId} label={label} />
                <div className="face-sample-meta">
                  <StatusBadge
                    status={flagged ? 'FLAGGED' : s.current ? 'CURRENT' : 'LEGACY'}
                    extra={SAMPLE_TONES}
                    label={flagged ? 'Unlike the others' : s.current ? 'Current' : 'Old engine'}
                  />
                  <span className="faint">{formatDateTime(s.createdAt)}</span>
                  {by && <span className="faint">{by}</span>}
                  {s.quality?.rederiveFailed && (
                    <span className="faint">Could not be upgraded: {s.quality.rederiveFailed}</span>
                  )}
                </div>
                {editable && (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger-ghost"
                    onClick={() => askRemove(s, i)}
                    disabled={confirm.open}
                    aria-label={`Remove ${label}`}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editable && samples.length > 0 && (
        <div className="face-samples-foot">
          <button type="button" className="btn btn-sm btn-danger-ghost" onClick={askReset} disabled={confirm.open}>
            {self ? 'Start over' : 'Reset all'}
          </button>
        </div>
      )}
      {!self && (
        <p className="faint hraud-flush face-samples-note">
          Samples are taken on the Clock page, in front of the camera. Remove one that is blurred, dark, or of
          someone else; the clock matches {whose} face against what stays.
        </p>
      )}
    </div>
  );
}

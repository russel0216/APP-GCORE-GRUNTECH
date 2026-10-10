import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Field, Loading, formatDateTime, formatTime, useToast } from '../../components/ui';

/**
 * The time clock.
 *
 * "Any one who access the web application can clock in clock out" — so this
 * screen is open to every signed-in person, and is the one G-HR screen that
 * needs no permission beyond having an employee record.
 *
 * The camera frame is sent to the server as a photograph. The server works out
 * whose face it is; the browser never asserts an identity. That is slower than
 * matching in the page, and it is the whole point — a descriptor computed here
 * would be a number the client could simply make up.
 */

interface ClockState {
  employee: { id: string; firstName: string; lastName: string; employeeNo: string } | null;
  message?: string;
  /**
   * Only for somebody who can open the employee register, and only while this
   * login is unlinked: the unlinked record carrying the login's employee
   * number, if there is one.
   */
  candidate?: { id: string; employeeNo: string; name: string } | null;
  enrolled?: boolean;
  faceSamples?: number;
  faceEngineReady?: boolean;
  today: {
    timeIn: string | null;
    timeOut: string | null;
    status: string;
    lateMinutes: number;
    workedMinutes: number;
    timeInMethod: string | null;
    notes: string | null;
  } | null;
  settings: { workStart: string; workEnd: string; graceMinutes: number };
}

type Mode = 'idle' | 'starting' | 'live' | 'denied' | 'unsupported';

/** Camera plumbing, kept apart from the clock logic that uses it. */
function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [detail, setDetail] = useState<string>('');

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setMode('idle');
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMode('unsupported');
      setDetail('This browser cannot open a camera. Use the fallback below.');
      return;
    }
    setMode('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setMode('live');
    } catch (err) {
      setMode('denied');
      setDetail(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'The camera was blocked. Allow it in the address bar, or use the fallback below.'
          : 'No camera is available on this device. Use the fallback below.',
      );
    }
  }, []);

  /** The current frame as a JPEG, or null if there is nothing to capture. */
  const capture = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85));
  }, []);

  useEffect(() => stop, [stop]);

  return { videoRef, mode, detail, start, stop, capture };
}

export function Clock() {
  const toast = useToast();
  const { refresh: refreshAuth, can, me } = useAuth();
  const camera = useCamera();
  const [state, setState] = useState<ClockState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(new Date());
  const [fallback, setFallback] = useState(false);
  const [fallbackForm, setFallbackForm] = useState({ method: 'PIN', reason: '' });

  const load = useCallback(async () => {
    try {
      setState(await api.get<ClockState>('/clock/me'));
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The clock face itself. A time clock that shows a stale time is worse than
  // one that shows none.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (state?.employee && state.enrolled) camera.start();
    // Starting the camera once, when we know there is someone to recognise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.employee?.id, state?.enrolled]);

  async function punch(action: 'IN' | 'OUT', method: 'FACE' | 'PIN' | 'BIOMETRIC') {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('action', action);
      form.set('method', method);
      if (method !== 'FACE') form.set('fallbackReason', fallbackForm.reason);

      const photo = await camera.capture();
      if (photo) form.set('photo', photo, `clock-${Date.now()}.jpg`);
      else if (method === 'FACE') {
        throw new Error('The camera has not started yet — give it a moment, or use the fallback.');
      }

      const result = await api.post<{ message: string }>('/clock', form);
      toast('ok', result.message);
      setFallback(false);
      setFallbackForm({ method: 'PIN', reason: '' });
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function enroll() {
    setBusy(true);
    setError(null);
    try {
      const photo = await camera.capture();
      if (!photo) throw new Error('The camera has not started yet — give it a moment.');
      const form = new FormData();
      form.set('photo', photo, `enrol-${Date.now()}.jpg`);
      const result = await api.post<{ samples: number }>('/clock/enroll', form);
      toast(
        'ok',
        result.samples < 3
          ? `Face saved — ${result.samples} of 3. Capture a couple more from slightly different angles.`
          : `Face saved — ${result.samples} samples. It's also your account photo now.`,
      );
      await load();
      // The server just pointed this capture at User.photoPath (see hr.ts) —
      // refetch /auth/me so the topbar avatar reflects it without a reload.
      await refreshAuth();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!state) return <Loading label="Opening the clock…" />;

  if (!state.employee) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1>Clock In / Out</h1>
          </div>
        </div>
        <div className="card">
          <div className="alert warn hraud-flush">{state.message}</div>
          {/*
            "Ask HR to link it" is a dead end when the person reading it IS
            HR — or an administrator setting the system up. For them it is a
            link: the record the login matches, else the register searched by
            name. The link is made on the employee record (its Login account field).
          */}
          {can('ghr.employees.edit_all') && (
            <p className="hraud-after hraud-flush">
              {state.candidate ? (
                <Link to={`/g-hr/employees/${state.candidate.id}`}>
                  Open {state.candidate.name} ({state.candidate.employeeNo}) and link this login →
                </Link>
              ) : (
                <Link to={`/g-hr/employees?q=${encodeURIComponent(me?.user.name.split(' ').pop() ?? '')}`}>
                  Find the employee record and link this login →
                </Link>
              )}
            </p>
          )}
          {!can('ghr.employees.edit_all') && can('admin.users.edit_all') && me && (
            <p className="hraud-after hraud-flush">
              <Link to={`/admin/users/${me.user.id}`}>Check this login’s employee number →</Link>{' '}
              <span className="faint">HR links it from the employee record.</span>
            </p>
          )}
        </div>
      </div>
    );
  }

  const today = state.today;
  const clockedIn = !!today?.timeIn;
  const clockedOut = !!today?.timeOut;
  const nextAction: 'IN' | 'OUT' = clockedIn ? 'OUT' : 'IN';
  const done = clockedIn && clockedOut;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Clock In / Out</h1>
          <p>
            {state.employee.firstName} {state.employee.lastName} ·{' '}
            <span className="mono">{state.employee.employeeNo}</span> · the working day is{' '}
            {state.settings.workStart}–{state.settings.workEnd} with {state.settings.graceMinutes}{' '}
            minutes' grace.
          </p>
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="grid grid-2">
        <div className="card">
          <div className="clock-now">
            <div className="clock-time mono">
              {formatTime(now, { hour12: false, seconds: true })}
            </div>
            <div className="faint">
              {now.toLocaleDateString('en-PH', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            </div>
          </div>

          <div className="camera-frame">
            <video ref={camera.videoRef} muted playsInline className="camera-video" />
            {camera.mode !== 'live' && (
              <div className="camera-overlay">
                {camera.mode === 'starting' ? (
                  <Loading label="Starting the camera…" />
                ) : (
                  <div className="faint hraud-camera-note">
                    {camera.detail || 'Camera off'}
                    {camera.mode === 'idle' && (
                      <div className="hraud-gap-above">
                        <button className="btn btn-sm" onClick={camera.start}>
                          Start camera
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {!state.enrolled ? (
            <>
              <div className="alert info">
                Your face is not enrolled yet. Look at the camera and capture three samples — a
                straight-on shot and two at slight angles. It takes about ten seconds and you only
                do it once.
              </div>
              <button
                className="btn btn-primary btn-block"
                onClick={enroll}
                disabled={busy || camera.mode !== 'live'}
              >
                {busy ? 'Saving…' : `Capture sample ${(state.faceSamples ?? 0) + 1}`}
              </button>
            </>
          ) : done ? (
            <div className="alert ok hraud-flush">
              You are done for today — in at {formatDateTime(today!.timeIn)}, out at{' '}
              {formatDateTime(today!.timeOut)}.
            </div>
          ) : (
            <>
              <button
                className={`btn btn-block clock-btn ${nextAction === 'IN' ? 'btn-primary' : 'btn-ok'}`}
                onClick={() => punch(nextAction, 'FACE')}
                disabled={busy || camera.mode !== 'live'}
              >
                {busy ? 'Reading…' : nextAction === 'IN' ? 'Clock In' : 'Clock Out'}
              </button>

              <button
                className="btn btn-ghost btn-sm btn-block"
                onClick={() => setFallback((f) => !f)}
                disabled={busy}
              >
                {fallback ? 'Cancel' : 'Face not working? Use the fallback'}
              </button>
            </>
          )}

          {fallback && (
            <div className="fallback-panel">
              <div className="alert warn">
                A fallback entry is recorded as a fallback, with your reason and the photo. HR sees
                both.
              </div>
              <Field label="How are you identifying yourself?">
                <select
                  value={fallbackForm.method}
                  onChange={(e) => setFallbackForm({ ...fallbackForm, method: e.target.value })}
                >
                  <option value="PIN">PIN / password (this sign-in)</option>
                  <option value="BIOMETRIC">Fingerprint device at the door</option>
                </select>
              </Field>
              <Field label="Why is face recognition not being used?">
                <input
                  value={fallbackForm.reason}
                  onChange={(e) => setFallbackForm({ ...fallbackForm, reason: e.target.value })}
                  placeholder="e.g. camera broken on the site laptop"
                />
              </Field>
              <button
                className="btn btn-primary btn-block"
                onClick={() => punch(nextAction, fallbackForm.method as 'PIN' | 'BIOMETRIC')}
                disabled={busy || fallbackForm.reason.trim().length < 3}
              >
                {busy ? 'Recording…' : `Clock ${nextAction === 'IN' ? 'in' : 'out'} with a reason`}
              </button>
            </div>
          )}
        </div>

        <div>
          <div className="card">
            <h3 className="card-title">Today</h3>
            {today ? (
              <dl className="kv">
                <dt>Clocked in</dt>
                <dd>{formatDateTime(today.timeIn)}</dd>
                <dt>Clocked out</dt>
                <dd>{today.timeOut ? formatDateTime(today.timeOut) : <span className="faint">— still in —</span>}</dd>
                <dt>Status</dt>
                <dd>
                  <span className={`badge ${today.status === 'LATE' ? 'warn' : 'ok'}`}>
                    {today.status.toLowerCase().replace(/_/g, ' ')}
                  </span>
                  {today.lateMinutes > 0 && (
                    <span className="faint"> · {today.lateMinutes} minutes late</span>
                  )}
                </dd>
                <dt>Hours so far</dt>
                <dd className="mono">{(today.workedMinutes / 60).toFixed(2)}</dd>
                <dt>Identified by</dt>
                <dd>{today.timeInMethod?.toLowerCase() ?? '—'}</dd>
                {today.notes && (
                  <>
                    <dt>Note</dt>
                    <dd>{today.notes}</dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="muted hraud-flush">Nothing recorded yet today.</p>
            )}
          </div>

          <div className="card">
            <h3 className="card-title">Your face</h3>
            <p className="muted">
              {state.faceSamples ?? 0} sample{state.faceSamples === 1 ? '' : 's'} enrolled.
              {(state.faceSamples ?? 0) > 0 && (state.faceSamples ?? 0) < 3 && (
                <> Adding a couple more makes recognition steadier in poor light.</>
              )}
            </p>
            {state.enrolled && (
              <button
                className="btn btn-sm"
                onClick={enroll}
                disabled={busy || camera.mode !== 'live'}
              >
                Add another sample
              </button>
            )}
            {state.faceEngineReady === false && (
              <div className="alert warn hraud-after hraud-flush">
                The recognition models are still loading on the server. Give it a few seconds, or
                use the fallback.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

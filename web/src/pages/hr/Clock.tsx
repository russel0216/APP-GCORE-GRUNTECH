import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { frameSharpness, scoringSize, sharpestIndex } from '../../lib/frameSharpness';
import { ErrorBox, Field, Loading, formatDateTime, formatTime, useToast } from '../../components/ui';
import { FaceSamplesPanel } from './FaceSamples';

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
 *
 * What the page does do is send the server a GOOD photograph (2026-10-10,
 * after colleagues were matched to each other's accounts): the camera asks for
 * 1280×720, nothing can be captured until the picture has run for a moment
 * (a webcam's exposure settles over the first half second), every capture is
 * a burst of three frames of which the sharpest goes (lib/frameSharpness.ts),
 * and the preview shows the whole frame — never cropped — with an oval to put
 * the face in, so what the person sees is what is sent. Enrolment takes three
 * samples, each with its own instruction, before face clock-in is offered.
 *
 * With the liveness check on (`liveness` from /clock/me; HR Settings ›
 * "Ask for a blink or a head turn"), one press of Capture sample / Clock In /
 * Clock Out is one sequence: a fresh challenge is fetched FIRST
 * (GET /clock/challenge — blink or turn, 2.5 s, single use), then the settle
 * and burst as before for the still, then the challenge itself — the prompt
 * under the oval says what to do, a ring around it drains over the 2.5 s
 * (a plain countdown under prefers-reduced-motion) while a frame is grabbed
 * every ~125 ms at 480 px wide — and the still, the frames and the token go
 * up together. The server decides whether the movement was seen; its refusal
 * shows verbatim, as every other does. Off, nothing of this happens.
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
  /** faceSamples ≥ samplesNeeded: the clock will match this face. */
  enrolled?: boolean;
  /** Samples from the present face engine — the only ones the clock matches against. */
  faceSamples?: number;
  /** Samples from an earlier engine, kept but no longer matched. */
  legacySamples?: number;
  samplesNeeded?: number;
  maxSamples?: number;
  faceEngineReady?: boolean;
  /** Whether a capture must answer a liveness challenge (a blink or a head turn). */
  liveness?: boolean;
  today: {
    timeIn: string | null;
    timeOut: string | null;
    status: string;
    lateMinutes: number;
    workedMinutes: number;
    timeInMethod: string | null;
    timeOutMethod?: string | null;
    /** The clock-in fallback's reason. */
    notes: string | null;
    /** The clock-out fallback's reason. */
    timeOutNotes?: string | null;
  } | null;
  settings: { workStart: string; workEnd: string; graceMinutes: number };
}

type Mode = 'idle' | 'starting' | 'live' | 'denied' | 'unsupported';

/** How long the picture runs before a capture is allowed: a webcam's exposure and focus settle over the first half second. */
const SETTLE_MS = 700;
/** Frames in a capture burst, and the gap between them; the sharpest is sent. */
const BURST_FRAMES = 3;
const BURST_GAP_MS = 120;
const JPEG_QUALITY = 0.92;

/**
 * The liveness burst: a small frame every ~125 ms while the ring runs (about
 * twenty over 2.5 s, never more than the server's 24), 480 px wide at a
 * lighter JPEG quality — the server reads landmarks off them, nothing more.
 */
const CHALLENGE_FRAME_GAP_MS = 125;
const CHALLENGE_MAX_FRAMES = 24;
const CHALLENGE_FRAME_WIDTH = 480;
const CHALLENGE_JPEG_QUALITY = 0.7;

/** The defaults the server sends (shared/hr.ts), for a /clock/me that predates them. */
const DEFAULT_SAMPLES_NEEDED = 3;
const DEFAULT_MAX_SAMPLES = 5;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type ChallengeKind = 'blink' | 'turn';

/** What GET /clock/challenge answers: the movement to ask for and the token the capture carries back. */
interface Challenge {
  challenge: string;
  kind: ChallengeKind;
  seconds: number;
  expiresAt: string;
}

/** What the prompt under the oval says while the ring runs. */
const CHALLENGE_PROMPT: Record<ChallengeKind, string> = {
  blink: 'Blink once, clearly',
  turn: 'Turn your head slightly left, then right',
};

/** What the button says while the ring runs. */
const CHALLENGE_LABEL: Record<ChallengeKind, string> = {
  blink: 'Blink…',
  turn: 'Turn…',
};

/** What to do for the next sample: three different looks make a steadier match than three of the same. */
function enrolPrompt(n: number, needed: number, max: number): string {
  if (n === 1) return `Sample 1 of ${needed} — look straight at the camera`;
  if (n === 2 && needed >= 2) return `2 of ${needed} — turn your head slightly left`;
  if (n === 3 && needed >= 3) return `3 of ${needed} — slightly right`;
  return `Sample ${n} of up to ${max} — look straight at the camera`;
}

/** Camera plumbing, kept apart from the clock logic that uses it. */
function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const settleTimer = useRef<number | null>(null);
  /**
   * Bumped by every stop, so a start still waiting on the browser when the
   * camera was stopped (a page left, React's development double mount) puts
   * its stream away instead of leaving the camera light on.
   */
  const generation = useRef(0);
  const starting = useRef(false);
  const [mode, setMode] = useState<Mode>('idle');
  const [detail, setDetail] = useState<string>('');
  /** The picture has run long enough to be worth capturing. */
  const [settled, setSettled] = useState(false);
  /** The frame's shape, so the preview shows all of it and nothing else. */
  const [shape, setShape] = useState<{ w: number; h: number } | null>(null);

  const clearSettle = () => {
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = null;
  };

  const stop = useCallback(() => {
    generation.current++;
    starting.current = false;
    clearSettle();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setSettled(false);
    setMode('idle');
  }, []);

  /** The video's own size, once it knows it — and again whenever it changes. */
  const onMetadata = useCallback(() => {
    const v = videoRef.current;
    if (v?.videoWidth && v.videoHeight) setShape({ w: v.videoWidth, h: v.videoHeight });
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMode('unsupported');
      setDetail('This browser cannot open a camera. Use the fallback below.');
      return;
    }
    if (streamRef.current || starting.current) return;
    starting.current = true;
    const run = generation.current;
    setMode('starting');
    setSettled(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (run !== generation.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      starting.current = false;
      streamRef.current = stream;
      if (videoRef.current) {
        // A phone turned mid-session sends frames of the other shape: the
        // video says so with 'resize' (React has no prop for it).
        videoRef.current.addEventListener('resize', onMetadata);
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      // Stopped while the picture was starting: stop() has put the stream away.
      if (run !== generation.current) return;
      setMode('live');
      clearSettle();
      settleTimer.current = window.setTimeout(() => setSettled(true), SETTLE_MS);
    } catch (err) {
      if (run !== generation.current) return;
      starting.current = false;
      setMode('denied');
      setDetail(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'The camera was blocked. Allow it in the address bar, or use the fallback below.'
          : 'No camera is available on this device. Use the fallback below.',
      );
    }
  }, [onMetadata]);

  /**
   * A burst of frames a moment apart, and the sharpest of them as a JPEG — or
   * null if there is nothing to capture. Sharpness is judged on a small
   * greyscale copy's centre, where the oval asks for the face.
   */
  const capture = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const width = video.videoWidth;
    const height = video.videoHeight;
    const small = scoringSize(width, height);
    const scorer = document.createElement('canvas');
    scorer.width = small.width;
    scorer.height = small.height;
    const scoreCtx = scorer.getContext('2d', { willReadFrequently: true });

    const frames: HTMLCanvasElement[] = [];
    const scores: number[] = [];
    for (let i = 0; i < BURST_FRAMES; i++) {
      if (i > 0) await wait(BURST_GAP_MS);
      if (!video.videoWidth) break;
      const frame = document.createElement('canvas');
      frame.width = width;
      frame.height = height;
      const ctx = frame.getContext('2d');
      if (!ctx) continue;
      ctx.drawImage(video, 0, 0, width, height);
      frames.push(frame);
      if (scoreCtx && small.width > 0) {
        scoreCtx.drawImage(frame, 0, 0, small.width, small.height);
        scores.push(frameSharpness(scoreCtx.getImageData(0, 0, small.width, small.height).data, small.width, small.height));
      } else {
        scores.push(0);
      }
    }
    if (!frames.length) return null;
    const best = frames[Math.max(0, sharpestIndex(scores))];
    return new Promise((resolve) => best.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY));
  }, []);

  /**
   * The liveness burst: small frames of the camera view, one every
   * `CHALLENGE_FRAME_GAP_MS` for `seconds`, in the order they were taken.
   * `onTick` is told how much of the time is left (1 → 0) as each frame is
   * due, for the countdown. Empty when there is no picture to grab.
   */
  const burst = useCallback(async (seconds: number, onTick?: (left: number) => void): Promise<Blob[]> => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return [];
    const width = CHALLENGE_FRAME_WIDTH;
    const height = Math.max(1, Math.round((width * video.videoHeight) / video.videoWidth));
    const total = seconds * 1000;
    const t0 = performance.now();
    const pending: Promise<Blob | null>[] = [];
    for (let i = 0; i < CHALLENGE_MAX_FRAMES; i++) {
      const due = i * CHALLENGE_FRAME_GAP_MS;
      if (due > total) break;
      const now = performance.now() - t0;
      if (due > now) await wait(due - now);
      if (!video.videoWidth) break;
      onTick?.(Math.max(0, 1 - (performance.now() - t0) / total));
      const frame = document.createElement('canvas');
      frame.width = width;
      frame.height = height;
      const ctx = frame.getContext('2d');
      if (!ctx) continue;
      ctx.drawImage(video, 0, 0, width, height);
      pending.push(new Promise((resolve) => frame.toBlob((b) => resolve(b), 'image/jpeg', CHALLENGE_JPEG_QUALITY)));
    }
    // The ring runs the whole of its time, whatever the frame count.
    const left = total - (performance.now() - t0);
    if (left > 0) await wait(left);
    onTick?.(0);
    return (await Promise.all(pending)).filter((b): b is Blob => b !== null);
  }, []);

  useEffect(() => stop, [stop]);

  return { videoRef, mode, detail, settled, shape, start, stop, capture, burst, onMetadata };
}

export function Clock() {
  const toast = useToast();
  const { refresh: refreshAuth, can, me } = useAuth();
  const camera = useCamera();
  const [state, setState] = useState<ClockState | null>(null);
  const [error, setError] = useState<unknown>(null);
  /**
   * What the button is doing: holding still for the burst, then performing
   * the liveness challenge while the ring runs, then waiting on the server.
   */
  const [busy, setBusy] = useState<null | 'capturing' | 'challenge' | 'sending'>(null);
  /** The challenge the ring is running, while it runs. */
  const [challenge, setChallenge] = useState<ChallengeKind | null>(null);
  /** Whole seconds left on the ring — the countdown shown where motion is turned off. */
  const [secondsLeft, setSecondsLeft] = useState(0);
  /** The ring, drained by writing `--ring` on it (1 full, 0 gone) — no re-render per frame. */
  const ringRef = useRef<HTMLDivElement | null>(null);
  /** The animation frame draining the ring, so a finished challenge stops it. */
  const ringFrame = useRef<number | null>(null);
  const [now, setNow] = useState(new Date());
  const [fallback, setFallback] = useState(false);
  const [fallbackForm, setFallbackForm] = useState({ method: 'PIN', reason: '' });
  /** Adding a sample past the three needed, from the samples card. */
  const [adding, setAdding] = useState(false);
  /** Bumped after a sample is saved, so the samples card loads again. */
  const [samplesVersion, setSamplesVersion] = useState(0);

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
    // The camera is for clocking in AND for enrolling, so it starts once we
    // know there is someone to recognise or to enrol.
    if (state?.employee) camera.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.employee?.id]);

  const liveness = !!state?.liveness;

  /** Drains the ring smoothly over `seconds`, from the moment it is called; stopped by `stopRing`. */
  function startRing(seconds: number) {
    const t0 = performance.now();
    const tick = () => {
      const left = Math.max(0, 1 - (performance.now() - t0) / (seconds * 1000));
      ringRef.current?.style.setProperty('--ring', String(left));
      ringFrame.current = left > 0 ? window.requestAnimationFrame(tick) : null;
    };
    ringRef.current?.style.setProperty('--ring', '1');
    ringFrame.current = window.requestAnimationFrame(tick);
  }

  function stopRing() {
    if (ringFrame.current !== null) window.cancelAnimationFrame(ringFrame.current);
    ringFrame.current = null;
  }

  useEffect(() => stopRing, []);

  /**
   * One capture, as the server wants it, put on `form`: the sharpest still of
   * the burst as `photo` and — with the liveness check on — the challenge
   * token and the frames taken while the person performed it. The challenge
   * is fetched FIRST, so a refused one (the brake, a lost link) is said before
   * the person is asked to hold still for nothing. False when the camera has
   * no picture to give; the caller says so in its own words.
   */
  async function takeCapture(form: FormData, name: string, withChallenge: boolean): Promise<boolean> {
    setBusy('capturing');
    try {
      const asked = withChallenge ? await api.get<Challenge>('/clock/challenge') : null;
      const photo = await camera.capture();
      if (!photo) return false;
      form.set('photo', photo, `${name}-${Date.now()}.jpg`);
      if (asked) {
        setChallenge(asked.kind);
        setSecondsLeft(Math.ceil(asked.seconds));
        setBusy('challenge');
        startRing(asked.seconds);
        const frames = await camera.burst(asked.seconds, (left) => setSecondsLeft(Math.ceil(left * asked.seconds)));
        frames.forEach((frame, i) => form.append('frames', frame, `frame-${String(i).padStart(2, '0')}.jpg`));
        form.set('challenge', asked.challenge);
      }
      return true;
    } finally {
      stopRing();
      setChallenge(null);
      setBusy('sending');
    }
  }

  async function punch(action: 'IN' | 'OUT', method: 'FACE' | 'PIN' | 'BIOMETRIC') {
    setError(null);
    try {
      const form = new FormData();
      form.set('action', action);
      form.set('method', method);
      if (method !== 'FACE') form.set('fallbackReason', fallbackForm.reason);

      // A fallback entry keeps its photo too, as evidence, but answers no
      // challenge: the liveness gate is the face clock's.
      const captured = camera.mode === 'live' ? await takeCapture(form, 'clock', method === 'FACE' && liveness) : false;
      setBusy('sending');
      if (!captured && method === 'FACE') {
        throw new Error('The camera has not started yet — give it a moment, or use the fallback.');
      }

      const result = await api.post<{ message: string }>('/clock', form);
      toast('ok', result.message);
      setFallback(false);
      setFallbackForm({ method: 'PIN', reason: '' });
      await load();
    } catch (err) {
      setError(err);
      // A refusal can mean the page is out of date — the samples were reset
      // by HR or removed in another tab, or the day already has its entry —
      // so read where things stand again: a person with too few samples is
      // put back on the enrolment prompts rather than left at a closed door.
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function enroll() {
    setError(null);
    try {
      const form = new FormData();
      if (!(await takeCapture(form, 'enrol', liveness))) {
        throw new Error('The camera has not started yet — give it a moment.');
      }
      const result = await api.post<{ samples?: number }>('/clock/enroll', form);
      const fresh = await api.get<ClockState>('/clock/me');
      setState(fresh);
      setSamplesVersion((v) => v + 1);
      setAdding(false);
      // A fallback panel opened during enrolment is not left open over the clock.
      setFallback(false);
      const have = fresh.faceSamples ?? result.samples ?? 0;
      const needed = fresh.samplesNeeded ?? DEFAULT_SAMPLES_NEEDED;
      toast(
        'ok',
        have < needed
          ? `Sample ${have} of ${needed} saved — ${needed - have} to go.`
          : have === needed
            ? `Face saved — ${have} samples. You can clock in with your face now. Your account picture is made from it.`
            : `Sample ${have} saved. Your account picture is made from it now.`,
      );
      // The server just gave this person a new account picture cut from the
      // capture (see hr.ts) — refetch /auth/me so the topbar avatar reflects
      // it without a reload.
      await refreshAuth();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (!state) return <Loading label="Opening the clock…" />;

  if (!state.employee) {
    return (
      <div className="stack">
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

  const samples = state.faceSamples ?? 0;
  const legacy = state.legacySamples ?? 0;
  const needed = state.samplesNeeded ?? DEFAULT_SAMPLES_NEEDED;
  const max = state.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const faceReady = state.enrolled ?? samples >= needed;
  const enrolling = !faceReady || adding;
  const canCapture = camera.mode === 'live' && camera.settled && busy === null;
  /**
   * The instruction under the oval. While the ring runs it is the challenge;
   * while the still is taken it is "look at the camera" (an enrolment sample
   * keeps its own pose — the still is what is enrolled); otherwise the next
   * sample's instruction, and nothing at the clock.
   */
  const prompt =
    busy === 'challenge' && challenge
      ? CHALLENGE_PROMPT[challenge]
      : enrolling
        ? `${enrolPrompt(samples + 1, needed, max)}${busy === 'capturing' ? ' — hold still' : ''}`
        : busy === 'capturing' && liveness
          ? 'Look at the camera'
          : null;

  const captureLabel = (idle: string) =>
    busy === 'capturing'
      ? 'Hold still…'
      : busy === 'challenge' && challenge
        ? CHALLENGE_LABEL[challenge]
        : busy === 'sending'
          ? liveness
            ? 'Checking…'
            : 'Reading…'
          : camera.mode === 'live' && !camera.settled
            ? 'Camera settling…'
            : idle;

  return (
    <div className="stack">
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

          <div
            className="camera-frame"
            style={
              camera.shape
                ? ({ '--cam-w': camera.shape.w, '--cam-h': camera.shape.h } as React.CSSProperties)
                : undefined
            }
          >
            <video
              ref={camera.videoRef}
              muted
              playsInline
              className="camera-video"
              onLoadedMetadata={camera.onMetadata}
            />
            {camera.mode === 'live' && <div className="camera-guide" aria-hidden="true" />}
            {/*
              The challenge's clock: a ring around the oval that drains over
              its seconds (--ring, written by startRing), or — where motion is
              turned off — the seconds counted down in its place. The prompt
              under the picture is what is read out; neither of these is.
            */}
            {busy === 'challenge' && (
              <>
                <div ref={ringRef} className="face-ring" aria-hidden="true" />
                <div className="face-countdown mono" aria-hidden="true">
                  {secondsLeft}
                </div>
              </>
            )}
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
          {camera.mode === 'live' && (
            <p className="faint camera-hint">
              {liveness
                ? 'Put your face inside the oval, in good light. The clock will ask you to blink or turn your head.'
                : 'Put your face inside the oval, in good light, and hold still.'}
            </p>
          )}
          {/* Read out as it changes: the sample to take, then what the ring asks for. */}
          {(enrolling || prompt) && (
            <p className="face-prompt" aria-live="polite">
              {prompt}
            </p>
          )}

          {enrolling ? (
            <>
              {!adding && (
                <div className="alert info">
                  {legacy > 0 && samples < needed ? (
                    <>
                      The clock now reads faces more carefully, and needs new samples of yours to do it. Your
                      old samples stay on file. Take each one as the instruction under the camera says.
                    </>
                  ) : samples === 0 ? (
                    <>
                      Your face is not enrolled yet. The clock needs {needed} samples — one straight on and two
                      with your head turned slightly. It takes about half a minute and you only do it once.
                    </>
                  ) : (
                    <>
                      {needed - samples} more sample{needed - samples === 1 ? '' : 's'} and the clock can recognise
                      you.
                    </>
                  )}
                </div>
              )}
              <button className="btn btn-primary btn-block clock-btn" onClick={enroll} disabled={!canCapture}>
                {captureLabel(`Capture sample ${samples + 1}`)}
              </button>
              {adding ? (
                <button
                  className="btn btn-ghost btn-sm btn-block"
                  onClick={() => setAdding(false)}
                  disabled={busy !== null}
                >
                  Cancel
                </button>
              ) : (
                !done && (
                  <button
                    className="btn btn-ghost btn-sm btn-block"
                    onClick={() => setFallback((f) => !f)}
                    disabled={busy !== null}
                    aria-expanded={fallback}
                  >
                    {fallback ? 'Cancel' : `Clock ${nextAction === 'IN' ? 'in' : 'out'} another way for now`}
                  </button>
                )
              )}
            </>
          ) : done ? (
            <div className="alert ok hraud-flush">
              You are done for today — in at {formatDateTime(today!.timeIn)}, out at{' '}
              {formatDateTime(today!.timeOut)}.
            </div>
          ) : (
            <>
              <button
                className="btn btn-primary btn-block clock-btn"
                onClick={() => punch(nextAction, 'FACE')}
                disabled={!canCapture}
              >
                {captureLabel(nextAction === 'IN' ? 'Clock In' : 'Clock Out')}
              </button>

              <button
                className="btn btn-ghost btn-sm btn-block"
                onClick={() => setFallback((f) => !f)}
                disabled={busy !== null}
                aria-expanded={fallback}
              >
                {fallback ? 'Cancel' : 'Face not working? Use the fallback'}
              </button>
            </>
          )}

          {fallback && !done && !adding && (
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
                  placeholder={faceReady ? 'e.g. camera broken on the site laptop' : 'e.g. face samples not added yet'}
                />
              </Field>
              <button
                className="btn btn-primary btn-block"
                onClick={() => punch(nextAction, fallbackForm.method as 'PIN' | 'BIOMETRIC')}
                disabled={busy !== null || fallbackForm.reason.trim().length < 3}
              >
                {busy ? 'Recording…' : `Clock ${nextAction === 'IN' ? 'in' : 'out'} with a reason`}
              </button>
            </div>
          )}
        </div>

        <div className="stack">
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
                    <dt>{today.timeOutNotes ? 'Clock-in note' : 'Note'}</dt>
                    <dd>{today.notes}</dd>
                  </>
                )}
                {today.timeOutNotes && (
                  <>
                    <dt>Clock-out note</dt>
                    <dd>{today.timeOutNotes}</dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="muted hraud-flush">Nothing recorded yet today.</p>
            )}
          </div>

          <div className="card">
            <div className="panel-head">
              <h3 className="card-title">Your face samples</h3>
              {faceReady && !adding && samples < max && (
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setAdding(true);
                    setFallback(false);
                  }}
                  disabled={busy !== null}
                >
                  + Add sample
                </button>
              )}
            </div>
            {legacy > 0 && samples < needed && (
              <div className="alert warn">
                Face recognition was upgraded — add {needed - samples} new sample
                {needed - samples === 1 ? '' : 's'} to use it again.
              </div>
            )}
            {state.faceEngineReady === false && (
              <div className="alert warn">
                The recognition models are still loading on the server. Give it a few seconds, or
                use the fallback.
              </div>
            )}
            <FaceSamplesPanel
              employeeId={state.employee.id}
              self
              editable
              reloadToken={samplesVersion}
              onChanged={() => {
                setAdding(false);
                void load();
                // The account picture is cut from a sample, and goes with it
                // when that sample is removed; the server decides, so read it again.
                void refreshAuth();
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The phone's position at a clock punch (2026-11-23, the owner's call: the
 * HR report shows where each punch was made). Asked of the browser only when
 * the person presses the button; never watched, never sent anywhere but the
 * clock route. A refusal or a timeout is not an error — the punch goes on
 * and the record says no location was given.
 */
export type Position = { lat: number; lng: number; accuracy: number };

export type PositionResult = { position: Position | null; problem: string | null };

export function currentPosition(timeoutMs = 10_000): Promise<PositionResult> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve({ position: null, problem: 'This browser cannot give a location.' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          position: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) },
          problem: null,
        }),
      (err) =>
        resolve({
          position: null,
          problem:
            err.code === err.PERMISSION_DENIED
              ? 'Location was blocked — allow it in the address bar so HR can see where you clocked.'
              : 'The location could not be read in time.',
        }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

/** Sets the punch's position on the form, when there is one. */
export function addPosition(form: FormData, position: Position | null) {
  if (!position) return;
  form.set('lat', String(position.lat));
  form.set('lng', String(position.lng));
  form.set('accuracy', String(position.accuracy));
}

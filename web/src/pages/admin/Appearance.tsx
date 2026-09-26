import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Loading, useToast } from '../../components/ui';
import {
  appearanceCss,
  applyAppearance,
  EMPTY_APPEARANCE,
  isEmpty,
  normalise,
  stylesheetDefaults,
  type Appearance,
} from '../../lib/appearance';
import {
  FOLLOWERS,
  hexToTriple,
  RGB_TWINS,
  splitLength,
  toHexInput,
  TOKEN_GROUPS,
  type Scope,
  type TokenDef,
} from '../../lib/tokens';

/**
 * Appearance & Layout — the design system, editable from inside the app.
 *
 * Every size, gap, colour and typeface in G-Core comes from a CSS custom
 * property. This screen edits those properties, and the edit is live: the
 * page you are looking at redraws as you drag, because the preview IS the
 * application rather than a picture of it. Nothing is stored until you save.
 *
 * What it can and cannot do is worth being plain about. A token moves a thing
 * EVERYWHERE it is used — one text size covers every caption in the app, one
 * card padding covers every card. That is the point, and it is also the
 * limit: this cannot move one particular box on one particular screen,
 * because no token means "that box". For that there is the custom CSS field
 * at the bottom, which is genuinely writing CSS and is labelled as such.
 *
 * Defaults are read off the live stylesheet with the overrides lifted, never
 * copied into this file — so "reset" restores what styles.css actually says
 * today, not what it said when this screen was written.
 */

type Draft = Appearance;

const ALL_NAMES = TOKEN_GROUPS.flatMap((g) => g.tokens.map((t) => t.name));

export function Appearance_() {
  const { me, refresh } = useAuth();
  const toast = useToast();

  const saved = useRef<Draft>(EMPTY_APPEARANCE);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [theme, setTheme] = useState<'day' | 'dark'>('day');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [openGroup, setOpenGroup] = useState<string>('layout');

  /* Load the stored appearance, and read what the stylesheet says by itself. */
  useEffect(() => {
    let live = true;
    api
      .get<Appearance>('/appearance')
      .then((a) => {
        if (!live) return;
        const clean = normalise(a);
        saved.current = clean;
        setDraft(clean);
        setDefaults(stylesheetDefaults(ALL_NAMES));
      })
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, []);

  /*
    Leaving the screen with unsaved changes puts the app back the way it was.
    An experiment you walked away from should not follow you around the
    application — and it certainly should not survive a reload looking like a
    setting somebody chose.
  */
  useEffect(
    () => () => {
      applyAppearance(saved.current);
    },
    [],
  );

  /** Every edit paints immediately, and stores nothing. */
  const preview = useCallback((next: Draft) => {
    setDraft(next);
    applyAppearance(next, { persist: false });
  }, []);

  const bucketFor = (scope: Scope | 'theme'): Scope => (scope === 'theme' ? theme : scope);

  function setToken(scope: Scope | 'theme', def: TokenDef, value: string) {
    if (!draft) return;
    const bucket = bucketFor(scope);
    const next: Draft = {
      ...draft,
      tokens: { ...draft.tokens },
      dark: { ...draft.dark },
      day: { ...draft.day },
    };
    const map = next[bucket];

    if (!value.trim()) delete map[def.name];
    else map[def.name] = value;

    /*
      A colour and its rgb triple are one decision. Tints are written
      `rgb(var(--neon-rgb) / 0.12)`, so setting the colour without the triple
      leaves every wash of it on the old hue — a half-change that looks like
      a bug rather than a choice.
    */
    if (def.kind === 'colour' && RGB_TWINS.has(def.name)) {
      const triple = value.trim() ? hexToTriple(value) : null;
      if (triple) map[`${def.name}-rgb`] = triple;
      else delete map[`${def.name}-rgb`];
    }

    // And the tokens that are the same decision wearing another name.
    for (const follower of FOLLOWERS[def.name] ?? []) {
      if (value.trim()) map[follower] = value;
      else delete map[follower];
    }
    preview(next);
  }

  function resetGroup(group: (typeof TOKEN_GROUPS)[number]) {
    if (!draft) return;
    const bucket = bucketFor(group.scope);
    const next: Draft = {
      ...draft,
      tokens: { ...draft.tokens },
      dark: { ...draft.dark },
      day: { ...draft.day },
    };
    for (const t of group.tokens) {
      delete next[bucket][t.name];
      delete next[bucket][`${t.name}-rgb`];
      for (const follower of FOLLOWERS[t.name] ?? []) delete next[bucket][follower];
    }
    preview(next);
  }

  function resetEverything() {
    preview({ ...EMPTY_APPEARANCE });
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const stored = await api.put<Appearance>('/appearance', draft);
      const clean = normalise(stored);
      saved.current = clean;
      setDraft(clean);
      applyAppearance(clean);
      // So the rest of the app — and the next reload — sees it too.
      await refresh();
      toast('ok', 'Appearance saved for everyone');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    setDraft(saved.current);
    applyAppearance(saved.current);
    toast('ok', 'Back to the saved appearance');
  }

  const dirty = useMemo(
    () => !!draft && JSON.stringify(draft) !== JSON.stringify(saved.current),
    [draft],
  );

  const canEdit = !!me?.user.isSuperAdmin || !!me?.permissions.includes('admin.appearance.edit_all');

  if (error && !draft) return <ErrorBox error={error} />;
  if (!draft) return <Loading label="Reading the design system…" />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Appearance &amp; Layout</h1>
          <p>
            Every size, space, colour and typeface in G-Core comes from one of these settings, and
            changing one moves it everywhere it is used. The page redraws as you go — nothing is
            saved until you say so, and leaving without saving puts it all back.
          </p>
        </div>
        <div className="row" style={{ gap: 'var(--s-2)' }}>
          <button className="btn btn-sm" onClick={discard} disabled={!dirty || busy}>
            Discard
          </button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || busy || !canEdit}>
            {busy ? 'Saving…' : dirty ? 'Save for everyone' : 'Saved'}
          </button>
        </div>
      </div>

      <ErrorBox error={error} />

      {!canEdit && (
        <div className="alert warn">
          You can try changes here and see them, but you do not have permission to save them for
          everyone. Ask an administrator for <span className="mono">admin.appearance.edit_all</span>.
        </div>
      )}

      <div className="stack">
        {TOKEN_GROUPS.map((group) => {
          const bucket = bucketFor(group.scope);
          const open = openGroup === group.key;
          const changed = group.tokens.filter((t) => draft[bucket][t.name] !== undefined).length;

          return (
            <section className="card" key={group.key}>
              <div className="panel-head">
                <button
                  className="disclosure"
                  aria-expanded={open}
                  onClick={() => setOpenGroup(open ? '' : group.key)}
                >
                  <span className="card-title">{group.title}</span>
                  {changed > 0 && (
                    <span className="badge info">
                      {changed} changed
                    </span>
                  )}
                </button>
                {open && changed > 0 && (
                  <button className="btn btn-sm btn-ghost" onClick={() => resetGroup(group)}>
                    Reset this section
                  </button>
                )}
              </div>

              {open && (
                <>
                  <p className="panel-blurb">{group.blurb}</p>

                  {group.scope === 'theme' && (
                    <div className="row" style={{ gap: 'var(--s-2)', marginBottom: 'var(--s-4)' }}>
                      <button
                        className={`btn btn-sm${theme === 'day' ? ' btn-active' : ''}`}
                        onClick={() => setTheme('day')}
                      >
                        Daylight screens
                      </button>
                      <button
                        className={`btn btn-sm${theme === 'dark' ? ' btn-active' : ''}`}
                        onClick={() => setTheme('dark')}
                      >
                        Dark launcher
                      </button>
                      <span className="faint" style={{ fontSize: 'var(--fs-xs)' }}>
                        {theme === 'day'
                          ? 'What you are looking at now'
                          : 'The home page — open it in another tab to watch these change'}
                      </span>
                    </div>
                  )}

                  <div className="token-grid">
                    {group.tokens.map((def) => (
                      <TokenRow
                        key={def.name}
                        def={def}
                        value={draft[bucket][def.name] ?? ''}
                        fallback={defaults[def.name] ?? ''}
                        onChange={(v) => setToken(group.scope, def, v)}
                      />
                    ))}
                  </div>
                </>
              )}
            </section>
          );
        })}

        <section className="card">
          <div className="panel-head">
            <button
              className="disclosure"
              aria-expanded={openGroup === 'css'}
              onClick={() => setOpenGroup(openGroup === 'css' ? '' : 'css')}
            >
              <span className="card-title">Custom CSS</span>
              {draft.css.trim() && <span className="badge info">in use</span>}
            </button>
          </div>
          {openGroup === 'css' && (
            <>
              <p className="panel-blurb">
                The escape hatch, for the things a setting above cannot reach — moving one
                particular box on one particular screen, rather than every box of that kind. This
                is really writing CSS, and a mistake here can make a screen unusable; if that
                happens, clear this field and save. Right-click anything in the app and choose
                Inspect to find out what to name it.
              </p>
              <textarea
                className="mono"
                rows={10}
                spellCheck={false}
                value={draft.css}
                placeholder={'.page-head h1 {\n  letter-spacing: 3px;\n}'}
                onChange={(e) => preview({ ...draft, css: e.target.value })}
              />
            </>
          )}
        </section>

        <section className="card">
          <h3 className="card-title">The whole thing as CSS</h3>
          <p className="panel-blurb">
            Everything above, as the stylesheet it becomes. Worth copying somewhere safe once you
            have it how you like it — and it is what to send me if you would rather a change became
            part of the app itself rather than a setting sitting on top of it.
          </p>
          {isEmpty(draft) ? (
            <p className="faint">
              Nothing is overridden. The app is exactly as the stylesheet draws it.
            </p>
          ) : (
            <>
              <pre className="code-block">{appearanceCss(draft)}</pre>
              <div className="row" style={{ gap: 'var(--s-2)' }}>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    navigator.clipboard
                      ?.writeText(appearanceCss(draft))
                      .then(() => toast('ok', 'Copied'))
                      .catch(() => toast('error', 'The browser would not let me copy that'));
                  }}
                >
                  Copy
                </button>
                <button className="btn btn-sm btn-ghost" onClick={resetEverything}>
                  Reset everything
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * One setting.
 *
 * The text box always accepts anything CSS would — `clamp()`, `rem`, a
 * percentage — and the slider appears only when the value is a plain number
 * and a unit, which is most of them. Leaving the box empty removes the
 * override rather than setting it to nothing, which is why the placeholder
 * shows the stylesheet's own value rather than pretending the field is blank.
 */
function TokenRow({
  def,
  value,
  fallback,
  onChange,
}: {
  def: TokenDef;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  const effective = value || fallback;
  const parts = def.kind === 'length' ? splitLength(effective) : null;
  const slideable = !!parts && def.min !== undefined && def.max !== undefined;

  return (
    <div className={`token-row${value ? ' changed' : ''}`}>
      <div className="token-label">
        <label htmlFor={`tok-${def.name}`}>{def.label}</label>
        <code className="faint">--{def.name}</code>
        {def.hint && <span className="token-hint">{def.hint}</span>}
      </div>

      <div className="token-control">
        {def.kind === 'colour' && (
          <input
            type="color"
            aria-label={`${def.label} colour picker`}
            value={toHexInput(effective)}
            onChange={(e) => onChange(e.target.value)}
            className="token-swatch"
          />
        )}

        <input
          id={`tok-${def.name}`}
          type="text"
          className={def.kind === 'font' || def.kind === 'text' ? 'mono token-wide' : 'mono'}
          value={value}
          placeholder={fallback}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />

        {slideable && (
          <input
            type="range"
            aria-label={`${def.label} slider`}
            min={def.min}
            max={def.max}
            step={parts!.unit === 'rem' ? 0.25 : 1}
            value={parts!.n}
            onChange={(e) => onChange(`${e.target.value}${parts!.unit}`)}
          />
        )}

        {value && (
          <button
            className="btn btn-sm btn-ghost"
            title={`Back to ${fallback || 'the stylesheet default'}`}
            onClick={() => onChange('')}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

export { Appearance_ as Appearance };

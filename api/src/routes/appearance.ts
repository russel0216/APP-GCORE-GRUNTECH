import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { handler, parseBody } from '../http/kit';
import { authenticate, require_ } from '../auth/middleware';
import { audit } from '../shared/audit';

/**
 * Appearance — the design tokens, edited from inside the app.
 *
 * G-Core's whole visual system is CSS custom properties in one stylesheet
 * (`web/src/styles.css`): spacing, type scale, radii, colour, and now the
 * structural dimensions too. This stores OVERRIDES for those properties —
 * never a copy of the stylesheet. An absent key means "whatever the
 * stylesheet says", so the defaults stay in the one place they belong and
 * clearing an override genuinely restores it.
 *
 * It adds no table: one row in `Setting`, the same store company settings
 * and the numbering rules already use.
 *
 * Reading is open to any signed-in user, because it IS the application's
 * appearance — everybody's browser needs it to draw the page, and it carries
 * nothing about the business. It rides along on `/auth/me` rather than taking
 * a request of its own, so it costs nothing at boot. WRITING is gated on
 * `admin.appearance.edit_all` and audited like any other setting.
 */

export const APPEARANCE_KEY = 'appearance';

export interface Appearance {
  /** `:root` — spacing, type, layout, shape. Theme-independent. */
  tokens: Record<string, string>;
  /** Colour on the dark launcher. */
  dark: Record<string, string>;
  /** Colour on the daylight screens behind the menu. */
  day: Record<string, string>;
  /**
   * Per-element overrides from the layout editor, keyed by CSS selector.
   * `{ '[data-route="/g-ops"] .kpi-card:nth-of-type(2)': { width: '320px' } }`
   */
  rules: Record<string, Record<string, string>>;
  /** Free-form CSS, appended after the tokens. The escape hatch. */
  css: string;
}

export const EMPTY_APPEARANCE: Appearance = { tokens: {}, dark: {}, day: {}, rules: {}, css: '' };

/**
 * A token name we are willing to write into a stylesheet.
 *
 * Narrow on purpose. The value ends up inside a `<style>` element, so a name
 * carrying a brace or a semicolon could close the declaration and open a rule
 * of its own — the custom CSS field is the sanctioned way to write rules, and
 * it is at least honest about being one.
 */
const TOKEN_NAME = /^[a-z0-9-]{1,40}$/;

/** No terminators, no comment markers, no `</style>`. */
const TOKEN_VALUE = /^[^{};<>]{0,120}$/;

/**
 * A selector the layout editor is allowed to write a rule for.
 *
 * Classes, attribute selectors, `nth-child`, combinators, descendants — the
 * shapes `selectorFor()` in the browser actually produces, including the `/`
 * in `[data-route="/g-ops"]`, whose absence here silently discarded every
 * rule the layout editor wrote while reporting the save as a success.
 *
 * Braces and semicolons stay out for the same reason as token values: this
 * text is about to sit in front of a `{` in a stylesheet, and a selector
 * carrying its own would close the rule and open whatever came next.
 */
const SELECTOR = /^[a-zA-Z0-9 ._:>#()="'\/,+~*\[\]-]{1,400}$/;
const PROPERTY = /^[a-z-]{1,40}$/;

function cleanMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && TOKEN_NAME.test(k) && TOKEN_VALUE.test(v) && v.trim()) {
      out[k] = v.trim();
    }
  }
  return out;
}

function cleanRules(value: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [selector, decls] of Object.entries(value as Record<string, unknown>)) {
    if (!SELECTOR.test(selector) || !decls || typeof decls !== 'object') continue;
    const clean: Record<string, string> = {};
    for (const [prop, v] of Object.entries(decls as Record<string, unknown>)) {
      if (typeof v === 'string' && PROPERTY.test(prop) && TOKEN_VALUE.test(v) && v.trim()) {
        clean[prop] = v.trim();
      }
    }
    if (Object.keys(clean).length) out[selector] = clean;
  }
  return out;
}

export function readAppearance(value: unknown): Appearance {
  if (!value || typeof value !== 'object') return EMPTY_APPEARANCE;
  const raw = value as Partial<Appearance>;
  return {
    tokens: cleanMap(raw.tokens),
    dark: cleanMap(raw.dark),
    day: cleanMap(raw.day),
    rules: cleanRules(raw.rules),
    css: typeof raw.css === 'string' ? raw.css : '',
  };
}

/** Loads the stored appearance for `/auth/me`. Never throws — styling is not worth a 500. */
export async function currentAppearance(): Promise<Appearance> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: APPEARANCE_KEY } });
    return readAppearance(row?.value);
  } catch {
    return EMPTY_APPEARANCE;
  }
}

export const appearanceRoutes = Router();
appearanceRoutes.use(authenticate);

appearanceRoutes.get(
  '/',
  handler(async (_req, res) => {
    res.json(await currentAppearance());
  }),
);

const saveSchema = z.object({
  tokens: z.record(z.string()).default({}),
  dark: z.record(z.string()).default({}),
  day: z.record(z.string()).default({}),
  rules: z.record(z.record(z.string())).default({}),
  css: z.string().max(20_000, 'That is more CSS than this field is meant to hold').default(''),
});

appearanceRoutes.put(
  '/',
  require_('admin.appearance.edit_all'),
  handler(async (req, res) => {
    const body = parseBody(saveSchema, req.body);
    // Sanitised on the way in as well as on the way out, so a value that
    // could break out of the style element never reaches the database.
    const clean = readAppearance(body);

    await prisma.setting.upsert({
      where: { key: APPEARANCE_KEY },
      create: {
        key: APPEARANCE_KEY,
        value: clean as unknown as object,
        description: 'Design token overrides and custom CSS, set from Admin › Appearance',
      },
      update: { value: clean as unknown as object },
    });

    await audit(
      {
        entityType: 'setting',
        entityId: APPEARANCE_KEY,
        action: 'UPDATED',
        summary: (() => {
          const n =
            Object.keys(clean.tokens).length +
            Object.keys(clean.dark).length +
            Object.keys(clean.day).length;
          const r = Object.keys(clean.rules).length;
          return `Changed the appearance (${n} token${n === 1 ? '' : 's'}, ${r} element${
            r === 1 ? '' : 's'
          }${clean.css.trim() ? ', plus custom CSS' : ''})`;
        })(),
        after: clean,
      },
      req,
    );

    res.json(clean);
  }),
);

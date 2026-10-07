import { z } from 'zod';
import { prisma } from '../prisma';

/**
 * The pipeline's STAGES — SCORO's "Quotes and pipeline" statuses, as data
 * (2026-10-07, the owner's status settings and pipeline screenshots).
 *
 * G-CORE keeps its own fine-grained statuses (a lead's NEW → COSTING, a
 * quotation's OPEN → WON); the board's six bands are these stages, each
 * gathering the statuses that stand in it. What an administrator may change
 * (Admin › Pipeline Stages) is what SCORO lets them change: the name, the
 * odds, the colour and whether the stage is on the active board. What is
 * NOT theirs to change is which statuses a stage gathers, and the odds the
 * board itself fixes — Confirmed and Completed are 100, Lost is 0, and On
 * hold says nothing — because a won deal weighted at 90% is a lie.
 *
 * Completed is derived: a won quotation with a sales order or a project
 * created from it, which is exactly SCORO's "assigned when creating an order
 * or invoice from that quote".
 */

export const STAGE_SETTING_KEY = 'pipeline.stages';

export const STAGE_KEYS = ['OPPORTUNITY', 'NEGOTIATION', 'CLOSING', 'CONFIRMED', 'COMPLETED', 'LOST', 'HOLD'] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export interface StageDef {
  key: StageKey;
  label: string;
  /** The odds a deal moved into this stage defaults to; null says nothing (On hold). */
  probability: number | null;
  color: string;
  /** On the active board. Off it, the stage's cards are reached from the list screens. */
  inActiveList: boolean;
  successful: boolean;
  /** The odds are the board's own rule for this stage; the setting cannot change them. */
  fixedOdds: boolean;
  /** The board's fine columns that stand in this stage, in order. */
  columns: string[];
  /** Every lead status, quotation outcome and column key that stands in it. */
  statuses: string[];
  explanation: string;
}

export const DEFAULT_STAGES: StageDef[] = [
  {
    key: 'OPPORTUNITY',
    label: 'Opportunity',
    probability: 10,
    color: '#F7E27A',
    inActiveList: true,
    successful: false,
    fixedOdds: false,
    columns: ['NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT', 'COSTING', 'QUOTED'],
    statuses: ['NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT', 'COSTING', 'QUOTATION_CREATED', 'QUOTED', 'OPEN'],
    explanation: 'Every new lead and every drafted quotation. The lead’s own steps (New → Costing) are the columns of the detailed view.',
  },
  {
    key: 'NEGOTIATION',
    label: 'Negotiation',
    probability: 50,
    color: '#F5A24B',
    inActiveList: true,
    successful: false,
    fixedOdds: false,
    columns: ['SUBMITTED'],
    statuses: ['QUOTATION_SUBMITTED', 'SUBMITTED'],
    explanation: 'A quotation sent to the customer.',
  },
  {
    key: 'CLOSING',
    label: 'Closing',
    probability: 90,
    color: '#8BC34A',
    inActiveList: true,
    successful: false,
    fixedOdds: false,
    columns: ['NEGOTIATION'],
    statuses: ['NEGOTIATION'],
    explanation: 'The customer is settling terms on the quotation.',
  },
  {
    key: 'CONFIRMED',
    label: 'Confirmed',
    probability: 100,
    color: '#2E9A4B',
    inActiveList: true,
    successful: true,
    fixedOdds: true,
    columns: ['WON'],
    statuses: ['WON'],
    explanation: 'Won — the customer approved the quotation. No sales order yet.',
  },
  {
    key: 'COMPLETED',
    label: 'Completed',
    probability: 100,
    color: '#2F80ED',
    inActiveList: true,
    successful: true,
    fixedOdds: true,
    columns: ['WON'],
    statuses: [],
    explanation: 'A won quotation with a sales order or a project created from it. Worked out, never set by hand.',
  },
  {
    key: 'LOST',
    label: 'Lost',
    probability: 0,
    color: '#E0405A',
    inActiveList: false,
    successful: false,
    fixedOdds: true,
    columns: ['LOST'],
    statuses: ['LOST'],
    explanation: 'Lost, with its reason. Off the active board unless listed here.',
  },
  {
    key: 'HOLD',
    label: 'On hold',
    probability: null,
    color: '#2C3E7A',
    inActiveList: false,
    successful: false,
    fixedOdds: true,
    columns: ['ON_HOLD'],
    statuses: ['ON_HOLD'],
    explanation: 'A lead parked for later. Moving a deal here changes nothing about its odds.',
  },
];

const HEX = /^#[0-9a-fA-F]{6}$/;

/** What Admin › Pipeline Stages may set per stage; everything else is code. */
const overrideSchema = z.object({
  label: z.string().trim().min(1, 'A stage needs a name').max(40).optional(),
  probability: z.number().int().min(0).max(100).nullable().optional(),
  color: z.string().regex(HEX, 'A colour is written #RRGGBB').optional(),
  inActiveList: z.boolean().optional(),
});
export type StageOverride = z.infer<typeof overrideSchema>;

export const stageSettingsSchema = z.record(z.enum(STAGE_KEYS), overrideSchema);
export type StageSettings = z.infer<typeof stageSettingsSchema>;

/** The defaults with the saved overrides on top — the fixed odds stay fixed. */
export function mergeStages(overrides: StageSettings | null | undefined): StageDef[] {
  return DEFAULT_STAGES.map((def) => {
    const o = overrides?.[def.key];
    if (!o) return def;
    return {
      ...def,
      label: o.label ?? def.label,
      probability: def.fixedOdds ? def.probability : o.probability === undefined ? def.probability : o.probability,
      color: o.color ?? def.color,
      inActiveList: o.inActiveList ?? def.inActiveList,
    };
  });
}

/** The stages as configured, or SCORO's defaults — a stored row that no longer reads prints the defaults. */
export async function pipelineStages(): Promise<StageDef[]> {
  const row = await prisma.setting.findUnique({ where: { key: STAGE_SETTING_KEY } });
  if (!row) return DEFAULT_STAGES;
  const parsed = stageSettingsSchema.safeParse(row.value);
  if (!parsed.success) {
    console.warn(`[pipeline] ${STAGE_SETTING_KEY} does not read as stage settings; using the defaults`);
    return DEFAULT_STAGES;
  }
  return mergeStages(parsed.data);
}

/** The saved overrides themselves, for the admin page's form. */
export async function pipelineStageOverrides(): Promise<StageSettings> {
  const row = await prisma.setting.findUnique({ where: { key: STAGE_SETTING_KEY } });
  if (!row) return {};
  const parsed = stageSettingsSchema.safeParse(row.value);
  return parsed.success ? parsed.data : {};
}

/** The stage a lead status, quotation outcome or board column stands in. */
export function stageFor(statusOrColumn: string, stages: StageDef[] = DEFAULT_STAGES): StageDef | null {
  return stages.find((s) => s.statuses.includes(statusOrColumn)) ?? null;
}

/**
 * The odds a stage carries — SCORO's ladder: Opportunity 10, Negotiation
 * 50, Closing 90, Confirmed 100, Lost 0 — looked up by any status or column
 * that stands in the stage. Null means the stage says nothing (On hold).
 */
export function stageProbability(key: string, stages: StageDef[] = DEFAULT_STAGES): number | null {
  return stageFor(key, stages)?.probability ?? null;
}

/**
 * The probability a record carries after a stage move: the target stage's
 * default where the two stages' defaults differ, otherwise whatever it had —
 * so odds typed by hand survive a move within the same band (New → Contacted
 * are both Opportunity), and On hold never touches them. The record pages can
 * still override afterwards; the stage only sets the starting odds, as
 * SCORO's statuses do.
 */
export function probabilityAfterMove(from: string, to: string, current: number, stages: StageDef[] = DEFAULT_STAGES): number {
  const was = stageProbability(from, stages);
  const now = stageProbability(to, stages);
  if (now === null || was === now) return current;
  return now;
}
